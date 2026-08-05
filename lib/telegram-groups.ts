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

/** Statuses that lose access. ACTIVE, CANCELLATION_SCHEDULED, PAYMENT_FAILED,
 *  TRIAL_ACTIVE and TRIAL_CANCELLATION_SCHEDULED are all still entitled —
 *  mirrors access.py BARRED_STATUSES in the bot repo. */
const BARRED_STATUSES = new Set(["CANCELLED", "TRIAL_CANCELLED"]);

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
 * Every non-cancelled row belonging to this username.
 *
 * Shared by entitledMarkets() and hasUnrecognisedLivePlan() on purpose: one is
 * the other's safety guard, so if their idea of "a live row for this person"
 * ever drifted apart, the guard would stop guarding the rows it is meant to.
 * Returns nothing for a blank username — a blank cell must never match the
 * other blank cells in the sheet.
 */
export function liveRowsFor(
  username: string | undefined | null,
  all: Subscriber[]
): Subscriber[] {
  const target = normaliseTelegramUsername(username);
  if (!target) return [];
  return all.filter(
    (row) =>
      normaliseTelegramUsername(row.telegramUsername) === target &&
      !BARRED_STATUSES.has(row.status)
  );
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
  const markets = new Set<string>();

  for (const row of liveRowsFor(username, all)) {
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
  return liveRowsFor(username, all).some((row) => {
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
    // Chat IDs are plain (usually negative) integers. Number() alone is far too
    // permissive here: "0x10" becomes 16 and "1e5" becomes 100000, so a mangled
    // env var would silently point a removal at SOME OTHER chat. Insist on the
    // literal digit form first, then on a value that survives as an exact
    // integer — a fat-fingered extra digit past 2^53 would otherwise round.
    // Zero is never a real chat.
    if (!/^-?\d+$/.test(raw)) {
      console.warn(`${envVar} is not a plain integer ("${raw}") — skipping ${key}`);
      continue;
    }
    const chatId = Number(raw);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      console.warn(`${envVar} is not a usable chat ID ("${raw}") — skipping ${key}`);
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

/**
 * Generic fail-safe dry-run flag: only the literal "false" (trimmed,
 * case-insensitive) goes live. An unset variable, a typo, or a var scoped to
 * Preview only all stay in dry-run. Shared by the kick, join-guard and sweep
 * flags so all three behave identically.
 */
export function flagIsDryRun(envVar: string, env: Env = process.env): boolean {
  return (env[envVar] ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Dry-run reports what it would do without calling banChatMember.
 *
 * Deliberately fails SAFE: anything other than an explicit "false" means
 * dry-run. An unset variable, a typo ("ture"), a wrong-cased "TRUE", or a
 * value that exists in Vercel's Preview scope but not Production all leave
 * the feature in report-only mode. Going live is a deliberate act.
 */
export function isDryRun(env: Env = process.env): boolean {
  return flagIsDryRun("TELEGRAM_KICK_DRY_RUN", env);
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
  /**
   * Group keys where the ban landed but the unban did not, so the user is
   * sitting under a PERMANENT ban and cannot even request to rejoin. Always
   * present, and empty in the ordinary case. These need a human — nothing
   * else in the system can see them (see removeFromGroups).
   */
  outstandingBans: string[];
  /**
   * "GROUP_KEY: sheet says @x, Telegram says @y" for each group where the
   * account behind col P's User ID is NOT the account named in col D. Nothing
   * was removed from those groups. Always present, and empty in the ordinary
   * case (see removeFromGroups).
   */
  identityMismatches: string[];
  dryRun: boolean;
  /**
   * Dry-run only: the loaded config, as counts, so the operator can eyeball it
   * once without opening the Vercel dashboard. A missing TELEGRAM_KICK_WHITELIST
   * silently means "nobody is protected", and that is worth seeing. Counts only —
   * never the usernames themselves, and never anything derived from the token.
   */
  configSummary?: string;
  /** Set when the whole removal was short-circuited. */
  reason?:
    | "whitelisted"
    | "no-user-id"
    | "no-username"
    | "not-configured"
    | "unrecognised-plan";
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
    return {
      removed: [],
      skipped: [],
      failures: [],
      outstandingBans: [],
      identityMismatches: [],
      dryRun: false,
      reason: "not-configured",
    };
  }
}

/**
 * The slice of Telegram's ChatMember object this module reads.
 *
 * `user.username` is the whole point of CHANGE 2: it is the only way to check
 * that the account behind col P's User ID is the account col D names.
 */
interface ChatMemberResult {
  status?: string;
  is_member?: boolean;
  user?: { username?: string };
}

/** Chat-member statuses that mean "currently in the group". */
const MEMBER_STATUSES = new Set(["member", "administrator", "creator"]);

function isCurrentMember(result: { status?: string; is_member?: boolean }): boolean {
  if (!result?.status) return false;
  if (MEMBER_STATUSES.has(result.status)) return true;
  // A "restricted" user may be in or out of the group — the flag decides.
  return result.status === "restricted" && result.is_member === true;
}

/**
 * Telegram answered, and its answer was `ok: false`.
 *
 * The distinction matters: this means the API was reached and gave a verdict
 * (typically "user not found" / "chat not found"), whereas a plain Error from
 * call() means we never got a usable answer at all — the socket died, or the
 * body was a gateway HTML page. getMember() treats only the former as "not a
 * member"; anything else has to surface as a real failure.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

/**
 * A short, safe one-line excerpt of a response body for an error message.
 *
 * Angle brackets are stripped and whitespace collapsed because these strings
 * end up inside `failures`, which the lifecycle splices into an admin ping sent
 * with parse_mode HTML. An unescaped "<html><head>" there makes Telegram reject
 * the ping itself, so the one message that would have told Joseph something
 * broke is the message that goes missing.
 */
function bodyExcerpt(text: string, max = 120): string {
  const flat = text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (flat === "") return "(empty body)";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export type KickOutcome =
  | { outcome: "removed" }
  | { outcome: "still-banned"; unbanError: string };

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

  /**
   * Ban + unban — Telegram's "remove without a permanent ban" — with the same
   * retry-then-report-loudly unban semantics removeFromGroups always had.
   * Throws if the BAN fails (nothing happened); returns "still-banned" if the
   * ban landed but both unbans failed (the user is out AND locked out — needs
   * a human). Public so the join guard and daily sweep kick through this one
   * tested path.
   *
   * NOTE: this method ignores this.dryRun — the CALLER owns the dry-run gate.
   * A dry-run caller must not call this at all.
   * Thrown ban errors are NOT token-redacted (describe() runs only on the
   * returned unbanError) — callers must sanitise before splicing a thrown
   * error into a ping.
   */
  async kickFromChat(chatId: number, userId: string): Promise<KickOutcome> {
    await this.call("banChatMember", { chat_id: chatId, user_id: userId });
    try {
      await this.unban(chatId, userId);
    } catch {
      try {
        await this.unban(chatId, userId);
      } catch (err) {
        return { outcome: "still-banned", unbanError: this.describe(err) };
      }
    }
    return { outcome: "removed" };
  }

  /**
   * Short-circuit order is deliberate and is asserted by a test:
   *   whitelisted → no user ID → no username → unrecognised plan.
   * Whitelist comes first so a protected account is never touched whatever else
   * is wrong with their row.
   */
  async removeFromGroups(input: RemovalInput): Promise<RemovalResult> {
    const base: RemovalResult = {
      removed: [],
      skipped: [],
      failures: [],
      outstandingBans: [],
      identityMismatches: [],
      dryRun: this.dryRun,
      // Only in dry-run, and only counts: this is for eyeballing the loaded
      // config once during validation, not a place to leak who is protected.
      ...(this.dryRun
        ? {
            configSummary: `${this.groups.length} groups, ${this.whitelist.size} whitelisted`,
          }
        : {}),
    };

    if (isWhitelisted(input.telegramUsername, this.whitelist)) {
      return { ...base, reason: "whitelisted" };
    }

    const userId = input.telegramUserId?.trim();
    if (!userId) return { ...base, reason: "no-user-id" };

    // A BLANK username is the one input for which entitlement is uncomputable,
    // and computing it anyway is maximally destructive: entitledMarkets("")
    // returns the empty set, so groupsToRemove() would target EVERY group and
    // strip a subscriber whose other subscriptions are still live. Neither the
    // whitelist nor the unrecognised-plan guard can catch a blank name either —
    // both match on it and both answer "false". So bail before any of that.
    if (normaliseTelegramUsername(input.telegramUsername) === "") {
      return { ...base, reason: "no-username" };
    }

    // An unrecognised plan on a live row means we can't trust the entitlement
    // calculation. Fail safe: remove nothing, and report it.
    if (hasUnrecognisedLivePlan(input.telegramUsername, input.allSubscribers)) {
      return { ...base, reason: "unrecognised-plan" };
    }

    const entitled = entitledMarkets(input.telegramUsername, input.allSubscribers);
    const targets = groupsToRemove(entitled, this.groups);

    const sheetUsername = normaliseTelegramUsername(input.telegramUsername);

    for (const group of targets) {
      try {
        const member = await this.getMember(group.chatId, userId);
        if (!member || !isCurrentMember(member)) {
          base.skipped.push(group.key);
          continue;
        }

        // Entitlement was computed from col D (the username); the removal
        // executes against col P (the User ID). If col P holds the wrong ID —
        // and col P is hand-filled for complimentary-access rows — the ban
        // lands on a completely different person, possibly one of the friends
        // given free group access by hand. Telegram just told us whose account
        // that ID actually is, so check it.
        //
        // Telegram reporting NO username is not evidence of a wrong ID: a user
        // may never have set one, or may have removed it since. Col P was
        // written by the join guard after a username match, so proceed.
        const reported = normaliseTelegramUsername(member.user?.username);
        if (reported !== "" && reported !== sheetUsername) {
          // Skip and report rather than hard-block the whole removal: a
          // subscriber can legitimately rename themselves on Telegram, and the
          // dry-run period is exactly when to measure how often this fires.
          base.identityMismatches.push(
            `${group.key}: sheet says @${sheetUsername}, Telegram says @${reported}`
          );
          continue;
        }

        // The ban has landed: the person IS out of the group, and stays out
        // until the unban. A failed unban is not "the removal failed", it is
        // "the removal succeeded and left a permanent ban behind".
        //
        // A permanent ban is invisible to everything else we run: a banned
        // user can't even request to rejoin, so bot.py's join guard never
        // sees them and scheduler.py's sweep never touches them. If they
        // resubscribe they are simply locked out. So kickFromChat retries the
        // unban once, then reports it loudly rather than filing it as an
        // ordinary failure.
        if (!this.dryRun) {
          const kick = await this.kickFromChat(group.chatId, userId);
          if (kick.outcome === "still-banned") {
            base.removed.push(group.key);
            base.outstandingBans.push(group.key);
            base.failures.push(
              `${group.key}: BANNED BUT NOT UNBANNED — user ${userId} is still banned in chat ${group.chatId} and cannot rejoin. Unban by hand. (${kick.unbanError})`
            );
            continue;
          }
        }
        base.removed.push(group.key);
      } catch (err) {
        base.failures.push(`${group.key}: ${this.describe(err)}`);
      }
    }

    return base;
  }

  /**
   * An error's message, made safe to put in a `failures` string.
   *
   * Everything in `failures` is forwarded to Joseph in an HTML-parsed Telegram
   * ping. Our own errors are already clean, but a fetch implementation is free
   * to quote the request URL back at us — and that URL contains the bot token.
   * Redact it here, at the one place every failure string is built.
   */
  private describe(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    // Real bot tokens look like "123456789:AAH…" — always long. The length
    // guard stops a short stub token (tests use "T") from being matched inside
    // ordinary words and shredding the message it was meant to protect.
    if (this.token.length < 8) return message;
    // Square brackets, not angle ones — this string lands in an HTML message.
    return message.split(this.token).join("[bot token]");
  }

  /** only_if_banned so a race can't turn the unban into a second removal. */
  private async unban(chatId: number, userId: string): Promise<void> {
    await this.call("unbanChatMember", {
      chat_id: chatId,
      user_id: userId,
      only_if_banned: true,
    });
  }

  /**
   * Telegram's ChatMember record for this user in this chat, or null.
   *
   * Returns the whole record rather than a bare "are they in?" boolean because
   * the caller needs `user.username` to check that the account behind col P's
   * User ID is the person col D names — see removeFromGroups.
   *
   * A TelegramApiError means Telegram answered and said it doesn't know this
   * user here — they never joined. That is the normal case, and the right
   * answer is null → "not a member": skip quietly, exactly as common.py
   * kick_user() does, since a ban would fail the same way.
   *
   * Anything else — a dead socket, a gateway HTML page, a JSON parse failure —
   * is NOT an answer, and swallowing it is not safe. scheduler.py's noon sweep
   * only removes rows whose status is CANCELLED; it does NOT back-stop a
   * PARTIAL cancellation, where one of several subscriptions ended and the
   * person stays ACTIVE while losing a single market's group. That is exactly
   * the case this module exists to handle, so for that person nothing else ever
   * runs. Rethrow, and let the per-group catch record a real failure.
   */
  private async getMember(
    chatId: number,
    userId: string
  ): Promise<ChatMemberResult | null> {
    try {
      const result = await this.call<ChatMemberResult>("getChatMember", {
        chat_id: chatId,
        user_id: userId,
      });
      // `ok: true` with no result at all is not an answer about anybody.
      return result ?? null;
    } catch (err) {
      if (err instanceof TelegramApiError) return null;
      throw err;
    }
  }

  /**
   * Every error raised here is destined for an admin ping, so it must never
   * carry the bot token — the URL is the only place the token appears and it is
   * deliberately kept out of the messages below.
   */
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

    // Read as text and parse by hand. res.json() on a Telegram 502 or a gateway
    // HTML page throws a SyntaxError whose message quotes the raw markup —
    // which then lands in an HTML-formatted admin ping and destroys the alert.
    const text = await res.text();
    let body: { ok?: boolean; result?: T; description?: string };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(
        `Telegram ${method} returned a non-JSON body (HTTP ${res.status}): ${bodyExcerpt(text)}`
      );
    }

    if (!body.ok) {
      // Include the status even when a description exists — a 429 and a 400
      // want very different responses from whoever reads the ping.
      const detail = body.description
        ? `${bodyExcerpt(body.description)} (HTTP ${res.status})`
        : `failed (HTTP ${res.status})`;
      throw new TelegramApiError(`Telegram ${method} ${detail}`, method, res.status);
    }
    return body.result as T;
  }
}
