// Focused translator tests for the trial flows. These lock in behaviour that a
// live test-clock run verified on 2026-07-27 (the trialing→active event carries
// `items` in previous_attributes with an UNCHANGED price, which used to trigger
// a spurious PLAN_CHANGED alongside TRIAL_CONVERTED).

import { describe, test, expect } from "vitest";
import type Stripe from "stripe";
import { translate } from "./stripe-translator.js";

// Mapped prices from plans.ts.
const ALL_MARKETS = "price_1SNau9PApeZiCPK22ZjuVaKQ"; // test-mode All Markets
const US = "price_1SNb26PApeZiCPK25nSa9j6H"; // test-mode US

function updatedEvent(object: unknown, previous_attributes: unknown): Stripe.Event {
  return {
    type: "customer.subscription.updated",
    data: { object, previous_attributes },
  } as unknown as Stripe.Event;
}

function deletedEvent(object: unknown): Stripe.Event {
  return {
    type: "customer.subscription.deleted",
    data: { object },
  } as unknown as Stripe.Event;
}

const noopStripe = {} as unknown as Stripe;

describe("trial conversion (trialing → active)", () => {
  test("emits TRIAL_CONVERTED and NOT a spurious PLAN_CHANGED when the price is unchanged", async () => {
    const priceObj = { id: ALL_MARKETS, unit_amount: 38800 };
    const sub = {
      id: "sub_1",
      status: "active",
      items: { data: [{ price: priceObj, current_period_end: 1800000000 }] },
    };
    // previous_attributes carries status:trialing AND items (same price) — the
    // exact shape Stripe sends at conversion.
    const event = updatedEvent(sub, {
      status: "trialing",
      items: { data: [{ price: priceObj }] },
    });

    const actions = await translate(event, noopStripe);
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain("TRIAL_CONVERTED");
    expect(kinds).not.toContain("PLAN_CHANGED");
    const tc = actions.find((a) => a.kind === "TRIAL_CONVERTED") as { planType: string };
    expect(tc.planType).toBe("ALL_MARKETS");
  });

  test("a genuine plan change (different price) still emits PLAN_CHANGED", async () => {
    const sub = {
      id: "sub_2",
      status: "active",
      items: { data: [{ price: { id: US, unit_amount: 14700 }, current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, {
      items: { data: [{ price: { id: ALL_MARKETS } }] }, // was All Markets, now US
    });
    const stripe = {
      subscriptions: {
        retrieve: async () => ({ discounts: [], items: { data: [{ price: { id: US, unit_amount: 14700 } }] } }),
      },
    } as unknown as Stripe;

    const actions = await translate(event, stripe);
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain("PLAN_CHANGED");
    expect(kinds).not.toContain("TRIAL_CONVERTED");
  });
});

describe("subscription deleted (win-back detection)", () => {
  test("a trial that never charged → ENDED wasUnconvertedTrial=true", async () => {
    const event = deletedEvent({ id: "sub_3", trial_end: 1790000000 });
    const stripe = {
      invoices: { list: async () => ({ data: [{ amount_paid: 0 }] }) },
    } as unknown as Stripe;

    const actions = await translate(event, stripe);
    expect(actions).toEqual([
      { kind: "ENDED", stripeSubscriptionId: "sub_3", wasUnconvertedTrial: true },
    ]);
  });

  test("a trial that DID charge → ENDED wasUnconvertedTrial=false", async () => {
    const event = deletedEvent({ id: "sub_4", trial_end: 1790000000 });
    const stripe = {
      invoices: { list: async () => ({ data: [{ amount_paid: 41700 }] }) },
    } as unknown as Stripe;

    const actions = await translate(event, stripe);
    expect(actions[0]).toMatchObject({ kind: "ENDED", wasUnconvertedTrial: false });
  });

  test("a normal (non-trial) cancellation → ENDED wasUnconvertedTrial=false, no invoice lookup", async () => {
    const event = deletedEvent({ id: "sub_5" }); // no trial_end
    let called = false;
    const stripe = {
      invoices: { list: async () => { called = true; return { data: [] }; } },
    } as unknown as Stripe;

    const actions = await translate(event, stripe);
    expect(actions[0]).toMatchObject({ kind: "ENDED", wasUnconvertedTrial: false });
    expect(called).toBe(false); // skips the API call entirely when there was no trial
  });
});
