// =============================================================================
// REFRESHER REMINDER SENDER (Vercel Cron)
// =============================================================================
// Sends the scheduled refresher-session reminders from @RobinHoReminderBot to
// everyone on the Refresher Reminder List sheet. Companion to
// api/telegram-reminder.ts, which captures the sign-ups.
//
// Trigger: two cron entries in vercel.json (22 July 11:00 UTC = 7pm SGT, and
// 25 July 00:30 UTC = 8:30am SGT). The cron expressions repeat yearly, so the
// handler guards on the FULL date (year included) — a firing in any other year
// is a no-op. Remove the cron entries after the session anyway.
//
// Which message goes out is decided by today's SGT date, not by the request,
// so a duplicate or late cron firing can't send the wrong message. A `phase`
// query param can force a specific message for manual sends/testing.
//
// Idempotent: column F ("Reminded") records each phase per row; rows already
// marked for today's phase are skipped, so re-running never double-sends.
//
// Auth: Vercel sends `Authorization: Bearer $CRON_SECRET` on cron requests
// when the CRON_SECRET env var is set. Manual triggers pass the same header.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { google } from "googleapis";
import { notifyAdmin } from "../lib/telegram.js";

const TELEGRAM_API = "https://api.telegram.org";

const REMINDER_SHEET_ID = "18umayVt3SWw__tKUbN0Tq8Mlboq-LmEcQMoqzxaLZuU";
const REMINDER_SHEET_TAB = "Sheet1";

const SESSION = "25jul";

const MESSAGES: Record<string, { onDate: string; text: string }> = {
  "3day": {
    onDate: "2026-07-22",
    text:
      `Hi! Just a reminder that you're signed up for Robin's refresher session <b>this Saturday</b>\n\n` +
      `<b>Date</b>: 25 July\n` +
      `<b>Time</b>: 2pm to 5pm\n` +
      `<b>Venue</b>: 250 North Bridge Road, #06-00 Raffles City Tower, S179101`,
  },
  morning: {
    onDate: "2026-07-25",
    text:
      `Good morning! Robin's refresher session is <b>this afternoon</b>\n\n` +
      `<b>Time</b>: 2pm to 5pm\n` +
      `<b>Venue</b>: 250 North Bridge Road, #06-00 Raffles City Tower, S179101\n\n` +
      `See you soon! ☺️`,
  },
};

function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// Today as "YYYY-MM-DD" in Singapore time.
function todaySgt(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.REMINDER_BOT_TOKEN!;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendMessage ${res.status}: ${body}`);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Normal cron path: pick the phase whose date is today. Manual override via
  // ?phase=3day / ?phase=morning for testing or a make-up send.
  const forced = typeof req.query.phase === "string" ? req.query.phase : "";
  const today = todaySgt();
  const phase =
    forced ||
    Object.keys(MESSAGES).find((k) => MESSAGES[k].onDate === today) ||
    "";

  if (!MESSAGES[phase]) {
    res.status(200).json({ sent: 0, skipped: "no reminder scheduled today" });
    return;
  }

  try {
    const sheets = getSheets();
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: REMINDER_SHEET_ID,
      range: `${REMINDER_SHEET_TAB}!A2:F`,
    });
    const rows = (read.data.values ?? []) as string[][];

    let sent = 0;
    const failed: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const chatId = (rows[i][1] ?? "").trim();
      const session = (rows[i][4] ?? "").trim();
      const reminded = (rows[i][5] ?? "").trim();
      if (!chatId || session !== SESSION) continue;
      if (reminded.includes(phase)) continue; // already sent this phase

      try {
        await sendTelegram(chatId, MESSAGES[phase].text);
        sent++;
        const marker = reminded ? `${reminded}, ${phase}` : phase;
        await sheets.spreadsheets.values.update({
          spreadsheetId: REMINDER_SHEET_ID,
          range: `${REMINDER_SHEET_TAB}!F${i + 2}`,
          valueInputOption: "RAW",
          requestBody: { values: [[marker]] },
        });
      } catch (err) {
        failed.push(
          `${chatId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const summary =
      `<b>Refresher Reminder Sent</b> (${phase})\n` +
      `Delivered: ${sent}\n` +
      (failed.length ? `Failed: ${failed.length}\n${failed.join("\n")}` : "Failed: 0");
    await notifyAdmin(summary).catch((e) =>
      console.error("Failed to send admin summary:", e)
    );

    res.status(200).json({ phase, sent, failed });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("Reminder send error:", detail);
    await notifyAdmin(
      `<b>Refresher Reminder FAILED</b> (${phase})\nError: ${detail}`
    ).catch((e) => console.error("Failed to alert admin:", e));
    res.status(500).json({ error: detail });
  }
}
