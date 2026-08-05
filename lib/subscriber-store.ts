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
  setLatestActionColor,
  resetLatestActionColor,
  setStatusColor,
  getAllSubscriberRows,
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
  currentPlan: string;
  subscriptionPrice: number;
  couponDiscount: boolean;
  periodStart: Date;
  periodEnd: Date;
  stripeSubscriptionId: string;
  referralSource: string; // "" when the checkout carried no partner ref
  mobileNumber?: string; // phone from checkout; optional so older callers compile
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
  currentPlan?: string;
  subscriptionPrice?: number;
  couponDiscount?: boolean;
  previousPlan?: string;
  subscriptionStart?: Date;
  subscriptionExpiry?: Date;
  status?:
    | "ACTIVE"
    | "PAYMENT_FAILED"
    | "CANCELLATION_SCHEDULED"
    | "CANCELLED"
    | "TRIAL_ACTIVE"
    | "TRIAL_CANCELLATION_SCHEDULED"
    | "TRIAL_CANCELLED";
  latestAction?: string;
  subscriptionCount?: number;
  failedPaymentCount?: number;
  stripeSubscriptionId?: string;
  referralSource?: string;
  followupSent?: string;
  mobileNumber?: string;
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
  listAll(): Promise<Subscriber[]>;
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

  listAll(): Promise<Subscriber[]> {
    return getAllSubscriberRows();
  }

  // --- Append a new row. ----------------------------------------------------
  // Dates → display strings, then hand off to sheets.ts.
  async appendNew(data: NewSubscriberData): Promise<void> {
    // Single-sourced so the row's Latest Action cell and its colour can
    // never disagree. sheets.ts keeps its own `??` as a defensive default.
    const latestAction = data.latestAction ?? "NEW_SUBSCRIPTION";
    const targetRow = await appendNewSubscriber({
      email: data.email,
      customerName: data.customerName,
      tradingViewUsername: data.tradingViewUsername,
      telegramUsername: data.telegramUsername,
      currentPlan: data.currentPlan,
      subscriptionPrice: data.subscriptionPrice,
      couponDiscount: data.couponDiscount,
      subscriptionStart: formatDisplayDateSGT(data.periodStart),
      subscriptionExpiry: formatDisplayDateSGT(data.periodEnd),
      stripeSubscriptionId: data.stripeSubscriptionId,
      referralSource: data.referralSource,
      mobileNumber: data.mobileNumber,
      status: data.status,
      latestAction,
    });
    // Reset cell colour (NEW_SUBSCRIPTION / START_TRIAL → white, per the map fallback).
    await setLatestActionColor(targetRow, latestAction);
  }

  // --- Update an existing row. ----------------------------------------------
  // Walk through the patch one field at a time. For date fields, format the
  // Date to a display string before passing through. For everything else,
  // copy the value across. When latestAction is patched, recolour the Latest
  // Action cell (G); when status is patched, recolour the Status cell (E) —
  // both in parallel, with white as the default for unmapped values.
  async applyUpdate(subscriber: Subscriber, patch: SubscriberPatch): Promise<void> {
    const row: RowPatch = {};
    if (patch.customerName !== undefined) row.customerName = patch.customerName;
    if (patch.tradingViewUsername !== undefined) row.tradingViewUsername = patch.tradingViewUsername;
    if (patch.telegramUsername !== undefined) row.telegramUsername = patch.telegramUsername;
    if (patch.currentPlan !== undefined) row.currentPlan = patch.currentPlan;
    if (patch.subscriptionPrice !== undefined) row.subscriptionPrice = patch.subscriptionPrice;
    if (patch.couponDiscount !== undefined) row.couponDiscount = patch.couponDiscount ? "TRUE" : "FALSE";
    if (patch.previousPlan !== undefined) row.previousPlan = patch.previousPlan;
    if (patch.subscriptionStart !== undefined) row.subscriptionStart = formatDisplayDateSGT(patch.subscriptionStart);
    if (patch.subscriptionExpiry !== undefined) row.subscriptionExpiry = formatDisplayDateSGT(patch.subscriptionExpiry);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.latestAction !== undefined) row.latestAction = patch.latestAction;
    if (patch.subscriptionCount !== undefined) row.subscriptionCount = patch.subscriptionCount;
    if (patch.failedPaymentCount !== undefined) row.failedPaymentCount = patch.failedPaymentCount;
    if (patch.stripeSubscriptionId !== undefined) row.stripeSubscriptionId = patch.stripeSubscriptionId;
    if (patch.referralSource !== undefined) row.referralSource = patch.referralSource;
    if (patch.followupSent !== undefined) row.followupSent = patch.followupSent;
    if (patch.mobileNumber !== undefined) row.mobileNumber = patch.mobileNumber;

    const tasks: Promise<void>[] = [updateRowFields(subscriber.rowIndex, row)];
    if (patch.latestAction !== undefined) {
      tasks.push(setLatestActionColor(subscriber.rowIndex, patch.latestAction));
    } else if (patch.status === "CANCELLED" || patch.status === "TRIAL_CANCELLED") {
      // ENDED patches only the status, so the Latest Action cell (G) would
      // keep its old fill — typically the yellow CANCELLATION_SCHEDULED — on
      // a cancelled row. Clear it so cancelled rows read clean: red status,
      // plain G. Same applies to a trial that ends without converting.
      tasks.push(resetLatestActionColor(subscriber.rowIndex));
    }
    if (patch.status !== undefined) {
      tasks.push(setStatusColor(subscriber.rowIndex, patch.status));
    }
    await Promise.all(tasks);
  }
}
