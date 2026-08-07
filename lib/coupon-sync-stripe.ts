// =============================================================================
// Coupon sync — the Stripe half.
//
// `coupon-sync.ts` holds the decision logic and knows nothing about Stripe.
// This file drives the API: read the subscription (and its schedule), ask the
// planner what the coupons should be, write them back, then VERIFY.
//
// The verify step is not optional. A phase write that omits `discounts` strips
// the coupon off the live subscription the moment it lands (proven in test mode,
// 2026-08-07). This module is the thing writing phases, so it is also the thing
// that must prove it didn't destroy a discount — the same stance the trial
// standardiser takes after the 2026-08-03 incident.
// =============================================================================

import type Stripe from "stripe";
import { getPlanType } from "./plans.js";
import { flagIsDryRun } from "./telegram-groups.js";
import {
  buildPhaseCouponPlan,
  couponCodeFor,
  isManagedCoupon,
  verdictForSubscription,
  type PhaseCouponState,
} from "./coupon-sync.js";

export interface CouponSyncResult {
  /** Did we actually write to Stripe? False in dry-run and when nothing changed. */
  applied: boolean;
  dryRun: boolean;
  route: "subscription" | "schedule" | "none";
  /** Plain-text summary for the console line, Status Log and ping. */
  summary: string;
  /** Things we deliberately refused to touch. */
  blockers: string[];
  /** A discount disappeared as a result of our write — always a 🚨. */
  destroyed: boolean;
}

/**
 * The seam the lifecycle depends on. Mirrors TradingViewGranter /
 * TelegramGroupRemover: injected, faked in tests, Noop when unconfigured.
 */
export interface CouponManager {
  readonly configured: boolean;
  /**
   * Bring the Pepperstone coupon in line with `newPlanType`.
   *
   * `newPlanType` is the plan the subscriber is moving TO. For a scheduled
   * downgrade the subscription itself hasn't moved yet — the schedule's phases
   * carry the target — so the planner reads the phases rather than this value.
   */
  sync(subscriptionId: string, newPlanType: string): Promise<CouponSyncResult>;
}

export class NoopCouponManager implements CouponManager {
  readonly configured = false;
  async sync(): Promise<CouponSyncResult> {
    return {
      applied: false,
      dryRun: true,
      route: "none",
      summary: "coupon sync not configured",
      blockers: [],
      destroyed: false,
    };
  }
}

/** Anything other than an explicit "false" keeps this in report-only mode. */
export function couponSyncIsDryRun(env = process.env): boolean {
  return flagIsDryRun("COUPON_SYNC_DRY_RUN", env);
}

function planFromPrice(
  // A schedule phase item can report a DeletedPrice, which carries only an id.
  price: string | Stripe.Price | Stripe.DeletedPrice | null | undefined
): string | null {
  const id = typeof price === "string" ? price : price?.id;
  if (!id) return null;
  try {
    return getPlanType(id);
  } catch {
    return null; // unrecognised price — the planner treats this as a blocker
  }
}

function couponIdsOf(
  discounts: Array<string | Stripe.Discount> | null | undefined
): string[] {
  const out: string[] = [];
  for (const d of discounts ?? []) {
    if (typeof d === "string") {
      // Unexpanded. We can't identify it, so surface it as an unmanaged coupon
      // rather than silently dropping it from a phase rewrite.
      out.push(d);
      continue;
    }
    const coupon = d.coupon;
    const id = typeof coupon === "string" ? coupon : coupon?.id;
    if (id) out.push(id);
  }
  return out;
}

function phaseCouponIdsOf(phase: Stripe.SubscriptionSchedule.Phase): string[] {
  const out: string[] = [];
  for (const d of phase.discounts ?? []) {
    const coupon = (d as { coupon?: string | Stripe.Coupon }).coupon;
    const id = typeof coupon === "string" ? coupon : coupon?.id;
    if (id) out.push(id);
  }
  return out;
}

export class StripeCouponManager implements CouponManager {
  readonly configured = true;

  constructor(
    private readonly stripe: Stripe,
    private readonly dryRun: boolean = couponSyncIsDryRun()
  ) {}

  async sync(subscriptionId: string, newPlanType: string): Promise<CouponSyncResult> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["discounts"],
    });
    const subCouponIds = couponIdsOf(sub.discounts);
    const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;

    return scheduleId
      ? this.syncSchedule(sub, scheduleId, subCouponIds)
      : this.syncSubscription(sub, newPlanType, subCouponIds);
  }

  // ---------------------------------------------------------------------------
  // No schedule attached — an immediate change (the upgrade path). One field.
  // ---------------------------------------------------------------------------
  private async syncSubscription(
    sub: Stripe.Subscription,
    newPlanType: string,
    subCouponIds: string[]
  ): Promise<CouponSyncResult> {
    const verdict = verdictForSubscription(subCouponIds, newPlanType);

    switch (verdict.kind) {
      case "no_coupon":
        return this.result("subscription", false, "no coupon attached — nothing to sync");
      case "correct":
        return this.result(
          "subscription",
          false,
          `${couponCodeFor(verdict.couponId)} already correct for ${newPlanType}`
        );
      case "unmanaged":
        return this.result(
          "subscription",
          false,
          `coupon ${verdict.couponId} is not managed — left untouched`,
          [`unmanaged coupon ${verdict.couponId}`]
        );
      case "unknown_plan":
        return this.result(
          "subscription",
          false,
          `plan "${verdict.planType}" not recognised — coupon left untouched`,
          [`unknown plan ${verdict.planType}`]
        );
      case "swap":
        break;
    }

    const line = `${couponCodeFor(verdict.from)} → ${couponCodeFor(verdict.to)} for ${newPlanType}`;
    if (this.dryRun) {
      return this.result("subscription", false, `dry run — would swap ${line}`);
    }

    await this.stripe.subscriptions.update(sub.id, {
      discounts: [{ coupon: verdict.to }],
      // Never re-invoice the current period for a coupon correction.
      proration_behavior: "none",
    });

    const destroyed = await this.discountWasDestroyed(sub.id);
    return this.result(
      "subscription",
      true,
      destroyed ? `swapped ${line} — BUT THE DISCOUNT IS NOW GONE` : `swapped ${line}`,
      [],
      destroyed
    );
  }

  // ---------------------------------------------------------------------------
  // Schedule attached — the scheduled-downgrade path.
  //
  // Every phase is resent in full, discounts included. Omitting a phase's
  // discounts wipes the coupon off the live subscription instantly, so there is
  // no such thing as a partial phase write here.
  // ---------------------------------------------------------------------------
  private async syncSchedule(
    sub: Stripe.Subscription,
    scheduleId: string,
    subCouponIds: string[]
  ): Promise<CouponSyncResult> {
    const schedule = await this.stripe.subscriptionSchedules.retrieve(scheduleId);
    const phases = schedule.phases ?? [];
    if (phases.length === 0) {
      return this.result("schedule", false, "schedule has no phases — nothing to sync");
    }

    // A portal-created schedule can report trial_end: null on the phase that IS
    // the trial, so the flag is never inferred from the phase. A currently
    // trialing subscription's first phase is its trial — the same rule
    // shiftPhaseBoundary relies on.
    const isTrialing = sub.status === "trialing";

    const states: PhaseCouponState[] = phases.map((p, i) => ({
      planType: planFromPrice(p.items?.[0]?.price),
      couponIds: phaseCouponIdsOf(p),
      isTrial: isTrialing && i === 0,
    }));

    const plan = buildPhaseCouponPlan(states, subCouponIds);

    if (!plan.changed) {
      const why = plan.blockers.length
        ? `no change — ${plan.blockers.join("; ")}`
        : "coupons already match every phase";
      return this.result("schedule", false, why, plan.blockers);
    }

    const summary = plan.notes.join("; ");
    if (this.dryRun) {
      return this.result("schedule", false, `dry run — would apply ${summary}`, plan.blockers);
    }

    await this.stripe.subscriptionSchedules.update(scheduleId, {
      phases: phases.map((p, i) => ({
        start_date: p.start_date,
        end_date: p.end_date,
        proration_behavior:
          (p.proration_behavior ??
            "none") as Stripe.SubscriptionScheduleUpdateParams.Phase.ProrationBehavior,
        items: (p.items ?? []).map((item) => ({
          price: typeof item.price === "string" ? item.price : item.price?.id,
          quantity: item.quantity ?? 1,
        })) as Stripe.SubscriptionScheduleUpdateParams.Phase.Item[],
        // ALWAYS explicit — see the phase-write trap.
        discounts: plan.phaseCouponIds[i].map((coupon) => ({ coupon })),
        // Forced, never inferred: the 2026-08-03 incident ended two live trials
        // because a rewrite described the trial phase as billable.
        ...(isTrialing && i === 0 ? { trial: true } : {}),
      })),
    });

    const destroyed = await this.discountWasDestroyed(sub.id);
    // The write must not have ended a trial either — same failure mode, same check.
    const after = await this.stripe.subscriptions.retrieve(sub.id);
    const endedTrial = isTrialing && after.status !== "trialing";

    const blockers = [...plan.blockers];
    if (endedTrial) {
      blockers.push(
        `🚨 subscription is now ${after.status} — THE TRIAL WAS ENDED; void any invoice raised and restore it`
      );
    }

    return this.result(
      "schedule",
      true,
      destroyed ? `${summary} — BUT THE DISCOUNT IS NOW GONE` : summary,
      blockers,
      destroyed || endedTrial
    );
  }

  /**
   * Post-write check: did the subscription lose its discount entirely?
   *
   * This is the specific catastrophe this module can cause, so it is verified
   * on every write rather than trusted.
   */
  private async discountWasDestroyed(subscriptionId: string): Promise<boolean> {
    try {
      const after = await this.stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["discounts"],
      });
      return couponIdsOf(after.discounts).filter(isManagedCoupon).length === 0;
    } catch {
      // Can't prove it's fine, so don't claim it is.
      return true;
    }
  }

  private result(
    route: CouponSyncResult["route"],
    applied: boolean,
    summary: string,
    blockers: string[] = [],
    destroyed = false
  ): CouponSyncResult {
    return { applied, dryRun: this.dryRun, route, summary, blockers, destroyed };
  }
}
