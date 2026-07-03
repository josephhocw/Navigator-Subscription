// =============================================================================
// SUBSCRIPTION LIFECYCLE
// =============================================================================
// This is the heart of the subscription system. Every rule about what happens
// to a subscriber — when they sign up, when they renew, when they cancel —
// lives in this file.
//
// How to read this file:
//   - Skip to the `apply()` method. It dispatches to a handler per action kind.
//   - Each handler is one section below. They read top-to-bottom.
//
// What this file does NOT do:
//   - It does not know anything about Stripe. It only knows about
//     SubscriberAction values (plain JS objects from the translator).
//   - It does not talk to the sheet directly — that goes through `store`.
//   - It does not send emails or Telegram messages directly — that goes
//     through `mailer` and `notifier`.
//
// Why is everything passed in via the constructor?
//   So tests can swap in fakes. A test creates a lifecycle with an in-memory
//   store, a recording mailer, and a recording notifier, calls `apply()` with
//   a hand-crafted action, and checks what happened.
// =============================================================================

import type { SubscriberAction } from "./stripe-translator.js";
import type {
  Subscriber,
  SubscriberStore,
  SubscriberPatch,
} from "./subscriber-store.js";
import {
  type OnboardingEmailData,
  type PaymentFailedEmailData,
  type CancellationEmailData,
  type PlanChangeEmailData,
  type DowngradeScheduledEmailData,
  type CancellationUndoneEmailData,
  type DowngradeUndoneEmailData,
  type SubscriptionEndedEmailData,
} from "./email.js";
import { getPlanDisplayName, classifyPlanChange } from "./plans.js";
import { formatDisplayDateSGT } from "./format-date.js";

// -----------------------------------------------------------------------------
// Collaborator interfaces.
//
// The lifecycle takes these three things as constructor arguments. In
// production they're satisfied by real Resend / Telegram calls. In tests they
// can be satisfied by simple object literals that record calls.
// -----------------------------------------------------------------------------

/** Sends customer-facing emails. */
export interface Mailer {
  sendOnboarding(data: OnboardingEmailData): Promise<void>;
  sendPaymentFailed(data: PaymentFailedEmailData): Promise<void>;
  sendCancellationConfirmation(data: CancellationEmailData): Promise<void>;
  sendCancellationUndone(data: CancellationUndoneEmailData): Promise<void>;
  sendSubscriptionEnded(data: SubscriptionEndedEmailData): Promise<void>;
  sendPlanChange(data: PlanChangeEmailData): Promise<void>;
  sendDowngradeScheduled(data: DowngradeScheduledEmailData): Promise<void>;
  sendDowngradeUndone(data: DowngradeUndoneEmailData): Promise<void>;
}

/** Pings Joseph on Telegram (HTML-formatted messages). */
export interface AdminNotifier {
  notify(message: string): Promise<void>;
}

// =============================================================================
// The lifecycle class itself.
// =============================================================================
export class SubscriptionLifecycle {
  constructor(
    private readonly store: SubscriberStore,   // reads/writes the sheet
    private readonly mailer: Mailer,           // sends customer emails
    private readonly notifier: AdminNotifier   // pings Joseph on Telegram
  ) {}

  /**
   * The single entry point. Hand it a SubscriberAction and it runs the
   * matching rule.
   *
   * Anywhere in the codebase that needs to trigger subscriber-side effects
   * should go through here.
   */
  async apply(action: SubscriberAction): Promise<void> {
    switch (action.kind) {
      case "STARTED":
        return this.handleStarted(action);
      case "RENEWED":
        return this.handleRenewed(action);
      case "PLAN_CHANGED":
        return this.handlePlanChanged(action);
      case "CANCELLATION_SCHEDULED":
        return this.handleCancellationScheduled(action);
      case "CANCELLATION_UNDONE":
        return this.handleCancellationUndone(action);
      case "CANCELLATION_REASON_RECEIVED":
        return this.handleCancellationReasonReceived(action);
      case "ENDED":
        return this.handleEnded(action);
      case "PAYMENT_FAILED":
        return this.handlePaymentFailed(action);
      case "DOWNGRADE_SCHEDULED":
        return this.handleDowngradeScheduled(action);
      case "DOWNGRADE_UNDONE":
        return this.handleDowngradeUndone(action);
      case "COUPON_CHANGED":
        return this.handleCouponChanged(action);
    }
  }

  // ===========================================================================
  // STARTED — a checkout just completed.
  //
  // Could be a brand-new subscriber, or someone who's subscribed before
  // (e.g. cancelled and came back). We decide which by checking their email.
  // ===========================================================================
  private async handleStarted(
    action: Extract<SubscriberAction, { kind: "STARTED" }>
  ): Promise<void> {
    // Duplicate-delivery guard. Stripe retries events (timeouts, 5xx, dropped
    // connections), and without this a retry would find the row we just wrote
    // by email and take the REACTIVATION path — bumping the count to 2 and
    // sending a second onboarding email to a brand-new subscriber. A real
    // reactivation always arrives with a brand-new subscription ID, so it
    // passes this guard untouched.
    const alreadyRecorded = await this.store.findBySubscriptionId(
      action.stripeSubscriptionId
    );
    if (alreadyRecorded) {
      console.log(
        `STARTED ${action.email}: subscription ${action.stripeSubscriptionId} already in sheet — duplicate delivery, skipping`
      );
      return;
    }

    // Email is the only safe deduplication key — it's verified by Stripe.
    // Usernames are user-typed and could collide with a different person.
    const existing = action.email
      ? await this.store.findByEmail(action.email)
      : null;
    const isReactivation = !!existing;

    // If email lookup missed, check usernames — but don't auto-merge.
    // A username collision with a different person would silently corrupt data,
    // so we treat this checkout as new and flag it for Joseph to review.
    let possibleReturning: Subscriber | null = null;
    if (!existing) {
      if (action.tradingViewUsername) {
        possibleReturning = await this.store.findByTradingViewUsername(action.tradingViewUsername);
      }
      if (!possibleReturning && action.telegramUsername) {
        possibleReturning = await this.store.findByTelegramUsername(action.telegramUsername);
      }
    }

    const planName = getPlanDisplayName(action.currentPlan);
    const expiryDisplay = formatDisplayDateSGT(action.periodEnd);

    if (existing) {
      // -------- Reactivation path: update the existing row. ----------------
      // If they switched plan compared to last time, preserve the old plan.
      const previousPlan =
        existing.currentPlan && existing.currentPlan !== action.currentPlan
          ? existing.currentPlan
          : existing.previousPlan;

      const patch: SubscriberPatch = {
        customerName: action.name,
        tradingViewUsername: action.tradingViewUsername,
        telegramUsername: action.telegramUsername,
        currentPlan: action.currentPlan,
        subscriptionPrice: action.subscriptionPrice,
        couponDiscount: action.couponDiscount,
        previousPlan,
        subscriptionStart: action.periodStart,
        subscriptionExpiry: action.periodEnd,
        status: "ACTIVE",
        latestAction: "REACTIVATED",
        subscriptionCount: existing.subscriptionCount + 1,
        failedPaymentCount: 0,
        stripeSubscriptionId: action.stripeSubscriptionId,
      };
      await this.store.applyUpdate(existing, patch);
    } else {
      // -------- New-subscriber path: append a fresh row. -------------------
      await this.store.appendNew({
        email: action.email,
        customerName: action.name,
        tradingViewUsername: action.tradingViewUsername,
        telegramUsername: action.telegramUsername,
        currentPlan: action.currentPlan,
        subscriptionPrice: action.subscriptionPrice,
        couponDiscount: action.couponDiscount,
        periodStart: action.periodStart,
        periodEnd: action.periodEnd,
        stripeSubscriptionId: action.stripeSubscriptionId,
      });
    }

    // Build the admin Telegram ping.
    let adminMessage: string;
    if (isReactivation) {
      adminMessage = [
        `<b>🥳 Returning Subscriber</b>`,
        ``,
        `<b>Name:</b> ${action.name}`,
        `<b>Email:</b> ${action.email}`,
        `<b>Plan:</b> ${planName} (${action.currentPlan})`,
        `<b>TradingView:</b> ${action.tradingViewUsername || "(not provided)"}`,
        `<b>Telegram:</b> ${action.telegramUsername ? `@${action.telegramUsername}` : "(not provided)"}`,
        `<b>Expires:</b> ${expiryDisplay}`,
        action.couponCode ? `<b>Promo code used:</b> ${action.couponCode}` : null,
      ].filter(Boolean).join("\n");
    } else if (possibleReturning) {
      // New row added, but a username matched an existing subscriber.
      // Joseph needs to decide whether to merge rows or leave as-is.
      adminMessage = [
        `<b>🎉 New Navigator Subscriber!</b>`,
        ``,
        `<b>Name:</b> ${action.name}`,
        `<b>Plan:</b> ${planName}`,
        `<b>TradingView Username:</b> ${action.tradingViewUsername || "(not provided)"}`,
        `<b>Telegram Username:</b> ${action.telegramUsername ? `@${action.telegramUsername}` : "(not provided)"}`,
        action.couponCode ? `<b>Promo code used:</b> ${action.couponCode}` : null,
        ``,
        `⚠️ <b>Username matches existing subscriber</b> (${possibleReturning.email}) — may be a returning subscriber who used a different email. Check the sheet and merge rows manually if needed.`,
        ``,
        `<a href="https://docs.google.com/spreadsheets/d/1ycnYJxGUAVBGo7eAUqbRycSyD2ONnA2nslnufMJdeog/edit?gid=0#gid=0">View in Spreadsheet</a>`,
      ].filter(Boolean).join("\n");
    } else {
      adminMessage = [
        `<b>🎉 New Navigator Subscriber!</b>`,
        ``,
        `<b>Name:</b> ${action.name}`,
        `<b>Plan:</b> ${planName}`,
        `<b>TradingView Username:</b> ${action.tradingViewUsername || "(not provided)"}`,
        `<b>Telegram Username:</b> ${action.telegramUsername ? `@${action.telegramUsername}` : "(not provided)"}`,
        action.couponCode ? `<b>Promo code used:</b> ${action.couponCode}` : null,
        ``,
        `<a href="https://docs.google.com/spreadsheets/d/1ycnYJxGUAVBGo7eAUqbRycSyD2ONnA2nslnufMJdeog/edit?gid=0#gid=0">View in Spreadsheet</a>`,
      ].filter(Boolean).join("\n");
    }

    // Side effects: welcome email + admin ping. Run them in parallel so a
    // slow Resend response doesn't delay the Telegram ping (or vice versa).
    await this.runSideEffects("STARTED", [
      this.mailer.sendOnboarding({
        email: action.email,
        name: action.name,
        planType: action.currentPlan,
        tvUsername: action.tradingViewUsername,
        telegramUsername: action.telegramUsername,
        billingEndDate: expiryDisplay,
      }),
      this.notifier.notify(adminMessage),
    ]);

    console.log(
      `STARTED ${action.email} (${action.currentPlan}) — ${
        isReactivation ? "reactivation" : "new"
      }`
    );
  }

  // ===========================================================================
  // RENEWED — quarterly billing cycle was paid.
  // Refresh the dates, bump the subscription count, clear failed-payment count.
  // ===========================================================================
  private async handleRenewed(
    action: Extract<SubscriberAction, { kind: "RENEWED" }>
  ): Promise<void> {
    // Find the subscriber in the sheet. If they're not there, something is
    // off — log it as an admin alert and skip.
    const existing = await this.requireSubscriber(action.stripeSubscriptionId, "Renewal");
    if (!existing) return;

    const newCount = existing.subscriptionCount + 1;
    const formattedExpiry = formatDisplayDateSGT(action.periodEnd);

    // Duplicate-delivery guard. If the sheet already shows this invoice's
    // period end, this renewal was applied on an earlier delivery — skip so
    // the count doesn't double and no email/ping repeats.
    if (existing.subscriptionExpiry === formattedExpiry) {
      console.log(
        `RENEWED ${existing.email}: expiry already ${formattedExpiry} — duplicate delivery, skipping`
      );
      return;
    }

    // Does the plan this invoice charged for match the sheet? A mismatch means
    // a plan change executed at the period boundary (a scheduled downgrade)
    // but the subscription.updated event hasn't been processed yet — Stripe
    // doesn't guarantee delivery order. In that case this handler applies the
    // plan change itself; when the items event arrives later,
    // handlePlanChanged's same-plan guard finds nothing left to do.
    const planChangedAtBoundary =
      action.planType !== null && action.planType !== existing.currentPlan;

    if (planChangedAtBoundary || existing.latestAction === "DOWNGRADE_EXECUTED") {
      // Either delivery order lands here:
      //   items event first → handlePlanChanged already wrote the new plan and
      //     left the DOWNGRADE_EXECUTED marker; this invoice confirms payment.
      //   invoice first     → the sheet still shows the old plan; apply the
      //     change now using the plan this invoice actually charged for.
      const oldPlan = planChangedAtBoundary
        ? existing.currentPlan
        : existing.previousPlan;
      const newPlan = planChangedAtBoundary
        ? (action.planType as string)
        : existing.currentPlan;
      let changeKind: "UPGRADED" | "DOWNGRADED" | "PLAN_SWITCH" = "DOWNGRADED";
      if (planChangedAtBoundary) {
        try {
          changeKind = classifyPlanChange(oldPlan, newPlan);
        } catch {
          changeKind = "PLAN_SWITCH"; // sheet plan unrecognised — don't fail the renewal over a label
        }
      }

      await this.store.applyUpdate(existing, {
        status: "ACTIVE",
        currentPlan: newPlan,
        previousPlan: oldPlan,
        subscriptionPrice: action.subscriptionPrice,
        couponDiscount: action.couponDiscount,
        subscriptionStart: action.periodStart,
        subscriptionExpiry: action.periodEnd,
        subscriptionCount: newCount,
        failedPaymentCount: 0,
        // The DOWNGRADE_EXECUTED marker (if any) is consumed here — the NEXT
        // renewal takes the normal path below. (Previously latestAction was
        // left as the branch trigger itself, so this confirmation email
        // re-fired every quarter.)
        latestAction: changeKind,
      });

      await this.runSideEffects("RENEWED (plan change confirmed)", [
        this.mailer.sendPlanChange({
          email: existing.email,
          name: existing.customerName,
          oldPlanType: oldPlan,
          newPlanType: newPlan,
          changeKind,
          telegramUsername: existing.telegramUsername || "",
          tvUsername: existing.tradingViewUsername || "",
          billingEndDate: formattedExpiry,
        }),
        this.notifier.notify(
          [
            `<b>${changeKind === "DOWNGRADED" ? "⬇️ Downgrade" : "🔀 Plan Change"} Confirmed (Payment Received)</b>`,
            ``,
            `<b>Name:</b> ${existing.customerName}`,
            `<b>Email:</b> ${existing.email}`,
            `<b>From:</b> ${getPlanDisplayName(oldPlan)} (${oldPlan})`,
            `<b>To:</b> ${getPlanDisplayName(newPlan)} (${newPlan})`,
            `<b>New expiry:</b> ${formattedExpiry}`,
            `<b>TradingView:</b> ${existing.tradingViewUsername || "(not in sheet)"}`,
            `<b>Telegram:</b> ${existing.telegramUsername ? `@${existing.telegramUsername}` : "(not in sheet)"}`,
            ``,
            `<b>Action Required: Change TradingView Indicator Access</b>`,
          ].join("\n")
        ),
      ]);

      console.log(
        `RENEWED (plan change confirmed) ${existing.email}: ${oldPlan} → ${newPlan} (${changeKind})`
      );
      return;
    }

    // Normal renewal — plan unchanged.
    await this.store.applyUpdate(existing, {
      status: "ACTIVE",
      subscriptionStart: action.periodStart,
      subscriptionExpiry: action.periodEnd,
      latestAction: "RENEWAL",
      subscriptionCount: newCount,
      failedPaymentCount: 0,
    });

    await this.runSideEffects("RENEWED", [
      this.notifier.notify(
        [
          `<b>🔄 Renewal Charged</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>New expiry:</b> ${formattedExpiry}`,
          `<b>Subscription #:</b> ${newCount}`,
        ].join("\n")
      ),
    ]);

    console.log(`RENEWED ${existing.email} (${existing.currentPlan})`);
  }

  // ===========================================================================
  // PLAN_CHANGED — subscriber switched plans (e.g. US → ALL_MARKETS).
  // We classify the change (upgrade / downgrade / switch) by comparing prices.
  // ===========================================================================
  private async handlePlanChanged(
    action: Extract<SubscriberAction, { kind: "PLAN_CHANGED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(action.stripeSubscriptionId, "Plan change");
    if (!existing) return;

    const oldPlanType = existing.currentPlan;
    if (oldPlanType === action.newPlanType) {
      // Same plan. Two ways to get here:
      //   - the late-arriving items event after handleRenewed already applied
      //     a period-boundary plan change (delivery-order race) — nothing to do;
      //   - a price-only migration on the same plan (e.g. a grandfathered
      //     subscriber moved to the current price ID) — sync price + coupon to
      //     the sheet and ping Joseph. No customer email either way.
      const priceDrifted =
        existing.subscriptionPrice !== action.newSubscriptionPrice ||
        existing.couponDiscount !== action.newCouponDiscount;
      if (!priceDrifted) return;

      await this.store.applyUpdate(existing, {
        subscriptionPrice: action.newSubscriptionPrice,
        couponDiscount: action.newCouponDiscount,
      });

      await this.runSideEffects("PLAN_CHANGED (price sync)", [
        this.notifier.notify(
          [
            `<b>🏷️ Price Updated (same plan)</b>`,
            ``,
            `<b>Name:</b> ${existing.customerName}`,
            `<b>Email:</b> ${existing.email}`,
            `<b>Plan:</b> ${getPlanDisplayName(oldPlanType)} (${oldPlanType})`,
            `<b>Price:</b> $${existing.subscriptionPrice} → $${action.newSubscriptionPrice} SGD/qtr`,
          ].join("\n")
        ),
      ]);

      console.log(
        `PLAN_CHANGED ${existing.email}: same plan, price ${existing.subscriptionPrice} → ${action.newSubscriptionPrice}`
      );
      return;
    }

    // Compare quarterly prices to label the change.
    const classification = classifyPlanChange(oldPlanType, action.newPlanType);

    await this.store.applyUpdate(existing, {
      currentPlan: action.newPlanType,
      subscriptionPrice: action.newSubscriptionPrice,
      couponDiscount: action.newCouponDiscount,
      previousPlan: oldPlanType,
      // Downgrades get a transient marker: handleRenewed watches for it,
      // sends the deferred confirmation email once payment lands, and flips
      // it to DOWNGRADED. Upgrades/switches record their classification
      // directly.
      latestAction:
        classification === "DOWNGRADED" ? "DOWNGRADE_EXECUTED" : classification,
    });

    if (classification === "DOWNGRADED") {
      // Downgrade executes at period end, but Stripe doesn't charge the invoice
      // until ~1 hour later. Defer the customer email and Joseph ping to
      // handleRenewed, which fires on invoice.payment_succeeded — so the
      // subscriber only hears about it once payment is confirmed.
      console.log(
        `PLAN_CHANGED ${existing.email}: ${oldPlanType} → ${action.newPlanType} (DOWNGRADED) — email deferred until payment confirmed`
      );
      return;
    }

    // Upgrades and plan switches are immediate — notify now.
    await this.runSideEffects("PLAN_CHANGED", [
      this.mailer.sendPlanChange({
        email: existing.email,
        name: existing.customerName,
        oldPlanType,
        newPlanType: action.newPlanType,
        changeKind: classification,
        telegramUsername: existing.telegramUsername || "",
        tvUsername: existing.tradingViewUsername || "",
        billingEndDate: existing.subscriptionExpiry ?? "",
      }),
      this.notifier.notify(
        [
          `<b>${classification === "UPGRADED" ? "⬆️" : "🔀"} Plan Change: ${classification}</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>From:</b> ${getPlanDisplayName(oldPlanType)} (${oldPlanType})`,
          `<b>To:</b> ${getPlanDisplayName(action.newPlanType)} (${action.newPlanType})`,
          `<b>TradingView:</b> ${existing.tradingViewUsername || "(not in sheet)"}`,
          `<b>Telegram:</b> ${existing.telegramUsername ? `@${existing.telegramUsername}` : "(not in sheet)"}`,
          ``,
          `<b>Action Required: Change TradingView Indicator Access</b>`,
        ].join("\n")
      ),
    ]);

    console.log(
      `PLAN_CHANGED ${existing.email}: ${oldPlanType} → ${action.newPlanType} (${classification})`
    );
  }

  // ===========================================================================
  // CANCELLATION_SCHEDULED — subscriber asked to cancel.
  // Access continues until accessEndDate. In Stripe the subscription is still
  // "active" — it just has cancel_at_period_end set.
  // ===========================================================================
  private async handleCancellationScheduled(
    action: Extract<SubscriberAction, { kind: "CANCELLATION_SCHEDULED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Cancellation scheduled"
    );
    if (!existing) return;

    const accessEndDisplay = formatDisplayDateSGT(action.accessEndDate);

    // Status flips to CANCELLATION_SCHEDULED so the sheet reflects the
    // subscriber's intent. It becomes CANCELLED only when ENDED fires.
    await this.store.applyUpdate(existing, {
      status: "CANCELLATION_SCHEDULED",
      latestAction: "CANCELLATION_SCHEDULED",
      subscriptionExpiry: action.accessEndDate,
    });

    // Send the cancellation-confirmation email + admin ping in parallel.
    await this.runSideEffects("CANCELLATION_SCHEDULED", [
      this.mailer.sendCancellationConfirmation({
        email: existing.email,
        name: existing.customerName,
        planType: existing.currentPlan,
        accessEndDate: accessEndDisplay,
      }),
      this.notifier.notify(
        [
          `<b>⏰ Cancellation Scheduled</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>Access until:</b> ${accessEndDisplay}`,
        ].join("\n")
      ),
    ]);

    console.log(
      `CANCELLATION_SCHEDULED ${existing.email} — access ends ${accessEndDisplay}`
    );
  }

  // ===========================================================================
  // CANCELLATION_UNDONE — subscriber reversed a scheduled cancellation.
  // Flip status back to ACTIVE. No customer email needed.
  // ===========================================================================
  private async handleCancellationUndone(
    action: Extract<SubscriberAction, { kind: "CANCELLATION_UNDONE" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Cancellation undone"
    );
    if (!existing) return;

    await this.store.applyUpdate(existing, {
      status: "ACTIVE",
      latestAction: "UNDO_CANCELLATION",
    });

    await this.runSideEffects("CANCELLATION_UNDONE", [
      this.mailer.sendCancellationUndone({
        email: existing.email,
        name: existing.customerName,
        planType: existing.currentPlan,
      }),
      this.notifier.notify(
        [
          `<b>↩️ Cancellation Undone</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>Subscription expiry:</b> ${existing.subscriptionExpiry}`,
        ].join("\n")
      ),
    ]);

    console.log(`CANCELLATION_UNDONE ${existing.email}`);
  }

  // ===========================================================================
  // CANCELLATION_REASON_RECEIVED — Stripe sent a follow-up event with the
  // reason/comment the subscriber selected after confirming their cancellation.
  // No sheet update needed — just ping Joseph with the reason.
  // ===========================================================================
  private async handleCancellationReasonReceived(
    action: Extract<SubscriberAction, { kind: "CANCELLATION_REASON_RECEIVED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Cancellation reason received"
    );
    if (!existing) return;

    await this.notifier.notify(
      `<b>💬 Cancellation Reason:</b> ${action.cancellationFeedback || "Not provided"}`
    );

    console.log(
      `CANCELLATION_REASON_RECEIVED ${existing.email}: ${action.cancellationFeedback}`
    );
  }

  // ===========================================================================
  // ENDED — subscription fully over.
  // Flip status to CANCELLED. Joseph still has to remove TradingView access
  // manually (no API for that), so we include the username in the ping.
  // ===========================================================================
  private async handleEnded(
    action: Extract<SubscriberAction, { kind: "ENDED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Subscription ended"
    );
    if (!existing) return;

    // Was the cancellation already scheduled via the portal? If so, the
    // subscriber already got a confirmation email when they cancelled — don't
    // send another one. Only email on immediate/forced cancellations.
    const wasScheduled = existing.status === "CANCELLATION_SCHEDULED";

    await this.store.applyUpdate(existing, { status: "CANCELLED" });

    const tasks: Promise<unknown>[] = [
      this.notifier.notify(
        [
          `<b>❗ Subscription Ended</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>TradingView:</b> ${existing.tradingViewUsername || "(not in sheet)"}`,
          `<b>Telegram:</b> ${existing.telegramUsername ? `@${existing.telegramUsername}` : "(not in sheet)"}`,
          ``,
          `<b>Action Required: Remove TradingView Indicator Access</b>`,
        ].join("\n")
      ),
    ];

    if (!wasScheduled) {
      tasks.push(
        this.mailer.sendSubscriptionEnded({
          email: existing.email,
          name: existing.customerName,
          planType: existing.currentPlan,
        })
      );
    }

    await this.runSideEffects("ENDED", tasks);

    console.log(`ENDED ${existing.email} (${wasScheduled ? "scheduled" : "immediate"})`);
  }

  // ===========================================================================
  // PAYMENT_FAILED — a renewal attempt failed.
  // Bump the failed counter, email the customer with instructions to update
  // their card, and ping the admin.
  // ===========================================================================
  private async handlePaymentFailed(
    action: Extract<SubscriberAction, { kind: "PAYMENT_FAILED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Payment failed"
    );
    if (!existing) return;

    const newFailedCount = existing.failedPaymentCount + 1;
    // `nextAttemptDate` may be null when Stripe has stopped retrying.
    const nextAttemptDisplay = action.nextAttemptDate
      ? formatDisplayDateSGT(action.nextAttemptDate)
      : undefined;

    await this.store.applyUpdate(existing, {
      status: "PAYMENT_FAILED",
      failedPaymentCount: newFailedCount,
    });

    await this.runSideEffects("PAYMENT_FAILED", [
      this.mailer.sendPaymentFailed({
        email: existing.email,
        name: existing.customerName,
        planType: existing.currentPlan,
        attemptCount: action.attemptCount,
        nextAttemptDate: nextAttemptDisplay,
      }),
      this.notifier.notify(
        [
          `<b>❌ Payment Failed</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>Attempt:</b> ${action.attemptCount}`,
          `<b>Next retry:</b> ${nextAttemptDisplay || "(none — final attempt)"}`,
        ].join("\n")
      ),
    ]);

    console.log(
      `PAYMENT_FAILED ${existing.email} (attempt ${action.attemptCount})`
    );
  }

  // ===========================================================================
  // DOWNGRADE_SCHEDULED — subscriber queued a downgrade via the customer portal.
  // The current plan is unchanged; it only flips at period end when the Stripe
  // subscription schedule executes. Record the intent and ping Joseph — no
  // customer email, no TradingView action needed yet.
  // ===========================================================================
  private async handleDowngradeScheduled(
    action: Extract<SubscriberAction, { kind: "DOWNGRADE_SCHEDULED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Downgrade scheduled"
    );
    if (!existing) return;

    // Guard against a missing/zero periodEnd from the webhook payload —
    // Stripe types it as number but it can be undefined in some test-mode events.
    const periodEndDate = action.periodEnd ? new Date(action.periodEnd * 1000) : null;
    const periodEndDisplay = periodEndDate
      ? formatDisplayDateSGT(periodEndDate)
      : "(date unknown)";

    await this.store.applyUpdate(existing, {
      latestAction: "DOWNGRADE_SCHEDULED",
    });

    await this.runSideEffects("DOWNGRADE_SCHEDULED", [
      this.mailer.sendDowngradeScheduled({
        email: existing.email,
        name: existing.customerName,
        currentPlanType: action.currentPlanType,
        pendingPlanType: action.pendingPlanType,
        effectiveDate: periodEndDisplay,
        telegramUsername: existing.telegramUsername || "",
        tvUsername: existing.tradingViewUsername || "",
      }),
      this.notifier.notify(
        [
          `<b>📋 Downgrade Scheduled — no action needed yet</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>From:</b> ${getPlanDisplayName(action.currentPlanType)} (${action.currentPlanType})`,
          `<b>To:</b> ${getPlanDisplayName(action.pendingPlanType)} (${action.pendingPlanType})`,
          `<b>Effective:</b> ${periodEndDisplay}`,
          ``,
          `<i>TradingView and Telegram access unchanged until then.</i>`,
        ].join("\n")
      ),
    ]);

    console.log(
      `DOWNGRADE_SCHEDULED ${existing.email}: ${action.currentPlanType} → ${action.pendingPlanType}, effective ${periodEndDisplay}`
    );
  }

  // ===========================================================================
  // DOWNGRADE_UNDONE — subscriber cancelled a previously scheduled downgrade.
  // The subscription schedule was released; the current plan is unchanged.
  // No customer email needed — just update the sheet and ping Joseph.
  // ===========================================================================
  private async handleDowngradeUndone(
    action: Extract<SubscriberAction, { kind: "DOWNGRADE_UNDONE" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(
      action.stripeSubscriptionId,
      "Downgrade undone"
    );
    if (!existing) return;

    await this.store.applyUpdate(existing, {
      latestAction: "UNDO_DOWNGRADE",
    });

    await this.runSideEffects("DOWNGRADE_UNDONE", [
      this.mailer.sendDowngradeUndone({
        email: existing.email,
        name: existing.customerName,
        planType: existing.currentPlan,
        pendingPlanType: action.pendingPlanType,
      }),
      this.notifier.notify(
        [
          `<b>↩️ Scheduled Downgrade Cancelled</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Cancelled change:</b> ${getPlanDisplayName(action.currentPlanType)} → ${getPlanDisplayName(action.pendingPlanType)}`,
          `<b>Stays on:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          ``,
          `<i>Subscriber cancelled their scheduled downgrade. No action needed.</i>`,
        ].join("\n")
      ),
    ]);

    console.log(`DOWNGRADE_UNDONE ${existing.email}`);
  }

  // ===========================================================================
  // COUPON_CHANGED — Joseph applied or removed the Pepperstone discount coupon.
  // Updates the price and checkbox in the sheet; pings Joseph to confirm.
  // No customer email — this is an internal operation.
  // ===========================================================================
  private async handleCouponChanged(
    action: Extract<SubscriberAction, { kind: "COUPON_CHANGED" }>
  ): Promise<void> {
    const existing = await this.requireSubscriber(action.stripeSubscriptionId, "Coupon changed");
    if (!existing) return;

    await this.store.applyUpdate(existing, {
      subscriptionPrice: action.newSubscriptionPrice,
      couponDiscount: action.couponDiscount,
    });

    const verb = action.couponDiscount ? "Pepperstone discount applied" : "Discount removed";
    await this.runSideEffects("COUPON_CHANGED", [
      this.notifier.notify(
        [
          `<b>🏷️ ${verb}</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>New price:</b> $${action.newSubscriptionPrice} SGD/qtr`,
        ].join("\n")
      ),
    ]);

    console.log(
      `COUPON_CHANGED ${existing.email}: discount=${action.couponDiscount}, price=${action.newSubscriptionPrice}`
    );
  }

  // ===========================================================================
  // Helper: run a handler's email/Telegram side effects without letting a
  // failure escape.
  //
  // By the time these run, the sheet write has already succeeded. If a send
  // threw here, the webhook would return 500 and Stripe would redeliver the
  // whole event — re-applying sheet writes and re-sending whatever DID go
  // out. Instead: let every send settle, log any failures, and best-effort
  // alert Joseph so a broken Resend key or Telegram outage is visible.
  // ===========================================================================
  private async runSideEffects(
    context: string,
    tasks: Promise<unknown>[]
  ): Promise<void> {
    const results = await Promise.allSettled(tasks);
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    if (failures.length === 0) return;

    console.error(`${context}: side effect failed:`, failures.join(" | "));
    try {
      await this.notifier.notify(
        [
          `<b>⚠️ ${context}: email/notification failed</b>`,
          ``,
          ...failures,
          ``,
          `<i>The sheet was already updated — only the message(s) above failed. Check Resend / Telegram.</i>`,
        ].join("\n")
      );
    } catch (notifyErr) {
      console.error(`${context}: failure alert also failed:`, notifyErr);
    }
  }

  // ===========================================================================
  // Helper used by every non-STARTED handler.
  //
  // Look up a subscriber by their Stripe subscription ID. If they're not in
  // the sheet (which would be weird — it means we missed their original
  // checkout event), notify the admin and return null so the handler can bail
  // out.
  // ===========================================================================
  private async requireSubscriber(
    subscriptionId: string,
    context: string
  ): Promise<Subscriber | null> {
    const existing = await this.store.findBySubscriptionId(subscriptionId);
    if (!existing) {
      await this.notifier.notify(
        `<b>⚠️ ${context} but no sheet row found</b>\nSub: ${subscriptionId}`
      );
      return null;
    }
    return existing;
  }
}
