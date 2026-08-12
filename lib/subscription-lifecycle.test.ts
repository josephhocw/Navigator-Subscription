// =============================================================================
// LIFECYCLE EVENT-LOG TESTS
// =============================================================================
// Drives SubscriptionLifecycle with in-memory fakes (the seam the class was
// built for) and asserts that every applied action leaves one append-only
// entry in the injected EventLog — the "Status Log" tab in production.
// =============================================================================

import { describe, test, expect, it } from "vitest";
import { SubscriptionLifecycle, type Mailer, type AdminNotifier } from "./subscription-lifecycle.js";
import type { TradingViewGranter } from "./tradingview-access.js";
import type {
  TelegramGroupRemover,
  RemovalInput,
  RemovalResult,
} from "./telegram-groups.js";
import { TelegramGroupApi, MAIN_MARKET, type GroupConfig } from "./telegram-groups.js";
import { NoopTelegramGroupRemover } from "./telegram-groups.js";
import {
  NoopCouponManager,
  type CouponManager,
  type CouponSyncResult,
} from "./coupon-sync-stripe.js";
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
  /** Raw appendNew payloads — the only place status/latestAction on a NEW row show up. */
  appends: NewSubscriberData[] = [];

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
    this.appends.push(data);
    this.rows.push(
      makeSubscriber({
        email: data.email,
        customerName: data.customerName,
        currentPlan: data.currentPlan,
        subscriptionPrice: data.subscriptionPrice,
        couponCode: data.couponCode ?? "",
        couponDiscount: (data.couponCode ?? "") !== "",
        stripeSubscriptionId: data.stripeSubscriptionId,
        referralSource: data.referralSource,
        mobileNumber: data.mobileNumber ?? "",
        // Defaults mirror the real store's (col E "ACTIVE", col G
        // "NEW_SUBSCRIPTION") so the appended row reads back as the sheet would.
        status: data.status ?? "ACTIVE",
        latestAction: data.latestAction ?? "NEW_SUBSCRIPTION",
      })
    );
  }
  async applyUpdate(subscriber: Subscriber, patch: SubscriberPatch): Promise<void> {
    this.patches.push(patch);
  }
  async listAll(): Promise<Subscriber[]> {
    return this.rows;
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
  sendTrialConverted: async () => {},
  sendTrialWinback: async () => {},
};

// A mailer that records which trial emails were sent, for the trial-flow tests.
class RecordingMailer implements Mailer {
  trialConverted: Array<{ email: string; planType: string; billingEndDate: string }> = [];
  trialWinback: Array<{ email: string; planType: string }> = [];
  subscriptionEnded: Array<{ email: string; planType: string }> = [];
  async sendOnboarding(): Promise<void> {}
  async sendPaymentFailed(): Promise<void> {}
  async sendCancellationConfirmation(): Promise<void> {}
  async sendCancellationUndone(): Promise<void> {}
  async sendSubscriptionEnded(d: { email: string; planType: string }): Promise<void> {
    this.subscriptionEnded.push({ email: d.email, planType: d.planType });
  }
  async sendPlanChange(): Promise<void> {}
  async sendDowngradeScheduled(): Promise<void> {}
  async sendDowngradeUndone(): Promise<void> {}
  async sendTrialConverted(d: { email: string; planType: string; billingEndDate: string }): Promise<void> {
    this.trialConverted.push({ email: d.email, planType: d.planType, billingEndDate: d.billingEndDate });
  }
  async sendTrialWinback(d: { email: string; planType: string }): Promise<void> {
    this.trialWinback.push({ email: d.email, planType: d.planType });
  }
}

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
  async hasRecorded(stripeSubscriptionId: string, action: string): Promise<boolean> {
    return this.entries.some(
      (e) => e.stripeSubscriptionId === stripeSubscriptionId && e.action === action
    );
  }
}

class RecordingTradingView implements TradingViewGranter {
  grants: Array<{ username: string; planType: string; expiration?: Date }> = [];
  removes: Array<{ username: string; planType: string }> = [];
  // What validateUsername resolves to. "echo" (default) returns the username
  // back — a valid account — so pre-existing tests are unaffected. Set null to
  // simulate a wrong username, "throw" to simulate the lookup erroring.
  validateResult: "echo" | "throw" | string | null = "echo";
  validated: string[] = [];
  async grantForPlan(username: string, planType: string, expiration?: Date): Promise<void> {
    this.grants.push({ username, planType, expiration });
  }
  async removeForPlan(username: string, planType: string): Promise<void> {
    this.removes.push({ username, planType });
  }
  async validateUsername(username: string): Promise<string | null> {
    this.validated.push(username);
    if (this.validateResult === "throw") throw new Error("username_hint returned 500");
    return this.validateResult === "echo" ? username : this.validateResult;
  }
}

// A granter whose grant always fails — used to prove a TradingView failure
// alerts Joseph but never fails the webhook (the sheet write already happened).
class FailingTradingView implements TradingViewGranter {
  async grantForPlan(): Promise<void> {
    throw new Error("TradingView session cookie expired");
  }
  async removeForPlan(): Promise<void> {
    throw new Error("TradingView session cookie expired");
  }
}

// Mirrors NoopTradingViewGranter: resolves without doing anything, and flags
// itself unconfigured so the lifecycle pings a manual-fallback nudge instead of
// a false "granted".
class UnconfiguredTradingView implements TradingViewGranter {
  readonly configured = false;
  async grantForPlan(): Promise<void> {}
  async removeForPlan(): Promise<void> {}
}

class FailingEventLog implements EventLog {
  async record(): Promise<void> {
    throw new Error("sheets append blew up");
  }
  async hasRecorded(): Promise<boolean> {
    return false;
  }
}

class RecordingTelegramGroups implements TelegramGroupRemover {
  readonly configured = true;
  readonly calls: RemovalInput[] = [];
  constructor(private readonly result: Partial<RemovalResult> = {}) {}

  async removeFromGroups(input: RemovalInput): Promise<RemovalResult> {
    this.calls.push(input);
    return {
      removed: ["HK_MARKET"],
      skipped: [],
      failures: [],
      outstandingBans: [],
      identityMismatches: [],
      dryRun: false,
      ...this.result,
    };
  }
}

class ThrowingTelegramGroups implements TelegramGroupRemover {
  readonly configured = true;
  async removeFromGroups(): Promise<RemovalResult> {
    throw new Error("telegram is down");
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
    couponCode: "NAV30",
    subscriptionStart: "9 April 2026 18:00",
    subscriptionExpiry: "9 July 2026 18:00",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_123",
    telegramUserId: "",
    referralSource: "",
    followupSent: "",
    mobileNumber: "",
    ...overrides,
  };
}

function build(
  store: FakeStore,
  log: EventLog,
  tv: TradingViewGranter = new RecordingTradingView()
) {
  return new SubscriptionLifecycle(store, noopMailer, new RecordingNotifier(), log, tv);
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

  test("STARTED records the checkout phone in the new row's mobile number", async () => {
    const store = new FakeStore();
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "STARTED",
      email: "new@example.com",
      name: "New Person",
      currentPlan: "ALL_MARKETS",
      subscriptionPrice: 139,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "newperson",
      telegramUsername: "",
      phone: "+6591234567",
      stripeSubscriptionId: "sub_phone",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].mobileNumber).toBe("+6591234567");
  });

  test("STARTED (reactivation) refreshes the mobile number when provided", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({ status: "CANCELLED", mobileNumber: "+6590000000" })
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
      phone: "+6591112222",
      stripeSubscriptionId: "sub_new_react",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].mobileNumber).toBe("+6591112222");
  });

  test("STARTED passes the trial flag through to the onboarding email", async () => {
    const store = new FakeStore();
    const log = new RecordingEventLog();
    const sent: Array<{ isTrial?: boolean; referralSource?: string | null }> = [];
    const mailer: Mailer = {
      ...noopMailer,
      sendOnboarding: async (d) => {
        sent.push(d);
      },
    };
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, new RecordingNotifier(), log, new RecordingTradingView()
    );
    await lifecycle.apply({
      kind: "STARTED",
      email: "trial@example.com",
      name: "Trial Person",
      currentPlan: "ALL_MARKETS",
      subscriptionPrice: 417,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "trialperson",
      telegramUsername: "",
      isTrial: true,
      stripeSubscriptionId: "sub_trialflag",
      periodStart,
      periodEnd,
      referralSource: null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].isTrial).toBe(true);
    expect(sent[0].referralSource).toBeNull();

    // Partner-attributed trial (DrWealth): the ref must reach the mailer so
    // the email shows the rolling per-subscriber trial end, not the 25 July
    // cohort's standardised 9 Aug date.
    await lifecycle.apply({
      kind: "STARTED",
      email: "drwealth-trial@example.com",
      name: "DrWealth Trialist",
      currentPlan: "ALL_MARKETS",
      subscriptionPrice: 417,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "drwtrial",
      telegramUsername: "",
      isTrial: true,
      stripeSubscriptionId: "sub_drwealth_trial",
      periodStart,
      periodEnd,
      referralSource: "drwealth",
    });
    expect(sent).toHaveLength(2);
    expect(sent[1].referralSource).toBe("drwealth");
  });

  test("STARTED labels the admin ping trial vs paid", async () => {
    const trialNotifier = new RecordingNotifier();
    const paidNotifier = new RecordingNotifier();
    const base = {
      kind: "STARTED" as const,
      name: "Ping Person",
      currentPlan: "ALL_MARKETS" as const,
      subscriptionPrice: 417,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "pingperson",
      telegramUsername: "",
      periodStart,
      periodEnd,
      referralSource: null,
    };

    await new SubscriptionLifecycle(
      new FakeStore(), noopMailer, trialNotifier,
      new RecordingEventLog(), new RecordingTradingView()
    ).apply({
      ...base,
      email: "trialping@example.com",
      stripeSubscriptionId: "sub_trialping",
      isTrial: true,
    });

    await new SubscriptionLifecycle(
      new FakeStore(), noopMailer, paidNotifier,
      new RecordingEventLog(), new RecordingTradingView()
    ).apply({
      ...base,
      email: "paidping@example.com",
      stripeSubscriptionId: "sub_paidping",
      isTrial: false,
    });

    expect(trialNotifier.messages[0]).toContain("New Trial Subscriber");
    expect(trialNotifier.messages[0]).toContain("Free trial — first charge");
    expect(trialNotifier.messages[0]).not.toContain("Paid");

    expect(paidNotifier.messages[0]).toContain("New Paid Subscriber");
    expect(paidNotifier.messages[0]).toContain("<b>Type:</b> 💳 Paid");
    expect(paidNotifier.messages[0]).not.toContain("trial");
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
      couponCode: null,
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
      couponCode: null,
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
      newCouponCode: null,
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

// -----------------------------------------------------------------------------
// TradingView access (grant on the right events, never on the wrong ones)
// -----------------------------------------------------------------------------

describe("SubscriptionLifecycle TradingView access", () => {
  const periodStart = new Date("2026-07-09T10:00:00Z");
  const periodEnd = new Date("2026-10-09T10:00:00Z");

  function startedAction(overrides: Record<string, unknown> = {}) {
    return {
      kind: "STARTED" as const,
      email: "new@example.com",
      name: "New Person",
      currentPlan: "US",
      subscriptionPrice: 168,
      couponDiscount: false,
      couponCode: null,
      tradingViewUsername: "newperson",
      telegramUsername: "newperson",
      stripeSubscriptionId: "sub_tv1",
      periodStart,
      periodEnd,
      referralSource: null,
      ...overrides,
    };
  }

  test("STARTED grants the plan's script permanently (no expiration)", async () => {
    const store = new FakeStore();
    const tv = new RecordingTradingView();
    await build(store, new RecordingEventLog(), tv).apply(startedAction());
    expect(tv.grants).toEqual([
      { username: "newperson", planType: "US", expiration: undefined },
    ]);
    expect(tv.removes).toHaveLength(0);
  });

  test("STARTED with no TradingView username grants nothing", async () => {
    const store = new FakeStore();
    const tv = new RecordingTradingView();
    await build(store, new RecordingEventLog(), tv).apply(
      startedAction({ tradingViewUsername: "" })
    );
    expect(tv.grants).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Username validation before the welcome email (added 2026-07-27): a wrong
  // or missing username flags the email's attach step ("contact Joseph"),
  // skips the doomed grant, and pings a clear warning instead.
  // ---------------------------------------------------------------------------

  function buildWithOnboardingCapture(tv: TradingViewGranter) {
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    const sent: Array<{ tvUsernameInvalid?: boolean }> = [];
    const mailer: Mailer = {
      ...noopMailer,
      sendOnboarding: async (d) => {
        sent.push(d);
      },
    };
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, notifier, new RecordingEventLog(), tv
    );
    return { lifecycle, notifier, sent };
  }

  test("STARTED with a wrong username flags the email, skips the grant, pings a warning", async () => {
    const tv = new RecordingTradingView();
    tv.validateResult = null; // no such TradingView account
    const { lifecycle, notifier, sent } = buildWithOnboardingCapture(tv);
    await lifecycle.apply(startedAction({ tradingViewUsername: "nosuchuser" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].tvUsernameInvalid).toBe(true);
    expect(tv.grants).toHaveLength(0);
    expect(
      notifier.messages.some(
        (m) => m.includes("Invalid TradingView username") && m.includes("@nosuchuser")
      )
    ).toBe(true);
  });

  test("STARTED with a blank username is treated the same as a wrong one", async () => {
    const tv = new RecordingTradingView();
    const { lifecycle, notifier, sent } = buildWithOnboardingCapture(tv);
    await lifecycle.apply(startedAction({ tradingViewUsername: "  " }));
    expect(sent[0].tvUsernameInvalid).toBe(true);
    expect(tv.grants).toHaveLength(0);
    expect(tv.validated).toHaveLength(0); // nothing to look up
    expect(
      notifier.messages.some(
        (m) => m.includes("Invalid TradingView username") && m.includes("(not provided)")
      )
    ).toBe(true);
  });

  test("STARTED sends the normal email and still attempts the grant when the lookup errors", async () => {
    const tv = new RecordingTradingView();
    tv.validateResult = "throw"; // lookup down ≠ username wrong — fail open
    const { lifecycle, sent } = buildWithOnboardingCapture(tv);
    await lifecycle.apply(startedAction());
    expect(sent[0].tvUsernameInvalid).toBe(false);
    expect(tv.grants).toHaveLength(1);
  });

  test("STARTED with a valid username sends the normal email and grants", async () => {
    const tv = new RecordingTradingView();
    const { lifecycle, notifier, sent } = buildWithOnboardingCapture(tv);
    await lifecycle.apply(startedAction());
    expect(sent[0].tvUsernameInvalid).toBe(false);
    expect(tv.validated).toEqual(["newperson"]);
    expect(tv.grants).toHaveLength(1);
    expect(
      notifier.messages.some((m) => m.includes("Invalid TradingView username"))
    ).toBe(false);
  });

  test("RENEWED (normal) touches TradingView nothing — grant is permanent, plan unchanged", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "US", tradingViewUsername: "tanahkow" }));
    const tv = new RecordingTradingView();
    await build(store, new RecordingEventLog(), tv).apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "US",
      subscriptionPrice: 168,
      couponDiscount: false,
      couponCode: null,
    });
    expect(tv.grants).toHaveLength(0);
    expect(tv.removes).toHaveLength(0);
  });

  test("PLAN_CHANGED removes the old script and grants the new one (permanent)", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "US", tradingViewUsername: "tanahkow" }));
    const tv = new RecordingTradingView();
    await build(store, new RecordingEventLog(), tv).apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "ALL_MARKETS",
      newSubscriptionPrice: 139,
      newCouponDiscount: false,
      newCouponCode: null,
    });
    expect(tv.removes).toEqual([{ username: "tanahkow", planType: "US" }]);
    expect(tv.grants).toEqual([
      { username: "tanahkow", planType: "ALL_MARKETS", expiration: undefined },
    ]);
  });

  test("CANCELLATION_SCHEDULED touches TradingView nothing (access lapses at expiry)", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber());
    const tv = new RecordingTradingView();
    await build(store, new RecordingEventLog(), tv).apply({
      kind: "CANCELLATION_SCHEDULED",
      stripeSubscriptionId: "sub_123",
      accessEndDate: periodEnd,
      cancellationFeedback: null,
      cancellationComment: null,
    });
    expect(tv.grants).toHaveLength(0);
    expect(tv.removes).toHaveLength(0);
  });

  test("ENDED removes the subscriber's script access", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "US_HK", tradingViewUsername: "tanahkow" }));
    const tv = new RecordingTradingView();
    await build(store, new RecordingEventLog(), tv).apply({
      kind: "ENDED",
      stripeSubscriptionId: "sub_123",
    });
    expect(tv.grants).toHaveLength(0);
    expect(tv.removes).toEqual([{ username: "tanahkow", planType: "US_HK" }]);
  });

  test("a failing TradingView grant alerts Joseph but never breaks the webhook", async () => {
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store,
      noopMailer,
      notifier,
      new RecordingEventLog(),
      new FailingTradingView()
    );
    await expect(lifecycle.apply(startedAction())).resolves.toBeUndefined();
    // The subscriber row was still written despite the grant failing.
    expect(store.rows).toHaveLength(1);
    // And Joseph got a dedicated TradingView failure alert.
    expect(notifier.messages.some((m) => m.includes("TradingView grant FAILED"))).toBe(true);
  });

  test("a successful grant pings a ✅ confirmation naming the user and plan", async () => {
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    const tv = new RecordingTradingView();
    const lifecycle = new SubscriptionLifecycle(
      store,
      noopMailer,
      notifier,
      new RecordingEventLog(),
      tv
    );
    await lifecycle.apply(startedAction());
    expect(tv.grants).toHaveLength(1);
    expect(
      notifier.messages.some(
        (m) => m.includes("TradingView access granted") && m.includes("@newperson")
      )
    ).toBe(true);
  });

  test("when TradingView isn't configured, the grant pings a manual-fallback nudge, not a false success", async () => {
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store,
      noopMailer,
      notifier,
      new RecordingEventLog(),
      new UnconfiguredTradingView()
    );
    await lifecycle.apply(startedAction());
    expect(notifier.messages.some((m) => m.includes("not configured"))).toBe(true);
    expect(notifier.messages.some((m) => m.includes("TradingView access granted"))).toBe(false);
  });
});

describe("trial conversion and win-back", () => {
  test("TRIAL_CONVERTED sends the welcome (plan + billing) and leaves dates/TV alone", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        stripeSubscriptionId: "sub_tv",
        currentPlan: "US",
        tradingViewUsername: "ekohcw",
        telegramUsername: "EKOHCW",
      })
    );
    const mailer = new RecordingMailer();
    const tv = new RecordingTradingView();
    const lifecycle = new SubscriptionLifecycle(
      store,
      mailer,
      new RecordingNotifier(),
      new RecordingEventLog(),
      tv
    );

    await lifecycle.apply({
      kind: "TRIAL_CONVERTED",
      stripeSubscriptionId: "sub_tv",
      planType: "ALL_MARKETS",
      periodEnd: new Date("2026-11-09T15:59:00Z"),
    });

    expect(mailer.trialConverted).toHaveLength(1);
    expect(mailer.trialConverted[0].planType).toBe("ALL_MARKETS");
    expect(mailer.trialConverted[0].billingEndDate).toContain("November");
    // Bookkeeping rides on RENEWED, not here — no sheet writes, no TV changes.
    expect(store.patches).toHaveLength(0);
    expect(tv.grants).toHaveLength(0);
    expect(tv.removes).toHaveLength(0);
  });

  test("ENDED with wasUnconvertedTrial sends the win-back (not the ended email) and removes access", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        stripeSubscriptionId: "sub_tv",
        status: "ACTIVE",
        currentPlan: "ALL_MARKETS",
        tradingViewUsername: "ekohcw",
      })
    );
    const mailer = new RecordingMailer();
    const tv = new RecordingTradingView();
    const lifecycle = new SubscriptionLifecycle(
      store,
      mailer,
      new RecordingNotifier(),
      new RecordingEventLog(),
      tv
    );

    await lifecycle.apply({
      kind: "ENDED",
      stripeSubscriptionId: "sub_tv",
      wasUnconvertedTrial: true,
    });

    expect(mailer.trialWinback).toEqual([
      { email: "tan@example.com", planType: "ALL_MARKETS" },
    ]);
    expect(mailer.subscriptionEnded).toHaveLength(0);
    // A trial that never converted is TRIAL_CANCELLED, not CANCELLED — the sheet
    // has to tell "cancelled having paid" from "cancelled having paid nothing".
    expect(store.patches).toContainEqual({ status: "TRIAL_CANCELLED" });
    expect(tv.removes).toEqual([{ username: "ekohcw", planType: "ALL_MARKETS" }]);
  });

  test("ENDED for a normal cancellation still sends the ended email, not the win-back", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        stripeSubscriptionId: "sub_paid",
        status: "ACTIVE",
        currentPlan: "US",
      })
    );
    const mailer = new RecordingMailer();
    const lifecycle = new SubscriptionLifecycle(
      store,
      mailer,
      new RecordingNotifier(),
      new RecordingEventLog(),
      new RecordingTradingView()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_paid" });

    expect(mailer.subscriptionEnded).toHaveLength(1);
    expect(mailer.trialWinback).toHaveLength(0);
  });
});

// =============================================================================
// TRIAL STATUSES (col E)
//
// A trialist owes nothing yet, so the sheet has to say so at a glance: the four
// paid statuses gain trial-prefixed twins (TRIAL_ACTIVE,
// TRIAL_CANCELLATION_SCHEDULED, TRIAL_CANCELLED) written on exactly the same
// events, with identical emails, pings and log rows. Only the status string and
// the fresh-sign-up log action change. PAYMENT_FAILED stays un-prefixed by
// design, and a converted trial goes back to plain ACTIVE (RENEWED writes it).
// =============================================================================
describe("trial statuses", () => {
  const periodStart = new Date("2026-07-09T10:00:00Z");
  const periodEnd = new Date("2026-10-09T10:00:00Z");

  const startedBase = {
    kind: "STARTED" as const,
    name: "Trial Person",
    currentPlan: "ALL_MARKETS",
    subscriptionPrice: 417,
    couponDiscount: false,
    couponCode: null,
    tradingViewUsername: "trialperson",
    telegramUsername: "trialperson",
    periodStart,
    periodEnd,
    referralSource: null,
  };

  test("STARTED trial (new subscriber) appends TRIAL_ACTIVE / START_TRIAL and logs START_TRIAL", async () => {
    const store = new FakeStore();
    const log = new RecordingEventLog();
    await build(store, log).apply({
      ...startedBase,
      email: "trialnew@example.com",
      stripeSubscriptionId: "sub_trial_new",
      isTrial: true,
    });

    expect(store.appends).toHaveLength(1);
    expect(store.appends[0].status).toBe("TRIAL_ACTIVE");
    expect(store.appends[0].latestAction).toBe("START_TRIAL");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("START_TRIAL");
  });

  test("STARTED trial (reactivation) patches TRIAL_ACTIVE but stays REACTIVATED", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ status: "CANCELLED", currentPlan: "US" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({
      ...startedBase,
      email: "tan@example.com",
      stripeSubscriptionId: "sub_trial_react",
      isTrial: true,
    });

    expect(store.appends).toHaveLength(0);
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].status).toBe("TRIAL_ACTIVE");
    // A returning subscriber is still a reactivation — only the status changes.
    expect(store.patches[0].latestAction).toBe("REACTIVATED");
    expect(log.entries[0].action).toBe("REACTIVATED");
  });

  test("STARTED paid is untouched: ACTIVE / NEW_SUBSCRIPTION (and REACTIVATED on a returning row)", async () => {
    const newStore = new FakeStore();
    const newLog = new RecordingEventLog();
    await build(newStore, newLog).apply({
      ...startedBase,
      email: "paidnew@example.com",
      stripeSubscriptionId: "sub_paid_new",
    });
    expect(newStore.appends[0].status).toBe("ACTIVE");
    expect(newStore.appends[0].latestAction).toBe("NEW_SUBSCRIPTION");
    expect(newLog.entries[0].action).toBe("NEW_SUBSCRIPTION");

    const reactStore = new FakeStore();
    reactStore.rows.push(makeSubscriber({ status: "CANCELLED" }));
    const reactLog = new RecordingEventLog();
    await build(reactStore, reactLog).apply({
      ...startedBase,
      email: "tan@example.com",
      stripeSubscriptionId: "sub_paid_react",
      isTrial: false,
    });
    expect(reactStore.patches[0].status).toBe("ACTIVE");
    expect(reactStore.patches[0].latestAction).toBe("REACTIVATED");
    expect(reactLog.entries[0].action).toBe("REACTIVATED");
  });

  test("CANCELLATION_SCHEDULED mid-trial writes TRIAL_CANCELLATION_SCHEDULED", async () => {
    const trialStore = new FakeStore();
    trialStore.rows.push(makeSubscriber({ status: "TRIAL_ACTIVE" }));
    await build(trialStore, new RecordingEventLog()).apply({
      kind: "CANCELLATION_SCHEDULED",
      stripeSubscriptionId: "sub_123",
      accessEndDate: periodEnd,
      cancellationFeedback: null,
      cancellationComment: null,
      isTrial: true,
    });
    expect(trialStore.patches[0].status).toBe("TRIAL_CANCELLATION_SCHEDULED");
    // The Latest Action (col G) is the same event either way.
    expect(trialStore.patches[0].latestAction).toBe("CANCELLATION_SCHEDULED");

    const paidStore = new FakeStore();
    paidStore.rows.push(makeSubscriber());
    await build(paidStore, new RecordingEventLog()).apply({
      kind: "CANCELLATION_SCHEDULED",
      stripeSubscriptionId: "sub_123",
      accessEndDate: periodEnd,
      cancellationFeedback: null,
      cancellationComment: null,
      isTrial: false,
    });
    expect(paidStore.patches[0].status).toBe("CANCELLATION_SCHEDULED");
    expect(paidStore.patches[0].latestAction).toBe("CANCELLATION_SCHEDULED");
  });

  test("CANCELLATION_UNDONE mid-trial goes back to TRIAL_ACTIVE, not ACTIVE", async () => {
    const trialStore = new FakeStore();
    trialStore.rows.push(
      makeSubscriber({ status: "TRIAL_CANCELLATION_SCHEDULED" })
    );
    await build(trialStore, new RecordingEventLog()).apply({
      kind: "CANCELLATION_UNDONE",
      stripeSubscriptionId: "sub_123",
      isTrial: true,
    });
    expect(trialStore.patches[0].status).toBe("TRIAL_ACTIVE");
    expect(trialStore.patches[0].latestAction).toBe("UNDO_CANCELLATION");

    const paidStore = new FakeStore();
    paidStore.rows.push(makeSubscriber({ status: "CANCELLATION_SCHEDULED" }));
    await build(paidStore, new RecordingEventLog()).apply({
      kind: "CANCELLATION_UNDONE",
      stripeSubscriptionId: "sub_123",
      isTrial: false,
    });
    expect(paidStore.patches[0].status).toBe("ACTIVE");
  });

  test("ENDED on a TRIAL_CANCELLATION_SCHEDULED row is treated as scheduled and still lands on TRIAL_CANCELLED", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({ status: "TRIAL_CANCELLATION_SCHEDULED" })
    );
    const mailer = new RecordingMailer();
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    // They were already emailed when they cancelled — same suppression as the
    // paid CANCELLATION_SCHEDULED path. That is what wasScheduled buys, and it
    // has to keep working off the trial-prefixed status too.
    expect(mailer.subscriptionEnded).toHaveLength(0);
    // No win-back flag on the action, so no win-back email either...
    expect(mailer.trialWinback).toHaveLength(0);
    // ...but the row was still trialing, and a row that never charged must not
    // land on a paid terminal status just because the flag was absent.
    expect(store.patches).toContainEqual({ status: "TRIAL_CANCELLED" });
  });

  test("ENDED on a PAID CANCELLATION_SCHEDULED row still writes plain CANCELLED", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ status: "CANCELLATION_SCHEDULED" }));
    const mailer = new RecordingMailer();
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    // The widened trial write must not leak onto the paid path.
    expect(store.patches).toContainEqual({ status: "CANCELLED" });
    expect(mailer.subscriptionEnded).toHaveLength(0);
    expect(mailer.trialWinback).toHaveLength(0);
  });

  test("RENEWED on a TRIAL_ACTIVE row (the conversion charge) writes plain ACTIVE", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ status: "TRIAL_ACTIVE" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "US_HK",
      subscriptionPrice: 99,
      couponDiscount: true,
      couponCode: null,
    });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].status).toBe("ACTIVE");
    expect(store.patches[0].latestAction).toBe("RENEWAL");
    expect(log.entries[0].action).toBe("RENEWAL");
  });

  test("RENEWED from TRIAL_ACTIVE with a plan change at the boundary also writes ACTIVE", async () => {
    const store = new FakeStore();
    // Sheet says US_HK; the invoice charged for ALL_MARKETS, so this renewal
    // applies the plan change itself — the second of RENEWED's two write paths,
    // which needs the same conversion-to-ACTIVE treatment as the first.
    store.rows.push(makeSubscriber({ status: "TRIAL_ACTIVE" }));
    const log = new RecordingEventLog();
    await build(store, log).apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "ALL_MARKETS",
      subscriptionPrice: 139,
      couponDiscount: false,
      couponCode: null,
    });
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].status).toBe("ACTIVE");
    expect(store.patches[0].currentPlan).toBe("ALL_MARKETS");
  });
});

// =============================================================================
// ENDED — duplicate Stripe delivery
//
// Stripe redelivers on a non-2xx. Before the guard, the second delivery read
// the row as CANCELLED (not CANCELLATION_SCHEDULED), so `wasScheduled` flipped
// to false and the deliberately-suppressed "your subscription has ended" email
// went to a customer who had already had their cancellation confirmed — plus a
// duplicate log row, ping, and a redundant TradingView + Telegram removal.
// =============================================================================
describe("ENDED — duplicate delivery guard", () => {
  test("a second ENDED for an already-CANCELLED row does nothing at all", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        // What the first delivery left behind.
        status: "CANCELLED",
      })
    );
    const mailer = new RecordingMailer();
    const notifier = new RecordingNotifier();
    const log = new RecordingEventLog();
    const tv = new RecordingTradingView();
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, notifier, log, tv, groups
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(mailer.subscriptionEnded).toHaveLength(0);
    expect(mailer.trialWinback).toHaveLength(0);
    expect(store.patches).toHaveLength(0);
    // "Duplicate Stripe deliveries log nothing" — and nothing is pinged either.
    expect(log.entries).toHaveLength(0);
    expect(notifier.messages).toHaveLength(0);
    // Neither access remover runs — nothing to re-remove.
    expect(tv.removes).toHaveLength(0);
    expect(groups.calls).toHaveLength(0);
  });

  test("a second ENDED for an already-TRIAL_CANCELLED row does nothing at all", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        // What the first delivery of an unconverted trial left behind.
        status: "TRIAL_CANCELLED",
      })
    );
    const mailer = new RecordingMailer();
    const notifier = new RecordingNotifier();
    const log = new RecordingEventLog();
    const tv = new RecordingTradingView();
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, notifier, log, tv, groups
    );

    await lifecycle.apply({
      kind: "ENDED",
      stripeSubscriptionId: "sub_123",
      wasUnconvertedTrial: true,
    });

    expect(mailer.trialWinback).toHaveLength(0);
    expect(mailer.subscriptionEnded).toHaveLength(0);
    expect(store.patches).toHaveLength(0);
    expect(log.entries).toHaveLength(0);
    expect(notifier.messages).toHaveLength(0);
    expect(tv.removes).toHaveLength(0);
    expect(groups.calls).toHaveLength(0);
  });

  test("the FIRST delivery of a scheduled cancellation is unaffected", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        stripeSubscriptionId: "sub_123",
        status: "CANCELLATION_SCHEDULED",
      })
    );
    const mailer = new RecordingMailer();
    const log = new RecordingEventLog();
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, new RecordingNotifier(), log, new RecordingTradingView()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    // Still no email (they were confirmed at cancellation time) but the row is
    // written and the event logged — the guard must not swallow a real ENDED.
    expect(mailer.subscriptionEnded).toHaveLength(0);
    expect(store.patches).toContainEqual({ status: "CANCELLED" });
    expect(log.entries.map((e) => e.action)).toContain("ENDED");
  });
});

describe("ENDED — Telegram group removal", () => {
  /** FakeStore takes no constructor args — push onto `.rows`. */
  function storeWith(...subs: Subscriber[]): FakeStore {
    const store = new FakeStore();
    store.rows.push(...subs);
    return store;
  }

  it("removes the subscriber from their groups, passing every OTHER sheet row", async () => {
    const store = storeWith(
      makeSubscriber({ rowIndex: 2, stripeSubscriptionId: "sub_123", telegramUserId: "999" }),
      makeSubscriber({ rowIndex: 3, stripeSubscriptionId: "sub_456", email: "other@example.com" })
    );
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groups
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(groups.calls).toHaveLength(1);
    expect(groups.calls[0].telegramUserId).toBe("999");
    expect(groups.calls[0].telegramUsername).toBe("tanahkow");
    // The ending row itself is withheld — it must not entitle the markets it is
    // losing (see applyTelegramRemoval). Everything else goes through.
    expect(groups.calls[0].allSubscribers.map((s) => s.rowIndex)).toEqual([3]);
  });

  it("pings the outcome", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), new RecordingTelegramGroups()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const pings = notifier.messages.join("\n");
    expect(pings).toContain("Telegram groups");
    expect(pings).toContain("HK_MARKET");
  });

  it("marks the ping as a dry run when the remover is in dry-run mode", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), new RecordingTelegramGroups({ dryRun: true })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(notifier.messages.join("\n")).toContain("DRY RUN");
  });

  it("reports an unrecognised plan without removing anything", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({ reason: "unrecognised-plan", removed: [] })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const pings = notifier.messages.join("\n");
    expect(pings).toContain("unrecognised plan");
    expect(pings).not.toContain("removed from");
  });

  it("reports a blank Telegram User ID", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({ reason: "no-user-id", removed: [] })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(notifier.messages.join("\n")).toContain("no User ID");
  });

  it("does not fail the webhook when Telegram throws", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), new ThrowingTelegramGroups()
    );

    await expect(
      lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" })
    ).resolves.toBeUndefined();

    expect(notifier.messages.join("\n")).toContain("telegram is down");
    // FakeStore.applyUpdate records patches rather than mutating the row.
    expect(store.patches.some((p) => p.status === "CANCELLED")).toBe(true);
  });

  it("reports a blank Telegram username as its own case, removing nothing", async () => {
    const store = storeWith(
      makeSubscriber({
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        telegramUsername: "",
      })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({ reason: "no-username", removed: [] })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const pings = notifier.messages.join("\n");
    expect(pings).toContain("no username");
    expect(pings).toContain("tan@example.com"); // the only handle we have
    expect(pings).not.toContain("removed from");
  });

  it("raises a loud, separate alarm when a removal left the user banned", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({
        removed: ["HK_MARKET"],
        outstandingBans: ["HK_MARKET"],
        failures: ["HK_MARKET: BANNED BUT NOT UNBANNED — user 999 …"],
      })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const ping = notifier.messages.find((m) => m.includes("STILL BANNED"));
    expect(ping).toBeDefined();
    // On its own line with the user ID, so it can't be lost among the ordinary
    // failures — nothing else in the system can clear a permanent ban.
    expect(ping).toContain("unban by hand");
    expect(ping).toContain("HK_MARKET");
    expect(ping).toContain("999");
  });

  it("flags an identity mismatch prominently, and says col P may be wrong", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({
        removed: [],
        identityMismatches: [
          "HK_MARKET: sheet says @tanahkow, Telegram says @someoneelse",
        ],
      })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const ping = notifier.messages.find((m) => m.includes("identity mismatch"))!;
    expect(ping).toBeDefined();
    expect(ping).toContain("SKIPPED");
    expect(ping).toContain("@someoneelse");
    // The whole point of the line: it tells Joseph the row is suspect.
    expect(ping).toContain("Col P");
  });

  it("appends the dry-run config summary as a trailing line", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({ dryRun: true, configSummary: "5 groups, 0 whitelisted" })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(notifier.messages.join("\n")).toContain("5 groups, 0 whitelisted");
  });

  // ---------------------------------------------------------------------------
  // The durable record. The ping used to be the only trace of a removal, so a
  // Telegram outage made it invisible everywhere including Vercel's logs.
  // ---------------------------------------------------------------------------
  it("writes a TELEGRAM_REMOVED Status Log row alongside the ping", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const log = new RecordingEventLog();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), log,
      new RecordingTradingView(), new RecordingTelegramGroups()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const entry = log.entries.find((e) => e.action === "TELEGRAM_REMOVED")!;
    expect(entry).toBeDefined();
    expect(entry.email).toBe("tan@example.com");
    expect(entry.stripeSubscriptionId).toBe("sub_123");
    expect(entry.plan).toBe("US_HK");
    expect(entry.detail).toContain("HK_MARKET");
    // The ENDED row is still written too — this is an extra row, not a swap.
    expect(log.entries.map((e) => e.action)).toContain("ENDED");
  });

  it("prefixes the logged detail with 'dry run' in dry-run mode", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const log = new RecordingEventLog();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), log,
      new RecordingTradingView(), new RecordingTelegramGroups({ dryRun: true })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const entry = log.entries.find((e) => e.action === "TELEGRAM_REMOVED")!;
    expect(entry.detail).toMatch(/^dry run — /);
  });

  it("logs the short-circuits too — the remover ran, so it leaves a trace", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const log = new RecordingEventLog();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), log,
      new RecordingTradingView(),
      new RecordingTelegramGroups({ reason: "whitelisted", removed: [] })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const entry = log.entries.find((e) => e.action === "TELEGRAM_REMOVED")!;
    expect(entry.detail).toContain("whitelisted");
  });

  it("does not log a TELEGRAM_REMOVED row when the remover is not configured", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const log = new RecordingEventLog();
    // No remover injected → NoopTelegramGroupRemover, configured === false.
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), log, new RecordingTradingView()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(log.entries.map((e) => e.action)).not.toContain("TELEGRAM_REMOVED");
  });

  it("still pings when the Status Log append fails", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new FailingEventLog(),
      new RecordingTradingView(), new RecordingTelegramGroups()
    );

    await expect(
      lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" })
    ).resolves.toBeUndefined();

    expect(notifier.messages.join("\n")).toContain("HK_MARKET");
  });

  // ---------------------------------------------------------------------------
  // Pings go out with parse_mode HTML. An unescaped "<" in a hand-typed sheet
  // cell makes Telegram reject the ENTIRE message ("can't parse entities"), and
  // pingTv swallows that to console.error — so the alert is silently lost.
  // ---------------------------------------------------------------------------
  it("escapes HTML in a hand-typed Telegram username", async () => {
    const store = storeWith(
      makeSubscriber({
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        telegramUsername: "tan<b>ahkow",
      })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), new RecordingTelegramGroups()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const ping = notifier.messages.find((m) => m.includes("Telegram groups"))!;
    expect(ping).toContain("@tan&lt;b&gt;ahkow");
    expect(ping).not.toContain("@tan<b>ahkow");
    // Our own markup is untouched.
    expect(ping).toContain("<b>");
  });

  it("escapes HTML in a hand-typed TradingView username", async () => {
    const store = storeWith(
      makeSubscriber({
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        tradingViewUsername: "tan<i>ahkow",
      })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), new RecordingTelegramGroups()
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    // The applyTvAccess confirmation, not handleEnded's own summary ping.
    const ping = notifier.messages.find((m) => m.includes("🗑️ TradingView access removed"))!;
    expect(ping).toContain("@tan&lt;i&gt;ahkow");
    expect(ping).not.toContain("@tan<i>ahkow");
  });

  it("escapes HTML in a Telegram failure message", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({
        removed: [],
        failures: ["HK_MARKET: <html><head>502 Bad Gateway</head></html>"],
      })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const ping = notifier.messages.find((m) => m.includes("Failed"))!;
    expect(ping).toContain("&lt;html&gt;&lt;head&gt;502");
    expect(ping).not.toContain("<html>");
  });

  it("still works when no remover is injected (defaults to Noop)", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView()
    );

    await expect(
      lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" })
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // The ending row must never entitle the markets it is losing.
  //
  // These drive the REAL TelegramGroupApi over a stub fetch, because the point
  // is the entitlement arithmetic, not the shape of the input we hand it.
  // ---------------------------------------------------------------------------
  const REAL_GROUPS: GroupConfig[] = [
    { key: "HK_MARKET", chatId: -111, market: "HK" },
    { key: "US_MARKET", chatId: -222, market: "US" },
    { key: "MAIN_GROUP", chatId: -333, market: MAIN_MARKET },
  ];

  /** Everyone is a member of everything; every write succeeds. */
  function memberOfEverything() {
    const methods: string[] = [];
    const impl = (async (url: string | URL): Promise<Response> => {
      const method = String(url).split("/").pop()!;
      methods.push(method);
      const body =
        method === "getChatMember"
          ? { ok: true, result: { status: "member" } }
          : { ok: true, result: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, methods };
  }

  function realRemover(fetchImpl: typeof fetch) {
    return new TelegramGroupApi({
      token: "T",
      groups: REAL_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl,
    });
  }

  it("removes the ending row's own markets even if the sheet still reads it as ACTIVE", async () => {
    // handleEnded writes CANCELLED first, but FakeStore records patches without
    // mutating rows — which is exactly a stale read-after-write from Sheets.
    // The ending row must not be allowed to entitle what it is losing.
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        status: "ACTIVE",
        currentPlan: "US_HK",
      })
    );
    const notifier = new RecordingNotifier();
    const { impl } = memberOfEverything();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), realRemover(impl)
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    const ping = notifier.messages.find((m) => m.includes("Telegram groups"))!;
    expect(ping).toContain("HK_MARKET");
    expect(ping).toContain("US_MARKET");
    expect(ping).toContain("MAIN_GROUP");
    expect(ping).not.toContain("(nothing)");
  });

  it("still honours a second live subscription belonging to the same person", async () => {
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "999",
        status: "ACTIVE",
        currentPlan: "HK",
      }),
      makeSubscriber({
        rowIndex: 3,
        stripeSubscriptionId: "sub_456",
        telegramUserId: "999",
        status: "ACTIVE",
        currentPlan: "US",
      })
    );
    const notifier = new RecordingNotifier();
    const { impl } = memberOfEverything();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, notifier, new RecordingEventLog(),
      new RecordingTradingView(), realRemover(impl)
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    // Only the HK group goes. The live US row keeps US and the main group.
    const ping = notifier.messages.find((m) => m.includes("Telegram groups"))!;
    expect(ping).toContain("removed from:</b> HK_MARKET");
    expect(ping).not.toContain("US_MARKET");
    expect(ping).not.toContain("MAIN_GROUP");
  });
});

// -----------------------------------------------------------------------------
// Plan changes kick instantly too. Unlike ENDED (where the subject's own row is
// EXCLUDED from the entitlement maths), a plan change keeps the subscription
// live — so the row is INCLUDED, with its plan forced to the NEW value in
// memory, because a stale Sheets read still showing the OLD plan would re-grant
// exactly the markets being removed and no-op the kick.
// -----------------------------------------------------------------------------

describe("plan-change Telegram removal", () => {
  const periodStart = new Date("2026-07-09T10:00:00Z");
  const periodEnd = new Date("2026-10-09T10:00:00Z");

  /** FakeStore takes no constructor args — push onto `.rows`. */
  function storeWith(...subs: Subscriber[]): FakeStore {
    const store = new FakeStore();
    store.rows.push(...subs);
    return store;
  }

  it("PLAN_CHANGED (upgrade/switch) calls the remover with the subject row carrying the NEW plan", async () => {
    // FakeStore.applyUpdate records patches without mutating rows, so listAll
    // still yields the STALE old plan — exactly a Sheets read-after-write miss.
    // The kick must not depend on reading our own write back.
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "77",
        currentPlan: "US_HK",
      })
    );
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groups
    );

    await lifecycle.apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "US_SG_FXMC", // same quarterly price as US_HK → PLAN_SWITCH
      newSubscriptionPrice: 297,
      newCouponDiscount: false,
      newCouponCode: null,
    });

    expect(groups.calls).toHaveLength(1);
    expect(groups.calls[0].telegramUserId).toBe("77");
    // The store really is stale — listAll still says US_HK…
    expect(store.rows[0].currentPlan).toBe("US_HK");
    // …but the row handed to the remover carries the NEW plan (the in-memory
    // override), so the HK group is genuinely no longer entitled.
    const subject = groups.calls[0].allSubscribers.find((s) => s.rowIndex === 2)!;
    expect(subject).toBeDefined();
    expect(subject.currentPlan).toBe("US_SG_FXMC");
  });

  it("PLAN_CHANGED downgrade-executed path also kicks", async () => {
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "77",
        currentPlan: "ALL_MARKETS",
      })
    );
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groups
    );

    await lifecycle.apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "HK", // cheaper → DOWNGRADED (email deferred; the kick is not)
      newSubscriptionPrice: 168,
      newCouponDiscount: false,
      newCouponCode: null,
    });

    expect(groups.calls).toHaveLength(1);
    const subject = groups.calls[0].allSubscribers.find((s) => s.rowIndex === 2)!;
    expect(subject).toBeDefined();
    expect(subject.currentPlan).toBe("HK");
  });

  it("PLAN_CHANGED same-plan price sync does NOT kick", async () => {
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "77",
        currentPlan: "US_HK",
        subscriptionPrice: 99,
      })
    );
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groups
    );

    await lifecycle.apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "US_HK", // same plan — a price-ID migration only
      newSubscriptionPrice: 297,
      newCouponDiscount: false,
      newCouponCode: null,
    });

    expect(groups.calls).toHaveLength(0);
  });

  it("RENEWED applying a period-boundary plan change kicks once; the marker-confirm path does not double-kick", async () => {
    // Case A — invoice-first: the sheet still shows the OLD plan, so this
    // RENEWED applies the plan change itself and must kick.
    const storeA = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "77",
        currentPlan: "ALL_MARKETS",
      })
    );
    const groupsA = new RecordingTelegramGroups();
    const lifecycleA = new SubscriptionLifecycle(
      storeA, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groupsA
    );

    await lifecycleA.apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "HK",
      subscriptionPrice: 168,
      couponDiscount: false,
      couponCode: null,
    });

    expect(groupsA.calls).toHaveLength(1);
    const subjectA = groupsA.calls[0].allSubscribers.find((s) => s.rowIndex === 2)!;
    expect(subjectA).toBeDefined();
    expect(subjectA.currentPlan).toBe("HK");

    // Case B — items-first: handlePlanChanged already wrote the new plan and
    // kicked, leaving the DOWNGRADE_EXECUTED marker. This RENEWED only
    // confirms payment and must NOT kick a second time.
    const storeB = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "77",
        currentPlan: "HK",
        previousPlan: "ALL_MARKETS",
        latestAction: "DOWNGRADE_EXECUTED",
      })
    );
    const groupsB = new RecordingTelegramGroups();
    const lifecycleB = new SubscriptionLifecycle(
      storeB, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groupsB
    );

    await lifecycleB.apply({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart,
      periodEnd,
      planType: "HK",
      subscriptionPrice: 168,
      couponDiscount: false,
      couponCode: null,
    });

    expect(groupsB.calls).toHaveLength(0);
  });

  it("overrides ONLY the subject row — a comp row for the same person passes through untouched", async () => {
    // Same person, two rows: the paid sub being switched, plus a comp row
    // (blank Stripe Sub ID = the comp marker) on ALL_MARKETS. The override
    // must pin the subject row alone; the comp keeps entitling its markets.
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "77",
        currentPlan: "US_HK",
      }),
      makeSubscriber({
        rowIndex: 5,
        stripeSubscriptionId: "",
        telegramUserId: "77",
        currentPlan: "ALL_MARKETS",
      })
    );
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groups
    );

    await lifecycle.apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "US_SG_FXMC", // drops HK → not a superset, so the pass runs
      newSubscriptionPrice: 297,
      newCouponDiscount: false,
      newCouponCode: null,
    });

    expect(groups.calls).toHaveLength(1);
    const rows = groups.calls[0].allSubscribers;
    expect(rows.find((s) => s.rowIndex === 2)!.currentPlan).toBe("US_SG_FXMC");
    expect(rows.find((s) => s.rowIndex === 5)!.currentPlan).toBe("ALL_MARKETS");
  });

  it("skips the removal pass entirely on an upgrade (new plan covers every old market)", async () => {
    // US → ALL_MARKETS loses nothing, so there is no kick to compute — no
    // "removed: (nothing)" ping, and no false "no User ID" short-circuit for
    // an upgrader with a blank col P.
    const store = storeWith(
      makeSubscriber({
        rowIndex: 2,
        stripeSubscriptionId: "sub_123",
        telegramUserId: "",
        currentPlan: "US",
      })
    );
    const groups = new RecordingTelegramGroups();
    const lifecycle = new SubscriptionLifecycle(
      store, noopMailer, new RecordingNotifier(), new RecordingEventLog(),
      new RecordingTradingView(), groups
    );

    await lifecycle.apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "ALL_MARKETS", // dearer → UPGRADED, and a strict superset
      newSubscriptionPrice: 417,
      newCouponDiscount: false,
      newCouponCode: null,
    });

    expect(groups.calls).toHaveLength(0);
  });
});

// =============================================================================
// COUPON SYNC
// =============================================================================
// The Pepperstone discount is a fixed amount per tier ($21 single / $30 combo +
// All Markets), so a move across that boundary needs the coupon swapped. These
// tests assert the lifecycle ASKS for the sync at the right moments and with
// the right target plan — the swap logic itself is unit-tested in
// coupon-sync.test.ts, and the Stripe calls in coupon-sync-stripe.ts.
// =============================================================================

class RecordingCouponManager implements CouponManager {
  readonly configured = true;
  calls: Array<{ subscriptionId: string; planType: string }> = [];
  constructor(private readonly behaviour: "ok" | "throw" = "ok") {}

  async sync(subscriptionId: string, planType: string): Promise<CouponSyncResult> {
    this.calls.push({ subscriptionId, planType });
    if (this.behaviour === "throw") throw new Error("Stripe is down");
    return {
      applied: true,
      dryRun: false,
      route: "schedule",
      summary: "NAV30 → NAV21",
      blockers: [],
      destroyed: false,
    };
  }
}

function buildWithCoupons(
  store: FakeStore,
  log: EventLog,
  coupons: CouponManager
) {
  return new SubscriptionLifecycle(
    store,
    noopMailer,
    new RecordingNotifier(),
    log,
    new RecordingTradingView(),
    new NoopTelegramGroupRemover(),
    coupons
  );
}

describe("coupon sync", () => {
  test("DOWNGRADE_SCHEDULED syncs against the PENDING plan, not the current one", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "ALL_MARKETS" }));
    const coupons = new RecordingCouponManager();

    await buildWithCoupons(store, new RecordingEventLog(), coupons).apply({
      kind: "DOWNGRADE_SCHEDULED",
      stripeSubscriptionId: "sub_123",
      currentPlanType: "ALL_MARKETS",
      pendingPlanType: "US",
      periodEnd: Math.floor(Date.UTC(2026, 8, 1) / 1000),
    });

    // The coupon must follow the plan they are moving TO. Syncing against
    // ALL_MARKETS here would leave NAV30 on a single-market plan forever.
    expect(coupons.calls).toEqual([{ subscriptionId: "sub_123", planType: "US" }]);
  });

  test("PLAN_CHANGED (immediate upgrade) syncs against the new plan", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "US" }));
    const coupons = new RecordingCouponManager();

    await buildWithCoupons(store, new RecordingEventLog(), coupons).apply({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_123",
      newPlanType: "ALL_MARKETS",
      newSubscriptionPrice: 417,
      newCouponDiscount: true,
      newCouponCode: "NAV21",
    });

    // An upgrade is immediate and there is no UPGRADE_SCHEDULED event, so this
    // is the only chance to move NAV21 → NAV30.
    expect(coupons.calls).toEqual([
      { subscriptionId: "sub_123", planType: "ALL_MARKETS" },
    ]);
  });

  // Live gap found by /coupon-audit 2026-08-12: matthew.ooi92 scheduled
  // ALL_MARKETS → US (sync correctly wrote NAV21 into the phases, which
  // propagates to the sub level), then RELEASED the schedule. Nothing re-synced,
  // so an All Markets subscription sat on NAV21 — $9/qtr under-discounted for as
  // long as they keep paying.
  test("DOWNGRADE_UNDONE syncs back to the plan they are keeping", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "ALL_MARKETS" }));
    const coupons = new RecordingCouponManager();

    await buildWithCoupons(store, new RecordingEventLog(), coupons).apply({
      kind: "DOWNGRADE_UNDONE",
      stripeSubscriptionId: "sub_123",
      currentPlanType: "ALL_MARKETS",
      pendingPlanType: "US",
    });

    // Sync against the plan that survives, NOT the cancelled target — the
    // DOWNGRADE_SCHEDULED sync already moved the coupon down to US.
    expect(coupons.calls).toEqual([
      { subscriptionId: "sub_123", planType: "ALL_MARKETS" },
    ]);
  });

  test("a failing coupon sync never fails the webhook", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "ALL_MARKETS" }));
    const coupons = new RecordingCouponManager("throw");

    await expect(
      buildWithCoupons(store, new RecordingEventLog(), coupons).apply({
        kind: "DOWNGRADE_SCHEDULED",
        stripeSubscriptionId: "sub_123",
        currentPlanType: "ALL_MARKETS",
        pendingPlanType: "US",
        periodEnd: Math.floor(Date.UTC(2026, 8, 1) / 1000),
      })
    ).resolves.toBeUndefined();

    expect(coupons.calls).toHaveLength(1);
  });

  test("an unconfigured manager is skipped entirely", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ currentPlan: "ALL_MARKETS" }));
    const noop = new NoopCouponManager();
    let called = false;
    const spy: CouponManager = {
      configured: false,
      async sync() {
        called = true;
        return noop.sync();
      },
    };

    await buildWithCoupons(store, new RecordingEventLog(), spy).apply({
      kind: "DOWNGRADE_SCHEDULED",
      stripeSubscriptionId: "sub_123",
      currentPlanType: "ALL_MARKETS",
      pendingPlanType: "US",
      periodEnd: Math.floor(Date.UTC(2026, 8, 1) / 1000),
    });

    expect(called).toBe(false);
  });
});

// =============================================================================
// Deferred trial welcome — live incident 2026-08-09/10. Stripe flipped the
// 25 July cohort trialing → active at 23:59 but charged at ~01:00, so the
// paid-invoice guard suppressed all 20 welcome emails. The unpaid flip now
// leaves a TRIAL_CONVERSION_PENDING marker in Latest Action; the RENEWED that
// fires when the charge lands sees the marker and sends the welcome — after
// checking the Status Log so a welcome already sent (webhook or the manual
// send-missed-trial-welcomes script) is never repeated.
// =============================================================================
describe("deferred trial welcome (charge lands after the flip)", () => {
  class DeferredEventLog implements EventLog {
    entries: EventLogEntry[] = [];
    async record(entry: EventLogEntry): Promise<void> {
      this.entries.push(entry);
    }
    async hasRecorded(stripeSubscriptionId: string, action: string): Promise<boolean> {
      return this.entries.some(
        (e) => e.stripeSubscriptionId === stripeSubscriptionId && e.action === action
      );
    }
  }

  class ThrowingHasRecordedLog extends DeferredEventLog {
    override async hasRecorded(): Promise<boolean> {
      throw new Error("sheets read blew up");
    }
  }

  const renewed = (overrides: Record<string, unknown> = {}) =>
    ({
      kind: "RENEWED",
      stripeSubscriptionId: "sub_123",
      periodStart: new Date("2026-08-09T15:59:00Z"),
      periodEnd: new Date("2026-11-09T15:59:00Z"),
      planType: "US_HK",
      subscriptionPrice: 267,
      couponDiscount: false,
      couponCode: "",
      ...overrides,
    }) as Parameters<SubscriptionLifecycle["apply"]>[0];

  function buildDeferred(row: Subscriber, log: EventLog = new DeferredEventLog()) {
    const store = new FakeStore();
    store.rows = [row];
    const mailer = new RecordingMailer();
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store,
      mailer,
      notifier,
      log,
      new RecordingTradingView()
    );
    return { store, mailer, notifier, lifecycle, log };
  }

  test("TRIAL_CONVERSION_PENDING writes the marker, keeps status, sends no email", async () => {
    const row = makeSubscriber({
      status: "TRIAL_ACTIVE",
      latestAction: "START_TRIAL",
      currentPlan: "US_HK",
    });
    const log = new DeferredEventLog();
    const { mailer, lifecycle, store } = buildDeferred(row, log);

    await lifecycle.apply({
      kind: "TRIAL_CONVERSION_PENDING",
      stripeSubscriptionId: "sub_123",
    } as Parameters<SubscriptionLifecycle["apply"]>[0]);

    expect(store.patches).toHaveLength(1);
    expect(store.patches[0]).toMatchObject({ latestAction: "TRIAL_CONVERSION_PENDING" });
    expect(store.patches[0]).not.toHaveProperty("status");
    expect(mailer.trialConverted).toHaveLength(0);
    expect(log.entries.map((e) => e.action)).toContain("TRIAL_CONVERSION_PENDING");
  });

  test("RENEWED with the marker sends the welcome and logs TRIAL_CONVERTED", async () => {
    const row = makeSubscriber({
      status: "TRIAL_ACTIVE",
      latestAction: "TRIAL_CONVERSION_PENDING",
      currentPlan: "US_HK",
    });
    const log = new DeferredEventLog();
    const { mailer, lifecycle } = buildDeferred(row, log);

    await lifecycle.apply(renewed());

    expect(mailer.trialConverted).toHaveLength(1);
    expect(mailer.trialConverted[0].planType).toBe("US_HK");
    expect(log.entries.map((e) => e.action)).toContain("TRIAL_CONVERTED");
  });

  test("RENEWED with the marker does NOT re-send when the Status Log already has TRIAL_CONVERTED", async () => {
    const row = makeSubscriber({
      status: "TRIAL_ACTIVE",
      latestAction: "TRIAL_CONVERSION_PENDING",
      currentPlan: "US_HK",
    });
    const log = new DeferredEventLog();
    // The manual send-missed-trial-welcomes script already welcomed this sub.
    log.entries.push({
      email: "tan@example.com",
      stripeSubscriptionId: "sub_123",
      action: "TRIAL_CONVERTED",
    });
    const { mailer, lifecycle } = buildDeferred(row, log);

    await lifecycle.apply(renewed());

    expect(mailer.trialConverted).toHaveLength(0);
    expect(
      log.entries.filter((e) => e.action === "TRIAL_CONVERTED")
    ).toHaveLength(1);
  });

  test("RENEWED that confirms a boundary plan change welcomes with the NEW plan", async () => {
    const row = makeSubscriber({
      status: "TRIAL_ACTIVE",
      latestAction: "TRIAL_CONVERSION_PENDING",
      currentPlan: "ALL_MARKETS",
    });
    const log = new DeferredEventLog();
    const { mailer, lifecycle } = buildDeferred(row, log);

    await lifecycle.apply(renewed({ planType: "US", subscriptionPrice: 147 }));

    expect(mailer.trialConverted).toHaveLength(1);
    expect(mailer.trialConverted[0].planType).toBe("US");
  });

  test("RENEWED without the marker never sends a welcome", async () => {
    const row = makeSubscriber({
      status: "ACTIVE",
      latestAction: "RENEWAL",
      currentPlan: "US_HK",
    });
    const log = new DeferredEventLog();
    const { mailer, lifecycle } = buildDeferred(row, log);

    await lifecycle.apply(renewed());

    expect(mailer.trialConverted).toHaveLength(0);
  });

  test("a Status Log read failure withholds the welcome and pings instead of risking a double-send", async () => {
    const row = makeSubscriber({
      status: "TRIAL_ACTIVE",
      latestAction: "TRIAL_CONVERSION_PENDING",
      currentPlan: "US_HK",
    });
    const log = new ThrowingHasRecordedLog();
    const { mailer, notifier, lifecycle, store } = buildDeferred(row, log);

    await lifecycle.apply(renewed());

    expect(mailer.trialConverted).toHaveLength(0);
    // The renewal bookkeeping itself must still have gone through.
    expect(store.patches.length).toBeGreaterThan(0);
    expect(notifier.messages.join("\n")).toMatch(/welcome/i);
  });
});
