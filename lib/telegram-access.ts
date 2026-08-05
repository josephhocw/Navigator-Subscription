// =============================================================================
// TELEGRAM JOIN-GUARD DECISION LOGIC
// =============================================================================
// TypeScript port of the join-evaluation half of the bot repo's access.py (the
// removal half already lives in telegram-groups.ts). Pure functions, no I/O —
// the webhook endpoint feeds these and acts on the verdict.
//
// One deliberate divergence from access.py, mirroring telegram-groups.ts: an
// unrecognised plan string on a live row FAILS SAFE (allow + report) instead
// of granting nothing and kicking a paying subscriber over a typo in col F.
// =============================================================================

import type { Subscriber } from "./subscriber-store.js";
import {
  MAIN_MARKET,
  normaliseTelegramUsername,
  liveRowsFor,
  entitledMarkets,
  hasUnrecognisedLivePlan,
  isWhitelisted,
  isCurrentMember,
  type GroupConfig,
} from "./telegram-groups.js";

// Re-exported so existing imports of isCurrentMember from this module keep
// working — the implementation now lives in telegram-groups.ts, deduplicated
// against the identical copy that used to live here.
export { isCurrentMember } from "./telegram-groups.js";

/** The slice of Telegram's ChatMember object the join guard reads. */
export interface ChatMemberLite {
  status?: string;
  is_member?: boolean;
}

/** True when a chat_member update represents someone actually joining. */
export function isJoinTransition(oldM: ChatMemberLite, newM: ChatMemberLite): boolean {
  return isCurrentMember(newM) && !isCurrentMember(oldM);
}

export type JoinVerdict =
  | {
      decision: "allow";
      /** Non-barred rows to write the joiner's User ID into (col P). */
      rowsToUpdate: Subscriber[];
      reason: "entitled" | "guest" | "whitelisted";
    }
  | {
      /** Fail-safe: a live row's plan string is unrecognised, so entitlement
       *  can't be trusted. Allow, write col P, and ping Joseph to fix col F. */
      decision: "allow-unrecognised-plan";
      rowsToUpdate: Subscriber[];
    }
  | { decision: "kick"; reason: "no-username" | "not-found" | "cancelled" | "wrong-plan" };

/**
 * Decide whether a joiner may stay in `group`. Mirrors access.py
 * evaluate_join(): a user is entitled if ANY live (non-barred) row's plan
 * covers the group's market — never judge by the first row alone. The main
 * group is lenient: guests (and no-username joiners) are welcome; only a
 * subscriber whose rows are ALL barred is kicked. "Barred" is defined by
 * liveRowsFor (CANCELLED and TRIAL_CANCELLED).
 */
export function evaluateJoin(
  joinerUsername: string | undefined | null,
  group: GroupConfig,
  allSubscribers: Subscriber[],
  whitelist: Set<string>
): JoinVerdict {
  const username = normaliseTelegramUsername(joinerUsername);

  // No username: market groups kick on sight (unmatchable against the sheet);
  // the open main group treats them as welcome guests. Mirrors bot.py.
  if (!username) {
    return group.market === MAIN_MARKET
      ? { decision: "allow", rowsToUpdate: [], reason: "guest" }
      : { decision: "kick", reason: "no-username" };
  }

  if (isWhitelisted(username, whitelist)) {
    return { decision: "allow", rowsToUpdate: [], reason: "whitelisted" };
  }

  const liveRows = liveRowsFor(username, allSubscribers);
  const hasAnyRow = allSubscribers.some(
    (r) => normaliseTelegramUsername(r.telegramUsername) === username
  );

  if (group.market === MAIN_MARKET) {
    if (!hasAnyRow) return { decision: "allow", rowsToUpdate: [], reason: "guest" };
    if (liveRows.length === 0) return { decision: "kick", reason: "cancelled" };
    // Any live row entitles — a blank or drifted plan string is irrelevant here.
    return { decision: "allow", rowsToUpdate: liveRows, reason: "entitled" };
  }

  if (!hasAnyRow) return { decision: "kick", reason: "not-found" };
  if (liveRows.length === 0) return { decision: "kick", reason: "cancelled" };

  if (hasUnrecognisedLivePlan(username, allSubscribers)) {
    return { decision: "allow-unrecognised-plan", rowsToUpdate: liveRows };
  }

  // entitledMarkets() also adds the MAIN pseudo-market, but this branch only
  // ever runs for market groups (the MAIN_MARKET case returns above), so
  // group.market can never be MAIN here — the extra entry is harmless.
  const entitled = entitledMarkets(username, allSubscribers);
  if (!entitled.has(group.market)) return { decision: "kick", reason: "wrong-plan" };

  return { decision: "allow", rowsToUpdate: liveRows, reason: "entitled" };
}
