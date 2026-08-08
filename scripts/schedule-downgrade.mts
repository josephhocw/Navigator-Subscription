/**
 * Arrange a downgrade at period end BY HAND, correctly.
 *
 *   npx tsx --env-file=.env scripts/schedule-downgrade.mts --sub sub_123 --to-price price_456
 *   npx tsx --env-file=.env scripts/schedule-downgrade.mts --sub sub_123 --to-price price_456 --apply
 *
 * Dry-run by default: it prints every step and writes nothing until --apply.
 *
 * WHY THIS EXISTS
 * ---------------
 * Subscribers normally queue their own downgrade in the customer portal and the
 * webhook handles it. Sometimes they can't — they fumble the portal, or they ask
 * over Telegram — and Joseph has to arrange it through the API. Doing that by
 * hand went wrong twice in ways that are invisible until later:
 *
 *   1. WRONG PLAN IN THE EMAIL. Stripe REFUSES `phases` on a `from_subscription`
 *      create, so a manual downgrade is always two requests: create the schedule
 *      (phase 1 is born as a copy of the CURRENT plan), then rewrite phase 1 to
 *      the target. The webhook fires on request one and used to read that copy,
 *      so YAP KIN FUNG was emailed "downgrading to All Markets" while moving to
 *      US Market (2026-08-09), and Max Yin's email said All Markets instead of HK
 *      (2026-08-04). The translator now ignores a same-price next phase, so that
 *      event is silent — and THIS script sends the real one, after the rewrite.
 *
 *   2. A DESTROYED COUPON. Rewriting phases without `discounts` strips the
 *      discount off the LIVE subscription immediately (see the phase-write trap
 *      in CLAUDE.md). The hand-rolled curl version omitted it. This script reuses
 *      `LiveTrialStripe`, which always reads discounts back and writes them out.
 *
 * WHAT IT DOES
 *   1. Refuses anything that isn't a real downgrade of a live subscription.
 *   2. Clears a scheduled cancellation if one is in the way (the usual case —
 *      the subscriber cancelled when they meant to downgrade).
 *   3. Attaches a schedule (or reuses the existing one) and rewrites the next
 *      phase to the target price, discounts carried, proration none.
 *   4. Verifies: trial end and status unchanged, discounts intact, next phase on
 *      target, and prints the invoice preview so the first charge is confirmed
 *      before anyone is told anything.
 *   5. Dispatches DOWNGRADE_SCHEDULED through the webhook's own lifecycle, so the
 *      subscriber gets the correct email, the Status Log gets the correct row,
 *      and the Pepperstone coupon syncs against the TRUE pending plan.
 *
 * The translator fix in step 3 must be DEPLOYED before this is used against
 * production, or the transient event will still send a wrong email.
 */
import Stripe from "stripe";
import { LiveTrialStripe } from "../api/standardise-trial-ends.js";
import { buildLifecycle } from "../api/stripe-webhook.js";
import { getPlanType, getPlanDisplayName, classifyPlanChange } from "../lib/plans.js";
import { formatDisplayDateSGT } from "../lib/format-date.js";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};

const subscriptionId = arg("--sub");
const targetPriceId = arg("--to-price");
const apply = process.argv.includes("--apply");

if (!subscriptionId || !targetPriceId) {
  console.error(
    "Usage: schedule-downgrade.mts --sub sub_123 --to-price price_456 [--apply]"
  );
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});
const sched = new LiveTrialStripe(stripe);

const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "?" : `$${(cents / 100).toFixed(2)}`;
const when = (epoch: number | null | undefined) =>
  epoch ? formatDisplayDateSGT(new Date(epoch * 1000)) : "(none)";
const couponIdsOf = (sub: Stripe.Subscription): string[] =>
  (sub.discounts ?? [])
    .map((d) => {
      const coupon = (d as unknown as { coupon?: string | Stripe.Coupon }).coupon;
      return typeof coupon === "string" ? coupon : coupon?.id;
    })
    .filter((id): id is string => !!id);

const die = (message: string): never => {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. Read the subscription and refuse anything this tool shouldn't touch.
// ---------------------------------------------------------------------------
const sub = await stripe.subscriptions.retrieve(subscriptionId, {
  expand: ["discounts"],
});

if (sub.status !== "active" && sub.status !== "trialing") {
  die(`subscription is ${sub.status} — only active or trialing can be downgraded`);
}
if (sub.items.data.length !== 1) {
  die(`subscription has ${sub.items.data.length} items — this tool assumes exactly one`);
}

const currentPriceId = sub.items.data[0]!.price.id;
if (currentPriceId === targetPriceId) {
  die("target price is the current price — nothing to schedule");
}

const currentPlan = getPlanType(currentPriceId); // throws on an unknown price
const pendingPlan = getPlanType(targetPriceId);
const change = classifyPlanChange(currentPlan, pendingPlan);
if (change !== "DOWNGRADED") {
  die(
    `${currentPlan} → ${pendingPlan} classifies as ${change}. Only downgrades are ` +
      `scheduled at period end; an upgrade or switch applies immediately and should ` +
      `go through the portal or a plain subscription update.`
  );
}

const couponsBefore = couponIdsOf(sub);
console.log(`Subscription : ${sub.id} (${sub.status})`);
console.log(`Current plan : ${getPlanDisplayName(currentPlan)} [${currentPlan}] ${currentPriceId}`);
console.log(`Pending plan : ${getPlanDisplayName(pendingPlan)} [${pendingPlan}] ${targetPriceId}`);
console.log(`Trial end    : ${when(sub.trial_end)}`);
console.log(`Coupons      : ${couponsBefore.length ? couponsBefore.join(", ") : "(none)"}`);
console.log(`Cancelling   : ${sub.cancel_at_period_end ? `yes, at ${when(sub.cancel_at)}` : "no"}`);
console.log(`Schedule     : ${sub.schedule ? String(sub.schedule) : "(none yet)"}`);

if (!apply) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to make these changes:");
  if (sub.cancel_at_period_end) console.log("  • clear the scheduled cancellation");
  if (!sub.schedule) console.log("  • attach a subscription schedule (from_subscription)");
  console.log(`  • rewrite the next phase to ${pendingPlan}, discounts carried, proration none`);
  console.log("  • send the downgrade-scheduled email, log it, sync the coupon, ping Telegram");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Clear a scheduled cancellation. A subscriber who cancelled when they meant
//    to downgrade is the common case, and a schedule can't outlive a cancel_at.
// ---------------------------------------------------------------------------
if (sub.cancel_at_period_end) {
  await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
  console.log("\n✓ Scheduled cancellation cleared");
}

// ---------------------------------------------------------------------------
// 3. Attach the schedule, then rewrite the next phase.
//    Between these two the subscription briefly holds a schedule whose next
//    phase is a copy of the current plan. The translator ignores that shape on
//    purpose — see the comment on the DOWNGRADE_SCHEDULED branch.
// ---------------------------------------------------------------------------
let scheduleId =
  typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
if (!scheduleId) {
  const created = await stripe.subscriptionSchedules.create({
    from_subscription: sub.id,
  });
  scheduleId = created.id;
  console.log(`✓ Schedule created: ${scheduleId}`);
} else {
  console.log(`✓ Reusing existing schedule: ${scheduleId}`);
}

const phases = await sched.getSchedulePhases(scheduleId);
if (phases.length < 2) {
  die(
    `schedule ${scheduleId} has ${phases.length} phase(s) — expected the current ` +
      `phase plus a following one to rewrite`
  );
}

const rewritten = phases.map((p, i) => ({
  ...p,
  // Never infer the trial flag from the phase (2026-08-03 incident): a
  // portal-created schedule can report trial_end: null on the phase that IS
  // the trial, and describing it as billable ends the trial and invoices on
  // the spot. A trialing subscription's first phase is always the trial.
  trial: i === 0 ? sub.status === "trialing" : p.trial,
  ...(i === 1
    ? { priceId: targetPriceId, prorationBehavior: "none" as const }
    : {}),
}));

await sched.setSchedulePhases(scheduleId, rewritten);
console.log(`✓ Next phase set to ${pendingPlan} (${targetPriceId})`);

// ---------------------------------------------------------------------------
// 4. Verify before anyone is told anything.
// ---------------------------------------------------------------------------
const after = await stripe.subscriptions.retrieve(sub.id, { expand: ["discounts"] });
const couponsAfter = couponIdsOf(after);
const phasesAfter = await sched.getSchedulePhases(scheduleId);
const problems: string[] = [];

if (after.status !== sub.status) problems.push(`status changed ${sub.status} → ${after.status}`);
if (after.trial_end !== sub.trial_end)
  problems.push(`trial end moved ${when(sub.trial_end)} → ${when(after.trial_end)}`);
if (after.cancel_at_period_end) problems.push("subscription is still set to cancel");
if (couponsAfter.length !== couponsBefore.length)
  problems.push(`discounts changed [${couponsBefore.join(", ")}] → [${couponsAfter.join(", ")}]`);
if (phasesAfter[1]?.priceId !== targetPriceId)
  problems.push(`next phase is ${phasesAfter[1]?.priceId}, expected ${targetPriceId}`);

const preview = await stripe.invoices.createPreview({ subscription: sub.id });
console.log(
  `\nNext invoice : ${money(preview.total)} ${preview.currency.toUpperCase()} — ` +
    preview.lines.data.map((l) => `${l.description} (${money(l.amount)})`).join(" + ")
);

if (problems.length) {
  console.error("\n🚨 VERIFICATION FAILED — no email sent, fix these in Stripe first:");
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log("✓ Verified: status, trial end, discounts and next phase all as expected");

// ---------------------------------------------------------------------------
// 5. Now — and only now — tell the subscriber, using the webhook's own wiring
//    so the email, the Status Log row, the coupon sync and the ping are exactly
//    what a portal downgrade would have produced.
// ---------------------------------------------------------------------------
const periodEnd = phasesAfter[0]?.endDate ?? 0;
await buildLifecycle().apply({
  kind: "DOWNGRADE_SCHEDULED",
  stripeSubscriptionId: sub.id,
  currentPlanType: currentPlan,
  pendingPlanType: pendingPlan,
  periodEnd,
});
console.log(
  `✓ DOWNGRADE_SCHEDULED dispatched: ${currentPlan} → ${pendingPlan}, effective ${when(periodEnd)}`
);

// The coupon sync above may legitimately swap NAV30 ↔ NAV21 when the downgrade
// crosses the single ↔ combo boundary. Losing the discount entirely is never
// legitimate, so check for that specifically.
const final = await stripe.subscriptions.retrieve(sub.id, { expand: ["discounts"] });
const couponsFinal = couponIdsOf(final);
if (couponsBefore.length > 0 && couponsFinal.length === 0) {
  console.error(
    `\n🚨 The discount [${couponsBefore.join(", ")}] is GONE from ${sub.id} after the ` +
      `coupon sync. Restore it by hand and check the schedule phases.`
  );
  process.exit(1);
}
console.log(`Coupons now  : ${couponsFinal.length ? couponsFinal.join(", ") : "(none)"}`);
console.log("\nDone.");
