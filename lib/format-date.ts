// =============================================================================
// DATE FORMATTING
// =============================================================================
// The whole system uses one date format for human eyes:
//   "16 April 2026 18:00"  (Singapore time, GMT+8, 24-hour clock)
//
// That string shows up in:
//   - the Google Sheet (the subscription start, expiry, last payment columns)
//   - the admin Telegram pings
//   - customer-facing emails (next billing date, access end date)
//
// Keeping one helper in one file means changing the format in the future
// (say, to add the day of the week) is a one-line edit.
// =============================================================================

/**
 * Format a `Date` as "16 April 2026 18:00" in Singapore time.
 *
 * Uses Intl.DateTimeFormat with the "Asia/Singapore" timezone — so this works
 * the same way whether the code runs on a Vercel server in Singapore, the US,
 * or Europe. The input Date is interpreted as a point in time; the timezone
 * setting decides how to display it.
 */
export function formatDisplayDateSGT(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // formatToParts returns an array like [{type:"day",value:"16"}, ...]. We
  // pull each piece out by name and stitch them together in the exact order
  // we want — that's how we control the layout independent of locale quirks.
  const parts = formatter.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")}`;
}
