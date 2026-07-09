// =============================================================================
// TELEGRAM REMINDER BOT WEBHOOK
// =============================================================================
// Webhook for @RobinHoReminderBot — the refresher-seminar reminder list.
//
// Flow: the Google Form confirmation screen shows a deep link like
// t.me/RobinHoReminderBot?start=25jul. Tapping it opens the bot; tapping
// Start sends "/start 25jul" here. We record the chat in the Refresher
// Reminder List sheet and reply with a confirmation the registrant keeps in
// their chat history (their proof of registration).
//
// Reminder sends are NOT done here — they run from Joseph's machine against
// the sheet. This endpoint only captures sign-ups and replies.
//
// Security: Telegram echoes back the secret_token we registered via
// setWebhook in the X-Telegram-Bot-Api-Secret-Token header. Reject anything
// without it. We always return 200 on handled updates (Telegram retries on
// errors, and a retry storm can't fix a bad update); failures alert Joseph
// via the admin bot instead.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { google } from "googleapis";
import { notifyAdmin } from "../lib/telegram.js";

const TELEGRAM_API = "https://api.telegram.org";

// The Refresher Reminder List spreadsheet (My Drive → RHO Navigator →
// Ex Students). Not a secret — the service account must be shared on it.
const REMINDER_SHEET_ID = "18umayVt3SWw__tKUbN0Tq8Mlboq-LmEcQMoqzxaLZuU";
const REMINDER_SHEET_TAB = "Sheet1";

// Deep-link payload → how the session is named in the confirmation message.
// Add a line per session, and use the payload in that session's form link:
// t.me/RobinHoReminderBot?start=<payload>
const SESSION_LABELS: Record<string, string> = {
  "25jul": "25 July refresher session",
};
const FALLBACK_LABEL = "upcoming refresher session";

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
  };
}

function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// "9 July 2026 14:05" Singapore time — matches the main sheet's date style.
function nowSgt(): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(" at ", " ")
    .replace(",", "");
}

async function sendReply(chatId: number, text: string): Promise<void> {
  const token = process.env.REMINDER_BOT_TOKEN!;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Reminder bot sendMessage ${res.status}: ${body}`);
  }
}

// Returns true if this chat is already on the list for this session.
async function alreadySignedUp(
  chatId: number,
  session: string
): Promise<boolean> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REMINDER_SHEET_ID,
    range: `${REMINDER_SHEET_TAB}!B2:E`,
  });
  const rows = (res.data.values ?? []) as string[][];
  return rows.some(
    (r) => (r[0] ?? "") === String(chatId) && (r[3] ?? "") === session
  );
}

async function appendSignup(
  chatId: number,
  username: string,
  name: string,
  session: string
): Promise<void> {
  const sheets = getSheets();
  // Plain append is safe here: this tab has no trailing data-validation and
  // nothing else writes to it (see the appendNewSubscriber note in sheets.ts
  // for why the Subscribers tab can't use append).
  // RAW, not USER_ENTERED: Sheets would otherwise parse a session code like
  // "25jul" as a date, and the stored value would no longer equal the payload
  // string the dedup check compares against.
  await sheets.spreadsheets.values.append({
    spreadsheetId: REMINDER_SHEET_ID,
    range: `${REMINDER_SHEET_TAB}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[nowSgt(), String(chatId), username, name, session, ""]],
    },
  });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Only Telegram knows this token — it was registered via setWebhook.
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.REMINDER_WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const update = req.body as TelegramUpdate;
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = message?.text ?? "";

  // Not a private text message (channel post, group event, sticker, etc.) —
  // acknowledge and drop.
  if (!message || !chatId || message.chat.type !== "private") {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const startMatch = text.match(/^\/start(?:\s+(\S+))?/);
    if (startMatch) {
      const payload = (startMatch[1] ?? "").toLowerCase();
      const label = SESSION_LABELS[payload] ?? FALLBACK_LABEL;
      const from = message.from;
      const name = [from?.first_name, from?.last_name]
        .filter(Boolean)
        .join(" ");
      const username = from?.username ? `@${from.username}` : "";
      const session = payload || "unknown";

      const duplicate = await alreadySignedUp(chatId, session);
      if (!duplicate) {
        await appendSignup(chatId, username, name, session);
      }

      await sendReply(
        chatId,
        `Got it! I'll remind you about the ${label} here — a few days before, and again on the morning itself. See you there!`
      );
    } else {
      // Anything else typed at the bot (hello, questions, etc.)
      await sendReply(
        chatId,
        `Hi! This bot only sends session reminders, so I can't answer questions. ` +
          `If you've filled in the sign-up form and pressed Start here, you're on the list. ` +
          `For anything else, drop a message in the Telegram group.`
      );
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("Reminder webhook error:", detail);
    // Alert Joseph through the admin bot, but still return 200 — a Telegram
    // retry would hit the same failure and can double-write the sheet.
    await notifyAdmin(
      `<b>Reminder Bot Error</b>\nChat: ${chatId}\nText: ${text}\nError: ${detail}`
    ).catch((e) => console.error("Failed to alert admin:", e));
    res.status(200).json({ ok: true });
  }
}
