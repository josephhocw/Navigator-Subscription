import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";

// --- Column layout (matches Stripe Webhook Gameplan) ---
//
// A Email                       J Subscription Start
// B Customer Name               K Subscription Expiry
// C TradingView Username        L Status              (ACTIVE | CANCELLED)
// D Telegram Username           M Latest Action       (see LatestAction below)
// E Telegram User ID            N Subscription Count
// F Plan Type                   O Failed Payment Count
// G Subscription Price          P Stripe Subscription ID
// H Coupon Discount             (TRUE if Pepperstone discount is active)
// I Previous Plan Type

export type Status = "ACTIVE" | "CANCELLATION_SCHEDULED" | "CANCELLED";

export type LatestAction =
  | "NEW_SUBSCRIPTION"
  | "RENEWAL"
  | "UPGRADED"
  | "DOWNGRADED"
  | "PLAN_SWITCH"
  | "CANCELLED"
  | "UNDO_CANCELLATION"
  | "REACTIVATED";

export const COL = {
  email: "A",
  customerName: "B",
  tradingViewUsername: "C",
  telegramUsername: "D",
  telegramUserId: "E",
  planType: "F",
  subscriptionPrice: "G",
  couponDiscount: "H",
  previousPlanType: "I",
  subscriptionStart: "J",
  subscriptionExpiry: "K",
  status: "L",
  latestAction: "M",
  subscriptionCount: "N",
  failedPaymentCount: "O",
  stripeSubscriptionId: "P",
} as const;

export type ColumnKey = keyof typeof COL;

export interface SheetRow {
  rowIndex: number; // 1-indexed (matches Sheets row numbering)
  email: string;
  customerName: string;
  tradingViewUsername: string;
  telegramUsername: string;
  telegramUserId: string;
  planType: string;
  subscriptionPrice: number;
  couponDiscount: boolean;
  previousPlanType: string;
  subscriptionStart: string;
  subscriptionExpiry: string;
  status: string;
  latestAction: string;
  subscriptionCount: number;
  failedPaymentCount: number;
  stripeSubscriptionId: string;
}

export interface NewSubscriberRow {
  email: string;
  customerName: string;
  tradingViewUsername: string;
  telegramUsername: string;
  planType: string;
  subscriptionPrice: number;
  couponDiscount: boolean;
  subscriptionStart: string;
  subscriptionExpiry: string;
  stripeSubscriptionId: string;
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

// Assumes row 1 is a header row. Data rows start at row 2.
const DATA_RANGE = () => `${SHEET_NAME()}!A2:P`;

// --- Reads ---

function parseRow(row: string[], rowIndex: number): SheetRow {
  const cell = (i: number) => (row[i] ?? "").toString();
  const num = (i: number) => {
    const raw = cell(i).trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  const bool = (i: number) => cell(i).toUpperCase() === "TRUE";
  return {
    rowIndex,
    email: cell(0),
    customerName: cell(1),
    tradingViewUsername: cell(2),
    telegramUsername: cell(3),
    telegramUserId: cell(4),
    planType: cell(5),
    subscriptionPrice: num(6),
    couponDiscount: bool(7),   // H
    previousPlanType: cell(8), // I
    subscriptionStart: cell(9), // J
    subscriptionExpiry: cell(10), // K
    status: cell(11),             // L
    latestAction: cell(12),       // M
    subscriptionCount: num(13),   // N
    failedPaymentCount: num(14),  // O
    stripeSubscriptionId: cell(15), // P
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
): Promise<void> {
  // Use append with INSERT_ROWS so Sheets inserts a new row after the last
  // row of data and auto-expands the grid — no row-count calculation needed
  // and no risk of hitting the sheet's row limit.
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: DATA_RANGE(),
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          data.email,                                    // A
          data.customerName,                             // B
          data.tradingViewUsername,                      // C
          data.telegramUsername,                         // D
          "",                                            // E — Telegram User ID (filled by bot.py)
          data.planType,                                 // F
          data.subscriptionPrice,                        // G
          data.couponDiscount ? "TRUE" : "FALSE",        // H — Coupon Discount
          "",                                            // I — Previous Plan Type
          data.subscriptionStart,                        // J
          data.subscriptionExpiry,                       // K
          "ACTIVE",                                      // L — Status
          "NEW_SUBSCRIPTION",                            // M — Latest Action
          1,                                             // N — Subscription Count
          0,                                             // O — Failed Payment Count
          data.stripeSubscriptionId,                     // P
        ],
      ],
    },
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
