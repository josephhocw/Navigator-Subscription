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
      case "ENDED":
        return this.handleEnded(action);
      case "PAYMENT_FAILED":
        return this.handlePaymentFailed(action);
      case "PAST_DUE":
        return this.handlePastDue(action);
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
    // Look up the subscriber by email. If found, this is a reactivation.
    const existing = action.email
      ? await this.store.findByEmail(action.email)
      : null;
    const isReactivation = !!existing;
    const planName = getPlanDisplayName(action.planType);
    const expiryDisplay = formatDisplayDateSGT(action.periodEnd);

    if (existing) {
      // -------- Reactivation path: update the existing row. ----------------
      // If they switched plan compared to last time, preserve the old plan.
      const previousPlanType =
        existing.planType && existing.planType !== action.planType
          ? existing.planType
          : existing.previousPlanType;

      const patch: SubscriberPatch = {
        customerName: action.name,
        tradingViewUsername: action.tradingViewUsername,
        telegramUsername: action.telegramUsername,
        planType: action.planType,
        subscriptionPrice: action.subscriptionPrice,
        previousPlanType,
        subscriptionStart: action.periodStart,
        subscriptionExpiry: action.periodEnd,
        status: "ACTIVE",
        latestAction: "REACTIVATED",
        // Each new subscription cycle increments the count.
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
        planType: action.planType,
        subscriptionPrice: action.subscriptionPrice,
        periodStart: action.periodStart,
        periodEnd: action.periodEnd,
        stripeSubscriptionId: action.stripeSubscriptionId,
      });
    }

    // Side effects: welcome email + admin ping. Run them in parallel so a
    // slow Resend response doesn't delay the Telegram ping (or vice versa).
    await Promise.all([
      this.mailer.sendOnboarding({
        email: action.email,
        name: action.name,
        planType: action.planType,
        tvUsername: action.tradingViewUsername,
        telegramUsername: action.telegramUsername,
        billingEndDate: expiryDisplay,
      }),
      isReactivation
        ? this.notifier.notify(
            [
              `<b>Returning Subscriber</b>`,
              ``,
              `<b>Name:</b> ${action.name}`,
              `<b>Email:</b> ${action.email}`,
              `<b>Plan:</b> ${planName} (${action.planType})`,
              `<b>TradingView:</b> ${action.tradingViewUsername || "(not provided)"}`,
              `<b>Telegram:</b> ${action.telegramUsername || "(not provided)"}`,
              `<b>Expires:</b> ${expiryDisplay}`,
              `<b>Stripe Sub:</b> ${action.stripeSubscriptionId}`,
            ].join("\n")
          )
        : this.notifier.notify(
            [
              `<b>🎉 New Navigator Subscriber!</b>`,
              ``,
              `<b>Name:</b> ${action.name}`,
              `<b>Plan:</b> ${planName}`,
              `<b>TradingView Username:</b> ${action.tradingViewUsername || "(not provided)"}`,
              `<b>Telegram Username:</b> ${action.telegramUsername ? `@${action.telegramUsername}` : "(not provided)"}`,
              ``,
              `<a href="https://docs.google.com/spreadsheets/d/1ycnYJxGUAVBGo7eAUqbRycSyD2ONnA2nslnufMJdeog/edit?gid=0#gid=0">View in Spreadsheet</a>`,
            ].join("\n")
          ),
    ]);

    console.log(
      `STARTED ${action.email} (${action.planType}) — ${
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
    await this.store.applyUpdate(existing, {
      subscriptionStart: action.periodStart,
      subscriptionExpiry: action.periodEnd,
      latestAction: "RENEWAL",
      subscriptionCount: newCount,
      failedPaymentCount: 0,
    });

    await this.notifier.notify(
      [
        `<b>Renewal Charged</b>`,
        ``,
        `<b>Name:</b> ${existing.customerName}`,
        `<b>Email:</b> ${existing.email}`,
        `<b>Plan:</b> ${getPlanDisplayName(existing.planType)} (${existing.planType})`,
        `<b>New expiry:</b> ${formatDisplayDateSGT(action.periodEnd)}`,
        `<b>Subscription #:</b> ${newCount}`,
      ].join("\n")
    );

    console.log(`RENEWED ${existing.email} (${existing.planType})`);
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

    const oldPlanType = existing.planType;
    // No-op guard: if the "new" plan equals the existing one, nothing changed.
    if (oldPlanType === action.newPlanType) return;

    // Compare quarterly prices to label the change.
    const classification = classifyPlanChange(oldPlanType, action.newPlanType);

    await this.store.applyUpdate(existing, {
      planType: action.newPlanType,
      subscriptionPrice: action.newSubscriptionPrice,
      previousPlanType: oldPlanType,
      latestAction: classification,
    });

    // Admin ping — Joseph needs to manually update TradingView access for
    // this subscriber, so the message includes the usernames.
    await this.notifier.notify(
      [
        `<b>Plan Change: ${classification}</b>`,
        ``,
        `<b>Name:</b> ${existing.customerName}`,
        `<b>Email:</b> ${existing.email}`,
        `<b>From:</b> ${getPlanDisplayName(oldPlanType)} (${oldPlanType})`,
        `<b>To:</b> ${getPlanDisplayName(action.newPlanType)} (${action.newPlanType})`,
        `<b>TradingView:</b> ${existing.tradingViewUsername || "(not in sheet)"}`,
        `<b>Telegram:</b> ${existing.telegramUsername || "(not in sheet)"}`,
        `<i>Update TradingView indicator access manually.</i>`,
      ].join("\n")
    );

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
      latestAction: "CANCELLED",
      subscriptionExpiry: action.accessEndDate,
    });

    // Send the cancellation-confirmation email + admin ping in parallel.
    await Promise.all([
      this.mailer.sendCancellationConfirmation({
        email: existing.email,
        name: existing.customerName,
        planType: existing.planType,
        accessEndDate: accessEndDisplay,
      }),
      this.notifier.notify(
        [
          `<b>Cancellation Scheduled</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.planType)} (${existing.planType})`,
          `<b>Access until:</b> ${accessEndDisplay}`,
          action.cancellationFeedback ? `<b>Reason:</b> ${action.cancellationFeedback}` : null,
          action.cancellationComment ? `<b>Comment:</b> ${action.cancellationComment}` : null,
        ]
          .filter(Boolean)
          .join("\n")
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

    await this.notifier.notify(
      [
        `<b>Cancellation Undone</b>`,
        ``,
        `<b>Name:</b> ${existing.customerName}`,
        `<b>Email:</b> ${existing.email}`,
        `<b>Plan:</b> ${getPlanDisplayName(existing.planType)} (${existing.planType})`,
        `<b>Subscription expiry:</b> ${existing.subscriptionExpiry}`,
      ].join("\n")
    );

    console.log(`CANCELLATION_UNDONE ${existing.email}`);
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

    await this.store.applyUpdate(existing, { status: "CANCELLED" });

    await this.notifier.notify(
      [
        `<b>Subscription Ended</b>`,
        ``,
        `<b>Name:</b> ${existing.customerName}`,
        `<b>Email:</b> ${existing.email}`,
        `<b>Plan:</b> ${getPlanDisplayName(existing.planType)} (${existing.planType})`,
        `<b>TradingView:</b> ${existing.tradingViewUsername || "(not in sheet)"}`,
        `<i>Remove TradingView indicator access manually.</i>`,
      ].join("\n")
    );

    console.log(`ENDED ${existing.email}`);
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
      failedPaymentCount: newFailedCount,
    });

    await Promise.all([
      this.mailer.sendPaymentFailed({
        email: existing.email,
        name: existing.customerName,
        planType: existing.planType,
        attemptCount: action.attemptCount,
        nextAttemptDate: nextAttemptDisplay,
      }),
      this.notifier.notify(
        [
          `<b>Payment Failed</b>`,
          ``,
          `<b>Name:</b> ${existing.customerName}`,
          `<b>Email:</b> ${existing.email}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.planType)} (${existing.planType})`,
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
  // PAST_DUE — subscription status flipped to past_due.
  // Notify-only: no sheet update. A PAYMENT_FAILED action will follow with the
  // actual detail; this is just an early heads-up to Joseph.
  // ===========================================================================
  private async handlePastDue(
    action: Extract<SubscriberAction, { kind: "PAST_DUE" }>
  ): Promise<void> {
    const existing = await this.store.findBySubscriptionId(
      action.stripeSubscriptionId
    );
    if (!existing) {
      await this.notifier.notify(
        `<b>Past-due but no sheet row found</b>\nSub: ${action.stripeSubscriptionId}`
      );
      return;
    }

    await this.notifier.notify(
      [
        `<b>Subscription Past Due</b>`,
        ``,
        `<b>Name:</b> ${existing.customerName}`,
        `<b>Email:</b> ${existing.email}`,
        `<b>Plan:</b> ${getPlanDisplayName(existing.planType)} (${existing.planType})`,
      ].join("\n")
    );

    console.log(`PAST_DUE ${existing.email}`);
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
        `<b>${context} but no sheet row found</b>\nSub: ${subscriptionId}`
      );
      return null;
    }
    return existing;
  }
}
