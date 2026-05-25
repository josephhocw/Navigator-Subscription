const PRICE_TO_PLAN: Record<string, string> = {
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
  US_SG_FXMC: "US + Singapore + FXMC Markets",
  HK_SG_FXMC: "HK + Singapore + FXMC Markets",
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

export function getMarketDisplayName(marketCode: string): string {
  return MARKET_DISPLAY_NAMES[marketCode] || marketCode;
}

// --- Plan pricing (SGD, quarterly) ---
// Used to classify plan changes as UPGRADED / DOWNGRADED / PLAN_SWITCH.

const PLAN_PRICE_SGD_QUARTERLY: Record<string, number> = {
  FXMC: 87,
  SG: 87,
  HK: 147,
  US: 147,
  US_HK: 264,
  US_SG_FXMC: 264,
  HK_SG_FXMC: 264,
  ALL_MARKETS: 388,
};

export function getPlanPriceSGD(planType: string): number {
  const price = PLAN_PRICE_SGD_QUARTERLY[planType];
  if (price === undefined) {
    throw new Error(`No price configured for plan: ${planType}`);
  }
  return price;
}

export type PlanChangeAction = "UPGRADED" | "DOWNGRADED" | "PLAN_SWITCH";

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
    return { category: "combo", markets: planType.split("_") };
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
