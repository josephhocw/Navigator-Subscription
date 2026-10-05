// =============================================================================
// ANNUAL PLAN — the one price table.
//
// "Annual, 2 months free" = 10 x the monthly list price. The Pepperstone annual
// is the list minus a fixed yearly coupon (NAV70 singles / NAV100 combos+All,
// i.e. the monthly Pepperstone discount x 10). Old-price subscribers get an
// exact grandfathered annual: 10 months at their legacy quarterly rate, rounded
// to the nearest 10. Offer window: 10 Oct – 30 Oct 2026 23:59 SGT.
// =============================================================================

export type BillingInterval = "quarter" | "year";

/** 30 Oct 2026 23:59 SGT. Every annual path checks this; nothing switches after it. */
export const ANNUAL_OFFER_CLOSES_MS = Date.UTC(2026, 9, 30, 15, 59);

/**
 * 31 Oct 2026 23:00 SGT (an hour's margin before 1 Nov). A trialist's annual is
 * collected at trial end, so a trial ending after this would be charged after
 * the offer's 1 Nov cut-off; those are refused.
 */
export const ANNUAL_TRIAL_CHARGE_DEADLINE_MS = Date.UTC(2026, 9, 31, 15, 0);

export function annualOfferOpen(nowMs: number = Date.now()): boolean {
  return nowMs <= ANNUAL_OFFER_CLOSES_MS;
}

export const PLAN_TYPES = [
  "SG", "FXMC", "HK", "US", "US_HK", "US_SG_FXMC", "HK_SG_FXMC", "ALL_MARKETS",
] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** 2026 lineup, per month (billed quarterly x3 today). */
export const MONTHLY_LIST: Record<PlanType, number> = {
  SG: 36, FXMC: 56, HK: 56, US: 56, US_HK: 99, US_SG_FXMC: 99, HK_SG_FXMC: 99, ALL_MARKETS: 139,
};

/** Pre-2026 quarterly prices still charged to grandfathered subscribers. */
export const LEGACY_QUARTERLY: Record<PlanType, number> = {
  SG: 87, FXMC: 147, HK: 147, US: 147, US_HK: 264, US_SG_FXMC: 264, HK_SG_FXMC: 264, ALL_MARKETS: 388,
};

export interface AnnualPrices {
  /** Annual list price, SGD. */
  list: number;
  /** Annual with the Pepperstone coupon applied, SGD. */
  pepperstone: number;
  /** Annual for subscribers on a legacy quarterly price ID, SGD. No coupon applies. */
  grandfathered: number;
  couponCode: "NAV70" | "NAV100";
  couponOff: 70 | 100;
}

const row = (plan: PlanType, couponCode: "NAV70" | "NAV100"): AnnualPrices => {
  const couponOff = couponCode === "NAV70" ? 70 : 100;
  const list = MONTHLY_LIST[plan] * 10;
  return {
    list,
    pepperstone: list - couponOff,
    grandfathered: Math.round((LEGACY_QUARTERLY[plan] * 10) / 3 / 10) * 10,
    couponCode,
    couponOff,
  };
};

export const ANNUAL_PRICING: Record<PlanType, AnnualPrices> = {
  SG: row("SG", "NAV70"),
  FXMC: row("FXMC", "NAV70"),
  HK: row("HK", "NAV70"),
  US: row("US", "NAV70"),
  US_HK: row("US_HK", "NAV100"),
  US_SG_FXMC: row("US_SG_FXMC", "NAV100"),
  HK_SG_FXMC: row("HK_SG_FXMC", "NAV100"),
  ALL_MARKETS: row("ALL_MARKETS", "NAV100"),
};

export function isPlanType(s: string): s is PlanType {
  return (PLAN_TYPES as readonly string[]).includes(s);
}

/**
 * The house money format for emails and the page: `1390` -> `$1,390 SGD`,
 * `987.65` -> `$987.65 SGD`. A non-whole amount always shows two decimals
 * (`$987.60`, never `$987.6`). Mirrored in web/src/pages/annual.astro.
 */
export function sgd(amount: number): string {
  const whole = Number.isInteger(amount);
  const digits = whole ? 0 : 2;
  return `$${amount.toLocaleString("en-SG", { minimumFractionDigits: digits, maximumFractionDigits: digits })} SGD`;
}
