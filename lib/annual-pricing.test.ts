import { describe, it, expect } from "vitest";
import {
  ANNUAL_PRICING,
  MONTHLY_LIST,
  LEGACY_QUARTERLY,
  PLAN_TYPES,
  ANNUAL_OFFER_CLOSES_MS,
  annualOfferOpen,
} from "./annual-pricing.js";

describe("annual pricing table", () => {
  it("covers all eight plans", () => {
    expect(PLAN_TYPES).toEqual([
      "SG", "FXMC", "HK", "US", "US_HK", "US_SG_FXMC", "HK_SG_FXMC", "ALL_MARKETS",
    ]);
    for (const p of PLAN_TYPES) expect(ANNUAL_PRICING[p]).toBeDefined();
  });

  it("annual list is 10 x the monthly list ('2 months free')", () => {
    for (const p of PLAN_TYPES) {
      expect(ANNUAL_PRICING[p].list).toBe(MONTHLY_LIST[p] * 10);
    }
  });

  it("Pepperstone annual is list minus the tier coupon (70 singles, 100 combos/all)", () => {
    expect(ANNUAL_PRICING.SG).toMatchObject({ couponCode: "NAV70", couponOff: 70, pepperstone: 290 });
    expect(ANNUAL_PRICING.US).toMatchObject({ couponCode: "NAV70", couponOff: 70, pepperstone: 490 });
    expect(ANNUAL_PRICING.US_HK).toMatchObject({ couponCode: "NAV100", couponOff: 100, pepperstone: 890 });
    expect(ANNUAL_PRICING.ALL_MARKETS).toMatchObject({ couponCode: "NAV100", couponOff: 100, pepperstone: 1290 });
    for (const p of PLAN_TYPES) {
      expect(ANNUAL_PRICING[p].pepperstone).toBe(ANNUAL_PRICING[p].list - ANNUAL_PRICING[p].couponOff);
    }
  });

  it("grandfathered annual is 10 months at the legacy quarterly rate, rounded to the nearest 10", () => {
    for (const p of PLAN_TYPES) {
      const exact = (LEGACY_QUARTERLY[p] * 10) / 3;
      expect(ANNUAL_PRICING[p].grandfathered).toBe(Math.round(exact / 10) * 10);
    }
    expect(ANNUAL_PRICING.ALL_MARKETS.grandfathered).toBe(1290);
    expect(ANNUAL_PRICING.US_SG_FXMC.grandfathered).toBe(880);
  });

  it("offer closes 30 Oct 2026 23:59 SGT", () => {
    expect(ANNUAL_OFFER_CLOSES_MS).toBe(Date.UTC(2026, 9, 30, 15, 59));
    expect(annualOfferOpen(Date.UTC(2026, 9, 30, 15, 59))).toBe(true);
    expect(annualOfferOpen(Date.UTC(2026, 9, 30, 16, 0))).toBe(false);
  });
});
