// =============================================================================
// SUBSCRIBER STORE
// =============================================================================
// This file is the bridge between the lifecycle (which speaks in subscribers
// and Date objects) and the Google Sheet (which speaks in rows, columns A–P,
// and display-formatted date strings).
//
// What this file does:
//   - Defines a `SubscriberStore` interface — the contract the lifecycle uses
//     to read and write subscriber data.
//   - Provides `SheetsSubscriberStore`, the real implementation backed by
//     the existing functions in `lib/sheets.ts`.
//   - Converts `Date` values into display strings on the way in, so the
//     lifecycle never has to format dates itself.
//
// Why it exists (and not just sheets.ts directly):
//   So tests can pass an in-memory store to the lifecycle. And so that when
//   we eventually deepen this further (folding `sheets.ts` entirely behind
//   this interface), nothing outside this file needs to change.
//
// Today this is a thin wrapper. That's intentional — candidate 1 in the
// architecture review will deepen it.
// =============================================================================

import {
  findRowByEmail,
  findRowBySubscriptionId,
  findRowByTradingViewUsername,
  findRowByTelegramUsername,
  appendNewSubscriber,
  updateRowFields,
  type SheetRow,
  type RowPatch,
} from "./sheets.js";
import { formatDisplayDateSGT } from "./format-date.js";

/**
 * One subscriber. Currently identical to a SheetRow (16 fields + the row
 * number). Callers should treat `rowIndex` as opaque — it's only used by the
 * store itself to know which row to write back to.
 */
export type Subscriber = SheetRow;

/**
 * Data needed to record a brand-new subscriber.
 * Dates are real `Date` objects — the store formats them when writing.
 */
export interface NewSubscriberData {
  email: string;
  customerName: string;
  tradingViewUsername: string;
  telegramUsername: string;
  planType: string;
  subscriptionPrice: number;
  periodStart: Date;
  periodEnd: Date;
  stripeSubscriptionId: string;
}

/**
 * Partial update — only the fields you set get written. Every field is
 * optional so a handler can update just `subscriptionCount`, or just the
 * dates, etc.
 *
 * Date fields take real Dates. The store formats them on write.
 */
export interface SubscriberPatch {
  customerName?: string;
  tradingViewUsername?: string;
  telegramUsername?: string;
  planType?: string;
  subscriptionPrice?: number;
  previousPlanType?: string;
  subscriptionStart?: Date;
  subscriptionExpiry?: Date;
  status?: "ACTIVE" | "CANCELLATION_SCHEDULED" | "CANCELLED";
  latestAction?: string;
  subscriptionCount?: number;
  failedPaymentCount?: number;
  stripeSubscriptionId?: string;
}

/**
 * The contract the lifecycle uses. Any object satisfying this shape can be
 * passed to `new SubscriptionLifecycle(...)` — that's the test seam.
 */
export interface SubscriberStore {
  findByEmail(email: string): Promise<Subscriber | null>;
  findBySubscriptionId(id: string): Promise<Subscriber | null>;
  findByTradingViewUsername(username: string): Promise<Subscriber | null>;
  findByTelegramUsername(username: string): Promise<Subscriber | null>;
  appendNew(data: NewSubscriberData): Promise<void>;
  applyUpdate(subscriber: Subscriber, patch: SubscriberPatch): Promise<void>;
}

// =============================================================================
// The real, Google-Sheets-backed implementation.
// Just delegates to the existing functions in sheets.ts, with date formatting
// added at the boundary so callers can hand in real Date objects.
// =============================================================================
export class SheetsSubscriberStore implements SubscriberStore {
  // --- Reads: pass-through to sheets.ts. -------------------------------------
  findByEmail(email: string): Promise<Subscriber | null> {
    return findRowByEmail(email);
  }

  findBySubscriptionId(id: string): Promise<Subscriber | null> {
    return findRowBySubscriptionId(id);
  }

  findByTradingViewUsername(username: string): Promise<Subscriber | null> {
    return findRowByTradingViewUsername(username);
  }

  findByTelegramUsername(username: string): Promise<Subscriber | null> {
    return findRowByTelegramUsername(username);
  }

  // --- Append a new row. ----------------------------------------------------
  // Dates → display strings, then hand off to sheets.ts.
  appendNew(data: NewSubscriberData): Promise<void> {
    return appendNewSubscriber({
      email: data.email,
      customerName: data.customerName,
      tradingViewUsername: data.tradingViewUsername,
      telegramUsername: data.telegramUsername,
      planType: data.planType,
      subscriptionPrice: data.subscriptionPrice,
      subscriptionStart: formatDisplayDateSGT(data.periodStart),
      subscriptionExpiry: formatDisplayDateSGT(data.periodEnd),
      stripeSubscriptionId: data.stripeSubscriptionId,
    });
  }

  // --- Update an existing row. ----------------------------------------------
  // Walk through the patch one field at a time. For date fields, format the
  // Date to a display string before passing through. For everything else,
  // copy the value across.
  applyUpdate(subscriber: Subscriber, patch: SubscriberPatch): Promise<void> {
    const row: RowPatch = {};
    if (patch.customerName !== undefined) row.customerName = patch.customerName;
    if (patch.tradingViewUsername !== undefined) row.tradingViewUsername = patch.tradingViewUsername;
    if (patch.telegramUsername !== undefined) row.telegramUsername = patch.telegramUsername;
    if (patch.planType !== undefined) row.planType = patch.planType;
    if (patch.subscriptionPrice !== undefined) row.subscriptionPrice = patch.subscriptionPrice;
    if (patch.previousPlanType !== undefined) row.previousPlanType = patch.previousPlanType;
    if (patch.subscriptionStart !== undefined) row.subscriptionStart = formatDisplayDateSGT(patch.subscriptionStart);
    if (patch.subscriptionExpiry !== undefined) row.subscriptionExpiry = formatDisplayDateSGT(patch.subscriptionExpiry);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.latestAction !== undefined) row.latestAction = patch.latestAction;
    if (patch.subscriptionCount !== undefined) row.subscriptionCount = patch.subscriptionCount;
    if (patch.failedPaymentCount !== undefined) row.failedPaymentCount = patch.failedPaymentCount;
    if (patch.stripeSubscriptionId !== undefined) row.stripeSubscriptionId = patch.stripeSubscriptionId;
    // sheets.ts knows how to write a partial RowPatch to a given row number.
    return updateRowFields(subscriber.rowIndex, row);
  }
}
