/**
 * Send the trial-converted welcome email to converts who never got it.
 *
 *   npx tsx --env-file=.env scripts/send-missed-trial-welcomes.mts
 *   npx tsx --env-file=.env scripts/send-missed-trial-welcomes.mts --apply
 *
 * Dry-run by default: prints who would get the welcome and writes nothing.
 *
 * WHY THIS EXISTS
 * ---------------
 * At a cohort trial end Stripe flips every subscription trialing → active at
 * the deadline but may only charge the cards up to an hour later (observed
 * 9 Aug 2026: flips at 23:59 SGT, charges at 00:59–01:00). The webhook's
 * TRIAL_CONVERTED guard requires a PAID invoice at the moment of the flip
 * (2026-08-03 incident — never relax it), so when payment lags the flip, the
 * "you're now a full subscriber" welcome that reveals the channel + signal
 * groups is suppressed and nothing sends it later. This script closes that
 * gap by hand: it finds recently-converted subscriptions whose welcome never
 * went out and dispatches TRIAL_CONVERTED through the webhook's own lifecycle,
 * so the email, Status Log row and admin ping are exactly what the live event
 * would have produced.
 *
 * Idempotent: a subscription with a TRIAL_CONVERTED row already in the Status
 * Log is skipped, so re-running never double-emails.
 */
import Stripe from "stripe";
import { google } from "googleapis";
import { buildLifecycle } from "../api/stripe-webhook.js";
import { getPlanType, getPlanDisplayName } from "../lib/plans.js";
import { formatDisplayDateSGT } from "../lib/format-date.js";

const apply = process.argv.includes("--apply");
const daysArg = process.argv.indexOf("--days");
const days = daysArg === -1 ? 2 : Number(process.argv[daysArg + 1] ?? 2);
// --exclude sub_a,sub_b — subscriptions that pass every filter but should not
// get the welcome (e.g. a long-standing subscriber whose billing date was once
// adjusted via trial_end, making them look like a fresh conversion).
const excludeArg = process.argv.indexOf("--exclude");
const excluded = new Set(
  excludeArg === -1 ? [] : (process.argv[excludeArg + 1] ?? "").split(",").filter(Boolean)
);
// --force sub_a,sub_b — send even when the Status Log already shows a
// TRIAL_CONVERTED for these subscriptions. For subscribers who report the
// welcome never arrived (bounced, spam-swallowed, or the logged send was the
// 3 Aug incident email with the wrong plan). The resend reflects the LIVE
// subscription, so a since-downgraded subscriber gets their correct groups.
const forceArg = process.argv.indexOf("--force");
const forced = new Set(
  forceArg === -1 ? [] : (process.argv[forceArg + 1] ?? "").split(",").filter(Boolean)
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

const now = Math.floor(Date.now() / 1000);
const windowStart = now - days * 86400;

// ---------------------------------------------------------------------------
// 1. Candidates: active subscriptions whose trial ended inside the window and
//    whose latest invoice is genuinely PAID (same bar the webhook applies).
// ---------------------------------------------------------------------------
type Candidate = {
  subId: string;
  email: string;
  plan: string;
  periodEnd: Date;
};
const candidates: Candidate[] = [];
const skipped: string[] = [];

for await (const sub of stripe.subscriptions.list({
  status: "active",
  limit: 100,
  expand: ["data.latest_invoice", "data.customer"],
})) {
  if (!sub.trial_end || sub.trial_end < windowStart || sub.trial_end > now) continue;
  if (excluded.has(sub.id)) {
    skipped.push(`${sub.id} — excluded by --exclude`);
    continue;
  }

  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  const email =
    (sub.customer as Stripe.Customer | null)?.email ?? "(unknown email)";
  if (invoice?.status !== "paid") {
    skipped.push(`${sub.id} ${email} — latest invoice is ${invoice?.status ?? "missing"}, not paid`);
    continue;
  }

  let plan: string;
  try {
    plan = getPlanType(sub.items.data[0]!.price.id);
  } catch {
    skipped.push(`${sub.id} ${email} — unrecognised price ${sub.items.data[0]?.price.id}`);
    continue;
  }

  const periodEnd =
    sub.items.data[0]?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;
  candidates.push({
    subId: sub.id,
    email,
    plan,
    periodEnd: periodEnd ? new Date(periodEnd * 1000) : new Date(),
  });
}

// ---------------------------------------------------------------------------
// 2. Idempotency: drop anyone whose welcome already went out (a TRIAL_CONVERTED
//    row exists in the Status Log — the lifecycle appends one per send).
// ---------------------------------------------------------------------------
const sheets = google.sheets({
  version: "v4",
  auth: new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  }),
});
const logTab = process.env.GOOGLE_SHEET_LOG_TAB_NAME || "Status Log";
const log = await sheets.spreadsheets.values.get({
  spreadsheetId: process.env.GOOGLE_SHEET_ID!,
  range: `${logTab}!A:D`,
});
const alreadyWelcomed = new Set(
  (log.data.values ?? [])
    .filter((r) => r[3] === "TRIAL_CONVERTED")
    .map((r) => r[2] as string)
);

const toSend = candidates.filter(
  (c) => !alreadyWelcomed.has(c.subId) || forced.has(c.subId)
);
const alreadyDone = candidates.filter(
  (c) => alreadyWelcomed.has(c.subId) && !forced.has(c.subId)
);

// ---------------------------------------------------------------------------
// 3. Report, then send (spaced out — the Sheets per-user quota is 60/min and
//    each dispatch reads the subscriber row and appends a log row).
// ---------------------------------------------------------------------------
console.log(`Trial ended in the last ${days} day(s), paid, still active: ${candidates.length}`);
for (const s of skipped) console.log(`  skipped: ${s}`);
for (const c of alreadyDone) console.log(`  already welcomed: ${c.email} (${c.subId})`);
console.log(`\nWelcome emails to send: ${toSend.length}`);
for (const c of toSend) {
  console.log(
    `  ${c.email}  ${getPlanDisplayName(c.plan)} [${c.plan}]  next billing ${formatDisplayDateSGT(c.periodEnd)}  ${c.subId}`
  );
}

if (!apply) {
  console.log("\nDRY RUN — nothing sent. Re-run with --apply to send the welcomes above.");
  process.exit(0);
}

const failures: string[] = [];
for (const c of toSend) {
  try {
    await buildLifecycle().apply({
      kind: "TRIAL_CONVERTED",
      stripeSubscriptionId: c.subId,
      planType: c.plan,
      periodEnd: c.periodEnd,
    });
    console.log(`✓ welcomed ${c.email} (${c.plan})`);
  } catch (err) {
    failures.push(`${c.email} (${c.subId}): ${err instanceof Error ? err.message : err}`);
    console.error(`✗ FAILED ${c.email}: ${err}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s) — re-run to retry (already-sent are skipped):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\nDone. ${toSend.length} welcome(s) sent.`);
