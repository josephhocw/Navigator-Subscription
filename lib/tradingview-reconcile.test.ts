// =============================================================================
// TRADINGVIEW RECONCILE TESTS
// =============================================================================
// computeReconciliation is a pure diff — these drive it with hand-built rows
// and grantee lists, covering the reconcile test cases (20–22) plus the
// two-subscription edge case.
// =============================================================================

import { describe, test, expect } from "vitest";
import { computeReconciliation } from "./tradingview-reconcile.js";
import type { Subscriber } from "./subscriber-store.js";

function sub(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    rowIndex: 2,
    email: "x@example.com",
    customerName: "X",
    tradingViewUsername: "user1",
    telegramUsername: "user1",
    status: "ACTIVE",
    currentPlan: "US",
    latestAction: "NEW_SUBSCRIPTION",
    previousPlan: "",
    subscriptionPrice: 168,
    couponDiscount: false,
    subscriptionStart: "",
    subscriptionExpiry: "",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_1",
    telegramUserId: "",
    referralSource: "",
    followupSent: "",
    mobileNumber: "",
    ...overrides,
  };
}

describe("computeReconciliation", () => {
  test("case 20: entitled subscriber missing their script → grant", () => {
    const plan = computeReconciliation([sub({ currentPlan: "US" })], { US: [] });
    expect(plan.toGrant).toEqual([{ username: "user1", planType: "US" }]);
    expect(plan.toRemove).toEqual([]);
  });

  test("case 21: cancelled subscriber still on a script → remove", () => {
    const plan = computeReconciliation(
      [sub({ status: "CANCELLED", currentPlan: "US" })],
      { US: ["user1"] }
    );
    expect(plan.toRemove).toEqual([{ username: "user1", planType: "US" }]);
    expect(plan.toGrant).toEqual([]);
  });

  test("case 22: a username not in the sheet (comp) is never touched", () => {
    // 'gansally' holds every script but isn't a subscriber → left alone.
    const grants: Record<string, string[]> = {};
    for (const p of ["SG", "FXMC", "HK", "US", "US_HK", "US_SG_FXMC", "HK_SG_FXMC", "ALL_MARKETS"]) {
      grants[p] = ["gansally"];
    }
    const plan = computeReconciliation([sub({ currentPlan: "US", tradingViewUsername: "user1" })], {
      ...grants,
      US: ["gansally", "user1"], // user1 correctly present on US
    });
    expect(plan.toGrant).toEqual([]);
    // No remove for gansally on any script, despite holding all 8.
    expect(plan.toRemove).toEqual([]);
  });

  test("already-correct state produces no actions", () => {
    const plan = computeReconciliation([sub({ currentPlan: "ALL_MARKETS" })], {
      ALL_MARKETS: ["User1"], // different case, still matches
    });
    expect(plan.toGrant).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  test("wrong-plan leftover: active on US but present on HK → grant US, remove HK", () => {
    const plan = computeReconciliation([sub({ currentPlan: "US" })], {
      HK: ["user1"],
    });
    expect(plan.toGrant).toEqual([{ username: "user1", planType: "US" }]);
    expect(plan.toRemove).toEqual([{ username: "user1", planType: "HK" }]);
  });

  test("two active subscriptions for one username → union of plans, no spurious remove", () => {
    const rows = [
      sub({ currentPlan: "US", stripeSubscriptionId: "sub_a" }),
      sub({ currentPlan: "HK", stripeSubscriptionId: "sub_b" }),
    ];
    // Already on US; missing HK.
    const plan = computeReconciliation(rows, { US: ["user1"], HK: [] });
    expect(plan.toGrant).toEqual([{ username: "user1", planType: "HK" }]);
    expect(plan.toRemove).toEqual([]);
  });

  test("subscriber with no TradingView username is skipped", () => {
    const plan = computeReconciliation([sub({ tradingViewUsername: "" })], { US: [] });
    expect(plan.toGrant).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  test("safety guard: an active subscriber with an unrecognised plan is never removed", () => {
    // Typo'd plan "USA" — the sheet says active, they're on the US script.
    // We must NOT strip their access; flag them instead.
    const plan = computeReconciliation([sub({ status: "ACTIVE", currentPlan: "USA" })], {
      US: ["user1"],
    });
    expect(plan.toRemove).toEqual([]); // NOT removed despite "USA" being unknown
    expect(plan.toGrant).toEqual([]);
    expect(plan.uncertain).toEqual(["user1"]);
  });

  test("a cancelled row does not make an otherwise-active user uncertain", () => {
    // Two rows: active ALL_MARKETS (valid) + an old cancelled row with junk plan.
    // The valid entitled row wins; not uncertain, and kept on ALL_MARKETS.
    const plan = computeReconciliation(
      [
        sub({ status: "ACTIVE", currentPlan: "ALL_MARKETS", stripeSubscriptionId: "a" }),
        sub({ status: "CANCELLED", currentPlan: "JUNK", stripeSubscriptionId: "b" }),
      ],
      { ALL_MARKETS: ["user1"] }
    );
    expect(plan.uncertain).toEqual([]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.toGrant).toEqual([]);
  });

  test("TRIAL_ACTIVE subscriber missing their script → grant", () => {
    const plan = computeReconciliation([sub({ status: "TRIAL_ACTIVE", currentPlan: "US" })], { US: [] });
    expect(plan.toGrant).toEqual([{ username: "user1", planType: "US" }]);
    expect(plan.toRemove).toEqual([]);
  });

  test("TRIAL_CANCELLATION_SCHEDULED subscriber keeps their script (no removal)", () => {
    const plan = computeReconciliation(
      [sub({ status: "TRIAL_CANCELLATION_SCHEDULED", currentPlan: "US" })],
      { US: ["user1"] }
    );
    expect(plan.toGrant).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  test("TRIAL_CANCELLED subscriber on a script → remove", () => {
    const plan = computeReconciliation(
      [sub({ status: "TRIAL_CANCELLED", currentPlan: "US" })],
      { US: ["user1"] }
    );
    expect(plan.toRemove).toEqual([{ username: "user1", planType: "US" }]);
    expect(plan.toGrant).toEqual([]);
  });
});
