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

import {
  ANNUAL_PRICING, ANNUAL_TRIAL_CHARGE_DEADLINE_MS, annualOfferOpen, isPlanType, type PlanType,
} from "./annual-pricing.js";
import {
  getPlanType, getBillingInterval, annualTargetPriceFor, isLegacyQuarterlyPrice,
  ANNUAL_COUPON_FOR_QUARTERLY, getPlanDisplayName,
} from "./plans.js";
import { verifyAnnualLink } from "./annual-link.js";
import { formatDisplayDateSGT } from "./format-date.js";
import { escapeHtml } from "./html-escape.js";

export interface SubscriptionSnapshot {
  id: string;
  customerEmail: string | null;
  status: string;
  priceId: string;
  itemId: string;
  couponIds: string[];
  cancelAtPeriodEnd: boolean;
  /** Stripe `cancel_at` (epoch seconds) — the customer portal schedules cancellations this way. */
  cancelAt: number | null;
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
  performSwitch(sub: SubscriptionSnapshot, plan: SwitchPlan, idempotencyKey: string): Promise<SwitchResult>;
}

/**
 * `verified` is the post-write check: the subscription was re-read and carries
 * the target price, the expected coupons and no scheduled cancellation.
 * `problems` lists what did not match (empty / absent when verified).
 */
export interface SwitchResult {
  periodEnd: number | null;
  verified: boolean;
  problems?: string[];
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
  // A trialist's annual is collected at trial end; past the deadline it would
  // land after 1 Nov.
  if (sub.status === "trialing" && sub.trialEnd !== null && sub.trialEnd * 1000 > ANNUAL_TRIAL_CHARGE_DEADLINE_MS) {
    return { ok: false, reason: "ineligible", detail: "trial ends after the deadline" };
  }
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
  const base = plan.grandfathered
    ? row.grandfathered
    : plan.couponIds.includes(row.couponCode)
      ? row.pepperstone
      : row.list;
  // SK50 (one subscriber's personal 50%-off-forever deal) halves whichever base
  // applies — she is on a legacy price, so grandfathered AND SK50 together.
  return plan.couponIds.includes("zqIA0zDQ") ? base / 2 : base;
}

type Resolved =
  | { refused: false; sub: SubscriptionSnapshot; plan: SwitchPlan; planType: PlanType }
  /** `sub` is set once the link checked out, so a ping can name the subscription. */
  | { refused: true; refusal: AnnualRefusal; sub?: SubscriptionSnapshot };

async function resolve(
  stripe: AnnualStripe, token: string, secret: string, nowMs: number
): Promise<Resolved> {
  const link = verifyAnnualLink(token, secret);
  if (!link) return { refused: true, refusal: { ok: false, reason: "invalid" } };
  const sub = await stripe.getSubscription(link.subscriptionId);
  if (!sub) return { refused: true, refusal: { ok: false, reason: "invalid" } };
  if ((sub.customerEmail ?? "").trim().toLowerCase() !== link.email) {
    return { refused: true, refusal: { ok: false, reason: "invalid" } };
  }
  const plan = decideSwitch(sub, nowMs);
  if ("ok" in plan) return { refused: true, refusal: plan, sub };
  const planType = getPlanType(sub.priceId) as PlanType;
  return { refused: false, sub, plan, planType };
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
  if (r.refused) return r.refusal;
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
  if (r.refused) {
    if (r.refusal.reason === "ineligible") {
      const who = r.sub
        ? `${escapeHtml(r.sub.id)}\n${escapeHtml(r.sub.customerEmail ?? "(no email)")}`
        : "(unknown subscription)";
      await notify(`<b>⚠️ Annual switch ineligible</b>\n${who}\n${escapeHtml(r.refusal.detail ?? "")}`).catch(() => {});
    }
    return r.refusal;
  }
  const { sub, plan, planType } = r;
  const due = plan.mode === "trialing" ? 0 : await stripe.previewAmountDueToday(sub, plan);
  try {
    // Per-minute key: Stripe replays a key's first result (failures included)
    // for 24h, so a constant key would lock a declined subscriber out of a
    // retry with a new card. A second charge after success is prevented by the
    // already_annual re-read, not by this key.
    const result = await stripe.performSwitch(sub, plan, `annual:${sub.id}:${Math.floor(nowMs / 60_000)}`);
    if (!result.verified) {
      // The money has moved, so never throw here: warn Joseph and carry on.
      await notify(
        `<b>⚠️ Annual switch done but post-write verification failed</b>\n` +
          `${escapeHtml(sub.id)}\n${escapeHtml(sub.customerEmail ?? "(no email)")}\n` +
          `${escapeHtml((result.problems ?? []).join("; ") || "unknown mismatch")}\n` +
          `<i>The charge went through. Check the subscription in Stripe by hand.</i>`
      ).catch(() => {});
    }
    return offerFrom(sub, plan, planType, due, result.periodEnd);
  } catch (err) {
    if (err instanceof AnnualPaymentFailed) {
      await notify(
        `<b>❌ Annual switch payment failed</b>\n${escapeHtml(sub.customerEmail ?? sub.id)}\n${escapeHtml(err.message)}\n<i>Quarterly subscription left as it was.</i>`
      ).catch(() => {});
      return { ok: false, reason: "payment_failed", detail: err.message };
    }
    throw err;
  }
}
