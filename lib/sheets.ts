import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";

// --- Column layout (matches Stripe Webhook Gameplan) ---
//
// A Email                       I Subscription Start
// B Customer Name               J Subscription Expiry
// C TradingView Username        K Status              (ACTIVE | CANCELLED)
// D Telegram Username           L Latest Action       (see LatestAction below)
// E Telegram User ID            M Subscription Count
// F Plan Type                   N Failed Payment Count
// G Subscription Price          O Stripe Subscription ID
// H Previous Plan Type

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
  previousPlanType: "H",
  subscriptionStart: "I",
  subscriptionExpiry: "J",
  status: "K",
  latestAction: "L",
  subscriptionCount: "M",
  failedPaymentCount: "N",
  stripeSubscriptionId: "O",
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
const DATA_RANGE = () => `${SHEET_NAME()}!A2:O`;

// --- Reads ---

function parseRow(row: string[], rowIndex: number): SheetRow {
  const cell = (i: number) => (row[i] ?? "").toString();
  const num = (i: number) => {
    const raw = cell(i).trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    rowIndex,
    email: cell(0),
    customerName: cell(1),
    tradingViewUsername: cell(2),
    telegramUsername: cell(3),
    telegramUserId: cell(4),
    planType: cell(5),
    subscriptionPrice: num(6),
    previousPlanType: cell(7),
    subscriptionStart: cell(8),
    subscriptionExpiry: cell(9),
    status: cell(10),
    latestAction: cell(11),
    subscriptionCount: num(12),
    failedPaymentCount: num(13),
    stripeSubscriptionId: cell(14),
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

// --- Writes ---

export async function appendNewSubscriber(
  data: NewSubscriberRow
): Promise<void> {
  // Use update on an explicit row rather than append. The Sheets API's append
  // scans for the last non-empty cell in the range, which means any blank/
  // formatted rows below real data push the new row down. Calculating the
  // target row from actual data avoids this.
  const existingRows = await getAllRows();
  const targetRow = existingRows.length + 2; // +1 for header, +1 for next row
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A${targetRow}:O${targetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          data.email,                  // A
          data.customerName,           // B
          data.tradingViewUsername,    // C
          data.telegramUsername,       // D
          "",                          // E — Telegram User ID (filled by bot.py)
          data.planType,               // F
          data.subscriptionPrice,      // G
          "",                          // H — Previous Plan Type
          data.subscriptionStart,      // I
          data.subscriptionExpiry,     // J
          "ACTIVE",                    // K — Status
          "NEW_SUBSCRIPTION",          // L — Latest Action
          1,                           // M — Subscription Count
          0,                           // N — Failed Payment Count
          data.stripeSubscriptionId,   // O
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
