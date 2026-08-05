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

/** A Stripe stub whose single invoice has the given status. */
const stripeWithInvoice = (status: string) =>
  ({
    invoices: { retrieve: async () => ({ id: "in_1", status }) },
  }) as unknown as Stripe;

describe("trial conversion (trialing → active)", () => {
  test("emits TRIAL_CONVERTED and NOT a spurious PLAN_CHANGED when the price is unchanged", async () => {
    const priceObj = { id: ALL_MARKETS, unit_amount: 38800 };
    const sub = {
      id: "sub_1",
      status: "active",
      latest_invoice: "in_1",
      items: { data: [{ price: priceObj, current_period_end: 1800000000 }] },
    };
    // previous_attributes carries status:trialing AND items (same price) — the
    // exact shape Stripe sends at conversion.
    const event = updatedEvent(sub, {
      status: "trialing",
      items: { data: [{ price: priceObj }] },
    });

    const actions = await translate(event, stripeWithInvoice("paid"));
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

  // Regression, live incident 2026-08-03. A subscription-schedule rewrite ended
  // two trials without charging anything. The subscriptions went trialing →
  // active carrying a DRAFT invoice, and both subscribers were emailed "you're
  // now a full subscriber" — channel and signal groups revealed — three weeks
  // early, having paid nothing. The status flip is not proof of payment.
  for (const status of ["draft", "open", "void", "uncollectible"]) {
    test(`does NOT emit TRIAL_CONVERTED when the invoice is ${status}`, async () => {
      const priceObj = { id: ALL_MARKETS, unit_amount: 38800 };
      const sub = {
        id: "sub_unpaid",
        status: "active",
        latest_invoice: "in_1",
        items: { data: [{ price: priceObj, current_period_end: 1800000000 }] },
      };
      const event = updatedEvent(sub, {
        status: "trialing",
        items: { data: [{ price: priceObj }] },
      });

      const actions = await translate(event, stripeWithInvoice(status));
      expect(actions.map((a) => a.kind)).not.toContain("TRIAL_CONVERTED");
    });
  }

  test("does NOT emit TRIAL_CONVERTED when there is no invoice at all", async () => {
    const priceObj = { id: ALL_MARKETS, unit_amount: 38800 };
    const sub = {
      id: "sub_noinv",
      status: "active",
      latest_invoice: null,
      items: { data: [{ price: priceObj, current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, {
      status: "trialing",
      items: { data: [{ price: priceObj }] },
    });

    const actions = await translate(event, noopStripe);
    expect(actions.map((a) => a.kind)).not.toContain("TRIAL_CONVERTED");
  });

  test("an unpaid flip still does not raise a spurious PLAN_CHANGED", async () => {
    // The items-with-same-price false positive must stay suppressed even when
    // the conversion email is withheld, or the subscriber gets a plan-change
    // email instead of the welcome we just blocked.
    const priceObj = { id: ALL_MARKETS, unit_amount: 38800 };
    const sub = {
      id: "sub_unpaid_2",
      status: "active",
      latest_invoice: "in_1",
      items: { data: [{ price: priceObj, current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, {
      status: "trialing",
      items: { data: [{ price: priceObj }] },
    });

    const actions = await translate(event, stripeWithInvoice("draft"));
    expect(actions.map((a) => a.kind)).not.toContain("PLAN_CHANGED");
  });
});

describe("checkout attribution (referralSource)", () => {
  // Partner payment links bake subscription_data.metadata.ref into every sub
  // they create, so attribution must survive a bare link shared without the
  // ?client_reference_id URL param (2026-07-28, DrWealth cohort).
  function checkoutEvent(session: unknown): Stripe.Event {
    return {
      type: "checkout.session.completed",
      data: { object: session },
    } as unknown as Stripe.Event;
  }

  const session = {
    id: "cs_ref",
    mode: "subscription",
    subscription: "sub_ref",
    customer_details: { email: "ref@example.com", name: "Ref Person" },
    custom_fields: [],
    client_reference_id: null,
  };

  function stripeReturning(metadata: Record<string, string>): {
    stripe: Stripe;
    updates: unknown[];
  } {
    const updates: unknown[] = [];
    const stripe = {
      subscriptions: {
        retrieve: async () => ({
          id: "sub_ref",
          status: "trialing",
          start_date: 1753600000,
          discounts: [],
          metadata,
          items: {
            data: [
              {
                price: { id: ALL_MARKETS, unit_amount: 41700 },
                current_period_end: 1755000000,
              },
            ],
          },
        }),
        update: async (_id: string, params: unknown) => {
          updates.push(params);
          return {};
        },
      },
    } as unknown as Stripe;
    return { stripe, updates };
  }

  test("bare partner link: metadata.ref fills in when client_reference_id is absent", async () => {
    const { stripe, updates } = stripeReturning({ ref: "drwealth" });
    const actions = await translate(checkoutEvent(session), stripe);
    expect(actions[0]).toMatchObject({
      kind: "STARTED",
      referralSource: "drwealth",
    });
    // metadata already matches — no redundant stamp call.
    expect(updates).toHaveLength(0);
  });

  test("no URL param and no baked metadata → referralSource null", async () => {
    const { stripe, updates } = stripeReturning({});
    const actions = await translate(checkoutEvent(session), stripe);
    expect(actions[0]).toMatchObject({ kind: "STARTED", referralSource: null });
    expect(updates).toHaveLength(0);
  });

  test("URL param wins over baked metadata and stamps it", async () => {
    const { stripe, updates } = stripeReturning({ ref: "drwealth" });
    const actions = await translate(
      checkoutEvent({ ...session, client_reference_id: "otherpartner" }),
      stripe
    );
    expect(actions[0]).toMatchObject({
      kind: "STARTED",
      referralSource: "otherpartner",
    });
    expect(updates).toHaveLength(1);
  });
});

describe("cancellation scheduled / undone (isTrial)", () => {
  // Mirrors STARTED's isTrial?: boolean (set from subscription.status ===
  // "trialing") so the lifecycle can tell a trial-time cancellation apart
  // from a paid one when it starts consuming this flag.
  test("scheduling a cancellation while trialing → CANCELLATION_SCHEDULED isTrial=true", async () => {
    const sub = {
      id: "sub_cs_trial",
      status: "trialing",
      cancel_at_period_end: true,
      cancel_at: null,
      cancellation_details: { comment: null, feedback: null, reason: null },
      items: { data: [{ current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, { cancel_at_period_end: false });

    const actions = await translate(event, noopStripe);
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "CANCELLATION_SCHEDULED", isTrial: true })
    );
  });

  test("scheduling a cancellation while active → CANCELLATION_SCHEDULED isTrial=false", async () => {
    const sub = {
      id: "sub_cs_active",
      status: "active",
      cancel_at_period_end: true,
      cancel_at: null,
      cancellation_details: { comment: null, feedback: null, reason: null },
      items: { data: [{ current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, { cancel_at_period_end: false });

    const actions = await translate(event, noopStripe);
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "CANCELLATION_SCHEDULED", isTrial: false })
    );
  });

  test("scheduling via cancel_at (current portal behavior) while trialing → CANCELLATION_SCHEDULED isTrial=true", async () => {
    // The other three cases above go through cancel_at_period_end (the older
    // mechanism). This guards the cancel_at route — "current portal behavior"
    // per the source comment — so a future refactor that splits the two
    // routes apart can't drop isTrial on the live path unnoticed.
    const sub = {
      id: "sub_cs_cancelat_trial",
      status: "trialing",
      cancel_at: 1800000000,
      cancel_at_period_end: false,
      cancellation_details: { comment: null, feedback: null, reason: null },
      items: { data: [{ current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, { cancel_at: null });

    const actions = await translate(event, noopStripe);
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "CANCELLATION_SCHEDULED", isTrial: true })
    );
  });

  test("undoing a cancellation while trialing → CANCELLATION_UNDONE isTrial=true", async () => {
    const sub = {
      id: "sub_cu_trial",
      status: "trialing",
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [{ current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, { cancel_at_period_end: true });

    const actions = await translate(event, noopStripe);
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "CANCELLATION_UNDONE", isTrial: true })
    );
  });

  test("undoing a cancellation while active → CANCELLATION_UNDONE isTrial=false", async () => {
    const sub = {
      id: "sub_cu_active",
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [{ current_period_end: 1800000000 }] },
    };
    const event = updatedEvent(sub, { cancel_at_period_end: true });

    const actions = await translate(event, noopStripe);
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "CANCELLATION_UNDONE", isTrial: false })
    );
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
