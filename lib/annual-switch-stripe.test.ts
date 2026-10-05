// lib/annual-switch-stripe.test.ts
import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import { StripeAnnualClient } from "./annual-switch-stripe.js";
import type { SubscriptionSnapshot, SwitchPlan } from "./annual-switch.js";

const LIVE_NEW_ALL = "price_1Te9XoPApeZiCPK2HqYrNNK1";

describe("StripeAnnualClient.getSubscription", () => {
  it("maps a Stripe subscription to a snapshot", async () => {
    const sdk = {
      subscriptions: {
        retrieve: async () => ({
          id: "sub_1",
          status: "active",
          customer: { email: "Ann@Example.com", deleted: false },
          items: { data: [{ id: "si_1", price: { id: LIVE_NEW_ALL, unit_amount: 41700 }, current_period_end: 1_795_000_000 }] },
          discounts: [{ coupon: { id: "7imb0DBR", amount_off: 3000 } }],
          cancel_at_period_end: true,
          cancel_at: 1_795_000_000,
          schedule: null,
          trial_end: null,
        }),
      },
    } as unknown as Stripe;
    const c = new StripeAnnualClient(sdk);
    expect(await c.getSubscription("sub_1")).toEqual({
      id: "sub_1", customerEmail: "Ann@Example.com", status: "active", priceId: LIVE_NEW_ALL, itemId: "si_1",
      couponIds: ["7imb0DBR"], cancelAtPeriodEnd: true, cancelAt: 1_795_000_000, scheduleId: null, trialEnd: null,
      currentPeriodEnd: 1_795_000_000, currentEffectivePrice: 387,
    });
  });
  it("returns null for a missing subscription", async () => {
    const sdk = { subscriptions: { retrieve: async () => { throw Object.assign(new Error("no"), { code: "resource_missing" }); } } } as unknown as Stripe;
    expect(await new StripeAnnualClient(sdk).getSubscription("sub_x")).toBeNull();
  });
});

// --- performSwitch / preview against a recording fake Stripe -----------------

const TARGET = "price_annual_all";

const snapshot = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: "sub_1", customerEmail: "ann@example.com", status: "active", priceId: LIVE_NEW_ALL, itemId: "si_1",
  couponIds: ["7imb0DBR"], cancelAtPeriodEnd: false, cancelAt: null, scheduleId: null, trialEnd: null,
  currentPeriodEnd: 1_795_000_000, currentEffectivePrice: 387, ...o,
});
const activePlan: SwitchPlan = { mode: "active", targetPriceId: TARGET, couponIds: ["NAV100"], grandfathered: false };

/** What the re-read after the write returns. Defaults = a clean switch. */
interface AfterState { price?: string; coupons?: string[]; cancelAt?: number | null; cancelAtPeriodEnd?: boolean }

function recordingSdk(after: AfterState = {}) {
  const calls: { update: unknown[]; preview: unknown[]; retrieve: unknown[] } = { update: [], preview: [], retrieve: [] };
  const sdk = {
    subscriptions: {
      update: async (id: string, params: unknown, opts: unknown) => {
        calls.update.push({ id, params, opts });
        return { id, items: { data: [{ id: "si_1", current_period_end: 1_822_000_000 }] } };
      },
      retrieve: async (id: string, opts: unknown) => {
        calls.retrieve.push({ id, opts });
        return {
          id,
          items: { data: [{ id: "si_1", price: { id: after.price ?? TARGET } }] },
          discounts: (after.coupons ?? ["NAV100"]).map((c) => ({ coupon: { id: c } })),
          cancel_at: after.cancelAt ?? null,
          cancel_at_period_end: after.cancelAtPeriodEnd ?? false,
        };
      },
    },
    invoices: {
      createPreview: async (params: unknown) => {
        calls.preview.push(params);
        return { amount_due: 100050, total: 100050 };
      },
    },
  } as unknown as Stripe;
  return { sdk, calls };
}

describe("StripeAnnualClient.performSwitch", () => {
  it("clears a portal-scheduled cancel_at with an empty string alongside cancel_at_period_end", async () => {
    const { sdk, calls } = recordingSdk();
    const r = await new StripeAnnualClient(sdk).performSwitch(snapshot({ cancelAt: 1_795_000_000 }), activePlan, "k1");
    const params = (calls.update[0] as { params: Record<string, unknown> }).params;
    expect(params.cancel_at).toBe("");
    expect(params.cancel_at_period_end).toBe(false);
    expect(r).toEqual({ periodEnd: 1_822_000_000, verified: true, problems: [] });
  });
  it("does not send cancel_at when none is scheduled", async () => {
    const { sdk, calls } = recordingSdk();
    await new StripeAnnualClient(sdk).performSwitch(snapshot(), activePlan, "k1");
    const params = (calls.update[0] as { params: Record<string, unknown> }).params;
    expect("cancel_at" in params).toBe(false);
    expect(params.cancel_at_period_end).toBe(false);
  });
  it("the preview clears the cancellation the same way", async () => {
    const { sdk, calls } = recordingSdk();
    await new StripeAnnualClient(sdk).previewAmountDueToday(snapshot({ cancelAt: 1_795_000_000 }), activePlan);
    const details = (calls.preview[0] as { subscription_details: Record<string, unknown> }).subscription_details;
    expect(details.cancel_at).toBe("");
    expect(details.cancel_at_period_end).toBe(false);
  });
  it("re-reads after the write and reports every mismatch without throwing", async () => {
    const { sdk, calls } = recordingSdk({ price: LIVE_NEW_ALL, coupons: ["7imb0DBR"], cancelAt: 1_795_000_000, cancelAtPeriodEnd: true });
    const r = await new StripeAnnualClient(sdk).performSwitch(snapshot({ cancelAt: 1_795_000_000 }), activePlan, "k1");
    expect(calls.retrieve).toHaveLength(1);
    expect(r.verified).toBe(false);
    expect(r.problems).toHaveLength(4);
    expect(r.problems!.join(" ")).toContain(LIVE_NEW_ALL);
  });
  it("a failed re-read counts as unverified, not as a thrown error", async () => {
    const { sdk } = recordingSdk();
    (sdk.subscriptions as unknown as { retrieve: () => Promise<never> }).retrieve = async () => { throw new Error("boom"); };
    const r = await new StripeAnnualClient(sdk).performSwitch(snapshot(), activePlan, "k1");
    expect(r.verified).toBe(false);
    expect(r.periodEnd).toBe(1_822_000_000);
  });
});
