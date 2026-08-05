// =============================================================================
// TELEGRAM JOIN GUARD — orchestration
// =============================================================================
// Replaces bot.py's on_new_member. api/telegram-webhook.ts receives the raw
// Telegram update, builds JoinGuardDeps from env + real collaborators, and
// hands the chat_member payload here. Everything is injected so tests drive
// this with fakes.
//
// FAIL OPEN: if the sheet is unreachable, the joiner is allowed and Joseph is
// pinged — never kick a paying subscriber because Google hiccuped. The daily
// sweep corrects within a day.
// =============================================================================

import { evaluateJoin, isJoinTransition, type JoinVerdict } from "./telegram-access.js";
import {
  MAIN_MARKET,
  isWhitelisted,
  normaliseTelegramUsername,
  type GroupConfig,
  type KickOutcome,
} from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

/** The slice of a Telegram ChatMemberUpdated payload the guard reads. */
export interface TelegramChatMemberEvent {
  chat: { id: number; title?: string };
  old_chat_member: { status?: string; is_member?: boolean; user?: { id: number; username?: string } };
  new_chat_member: { status?: string; is_member?: boolean; user?: { id: number; username?: string } };
}

export interface JoinGuardDeps {
  groups: GroupConfig[];
  whitelist: Set<string>;
  /** TELEGRAM_JOIN_DRY_RUN — report-only. Col-P writes are also suppressed:
   *  until cutover, bot.py owns col P. */
  dryRun: boolean;
  listAll(): Promise<Subscriber[]>;
  writeUserId(rowIndex: number, userId: string): Promise<void>;
  kick(chatId: number, userId: string): Promise<KickOutcome>;
  notify(message: string): Promise<void>;
}

/** Telegram pings are parse_mode HTML; usernames and error text are untrusted. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Handle one chat_member update. Returns a one-line summary for the console —
 * every update produces a log line, so the dry-run soak has a complete record
 * to diff against bot.py's decisions.
 */
export async function handleChatMemberUpdate(
  ev: TelegramChatMemberEvent,
  deps: JoinGuardDeps
): Promise<string> {
  const group = deps.groups.find((g) => g.chatId === ev.chat.id);
  if (!group) return `ignored: unknown chat ${ev.chat.id}`;

  if (!isJoinTransition(ev.old_chat_member, ev.new_chat_member)) {
    return `ignored: not a join (${group.key})`;
  }

  const user = ev.new_chat_member.user;
  if (!user?.id) return `ignored: join with no user object (${group.key})`;
  const userId = String(user.id);
  const username = user.username ?? "";
  const handle = username ? `@${escapeHtml(username)}` : `(no username, ID ${userId})`;
  const tag = deps.dryRun ? "[DRY RUN] " : "";

  // Sheet-independent verdicts first, mirroring bot.py's ordering. These two
  // inline checks deliberately duplicate evaluateJoin's first two branches
  // (no-username, then whitelist) so those verdicts survive a Sheets outage —
  // a ghost joiner is still kicked and a whitelisted account is still let in
  // even when the sheet can't be read. evaluateJoin stays the single decision
  // authority for every sheet-dependent verdict below.
  let verdict: JoinVerdict | undefined;
  if (!normaliseTelegramUsername(username)) {
    verdict =
      group.market === MAIN_MARKET
        ? { decision: "allow", rowsToUpdate: [], reason: "guest" }
        : { decision: "kick", reason: "no-username" };
  } else if (isWhitelisted(username, deps.whitelist)) {
    verdict = { decision: "allow", rowsToUpdate: [], reason: "whitelisted" };
  }

  if (!verdict) {
    let all: Subscriber[];
    try {
      all = await deps.listAll();
    } catch (err) {
      const detail = escapeHtml(err instanceof Error ? err.message : String(err));
      await deps
        .notify(
          [
            `<b>⚠️ Join guard fail-open — sheet unreachable</b>`,
            `${handle} joined ${group.key} and was ALLOWED without a check.`,
            `<i>${detail}</i>`,
            `<i>If they have a sheet row, the daily sweep corrects this within a day; a non-subscriber must be removed by hand.</i>`,
          ].join("\n")
        )
        .catch(() => {});
      return `${tag}fail-open: allowed ${handle} into ${group.key} (sheet unreachable)`;
    }
    verdict = evaluateJoin(username, group, all, deps.whitelist);
  }

  if (verdict.decision === "kick") {
    if (deps.dryRun) {
      await deps
        .notify(
          [
            `<b>🧪 DRY RUN — join guard would KICK</b>`,
            `${handle} from ${group.key} (${verdict.reason})`,
          ].join("\n")
        )
        .catch(() => {});
      return `${tag}would kick ${handle} from ${group.key} (${verdict.reason})`;
    }
    try {
      const out = await deps.kick(group.chatId, userId);
      if (out.outcome === "still-banned") {
        await deps
          .notify(
            [
              `<b>🚨 STILL BANNED — unban by hand:</b> ${group.key}`,
              `${handle} (user ID ${userId}) was kicked on join but the unban failed — they cannot rejoin even if they subscribe.`,
              `<i>${escapeHtml(out.unbanError)}</i>`,
            ].join("\n")
          )
          .catch(() => {});
      } else {
        await deps
          .notify(`<b>🚫 Join guard kicked</b> ${handle} from ${group.key} (${verdict.reason})`)
          .catch(() => {});
      }
      return `kicked ${handle} from ${group.key} (${verdict.reason})`;
    } catch (err) {
      // kickFromChat redacts the bot token at source before rethrowing a ban
      // failure, so `raw` is safe for the console summary; the ping variant
      // additionally needs HTML-escaping because Telegram parses it as HTML.
      const raw = err instanceof Error ? err.message : String(err);
      const detail = escapeHtml(raw);
      await deps
        .notify(
          [
            `<b>❌ Join guard kick FAILED</b>`,
            `${handle} joined ${group.key} (${verdict.reason}) and could not be removed.`,
            `<i>${detail}</i>`,
            `<i>Remove them by hand, or the daily sweep retries at noon.</i>`,
          ].join("\n")
        )
        .catch(() => {});
      return `kick FAILED for ${handle} in ${group.key}: ${raw}`;
    }
  }

  // Allowed. Write the User ID to every live row so whichever subscription
  // cancels later, the sweep and instant removal can still find the ID (col P).
  let writes = 0;
  if (!deps.dryRun) {
    for (const rowToUpdate of verdict.rowsToUpdate) {
      try {
        await deps.writeUserId(rowToUpdate.rowIndex, userId);
        writes++;
      } catch (err) {
        const detail = escapeHtml(err instanceof Error ? err.message : String(err));
        await deps
          .notify(
            [
              `<b>⚠️ Join guard — col P write failed</b>`,
              `${handle} allowed into ${group.key}, but row ${rowToUpdate.rowIndex} did not get the User ID.`,
              `<i>${detail}</i>`,
            ].join("\n")
          )
          .catch(() => {});
      }
    }
  }

  if (verdict.decision === "allow-unrecognised-plan") {
    await deps
      .notify(
        [
          `<b>⚠️ Join guard allowed — unrecognised plan</b>`,
          `${handle} joined ${group.key}. A live row for them has a plan string we don't recognise, so entitlement can't be checked. They were ALLOWED (fail-safe).`,
          `<i>Fix col F; the daily sweep applies the same guard, so nothing will auto-remove them either.</i>`,
        ].join("\n")
      )
      .catch(() => {});
    return `${tag}allowed ${handle} into ${group.key} (unrecognised plan — flagged)`;
  }

  return `${tag}allowed ${handle} into ${group.key} (${verdict.reason}${writes ? `, col P → ${writes} row(s)` : ""})`;
}
