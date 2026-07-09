// =============================================================================
// STATUS LOG BACKFILL (one-time)
// =============================================================================
// Reconstructs historical lifecycle events from Stripe and writes them to the
// Status Log tab, so the log covers the whole business history instead of
// starting at webhook deployment.
//
//   Dry run (default):  npx tsx --env-file=.env scripts/backfill-status-log.mts
//   Write to sheet:     npx tsx --env-file=.env scripts/backfill-status-log.mts --apply
//
// Read-only against Stripe (paginated list calls, status:"all" so cancelled
// subscriptions are included — the default list hides them). Writes only the
// Status Log tab, and only when it has no data rows yet (guard below).
//
// What it can and cannot recover:
//   - NEW_SUBSCRIPTION / REACTIVATED / RENEWAL: from paid invoices.
//   - Plan changes: inferred where consecutive invoices of one subscription
//     charge different plans (classified with the same classifyPlanChange the
//     webhook uses).
//   - ENDED + CANCELLATION_SCHEDULED + reasons: from subscription objects
//     (cancellation_details persists on cancelled subs).
//   - NOT recoverable: payment-failure attempts, cancel-then-undo wobbles,
//     coupon apply/remove events — those lived only in Stripe's 30-day event
//     log. The live webhook captures them from deployment onward.
//
// Every row's Detail starts with "backfill" so reconstructed rows are always
// distinguishable from live-captured ones.
// =============================================================================

import Stripe from "stripe";
import { google } from "googleapis";
import { getPlanType, classifyPlanChange } from "../lib/plans.js";
import {
  entryToRow,
  formatLogTimestampSGT,
  type EventLogEntry,
} from "../lib/event-log.js";
import { formatDisplayDateSGT } from "../lib/format-date.js";

const APPLY = process.argv.includes("--apply");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

// planFromPriceId that never throws — unknown price IDs become "?" so one
// retired price can't sink the whole backfill.
function planOf(priceId: string | undefined | null): string {
  if (!priceId) return "?";
  try {
    return getPlanType(priceId);
  } catch {
    return "?";
  }
}

function invoicePriceId(inv: Stripe.Invoice): string | null {
  const line = inv.lines?.data?.[0];
  return (
    (line as { pricing?: { price_details?: { price?: string } } } | undefined)
      ?.pricing?.price_details?.price ??
    (line as unknown as { price?: { id?: string } } | undefined)?.price?.id ??
    null
  );
}

interface TimedEntry {
  ts: number; // unix seconds
  entry: EventLogEntry;
}

async function main() {
  // --------------------------------------------------------------------------
  // Fetch everything (read-only, auto-paginated).
  // --------------------------------------------------------------------------
  console.log("Fetching subscriptions (status: all)...");
  const subs: Stripe.Subscription[] = [];
  for await (const s of stripe.subscriptions.list({ status: "all", limit: 100 })) {
    subs.push(s);
  }
  console.log(`  ${subs.length} subscriptions`);

  console.log("Fetching invoices...");
  const invoices: Stripe.Invoice[] = [];
  for await (const inv of stripe.invoices.list({ limit: 100 })) {
    invoices.push(inv);
  }
  console.log(`  ${invoices.length} invoices`);

  // customer id -> email, from invoices (they carry customer_email).
  const emailByCustomer = new Map<string, string>();
  for (const inv of invoices) {
    const cust = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
    if (cust && inv.customer_email) emailByCustomer.set(cust, inv.customer_email);
  }
  // Any subscription whose customer never appeared on an invoice: fetch directly.
  for (const s of subs) {
    const cust = typeof s.customer === "string" ? s.customer : s.customer.id;
    if (!emailByCustomer.has(cust)) {
      const c = await stripe.customers.retrieve(cust);
      if (!("deleted" in c && c.deleted) && (c as Stripe.Customer).email) {
        emailByCustomer.set(cust, (c as Stripe.Customer).email!);
      }
    }
  }
  const emailOf = (customer: string | { id: string }): string => {
    const id = typeof customer === "string" ? customer : customer.id;
    return emailByCustomer.get(id) ?? id; // fall back to the customer id
  };

  // --------------------------------------------------------------------------
  // Derive events from paid invoices, oldest first.
  // --------------------------------------------------------------------------
  const entries: TimedEntry[] = [];
  const paid = invoices
    .filter((i) => i.status === "paid")
    .sort((a, b) => a.created - b.created);

  const lastPlanBySub = new Map<string, string>();
  const quarterBySub = new Map<string, number>();
  const seenCreateByEmail = new Set<string>();

  for (const inv of paid) {
    const subId =
      (inv as { subscription?: string | { id: string } }).subscription ??
      (inv as { parent?: { subscription_details?: { subscription?: string } } })
        .parent?.subscription_details?.subscription;
    const sub = typeof subId === "string" ? subId : subId?.id;
    if (!sub) continue; // one-off invoice, not a subscription event

    const email = inv.customer_email ?? emailOf(inv.customer as string);
    const plan = planOf(invoicePriceId(inv));
    const price = inv.total / 100;
    const coupon = (inv.total_discount_amounts ?? []).some((d) => d.amount > 0);
    const ts = inv.status_transitions?.paid_at ?? inv.created;
    const periodEnd = inv.lines?.data?.[0]?.period?.end;
    const expiry = periodEnd ? formatDisplayDateSGT(new Date(periodEnd * 1000)) : "?";
    const prevPlan = lastPlanBySub.get(sub);

    if (inv.billing_reason === "subscription_create") {
      const isReactivation = seenCreateByEmail.has(email);
      seenCreateByEmail.add(email);
      quarterBySub.set(sub, 1);
      entries.push({
        ts,
        entry: {
          email,
          stripeSubscriptionId: sub,
          action: isReactivation ? "REACTIVATED" : "NEW_SUBSCRIPTION",
          plan,
          price,
          coupon,
          detail: `backfill; expiry ${expiry}${inv.total === 0 ? "; $0 first invoice (trial/comp)" : ""}`,
        },
      });
    } else if (inv.billing_reason === "subscription_cycle") {
      const quarter = (quarterBySub.get(sub) ?? 1) + 1;
      quarterBySub.set(sub, quarter);
      if (prevPlan && prevPlan !== plan && plan !== "?" && prevPlan !== "?") {
        // Period-boundary plan change (scheduled downgrade executing).
        let kind = "PLAN_SWITCH";
        try {
          kind = classifyPlanChange(prevPlan, plan);
        } catch {}
        entries.push({
          ts,
          entry: {
            email,
            stripeSubscriptionId: sub,
            action: kind,
            plan,
            previousPlan: prevPlan,
            price,
            coupon,
            detail: `backfill; confirmed at renewal; expiry ${expiry}`,
          },
        });
      } else {
        entries.push({
          ts,
          entry: {
            email,
            stripeSubscriptionId: sub,
            action: "RENEWAL",
            plan,
            price,
            coupon,
            detail: `backfill; subscription #${quarter}; expiry ${expiry}`,
          },
        });
      }
    } else if (inv.billing_reason === "subscription_update") {
      // Mid-cycle plan change (upgrade/switch with proration).
      if (prevPlan && prevPlan !== plan && plan !== "?" && prevPlan !== "?") {
        let kind = "PLAN_SWITCH";
        try {
          kind = classifyPlanChange(prevPlan, plan);
        } catch {}
        entries.push({
          ts,
          entry: {
            email,
            stripeSubscriptionId: sub,
            action: kind,
            plan,
            previousPlan: prevPlan,
            price,
            coupon,
            detail: `backfill; mid-cycle change`,
          },
        });
      }
      // Same-plan update invoices (prorations, price syncs) carry no event.
    }

    if (plan !== "?") lastPlanBySub.set(sub, plan);
  }

  // --------------------------------------------------------------------------
  // Derive cancellation events from subscription objects.
  // --------------------------------------------------------------------------
  for (const s of subs) {
    const email = emailOf(s.customer as string);
    const plan = planOf(s.items.data[0]?.price?.id);
    const reason = [
      s.cancellation_details?.feedback,
      s.cancellation_details?.comment,
    ]
      .filter(Boolean)
      .join("; ");

    if (s.status === "canceled") {
      const endedAt = s.ended_at ?? s.canceled_at ?? s.created;
      const wasScheduled = !!s.canceled_at && !!s.ended_at && s.ended_at - s.canceled_at > 3600;
      if (wasScheduled && s.canceled_at) {
        entries.push({
          ts: s.canceled_at,
          entry: {
            email,
            stripeSubscriptionId: s.id,
            action: "CANCELLATION_SCHEDULED",
            plan,
            detail: `backfill; access ends ${formatDisplayDateSGT(new Date(endedAt * 1000))}${reason ? `; reason: ${reason}` : ""}`,
          },
        });
      }
      entries.push({
        ts: endedAt,
        entry: {
          email,
          stripeSubscriptionId: s.id,
          action: "ENDED",
          plan,
          detail: `backfill; ${wasScheduled ? "scheduled cancellation completed" : "immediate cancellation"}${reason ? `; reason: ${reason}` : ""}`,
        },
      });
    } else if (s.cancel_at_period_end && s.canceled_at) {
      const accessEnd =
        s.items.data[0]?.current_period_end ??
        (s as unknown as { current_period_end?: number }).current_period_end;
      entries.push({
        ts: s.canceled_at,
        entry: {
          email,
          stripeSubscriptionId: s.id,
          action: "CANCELLATION_SCHEDULED",
          plan,
          detail: `backfill; access ends ${accessEnd ? formatDisplayDateSGT(new Date(accessEnd * 1000)) : "?"}${reason ? `; reason: ${reason}` : ""}`,
        },
      });
    }
  }

  // --------------------------------------------------------------------------
  // Sort chronologically and report.
  // --------------------------------------------------------------------------
  entries.sort((a, b) => a.ts - b.ts);

  const byAction = new Map<string, number>();
  for (const e of entries) {
    byAction.set(e.entry.action, (byAction.get(e.entry.action) ?? 0) + 1);
  }
  console.log(`\n${entries.length} events reconstructed:`);
  for (const [action, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(24)} ${n}`);
  }
  if (entries.length > 0) {
    console.log(
      `\nRange: ${formatLogTimestampSGT(new Date(entries[0].ts * 1000))} to ${formatLogTimestampSGT(new Date(entries[entries.length - 1].ts * 1000))}`
    );
  }
  console.log("\nFirst 5 rows:");
  for (const e of entries.slice(0, 5)) {
    console.log(
      "  " + entryToRow(formatLogTimestampSGT(new Date(e.ts * 1000)), e.entry).join(" | ")
    );
  }
  console.log("Last 5 rows:");
  for (const e of entries.slice(-5)) {
    console.log(
      "  " + entryToRow(formatLogTimestampSGT(new Date(e.ts * 1000)), e.entry).join(" | ")
    );
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to write to the sheet.");
    return;
  }

  // --------------------------------------------------------------------------
  // Write to the Status Log tab in one batch. Refuses if the tab already has
  // data rows — this is a seed, not a merge.
  // --------------------------------------------------------------------------
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const sheetId = process.env.GOOGLE_SHEET_ID!;
  const tab = process.env.GOOGLE_SHEET_LOG_TAB_NAME || "Status Log";

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${tab}'!A2:A`,
  });
  if ((existing.data.values ?? []).length > 0) {
    throw new Error(
      `${tab} already has data rows — refusing to backfill over them. Clear the tab (below the header) first if you really want to re-seed.`
    );
  }

  const rows = entries.map((e) =>
    entryToRow(formatLogTimestampSGT(new Date(e.ts * 1000)), e.entry)
  );
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tab}'!A2:I${1 + rows.length}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
  console.log(`\nWrote ${rows.length} rows to '${tab}'.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
