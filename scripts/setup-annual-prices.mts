/**
 * Create the annual-plan objects in Stripe (whichever mode STRIPE_SECRET_KEY is):
 *   - 8 annual list prices + 8 grandfathered annual prices (yearly, SGD) on the
 *     existing plan products (looked up from the current quarterly price IDs)
 *   - coupons NAV70 / NAV100 (amount_off, forever) + promotion codes
 *   - 8 annual payment links cloned from the quarterly links' config (live only)
 *
 *   npx tsx --env-file=.env scripts/setup-annual-prices.mts            (dry run)
 *   npx tsx --env-file=.env scripts/setup-annual-prices.mts --apply
 *
 * Idempotent: a price with the same nickname + amount on the product, a coupon
 * with the same id, and a payment link with the same metadata.annual_plan are
 * reused. Prints a JSON block to paste into lib/plans.ts at the end.
 */
import Stripe from "stripe";

const apply = process.argv.includes("--apply");
const key = process.env.STRIPE_SECRET_KEY!;
const mode: "live" | "test" = key.startsWith("sk_test_") ? "test" : "live";
const stripe = new Stripe(key, { apiVersion: "2025-08-27.basil" });

// Current quarterly (2026-lineup) price per plan, and the legacy quarterly price
// whose subscribers get the grandfathered annual. Test mode has one set only.
const QUARTERLY: Record<"live" | "test", Record<string, { current: string; legacy: string | null }>> = {
  live: {
    SG: { current: "price_1Te9NWPApeZiCPK2HF8oNIi4", legacy: "price_1SOPIPPApeZiCPK2hrXFzaK3" },
    FXMC: { current: "price_1Te9SePApeZiCPK2rOTq0iMm", legacy: "price_1SOPI8PApeZiCPK2Z9OMozyV" },
    HK: { current: "price_1Te9RrPApeZiCPK2A0gTaF7Y", legacy: "price_1SOPIUPApeZiCPK2wSCEaEC3" },
    US: { current: "price_1Te9RNPApeZiCPK2q0Dj5Cds", legacy: "price_1SOPIQPApeZiCPK2B4FlKafO" },
    US_HK: { current: "price_1Te9UNPApeZiCPK2nF91HJ8Z", legacy: "price_1SOPIIPApeZiCPK2krxQ55XI" },
    US_SG_FXMC: { current: "price_1Te9VrPApeZiCPK2cczy5wyD", legacy: "price_1SOPIwPApeZiCPK2VlNvGRiv" },
    HK_SG_FXMC: { current: "price_1Te9X1PApeZiCPK2LXW6bhMT", legacy: "price_1SumwoPApeZiCPK2aBYCsk8E" },
    ALL_MARKETS: { current: "price_1Te9XoPApeZiCPK2HqYrNNK1", legacy: "price_1SOPISPApeZiCPK26eGgrPH2" },
  },
  test: {
    SG: { current: "price_1SNb2pPApeZiCPK2uIln7piV", legacy: null },
    FXMC: { current: "price_1SNaZXPApeZiCPK2PZkjTiz3", legacy: null },
    HK: { current: "price_1SNbFQPApeZiCPK2YcsuDyXc", legacy: null },
    US: { current: "price_1SNb26PApeZiCPK25nSa9j6H", legacy: null },
    US_HK: { current: "price_1SNasAPApeZiCPK28bMFFYhP", legacy: null },
    US_SG_FXMC: { current: "price_1SNaqLPApeZiCPK2c7Fcenzl", legacy: null },
    HK_SG_FXMC: { current: "price_1TRnm7PApeZiCPK2hk54bsUA", legacy: null },
    ALL_MARKETS: { current: "price_1SNau9PApeZiCPK22ZjuVaKQ", legacy: null },
  },
};

// Annual = 10 x monthly list. Pepperstone = list - coupon. Grandfathered = 10/3 x old quarterly, rounded.
const ANNUAL: Record<string, { list: number; grandfathered: number; coupon: "NAV70" | "NAV100" }> = {
  SG: { list: 360, grandfathered: 290, coupon: "NAV70" },
  FXMC: { list: 560, grandfathered: 490, coupon: "NAV70" },
  HK: { list: 560, grandfathered: 490, coupon: "NAV70" },
  US: { list: 560, grandfathered: 490, coupon: "NAV70" },
  US_HK: { list: 990, grandfathered: 880, coupon: "NAV100" },
  US_SG_FXMC: { list: 990, grandfathered: 880, coupon: "NAV100" },
  HK_SG_FXMC: { list: 990, grandfathered: 880, coupon: "NAV100" },
  ALL_MARKETS: { list: 1390, grandfathered: 1290, coupon: "NAV100" },
};
const COUPONS = {
  NAV70: { amount_off: 7000, name: "NAV70" },
  NAV100: { amount_off: 10000, name: "NAV100" },
};
// Quarterly payment-link URLs (web/src/data/plans.ts). The annual links clone their config.
const QUARTERLY_LINK_URL: Record<string, string> = {
  SG: "https://buy.stripe.com/5kQ00lb123X5f6Bb044ow05",
  US: "https://buy.stripe.com/8x24gB6KM65de2x9W04ow06",
  HK: "https://buy.stripe.com/3cI9AV2uw3X53nT9W04ow08",
  FXMC: "https://buy.stripe.com/9B6eVfb120KT7E9gko4ow01",
  US_HK: "https://buy.stripe.com/5kQ9AVfhi1OXf6Bfgk4ow03",
  US_SG_FXMC: "https://buy.stripe.com/28EbJ3c56ctB5w10lq4ow04",
  HK_SG_FXMC: "https://buy.stripe.com/5kQbJ31qseBJ6A5ecg4ow09",
  ALL_MARKETS: "https://buy.stripe.com/bJecN74CE65d5w17NS4ow07",
};

const log = (s: string) => console.log(s);
const out: Record<string, unknown> = { mode, annualList: {}, annualGrandfathered: {}, coupons: {}, promotionCodes: {}, paymentLinks: {} };

async function ensurePrice(product: string, nickname: string, amount: number): Promise<string> {
  const existing = await stripe.prices.list({ product, active: true, type: "recurring", limit: 100 });
  const hit = existing.data.find(
    (p) => p.nickname === nickname && p.unit_amount === amount * 100 && p.recurring?.interval === "year" && p.currency === "sgd"
  );
  if (hit) { log(`  reuse ${nickname} ${hit.id}`); return hit.id; }
  log(`  create ${nickname} $${amount}/yr on ${product}`);
  if (!apply) return `price_DRYRUN_${nickname.replace(/\W+/g, "_")}`;
  const p = await stripe.prices.create({
    product, nickname, currency: "sgd", unit_amount: amount * 100, recurring: { interval: "year" },
    metadata: { annual: "2026-10", kind: nickname.includes("grandfathered") ? "grandfathered" : "list" },
  });
  return p.id;
}

async function ensureCoupon(id: keyof typeof COUPONS): Promise<string> {
  try { const c = await stripe.coupons.retrieve(id); log(`  reuse coupon ${c.id}`); return c.id; } catch { /* missing */ }
  log(`  create coupon ${id} $${COUPONS[id].amount_off / 100} off forever`);
  if (!apply) return id;
  const c = await stripe.coupons.create({ id, name: COUPONS[id].name, amount_off: COUPONS[id].amount_off, currency: "sgd", duration: "forever" });
  return c.id;
}

async function ensurePromo(code: string, coupon: string): Promise<string> {
  const list = await stripe.promotionCodes.list({ code, limit: 1 });
  if (list.data[0]) { log(`  reuse promo ${code} ${list.data[0].id}`); return list.data[0].id; }
  log(`  create promo ${code} -> ${coupon}`);
  if (!apply) return `promo_DRYRUN_${code}`;
  return (await stripe.promotionCodes.create({ coupon, code })).id;
}

async function ensureLink(plan: string, price: string, template: Stripe.PaymentLink): Promise<string> {
  const all = await stripe.paymentLinks.list({ active: true, limit: 100 });
  const hit = all.data.find((l) => l.metadata?.annual_plan === plan);
  if (hit) { log(`  reuse link ${plan} ${hit.url}`); return hit.url; }
  log(`  create link ${plan} on ${price}`);
  if (!apply) return `https://buy.stripe.com/DRYRUN_${plan}`;
  const l = await stripe.paymentLinks.create({
    line_items: [{ price, quantity: 1 }],
    // The retrieved shape carries null text limits the create API rejects; keep key/label/type/optional only.
    custom_fields: template.custom_fields.map((f) => ({
      key: f.key,
      label: { type: "custom" as const, custom: f.label.custom ?? f.key },
      type: f.type,
      optional: f.optional,
    })),
    phone_number_collection: { enabled: template.phone_number_collection.enabled },
    after_completion: template.after_completion.type === "hosted_confirmation"
      ? { type: "hosted_confirmation", hosted_confirmation: { custom_message: template.after_completion.hosted_confirmation?.custom_message ?? undefined } }
      : { type: "redirect", redirect: { url: template.after_completion.redirect!.url } },
    allow_promotion_codes: template.allow_promotion_codes,
    payment_method_collection: template.payment_method_collection,
    billing_address_collection: template.billing_address_collection,
    metadata: { annual_plan: plan, annual: "2026-10" },
  });
  return l.url;
}

log(`Mode: ${mode} ${apply ? "(APPLY)" : "(dry run)"}`);
const coupons: Record<string, string> = {};
for (const id of ["NAV70", "NAV100"] as const) {
  coupons[id] = await ensureCoupon(id);
  (out.coupons as Record<string, string>)[id] = coupons[id];
  (out.promotionCodes as Record<string, string>)[id] = await ensurePromo(id, coupons[id]);
}

let template: Stripe.PaymentLink | null = null;
if (mode === "live") {
  const links = await stripe.paymentLinks.list({ active: true, limit: 100 });
  template = links.data.find((l) => l.url === QUARTERLY_LINK_URL.US) ?? null;
  if (!template) throw new Error("US quarterly payment link not found - cannot clone config");
}

for (const [plan, q] of Object.entries(QUARTERLY[mode])) {
  log(`\n${plan}`);
  const current = await stripe.prices.retrieve(q.current);
  const product = typeof current.product === "string" ? current.product : current.product.id;
  const a = ANNUAL[plan];
  const listId = await ensurePrice(product, `Annual`, a.list);
  const gfId = await ensurePrice(product, `Annual (grandfathered)`, a.grandfathered);
  (out.annualList as Record<string, string>)[plan] = listId;
  (out.annualGrandfathered as Record<string, string>)[plan] = gfId;
  if (template) (out.paymentLinks as Record<string, string>)[plan] = await ensureLink(plan, listId, template);
}

log("\n=== RESULT (paste into lib/plans.ts / web/src/data/plans.ts) ===");
log(JSON.stringify(out, null, 2));
