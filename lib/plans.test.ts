// lib/plans.test.ts
import { describe, it, expect } from "vitest";
import {
  getPlanType,
  getBillingInterval,
  isLegacyQuarterlyPrice,
  stripeModeOfPrice,
  annualTargetPriceFor,
  ANNUAL_LIST_PRICE_IDS,
  ANNUAL_GRANDFATHERED_PRICE_IDS,
  ANNUAL_COUPON_FOR_QUARTERLY,
  COUPON_CODES,
} from "./plans.js";

const LIVE_NEW_US = "price_1Te9RNPApeZiCPK2q0Dj5Cds";
const LIVE_OLD_US = "price_1SOPIQPApeZiCPK2B4FlKafO";
const LIVE_OLD_ALL = "price_1SOPISPApeZiCPK26eGgrPH2";
const TEST_US = "price_1SNb26PApeZiCPK25nSa9j6H";

describe("annual price IDs", () => {
  it("every annual price resolves to its plan and reads as yearly", () => {
    for (const mode of ["live", "test"] as const) {
      for (const [plan, id] of Object.entries(ANNUAL_LIST_PRICE_IDS[mode])) {
        expect(getPlanType(id)).toBe(plan);
        expect(getBillingInterval(id)).toBe("year");
      }
      for (const [plan, id] of Object.entries(ANNUAL_GRANDFATHERED_PRICE_IDS[mode])) {
        expect(getPlanType(id)).toBe(plan);
        expect(getBillingInterval(id)).toBe("year");
      }
    }
    expect(Object.keys(ANNUAL_LIST_PRICE_IDS.live)).toHaveLength(8);
    expect(Object.keys(ANNUAL_GRANDFATHERED_PRICE_IDS.live)).toHaveLength(8);
  });

  it("quarterly prices read as quarter", () => {
    expect(getBillingInterval(LIVE_NEW_US)).toBe("quarter");
    expect(getBillingInterval(LIVE_OLD_US)).toBe("quarter");
    expect(getBillingInterval(TEST_US)).toBe("quarter");
  });

  it("legacy detection is by price ID, never by amount", () => {
    expect(isLegacyQuarterlyPrice(LIVE_OLD_US)).toBe(true);
    expect(isLegacyQuarterlyPrice(LIVE_NEW_US)).toBe(false);
    expect(isLegacyQuarterlyPrice(TEST_US)).toBe(false);
  });

  it("knows which Stripe mode a price belongs to", () => {
    expect(stripeModeOfPrice(LIVE_NEW_US)).toBe("live");
    expect(stripeModeOfPrice(TEST_US)).toBe("test");
  });

  it("targets the grandfathered annual for a legacy price, the list annual otherwise", () => {
    expect(annualTargetPriceFor(LIVE_OLD_ALL)).toBe(ANNUAL_GRANDFATHERED_PRICE_IDS.live.ALL_MARKETS);
    expect(annualTargetPriceFor(LIVE_NEW_US)).toBe(ANNUAL_LIST_PRICE_IDS.live.US);
    expect(() => annualTargetPriceFor("price_nope")).toThrow(/Unknown Stripe price ID/);
  });

  it("maps the quarterly Pepperstone coupons to their annual counterparts", () => {
    expect(ANNUAL_COUPON_FOR_QUARTERLY).toEqual({ gcUCHGHv: "NAV70", "7imb0DBR": "NAV100" });
    expect(COUPON_CODES.NAV70).toBe("NAV70");
    expect(COUPON_CODES.NAV100).toBe("NAV100");
  });
});
