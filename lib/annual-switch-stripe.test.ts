// lib/annual-switch-stripe.test.ts
import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import { StripeAnnualClient } from "./annual-switch-stripe.js";

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
          schedule: null,
          trial_end: null,
        }),
      },
    } as unknown as Stripe;
    const c = new StripeAnnualClient(sdk);
    expect(await c.getSubscription("sub_1")).toEqual({
      id: "sub_1", customerEmail: "Ann@Example.com", status: "active", priceId: LIVE_NEW_ALL, itemId: "si_1",
      couponIds: ["7imb0DBR"], cancelAtPeriodEnd: true, scheduleId: null, trialEnd: null,
      currentPeriodEnd: 1_795_000_000, currentEffectivePrice: 387,
    });
  });
  it("returns null for a missing subscription", async () => {
    const sdk = { subscriptions: { retrieve: async () => { throw Object.assign(new Error("no"), { code: "resource_missing" }); } } } as unknown as Stripe;
    expect(await new StripeAnnualClient(sdk).getSubscription("sub_x")).toBeNull();
  });
});
