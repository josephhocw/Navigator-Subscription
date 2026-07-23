// =============================================================================
// ONBOARDING FOLLOW-UP SEND (Vercel Cron)
// =============================================================================
// Daily job that sends the day-3 "getting started" email (Pepperstone + free
// TradingView + trading basics) to each brand-new subscriber, exactly once.
// The selection rules and once-only guarantee live in lib/followup.ts.
//
// Trigger: a daily cron entry in vercel.json. Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`. A clean run (nobody due) stays quiet;
// sends or failures ping Joseph.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { runFollowupSend, type FollowupMailer } from "../lib/followup.js";
import { sendFollowupEmail } from "../lib/email.js";
import { notifyAdmin } from "../lib/telegram.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const mailer: FollowupMailer = {
    sendFollowup: (data) => sendFollowupEmail(data),
  };

  try {
    const store = new SheetsSubscriberStore();
    const summary = await runFollowupSend(store, mailer, new Date());

    if (summary.sent || summary.failures.length) {
      await notifyAdmin(
        [
          `<b>✉️ Onboarding follow-up</b>`,
          ``,
          `<b>Sent (${summary.sent}):</b> ${summary.sentList.join(", ") || "—"}`,
          summary.failures.length
            ? `<b>Failures (${summary.failures.length}):</b>\n${summary.failures.join("\n")}`
            : `<i>No failures.</i>`,
        ].join("\n")
      ).catch(() => {});
    }

    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Follow-up send failed:", message);
    await notifyAdmin(
      `<b>❌ Onboarding follow-up failed</b>\n${message}`
    ).catch(() => {});
    res.status(500).json({ error: message });
  }
}
