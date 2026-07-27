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
import { SheetsEventLog } from "../lib/event-log.js";
import { TradingViewAccessClient } from "../lib/tradingview-access.js";
import { reconcileTradingView } from "../lib/tradingview-reconcile.js";
import { expireDueComps } from "../lib/comp-expiry.js";
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

    // Step 1: expire any comps past their fixed date FIRST — flip them to
    // CANCELLED — so the reconcile below sees them as no longer entitled and
    // removes their script access in the same run. Uses the server clock (UTC)
    // vs. the sheet's SGT expiry, both handled as absolute instants.
    const eventLog = new SheetsEventLog();
    const compExpiry = await expireDueComps(store, new Date(), eventLog);

    // Step 2: reconcile TradingView grants against the (now-updated) sheet.
    const summary = await reconcileTradingView(store, tv);

    // Ping Joseph only when something happened, something needs attention, or
    // something failed — a clean no-op day stays quiet. An expired comp always
    // produces a removal, so this fires and the removal shows in "Removed".
    if (
      summary.granted ||
      summary.removed ||
      summary.uncertain.length ||
      summary.failures.length ||
      compExpiry.expired.length ||
      compExpiry.failures.length
    ) {
      const expiredLine = compExpiry.expired
        .map((c) => `@${c.tradingViewUsername} → ${c.plan} (expired ${c.expiry})`)
        .join("\n");
      await notifyAdmin(
        [
          `<b>🔁 TradingView reconcile</b>`,
          ``,
          compExpiry.expired.length
            ? `<b>⏰ Comps expired (${compExpiry.expired.length}) — access being removed:</b>\n${expiredLine}`
            : null,
          `<b>Granted (${summary.granted}):</b> ${summary.grantedList.join(", ") || "—"}`,
          `<b>Removed (${summary.removed}):</b> ${summary.removedList.join(", ") || "—"}`,
          summary.uncertain.length
            ? `<b>⚠️ Unrecognised plan (left alone — fix the sheet):</b>\n${summary.uncertain.join(", ")}`
            : null,
          compExpiry.failures.length
            ? `<b>⚠️ Comp-expiry write failures (${compExpiry.failures.length}):</b>\n${compExpiry.failures.join("\n")}`
            : null,
          summary.failures.length
            ? `<b>Failures (${summary.failures.length}):</b>\n${summary.failures.join("\n")}\n\n<i>"username not found" = bad TradingView username in the sheet. Auth errors = refresh the session cookie.</i>`
            : `<i>No failures.</i>`,
        ]
          .filter(Boolean)
          .join("\n")
      ).catch(() => {});
    }

    res.status(200).json({ ok: true, compExpiry, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("TradingView reconcile failed:", message);
    await notifyAdmin(
      `<b>❌ TradingView reconcile failed</b>\n${message}\n\n<i>Likely a dead session cookie — refresh TRADINGVIEW_SESSIONID / _SIGN.</i>`
    ).catch(() => {});
    res.status(500).json({ error: message });
  }
}
