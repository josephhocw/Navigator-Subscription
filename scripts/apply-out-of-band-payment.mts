/**
 * Apply a renewal that was paid OUTSIDE Stripe (PayNow / bank transfer).
 *
 * Why this exists: marking an invoice paid with `paid_out_of_band=true` fires
 * `invoice.paid` but NOT `invoice.payment_succeeded` (verified live 2026-09-29,
 * in_1UCiTfPApeZiCPK2SxZQum5E). The webhook only translates
 * `invoice.payment_succeeded`, so the sheet, the Status Log, the TradingView
 * swap and the customer emails never happen.
 *
 * This script builds the same RENEWED action the translator would have built
 * and dispatches it through `buildLifecycle()` — the webhook's own wiring — so
 * the outcome is exactly what a card payment produces.
 *
 * Two deliberate differences from the translator:
 *   - price is `amount_paid`, not `total`: a coupon added after the invoice was
 *     finalised shows up as a credit note, which leaves `total` at full price.
 *   - the coupon code comes from the live subscription, not the invoice, for
 *     the same reason.
 *
 * Usage (dry-run by default):
 *   npx tsx --env-file=.env scripts/apply-out-of-band-payment.mts --invoice in_123 [--apply]
 *
 * Mark the invoice paid in Stripe FIRST; this script refuses an unpaid one.
 * Run it with TELEGRAM_BOT_TOKEN unset in the shell — the machine-level user
 * env var belongs to another bot and `--env-file` does not override it.
 */
import Stripe from "stripe";
import { buildLifecycle } from "../api/stripe-webhook.js";
import { getPlanType, getBillingInterval, getPlanDisplayName, COUPON_CODES } from "../lib/plans.js";
import { formatDisplayDateSGT } from "../lib/format-date.js";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
};

const invoiceId = arg("--invoice");
const apply = process.argv.includes("--apply");

if (!invoiceId) {
  console.error("Usage: apply-out-of-band-payment.mts --invoice in_123 [--apply]");
  process.exit(1);
}

const die = (message: string): never => {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

const invoice = await stripe.invoices.retrieve(invoiceId);

if (invoice.status !== "paid") {
  die(`invoice ${invoice.id} is "${invoice.status}" — mark it paid in Stripe first`);
}
if (invoice.billing_reason !== "subscription_cycle") {
  die(
    `invoice ${invoice.id} has billing_reason "${invoice.billing_reason}" — ` +
      `only renewal-cycle invoices are handled here`
  );
}

const subRef = invoice.parent?.subscription_details?.subscription ?? null;
const subscriptionId = typeof subRef === "string" ? subRef : subRef?.id ?? null;
if (!subscriptionId) die(`invoice ${invoice.id} is not attached to a subscription`);

const line = invoice.lines?.data?.[0];
if (!line?.period?.start || !line?.period?.end) {
  die(`invoice ${invoice.id} has no line-item period`);
}
const linePriceId = line!.pricing?.price_details?.price ?? null;
let planType: string | null = null;
if (linePriceId) {
  try {
    planType = getPlanType(linePriceId);
  } catch {
    planType = null;
  }
}
if (!planType) die(`price ${linePriceId} on invoice ${invoice.id} is not in plans.ts`);

const sub = await stripe.subscriptions.retrieve(subscriptionId!, {
  expand: ["discounts", "discounts.promotion_code"],
});
if (sub.status !== "active") {
  die(`subscription ${sub.id} is "${sub.status}", expected "active" after payment`);
}

const firstDiscount = sub.discounts?.[0];
let couponCode = "";
if (firstDiscount && typeof firstDiscount !== "string") {
  const promo = firstDiscount.promotion_code;
  const coupon = (firstDiscount as unknown as { coupon?: Stripe.Coupon }).coupon;
  couponCode =
    promo && typeof promo !== "string"
      ? promo.code
      : coupon
        ? COUPON_CODES[coupon.id] ?? coupon.name ?? coupon.id
        : "";
}

const periodStart = new Date(line!.period.start * 1000);
const periodEnd = new Date(line!.period.end * 1000);
const subscriptionPrice = (invoice.amount_paid ?? 0) / 100;

console.log(`Invoice      : ${invoice.id} (${invoice.status})`);
console.log(`Subscription : ${sub.id} (${sub.status})`);
console.log(`Customer     : ${invoice.customer_email ?? "(no email on invoice)"}`);
console.log(`Plan         : ${getPlanDisplayName(planType!)} (${planType})`);
console.log(`Price paid   : $${subscriptionPrice.toFixed(2)} SGD`);
console.log(`Coupon       : ${couponCode || "(none)"}`);
console.log(
  `Period       : ${formatDisplayDateSGT(periodStart)} → ${formatDisplayDateSGT(periodEnd)}`
);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to dispatch RENEWED.");
  process.exit(0);
}

await buildLifecycle().apply({
  kind: "RENEWED",
  stripeSubscriptionId: sub.id,
  periodStart,
  periodEnd,
  planType,
  subscriptionPrice,
  couponDiscount: couponCode !== "",
  couponCode,
  // Safe: getBillingInterval calls getPlanType internally, and planType above
  // already resolved successfully from this same linePriceId (die() exits
  // before here otherwise), so linePriceId is guaranteed non-null and valid.
  billingInterval: getBillingInterval(linePriceId!),
});
console.log("\n✓ RENEWED dispatched through the webhook lifecycle");
