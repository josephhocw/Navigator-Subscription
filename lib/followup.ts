// =============================================================================
// ONBOARDING FOLLOW-UP SEND
// =============================================================================
// The T+1 "getting started" email (Pepperstone + free TradingView + trading
// basics), sent once per new subscriber the evening after they sign up
// (20:00 SGT, via a daily Vercel Cron — evening because the audience works
// during the day and can't place trades until they're home). Mirrors the
// TradingView reconcile shape: a pure selector (unit-testable, no I/O) plus a
// thin runner that sends and records.
//
// Why a cron and not the webhook: the webhook fires at checkout, but this email
// should land the next evening, after the access steps have been done. A daily
// 8pm job scanning the sheet for "signed up on an earlier day" is the
// no-new-vendor way to schedule it.
//
// Sending EXACTLY ONCE, and never to the wrong people, rests on three gates:
//   1. status === ACTIVE or TRIAL_ACTIVE — skip payment-failed / cancelled /
//                                     trial-cancelled / etc. Trialists keep
//                                     getting the T+1 follow-up (owner's
//                                     decision 2026-08-05).
//   2. subscriptionCount === 1      — brand-new only; a renewal (count ≥ 2)
//                                     refreshes Subscription Start, so this
//                                     gate is what stops a 3-months-later renewal
//                                     from re-entering the date window.
//   3. col U (followupSent) blank   — the durable "already sent" marker, written
//                                     after a successful send and never cleared.
// Plus a 1–14 SGT-calendar-day window on Subscription Start (normally T+1 — the
// next morning — with the upper bound only there to still catch a cohort if a
// cron day is missed), and a go-live FLOOR (FOLLOWUP_NOT_BEFORE): nobody who
// subscribed before the feature went live is ever emailed. Together that makes
// this "new sign-ups only" — the back catalogue, and even the sign-ups from the
// days just before launch, are never touched.
// =============================================================================

import type { Subscriber, SubscriberStore } from "./subscriber-store.js";
import { formatDisplayDateSGT } from "./format-date.js";

// Window in whole Singapore calendar days between sign-up and the cron run.
export const FOLLOWUP_MIN_DAYS = 1; // T+1: the evening after sign-up
export const FOLLOWUP_MAX_DAYS = 14;

// Go-live floor: only subscribers whose Subscription Start is on or after this
// instant are ever eligible. Set to the launch date (2026-07-23 SGT) so the
// follow-up reaches sign-ups from launch onward only — never anyone who was
// already a subscriber when it shipped.
export const FOLLOWUP_NOT_BEFORE = new Date("2026-07-23T00:00:00+08:00");

export interface FollowupMailer {
  sendFollowup(data: { email: string; name: string }): Promise<void>;
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parse the system's display date ("16 April 2026 18:00", Singapore wall time)
 * back into a Date. Returns null on anything that doesn't match — a blank or
 * malformed Subscription Start then simply fails the window and is skipped.
 */
export function parseDisplayDateSGT(value: string): Date | null {
  const m = value.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2].toLowerCase()];
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month === undefined) return null;
  // The string is SGT (UTC+8); convert to the UTC instant.
  const utcMs = Date.UTC(year, month, day, hour - 8, minute);
  return Number.isFinite(utcMs) ? new Date(utcMs) : null;
}

// Singapore-time calendar day number (whole days since the Unix epoch in
// UTC+8). Differencing two of these gives whole SGT days between them, so a
// sign-up today and the next-evening 8pm cron are exactly 1 apart — a clean
// "T+1 day" no matter what wall-clock time either happened at.
function sgtDayNumber(d: Date): number {
  return Math.floor((d.getTime() + 8 * 3_600_000) / 86_400_000);
}

/**
 * Pure selection. Given every sheet row and "now", return the subscribers who
 * should receive the follow-up this run. No I/O — the runner does the sending.
 */
export function selectFollowupRecipients(
  rows: Subscriber[],
  now: Date
): Subscriber[] {
  return rows.filter((r) => {
    if (r.status !== "ACTIVE" && r.status !== "TRIAL_ACTIVE") return false;
    if (r.subscriptionCount !== 1) return false; // brand-new only, not a renewal
    if (r.followupSent.trim() !== "") return false; // already sent
    if (!r.email.trim()) return false;
    const started = parseDisplayDateSGT(r.subscriptionStart);
    if (!started) return false;
    if (started < FOLLOWUP_NOT_BEFORE) return false; // pre-launch → new sign-ups only
    const ageDays = sgtDayNumber(now) - sgtDayNumber(started);
    return ageDays >= FOLLOWUP_MIN_DAYS && ageDays <= FOLLOWUP_MAX_DAYS;
  });
}

export interface FollowupSummary {
  considered: number; // total rows scanned
  eligible: number; // rows selected this run
  sent: number;
  sentList: string[]; // emails successfully sent + marked
  failures: string[]; // "email: reason"
}

/**
 * Fetch rows, select recipients, send each follow-up, then stamp col U. Order
 * is send-then-mark: a marked row is always one that was actually emailed, so a
 * mid-run failure never leaves someone marked-but-unsent. The rare cost is a
 * possible re-send if the col-U write itself fails — surfaced as a failure for
 * the admin ping. Individual failures are collected, not thrown, so one bad row
 * doesn't abort the sweep.
 */
export async function runFollowupSend(
  store: SubscriberStore,
  mailer: FollowupMailer,
  now: Date
): Promise<FollowupSummary> {
  const rows = await store.listAll();
  const recipients = selectFollowupRecipients(rows, now);
  const marker = formatDisplayDateSGT(now);
  const sentList: string[] = [];
  const failures: string[] = [];

  for (const sub of recipients) {
    try {
      await mailer.sendFollowup({
        email: sub.email,
        name: sub.customerName?.trim() || "there",
      });
      await store.applyUpdate(sub, { followupSent: marker });
      sentList.push(sub.email);
    } catch (err) {
      failures.push(`${sub.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    considered: rows.length,
    eligible: recipients.length,
    sent: sentList.length,
    sentList,
    failures,
  };
}
