// Print a payment link's configuration (line items, trial, custom fields, text).
// Usage: npx tsx --env-file=.env scripts/inspect-payment-link.mts plink_...
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-08-27.basil" });
const id = process.argv[2];
if (!id) throw new Error("usage: inspect-payment-link.mts <plink_id>");
const pl = (await stripe.paymentLinks.retrieve(id, { expand: ["line_items"] })) as any;
const out = {
  id: pl.id, url: pl.url, active: pl.active,
  line_items: pl.line_items?.data?.map((l: any) => ({ price: l.price?.id, qty: l.quantity })),
  subscription_data: pl.subscription_data, custom_fields: pl.custom_fields, custom_text: pl.custom_text,
  phone_number_collection: pl.phone_number_collection, after_completion: pl.after_completion,
  allow_promotion_codes: pl.allow_promotion_codes, metadata: pl.metadata,
  payment_method_collection: pl.payment_method_collection, billing_address_collection: pl.billing_address_collection,
  consent_collection: pl.consent_collection, tax_id_collection: pl.tax_id_collection, automatic_tax: pl.automatic_tax,
  submit_type: pl.submit_type, invoice_creation: pl.invoice_creation, restrictions: pl.restrictions,
};
console.log(JSON.stringify(out, null, 1));
