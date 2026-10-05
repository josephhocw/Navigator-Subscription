/**
 * Prepare (and, with --apply, send) the annual-offer emails. Joseph runs this
 * by hand; nothing is scheduled.
 *
 *   npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing --phase offer            (dry run)
 *   npx tsx --env-file=.env scripts/annual-offer-send.mts --audience trial --phase offer --to me@x.com  (one address)
 *   npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing --phase reminder --apply
 *
 * existing = ACTIVE + CANCELLATION_SCHEDULED rows with a Stripe sub ID (comps skipped)
 * trial    = TRIAL_ACTIVE + TRIAL_CANCELLATION_SCHEDULED rows
 * Every phase skips subscriptions already on a yearly price (checked live).
 * Dry run prints the recipient table and renders ONE sample to --to (if given).
 */
import Stripe from "stripe";
import { getAllSubscriberRows } from "../lib/sheets.js";
import { sendAnnualOfferEmail } from "../lib/email.js";
import { annualLinkUrl } from "../lib/annual-link.js";
import { ANNUAL_PRICING, isPlanType, sgd } from "../lib/annual-pricing.js";
import { getBillingInterval, isLegacyQuarterlyPrice } from "../lib/plans.js";
import { formatDisplayDateSGT } from "../lib/format-date.js";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] ?? null; };
const audience = arg("audience") as "existing" | "trial" | null;
const phase = arg("phase") as "offer" | "reminder" | "lastcall" | null;
const only = arg("to");
const apply = process.argv.includes("--apply");
if (!audience || !phase) { console.error("need --audience existing|trial --phase offer|reminder|lastcall"); process.exit(1); }
const secret = process.env.ANNUAL_LINK_SECRET;
if (!secret) { console.error("ANNUAL_LINK_SECRET not set"); process.exit(1); }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-08-27.basil" });
const STATUSES = audience === "existing"
  ? new Set(["ACTIVE", "CANCELLATION_SCHEDULED"])
  : new Set(["TRIAL_ACTIVE", "TRIAL_CANCELLATION_SCHEDULED"]);

const rows = (await getAllSubscriberRows()).filter(
  (r) => STATUSES.has(r.status) && r.stripeSubscriptionId.trim() !== "" && (!only || r.email.toLowerCase() === only.toLowerCase())
);

type Prepared = { email: string; name: string; plan: string; current: number; annual: number; link: string; grandfathered: boolean; trialEnd?: string; skip?: string };
const prepared: Prepared[] = [];
for (const r of rows) {
  const sub = await stripe.subscriptions.retrieve(r.stripeSubscriptionId, { expand: ["discounts"] });
  const priceId = sub.items.data[0]?.price?.id ?? "";
  let interval: "quarter" | "year";
  try { interval = getBillingInterval(priceId); } catch { prepared.push({ email: r.email, name: r.customerName, plan: r.currentPlan, current: r.subscriptionPrice, annual: 0, link: "", grandfathered: false, skip: `unknown price ${priceId}` }); continue; }
  if (interval === "year") { prepared.push({ email: r.email, name: r.customerName, plan: r.currentPlan, current: r.subscriptionPrice, annual: 0, link: "", grandfathered: false, skip: "already annual" }); continue; }
  if (!isPlanType(r.currentPlan)) { prepared.push({ email: r.email, name: r.customerName, plan: r.currentPlan, current: r.subscriptionPrice, annual: 0, link: "", grandfathered: false, skip: "unknown plan" }); continue; }
  const row = ANNUAL_PRICING[r.currentPlan];
  const grandfathered = isLegacyQuarterlyPrice(priceId);
  const hasPep = (sub.discounts ?? []).some((d) => typeof d !== "string" && ["gcUCHGHv", "7imb0DBR"].includes(typeof d.coupon === "string" ? d.coupon : d.coupon?.id ?? ""));
  const annual = grandfathered ? row.grandfathered : hasPep ? row.pepperstone : row.list;
  prepared.push({
    email: r.email, name: r.customerName, plan: r.currentPlan,
    current: r.subscriptionPrice, annual, grandfathered,
    link: annualLinkUrl(r.stripeSubscriptionId, r.email, secret),
    trialEnd: sub.trial_end ? formatDisplayDateSGT(new Date(sub.trial_end * 1000)) : r.subscriptionExpiry || undefined,
  });
}

console.log(`${audience}/${phase}: ${prepared.length} rows, ${prepared.filter((p) => !p.skip).length} to send, ${prepared.filter((p) => p.skip).length} skipped`);
for (const p of prepared) console.log(`${p.skip ? "SKIP " : "SEND "}${p.email.padEnd(36)} ${p.plan.padEnd(12)} ${p.skip ?? `${sgd(p.current)} -> ${sgd(p.annual)}${p.grandfathered ? " (grandfathered)" : ""}`}`);
if (!apply) { console.log("\nDRY RUN — add --apply to send"); process.exit(0); }

let sent = 0; const failures: string[] = [];
for (const p of prepared.filter((x) => !x.skip)) {
  try {
    await sendAnnualOfferEmail({ email: p.email, name: p.name, planType: p.plan, currentPrice: p.current, annualPrice: p.annual, link: p.link, grandfathered: p.grandfathered, audience, phase, trialEnd: p.trialEnd });
    sent++;
  } catch (err) {
    failures.push(`${p.email}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await new Promise((r) => setTimeout(r, 600)); // Resend rate limit: 2 req/s
  }
}
console.log(`\nsent ${sent}, failures ${failures.length}`);
for (const f of failures) console.log(`  ${f}`);
