import { describe, it, expect } from "vitest";
import {
  evaluateJoin,
  isJoinTransition,
  type JoinVerdict,
} from "./telegram-access.js";
import { MAIN_MARKET, type GroupConfig } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

// Minimal subscriber row — only the fields the join guard reads, plus rowIndex.
let nextRow = 2;
function row(over: Partial<Subscriber>): Subscriber {
  return {
    rowIndex: nextRow++,
    email: "x@example.com",
    customerName: "",
    tradingViewUsername: "",
    telegramUsername: "",
    status: "ACTIVE",
    currentPlan: "",
    latestAction: "",
    previousPlan: "",
    subscriptionPrice: 0,
    couponDiscount: false,
    couponCode: "",
    subscriptionStart: "",
    subscriptionExpiry: "",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_x",
    telegramUserId: "",
    referralSource: "",
    followupSent: "",
    mobileNumber: "",
    ...over,
  };
}

const US_GROUP: GroupConfig = { key: "US_MARKET", chatId: -1, market: "US" };
const HK_GROUP: GroupConfig = { key: "HK_MARKET", chatId: -2, market: "HK" };
const SG_GROUP: GroupConfig = { key: "SG_MARKET", chatId: -3, market: "SG" };
const MAIN_GROUP: GroupConfig = { key: "MAIN_GROUP", chatId: -5, market: MAIN_MARKET };
const NO_WHITELIST = new Set<string>();

function verdictOf(v: JoinVerdict) {
  return v.decision === "kick" ? `kick:${v.reason}` : v.decision;
}

describe("evaluateJoin — market groups (ports test_access.py)", () => {
  it("kicks a joiner with no username", () => {
    expect(verdictOf(evaluateJoin(undefined, US_GROUP, [], NO_WHITELIST))).toBe("kick:no-username");
    expect(verdictOf(evaluateJoin("", US_GROUP, [], NO_WHITELIST))).toBe("kick:no-username");
  });

  it("allows a whitelisted user with no sheet lookup", () => {
    const v = evaluateJoin("@Joseph_Ho", US_GROUP, [], new Set(["joseph_ho"]));
    expect(v).toEqual({ decision: "allow", rowsToUpdate: [], reason: "whitelisted" });
  });

  it("kicks when the username is not in the sheet", () => {
    const all = [row({ telegramUsername: "other", currentPlan: "HK" })];
    expect(verdictOf(evaluateJoin("ghost", US_GROUP, all, NO_WHITELIST))).toBe("kick:not-found");
  });

  it("kicks when every row is CANCELLED", () => {
    const all = [row({ telegramUsername: "joe", status: "CANCELLED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, all, NO_WHITELIST))).toBe("kick:cancelled");
  });

  it("allows an active row whose plan covers the market, returning it for the col-P write", () => {
    const r = row({ telegramUsername: "joe", currentPlan: "US" });
    const v = evaluateJoin("joe", US_GROUP, [r], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([r]);
  });

  it("matches case-insensitively and @-tolerantly", () => {
    const r = row({ telegramUsername: "@MaxK", currentPlan: "US" });
    expect(verdictOf(evaluateJoin("maxk", US_GROUP, [r], NO_WHITELIST))).toBe("allow");
  });

  it("a second active row rescues a cancelled first row; ID written to active rows only", () => {
    const dead = row({ telegramUsername: "maxk", status: "CANCELLED", currentPlan: "US" });
    const live = row({ telegramUsername: "maxk", status: "ACTIVE", currentPlan: "US" });
    const v = evaluateJoin("maxk", US_GROUP, [dead, live], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([live]);
  });

  it("unions plans across active rows", () => {
    const a = row({ telegramUsername: "maxk", currentPlan: "US" });
    const b = row({ telegramUsername: "maxk", currentPlan: "HK" });
    const v = evaluateJoin("maxk", HK_GROUP, [a, b], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([a, b]);
  });

  it("kicks an active subscriber whose plan does not cover this market", () => {
    const all = [row({ telegramUsername: "joe", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", HK_GROUP, all, NO_WHITELIST))).toBe("kick:wrong-plan");
  });

  it("a live row with a blank plan grants no market groups (kick wrong-plan)", () => {
    const all = [row({ telegramUsername: "joe", currentPlan: "" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, all, NO_WHITELIST))).toBe("kick:wrong-plan");
  });

  it("PAYMENT_FAILED and CANCELLATION_SCHEDULED are still entitled", () => {
    const pf = [row({ telegramUsername: "joe", status: "PAYMENT_FAILED", currentPlan: "US" })];
    const cs = [row({ telegramUsername: "joe", status: "CANCELLATION_SCHEDULED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, pf, NO_WHITELIST))).toBe("allow");
    expect(verdictOf(evaluateJoin("joe", US_GROUP, cs, NO_WHITELIST))).toBe("allow");
  });

  it("a combo grants the SG bonus group", () => {
    const all = [row({ telegramUsername: "joe", currentPlan: "US_HK" })];
    expect(verdictOf(evaluateJoin("joe", SG_GROUP, all, NO_WHITELIST))).toBe("allow");
  });

  it("DIVERGENCE from access.py: an unrecognised live plan fails safe (allow + flag)", () => {
    const r = row({ telegramUsername: "joe", currentPlan: "BANANA" });
    const v = evaluateJoin("joe", US_GROUP, [r], NO_WHITELIST);
    expect(v.decision).toBe("allow-unrecognised-plan");
    if (v.decision === "allow-unrecognised-plan") expect(v.rowsToUpdate).toEqual([r]);
  });

  it("TRIAL_ACTIVE is entitled; TRIAL_CANCELLED is barred (inherited from liveRowsFor)", () => {
    const trial = [row({ telegramUsername: "joe", status: "TRIAL_ACTIVE", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, trial, NO_WHITELIST))).toBe("allow");
    const dead = [row({ telegramUsername: "moe", status: "TRIAL_CANCELLED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("moe", US_GROUP, dead, NO_WHITELIST))).toBe("kick:cancelled");
  });

  it("TRIAL_CANCELLATION_SCHEDULED is still entitled", () => {
    const all = [row({ telegramUsername: "joe", status: "TRIAL_CANCELLATION_SCHEDULED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, all, NO_WHITELIST))).toBe("allow");
  });
});

describe("evaluateJoin — main group (lenient)", () => {
  it("welcomes a guest who is not in the sheet", () => {
    const v = evaluateJoin("stranger", MAIN_GROUP, [], NO_WHITELIST);
    expect(v).toEqual({ decision: "allow", rowsToUpdate: [], reason: "guest" });
  });

  it("welcomes a joiner with no username", () => {
    const v = evaluateJoin(undefined, MAIN_GROUP, [], NO_WHITELIST);
    expect(v).toEqual({ decision: "allow", rowsToUpdate: [], reason: "guest" });
  });

  it("kicks only when ALL rows are CANCELLED", () => {
    const all = [row({ telegramUsername: "joe", status: "CANCELLED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", MAIN_GROUP, all, NO_WHITELIST))).toBe("kick:cancelled");
  });

  it("any live row allows, even a blank or drifted plan string", () => {
    const blank = row({ telegramUsername: "joe", currentPlan: "" });
    const v1 = evaluateJoin("joe", MAIN_GROUP, [blank], NO_WHITELIST);
    expect(v1.decision).toBe("allow");
    if (v1.decision === "allow") expect(v1.rowsToUpdate).toEqual([blank]);
    const drifted = row({ telegramUsername: "moe", currentPlan: "BANANA" });
    expect(evaluateJoin("moe", MAIN_GROUP, [drifted], NO_WHITELIST).decision).toBe("allow");
  });

  it("one cancelled + one active row still allows, ID to the active row only", () => {
    const dead = row({ telegramUsername: "maxkohts", status: "CANCELLED", currentPlan: "HK" });
    const live = row({ telegramUsername: "maxkohts", status: "ACTIVE", currentPlan: "SG" });
    const v = evaluateJoin("maxkohts", MAIN_GROUP, [dead, live], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([live]);
  });
});

describe("isJoinTransition (ports TestJoinTransition)", () => {
  const m = (status: string, is_member = false) => ({ status, is_member });
  it("left → member is a join", () => expect(isJoinTransition(m("left"), m("member"))).toBe(true));
  it("kicked → member is a join", () => expect(isJoinTransition(m("kicked"), m("member"))).toBe(true));
  it("restricted non-member → member is a join", () =>
    expect(isJoinTransition(m("restricted", false), m("member"))).toBe(true));
  it("restricted member → member is not a join", () =>
    expect(isJoinTransition(m("restricted", true), m("member"))).toBe(false));
  it("member → administrator is not a join", () =>
    expect(isJoinTransition(m("member"), m("administrator"))).toBe(false));
  it("left → restricted member is a join", () =>
    expect(isJoinTransition(m("left"), m("restricted", true))).toBe(true));
});
