// lib/annual-switch-stripe.ts
import type Stripe from "stripe";
import { effectivePrice } from "./stripe-translator.js";
import { AnnualPaymentFailed, type AnnualStripe, type SubscriptionSnapshot, type SwitchPlan } from "./annual-switch.js";

const couponIdsOf = (sub: Stripe.Subscription): string[] =>
  (sub.discounts ?? [])
    .map((d) => {
      if (typeof d === "string") return null;
      const c = (d as Stripe.Discount).coupon;
      return typeof c === "string" ? c : c?.id ?? null;
    })
    .filter((c): c is string => !!c);

export class StripeAnnualClient implements AnnualStripe {
  constructor(private readonly stripe: Stripe) {}

  async getSubscription(id: string): Promise<SubscriptionSnapshot | null> {
    let sub: Stripe.Subscription;
    try {
      sub = await this.stripe.subscriptions.retrieve(id, {
        expand: ["discounts", "customer", "items.data.price"],
      });
    } catch (err) {
      if ((err as { code?: string }).code === "resource_missing") return null;
      throw err;
    }
    const item = sub.items.data[0];
    if (!item?.price?.id) return null;
    const customer = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
    const customerEmail =
      typeof customer === "object" && !("deleted" in customer && customer.deleted)
        ? (customer as Stripe.Customer).email ?? null
        : null;
    return {
      id: sub.id,
      customerEmail,
      status: sub.status,
      priceId: item.price.id,
      itemId: item.id,
      couponIds: couponIdsOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      scheduleId: typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null,
      trialEnd: sub.trial_end ?? null,
      currentPeriodEnd: item.current_period_end ?? null,
      currentEffectivePrice: effectivePrice(item.price.unit_amount ?? 0, sub.discounts),
    };
  }

  async previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan): Promise<number> {
    const preview = await this.stripe.invoices.createPreview({
      subscription: sub.id,
      subscription_details: {
        items: [{ id: sub.itemId, price: plan.targetPriceId }],
        proration_behavior: "always_invoice",
        billing_cycle_anchor: "now",
      },
      // Discounts for the preview: the ANNUAL coupon, not the quarterly one the
      // subscription still carries. [] means "no discount" (grandfathered).
      discounts: plan.couponIds.map((coupon) => ({ coupon })),
    });
    return (preview.amount_due ?? preview.total ?? 0) / 100;
  }

  async performSwitch(
    sub: SubscriptionSnapshot, plan: SwitchPlan, idempotencyKey: string
  ): Promise<{ periodEnd: number | null }> {
    const common: Stripe.SubscriptionUpdateParams = {
      items: [{ id: sub.itemId, price: plan.targetPriceId }],
      discounts: plan.couponIds.map((coupon) => ({ coupon })),
      cancel_at_period_end: false,
    };
    const params: Stripe.SubscriptionUpdateParams =
      plan.mode === "trialing"
        ? { ...common, proration_behavior: "none" }
        : {
            ...common,
            billing_cycle_anchor: "now",
            proration_behavior: "always_invoice",
            payment_behavior: "error_if_incomplete",
          };
    try {
      const updated = await this.stripe.subscriptions.update(sub.id, params, { idempotencyKey });
      return { periodEnd: updated.items.data[0]?.current_period_end ?? null };
    } catch (err) {
      const e = err as { code?: string; type?: string; message?: string; decline_code?: string };
      if (e.type === "StripeCardError" || e.code === "card_declined" || e.code === "payment_intent_authentication_failure" || e.code === "subscription_payment_intent_requires_action") {
        throw new AnnualPaymentFailed(e.decline_code ?? e.code ?? e.message ?? "payment failed");
      }
      throw err;
    }
  }
}
