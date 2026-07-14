// =============================================================================
// SUBSCRIBERS RECONCILE (one-time)
// =============================================================================
// Reconciles ACTIVE rows of the Subscribers tab:
//   - Current Plan (F) and Subscription Price (I): from the LIVE Stripe
//     subscription object. The Status Log can't be the source here — mid-cycle
//     portal upgrades create no immediate invoice (prorations roll into the
//     next cycle invoice), so invoice-derived log state misses them, and
//     invoice totals include prorations rather than the ongoing quarterly
//     price.
//   - Latest Action (G) and Previous Plan (H): from the Status Log's latest
//     event, but ONLY filling blank cells. Non-blank cells that disagree with
//     the log are reported as conflicts for manual review, never overwritten —
//     the sheet may know about invoice-less events the backfill couldn't see.
//
//   Dry run (default):  npx tsx --env-file=.env scripts/reconcile-subscribers-from-log.mts
//   Write:              npx tsx --env-file=.env scripts/reconcile-subscribers-from-log.mts --apply
//
// Scope: sheet rows FROM_ROW..TO_ROW (defaults 2..122), Status = ACTIVE only.
// Only cells whose value actually differs are written. Latest Action cell
// colours are kept consistent with the webhook's convention. Rows whose
// subscription ID has no log events, and ACTIVE rows outside the range, are
// reported but never touched.
// =============================================================================

import { google } from "googleapis";
import Stripe from "stripe";
import { getPlanType } from "../lib/plans.js";

const APPLY = process.argv.includes("--apply");
const FROM_ROW = 2;
const TO_ROW = 122;

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const SUBS_TAB = process.env.GOOGLE_SHEET_TAB_NAME || "Subscribers";
const LOG_TAB = process.env.GOOGLE_SHEET_LOG_TAB_NAME || "Status Log";

// Latest Action values the sheet uses (webhook vocabulary). Log-only actions
// (CANCELLATION_REASON, PRICE_SYNC, ENDED) never land in col G.
const SHEET_ACTIONS = new Set([
  "NEW_SUBSCRIPTION",
  "RENEWAL",
  "UPGRADED",
  "DOWNGRADED",
  "DOWNGRADE_EXECUTED",
  "PLAN_SWITCH",
  "CANCELLATION_SCHEDULED",
  "DOWNGRADE_SCHEDULED",
  "UNDO_CANCELLATION",
  "UNDO_DOWNGRADE",
  "REACTIVATED",
]);

// Mirrors LATEST_ACTION_COLORS in lib/sheets.ts.
const ACTION_HEX: Record<string, string> = {
  CANCELLATION_SCHEDULED: "FEFF00",
  UPGRADED: "01FF00",
  UNDO_CANCELLATION: "01FF00",
  DOWNGRADE_SCHEDULED: "F0BE3B",
  DOWNGRADE_EXECUTED: "F0BE3B",
  DOWNGRADED: "F0BE3B",
};
function hexToRgb(hex: string) {
  const n = parseInt(hex, 16);
  return { red: ((n >> 16) & 0xff) / 255, green: ((n >> 8) & 0xff) / 255, blue: (n & 0xff) / 255 };
}
const WHITE = { red: 1, green: 1, blue: 1 };

// Parse "$147 SGD", "147", "$88.50" etc. to a number; null if not parseable.
function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Effective quarterly price after discount — mirrors effectivePrice in
// lib/stripe-translator.ts (list price when the discount isn't expanded).
function livePrice(sub: Stripe.Subscription): number | null {
  const unit = sub.items.data[0]?.price?.unit_amount;
  if (unit === null || unit === undefined) return null;
  const first = sub.discounts?.[0];
  if (first && typeof first !== "string") {
    const { amount_off, percent_off } = first.coupon ?? {};
    if (amount_off) return (unit - amount_off) / 100;
    if (percent_off) return (unit * (1 - percent_off / 100)) / 100;
  }
  return unit / 100;
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // --- Live subscription state from Stripe (authoritative for plan + price). ---
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2025-08-27.basil",
  });
  interface LiveState {
    plan: string | null;
    price: number | null;
    status: string;
  }
  const liveBySub = new Map<string, LiveState>();
  console.log("Fetching live subscriptions from Stripe...");
  for await (const s of stripe.subscriptions.list({
    status: "all",
    limit: 100,
    expand: ["data.discounts"],
  })) {
    let plan: string | null = null;
    try {
      plan = getPlanType(s.items.data[0]?.price?.id ?? "");
    } catch {}
    liveBySub.set(s.id, { plan, price: livePrice(s), status: s.status });
  }
  console.log(`  ${liveBySub.size} subscriptions`);

  // --- Load the Status Log and index the latest state per subscription ID. ---
  const logRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${LOG_TAB}'!A2:I`,
  });
  const logRows = (logRes.data.values ?? []) as string[][];

  interface LatestState {
    action?: string;
    plan?: string;
    previousPlan?: string;
    price?: number;
  }
  // Log rows are appended chronologically (backfill sorted, live appends after),
  // so walking top to bottom and overwriting leaves the latest value of each
  // field. Fields only overwrite when the event carries them.
  const stateBySub = new Map<string, LatestState>();
  for (const row of logRows) {
    const [, , subId, action, plan, previousPlan, price] = row.map((c) => (c ?? "").trim());
    if (!subId) continue;
    const st = stateBySub.get(subId) ?? {};
    if (action && SHEET_ACTIONS.has(action)) st.action = action;
    if (plan && plan !== "?") st.plan = plan;
    if (previousPlan) st.previousPlan = previousPlan;
    const p = price ? parsePrice(price) : null;
    if (p !== null) st.price = p;
    stateBySub.set(subId, st);
  }
  console.log(`${logRows.length} log rows -> latest state for ${stateBySub.size} subscriptions`);

  // --- Load the Subscribers tab. ---
  const subsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SUBS_TAB}'!A2:P`,
  });
  const subsRows = (subsRes.data.values ?? []) as string[][];

  interface CellChange {
    row: number;
    col: "F" | "G" | "H" | "I";
    from: string;
    to: string | number;
  }
  const changes: CellChange[] = [];
  const changedActionByRow = new Map<number, string>();
  const conflicts: string[] = [];
  const noMatch: string[] = [];
  const notActiveInStripe: string[] = [];
  const activeOutsideRange: string[] = [];

  for (let i = 0; i < subsRows.length; i++) {
    const rowNum = i + 2;
    const r = subsRows[i];
    const cell = (idx: number) => ((r[idx] ?? "") as string).trim();
    const email = cell(0);
    const status = cell(4);
    if (status !== "ACTIVE") continue;
    if (rowNum < FROM_ROW || rowNum > TO_ROW) {
      activeOutsideRange.push(`row ${rowNum} (${email})`);
      continue;
    }
    const subId = cell(14); // col O
    const live = subId ? liveBySub.get(subId) : undefined;
    const st = subId ? stateBySub.get(subId) : undefined;
    if (!live) {
      noMatch.push(`row ${rowNum} (${email}) sub="${subId || "(empty)"}"`);
      continue;
    }
    if (live.status !== "active" && live.status !== "trialing") {
      notActiveInStripe.push(
        `row ${rowNum} (${email}): sheet ACTIVE but Stripe says ${live.status}`
      );
      continue;
    }

    const curPlan = cell(5); // F
    const curAction = cell(6); // G
    const curPrev = cell(7); // H
    const curPrice = parsePrice(cell(8)); // I

    // F + I: live Stripe subscription is authoritative.
    if (live.plan && live.plan !== curPlan) {
      changes.push({ row: rowNum, col: "F", from: curPlan, to: live.plan });
    }
    if (live.price !== null && live.price !== curPrice) {
      changes.push({ row: rowNum, col: "I", from: cell(8), to: live.price });
    }

    // G + H: from the log, fill blanks only; conflicts are reported, not written.
    if (st?.action) {
      if (!curAction) {
        changes.push({ row: rowNum, col: "G", from: curAction, to: st.action });
        changedActionByRow.set(rowNum, st.action);
      } else if (curAction !== st.action) {
        conflicts.push(
          `row ${rowNum} (${email}) G: sheet "${curAction}" vs log "${st.action}" — left as-is`
        );
      }
    }
    if (st?.previousPlan && !curPrev) {
      changes.push({ row: rowNum, col: "H", from: curPrev, to: st.previousPlan });
    }
  }

  // --- Report. ---
  console.log(`\n${changes.length} cell changes across ${new Set(changes.map((c) => c.row)).size} rows:`);
  for (const c of changes) {
    console.log(`  ${SUBS_TAB}!${c.col}${c.row}: "${c.from}" -> "${c.to}"`);
  }
  if (conflicts.length) {
    console.log(`\nLatest Action conflicts (manual review, untouched):`);
    for (const s of conflicts) console.log(`  ${s}`);
  }
  if (notActiveInStripe.length) {
    console.log(`\nSheet-ACTIVE rows that are NOT active in Stripe (untouched — review!):`);
    for (const s of notActiveInStripe) console.log(`  ${s}`);
  }
  if (noMatch.length) {
    console.log(`\nACTIVE rows with no Stripe subscription match (untouched):`);
    for (const s of noMatch) console.log(`  ${s}`);
  }
  if (activeOutsideRange.length) {
    console.log(`\nACTIVE rows outside rows ${FROM_ROW}-${TO_ROW} (untouched):`);
    for (const s of activeOutsideRange) console.log(`  ${s}`);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.");
    return;
  }
  if (changes.length === 0) {
    console.log("\nNothing to write.");
    return;
  }

  // --- Write changed cells in one batch. ---
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: changes.map((c) => ({
        range: `'${SUBS_TAB}'!${c.col}${c.row}`,
        values: [[String(c.to)]],
      })),
    },
  });

  // --- Recolour changed Latest Action cells (col G, 0-based col 6). ---
  if (changedActionByRow.size > 0) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: "sheets.properties",
    });
    const tabId = meta.data.sheets?.find((s) => s.properties?.title === SUBS_TAB)
      ?.properties?.sheetId;
    if (tabId === undefined || tabId === null) throw new Error(`Tab ${SUBS_TAB} not found`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [...changedActionByRow.entries()].map(([rowNum, action]) => ({
          updateCells: {
            range: {
              sheetId: tabId,
              startRowIndex: rowNum - 1,
              endRowIndex: rowNum,
              startColumnIndex: 6,
              endColumnIndex: 7,
            },
            rows: [
              {
                values: [
                  {
                    userEnteredFormat: {
                      backgroundColor: ACTION_HEX[action] ? hexToRgb(ACTION_HEX[action]) : WHITE,
                    },
                  },
                ],
              },
            ],
            fields: "userEnteredFormat.backgroundColor",
          },
        })),
      },
    });
  }

  console.log(`\nWrote ${changes.length} cells (${changedActionByRow.size} Latest Action recolours).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
