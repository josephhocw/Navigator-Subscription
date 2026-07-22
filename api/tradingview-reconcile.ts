// =============================================================================
// TRADINGVIEW RECONCILE (Vercel Cron)
// =============================================================================
// Daily safety net for the inline webhook automation. Reads the subscriber
// sheet and the current grantees on all 8 scripts, then re-grants anyone
// entitled-but-missing and removes anyone in the sheet who shouldn't have
// access (cancelled, or a stale grant from an old plan). Never touches a
// username that isn't in the sheet — comps are safe by construction.
//
// Trigger: a daily cron entry in vercel.json. Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`. If the TradingView cookies aren't
// configured, it no-ops with an admin ping rather than erroring.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { TradingViewAccessClient } from "../lib/tradingview-access.js";
import { reconcileTradingView } from "../lib/tradingview-reconcile.js";
import { notifyAdmin } from "../lib/telegram.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const sessionId = process.env.TRADINGVIEW_SESSIONID;
  const sessionIdSign = process.env.TRADINGVIEW_SESSIONID_SIGN;
  if (!sessionId || !sessionIdSign) {
    await notifyAdmin(
      "<b>⚠️ TradingView reconcile skipped</b>\nTRADINGVIEW_SESSIONID / _SIGN not set — access is on manual fallback."
    ).catch(() => {});
    res.status(200).json({ skipped: "not configured" });
    return;
  }

  try {
    const store = new SheetsSubscriberStore();
    const tv = new TradingViewAccessClient({ sessionId, sessionIdSign });
    const summary = await reconcileTradingView(store, tv);

    // Ping Joseph only when something happened, something needs attention, or
    // something failed — a clean no-op day stays quiet.
    if (
      summary.granted ||
      summary.removed ||
      summary.uncertain.length ||
      summary.failures.length
    ) {
      await notifyAdmin(
        [
          `<b>🔁 TradingView reconcile</b>`,
          ``,
          `<b>Granted (${summary.granted}):</b> ${summary.grantedList.join(", ") || "—"}`,
          `<b>Removed (${summary.removed}):</b> ${summary.removedList.join(", ") || "—"}`,
          summary.uncertain.length
            ? `<b>⚠️ Unrecognised plan (left alone — fix the sheet):</b>\n${summary.uncertain.join(", ")}`
            : null,
          summary.failures.length
            ? `<b>Failures (${summary.failures.length}):</b>\n${summary.failures.join("\n")}\n\n<i>"username not found" = bad TradingView username in the sheet. Auth errors = refresh the session cookie.</i>`
            : `<i>No failures.</i>`,
        ]
          .filter(Boolean)
          .join("\n")
      ).catch(() => {});
    }

    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("TradingView reconcile failed:", message);
    await notifyAdmin(
      `<b>❌ TradingView reconcile failed</b>\n${message}\n\n<i>Likely a dead session cookie — refresh TRADINGVIEW_SESSIONID / _SIGN.</i>`
    ).catch(() => {});
    res.status(500).json({ error: message });
  }
}
