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

export type Status = "ACTIVE" | "PAYMENT_FAILED" | "CANCELLATION_SCHEDULED" | "CANCELLED";

export type LatestAction =
  | "NEW_SUBSCRIPTION"
  | "RENEWAL"
  | "UPGRADED"
  | "DOWNGRADED"
  | "PLAN_SWITCH"
  | "CANCELLATION_SCHEDULED"
  | "DOWNGRADE_SCHEDULED"
  | "UNDO_CANCELLATION"
  | "UNDO_DOWNGRADE"
  | "REACTIVATED";

export const COL = {
  email: "A",
  customerName: "B",
  tradingViewUsername: "C",
  telegramUsername: "D",
  status: "E",
  planType: "F",
  latestAction: "G",
  previousPlanType: "H",
  subscriptionPrice: "I",
  couponDiscount: "J",
  subscriptionStart: "K",
  subscriptionExpiry: "L",
  subscriptionCount: "M",
  failedPaymentCount: "N",
  stripeSubscriptionId: "O",
  telegramUserId: "P",
} as const;

export type ColumnKey = keyof typeof COL;

export interface SheetRow {
  rowIndex: number; // 1-indexed (matches Sheets row numbering)
  email: string;
  customerName: string;
  tradingViewUsername: string;
  telegramUsername: string;
  status: string;
  planType: string;
  latestAction: string;
  previousPlanType: string;
  subscriptionPrice: number;
  couponDiscount: boolean;
  subscriptionStart: string;
  subscriptionExpiry: string;
  subscriptionCount: number;
  failedPaymentCount: number;
  stripeSubscriptionId: string;
  telegramUserId: string;
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

// --- Cell colour helpers ---

const LATEST_ACTION_COL = 6; // Column G (0-based)

const LATEST_ACTION_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  CANCELLATION_SCHEDULED: { red: 1.0,   green: 0.898, blue: 0.4   },
  DOWNGRADE_SCHEDULED:    { red: 1.0,   green: 0.898, blue: 0.4   },
  UPGRADED:               { red: 0.714, green: 0.843, blue: 0.659 },
  UNDO_CANCELLATION:      { red: 0.714, green: 0.843, blue: 0.659 },
};

const WHITE = { red: 1, green: 1, blue: 1 };

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

export async function setLatestActionColor(rowIndex: number, latestAction: string): Promise<void> {
  const sheetTabId = await getSheetTabId();
  const color = LATEST_ACTION_COLORS[latestAction] ?? WHITE;
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
              startColumnIndex: LATEST_ACTION_COL,
              endColumnIndex: LATEST_ACTION_COL + 1,
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
    email: cell(0),              // A
    customerName: cell(1),       // B
    tradingViewUsername: cell(2), // C
    telegramUsername: cell(3),   // D
    status: cell(4),             // E
    planType: cell(5),           // F
    latestAction: cell(6),       // G
    previousPlanType: cell(7),   // H
    subscriptionPrice: num(8),   // I
    couponDiscount: bool(9),     // J
    subscriptionStart: cell(10), // K
    subscriptionExpiry: cell(11), // L
    subscriptionCount: num(12),  // M
    failedPaymentCount: num(13), // N
    stripeSubscriptionId: cell(14), // O
    telegramUserId: cell(15),    // P
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
): Promise<number> {
  // Find the last row that has a real email address. Rows with only checkbox
  // formatting (column J) return "FALSE" from the API and inflate the count,
  // so we filter to rows with a non-empty email before calculating targetRow.
  const existingRows = await getAllRows();
  const realRows = existingRows.filter((r) => r.email.trim() !== "");
  const lastRealRowIndex =
    realRows.length > 0 ? Math.max(...realRows.map((r) => r.rowIndex)) : 1;
  const targetRow = lastRealRowIndex + 1;

  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${SHEET_NAME()}!A${targetRow}:P${targetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          data.email,                                    // A
          data.customerName,                             // B
          data.tradingViewUsername,                      // C
          data.telegramUsername,                         // D
          "ACTIVE",                                      // E — Status
          data.planType,                                 // F — Current Plan
          "NEW_SUBSCRIPTION",                            // G — Latest Action
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
  });

  return targetRow;
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
