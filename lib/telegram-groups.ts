// =============================================================================
// TELEGRAM GROUP ACCESS
// =============================================================================
// Removes a cancelled subscriber from the Telegram groups they are no longer
// entitled to, at the moment their subscription ends — instead of waiting for
// the bot repo's scheduler.py sweep at 12:00 PM SGT.
//
// This is a TypeScript port of the decision logic in the bot repo's access.py
// (entitlements_by_username / groups_to_kick / is_whitelisted) plus the kick
// itself from common.py (ban + unban). The bot keeps running: bot.py still
// guards joins and writes col P, and scheduler.py stays as the daily reconcile.
//
// SAFETY PROPERTY: this module only ever acts on the single Telegram User ID it
// is handed. It never lists group members and never decides anything about a
// person it was not given. Someone with no row in the sheet — e.g. a friend
// given free group access by hand — is unreachable by this code path.
// =============================================================================

import { parsePlanType } from "./plans.js";
import type { Subscriber } from "./subscriber-store.js";

/** Pseudo-market for the open main "RHO Navigator Subscribers" group. No plan
 *  maps to it — ANY non-cancelled row grants it, whatever the plan string. */
export const MAIN_MARKET = "MAIN";

/** The one status that loses access. ACTIVE, CANCELLATION_SCHEDULED and
 *  PAYMENT_FAILED are all still entitled — mirrors access.py BARRED_STATUS. */
const BARRED_STATUS = "CANCELLED";

export interface GroupConfig {
  /** Stable key used in logs and pings, e.g. "HK_MARKET". */
  key: string;
  chatId: number;
  /** "HK" | "SG" | "US" | "FXMC" | MAIN_MARKET */
  market: string;
}

/** Lowercase, @-stripped, trimmed. Telegram usernames are case-insensitive. */
export function normaliseTelegramUsername(username: string | undefined | null): string {
  if (!username) return "";
  return username.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Markets this username is STILL entitled to, from their non-cancelled rows.
 *
 * A subscriber can hold several rows (one per Stripe subscription), so the
 * cancelled row must never be judged alone — that would remove someone whose
 * second subscription is still live.
 */
export function entitledMarkets(
  username: string,
  all: Subscriber[]
): Set<string> {
  const target = normaliseTelegramUsername(username);
  const markets = new Set<string>();
  if (!target) return markets;

  for (const row of all) {
    if (normaliseTelegramUsername(row.telegramUsername) !== target) continue;
    if (row.status === BARRED_STATUS) continue;
    // Any live subscription keeps main-group access, even if the plan string
    // is blank or has drifted from plans.ts.
    markets.add(MAIN_MARKET);
    for (const m of parsePlanType(row.currentPlan ?? "").markets) {
      // A blank/unrecognised plan string round-trips through parsePlanType
      // as markets: [""] — skip it. No GroupConfig.market is ever "", so
      // this only prevents a stray empty string from polluting the set.
      if (m) markets.add(m);
    }
  }
  return markets;
}

/**
 * The groups to remove from: every configured group whose market is not in the
 * entitled set. Deliberately independent of the cancelled row's own plan
 * string, so a drifted or blank plan cannot leave someone un-removed.
 */
export function groupsToRemove(
  entitled: Set<string>,
  groups: GroupConfig[]
): GroupConfig[] {
  return groups.filter((g) => !entitled.has(g.market));
}

/** Whitelisted usernames are never removed from anything. */
export function isWhitelisted(
  username: string | undefined,
  whitelist: Set<string>
): boolean {
  const u = normaliseTelegramUsername(username);
  return u !== "" && whitelist.has(u);
}
