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
        mobileNumber: data.mobileNumber ?? "",
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
    expect(store.patches).toContainEqual({ status: "CANCELLED" });
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

describe("ENDED — Telegram group removal", () => {
  /** FakeStore takes no constructor args — push onto `.rows`. */
  function storeWith(...subs: Subscriber[]): FakeStore {
    const store = new FakeStore();
    store.rows.push(...subs);
    return store;
  }

  it("removes the subscriber from their groups, passing every sheet row", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
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
    expect(groups.calls[0].allSubscribers).toHaveLength(1);
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
});
