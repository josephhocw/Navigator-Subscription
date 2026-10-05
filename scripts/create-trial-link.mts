// Create a cohort trial payment link for the All Markets plan, cloned from the
// rolling 7-day link's configuration (custom fields, phone, confirmation page).
// Usage: npx tsx --env-file=.env scripts/create-trial-link.mts --days 13 --ref oct5 --ends "18 October 2026, 11:59pm" [--apply]
import Stripe from "stripe";
import { TRIAL_PRICE_ID } from "../lib/trial-standardiser.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const days = Number(arg("days"));
const ref = arg("ref");
const ends = arg("ends");
const apply = process.argv.includes("--apply");
if (!days || !ref || !ends) throw new Error("need --days, --ref, --ends");

const params: Stripe.PaymentLinkCreateParams = {
  line_items: [{ price: TRIAL_PRICE_ID, quantity: 1 }],
  subscription_data: {
    trial_period_days: days,
    metadata: { ref },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
  },
  custom_fields: [
    { key: "tradingviewusername", label: { type: "custom", custom: "TradingView Username" }, type: "text", optional: false },
    { key: "telegramusernamewithoutthe", label: { type: "custom", custom: "Telegram Username (Without the '@')" }, type: "text", optional: false },
  ],
  custom_text: {
    submit: { message: `Your free trial runs until ${ends} (Singapore time). We will not charge your card before then, and you can cancel any time up to that point.` },
  },
  phone_number_collection: { enabled: true },
  after_completion: {
    type: "hosted_confirmation",
    hosted_confirmation: { custom_message: `Your free trial has started and runs until ${ends}. We will not charge your card before then. Check your inbox now for your welcome email and your next steps.` },
  },
  payment_method_collection: "always",
  billing_address_collection: "auto",
  allow_promotion_codes: false,
  metadata: { cohort: ref },
};
console.log(JSON.stringify(params, null, 1));
if (!apply) { console.log("\nDRY RUN — pass --apply to create"); process.exit(0); }
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-08-27.basil" });
const pl = await stripe.paymentLinks.create(params);
console.log(`\nCREATED ${pl.id}\n${pl.url}`);
