// =============================================================================
// STRIPE TRANSLATOR
// =============================================================================
// This file's only job: turn a raw Stripe event into a list of plain "notes"
// describing what happened in subscriber terms.
//
// Input:  a Stripe.Event (something like a checkout.session.completed payload)
// Output: an array of SubscriberAction values — e.g. [{ kind: "RENEWED", ... }]
//
// What this file does NOT do:
//   - It does not read or write the Google Sheet.
//   - It does not send emails.
//   - It does not ping Telegram.
//   - It does not decide whether something is a new subscriber or a returning
//     one — that's the lifecycle's job, because it requires looking at the
//     sheet.
//
// Why this split exists: the lifecycle should be readable and testable without
// any Stripe-specific noise. By the time anything leaves this file, all the
// Stripe types have been turned into plain JavaScript objects.
// =============================================================================

import type Stripe from "stripe";
import { getPlanType } from "./plans.js";

/**
 * A "SubscriberAction" is a labelled note describing one thing that happened
 * to a subscriber. The lifecycle module reads the `kind` field and runs the
 * matching rule.
 *
 * A single Stripe event can produce multiple notes. For example, one
 * `customer.subscription.updated` event might carry a plan change AND a
 * cancellation being scheduled — each becomes its own action.
 */
export type SubscriberAction =
  // A brand-new checkout completed. Lifecycle decides whether this is truly
  // new or a reactivation (by checking if the email already exists).
  | {
      kind: "STARTED";
      email: string;
      name: string;
      planType: string;
      subscriptionPrice: number;
      tradingViewUsername: string;
      telegramUsername: string;
      stripeSubscriptionId: string;
      periodStart: Date;
      periodEnd: Date;
    }
  // A quarterly billing cycle was just charged successfully.
  | {
      kind: "RENEWED";
      stripeSubscriptionId: string;
      periodStart: Date;
      periodEnd: Date;
    }
  // The subscriber switched to a different plan. The translator only carries
  // the NEW plan — the lifecycle resolves the old one from the sheet.
  | {
      kind: "PLAN_CHANGED";
      stripeSubscriptionId: string;
      newPlanType: string;
      newSubscriptionPrice: number;
    }
  // The subscriber asked to cancel. Access continues until accessEndDate.
  | {
      kind: "CANCELLATION_SCHEDULED";
      stripeSubscriptionId: string;
      accessEndDate: Date;
      cancellationFeedback: string | null;
      cancellationComment: string | null;
    }
  // The subscription is fully over (period reached its end, or force-cancelled).
  | {
      kind: "ENDED";
      stripeSubscriptionId: string;
    }
  // A payment attempt failed. Stripe will retry automatically.
  | {
      kind: "PAYMENT_FAILED";
      stripeSubscriptionId: string;
      attemptCount: number;
      nextAttemptDate: Date | null;
    }
  // The subscription's status flipped to past_due. Notify-only (no sheet write).
  | {
      kind: "PAST_DUE";
      stripeSubscriptionId: string;
    };

/**
 * The single entry point. Takes a Stripe event, decides which translator to
 * run based on the event type, and returns 0..N actions.
 *
 * Why is it allowed to take a `stripe` client?
 *   `checkout.session.completed` doesn't include the full subscription on the
 *   event payload, so we need to call Stripe to retrieve it. That's a
 *   Stripe-API concern, so it belongs on the translator side of the seam.
 */
export async function translate(
  event: Stripe.Event,
  stripe: Stripe
): Promise<SubscriberAction[]> {
  switch (event.type) {
    case "checkout.session.completed":
      return translateCheckoutCompleted(event, stripe);
    case "invoice.payment_succeeded":
      return translateInvoicePaymentSucceeded(event);
    case "invoice.payment_failed":
      return translateInvoicePaymentFailed(event);
    case "customer.subscription.updated":
      return translateSubscriptionUpdated(event);
    case "customer.subscription.deleted":
      return translateSubscriptionDeleted(event);
    default:
      // Any other event type we don't care about — return empty.
      return [];
  }
}

// =============================================================================
// checkout.session.completed → STARTED
// Fires when a new subscriber finishes Stripe checkout.
// =============================================================================
async function translateCheckoutCompleted(
  event: Stripe.Event,
  stripe: Stripe
): Promise<SubscriberAction[]> {
  const session = event.data.object as Stripe.Checkout.Session;

  // We only handle subscription checkouts. One-time payments (if we ever
  // add them) are ignored here.
  if (session.mode !== "subscription") return [];

  // Pull the subscription ID off the session. It can come as a string or an
  // expanded object, so idFrom() normalises to a string.
  const subscriptionId = idFrom(session.subscription);
  if (!subscriptionId) {
    throw new Error(`Checkout session ${session.id} missing subscription`);
  }

  // The session doesn't carry the full subscription details (price, period),
  // so we fetch the subscription from Stripe.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const price = subscription.items.data[0]?.price;
  if (!price?.id) throw new Error(`No price ID on subscription ${subscriptionId}`);
  const planType = getPlanType(price.id);  // e.g. "US" or "ALL_MARKETS"
  const subscriptionPrice = (price.unit_amount ?? 0) / 100;

  // Email and name: Stripe puts them in different places depending on the
  // checkout flow. Fall through the most-reliable sources.
  const email =
    session.customer_email || session.customer_details?.email || "";
  const name = session.customer_details?.name || email || "Unknown";

  // Custom fields collected during checkout (TradingView + Telegram usernames).
  const { tvUsername, tgUsername } = parseCustomFields(session);

  // Period dates. current_period_end should always be present on a fresh
  // subscription, but we have a fallback that calculates it from the price's
  // recurring interval just in case.
  const periodStart = new Date(subscription.start_date * 1000);
  const periodEndSeconds =
    subscription.current_period_end || calculatePeriodEnd(subscription);
  const periodEnd = periodEndSeconds
    ? new Date(periodEndSeconds * 1000)
    : periodStart;

  return [
    {
      kind: "STARTED",
      email,
      name,
      planType,
      subscriptionPrice,
      tradingViewUsername: tvUsername,
      telegramUsername: tgUsername,
      stripeSubscriptionId: subscriptionId,
      periodStart,
      periodEnd,
    },
  ];
}

// =============================================================================
// invoice.payment_succeeded → RENEWED (renewal cycles only)
// =============================================================================
// This event fires for both new-sub payments AND renewals. We only want
// renewals — the new-sub case is already covered by checkout.session.completed.
// Stripe tags the difference in `billing_reason`.
function translateInvoicePaymentSucceeded(
  event: Stripe.Event
): SubscriberAction[] {
  const invoice = event.data.object as Stripe.Invoice;
  if (invoice.billing_reason !== "subscription_cycle") return [];

  const subscriptionId = idFrom(invoice.subscription);
  if (!subscriptionId) return [];

  return [
    {
      kind: "RENEWED",
      stripeSubscriptionId: subscriptionId,
      periodStart: new Date(invoice.period_start * 1000),
      periodEnd: new Date(invoice.period_end * 1000),
    },
  ];
}

// =============================================================================
// invoice.payment_failed → PAYMENT_FAILED
// =============================================================================
function translateInvoicePaymentFailed(
  event: Stripe.Event
): SubscriberAction[] {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = idFrom(invoice.subscription);
  if (!subscriptionId) return [];

  return [
    {
      kind: "PAYMENT_FAILED",
      stripeSubscriptionId: subscriptionId,
      attemptCount: invoice.attempt_count ?? 1,
      // next_payment_attempt is null when Stripe has given up retrying.
      nextAttemptDate: invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000)
        : null,
    },
  ];
}

// =============================================================================
// customer.subscription.updated → 0..3 actions
// =============================================================================
// This is the busiest event. One update can describe multiple changes at once:
//   - a plan switch
//   - the customer scheduling a cancellation
//   - the status flipping to past_due
// We emit a separate action for each. The lifecycle will apply them in order.
function translateSubscriptionUpdated(
  event: Stripe.Event
): SubscriberAction[] {
  const subscription = event.data.object as Stripe.Subscription;
  // `previous_attributes` tells us what changed. If a field is in here, it
  // means it had a different value before this update.
  const previous = (event.data.previous_attributes ||
    {}) as Partial<Stripe.Subscription>;

  const actions: SubscriberAction[] = [];

  // ---- Plan change: the `items` array changed. ----------------------------
  if (previous.items) {
    const newPrice = subscription.items.data[0]?.price;
    if (newPrice?.id) {
      actions.push({
        kind: "PLAN_CHANGED",
        stripeSubscriptionId: subscription.id,
        newPlanType: getPlanType(newPrice.id),
        newSubscriptionPrice: (newPrice.unit_amount ?? 0) / 100,
      });
    }
  }

  // ---- Cancellation scheduled ---------------------------------------------
  // Stripe uses one of two mechanisms depending on portal configuration:
  //   1. cancel_at changes from null to a timestamp (current portal behavior)
  //   2. cancel_at_period_end flips to true (older behavior)
  // We detect both. cancel_at takes priority as the access-end date source.
  const prevAttr = (event.data.previous_attributes ?? {}) as Record<string, unknown>;
  const cancelViaAt =
    "cancel_at" in prevAttr && prevAttr["cancel_at"] === null && !!subscription.cancel_at;
  const cancelViaPeriodEnd =
    "cancel_at_period_end" in prevAttr && subscription.cancel_at_period_end === true;

  if (cancelViaAt || cancelViaPeriodEnd) {
    const accessEndSeconds =
      subscription.cancel_at ||
      subscription.current_period_end ||
      calculatePeriodEnd(subscription);
    if (accessEndSeconds) {
      actions.push({
        kind: "CANCELLATION_SCHEDULED",
        stripeSubscriptionId: subscription.id,
        accessEndDate: new Date(accessEndSeconds * 1000),
        cancellationFeedback: subscription.cancellation_details?.feedback ?? null,
        cancellationComment: subscription.cancellation_details?.comment ?? null,
      });
    }
  }

  // ---- Status flipped to past_due ----------------------------------------
  if (previous.status && subscription.status === "past_due") {
    actions.push({
      kind: "PAST_DUE",
      stripeSubscriptionId: subscription.id,
    });
  }

  return actions;
}

// =============================================================================
// customer.subscription.deleted → ENDED
// The subscription is fully over (either ran to its access-end date, or
// someone force-cancelled it in the Stripe dashboard).
// =============================================================================
function translateSubscriptionDeleted(
  event: Stripe.Event
): SubscriberAction[] {
  const subscription = event.data.object as Stripe.Subscription;
  return [
    {
      kind: "ENDED",
      stripeSubscriptionId: subscription.id,
    },
  ];
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Stripe IDs sometimes arrive as bare strings, sometimes as expanded objects
 * with `{ id: "..." }`. This normalises to a string (or null).
 */
function idFrom(
  ref: string | { id: string } | null | undefined
): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * Parse the TradingView and Telegram usernames out of a checkout session.
 *
 * Two formats are accepted (the live Stripe form has changed shape once):
 *   1. Two separate custom fields with keys like "tradingview_username" and
 *      "telegram_username".
 *   2. A single field with a comma-separated value: "tvUsername, tgUsername".
 */
function parseCustomFields(
  session: Stripe.Checkout.Session
): { tvUsername: string; tgUsername: string } {
  const fields = session.custom_fields;
  if (!fields?.length) return { tvUsername: "", tgUsername: "" };

  const tvField = fields.find((f) => f.key.includes("tradingview"));
  const tgField = fields.find((f) => f.key.includes("telegram"));

  // Format #1: separate fields found by key.
  if (tvField || tgField) {
    return {
      tvUsername: tvField?.text?.value?.trim() || "",
      tgUsername: tgField?.text?.value?.trim() || "",
    };
  }

  // Format #2: fallback to splitting the first field's value on a comma.
  const combined = fields[0]?.text?.value || "";
  const parts = combined.split(",");
  return {
    tvUsername: parts[0]?.trim() || "",
    tgUsername: parts[1]?.trim() || "",
  };
}

/**
 * Fallback for when `current_period_end` is missing on a subscription.
 * Walks the price's recurring interval forward from start_date and returns
 * the resulting Unix timestamp.
 *
 * Used only as a safety net — Stripe almost always sets current_period_end.
 */
function calculatePeriodEnd(subscription: Stripe.Subscription): number | null {
  const item = subscription.items?.data?.[0];
  if (!item?.price?.recurring) return null;

  const { interval, interval_count } = item.price.recurring;
  const start = new Date(subscription.start_date * 1000);

  switch (interval) {
    case "day":
      start.setDate(start.getDate() + interval_count);
      break;
    case "week":
      start.setDate(start.getDate() + interval_count * 7);
      break;
    case "month":
      start.setMonth(start.getMonth() + interval_count);
      break;
    case "year":
      start.setFullYear(start.getFullYear() + interval_count);
      break;
  }

  return Math.floor(start.getTime() / 1000);
}
