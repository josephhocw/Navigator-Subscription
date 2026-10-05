// lib/annual-switch.ts
// =============================================================================
// ANNUAL SWITCH — decision logic + orchestration, Stripe behind a seam.
//
// The magic-link page calls previewAnnual (GET) and performAnnual (POST). The
// Stripe write itself (lib/annual-switch-stripe.ts) resets the billing anchor
// to NOW and invoices immediately, so the annual is PAID before 1 Nov — the
// customer portal cannot do that (it keeps the anchor, so the big charge would
// land at the old renewal date, after the deadline). Trialists only get the
// price swapped; Stripe collects the annual at trial end.
//
// Nothing here touches the sheet, sends the confirmation email or logs: the
// webhook sees the price change and runs the lifecycle's ANNUAL_SWITCH path.
// =============================================================================

import { ANNUAL_PRICING, annualOfferOpen, isPlanType, type PlanType } from "./annual-pricing.js";
import {
  getPlanType, getBillingInterval, annualTargetPriceFor, isLegacyQuarterlyPrice,
  ANNUAL_COUPON_FOR_QUARTERLY, getPlanDisplayName,
} from "./plans.js";
import { verifyAnnualLink } from "./annual-link.js";
import { formatDisplayDateSGT } from "./format-date.js";

export interface SubscriptionSnapshot {
  id: string;
  customerEmail: string | null;
  status: string;
  priceId: string;
  itemId: string;
  couponIds: string[];
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  trialEnd: number | null;
  currentPeriodEnd: number | null;
  currentEffectivePrice: number;
}

export interface SwitchPlan {
  mode: "active" | "trialing";
  targetPriceId: string;
  couponIds: string[];
  grandfathered: boolean;
}

export type SwitchRefusal = "offer_closed" | "invalid" | "already_annual" | "ineligible" | "payment_failed";
export interface AnnualRefusal { ok: false; reason: SwitchRefusal; detail?: string }
export interface AnnualOffer {
  ok: true;
  mode: "active" | "trialing";
  planType: string;
  planName: string;
  currentPrice: number;
  annualPrice: number;
  amountDueToday: number;
  newExpiry: string;
  grandfathered: boolean;
}

export interface AnnualStripe {
  getSubscription(id: string): Promise<SubscriptionSnapshot | null>;
  previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan): Promise<number>;
  performSwitch(sub: SubscriptionSnapshot, plan: SwitchPlan, idempotencyKey: string): Promise<{ periodEnd: number | null }>;
}

export class AnnualPaymentFailed extends Error {}

export function decideSwitch(sub: SubscriptionSnapshot, nowMs: number): SwitchPlan | AnnualRefusal {
  if (!annualOfferOpen(nowMs)) return { ok: false, reason: "offer_closed" };

  let planType: string;
  try {
    planType = getPlanType(sub.priceId);
  } catch {
    return { ok: false, reason: "ineligible", detail: `unknown price ${sub.priceId}` };
  }
  if (getBillingInterval(sub.priceId) === "year") return { ok: false, reason: "already_annual" };
  if (sub.status !== "active" && sub.status !== "trialing") {
    return { ok: false, reason: "ineligible", detail: `status ${sub.status}` };
  }
  if (sub.scheduleId) return { ok: false, reason: "ineligible", detail: `schedule ${sub.scheduleId} attached` };
  if (!isPlanType(planType)) return { ok: false, reason: "ineligible", detail: `plan ${planType}` };

  let targetPriceId: string;
  try {
    targetPriceId = annualTargetPriceFor(sub.priceId);
  } catch (err) {
    return { ok: false, reason: "ineligible", detail: err instanceof Error ? err.message : String(err) };
  }
  const couponIds = sub.couponIds.map((c) => ANNUAL_COUPON_FOR_QUARTERLY[c] ?? c);
  return {
    mode: sub.status === "trialing" ? "trialing" : "active",
    targetPriceId,
    couponIds,
    grandfathered: isLegacyQuarterlyPrice(sub.priceId),
  };
}

function annualPriceFor(planType: PlanType, plan: SwitchPlan): number {
  const row = ANNUAL_PRICING[planType];
  if (plan.grandfathered) return row.grandfathered;
  if (plan.couponIds.includes(row.couponCode)) return row.pepperstone;
  if (plan.couponIds.includes("zqIA0zDQ")) return row.list / 2; // SK50: 50% off forever
  return row.list;
}

async function resolve(
  stripe: AnnualStripe, token: string, secret: string, nowMs: number
): Promise<{ sub: SubscriptionSnapshot; plan: SwitchPlan; planType: PlanType } | AnnualRefusal> {
  const link = verifyAnnualLink(token, secret);
  if (!link) return { ok: false, reason: "invalid" };
  const sub = await stripe.getSubscription(link.subscriptionId);
  if (!sub) return { ok: false, reason: "invalid" };
  if ((sub.customerEmail ?? "").trim().toLowerCase() !== link.email) return { ok: false, reason: "invalid" };
  const plan = decideSwitch(sub, nowMs);
  if ("ok" in plan) return plan;
  const planType = getPlanType(sub.priceId) as PlanType;
  return { sub, plan, planType };
}

function offerFrom(
  sub: SubscriptionSnapshot, plan: SwitchPlan, planType: PlanType, amountDueToday: number, periodEnd: number | null
): AnnualOffer {
  const expiryEpoch = plan.mode === "trialing" ? sub.trialEnd : periodEnd;
  return {
    ok: true,
    mode: plan.mode,
    planType,
    planName: getPlanDisplayName(planType),
    currentPrice: sub.currentEffectivePrice,
    annualPrice: annualPriceFor(planType, plan),
    amountDueToday,
    newExpiry: expiryEpoch ? formatDisplayDateSGT(new Date(expiryEpoch * 1000)) : "",
    grandfathered: plan.grandfathered,
  };
}

export async function previewAnnual(
  stripe: AnnualStripe, token: string, secret: string, nowMs: number = Date.now()
): Promise<AnnualOffer | AnnualRefusal> {
  const r = await resolve(stripe, token, secret, nowMs);
  if ("ok" in r) return r;
  const { sub, plan, planType } = r;
  const due = plan.mode === "trialing" ? 0 : await stripe.previewAmountDueToday(sub, plan);
  // Preview: an active subscriber's new period would end one year from now.
  const projectedEnd = plan.mode === "trialing" ? sub.trialEnd : Math.floor(nowMs / 1000) + 365 * 86400;
  return offerFrom(sub, plan, planType, due, projectedEnd);
}

export async function performAnnual(
  stripe: AnnualStripe, token: string, secret: string,
  notify: (msg: string) => Promise<void>, nowMs: number = Date.now()
): Promise<AnnualOffer | AnnualRefusal> {
  const r = await resolve(stripe, token, secret, nowMs);
  if ("ok" in r) {
    if (r.reason === "ineligible") {
      await notify(`<b>⚠️ Annual switch ineligible</b>\n${token.slice(0, 12)}…\n${r.detail ?? ""}`).catch(() => {});
    }
    return r;
  }
  const { sub, plan, planType } = r;
  const due = plan.mode === "trialing" ? 0 : await stripe.previewAmountDueToday(sub, plan);
  try {
    const { periodEnd } = await stripe.performSwitch(sub, plan, `annual:${sub.id}`);
    return offerFrom(sub, plan, planType, due, periodEnd);
  } catch (err) {
    if (err instanceof AnnualPaymentFailed) {
      await notify(
        `<b>❌ Annual switch payment failed</b>\n${sub.customerEmail ?? sub.id}\n${err.message}\n<i>Quarterly subscription left as it was.</i>`
      ).catch(() => {});
      return { ok: false, reason: "payment_failed", detail: err.message };
    }
    throw err;
  }
}
