// =============================================================================
// TELEGRAM WEBHOOK (join guard endpoint)
// =============================================================================
// Registered with Telegram via setWebhook (see docs/runbooks/
// telegram-migration-cutover.md) with allowed_updates=["chat_member"] and a
// secret_token. Telegram POSTs every chat_member change in the five groups
// here; lib/telegram-join.ts decides and acts.
//
// ALWAYS returns 200 once the secret check passes — a non-2xx makes Telegram
// retry the update, and a replayed join could double-kick. Errors are logged
// and pinged instead.
//
// Worst-case serial IO must stay under this function's maxDuration (pinned to
// 60s in vercel.json); IO_TIMEOUT_MS=8s per call keeps it well inside that.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { updateRowFields } from "../lib/sheets.js";
import { notifyAdmin } from "../lib/telegram.js";
import {
  TelegramGroupApi,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  flagIsDryRun,
  type GroupConfig,
} from "../lib/telegram-groups.js";
import {
  handleChatMemberUpdate,
  type JoinGuardDeps,
  type TelegramChatMemberEvent,
} from "../lib/telegram-join.js";

/** A hung Sheets or Telegram socket must not hang the function: Telegram
 *  redelivers on timeout, and a replayed kick is a harmless no-op. A listAll
 *  timeout surfaces as the join guard's fail-open path, which is correct. */
const IO_TIMEOUT_MS = 8_000;

function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${IO_TIMEOUT_MS}ms`)),
      IO_TIMEOUT_MS
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Misconfiguration guard: two env vars pointing at the same chat would make
 *  group resolution silently pick the first. Say it out loud — once per
 *  instance, not per request (env doesn't change within an instance). */
let warnedDuplicateChatIds = false;

function warnOnDuplicateChatIds(groups: GroupConfig[]): void {
  if (warnedDuplicateChatIds) return;
  warnedDuplicateChatIds = true;
  const seen = new Map<number, string>();
  for (const g of groups) {
    const prev = seen.get(g.chatId);
    if (prev) {
      console.warn(
        `telegram-webhook: ${g.key} and ${prev} share chat ID ${g.chatId} — check TELEGRAM_CHAT_* env vars`
      );
    } else {
      seen.set(g.chatId, g.key);
    }
  }
}

function buildDeps(): JoinGuardDeps | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groups = loadGroupsFromEnv();
  if (!token || groups.length === 0) {
    console.warn(
      "telegram-webhook: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_* not set — ignoring update"
    );
    return null;
  }
  warnOnDuplicateChatIds(groups);
  const whitelist = loadWhitelistFromEnv();
  const api = new TelegramGroupApi({
    token,
    groups,
    whitelist,
    // The join guard owns its own dry-run gate (deps.dryRun below); this
    // instance is only used for kickFromChat, which ignores the flag anyway.
    dryRun: false,
  });
  const store = new SheetsSubscriberStore();
  return {
    groups,
    whitelist,
    dryRun: flagIsDryRun("TELEGRAM_JOIN_DRY_RUN"),
    listAll: () => withTimeout("listAll", store.listAll()),
    writeUserId: (rowIndex, userId) =>
      withTimeout(
        "writeUserId",
        updateRowFields(rowIndex, { telegramUserId: userId })
      ),
    kick: (chatId, userId) => withTimeout("kick", api.kickFromChat(chatId, userId)),
    notify: (m) => withTimeout("notify", notifyAdmin(m)),
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Reject anything that didn't come from Telegram. setWebhook registers this
  // secret; Telegram echoes it on every delivery. No secret configured = the
  // endpoint is dead, deliberately.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    console.warn("telegram-webhook: bad or missing secret token header");
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const update = req.body as {
      update_id?: number;
      chat_member?: TelegramChatMemberEvent;
    };
    if (update?.chat_member) {
      const deps = buildDeps();
      if (deps) {
        const summary = await handleChatMemberUpdate(update.chat_member, deps);
        console.log(`telegram-webhook [update ${update.update_id ?? "?"}]: ${summary}`);
      }
    } else {
      console.log("telegram-webhook: non-chat_member update ignored");
    }
  } catch (err) {
    // Never bubble to a non-2xx — log, and let the sweep self-heal.
    console.error("telegram-webhook error:", err);
  }
  res.status(200).json({ ok: true });
}
