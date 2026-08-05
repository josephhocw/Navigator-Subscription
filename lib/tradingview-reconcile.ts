// =============================================================================
// TRADINGVIEW RECONCILE
// =============================================================================
// The daily safety net behind the inline webhook automation. It reads the whole
// subscriber sheet and the current grantees on all 8 scripts, then fixes drift:
//
//   - entitled subscriber (not barred — see ENTITLED_STATUSES) missing their
//     plan's script → grant
//   - in-sheet subscriber on a script they shouldn't be on (barred, or a
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
  // Entitled subscribers whose plan string isn't recognised. We deliberately do
  // NOT remove their access (a typo'd plan must never strip a paying customer);
  // they're surfaced here for a manual fix instead.
  uncertain: string[];
}

// A subscriber is entitled to access until they're fully cancelled — the same
// rule the Telegram bot uses. Trial statuses mirror their paid counterparts:
// TRIAL_ACTIVE / TRIAL_CANCELLATION_SCHEDULED keep access, TRIAL_CANCELLED
// (like CANCELLED) loses it.
//
// This is an ALLOWLIST — an unrecognised status is NOT entitled, so it fails
// toward removal — the opposite of telegram-groups.ts's BARRED_STATUSES
// blocklist, where an unrecognised status is NOT barred, so it fails toward
// keeping access. Each module's failure direction was chosen for what it
// guards: a script grant is easy to re-issue by hand, so this side fails
// closed; a wrongful group kick is disruptive and hard to walk back
// unnoticed, so that side fails open.
const ENTITLED_STATUSES = new Set([
  "ACTIVE",
  "PAYMENT_FAILED",
  "CANCELLATION_SCHEDULED",
  "TRIAL_ACTIVE",
  "TRIAL_CANCELLATION_SCHEDULED",
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
  // Usernames with an entitled row whose plan string we don't recognise. These
  // are never removed from anything — a typo in the plan column must not strip a
  // paying customer's access. They also can't be granted (no known plan), so
  // they simply keep whatever they have and get surfaced for a manual fix.
  const uncertain = new Set<string>();
  for (const sub of subscribers) {
    const username = sub.tradingViewUsername?.trim();
    if (!username) continue;
    const key = username.toLowerCase();
    if (!desired.has(key)) desired.set(key, { username, plans: new Set() });
    const entitled = ENTITLED_STATUSES.has(sub.status);
    if (entitled) {
      if (PLAN_TO_PINE_ID[sub.currentPlan]) {
        desired.get(key)!.plans.add(sub.currentPlan);
      } else {
        uncertain.add(key);
      }
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
      // The uncertain guard: skip ALL removals for a user we can't reason about.
      if (!shouldHave && has && !uncertain.has(key)) {
        toRemove.push({ username, planType: plan });
      }
    }
  }
  const uncertainNames = [...desired.values()]
    .filter((d) => uncertain.has(d.username.toLowerCase()))
    .map((d) => d.username);
  return { toGrant, toRemove, uncertain: uncertainNames };
}

export interface ReconcileSummary {
  granted: number;
  removed: number;
  grantedList: string[]; // "username/PLAN" for each successful grant
  removedList: string[]; // "username/PLAN" for each successful remove
  uncertain: string[]; // entitled subscribers with an unrecognised plan (untouched)
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
  const grantedList: string[] = [];
  const removedList: string[] = [];

  for (const a of plan.toGrant) {
    try {
      await tv.grantForPlan(a.username, a.planType);
      grantedList.push(`${a.username}/${a.planType}`);
    } catch (err) {
      failures.push(`grant ${a.username}/${a.planType}: ${errMsg(err)}`);
    }
  }
  for (const a of plan.toRemove) {
    try {
      await tv.removeForPlan(a.username, a.planType);
      removedList.push(`${a.username}/${a.planType}`);
    } catch (err) {
      failures.push(`remove ${a.username}/${a.planType}: ${errMsg(err)}`);
    }
  }

  return {
    granted: grantedList.length,
    removed: removedList.length,
    grantedList,
    removedList,
    uncertain: plan.uncertain,
    failures,
  };
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
