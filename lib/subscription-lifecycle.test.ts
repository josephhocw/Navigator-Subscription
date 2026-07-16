// =============================================================================
// LIFECYCLE EVENT-LOG TESTS
// =============================================================================
// Drives SubscriptionLifecycle with in-memory fakes (the seam the class was
// built for) and asserts that every applied action leaves one append-only
// entry in the injected EventLog — the "Status Log" tab in production.
// =============================================================================

import { describe, test, expect } from "vitest";
import { SubscriptionLifecycle, type Mailer, type AdminNotifier } from "./subscription-lifecycle.js";
import type {
  Subscriber,
  SubscriberStore,
  SubscriberPatch,
  NewSubscriberData,
} from "./subscriber-store.js";
import {
  formatLogTimestampSGT,
  entryToRow,
  type EventLog,
  type EventLogEntry,
} from "./event-log.js";
import { formatDisplayDateSGT } from "./format-date.js";

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

class FakeStore implements SubscriberStore {
  rows: Subscriber[] = [];
  patches: SubscriberPatch[] = [];

  async findByEmail(email: string): Promise<Subscriber | null> {
    return (
      this.rows.find((r) => r.email.toLowerCase() === email.toLowerCase()) ?? null
    );
  }
  async findBySubscriptionId(id: string): Promise<Subscriber | null> {
    return this.rows.find((r) => r.stripeSubscriptionId === id) ?? null;
  }
  async findByTradingViewUsername(): Promise<Subscriber | null> {
    return null;
  }
  async findByTelegramUsername(): Promise<Subscriber | null> {
    return null;
  }
  async appendNew(data: NewSubscriberData): Promise<void> {
    this.rows.push(
      makeSubscriber({
        email: data.email,
        customerName: data.customerName,
        currentPlan: data.currentPlan,
        subscriptionPrice: data.subscriptionPrice,
        couponDiscount: data.couponDiscount,
        stripeSubscriptionId: data.stripeSubscriptionId,
        referralSource: data.referralSource,
      })
    );
  }
  async applyUpdate(subscriber: Subscriber, patch: SubscriberPatch): Promise<void> {
    this.patches.push(patch);
  }
}

const noopMailer: Mailer = {
  sendOnboarding: async () => {},
  sendPaymentFailed: async () => {},
  sendCancellationConfirmation: async () => {},
  sendCancellationUndone: async () => {},
  sendSubscriptionEnded: async () => {},
  sendPlanChange: async () => {},
  sendDowngradeScheduled: async () => {},
  sendDowngradeUndone: async () => {},
};

class RecordingNotifier implements AdminNotifier {
  messages: string[] = [];
  async notify(message: string): Promise<void> {
    this.messages.push(message);
  }
}

class RecordingEventLog implements EventLog {
  entries: EventLogEntry[] = [];
  async record(entry: EventLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class FailingEventLog implements EventLog {
  async record(): Promise<void> {
    throw new Error("sheets append blew up");
  }
}

function makeSubscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    rowIndex: 2,
    email: "tan@example.com",
    customerName: "Tan Ah Kow",
    tradingViewUsername: "tanahkow",
    telegramUsername: "tanahkow",
    status: "ACTIVE",
    currentPlan: "US_HK",
    latestAction: "NEW_SUBSCRIPTION",
    previousPlan: "",
    subscriptionPrice: 99,
    couponDiscount: true,
    subscriptionStart: "9 April 2026 18:00",
    subscriptionExpiry: "9 July 2026 18:00",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_123",
    telegramUserId: "",
    referralSource: "",
    ...overrides,
  };
}

function build(store: FakeStore, log: EventLog) {
  return new SubscriptionLifecycle(store, noopMailer, new RecordingNotifier(), log);
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

describe("formatLogTimestampSGT", () => {
  test("formats a UTC instant as sortable Singapore time", () => {
    // 06:32:05 UTC = 14:32:05 SGT (UTC+8)
    expect(formatLogTimestampSGT(new Date("2026-07-09T06:32:05Z"))).toBe(
      "2026-07-09 14:32:05"
    );
  });
});

describe("entryToRow", () => {
  test("maps an entry to the 9-column Status Log row", () => {
    const row = entryToRow("2026-07-09 14:32:05", {
      email: "tan@example.com",
      stripeSubscriptionId: "sub_123",
      action: "RENEWAL",
      plan: "US_HK",
      previousPlan: "",
      price: 99,
      coupon: true,
      detail: "subscription #2",
    });
    expect(row).toEqual([
      "2026-07-09 14:32:05",
      "tan@example.com",
      "sub_123",
      "RENEWAL",
      "US_HK",
      "",
      99,
      "TRUE",
      "subscription #2",
    ]);
  });

  test("leaves optional fields as empty cells", () => {
    const row = entryToRow("2026-07-09 14:32:05", {
      email: "tan@example.com",
      stripeSubscriptionId: "sub_123",
      action: "ENDED",
    });
    expect(row).toEqual([
      "2026-07-09 14:32:05",
      "tan@example.com",
      "sub_123",
      "ENDED",
      "",
      "",
      "",
      "",
      "",
    ]);
  });
});

// -----------------------------------------------------------------------------
// Lifecycle logging
// -----------------------------------------------------------------------------

describe("SubscriptionLifecycle event logging", () => {
  const periodStart = new Date("2026-07-09T10:00:00Z");
  const periodEnd = new Date("2026-10-09T10:00:00Z");

  test("STARTED (new subscriber) logs NEW_SUBSCRIPTION", async () => {
    const store = new FakeStore();
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "new@example.com",
      name: "New Person",
      currentPlan: "ALL_MARKETS",
      subscriptionPrice: 109,
      couponDiscount: true,
      couponCode: "NAV30",
      tradingViewUsername: "newperson",
      telegramUsername: "newperson",
      stripeSubscriptionId: "sub_new",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(log.entries).toHaveLength(1);
    const entry = log.entries[0];
    expect(entry.action).toBe("NEW_SUBSCRIPTION");
    expect(entry.email).toBe("new@example.com");
    expect(entry.plan).toBe("ALL_MARKETS");
    expect(entry.price).toBe(109);
    expect(entry.coupon).toBe(true);
    expect(entry.detail).toContain("NAV30");
  });

  test("STARTED (existing email) logs REACTIVATED with the previous plan", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ status: "CANCELLED", currentPlan: "US" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "tan@example.com",
      name: "Tan Ah Kow",
      currentPlan: "ALL_MARKETS",
      subscriptionPrice: 139,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "tanahkow",
      telegramUsername: "tanahkow",
      stripeSubscriptionId: "sub_new2",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("REACTIVATED");
    expect(log.entries[0].plan).toBe("ALL_MARKETS");
    expect(log.entries[0].previousPlan).toBe("US");
  });

  test("STARTED duplicate delivery logs nothing", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ stripeSubscriptionId: "sub_dup" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "tan@example.com",
      name: "Tan Ah Kow",
      currentPlan: "US_HK",
      subscriptionPrice: 99,
      couponDiscount: true,
      couponCode: null,
      tradingViewUsername: "tanahkow",
      telegramUsername: "tanahkow",
      stripeSubscriptionId: "sub_dup",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(log.entries).toHaveLength(0);
  });

  test("STARTED with a referral source writes col Q and logs the ref", async () => {
    const store = new FakeStore();
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "fan@example.com",
      name: "DrWealth Fan",
      currentPlan: "SG",
      subscriptionPrice: 108,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "dwfan",
      telegramUsername: "dwfan",
      stripeSubscriptionId: "sub_ref1",
      periodStart,
      periodEnd,
      referralSource: "drwealth",
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].referralSource).toBe("drwealth");
    expect(log.entries[0].detail).toContain("ref drwealth");
  });

  test("STARTED without a referral source leaves col Q blank", async () => {
    const store = new FakeStore();
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "organic@example.com",
      name: "Organic Person",
      currentPlan: "SG",
      subscriptionPrice: 108,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "organic",
      telegramUsername: "organic",
      stripeSubscriptionId: "sub_org1",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(store.rows[0].referralSource).toBe("");
    expect(log.entries[0].detail).not.toContain("ref ");
  });

  test("STARTED reactivation fills an empty referral source", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({ status: "CANCELLED", referralSource: "" })
    );
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "tan@example.com",
      name: "Tan Ah Kow",
      currentPlan: "US_HK",
      subscriptionPrice: 99,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "tanahkow",
      telegramUsername: "tanahkow",
      stripeSubscriptionId: "sub_react_ref",
      periodStart,
      periodEnd,
      referralSource: "drwealth",
    });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].referralSource).toBe("drwealth");
  });

  test("STARTED reactivation never overwrites an existing referral source", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({ status: "CANCELLED", referralSource: "otherpartner" })
    );
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "tan@example.com",
      name: "Tan Ah Kow",
      currentPlan: "US_HK",
      subscriptionPrice: 99,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "tanahkow",
      telegramUsername: "tanahkow",
      stripeSubscriptionId: "sub_react_keep",
      periodStart,
      periodEnd,
      referralSource: "drwealth",
    });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].referralSource).toBeUndefined();
  });

  test("RENEWED logs RENEWAL with count and new expiry", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber());
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "US_HK",
      subscriptionPrice: 99,
      couponDiscount: true,
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("RENEWAL");
    expect(log.entries[0].detail).toContain("#2");
    expect(log.entries[0].detail).toContain(formatDisplayDateSGT(periodEnd));
  });

  test("RENEWED duplicate delivery logs nothing", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({ subscriptionExpiry: formatDisplayDateSGT(periodEnd) })
    );
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "US_HK",
      subscriptionPrice: 99,
      couponDiscount: true,
    });
    expect(log.entries).toHaveLength(0);
  });

  test("CANCELLATION_SCHEDULED logs with the access-end date", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber());
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "CANCELLATION_SCHEDULED",
      stripeSubscriptionId: "sub_123",
      accessEndDate: periodEnd,
      cancellationFeedback: null,
      cancellationComment: null,
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("CANCELLATION_SCHEDULED");
    expect(log.entries[0].detail).toContain(formatDisplayDateSGT(periodEnd));
  });

  test("CANCELLATION_REASON_RECEIVED logs the reason", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber());
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "CANCELLATION_REASON_RECEIVED",
      stripeSubscriptionId: "sub_123",
      cancellationFeedback: "too_expensive",
      cancellationComment: "Cutting back this year",
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("CANCELLATION_REASON");
    expect(log.entries[0].detail).toContain("too_expensive");
    expect(log.entries[0].detail).toContain("Cutting back this year");
  });

  test("ENDED logs ENDED", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ status: "CANCELLATION_SCHEDULED" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("ENDED");
    expect(log.entries[0].plan).toBe("US_HK");
  });

  test("PAYMENT_FAILED logs the attempt number", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber());
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "PAYMENT_FAILED",
      stripeSubscriptionId: "sub_123",
      attemptCount: 2,
      nextAttemptDate: periodEnd,
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("PAYMENT_FAILED");
    expect(log.entries[0].detail).toContain("attempt 2");
  });

  test("PLAN_CHANGED logs the classification with old and new plan", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "US" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "ALL_MARKETS",
      newSubscriptionPrice: 139,
      newCouponDiscount: false,
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("UPGRADED");
    expect(log.entries[0].plan).toBe("ALL_MARKETS");
    expect(log.entries[0].previousPlan).toBe("US");
  });

  test("a failing event log never breaks the webhook", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber());
    const lifecycle = build(store, new FailingEventLog());
    await expect(
      lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" })
    ).resolves.toBeUndefined();
    // The sheet update must still have gone through.
    expect(store.patches).toHaveLength(1);
  });
});
