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
// SAFETY PROPERTY: this module only ever acts on the single subscriber it is
// handed — their Telegram User ID for the removal, their username for the
// entitlement and whitelist checks. It never lists group members and never
// decides anything about a person it was not given. Someone with no row in the
// sheet — e.g. a friend given free group access by hand — is unreachable by
// this code path.
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
  username: string | undefined | null,
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
      // parsePlanType("") returns markets [""] — filter it out so the returned
      // set is clean. A NON-blank unrecognised plan round-trips as [planType]
      // and would enter the set; hasUnrecognisedLivePlan() is what stops that
      // from causing an over-removal.
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

/**
 * Whitelisted usernames are never removed from anything.
 *
 * `whitelist` entries must ALREADY be normalised (see normaliseTelegramUsername);
 * loadWhitelistFromEnv() guarantees this. An un-normalised Set silently matches
 * nobody.
 */
export function isWhitelisted(
  username: string | undefined | null,
  whitelist: Set<string>
): boolean {
  const u = normaliseTelegramUsername(username);
  return u !== "" && whitelist.has(u);
}

/**
 * Does this user hold a live row whose plan string we don't recognise?
 *
 * A typo or a drifted plan code (e.g. "HK " with a trailing space, or a plan
 * added to plans.ts but not yet deployed) parses to the `unknown` category,
 * whose "market" matches no group — so it would silently target EVERY group
 * and remove a paying subscriber. Rather than guess, we remove nothing and
 * tell Joseph to look.
 *
 * A BLANK plan is not uncertain: a live row with no plan legitimately grants
 * main-group access only, and that is long-standing behaviour.
 *
 * Mirrors the `uncertain` guard in tradingview-reconcile.ts — an unrecognised
 * plan must never strip access someone is paying for.
 */
export function hasUnrecognisedLivePlan(
  username: string | undefined | null,
  all: Subscriber[]
): boolean {
  const target = normaliseTelegramUsername(username);
  if (!target) return false;

  return all.some((row) => {
    if (normaliseTelegramUsername(row.telegramUsername) !== target) return false;
    if (row.status === BARRED_STATUS) return false;
    const plan = row.currentPlan ?? "";
    if (plan.trim() === "") return false; // blank is a known, allowed case
    // Deliberately parse the UNTRIMMED plan — a trailing space (e.g. "HK ")
    // is exactly the kind of drift this guard exists to catch; trimming it
    // first would silently normalise the typo away.
    return parsePlanType(plan).category === "unknown";
  });
}

// -----------------------------------------------------------------------------
// Configuration. Everything comes from env so nothing is hardcoded twice.
//
// These chat IDs and the whitelist are duplicated from the bot repo's
// config.py. That duplication disappears when the bots move onto Vercel; until
// then, change both. See CLAUDE.md.
// -----------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const GROUP_ENV: ReadonlyArray<{ key: string; market: string; envVar: string }> = [
  { key: "HK_MARKET", market: "HK", envVar: "TELEGRAM_CHAT_HK" },
  { key: "SG_MARKET", market: "SG", envVar: "TELEGRAM_CHAT_SG" },
  { key: "US_MARKET", market: "US", envVar: "TELEGRAM_CHAT_US" },
  { key: "FXMC_MARKET", market: "FXMC", envVar: "TELEGRAM_CHAT_FXMC" },
  { key: "MAIN_GROUP", market: MAIN_MARKET, envVar: "TELEGRAM_CHAT_MAIN" },
];

/**
 * Build the group list from env. A missing or malformed chat ID drops that one
 * group rather than throwing — a typo must never take the webhook down, and a
 * partially configured deployment should still remove from the groups it knows.
 */
export function loadGroupsFromEnv(env: Env = process.env): GroupConfig[] {
  const groups: GroupConfig[] = [];
  for (const { key, market, envVar } of GROUP_ENV) {
    const raw = env[envVar]?.trim();
    if (!raw) continue;
    const chatId = Number(raw);
    if (!Number.isFinite(chatId)) {
      console.warn(`${envVar} is not a number ("${raw}") — skipping ${key}`);
      continue;
    }
    groups.push({ key, chatId, market });
  }
  return groups;
}

/** Usernames never removed from anything. Mirrors config.py WHITELIST. */
export function loadWhitelistFromEnv(env: Env = process.env): Set<string> {
  const raw = env.TELEGRAM_KICK_WHITELIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => normaliseTelegramUsername(s))
      .filter((s) => s !== "")
  );
}

/** Dry-run reports what it would do without calling banChatMember. */
export function isDryRun(env: Env = process.env): boolean {
  return env.TELEGRAM_KICK_DRY_RUN === "true";
}

// -----------------------------------------------------------------------------
// The seam the lifecycle uses. It knows nothing about HTTP or chat IDs — only
// "this person's subscription ended; remove them from what they've lost".
// In tests it's satisfied by a recording fake; in production by TelegramGroupApi.
// -----------------------------------------------------------------------------

export interface RemovalInput {
  /** Col P. Blank means the subscriber never joined — nothing to remove. */
  telegramUserId: string;
  /** Col D. Used for the whitelist check and entitlement matching. */
  telegramUsername: string;
  /** Every sheet row, so other live subscriptions can be honoured. */
  allSubscribers: Subscriber[];
}

export interface RemovalResult {
  /** Group keys actually removed from (or, in dry-run, that would have been). */
  removed: string[];
  /** Group keys where the user was not a member — nothing to do. */
  skipped: string[];
  /** "GROUP_KEY: message" for each group that errored. */
  failures: string[];
  dryRun: boolean;
  /** Set when the whole removal was short-circuited. */
  reason?: "whitelisted" | "no-user-id" | "not-configured" | "unrecognised-plan";
}

export interface TelegramGroupRemover {
  /** False on the Noop so callers don't claim a removal that never happened. */
  readonly configured?: boolean;
  removeFromGroups(input: RemovalInput): Promise<RemovalResult>;
}

/** Used when no chat IDs or no bot token are configured. Never throws. */
export class NoopTelegramGroupRemover implements TelegramGroupRemover {
  readonly configured = false;

  async removeFromGroups(_input: RemovalInput): Promise<RemovalResult> {
    return { removed: [], skipped: [], failures: [], dryRun: false, reason: "not-configured" };
  }
}

/** Chat-member statuses that mean "currently in the group". */
const MEMBER_STATUSES = new Set(["member", "administrator", "creator"]);

function isCurrentMember(result: { status?: string; is_member?: boolean }): boolean {
  if (!result?.status) return false;
  if (MEMBER_STATUSES.has(result.status)) return true;
  // A "restricted" user may be in or out of the group — the flag decides.
  return result.status === "restricted" && result.is_member === true;
}

export interface TelegramGroupApiOptions {
  token: string;
  groups: GroupConfig[];
  whitelist: Set<string>;
  dryRun: boolean;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class TelegramGroupApi implements TelegramGroupRemover {
  readonly configured = true;

  private readonly token: string;
  private readonly groups: GroupConfig[];
  private readonly whitelist: Set<string>;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramGroupApiOptions) {
    if (!opts.token) throw new Error("TelegramGroupApi needs a bot token");
    this.token = opts.token;
    this.groups = opts.groups;
    this.whitelist = opts.whitelist;
    this.dryRun = opts.dryRun;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async removeFromGroups(input: RemovalInput): Promise<RemovalResult> {
    const base: RemovalResult = {
      removed: [],
      skipped: [],
      failures: [],
      dryRun: this.dryRun,
    };

    if (isWhitelisted(input.telegramUsername, this.whitelist)) {
      return { ...base, reason: "whitelisted" };
    }

    const userId = input.telegramUserId?.trim();
    if (!userId) return { ...base, reason: "no-user-id" };

    // An unrecognised plan on a live row means we can't trust the entitlement
    // calculation. Fail safe: remove nothing, and report it.
    if (hasUnrecognisedLivePlan(input.telegramUsername, input.allSubscribers)) {
      return { ...base, reason: "unrecognised-plan" };
    }

    const entitled = entitledMarkets(input.telegramUsername, input.allSubscribers);
    const targets = groupsToRemove(entitled, this.groups);

    for (const group of targets) {
      try {
        if (!(await this.isMember(group.chatId, userId))) {
          base.skipped.push(group.key);
          continue;
        }
        if (!this.dryRun) {
          await this.call("banChatMember", { chat_id: group.chatId, user_id: userId });
          // only_if_banned so a race can't turn the unban into a second removal.
          await this.call("unbanChatMember", {
            chat_id: group.chatId,
            user_id: userId,
            only_if_banned: true,
          });
        }
        base.removed.push(group.key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        base.failures.push(`${group.key}: ${message}`);
      }
    }

    return base;
  }

  /**
   * Is this user currently in the chat? A failed lookup means Telegram doesn't
   * know them there (they never joined) — treat as "not a member" and skip
   * quietly, exactly as common.py kick_user() does. A ban would fail the same
   * way, and transient errors self-heal on scheduler.py's next sweep.
   */
  private async isMember(chatId: number, userId: string): Promise<boolean> {
    try {
      const result = await this.call<{ status?: string; is_member?: boolean }>(
        "getChatMember",
        { chat_id: chatId, user_id: userId }
      );
      return isCurrentMember(result);
    } catch {
      return false;
    }
  }

  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const res = await this.fetchImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      }
    );
    const body = (await res.json()) as { ok?: boolean; result?: T; description?: string };
    if (!body.ok) {
      throw new Error(body.description ?? `Telegram ${method} failed (HTTP ${res.status})`);
    }
    return body.result as T;
  }
}
