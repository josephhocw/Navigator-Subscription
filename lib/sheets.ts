import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";

// --- Column layout (matches Stripe Webhook Gameplan) ---
//
// A Email                       I Subscription Price
// B Customer Name               J Coupon Discount      (TRUE if Pepperstone discount is active)
// C TradingView Username        K Subscription Start
// D Telegram Username           L Subscription Expiry
// E Status                      M Subscription Count
// F Current Plan                N Failed Payment Count
// G Latest Action               O Stripe Subscription ID
// H Previous Plan               P Telegram User ID
//
// Q–S are MANUAL columns owned by Joseph, not this code — never write them:
// Q Indicator Invited · R NOTES · S Pepperstone Acc
//
// T Referral Source — partner ref from checkout (?client_reference_id), e.g. "drwealth".
// Written by the webhook on STARTED; next webhook column goes at U onward.
//
// U Onboarding Follow-up Sent — display date the day-3 "getting started" email
// (Pepperstone + free TradingView + trading basics) was sent by the follow-up
// cron. Blank = not yet sent. Written once; never cleared, so it also guards a
// renewal from re-triggering the email.
//
// V Mobile Number — collected by Stripe checkout when the payment link has
// phone_number_collection enabled (the 25 July trial link onward). E.164
// format, e.g. "+6591234567". Blank for subscribers from older links.

// Status (E) values: ACTIVE | PAYMENT_FAILED | CANCELLATION_SCHEDULED | CANCELLED |
// TRIAL_ACTIVE | TRIAL_CANCELLATION_SCHEDULED | TRIAL_CANCELLED.
// Latest Action (G) values: NEW_SUBSCRIPTION | START_TRIAL | RENEWAL | UPGRADED |
// DOWNGRADE_EXECUTED (transient — plan flipped, payment not yet confirmed) |
// DOWNGRADED | PLAN_SWITCH | CANCELLATION_SCHEDULED | DOWNGRADE_SCHEDULED |
// UNDO_CANCELLATION | UNDO_DOWNGRADE | REACTIVATED | COMP_EXPIRED (written by
// lib/comp-expiry.ts) | COMP_GRANTED.

export const COL = {
  email: "A",
  customerName: "B",
  tradingViewUsername: "C",
  telegramUsername: "D",
  status: "E",
  currentPlan: "F",
  latestAction: "G",
  previousPlan: "H",
  subscriptionPrice: "I",
  couponDiscount: "J",
  subscriptionStart: "K",
  subscriptionExpiry: "L",
  subscriptionCount: "M",
  failedPaymentCount: "N",
  stripeSubscriptionId: "O",
  telegramUserId: "P",
  referralSource: "T", // Q/R/S are manual columns — see layout note above
  followupSent: "U", // day-3 onboarding follow-up email marker (webhook/cron-owned)
  mobileNumber: "V", // phone from Stripe checkout (phone_number_collection links)
} as const;

export type ColumnKey = keyof typeof COL;

export interface SheetRow {
  rowIndex: number; // 1-indexed (matches Sheets row numbering)
  email: string;
  customerName: string;
  tradingViewUsername: string;
  telegramUsername: string;
  status: string;
  currentPlan: string;
  latestAction: string;
  previousPlan: string;
  subscriptionPrice: number;
  couponDiscount: boolean;
  subscriptionStart: string;
  subscriptionExpiry: string;
  subscriptionCount: number;
  failedPaymentCount: number;
  stripeSubscriptionId: string;
  telegramUserId: string;
  referralSource: string;
  followupSent: string;
  mobileNumber: string;
}

export interface NewSubscriberRow {
  email: string;
  customerName: string;
  tradingViewUsername: string;
  telegramUsername: string;
  currentPlan: string;
  subscriptionPrice: number;
  couponDiscount: boolean;
  subscriptionStart: string;
  subscriptionExpiry: string;
  stripeSubscriptionId: string;
  referralSource: string;
  mobileNumber?: string; // optional — older callers/links may not collect it
  /**
   * Status (col E) to write; defaults to "ACTIVE". Trials pass "TRIAL_ACTIVE".
   * Deliberately narrow: an appended row can only begin in one of these two
   * states, so a future caller hitting the type error needs a decision, not
   * a workaround.
   */
  status?: "ACTIVE" | "TRIAL_ACTIVE";
  /**
   * Latest Action (col G); defaults to "NEW_SUBSCRIPTION". Trials pass
   * "START_TRIAL". Deliberately narrow: an appended row can only begin in
   * one of these two states, so a future caller hitting the type error
   * needs a decision, not a workaround.
   */
  latestAction?: "NEW_SUBSCRIPTION" | "START_TRIAL";
}

// Partial column update — pass any subset of ColumnKey -> string|number.
export type RowPatch = Partial<Record<ColumnKey, string | number>>;

// --- Auth & sheet config ---

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheets(): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth: getAuth() });
}

const SHEET_ID = () => process.env.GOOGLE_SHEET_ID!;
const SHEET_NAME = () => process.env.GOOGLE_SHEET_TAB_NAME || "Subscribers";
const LOG_SHEET_NAME = () => process.env.GOOGLE_SHEET_LOG_TAB_NAME || "Status Log";

// Assumes row 1 is a header row. Data rows start at row 2.
const DATA_RANGE = () => `${SHEET_NAME()}!A2:V`;

// --- Cell colour helpers ---

const STATUS_COL = 4;        // Column E (0-based)
const LATEST_ACTION_COL = 6; // Column G (0-based)

type Rgb = { red: number; green: number; blue: number };

// Convert a 6-digit hex colour ("F4CCCC") into the 0–1 RGB the Sheets API wants.
function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace(/^#/, ""), 16);
  return {
    red: ((n >> 16) & 0xff) / 255,
    green: ((n >> 8) & 0xff) / 255,
    blue: (n & 0xff) / 255,
  };
}

const WHITE: Rgb = { red: 1, green: 1, blue: 1 };

// Shared so "TRIAL_CANCELLED reads the same as CANCELLED" is mechanical, not
// two hand-typed hex literals that could drift apart.
const CANCELLED_RED = hexToRgb("F4CCCC");

// Status column (E) — only CANCELLED / TRIAL_CANCELLED get a fill; everything
// else (including TRIAL_ACTIVE and TRIAL_CANCELLATION_SCHEDULED) stays white.
const STATUS_COLORS: Record<string, Rgb> = {
  CANCELLED: CANCELLED_RED,
  TRIAL_CANCELLED: CANCELLED_RED, // same red — reads as cancelled at a glance
};

// Latest Action column (G).
const LATEST_ACTION_COLORS: Record<string, Rgb> = {
  CANCELLATION_SCHEDULED: hexToRgb("FEFF00"),
  UPGRADED:               hexToRgb("01FF00"),
  UNDO_CANCELLATION:      hexToRgb("01FF00"),
  DOWNGRADE_SCHEDULED:    hexToRgb("F0BE3B"),
  DOWNGRADE_EXECUTED:     hexToRgb("F0BE3B"),
  DOWNGRADED:             hexToRgb("F0BE3B"),
};

async function getSheetTabId(): Promise<number> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID(),
    fields: "sheets.properties",
  });
  const tabName = SHEET_NAME();
  const sheet = res.data.sheets?.find((s) => s.properties?.title === tabName);
  const id = sheet?.properties?.sheetId;
  if (id === undefined || id === null) {
    throw new Error(`Sheet tab "${tabName}" not found in spreadsheet`);
  }
  return id;
}

// Set the background fill of a single cell. columnIndex is 0-based.
async function setCellBackground(
  rowIndex: number,
  columnIndex: number,
  color: Rgb
): Promise<void> {
  const sheetTabId = await getSheetTabId();
  const sheets = getSheets();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      requests: [
        {
          updateCells: {
            range: {
              sheetId: sheetTabId,
              startRowIndex: rowIndex - 1, // convert to 0-based
              endRowIndex: rowIndex,
              startColumnIndex: columnIndex,
              endColumnIndex: columnIndex + 1,
            },
            rows: [
              {
                values: [
                  {
                    userEnteredFormat: {
                      backgroundColor: color,
                    },
                  },
                ],
              },
            ],
            fields: "userEnteredFormat.backgroundColor",
          },
        },
      ],
    },
  });
}

export async function setLatestActionColor(rowIndex: number, latestAction: string): Promise<void> {
  await setCellBackground(rowIndex, LATEST_ACTION_COL, LATEST_ACTION_COLORS[latestAction] ?? WHITE);
}

/** Clear the Latest Action cell (G) back to white — used when a subscription
 *  is cancelled without writing a new Latest Action, so a leftover fill (e.g.
 *  the yellow CANCELLATION_SCHEDULED) doesn't linger on a cancelled row. */
export async function resetLatestActionColor(rowIndex: number): Promise<void> {
  await setCellBackground(rowIndex, LATEST_ACTION_COL, WHITE);
}

export async function setStatusColor(rowIndex: number, status: string): Promise<void> {
  await setCellBackground(rowIndex, STATUS_COL, STATUS_COLORS[status] ?? WHITE);
}

// --- Reads ---

export function parseRow(row: string[], rowIndex: number): SheetRow {
  const cell = (i: number) => (row[i] ?? "").toString();
  const num = (i: number) => {
    // Strip currency symbols, thousands separators, and stray text (e.g. a
    // manually-typed "$264 SGD", or a currency-formatted cell read back as
    // "$264.00" under FORMATTED_VALUE) before parsing. Without this, a
    // non-numeric price reads as 0 and every same-plan renewal looks like a
    // price drift, firing a spurious "Price Updated" ping.
    const raw = cell(i).replace(/[^0-9.\-]/g, "").trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const bool = (i: number) => cell(i).toUpperCase() === "TRUE";
  return {
    rowIndex,
    email: cell(0),              // A
    customerName: cell(1),       // B
    tradingViewUsername: cell(2), // C
    telegramUsername: cell(3),   // D
    status: cell(4),             // E
    currentPlan: cell(5),        // F
    latestAction: cell(6),       // G
    previousPlan: cell(7),       // H
    subscriptionPrice: num(8),   // I
    couponDiscount: bool(9),     // J
    subscriptionStart: cell(10), // K
    subscriptionExpiry: cell(11), // L
    subscriptionCount: num(12),  // M
    failedPaymentCount: num(13), // N
    stripeSubscriptionId: cell(14), // O
    telegramUserId: cell(15),    // P
    // cell(16)–cell(18) are the manual Q/R/S columns — skipped, not modelled.
    referralSource: cell(19),    // T
    followupSent: cell(20),      // U
    mobileNumber: cell(21),      // V
  };
}

async function getAllRows(): Promise<SheetRow[]> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: DATA_RANGE(),
  });
  const values = (res.data.values ?? []) as string[][];
  // rowIndex is 1-indexed; data starts at row 2.
  return values.map((row, i) => parseRow(row, i + 2));
}

/** Every subscriber row. Used by the daily TradingView reconcile job. */
export async function getAllSubscriberRows(): Promise<SheetRow[]> {
  return getAllRows();
}

export async function findRowByEmail(
  email: string
): Promise<SheetRow | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const rows = await getAllRows();
  return rows.find((r) => r.email.trim().toLowerCase() === target) ?? null;
}

export async function findRowBySubscriptionId(
  subscriptionId: string
): Promise<SheetRow | null> {
  if (!subscriptionId) return null;
  const rows = await getAllRows();
  return rows.find((r) => r.stripeSubscriptionId === subscriptionId) ?? null;
}

export async function findRowByTradingViewUsername(
  username: string
): Promise<SheetRow | null> {
  const target = username.trim().toLowerCase();
  if (!target) return null;
  const rows = await getAllRows();
  return rows.find((r) => r.tradingViewUsername.trim().toLowerCase() === target) ?? null;
}

export async function findRowByTelegramUsername(
  username: string
): Promise<SheetRow | null> {
  const target = username.trim().toLowerCase().replace(/^@/, "");
  if (!target) return null;
  const rows = await getAllRows();
  return (
    rows.find(
      (r) => r.telegramUsername.trim().toLowerCase().replace(/^@/, "") === target
    ) ?? null
  );
}

// --- Writes ---

export async function appendNewSubscriber(
  data: NewSubscriberRow
): Promise<number> {
  // Find the target row by scanning column A (email) ourselves, then write
  // with values.update — we deliberately do NOT use values.append here.
  //
  // Why not append: despite passing an "A2:A" range, values.append detects the
  // table's full width (A–P) and appends after the last row containing a value
  // in ANY column. So a stray value far down another column — e.g. checkbox
  // data-validation applied past the data in column J, which reports "FALSE" —
  // fools it into placing new rows hundreds of rows below the real data.
  // (That is exactly what happened in July 2026: a new subscriber landed at
  // row 1132 instead of 148.) Scanning column A directly is immune to stray
  // values in every other column.
  //
  // Trade-off: this reintroduces a small write race — two checkouts completing
  // within the same read-then-write window could compute the same target row
  // and the second would overwrite the first. At this business's volume (a
  // handful of subscriptions a week) that collision is effectively impossible,
  // and it's the deliberate choice over the append footgun above.
  const sheets = getSheets();

  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A2:A`,
    majorDimension: "COLUMNS",
  });
  const emails = (colA.data.values?.[0] ?? []) as string[];
  // Walk column A and remember the last non-empty cell's row. Data starts at
  // row 2, so column-A index i maps to sheet row i + 2. A gap (empty A with
  // data elsewhere, e.g. a manual separator row) is skipped — we always land
  // after the last real email.
  let lastDataRow = 1; // header only; the new row becomes row 2 if sheet empty
  for (let i = 0; i < emails.length; i++) {
    if (emails[i] != null && String(emails[i]).trim() !== "") {
      lastDataRow = i + 2;
    }
  }
  const targetRow = lastDataRow + 1;

  // Two ranges in one batch: the webhook-owned block A–P, and Referral Source
  // in T. Q/R/S (Indicator Invited / NOTES / Pepperstone Acc) are manual
  // columns Joseph maintains — deliberately never written, not even as "".
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${SHEET_NAME()}!A${targetRow}:P${targetRow}`,
          values: [
            [
              data.email,                                    // A
              data.customerName,                             // B
              data.tradingViewUsername,                      // C
              data.telegramUsername,                         // D
              data.status ?? "ACTIVE",                       // E — Status
              data.currentPlan,                              // F — Current Plan
              data.latestAction ?? "NEW_SUBSCRIPTION",       // G — Latest Action
              "",                                            // H — Previous Plan
              data.subscriptionPrice,                        // I
              data.couponDiscount ? "TRUE" : "FALSE",        // J — Coupon Discount
              data.subscriptionStart,                        // K
              data.subscriptionExpiry,                       // L
              1,                                             // M — Subscription Count
              0,                                             // N — Failed Payment Count
              data.stripeSubscriptionId,                     // O
              "",                                            // P — Telegram User ID (filled by bot.py)
            ],
          ],
        },
        {
          range: `${SHEET_NAME()}!T${targetRow}`,
          values: [[data.referralSource]],                   // T — Referral Source
        },
        {
          // U (Follow-up Sent) is cron-owned — skipped, same as Q/R/S.
          range: `${SHEET_NAME()}!V${targetRow}`,
          values: [[data.mobileNumber ?? ""]],               // V — Mobile Number
        },
      ],
    },
  });

  return targetRow;
}

/**
 * Append one row to the Status Log tab (the append-only lifecycle history).
 *
 * values.append is safe here, unlike on the Subscribers tab: this tab has no
 * checkbox data-validation trailing below the data (the footgun documented in
 * appendNewSubscriber), and nothing else writes to it, so append's table
 * detection always lands on the true last row.
 */
export async function appendEventLogRow(
  values: (string | number)[]
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `'${LOG_SHEET_NAME()}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

/**
 * Update a subset of columns on a row. Pass any subset of ColumnKey -> value.
 * Empty patch is a no-op.
 */
export async function updateRowFields(
  rowIndex: number,
  patch: RowPatch
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const sheets = getSheets();
  const sheetName = SHEET_NAME();

  const data = entries.map(([key, value]) => ({
    range: `${sheetName}!${COL[key as ColumnKey]}${rowIndex}`,
    values: [[String(value)]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });
}
