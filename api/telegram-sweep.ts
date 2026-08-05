// =============================================================================
// TELEGRAM SWEEP (Vercel Cron)
// =============================================================================
// Daily safety net replacing scheduler.py — see lib/telegram-sweep.ts.
// Trigger: vercel.json cron, 0 4 * * * UTC = 12:00 PM SGT (Hobby crons can
// fire up to ~1h late; fine for a backstop). Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`.
// Dry-run: TELEGRAM_SWEEP_DRY_RUN (fail-safe — only the literal "false" kicks).
//
// maxDuration is pinned to 300s in vercel.json; the sweep's in-code budget is
// 240s, leaving 60s of headroom so Vercel never hard-kills mid-user (a kill
// between ban and unban would strand a permanent ban with no record).
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { SheetsEventLog } from "../lib/event-log.js";
import { notifyAdmin } from "../lib/telegram.js";
import {
  TelegramGroupApi,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  flagIsDryRun,
} from "../lib/telegram-groups.js";
import { runTelegramSweep } from "../lib/telegram-sweep.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groups = loadGroupsFromEnv();
  if (!token || groups.length === 0) {
    await notifyAdmin(
      "<b>⚠️ Telegram sweep skipped</b>\nTELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_* not set."
    ).catch(() => {});
    res.status(200).json({ skipped: "not configured" });
    return;
  }

  try {
    const store = new SheetsSubscriberStore();
    const eventLog = new SheetsEventLog();
    const remover = new TelegramGroupApi({
      token,
      groups,
      whitelist: loadWhitelistFromEnv(),
      dryRun: flagIsDryRun("TELEGRAM_SWEEP_DRY_RUN"),
    });

    const summary = await runTelegramSweep({
      listAll: () => store.listAll(),
      remover,
      notify: notifyAdmin,
      recordLog: (e) => eventLog.record(e),
    });

    res.status(200).json(summary);
  } catch (err) {
    console.error("telegram-sweep failed:", err);
    await notifyAdmin(
      `<b>❌ Telegram sweep FAILED</b>\n${err instanceof Error ? err.message : String(err)}`
    ).catch(() => {});
    res.status(500).json({ error: "sweep failed" });
  }
}
