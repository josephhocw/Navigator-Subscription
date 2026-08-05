// =============================================================================
// TRIAL STATUS BACKFILL (one-time)
// =============================================================================
// The trial-status feature (Status = TRIAL_ACTIVE / TRIAL_CANCELLATION_SCHEDULED
// / TRIAL_CANCELLED, Latest Action = START_TRIAL) is only written by the
// webhook going forward. The ~60 subscribers who started a trial BEFORE that
// deploy still read Status ACTIVE / Latest Action NEW_SUBSCRIPTION even though
// they're still trialing in Stripe. This script migrates those existing rows
// to the correct trial vocabulary so the sheet matches reality.
//
//   Dry run (default):  npx tsx --env-file=.env scripts/backfill-trial-statuses.mts
//   Write to sheet:     npx tsx --env-file=.env scripts/backfill-trial-statuses.mts --live
//
// What it does:
//   1. Lists every LIVE Stripe subscription with status "trialing" (paginated).
//   2. Reads every Subscribers row.
//   3. For each row whose col-O Stripe Subscription ID matches a trialing
//      subscription:
//        - target Status: TRIAL_CANCELLATION_SCHEDULED if the subscription has
//          a scheduled cancellation (cancel_at_period_end or cancel_at set),
//          else TRIAL_ACTIVE.
//        - target Latest Action: START_TRIAL, but ONLY when the row's current
//          Latest Action is exactly NEW_SUBSCRIPTION — anything else (RENEWAL,
//          UPGRADED, a manual note, etc.) is left alone, since we can't be sure
//          it's safe to clobber.
//        - rows already at their target are left untouched (idempotent).
//   4. Trialing subscriptions with no matching sheet row are listed, not
//      silently dropped — those are sheet gaps that need a human look.
//
// Read-only against both Stripe and the sheet unless --live is passed. With
// --live, writes go through SheetsSubscriberStore.applyUpdate so status/action
// cell colours stay consistent with the webhook's own convention (both new
// targets map to white fills, so there's no colour churn — using the store is
// about keeping one write path, not about colour). One row failing to write
// does not abort the run; failures are collected and reported at the end.
// =============================================================================

import Stripe from "stripe";
import { getAllSubscriberRows } from "../lib/sheets.js";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";

const LIVE = process.argv.includes("--live");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

interface TrialInfo {
  cancelScheduled: boolean;
  customerEmail: string | null;
}

async function main() {
  console.log(`Stripe key: ${process.env.STRIPE_SECRET_KEY?.slice(0, 8)}…  (${process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE" : "test"})`);
  console.log(LIVE ? "Mode: LIVE — will write to the sheet.\n" : "Mode: DRY RUN — no writes.\n");

  // --------------------------------------------------------------------------
  // 1. List every trialing subscription (read-only, auto-paginated).
  // --------------------------------------------------------------------------
  console.log("Fetching trialing subscriptions from Stripe...");
  const trialBySub = new Map<string, TrialInfo>();
  for await (const s of stripe.subscriptions.list({
    status: "trialing",
    limit: 100,
    expand: ["data.customer"],
  })) {
    const customer = s.customer;
    const customerEmail =
      typeof customer === "object" && customer && !("deleted" in customer)
        ? customer.email
        : null;
    trialBySub.set(s.id, {
      cancelScheduled: s.cancel_at_period_end === true || s.cancel_at != null,
      customerEmail,
    });
  }
  console.log(`  ${trialBySub.size} trialing subscriptions\n`);

  // --------------------------------------------------------------------------
  // 2. Read every sheet row.
  // --------------------------------------------------------------------------
  console.log("Fetching Subscribers sheet rows...");
  const rows = await getAllSubscriberRows();
  console.log(`  ${rows.length} rows\n`);

  // --------------------------------------------------------------------------
  // 3. Compute the plan: target E / target G per matching row.
  // --------------------------------------------------------------------------
  interface PlannedRow {
    rowIndex: number;
    email: string;
    currentStatus: string;
    targetStatus: string;
    currentAction: string;
    targetAction: string | null; // null = leave G alone
  }

  const planned: PlannedRow[] = [];
  const alreadyCorrect: PlannedRow[] = [];
  const matchedSubIds = new Set<string>();

  for (const row of rows) {
    const subId = row.stripeSubscriptionId;
    if (!subId) continue; // blank sub ID = comp row, can't match
    const trial = trialBySub.get(subId);
    if (!trial) continue; // not a trialing subscription
    matchedSubIds.add(subId);

    const targetStatus = trial.cancelScheduled
      ? "TRIAL_CANCELLATION_SCHEDULED"
      : "TRIAL_ACTIVE";
    const targetAction =
      row.latestAction === "NEW_SUBSCRIPTION" ? "START_TRIAL" : null;

    const statusChanged = row.status !== targetStatus;
    const actionChanged = targetAction !== null && row.latestAction !== targetAction;

    const entry: PlannedRow = {
      rowIndex: row.rowIndex,
      email: row.email,
      currentStatus: row.status,
      targetStatus,
      currentAction: row.latestAction,
      targetAction,
    };

    if (statusChanged || actionChanged) {
      planned.push(entry);
    } else {
      alreadyCorrect.push(entry);
    }
  }

  // Trialing subscriptions in Stripe with no matching sheet row at all.
  const unmatched: { subId: string; email: string | null }[] = [];
  for (const [subId, trial] of trialBySub) {
    if (!matchedSubIds.has(subId)) {
      unmatched.push({ subId, email: trial.customerEmail });
    }
  }

  // --------------------------------------------------------------------------
  // 4. Print the table.
  // --------------------------------------------------------------------------
  console.log(`${planned.length} row(s) to move:\n`);
  for (const p of planned) {
    const statusPart =
      p.currentStatus === p.targetStatus
        ? `E unchanged (${p.currentStatus})`
        : `E: ${p.currentStatus} → ${p.targetStatus}`;
    const actionPart =
      p.targetAction === null
        ? `G unchanged (${p.currentAction || "(blank)"})`
        : `G: ${p.currentAction} → ${p.targetAction}`;
    console.log(`  row ${p.rowIndex}  ${p.email}  |  ${statusPart}  |  ${actionPart}`);
  }

  // --------------------------------------------------------------------------
  // 5. Summary.
  // --------------------------------------------------------------------------
  console.log(`\nSummary:`);
  console.log(`  rows to move: ${planned.length}`);
  console.log(`  rows already correct: ${alreadyCorrect.length}`);
  console.log(`  trialing subscriptions with NO matching sheet row: ${unmatched.length}`);
  for (const u of unmatched) {
    console.log(`    ${u.subId}  ${u.email ?? "(no email on Stripe customer)"}`);
  }

  if (!LIVE) {
    console.log("\nDry run — nothing was written. Re-run with --live to apply.");
    return;
  }

  // --------------------------------------------------------------------------
  // 6. Apply writes via the store. One failure never aborts the run.
  // --------------------------------------------------------------------------
  const store = new SheetsSubscriberStore();
  const failures: string[] = [];
  let succeeded = 0;

  for (const p of planned) {
    try {
      const subscriber = rows.find((r) => r.rowIndex === p.rowIndex);
      if (!subscriber) throw new Error("row disappeared between read and write");
      const patch: { status: typeof p.targetStatus; latestAction?: string } = {
        status: p.targetStatus as
          | "TRIAL_ACTIVE"
          | "TRIAL_CANCELLATION_SCHEDULED",
      };
      if (p.targetAction !== null) patch.latestAction = p.targetAction;
      await store.applyUpdate(subscriber, patch);
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`row ${p.rowIndex} (${p.email}): ${message}`);
    }
  }

  console.log(`\nWrote ${succeeded} of ${planned.length} rows.`);
  if (failures.length) {
    console.log(`Failures (${failures.length}):`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
