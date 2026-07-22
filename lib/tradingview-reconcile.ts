// =============================================================================
// TRADINGVIEW RECONCILE
// =============================================================================
// The daily safety net behind the inline webhook automation. It reads the whole
// subscriber sheet and the current grantees on all 8 scripts, then fixes drift:
//
//   - entitled subscriber (not CANCELLED) missing their plan's script → grant
//   - in-sheet subscriber on a script they shouldn't be on (cancelled, or a
//     stale grant from an old plan) → remove
//
// Safety rule (test case 22): it ONLY ever acts on usernames that appear in the
// sheet. Anyone on a script but NOT in the sheet — Robin's comps, reviewers,
// the TCM 2-month grants — is invisible to it and never removed. No allowlist
// needed; "not in the sheet" is the allowlist.
//
// It catches missed webhook grants, a plan change that failed mid-flight, and a
// cancellation whose removal failed (e.g. the cookie was dead that day).
// =============================================================================

import type { Subscriber, SubscriberStore } from "./subscriber-store.js";
import {
  PLAN_TO_PINE_ID,
  planToPineId,
  type TradingViewGranter,
} from "./tradingview-access.js";

// The reconcile needs to READ current grantees too, so it wants a granter that
// can also list. TradingViewAccessClient satisfies this.
export interface TradingViewReconciler extends TradingViewGranter {
  listUsers(pineId: string): Promise<string[]>;
}

export interface ReconcileAction {
  username: string;
  planType: string;
}

export interface ReconcilePlan {
  toGrant: ReconcileAction[];
  toRemove: ReconcileAction[];
}

// A subscriber is entitled to access until they're fully CANCELLED — the same
// rule the Telegram bot uses (ACTIVE, PAYMENT_FAILED and CANCELLATION_SCHEDULED
// all keep access; only CANCELLED loses it).
const ENTITLED_STATUSES = new Set([
  "ACTIVE",
  "PAYMENT_FAILED",
  "CANCELLATION_SCHEDULED",
]);

const ALL_PLANS = Object.keys(PLAN_TO_PINE_ID);

/**
 * Pure diff. Given every sheet row and the current grantees per plan, return
 * the grants and removes needed. Only usernames present in `subscribers` ever
 * appear in the result — comps are untouchable.
 *
 * `grantsByPlan` maps a plan string to the usernames currently on that script
 * (as returned by list_users; case is normalised here).
 */
export function computeReconciliation(
  subscribers: Subscriber[],
  grantsByPlan: Record<string, string[]>
): ReconcilePlan {
  // Current presence per plan, lowercased for case-insensitive comparison.
  const present: Record<string, Set<string>> = {};
  for (const plan of ALL_PLANS) {
    present[plan] = new Set((grantsByPlan[plan] ?? []).map((u) => u.toLowerCase()));
  }

  // Aggregate desired access per username across ALL their rows. A subscriber
  // can legitimately hold two subscriptions (e.g. maxkohts) → the union of
  // their entitled plans. A username with only cancelled rows contributes an
  // empty plan set, so they get removed from every script.
  const desired = new Map<
    string,
    { username: string; plans: Set<string> }
  >();
  for (const sub of subscribers) {
    const username = sub.tradingViewUsername?.trim();
    if (!username) continue;
    const key = username.toLowerCase();
    if (!desired.has(key)) desired.set(key, { username, plans: new Set() });
    const entitled = ENTITLED_STATUSES.has(sub.status);
    // Only add known plans — an unrecognised plan string is left alone rather
    // than guessed at.
    if (entitled && PLAN_TO_PINE_ID[sub.currentPlan]) {
      desired.get(key)!.plans.add(sub.currentPlan);
    }
  }

  const toGrant: ReconcileAction[] = [];
  const toRemove: ReconcileAction[] = [];
  for (const { username, plans } of desired.values()) {
    const key = username.toLowerCase();
    for (const plan of ALL_PLANS) {
      const shouldHave = plans.has(plan);
      const has = present[plan].has(key);
      if (shouldHave && !has) toGrant.push({ username, planType: plan });
      if (!shouldHave && has) toRemove.push({ username, planType: plan });
    }
  }
  return { toGrant, toRemove };
}

export interface ReconcileSummary {
  granted: number;
  removed: number;
  failures: string[];
}

/**
 * Fetch live state, compute the diff, and apply it. Returns a summary for the
 * admin ping. Individual grant/remove failures are collected, not thrown, so
 * one bad row (or a dead cookie mid-run) doesn't abort the whole sweep.
 */
export async function reconcileTradingView(
  store: SubscriberStore,
  tv: TradingViewReconciler
): Promise<ReconcileSummary> {
  const [subscribers, grantsByPlan] = await Promise.all([
    store.listAll(),
    loadGrantsByPlan(tv),
  ]);

  const plan = computeReconciliation(subscribers, grantsByPlan);
  const failures: string[] = [];
  let granted = 0;
  let removed = 0;

  for (const a of plan.toGrant) {
    try {
      await tv.grantForPlan(a.username, a.planType);
      granted++;
    } catch (err) {
      failures.push(`grant ${a.username}/${a.planType}: ${errMsg(err)}`);
    }
  }
  for (const a of plan.toRemove) {
    try {
      await tv.removeForPlan(a.username, a.planType);
      removed++;
    } catch (err) {
      failures.push(`remove ${a.username}/${a.planType}: ${errMsg(err)}`);
    }
  }

  return { granted, removed, failures };
}

async function loadGrantsByPlan(
  tv: TradingViewReconciler
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const plan of ALL_PLANS) {
    out[plan] = await tv.listUsers(planToPineId(plan));
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
