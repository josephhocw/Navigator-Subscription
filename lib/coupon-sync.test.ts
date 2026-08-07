import { describe, it, expect } from "vitest";
import {
  NAV21_COUPON_ID,
  NAV30_COUPON_ID,
  desiredCouponForPlan,
  verdictForSubscription,
  buildPhaseCouponPlan,
  isManagedCoupon,
  type PhaseCouponState,
} from "./coupon-sync.js";

const SK50 = "zqIA0zDQ"; // LEOW SUI KIANG's personal 50%-off-forever deal

describe("desiredCouponForPlan", () => {
  it("puts NAV21 on every single-market plan", () => {
    for (const plan of ["SG", "US", "HK", "FXMC"]) {
      expect(desiredCouponForPlan(plan)).toBe(NAV21_COUPON_ID);
    }
  });

  it("puts NAV30 on combos and All Markets", () => {
    for (const plan of ["US_HK", "US_SG_FXMC", "HK_SG_FXMC", "ALL_MARKETS"]) {
      expect(desiredCouponForPlan(plan)).toBe(NAV30_COUPON_ID);
    }
  });

  it("returns null for an unrecognised plan rather than guessing", () => {
    expect(desiredCouponForPlan("HK ")).toBeNull();
    expect(desiredCouponForPlan("NONSENSE")).toBeNull();
  });
});

describe("verdictForSubscription", () => {
  it("does nothing when there is no coupon — it never grants one", () => {
    expect(verdictForSubscription([], "US")).toEqual({ kind: "no_coupon" });
  });

  it("swaps NAV21 → NAV30 on an upgrade across the tier boundary", () => {
    expect(verdictForSubscription([NAV21_COUPON_ID], "ALL_MARKETS")).toEqual({
      kind: "swap",
      from: NAV21_COUPON_ID,
      to: NAV30_COUPON_ID,
    });
  });

  it("swaps NAV30 → NAV21 when landing on a single-market plan", () => {
    expect(verdictForSubscription([NAV30_COUPON_ID], "US")).toEqual({
      kind: "swap",
      from: NAV30_COUPON_ID,
      to: NAV21_COUPON_ID,
    });
  });

  it("leaves a within-tier move alone (combo ↔ All Markets)", () => {
    expect(verdictForSubscription([NAV30_COUPON_ID], "US_HK")).toEqual({
      kind: "correct",
      couponId: NAV30_COUPON_ID,
    });
  });

  it("leaves a within-tier move alone (US → SG, both single)", () => {
    expect(verdictForSubscription([NAV21_COUPON_ID], "SG")).toEqual({
      kind: "correct",
      couponId: NAV21_COUPON_ID,
    });
  });

  it("never touches SK50 — the personal forever deal", () => {
    expect(verdictForSubscription([SK50], "US")).toEqual({
      kind: "unmanaged",
      couponId: SK50,
    });
  });

  it("refuses to act when several discounts are stacked", () => {
    const v = verdictForSubscription([NAV30_COUPON_ID, SK50], "US");
    expect(v.kind).toBe("unmanaged");
  });

  it("refuses to act on an unrecognised plan instead of stripping the coupon", () => {
    expect(verdictForSubscription([NAV30_COUPON_ID], "HK ")).toEqual({
      kind: "unknown_plan",
      planType: "HK ",
    });
  });
});

describe("isManagedCoupon", () => {
  it("recognises only the two Pepperstone coupons", () => {
    expect(isManagedCoupon(NAV21_COUPON_ID)).toBe(true);
    expect(isManagedCoupon(NAV30_COUPON_ID)).toBe(true);
    expect(isManagedCoupon(SK50)).toBe(false);
    expect(isManagedCoupon(null)).toBe(false);
    expect(isManagedCoupon(undefined)).toBe(false);
  });
});

describe("buildPhaseCouponPlan", () => {
  const phase = (
    planType: string | null,
    couponIds: string[] = [],
    isTrial = false
  ): PhaseCouponState => ({ planType, couponIds, isTrial });

  it("swaps only the phase that crosses the tier boundary", () => {
    // The live shape: still on All Markets this period, downgrading to US.
    const plan = buildPhaseCouponPlan(
      [phase("ALL_MARKETS", [NAV30_COUPON_ID]), phase("US", [NAV30_COUPON_ID])],
      [NAV30_COUPON_ID]
    );
    expect(plan.phaseCouponIds).toEqual([[NAV30_COUPON_ID], [NAV21_COUPON_ID]]);
    expect(plan.changed).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it("reports no change for a within-tier downgrade (All Markets → combo)", () => {
    const plan = buildPhaseCouponPlan(
      [phase("ALL_MARKETS", [NAV30_COUPON_ID]), phase("US_HK", [NAV30_COUPON_ID])],
      [NAV30_COUPON_ID]
    );
    expect(plan.phaseCouponIds).toEqual([[NAV30_COUPON_ID], [NAV30_COUPON_ID]]);
    expect(plan.changed).toBe(false);
  });

  it("ALWAYS emits an explicit coupon list per phase — omitting it wipes the live sub", () => {
    const plan = buildPhaseCouponPlan(
      [phase("ALL_MARKETS", [NAV30_COUPON_ID]), phase("US_HK", [NAV30_COUPON_ID])],
      [NAV30_COUPON_ID]
    );
    // Even with nothing to change, every phase carries its discounts forward.
    expect(plan.phaseCouponIds.every((ids) => Array.isArray(ids))).toBe(true);
    expect(plan.phaseCouponIds[0]).toHaveLength(1);
    expect(plan.phaseCouponIds[1]).toHaveLength(1);
  });

  it("restores a coupon a previous phase write dropped", () => {
    // Subscription still carries NAV30; phase 1 lost its discounts.
    const plan = buildPhaseCouponPlan(
      [phase("ALL_MARKETS", [NAV30_COUPON_ID]), phase("US_HK", [])],
      [NAV30_COUPON_ID]
    );
    expect(plan.phaseCouponIds[1]).toEqual([NAV30_COUPON_ID]);
    expect(plan.changed).toBe(true);
    expect(plan.notes.join(" ")).toContain("restored");
  });

  it("emits empty lists when there is no discount anywhere", () => {
    const plan = buildPhaseCouponPlan([phase("ALL_MARKETS"), phase("US")], []);
    expect(plan.phaseCouponIds).toEqual([[], []]);
    expect(plan.changed).toBe(false);
  });

  it("keeps an unmanaged coupon verbatim and blocks the whole sync", () => {
    const plan = buildPhaseCouponPlan(
      [phase("ALL_MARKETS", [SK50]), phase("US", [SK50])],
      [SK50]
    );
    expect(plan.phaseCouponIds).toEqual([[SK50], [SK50]]);
    expect(plan.changed).toBe(false);
    expect(plan.blockers).toHaveLength(2);
  });

  it("leaves an unparseable phase plan untouched and blocks", () => {
    const plan = buildPhaseCouponPlan(
      [phase("ALL_MARKETS", [NAV30_COUPON_ID]), phase("HK ", [NAV30_COUPON_ID])],
      [NAV30_COUPON_ID]
    );
    expect(plan.phaseCouponIds[1]).toEqual([NAV30_COUPON_ID]);
    expect(plan.blockers.join(" ")).toContain("unknown plan");
  });

  it("leaves a trial phase's coupon alone but still resends it", () => {
    // The live 25-July shape: trial phase is All Markets, paid phase is US,
    // both already NAV21. The trial never charges, so nothing needs changing —
    // but phase 0 must still carry its discount forward or the write wipes it.
    const plan = buildPhaseCouponPlan(
      [
        phase("ALL_MARKETS", [NAV21_COUPON_ID], true),
        phase("US", [NAV21_COUPON_ID]),
      ],
      [NAV21_COUPON_ID]
    );
    expect(plan.phaseCouponIds[0]).toEqual([NAV21_COUPON_ID]); // verbatim
    expect(plan.phaseCouponIds[1]).toEqual([NAV21_COUPON_ID]); // already correct
    expect(plan.changed).toBe(false); // no pointless write against live money
  });

  it("still fixes the charging phase when the trial phase differs", () => {
    const plan = buildPhaseCouponPlan(
      [
        phase("ALL_MARKETS", [NAV30_COUPON_ID], true),
        phase("US", [NAV30_COUPON_ID]),
      ],
      [NAV30_COUPON_ID]
    );
    expect(plan.phaseCouponIds[0]).toEqual([NAV30_COUPON_ID]); // trial untouched
    expect(plan.phaseCouponIds[1]).toEqual([NAV21_COUPON_ID]); // charging phase fixed
    expect(plan.changed).toBe(true);
  });
});
