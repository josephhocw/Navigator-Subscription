import { type BillingInterval, isPlanType } from "./annual-pricing.js";

// Test-mode annual prices — created by scripts/setup-annual-prices.mts with an
// sk_test_ key. Empty until that run; the switch endpoint refuses test prices
// until they are filled (annualTargetPriceFor throws).
const TEST_ANNUAL_LIST: Record<string, string> = {};
const TEST_ANNUAL_GRANDFATHERED: Record<string, string> = {};

// Holds both live and test price IDs so the webhook classifies events in either
// Stripe mode. Price IDs are globally unique, so the two sets never collide.
const PRICE_TO_PLAN: Record<string, string> = {
  // Live prices
  "price_1SOPIPPApeZiCPK2hrXFzaK3": "SG",
  "price_1SOPI8PApeZiCPK2Z9OMozyV": "FXMC",
  "price_1SOPIUPApeZiCPK2wSCEaEC3": "HK",
  "price_1SOPIQPApeZiCPK2B4FlKafO": "US",
  "price_1SOPIIPApeZiCPK2krxQ55XI": "US_HK",
  "price_1SOPIwPApeZiCPK2VlNvGRiv": "US_SG_FXMC",
  "price_1SumwoPApeZiCPK2aBYCsk8E": "HK_SG_FXMC",
  "price_1SOPISPApeZiCPK26eGgrPH2": "ALL_MARKETS",
  // New live prices — 2026 lineup (SG $36, FXMC/HK/US $56, combos $99, All Markets $139).
  // The OLD live prices above are kept on purpose: grandfathered subscribers stay on the
  // old price ID, so their renewal invoices must still resolve to a plan.
  "price_1Te9NWPApeZiCPK2HF8oNIi4": "SG",
  "price_1Te9SePApeZiCPK2rOTq0iMm": "FXMC",
  "price_1Te9RrPApeZiCPK2A0gTaF7Y": "HK",
  "price_1Te9RNPApeZiCPK2q0Dj5Cds": "US",
  "price_1Te9UNPApeZiCPK2nF91HJ8Z": "US_HK",
  "price_1Te9VrPApeZiCPK2cczy5wyD": "US_SG_FXMC",
  "price_1Te9X1PApeZiCPK2LXW6bhMT": "HK_SG_FXMC",
  "price_1Te9XoPApeZiCPK2HqYrNNK1": "ALL_MARKETS",
  // Test prices
  "price_1SNb2pPApeZiCPK2uIln7piV": "SG",
  "price_1SNaZXPApeZiCPK2PZkjTiz3": "FXMC",
  "price_1SNbFQPApeZiCPK2YcsuDyXc": "HK",
  "price_1SNb26PApeZiCPK25nSa9j6H": "US",
  "price_1SNasAPApeZiCPK28bMFFYhP": "US_HK",
  "price_1SNaqLPApeZiCPK2c7Fcenzl": "US_SG_FXMC",
  "price_1TRnm7PApeZiCPK2hk54bsUA": "HK_SG_FXMC",
  "price_1SNau9PApeZiCPK22ZjuVaKQ": "ALL_MARKETS",
  // Annual prices — October 2026 offer (lib/annual-pricing.ts has the amounts).
  // Live, list:
  "price_1UN6bOPApeZiCPK2e2I1aTYS": "SG",
  "price_1UN6bcPApeZiCPK2ClMfLN0v": "FXMC",
  "price_1UN6bePApeZiCPK2wOHj1JsL": "HK",
  "price_1UN6bfPApeZiCPK2wGCQompq": "US",
  "price_1UN6bhPApeZiCPK2jrb4ft2X": "US_HK",
  "price_1UN6bjPApeZiCPK2WTGd23qf": "US_SG_FXMC",
  "price_1UN6blPApeZiCPK2Yj8wLwO4": "HK_SG_FXMC",
  "price_1UN6bnPApeZiCPK2pXHbbeX2": "ALL_MARKETS",
  // Live, grandfathered (only reachable via the annual-switch endpoint):
  "price_1UN6bOPApeZiCPK2yYitohWn": "SG",
  "price_1UN6bcPApeZiCPK2Ve1fhzvB": "FXMC",
  "price_1UN6bePApeZiCPK2fDOeOLLi": "HK",
  "price_1UN6bgPApeZiCPK2GdOWDcwO": "US",
  "price_1UN6biPApeZiCPK2jn6Dd0v2": "US_HK",
  "price_1UN6bkPApeZiCPK2ph67Bd7n": "US_SG_FXMC",
  "price_1UN6bmPApeZiCPK2QwqTbpr8": "HK_SG_FXMC",
  "price_1UN6boPApeZiCPK2qNGhsKiH": "ALL_MARKETS",
  // Test-mode annual prices are spread in from the maps below (filled in Task 11).
  ...Object.fromEntries(
    Object.entries(TEST_ANNUAL_LIST).map(([plan, id]) => [id, plan])
  ),
  ...Object.fromEntries(
    Object.entries(TEST_ANNUAL_GRANDFATHERED).map(([plan, id]) => [id, plan])
  ),
};

export function getPlanType(priceId: string): string {
  const plan = PRICE_TO_PLAN[priceId];
  if (!plan) throw new Error(`Unknown Stripe price ID: ${priceId}`);
  return plan;
}

// --- Billing interval & annual lookups -------------------------------------

export const ANNUAL_LIST_PRICE_IDS: Record<"live" | "test", Record<string, string>> = {
  live: {
    SG: "price_1UN6bOPApeZiCPK2e2I1aTYS",
    FXMC: "price_1UN6bcPApeZiCPK2ClMfLN0v",
    HK: "price_1UN6bePApeZiCPK2wOHj1JsL",
    US: "price_1UN6bfPApeZiCPK2wGCQompq",
    US_HK: "price_1UN6bhPApeZiCPK2jrb4ft2X",
    US_SG_FXMC: "price_1UN6bjPApeZiCPK2WTGd23qf",
    HK_SG_FXMC: "price_1UN6blPApeZiCPK2Yj8wLwO4",
    ALL_MARKETS: "price_1UN6bnPApeZiCPK2pXHbbeX2",
  },
  test: TEST_ANNUAL_LIST,
};

export const ANNUAL_GRANDFATHERED_PRICE_IDS: Record<"live" | "test", Record<string, string>> = {
  live: {
    SG: "price_1UN6bOPApeZiCPK2yYitohWn",
    FXMC: "price_1UN6bcPApeZiCPK2Ve1fhzvB",
    HK: "price_1UN6bePApeZiCPK2fDOeOLLi",
    US: "price_1UN6bgPApeZiCPK2GdOWDcwO",
    US_HK: "price_1UN6biPApeZiCPK2jn6Dd0v2",
    US_SG_FXMC: "price_1UN6bkPApeZiCPK2ph67Bd7n",
    HK_SG_FXMC: "price_1UN6bmPApeZiCPK2QwqTbpr8",
    ALL_MARKETS: "price_1UN6boPApeZiCPK2qNGhsKiH",
  },
  test: TEST_ANNUAL_GRANDFATHERED,
};

/** Pre-2026 live quarterly prices. A subscriber still on one of these gets the
 *  grandfathered annual. Detection is by ID only — amounts collide (US at 147 is
 *  both the old list and the new list minus NAV21). */
const LEGACY_QUARTERLY_PRICE_IDS = new Set([
  "price_1SOPIPPApeZiCPK2hrXFzaK3", // SG
  "price_1SOPI8PApeZiCPK2Z9OMozyV", // FXMC
  "price_1SOPIUPApeZiCPK2wSCEaEC3", // HK
  "price_1SOPIQPApeZiCPK2B4FlKafO", // US
  "price_1SOPIIPApeZiCPK2krxQ55XI", // US_HK
  "price_1SOPIwPApeZiCPK2VlNvGRiv", // US_SG_FXMC
  "price_1SumwoPApeZiCPK2aBYCsk8E", // HK_SG_FXMC
  "price_1SOPISPApeZiCPK26eGgrPH2", // ALL_MARKETS
]);

const TEST_QUARTERLY_PRICE_IDS = new Set([
  "price_1SNb2pPApeZiCPK2uIln7piV",
  "price_1SNaZXPApeZiCPK2PZkjTiz3",
  "price_1SNbFQPApeZiCPK2YcsuDyXc",
  "price_1SNb26PApeZiCPK25nSa9j6H",
  "price_1SNasAPApeZiCPK28bMFFYhP",
  "price_1SNaqLPApeZiCPK2c7Fcenzl",
  "price_1TRnm7PApeZiCPK2hk54bsUA",
  "price_1SNau9PApeZiCPK22ZjuVaKQ",
]);

const ANNUAL_PRICE_ID_SET = (): Set<string> =>
  new Set([
    ...Object.values(ANNUAL_LIST_PRICE_IDS.live),
    ...Object.values(ANNUAL_GRANDFATHERED_PRICE_IDS.live),
    ...Object.values(ANNUAL_LIST_PRICE_IDS.test),
    ...Object.values(ANNUAL_GRANDFATHERED_PRICE_IDS.test),
  ]);

export function getBillingInterval(priceId: string): BillingInterval {
  getPlanType(priceId); // throws on an unknown price — never guess an interval
  return ANNUAL_PRICE_ID_SET().has(priceId) ? "year" : "quarter";
}

export function isLegacyQuarterlyPrice(priceId: string): boolean {
  return LEGACY_QUARTERLY_PRICE_IDS.has(priceId);
}

export function stripeModeOfPrice(priceId: string): "live" | "test" {
  getPlanType(priceId);
  const test =
    TEST_QUARTERLY_PRICE_IDS.has(priceId) ||
    Object.values(ANNUAL_LIST_PRICE_IDS.test).includes(priceId) ||
    Object.values(ANNUAL_GRANDFATHERED_PRICE_IDS.test).includes(priceId);
  return test ? "test" : "live";
}

/**
 * The annual price a subscriber on `currentPriceId` moves to: the grandfathered
 * annual when they are on a legacy quarterly price, otherwise the list annual
 * for their plan, in the same Stripe mode. Throws on an unknown price or when
 * the mode's annual maps are not filled yet.
 */
export function annualTargetPriceFor(currentPriceId: string): string {
  const plan = getPlanType(currentPriceId);
  if (!isPlanType(plan)) throw new Error(`No annual price for plan: ${plan}`);
  const mode = stripeModeOfPrice(currentPriceId);
  const table = isLegacyQuarterlyPrice(currentPriceId)
    ? ANNUAL_GRANDFATHERED_PRICE_IDS[mode]
    : ANNUAL_LIST_PRICE_IDS[mode];
  const target = table[plan];
  if (!target) throw new Error(`No ${mode} annual price configured for ${plan}`);
  return target;
}

/** Quarterly Pepperstone coupon ID -> its annual counterpart (coupon id = code). */
export const NAV70_COUPON_ID = "NAV70";
export const NAV100_COUPON_ID = "NAV100";
export const ANNUAL_COUPON_FOR_QUARTERLY: Record<string, string> = {
  gcUCHGHv: NAV70_COUPON_ID, // NAV21 -> NAV70
  "7imb0DBR": NAV100_COUPON_ID, // NAV30 -> NAV100
};

// --- Coupons ---

// Short customer-facing code for each known coupon ID. Manually-applied
// discounts (Joseph applying the Pepperstone coupon in Stripe) carry no
// promotion_code on the discount object, so the code has to be resolved from
// the coupon ID. Unknown coupons fall back to the coupon's name/ID at the
// call site (stripe-translator's couponCodeFromDiscounts).
export const COUPON_CODES: Record<string, string> = {
  "7imb0DBR": "NAV30", // Pepperstone $30/qtr off — combos + All Markets
  gcUCHGHv: "NAV21", // Pepperstone $21/qtr off — single-market plans
  zqIA0zDQ: "SK50", // LEOW SUI KIANG's personal 50%-off-forever deal
  NAV70: "NAV70", // Pepperstone $70/yr off — single-market annual
  NAV100: "NAV100", // Pepperstone $100/yr off — combo + All Markets annual
};

// --- Display names ---

const PLAN_DISPLAY_NAMES: Record<string, string> = {
  SG: "Singapore Market",
  HK: "Hong Kong Market",
  US: "US Market",
  FXMC: "FXMC Market",
  US_HK: "US + Hong Kong Markets",
  US_SG_FXMC: "US + FXMC",
  HK_SG_FXMC: "HK + FXMC",
  ALL_MARKETS: "All Markets",
};

const MARKET_DISPLAY_NAMES: Record<string, string> = {
  HK: "Hong Kong Market",
  SG: "Singapore Market",
  US: "US Market",
  FXMC: "FXMC Market",
};

export function getPlanDisplayName(planType: string): string {
  return PLAN_DISPLAY_NAMES[planType] || planType;
}

function getMarketDisplayName(marketCode: string): string {
  return MARKET_DISPLAY_NAMES[marketCode] || marketCode;
}

// --- Plan pricing (SGD, quarterly) ---
// Used to classify plan changes as UPGRADED / DOWNGRADED / PLAN_SWITCH.

const PLAN_PRICE_SGD_QUARTERLY: Record<string, number> = {
  FXMC: 168,
  SG: 108,
  HK: 168,
  US: 168,
  US_HK: 297,
  US_SG_FXMC: 297,
  HK_SG_FXMC: 297,
  ALL_MARKETS: 417,
};

function getPlanPriceSGD(planType: string): number {
  const price = PLAN_PRICE_SGD_QUARTERLY[planType];
  if (price === undefined) {
    throw new Error(`No price configured for plan: ${planType}`);
  }
  return price;
}

type PlanChangeAction = "UPGRADED" | "DOWNGRADED" | "PLAN_SWITCH";

export function classifyPlanChange(
  oldPlanType: string,
  newPlanType: string
): PlanChangeAction {
  const oldPrice = getPlanPriceSGD(oldPlanType);
  const newPrice = getPlanPriceSGD(newPlanType);
  if (newPrice > oldPrice) return "UPGRADED";
  if (newPrice < oldPrice) return "DOWNGRADED";
  return "PLAN_SWITCH";
}

// --- Plan category & markets ---

export type PlanCategory = "single" | "combo" | "all" | "unknown";

export interface PlanInfo {
  category: PlanCategory;
  markets: string[];
}

const SINGLE_PLANS = ["SG", "US", "HK", "FXMC"];
const COMBO_PLANS = ["US_HK", "US_SG_FXMC", "HK_SG_FXMC"];

export function parsePlanType(planType: string): PlanInfo {
  if (planType === "ALL_MARKETS") {
    return { category: "all", markets: ["HK", "SG", "US", "FXMC"] };
  }
  if (SINGLE_PLANS.includes(planType)) {
    return { category: "single", markets: [planType] };
  }
  if (COMBO_PLANS.includes(planType)) {
    // Every combo includes the Singapore market as a free bonus, even when the plan
    // string doesn't name it (e.g. US_HK). Display names hide SG; access does not.
    // SG is a combo/All-Markets perk only — the single major plans do NOT include it.
    const markets = planType.split("_");
    if (!markets.includes("SG")) markets.push("SG");
    return { category: "combo", markets };
  }
  return { category: "unknown", markets: [planType] };
}

// --- Telegram invite links ---

// Maps market code to env var name holding its invite link
const MARKET_INVITE_ENV: Record<string, string> = {
  HK: "TELEGRAM_INVITE_HK",
  SG: "TELEGRAM_INVITE_SG",
  US: "TELEGRAM_INVITE_US",
  FXMC: "TELEGRAM_INVITE_FXMC",
};

export interface MarketLink {
  code: string;
  displayName: string;
  url: string;
}

export function getMarketLinks(planType: string): MarketLink[] {
  const { markets } = parsePlanType(planType);
  return markets.map((code) => {
    const envVar = MARKET_INVITE_ENV[code] || `TELEGRAM_INVITE_${code}`;
    return {
      code,
      displayName: getMarketDisplayName(code),
      url: process.env[envVar] || `https://t.me/+placeholder_${code}`,
    };
  });
}

// Fixed links
export const MAIN_CHANNEL_LINK = "https://t.me/+8YBVQvNryk43MWNl";
export const BILLING_PORTAL_LINK =
  "https://billing.stripe.com/p/login/14A28tfhi79h9Mhfgk4ow00";

// --- Website + email assets ---

// Base URL of the marketing site. Guide links and the email logo hang off this.
export const SITE_URL = "https://rho-market-navigator.vercel.app";

// Hosted logo for the email header (a 256px PNG in web/public — email clients
// don't reliably render webp/svg, so keep this a PNG).
export const EMAIL_LOGO_URL = `${SITE_URL}/rho-navigator-logo-256.png`;

// Website guides referenced from the emails.
export const MASTER_GUIDE_LINK = `${SITE_URL}/guides/master`;
export const ATTACH_GUIDE_LINK = `${SITE_URL}/guides/attach-the-navigator`;
// The trial welcome links the trial track's attach step instead: it opens with
// Supercharts and the attach clicks, with no Pepperstone prerequisites — the
// right entry point for a trialist. Paid subscribers keep the full original
// guide, reached having done steps 1-4 of the classic path.
export const ATTACH_GUIDE_INDICATOR_LINK = `${SITE_URL}/guides/trial/attach-the-navigator`;
export const PLACE_TRADE_LINK = `${SITE_URL}/guides/place-a-trade#on-your-computer`;
export const TRADING_GUIDE_LINK = `${SITE_URL}/guides/trading`;
// Step 1 of the setup guide — opening a Pepperstone account under our IB link,
// including what to do if they already have an account.
export const OPEN_PEPPERSTONE_GUIDE_LINK = `${SITE_URL}/guides/open-pepperstone-free-tradingview`;

// Our Pepperstone introducing-broker referral link. This is the URL a client
// must open the account through for the rebate, the lower subscription price
// and the 3 free months of TradingView to attach to us — same link the site
// uses on /free-tradingview and in the Step 1 guide. Keep all three in sync.
export const PEPPERSTONE_SIGNUP_LINK =
  "https://trk.pepperstonepartners.com/aff_c?offer_id=439&aff_id=33751";
