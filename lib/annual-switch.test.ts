// lib/annual-switch.test.ts
import { describe, it, expect } from "vitest";
import {
  decideSwitch, previewAnnual, performAnnual, AnnualPaymentFailed,
  type AnnualStripe, type SubscriptionSnapshot, type SwitchPlan,
} from "./annual-switch.js";
import { signAnnualLink } from "./annual-link.js";
import { ANNUAL_LIST_PRICE_IDS, ANNUAL_GRANDFATHERED_PRICE_IDS } from "./plans.js";
import { ANNUAL_TRIAL_CHARGE_DEADLINE_MS } from "./annual-pricing.js";

const SECRET = "s";
const NOW = Date.UTC(2026, 9, 12, 4, 0); // 12 Oct 2026, inside the window
const LIVE_NEW_ALL = "price_1Te9XoPApeZiCPK2HqYrNNK1";
const LIVE_OLD_ALL = "price_1SOPISPApeZiCPK26eGgrPH2";
const LIVE_NEW_US = "price_1Te9RNPApeZiCPK2q0Dj5Cds";

const snap = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: "sub_1", customerEmail: "ann@example.com", status: "active", priceId: LIVE_NEW_ALL, itemId: "si_1",
  couponIds: ["7imb0DBR"], cancelAtPeriodEnd: false, cancelAt: null, scheduleId: null, trialEnd: null,
  currentPeriodEnd: 1_795_000_000, currentEffectivePrice: 387, ...o,
});

class FakeStripe implements AnnualStripe {
  subs = new Map<string, SubscriptionSnapshot>();
  performed: Array<{ plan: SwitchPlan; key: string }> = [];
  failPayment = false;
  verified = true;
  async getSubscription(id: string) { return this.subs.get(id) ?? null; }
  async previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan) {
    return plan.mode === "trialing" ? 0 : 1000.5;
  }
  async performSwitch(sub: SubscriptionSnapshot, plan: SwitchPlan, key: string) {
    if (this.failPayment) throw new AnnualPaymentFailed("card_declined");
    this.performed.push({ plan, key });
    return this.verified
      ? { periodEnd: 1_822_000_000, verified: true }
      : { periodEnd: 1_822_000_000, verified: false, problems: ["cancel_at still set"] };
  }
}

describe("decideSwitch", () => {
  it("active NAV30 subscriber on a 2026 price -> list annual with NAV100", () => {
    expect(decideSwitch(snap(), NOW)).toEqual({
      mode: "active", targetPriceId: ANNUAL_LIST_PRICE_IDS.live.ALL_MARKETS, couponIds: ["NAV100"], grandfathered: false,
    });
  });
  it("legacy price -> grandfathered annual, no coupon", () => {
    expect(decideSwitch(snap({ priceId: LIVE_OLD_ALL, couponIds: [] }), NOW)).toEqual({
      mode: "active", targetPriceId: ANNUAL_GRANDFATHERED_PRICE_IDS.live.ALL_MARKETS, couponIds: [], grandfathered: true,
    });
  });
  it("single-market NAV21 -> NAV70; unmanaged SK50 carried as is", () => {
    expect((decideSwitch(snap({ priceId: LIVE_NEW_US, couponIds: ["gcUCHGHv"] }), NOW) as SwitchPlan).couponIds).toEqual(["NAV70"]);
    expect((decideSwitch(snap({ priceId: LIVE_NEW_US, couponIds: ["zqIA0zDQ"] }), NOW) as SwitchPlan).couponIds).toEqual(["zqIA0zDQ"]);
  });
  it("trialing -> trialing mode", () => {
    expect((decideSwitch(snap({ status: "trialing", trialEnd: 1_792_000_000 }), NOW) as SwitchPlan).mode).toBe("trialing");
  });
  it("a trial ending after the 31 Oct 23:00 SGT charge deadline is refused", () => {
    const deadlineSec = ANNUAL_TRIAL_CHARGE_DEADLINE_MS / 1000;
    expect(ANNUAL_TRIAL_CHARGE_DEADLINE_MS).toBe(Date.UTC(2026, 9, 31, 15, 0));
    expect(decideSwitch(snap({ status: "trialing", trialEnd: deadlineSec + 1 }), NOW)).toEqual({
      ok: false, reason: "ineligible", detail: "trial ends after the deadline",
    });
    expect((decideSwitch(snap({ status: "trialing", trialEnd: deadlineSec }), NOW) as SwitchPlan).mode).toBe("trialing");
  });
  it("refusals", () => {
    expect(decideSwitch(snap(), Date.UTC(2026, 9, 30, 16, 0))).toEqual({ ok: false, reason: "offer_closed" });
    expect(decideSwitch(snap({ priceId: ANNUAL_LIST_PRICE_IDS.live.ALL_MARKETS }), NOW)).toEqual({ ok: false, reason: "already_annual" });
    expect(decideSwitch(snap({ status: "past_due" }), NOW)).toMatchObject({ ok: false, reason: "ineligible" });
    expect(decideSwitch(snap({ scheduleId: "sub_sched_1" }), NOW)).toMatchObject({ ok: false, reason: "ineligible" });
    expect(decideSwitch(snap({ priceId: "price_unknown" }), NOW)).toMatchObject({ ok: false, reason: "ineligible" });
  });
});

describe("previewAnnual / performAnnual", () => {
  it("preview returns the offer with Stripe's amount due today", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap());
    const t = signAnnualLink("sub_1", "ann@example.com", SECRET);
    const r = await previewAnnual(s, t, SECRET, NOW);
    expect(r).toMatchObject({ ok: true, mode: "active", planType: "ALL_MARKETS", currentPrice: 387, annualPrice: 1290, amountDueToday: 1000.5, grandfathered: false });
  });
  it("SK50 on a legacy single-market price shows half the grandfathered annual (490 -> 245)", async () => {
    const LIVE_OLD_US = "price_1SOPIQPApeZiCPK2B4FlKafO";
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ priceId: LIVE_OLD_US, couponIds: ["zqIA0zDQ"], currentEffectivePrice: 73.5 }));
    const r = await previewAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, NOW);
    expect(r).toMatchObject({ ok: true, planType: "US", annualPrice: 245, grandfathered: true });
  });
  it("preview of a trialist has 0 due today and the trial end as expiry", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ status: "trialing", trialEnd: 1_792_000_000, couponIds: [] }));
    const r = await previewAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, NOW);
    expect(r).toMatchObject({ ok: true, mode: "trialing", annualPrice: 1390, amountDueToday: 0 });
  });
  it("rejects a bad token and an email mismatch", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ customerEmail: "other@example.com" }));
    expect(await previewAnnual(s, "nope", SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await previewAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
  it("perform writes once with a per-minute idempotency key and reports the new expiry", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap());
    const pings: string[] = [];
    const t = signAnnualLink("sub_1", "ann@example.com", SECRET);
    const r = await performAnnual(s, t, SECRET, async (m) => { pings.push(m); }, NOW);
    expect(r).toMatchObject({ ok: true, newExpiry: expect.stringContaining("2027") });
    expect(s.performed).toHaveLength(1);
    expect(s.performed[0].key.startsWith("annual:sub_1:")).toBe(true);
    expect(s.performed[0].key).toBe(`annual:sub_1:${Math.floor(NOW / 60_000)}`);
    expect(s.performed[0].plan.couponIds).toEqual(["NAV100"]);
    expect(pings).toHaveLength(0);
  });
  it("a retry a minute after a decline uses a fresh idempotency key", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap());
    const t = signAnnualLink("sub_1", "ann@example.com", SECRET);
    s.failPayment = true;
    await performAnnual(s, t, SECRET, async () => {}, NOW);
    s.failPayment = false;
    await performAnnual(s, t, SECRET, async () => {}, NOW + 60_000);
    expect(s.performed[0].key).toBe(`annual:sub_1:${Math.floor((NOW + 60_000) / 60_000)}`);
    expect(s.performed[0].key).not.toBe(`annual:sub_1:${Math.floor(NOW / 60_000)}`);
  });
  it("a switch whose post-write check fails still succeeds but pings a warning with sub id and email", async () => {
    const s = new FakeStripe(); s.verified = false; s.subs.set("sub_1", snap());
    const pings: string[] = [];
    const r = await performAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, async (m) => { pings.push(m); }, NOW);
    expect(r).toMatchObject({ ok: true });
    expect(pings).toHaveLength(1);
    expect(pings[0]).toContain("verif");
    expect(pings[0]).toContain("sub_1");
    expect(pings[0]).toContain("ann@example.com");
    expect(pings[0]).toContain("cancel_at still set");
  });
  it("a declined card returns payment_failed and pings", async () => {
    const s = new FakeStripe(); s.failPayment = true; s.subs.set("sub_1", snap());
    const pings: string[] = [];
    const r = await performAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, async (m) => { pings.push(m); }, NOW);
    expect(r).toEqual({ ok: false, reason: "payment_failed", detail: "card_declined" });
    expect(pings[0]).toContain("payment failed");
  });
  it("an ineligible subscription pings Joseph with the reason", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ scheduleId: "sub_sched_9" }));
    const pings: string[] = [];
    await performAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, async (m) => { pings.push(m); }, NOW);
    expect(pings[0]).toContain("ineligible");
    expect(pings[0]).toContain("sub_1");
    expect(pings[0]).toContain("ann@example.com");
    expect(pings[0]).toContain("sub_sched_9");
  });
});
