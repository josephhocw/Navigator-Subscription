// Read-only probe: dump a customer's cards + subscription history.
// Usage: npx tsx --env-file=.env scripts/probe-customer.mts <email>
import Stripe from "stripe";

const email = process.argv[2];
if (!email) throw new Error("Usage: probe-customer.mts <email>");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

const custs = await stripe.customers.list({ email });
for (const c of custs.data) {
  console.log(`customer: ${c.id} ${c.email} name="${c.name}" default_pm=${c.invoice_settings?.default_payment_method ?? "(none)"}`);
  const pms = await stripe.customers.listPaymentMethods(c.id);
  for (const pm of pms.data) {
    console.log(`  pm: ${pm.id} ${pm.card?.brand} ****${pm.card?.last4} exp ${pm.card?.exp_month}/${pm.card?.exp_year}`);
  }
  const subs = await stripe.subscriptions.list({ customer: c.id, status: "all" });
  for (const s of subs.data) {
    const item = s.items.data[0];
    console.log(
      `  sub: ${s.id} ${s.status} price=${item?.price?.id} $${(item?.price?.unit_amount ?? 0) / 100}` +
        ` created=${new Date(s.created * 1000).toISOString().slice(0, 10)}` +
        ` canceled_at=${s.canceled_at ? new Date(s.canceled_at * 1000).toISOString().slice(0, 10) : "-"}` +
        ` ended_at=${s.ended_at ? new Date(s.ended_at * 1000).toISOString().slice(0, 10) : "-"}` +
        ` cancel_details=${JSON.stringify(s.cancellation_details)}`
    );
  }
  const invoices = await stripe.invoices.list({ customer: c.id, limit: 10 });
  for (const inv of invoices.data) {
    console.log(
      `  invoice: ${inv.id} ${inv.status} $${inv.total / 100} reason=${inv.billing_reason} created=${new Date(inv.created * 1000).toISOString().slice(0, 10)}`
    );
  }
}
