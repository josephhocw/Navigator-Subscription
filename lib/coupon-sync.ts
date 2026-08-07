// =============================================================================
// Coupon sync — keep the Pepperstone discount matched to the plan tier.
//
// The Pepperstone discount is a fixed amount per tier, not a percentage:
//   NAV21 (gcUCHGHv)  $21/qtr off  — single-market plans (SG/US/HK/FXMC)
//   NAV30 (7imb0DBR)  $30/qtr off  — combos + All Markets
//
// Nothing in Stripe links a coupon to a plan, so a move across the
// single <-> combo/all boundary leaves the wrong coupon attached. Before this
// module that was a manual step on the plan-change ping, and a missed one meant
// a subscriber over- or under-discounted forever (the coupons are
// `duration: forever`).
//
// Two moments need covering, because Stripe's portal treats the directions
// differently — `schedule_at_period_end` is configured on
// `decreasing_item_amount` only:
//
//   upgrade    (single -> combo/all)   items change immediately -> PLAN_CHANGED
//   downgrade  (combo/all -> single)   a schedule is attached   -> DOWNGRADE_SCHEDULED
//
// There is no UPGRADE_SCHEDULED event; an upgrade is never deferred.
//
// -----------------------------------------------------------------------------
// THE PHASE-WRITE TRAP (verified in test mode, 2026-08-07)
// -----------------------------------------------------------------------------
// Creating a schedule from a subscription COPIES the subscription's discounts
// into the phases — the customer portal preserves a coupon correctly, and live
// data confirms it (a 29 Jul NAV30 survived a 4 Aug portal downgrade intact).
//
// But rewriting a schedule's phases WITHOUT resending `discounts` strips the
// coupon from the LIVE SUBSCRIPTION immediately — not at the phase flip, at the
// moment of the write:
//
//   phases rewritten, discounts omitted
//     -> phase 0 discounts = (none)
//     -> phase 1 discounts = (none)
//     -> subscription discounts = (none)      <-- gone right now
//
// So any code that touches phases MUST resend every phase's discounts verbatim.
// `buildPhaseCouponPlan` below never emits a phase without an explicit coupon
// list for exactly this reason.
// =============================================================================

import { parsePlanType } from "./plans.js";

/** Coupon IDs this module is allowed to move. Anything else is left alone. */
export const NAV21_COUPON_ID = "gcUCHGHv";
export const NAV30_COUPON_ID = "7imb0DBR";

/** Short code per managed coupon, for pings and the Status Log. */
export const MANAGED_COUPON_CODES: Record<string, string> = {
  [NAV21_COUPON_ID]: "NAV21",
  [NAV30_COUPON_ID]: "NAV30",
};

export function isManagedCoupon(couponId: string | null | undefined): boolean {
  return !!couponId && couponId in MANAGED_COUPON_CODES;
}

export function couponCodeFor(couponId: string): string {
  return MANAGED_COUPON_CODES[couponId] ?? couponId;
}

/**
 * Which Pepperstone coupon belongs on this plan?
 *
 * Returns null for a plan string we don't recognise. Callers must treat null as
 * "do nothing and tell Joseph" — never as "no coupon". A typo'd plan cell must
 * not be able to strip a real discount, the same fail-safe stance the Telegram
 * remover takes on an unrecognised plan.
 */
export function desiredCouponForPlan(planType: string): string | null {
  const { category } = parsePlanType(planType);
  if (category === "single") return NAV21_COUPON_ID;
  if (category === "combo" || category === "all") return NAV30_COUPON_ID;
  return null; // "unknown"
}

// -----------------------------------------------------------------------------
// Verdict for a single subscription-level discount (the immediate-upgrade path)
// -----------------------------------------------------------------------------

export type CouponVerdict =
  /** No discount attached — this module never GRANTS one. Eligibility (new-2026
   *  prices, Pepperstone account on file) stays a human decision. */
  | { kind: "no_coupon" }
  /** A coupon we don't manage (e.g. SK50, a personal forever deal). Never touched. */
  | { kind: "unmanaged"; couponId: string }
  /** Plan string didn't parse — do nothing, ping. */
  | { kind: "unknown_plan"; planType: string }
  /** Already the right coupon for the tier. */
  | { kind: "correct"; couponId: string }
  /** Tier boundary crossed — swap. */
  | { kind: "swap"; from: string; to: string };

export function verdictForSubscription(
  couponIds: string[],
  planType: string
): CouponVerdict {
  if (couponIds.length === 0) return { kind: "no_coupon" };

  // More than one discount is not a shape this business creates. Refuse rather
  // than guess which one is the Pepperstone discount.
  const managed = couponIds.filter(isManagedCoupon);
  if (managed.length === 0) return { kind: "unmanaged", couponId: couponIds[0] };
  if (managed.length > 1 || couponIds.length > 1) {
    return { kind: "unmanaged", couponId: couponIds.join("+") };
  }

  const current = managed[0];
  const desired = desiredCouponForPlan(planType);
  if (desired === null) return { kind: "unknown_plan", planType };
  if (desired === current) return { kind: "correct", couponId: current };
  return { kind: "swap", from: current, to: desired };
}

// -----------------------------------------------------------------------------
// Phase planning (the scheduled-downgrade path)
// -----------------------------------------------------------------------------

/** One schedule phase, reduced to what coupon sync needs to reason about. */
export interface PhaseCouponState {
  /** Plan the phase charges for, resolved from its price ID. */
  planType: string | null;
  /** Coupon IDs currently on the phase. */
  couponIds: string[];
  /**
   * Is this the trial phase? A trial phase raises no invoice, so the coupon on
   * it is cosmetic and gets carried through verbatim rather than tier-matched.
   * Rewriting it would mean writing to live subscriptions whose *charging*
   * phase is already correct — churn against real money for no gain.
   */
  isTrial?: boolean;
}

export interface PhaseCouponPlan {
  /** Coupon IDs to write for each phase, in order. Always explicit — an empty
   *  array means "deliberately no discount", never "leave it alone", because
   *  Stripe has no "leave it alone" for a phase write. */
  phaseCouponIds: string[][];
  /** Human-readable per-phase notes for the ping / Status Log. */
  notes: string[];
  /** Did anything actually change? */
  changed: boolean;
  /** Something we refuse to act on — populated for unknown plans / unmanaged coupons. */
  blockers: string[];
}

/**
 * Decide the coupon for every phase of a schedule.
 *
 * Rules, per phase:
 *   - phase carries an unmanaged coupon  -> keep it verbatim, record a blocker
 *   - phase plan doesn't parse           -> keep whatever it has, record a blocker
 *   - phase carries a managed coupon     -> set the coupon matching THAT phase's tier
 *   - phase carries no coupon, but the subscription does (managed)
 *                                        -> adopt the right one for that phase
 *
 * That last rule is what stops a coupon evaporating: if anything ever writes
 * phases without discounts, the next sync puts the correct one back rather than
 * treating the empty list as intent.
 */
export function buildPhaseCouponPlan(
  phases: PhaseCouponState[],
  subscriptionCouponIds: string[]
): PhaseCouponPlan {
  const subManaged = subscriptionCouponIds.filter(isManagedCoupon);
  const carrier = subManaged.length === 1 ? subManaged[0] : null;
  const subHasUnmanaged = subscriptionCouponIds.some((c) => !isManagedCoupon(c));

  const phaseCouponIds: string[][] = [];
  const notes: string[] = [];
  const blockers: string[] = [];
  let changed = false;

  phases.forEach((phase, i) => {
    const unmanaged = phase.couponIds.filter((c) => !isManagedCoupon(c));
    const managed = phase.couponIds.filter(isManagedCoupon);

    // Anything we don't own on the phase — hands off the whole phase.
    if (unmanaged.length > 0 || subHasUnmanaged) {
      phaseCouponIds.push([...phase.couponIds]);
      blockers.push(
        `phase ${i}: unmanaged coupon ${(unmanaged[0] ?? subscriptionCouponIds.find((c) => !isManagedCoupon(c)))} — left untouched`
      );
      return;
    }

    const has = managed[0] ?? carrier ?? null;
    if (!has) {
      // No discount anywhere. Nothing to preserve, nothing to grant.
      phaseCouponIds.push([]);
      return;
    }

    // A trial phase never invoices, so its coupon has no money effect. Carry it
    // through exactly as-is (never omit — see the phase-write trap at the top).
    if (phase.isTrial) {
      phaseCouponIds.push(managed.length ? [...phase.couponIds] : [has]);
      return;
    }

    if (!phase.planType) {
      phaseCouponIds.push([...phase.couponIds]);
      blockers.push(`phase ${i}: unrecognised price — left untouched`);
      return;
    }

    const desired = desiredCouponForPlan(phase.planType);
    if (desired === null) {
      phaseCouponIds.push([...phase.couponIds]);
      blockers.push(`phase ${i}: unknown plan ${phase.planType} — left untouched`);
      return;
    }

    phaseCouponIds.push([desired]);
    const before = managed[0] ?? null;
    if (before !== desired) {
      changed = true;
      notes.push(
        before
          ? `phase ${i} (${phase.planType}): ${couponCodeFor(before)} → ${couponCodeFor(desired)}`
          : `phase ${i} (${phase.planType}): restored ${couponCodeFor(desired)}`
      );
    }
  });

  return { phaseCouponIds, notes, changed, blockers };
}
