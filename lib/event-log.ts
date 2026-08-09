// =============================================================================
// EVENT LOG
// =============================================================================
// Append-only history of subscription lifecycle events — the "Status Log" tab
// in the subscriber spreadsheet. The master Subscribers tab updates rows in
// place, so it forgets history (start date resets on renewal, a returning
// customer's reactivation overwrites their churn record). This log is the
// permanent record: one row per lifecycle event, never edited, never deleted.
// It's what makes renewal-rate, churn-cohort, and cancel-then-undo analysis a
// filter on a tab instead of a Stripe reconstruction job.
//
// The lifecycle records entries through the `EventLog` interface (its fourth
// collaborator); `SheetsEventLog` is the production implementation. Log writes
// run inside `runSideEffects`, so a failed append alerts Joseph but never
// fails the webhook — the log is derived data, the sheet write is the truth.
// =============================================================================

import { appendEventLogRow, eventLogHasRow } from "./sheets.js";

export interface EventLogEntry {
  email: string;
  stripeSubscriptionId: string;
  action: string;
  plan?: string;
  previousPlan?: string;
  price?: number;
  coupon?: boolean;
  detail?: string;
}

export interface EventLog {
  record(entry: EventLogEntry): Promise<void>;
  /**
   * Has a row with this subscription ID + action already been recorded?
   * The dedup check behind the deferred trial welcome: the log is the one
   * place every welcome sender (webhook TRIAL_CONVERTED, deferred RENEWED
   * path, the manual send-missed-trial-welcomes script) leaves a record, so
   * it is what makes "send at most one welcome" hold across all of them.
   */
  hasRecorded(stripeSubscriptionId: string, action: string): Promise<boolean>;
}

/**
 * Format an instant as "2026-07-09 14:32:05" in Singapore time — sortable as
 * text and parseable by Sheets as a real datetime. Deliberately different from
 * `formatDisplayDateSGT` (the human-facing "9 July 2026 18:00"): log rows are
 * for filtering and pivoting, not for emails.
 */
export function formatLogTimestampSGT(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

// The 9-column Status Log row:
// A Timestamp · B Email · C Stripe Sub ID · D Action · E Plan ·
// F Previous Plan · G Price · H Coupon · I Detail
export function entryToRow(
  timestamp: string,
  entry: EventLogEntry
): (string | number)[] {
  return [
    timestamp,
    entry.email,
    entry.stripeSubscriptionId,
    entry.action,
    entry.plan ?? "",
    entry.previousPlan ?? "",
    entry.price ?? "",
    entry.coupon === undefined ? "" : entry.coupon ? "TRUE" : "FALSE",
    entry.detail ?? "",
  ];
}

export class SheetsEventLog implements EventLog {
  async record(entry: EventLogEntry): Promise<void> {
    await appendEventLogRow(entryToRow(formatLogTimestampSGT(new Date()), entry));
  }
  async hasRecorded(stripeSubscriptionId: string, action: string): Promise<boolean> {
    return eventLogHasRow(stripeSubscriptionId, action);
  }
}
