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
      currentPlan: string;
      subscriptionPrice: number; // effective price after any coupon
      couponDiscount: boolean;
      couponCode: string | null; // promo code string used at checkout, e.g. "PS125"
      tradingViewUsername: string;
      telegramUsername: string;
      stripeSubscriptionId: string;
      periodStart: Date;
      periodEnd: Date;
      // Partner attribution: the ?client_reference_id=... the website appended
      // to the payment link (from a ?ref= landing, e.g. "drwealth"). Null when
      // the checkout carried none — the organic path.
      referralSource: string | null;
    }
  // A quarterly billing cycle was just charged successfully.
  | {
      kind: "RENEWED";
      stripeSubscriptionId: string;
      periodStart: Date;
      periodEnd: Date;
      // What this invoice actually paid for. Carried so the lifecycle can
      // detect a period-boundary plan change (scheduled downgrade executing)
      // even when this invoice arrives BEFORE the subscription.updated event
      // — Stripe does not guarantee delivery order.
      planType: string | null; // null if the line's price ID is missing or unrecognised
      subscriptionPrice: number; // effective amount paid after any coupon, SGD
      couponDiscount: boolean;
    }
  // The subscriber switched to a different plan. The translator only carries
  // the NEW plan — the lifecycle resolves the old one from the sheet.
  | {
      kind: "PLAN_CHANGED";
      stripeSubscriptionId: string;
      newPlanType: string;
      newSubscriptionPrice: number; // effective price after any coupon
      newCouponDiscount: boolean;
    }
  // A coupon was applied to or removed from an existing subscription by Joseph.
  // No plan change occurred — just the discount changed.
  | {
      kind: "COUPON_CHANGED";
      stripeSubscriptionId: string;
      newSubscriptionPrice: number; // effective price after applying/removing the coupon
      couponDiscount: boolean;
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
  // The subscriber undid a scheduled cancellation. Access continues uninterrupted.
  | {
      kind: "CANCELLATION_UNDONE";
      stripeSubscriptionId: string;
    }
  // Stripe sent a second update with the reason/comment the subscriber selected.
  | {
      kind: "CANCELLATION_REASON_RECEIVED";
      stripeSubscriptionId: string;
      cancellationFeedback: string | null;
      cancellationComment: string | null;
    }
  // A downgrade was scheduled via the customer portal. The current plan doesn't
  // change yet — it takes effect at period end when the schedule phase executes.
  | {
      kind: "DOWNGRADE_SCHEDULED";
      stripeSubscriptionId: string;
      currentPlanType: string;
      pendingPlanType: string;
      periodEnd: number; // Unix timestamp — when the downgrade executes
    }
  // The subscriber cancelled a previously scheduled downgrade. The subscription
  // schedule was released; the current plan stays in effect.
  | {
      kind: "DOWNGRADE_UNDONE";
      stripeSubscriptionId: string;
      currentPlanType: string;  // plan they're keeping
      pendingPlanType: string;  // plan they were going to be moved to (now cancelled)
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
      return translateSubscriptionUpdated(event, stripe);
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
  // so we fetch the subscription from Stripe. Expand discounts so we can
  // compute the effective price when a coupon was used at checkout.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["discounts", "discounts.promotion_code"],
  });
  const price = subscription.items.data[0]?.price;
  if (!price?.id) throw new Error(`No price ID on subscription ${subscriptionId}`);
  const currentPlan = getPlanType(price.id);  // e.g. "US" or "ALL_MARKETS"
  const subscriptionPrice = effectivePrice(price.unit_amount ?? 0, subscription.discounts);
  const couponDiscount = subscription.discounts.length > 0;
  const firstDiscount = subscription.discounts[0];
  const couponCode: string | null = (() => {
    if (!firstDiscount || typeof firstDiscount === "string") return null;
    const promo = firstDiscount.promotion_code;
    if (promo && typeof promo !== "string") return promo.code;
    return firstDiscount.coupon?.name ?? firstDiscount.coupon?.id ?? null;
  })();

  // Email and name: Stripe puts them in different places depending on the
  // checkout flow. Fall through the most-reliable sources.
  const email =
    session.customer_email || session.customer_details?.email || "";
  const name = session.customer_details?.name || email || "Unknown";

  // Custom fields collected during checkout (TradingView + Telegram usernames).
  const { tvUsername, tgUsername } = parseCustomFields(session);

  // Partner attribution. The website appends ?client_reference_id=<ref> to the
  // payment-link URL when the visitor originally landed with ?ref=<partner>.
  // Stamp it onto the subscription's metadata too, so the attribution survives
  // outside the sheet and every later object (renewal invoices, portal events)
  // can be traced back to the partner straight from Stripe. Best-effort: a
  // failed metadata write must never fail the webhook (Stripe would redeliver
  // and re-run side effects).
  const referralSource = session.client_reference_id?.trim() || null;
  if (referralSource && subscription.metadata?.ref !== referralSource) {
    try {
      await stripe.subscriptions.update(subscriptionId, {
        metadata: { ...subscription.metadata, ref: referralSource },
      });
    } catch (err) {
      console.warn(
        `Could not stamp metadata.ref="${referralSource}" on ${subscriptionId}: ${err}`
      );
    }
  }

  // Period dates. current_period_end lives on the subscription item in the
  // basil API; we fall back to calculating it from the price's recurring
  // interval if the item value is somehow missing.
  const periodStart = new Date(subscription.start_date * 1000);
  const periodEndSeconds =
    subscriptionPeriodEnd(subscription) || calculatePeriodEnd(subscription);
  const periodEnd = periodEndSeconds
    ? new Date(periodEndSeconds * 1000)
    : periodStart;

  return [
    {
      kind: "STARTED",
      email,
      name,
      currentPlan,
      subscriptionPrice,
      couponDiscount,
      couponCode,
      tradingViewUsername: tvUsername,
      telegramUsername: tgUsername,
      stripeSubscriptionId: subscriptionId,
      periodStart,
      periodEnd,
      referralSource,
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

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return [];

  // Stripe API 2025-08-27 moved per-cycle period dates from invoice top-level
  // (which now spans all line items) to the line item itself. Prefer the line
  // item's period; fall back to invoice top-level for older API versions.
  const { start, end } = invoicePeriod(invoice);

  // Which plan did this invoice charge for? On basil the line's price ID lives
  // at pricing.price_details.price; older API shapes had an expanded price
  // object. An unknown/missing price becomes null rather than an error — a
  // renewal must still be recorded even if the price ID isn't in plans.ts.
  const line = invoice.lines?.data?.[0];
  const linePriceId =
    line?.pricing?.price_details?.price ??
    (line as unknown as { price?: { id?: string } } | undefined)?.price?.id ??
    null;
  let planType: string | null = null;
  if (linePriceId) {
    try {
      planType = getPlanType(linePriceId);
    } catch {
      planType = null;
    }
  }

  return [
    {
      kind: "RENEWED",
      stripeSubscriptionId: subscriptionId,
      periodStart: new Date(start * 1000),
      periodEnd: new Date(end * 1000),
      planType,
      // invoice.total is the post-discount amount in cents.
      subscriptionPrice: (invoice.total ?? 0) / 100,
      couponDiscount: (invoice.total_discount_amounts ?? []).some(
        (d) => d.amount > 0
      ),
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
  const subscriptionId = invoiceSubscriptionId(invoice);
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
// customer.subscription.updated → 0..N actions
// =============================================================================
// This is the busiest event. One update can describe multiple changes at once:
//   - a plan switch (immediate)
//   - a downgrade scheduled (via Stripe subscription schedule)
//   - the customer scheduling a cancellation
// We emit a separate action for each. The lifecycle will apply them in order.
async function translateSubscriptionUpdated(
  event: Stripe.Event,
  stripe: Stripe
): Promise<SubscriberAction[]> {
  const subscription = event.data.object as Stripe.Subscription;
  // `previous_attributes` tells us what changed. If a field is in here, it
  // means it had a different value before this update.
  // Two casts: one to Stripe types (for typed field access), one to a plain
  // record (for arbitrary key presence checks like `'schedule' in prevAttr`).
  const previous = (event.data.previous_attributes ||
    {}) as Partial<Stripe.Subscription>;
  const prevAttr = (event.data.previous_attributes ?? {}) as Record<string, unknown>;

  const actions: SubscriberAction[] = [];

  // ---- Plan change: the `items` array changed. ----------------------------
  if (previous.items) {
    const newPrice = subscription.items.data[0]?.price;
    if (newPrice?.id) {
      // Fetch with expanded discounts to get the accurate effective price.
      const subWithDiscounts = await stripe.subscriptions.retrieve(subscription.id, {
        expand: ["discounts"],
      });
      actions.push({
        kind: "PLAN_CHANGED",
        stripeSubscriptionId: subscription.id,
        newPlanType: getPlanType(newPrice.id),
        newSubscriptionPrice: effectivePrice(newPrice.unit_amount ?? 0, subWithDiscounts.discounts),
        newCouponDiscount: subWithDiscounts.discounts.length > 0,
      });
    }
  }

  // ---- Coupon applied or removed (discount-only update) -------------------
  // Fires when Joseph manually applies the Pepperstone discount (or removes it)
  // on an existing subscription. Items don't change — only `discounts` does.
  if ("discounts" in prevAttr && !previous.items) {
    const subWithDiscounts = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ["discounts"],
    });
    const hasCoupon = subWithDiscounts.discounts.length > 0;
    const newPrice = subWithDiscounts.items.data[0]?.price;
    actions.push({
      kind: "COUPON_CHANGED",
      stripeSubscriptionId: subscription.id,
      newSubscriptionPrice: effectivePrice(newPrice?.unit_amount ?? 0, subWithDiscounts.discounts),
      couponDiscount: hasCoupon,
    });
  }

  // ---- Downgrade scheduled (subscription schedule attached) ---------------
  // When the customer portal queues a downgrade, Stripe attaches a subscription
  // schedule instead of changing the items immediately. The schedule's next phase
  // holds the pending (lower) plan. Items only change when the phase executes at
  // period end — that fires another customer.subscription.updated, which the
  // existing `previous.items` check above handles as a normal PLAN_CHANGED.
  //
  // Detection: `schedule` in previous_attributes was null, now it has an ID.
  // Guard: only emit if items didn't change simultaneously (they can't in the
  // customer portal flow, but be defensive).
  const prevScheduleWasNull =
    "schedule" in prevAttr && prevAttr["schedule"] === null;
  const newScheduleId = prevScheduleWasNull
    ? idFrom(subscription.schedule as string | { id: string } | null)
    : null;

  if (newScheduleId && !previous.items) {
    try {
      const schedule = await stripe.subscriptionSchedules.retrieve(newScheduleId);
      const nextPhase = schedule.phases[1];
      const pendingPriceRef = nextPhase?.items[0]?.price;
      const pendingPriceId =
        typeof pendingPriceRef === "string"
          ? pendingPriceRef
          : (pendingPriceRef as { id?: string } | undefined)?.id;

      if (pendingPriceId) {
        const currentPriceId = subscription.items.data[0]?.price?.id;
        // phases[0].end_date is when the current (pre-downgrade) phase ends —
        // the most authoritative "when the downgrade executes" value. Fall back
        // to the subscription item's current_period_end if the schedule phase
        // date is absent.
        const phaseEndDate = schedule.phases[0]?.end_date;
        const periodEnd =
          typeof phaseEndDate === "number" && phaseEndDate > 0
            ? phaseEndDate
            : subscriptionPeriodEnd(subscription) || 0;
        actions.push({
          kind: "DOWNGRADE_SCHEDULED",
          stripeSubscriptionId: subscription.id,
          currentPlanType: currentPriceId ? getPlanType(currentPriceId) : "UNKNOWN",
          pendingPlanType: getPlanType(pendingPriceId),
          periodEnd,
        });
      }
    } catch (err) {
      // Schedule fetch failed or price ID unrecognised — skip quietly.
      console.warn(
        `Could not resolve pending plan for schedule ${newScheduleId}: ${err}`
      );
    }
  }

  // ---- Downgrade cancelled (subscription schedule detached) ---------------
  // When the subscriber cancels a queued downgrade in the portal, Stripe releases
  // the schedule — `schedule` goes from an ID back to null. Items do NOT change
  // at this point (the plan was never swapped), so we guard on !previous.items to
  // avoid misfiring when the downgrade actually executes (which also clears the
  // schedule but does change items).
  const prevScheduleWasSet =
    "schedule" in prevAttr && prevAttr["schedule"] !== null;
  const scheduleNowNull = subscription.schedule === null;

  if (prevScheduleWasSet && scheduleNowNull && !previous.items) {
    // Two cases produce this pattern:
    //   A) Subscriber manually cancels a pending downgrade → subscription items unchanged
    //   B) Downgrade schedule ran to completion → items already swapped by a prior event
    //
    // Stripe's schedule status is "released" in BOTH cases (end_behavior: "release"
    // means the schedule is released when the final phase executes, not "completed"),
    // so status alone can't distinguish them.
    //
    // Reliable discriminator: compare the subscription's current price ID against the
    // schedule's target (phase 1) price ID. If they match, the downgrade already
    // executed — PLAN_CHANGED handled it, nothing to do here. If they don't match,
    // the subscriber cancelled the pending downgrade — emit DOWNGRADE_UNDONE.
    const oldScheduleId = prevAttr["schedule"] as string;
    try {
      const oldSchedule = await stripe.subscriptionSchedules.retrieve(oldScheduleId);
      const currentPriceRef = oldSchedule.phases[0]?.items[0]?.price;
      const pendingPriceRef = oldSchedule.phases[1]?.items[0]?.price;
      const currentPriceId = typeof currentPriceRef === "string" ? currentPriceRef : (currentPriceRef as { id?: string } | undefined)?.id;
      const pendingPriceId = typeof pendingPriceRef === "string" ? pendingPriceRef : (pendingPriceRef as { id?: string } | undefined)?.id;

      const currentSubPriceId = subscription.items.data[0]?.price?.id;
      if (pendingPriceId && currentSubPriceId === pendingPriceId) {
        // Subscription is already on the target plan — downgrade executed, skip.
      } else {
        actions.push({
          kind: "DOWNGRADE_UNDONE",
          stripeSubscriptionId: subscription.id,
          currentPlanType: currentPriceId ? getPlanType(currentPriceId) : (currentSubPriceId ? getPlanType(currentSubPriceId) : "UNKNOWN"),
          pendingPlanType: pendingPriceId ? getPlanType(pendingPriceId) : "UNKNOWN",
        });
      }
    } catch (err) {
      console.warn(`Could not fetch old schedule ${oldScheduleId} to classify release: ${err}`);
      // Err on the side of silence — a false DOWNGRADE_UNDONE is more disruptive
      // than missing one.
    }
  }

  // ---- Cancellation scheduled / undone ------------------------------------
  // Stripe uses one of two mechanisms depending on portal configuration:
  //   1. cancel_at changes from null to a timestamp (current portal behavior)
  //   2. cancel_at_period_end flips to true (older behavior)
  // We detect both for scheduling, and the reverse for undoing.
  const cancelViaAt =
    "cancel_at" in prevAttr && prevAttr["cancel_at"] === null && !!subscription.cancel_at;
  const cancelViaPeriodEnd =
    "cancel_at_period_end" in prevAttr && subscription.cancel_at_period_end === true;
  const undoViaAt =
    "cancel_at" in prevAttr && prevAttr["cancel_at"] !== null && subscription.cancel_at === null;
  const undoViaPeriodEnd =
    "cancel_at_period_end" in prevAttr && subscription.cancel_at_period_end === false;

  if (cancelViaAt || cancelViaPeriodEnd) {
    const accessEndSeconds =
      subscription.cancel_at ||
      subscriptionPeriodEnd(subscription) ||
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
  } else if (undoViaAt || undoViaPeriodEnd) {
    actions.push({
      kind: "CANCELLATION_UNDONE",
      stripeSubscriptionId: subscription.id,
    });
  }

  // ---- Cancellation reason received (second event after scheduling) -------
  // When a subscriber picks a cancellation reason in the portal, Stripe fires a
  // second customer.subscription.updated with only cancellation_details changed.
  // The subscription is already marked for cancellation (cancel_at is set or
  // cancel_at_period_end is true), so none of the cancellation-scheduled guards
  // above will fire — this block catches the reason update separately.
  if (
    "cancellation_details" in prevAttr &&
    (subscription.cancel_at || subscription.cancel_at_period_end) &&
    !cancelViaAt && !cancelViaPeriodEnd && !undoViaAt && !undoViaPeriodEnd
  ) {
    actions.push({
      kind: "CANCELLATION_REASON_RECEIVED",
      stripeSubscriptionId: subscription.id,
      cancellationFeedback: subscription.cancellation_details?.feedback ?? null,
      cancellationComment: subscription.cancellation_details?.comment ?? null,
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
 * Returns the effective quarterly price after applying a Stripe discount.
 * Accepts the `discounts` array from the basil API (each element may be an
 * unexpanded ID string or a full Stripe.Discount object). If the first
 * discount is not expanded, falls back to the list price.
 *
 * Stripe coupons are either percentage-off (`percent_off`) or fixed-amount-off
 * (`amount_off`, in the smallest currency unit — cents — same as unit_amount),
 * never both. The Pepperstone codes (NAV21 / NAV30) are amount_off, so both
 * branches must be handled or the discounted price won't be recorded.
 */
function effectivePrice(
  unitAmountCents: number,
  discounts: Array<string | Stripe.Discount> | null | undefined
): number {
  const first = discounts?.[0];
  if (!first || typeof first === "string") return unitAmountCents / 100; // not expanded
  const coupon = first.coupon;

  if (coupon?.percent_off) {
    return Math.round(unitAmountCents * (1 - coupon.percent_off / 100)) / 100;
  }
  if (coupon?.amount_off) {
    // amount_off is in cents, same unit as unit_amount. Never go below zero.
    return Math.max(0, unitAmountCents - coupon.amount_off) / 100;
  }
  return unitAmountCents / 100;
}

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
 * Get the subscription ID from an invoice. On the basil API the ID lives at
 * `invoice.parent.subscription_details.subscription` (top-level `subscription`
 * was removed). Returning null is fine — callers early-out.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return idFrom(invoice.parent?.subscription_details?.subscription ?? null);
}

/**
 * On the basil API, `current_period_end` (and `current_period_start`) moved
 * off the subscription top level onto the individual subscription items. For
 * single-item subscriptions (everything we sell), the first item's value is
 * the canonical answer.
 */
function subscriptionPeriodEnd(subscription: Stripe.Subscription): number | null {
  return subscription.items?.data?.[0]?.current_period_end ?? null;
}

/**
 * Get the billing period start/end for an invoice.
 *
 * From API 2025-08-27, invoice-level `period_start` / `period_end` cover the
 * full range across all line items (which for a renewal can stretch back to
 * the original subscription start). The current cycle lives on the line item.
 * Prefer the line item's period; fall back to invoice top-level for older
 * API versions.
 */
function invoicePeriod(invoice: Stripe.Invoice): { start: number; end: number } {
  const linePeriod = invoice.lines?.data?.[0]?.period;
  if (linePeriod?.start && linePeriod?.end) {
    return { start: linePeriod.start, end: linePeriod.end };
  }
  return { start: invoice.period_start, end: invoice.period_end };
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
