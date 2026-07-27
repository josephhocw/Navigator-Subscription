// =============================================================================
// COMP EXPIRY
// =============================================================================
// Complimentary access (e.g. the TCM course's 2-month ALL_MARKETS grant) is
// modelled as an ordinary subscriber row with a FIXED expiry date and a BLANK
// Stripe Subscription ID (col O) — the blank ID is what marks it as a comp
// rather than a paid subscription.
//
// Nothing else in the system acts on the expiry date on its own; access is only
// ever revoked when Status becomes CANCELLED. This module is the daily pass
// that closes that loop: it flips any comp whose expiry has passed to CANCELLED.
// After that, the two existing systems do the rest with no further changes —
// the TradingView reconcile removes the script grant, and the Telegram bot's
// daily kicker removes the person from the groups they're no longer entitled to
// (a still-active paid sub on another row keeps whatever it covers).
//
// It runs as the first step of the daily TradingView reconcile cron, so the
// SAME run that cancels the comp also removes the TradingView access.
//
// Everything here is Singapore time (GMT+8). Expiry strings are stored in the
// sheet as "14 September 2026 23:59" (see format-date.ts); parseDisplayDateSGT
// is the inverse of that formatter and treats the wall-clock as SGT.
// =============================================================================

import type { Subscriber, SubscriberStore } from "./subscriber-store.js";
import type { EventLog } from "./event-log.js";

// Same rule as the TradingView reconcile and the Telegram bot: a subscriber is
// entitled until they're CANCELLED. Only these statuses are candidates to
// expire; a row already CANCELLED is left alone.
const ENTITLED_STATUSES = new Set([
  "ACTIVE",
  "PAYMENT_FAILED",
  "CANCELLATION_SCHEDULED",
]);

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Parse a display date string ("14 September 2026 23:59") as Singapore time and
 * return the absolute instant. Returns null on anything that doesn't match the
 * exact format the system writes — a malformed expiry must never be treated as
 * "in the past" and silently revoke access.
 *
 * Singapore has no daylight saving and a fixed +08:00 offset, so the UTC
 * instant is simply the wall-clock minus 8 hours.
 */
export function parseDisplayDateSGT(display: string | undefined | null): Date | null {
  if (!display) return null;
  const m = display.trim().match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})$/
  );
  if (!m) return null;
  const day = Number(m[1]);
  const monthIndex = MONTHS.indexOf(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (monthIndex < 0) return null;
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  // SGT (UTC+8) → subtract 8h for the UTC instant. Date.UTC normalises any
  // day/hour rollover (e.g. 00:00 SGT becomes the previous day 16:00 UTC).
  const ms = Date.UTC(year, monthIndex, day, hour - 8, minute);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** A comp is a row with no Stripe subscription ID — never a paid subscriber. */
export function isComp(sub: Subscriber): boolean {
  return !sub.stripeSubscriptionId?.trim();
}

/**
 * The comps whose fixed expiry has passed, relative to `now`. Pure — no I/O.
 *
 * A paid subscriber (has a Stripe sub ID) is never returned even if their
 * period-end date is in the past: paid subs renew, and access is governed by
 * CANCELLED, not by the date. Only genuine comps are time-boxed here.
 */
export function findExpiredComps(subscribers: Subscriber[], now: Date): Subscriber[] {
  return subscribers.filter((s) => {
    if (!isComp(s)) return false;
    if (!ENTITLED_STATUSES.has(s.status)) return false;
    if (!s.currentPlan?.trim()) return false; // guard against blank/junk rows
    const expiry = parseDisplayDateSGT(s.subscriptionExpiry);
    return expiry !== null && expiry.getTime() < now.getTime();
  });
}

export interface ExpiredComp {
  email: string;
  tradingViewUsername: string;
  plan: string;
  expiry: string; // the stored SGT display string, for the admin ping
}

export interface ExpireCompsResult {
  expired: ExpiredComp[];
  failures: string[]; // "email/plan: message" for any row whose flip failed
}

/**
 * Flip every due comp to CANCELLED (Latest Action = COMP_EXPIRED) and log it.
 * Returns what was expired so the caller can ping Joseph and then run the
 * TradingView reconcile, which will now see CANCELLED rows and remove access.
 *
 * A single row's failure is collected, not thrown, so one bad write doesn't
 * abort the sweep — mirrors the reconcile's own failure handling.
 */
export async function expireDueComps(
  store: SubscriberStore,
  now: Date,
  eventLog?: EventLog
): Promise<ExpireCompsResult> {
  const subscribers = await store.listAll();
  const due = findExpiredComps(subscribers, now);

  const expired: ExpiredComp[] = [];
  const failures: string[] = [];

  for (const sub of due) {
    try {
      await store.applyUpdate(sub, {
        status: "CANCELLED",
        latestAction: "COMP_EXPIRED",
      });
      if (eventLog) {
        // The log is derived data — a failed append must not fail the expiry.
        await eventLog
          .record({
            email: sub.email,
            stripeSubscriptionId: "",
            action: "COMP_EXPIRED",
            plan: sub.currentPlan,
            detail: `Comp expired ${sub.subscriptionExpiry} — access being removed`,
          })
          .catch(() => {});
      }
      expired.push({
        email: sub.email,
        tradingViewUsername: sub.tradingViewUsername,
        plan: sub.currentPlan,
        expiry: sub.subscriptionExpiry,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${sub.email}/${sub.currentPlan}: ${message}`);
    }
  }

  return { expired, failures };
}
