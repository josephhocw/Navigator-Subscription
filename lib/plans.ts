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
};

export function getPlanType(priceId: string): string {
  const plan = PRICE_TO_PLAN[priceId];
  if (!plan) throw new Error(`Unknown Stripe price ID: ${priceId}`);
  return plan;
}

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
