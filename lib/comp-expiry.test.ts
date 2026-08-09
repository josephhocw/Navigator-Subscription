import { describe, test, expect } from "vitest";
import {
  parseDisplayDateSGT,
  isComp,
  findExpiredComps,
  expireDueComps,
} from "./comp-expiry.js";
import type {
  Subscriber,
  SubscriberStore,
  SubscriberPatch,
  NewSubscriberData,
} from "./subscriber-store.js";
import type { EventLog, EventLogEntry } from "./event-log.js";

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

function makeSubscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    rowIndex: 2,
    email: "comp@example.com",
    customerName: "Comp Person",
    tradingViewUsername: "compuser",
    telegramUsername: "compuser",
    status: "ACTIVE",
    currentPlan: "ALL_MARKETS",
    latestAction: "COMP_GRANTED",
    previousPlan: "",
    subscriptionPrice: 0,
    couponDiscount: false,
    couponCode: "",
    subscriptionStart: "14 July 2026 14:35",
    subscriptionExpiry: "14 September 2026 23:59",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "", // blank → comp
    telegramUserId: "123",
    referralSource: "",
    followupSent: "",
    mobileNumber: "",
    ...overrides,
  };
}

class FakeStore implements SubscriberStore {
  rows: Subscriber[];
  applied: Array<{ row: Subscriber; patch: SubscriberPatch }> = [];
  failOnEmail?: string;
  constructor(rows: Subscriber[]) {
    this.rows = rows;
  }
  async findByEmail(): Promise<Subscriber | null> { return null; }
  async findBySubscriptionId(): Promise<Subscriber | null> { return null; }
  async findByTradingViewUsername(): Promise<Subscriber | null> { return null; }
  async findByTelegramUsername(): Promise<Subscriber | null> { return null; }
  async appendNew(_: NewSubscriberData): Promise<void> {}
  async applyUpdate(subscriber: Subscriber, patch: SubscriberPatch): Promise<void> {
    if (this.failOnEmail && subscriber.email === this.failOnEmail) {
      throw new Error("sheet write blew up");
    }
    this.applied.push({ row: subscriber, patch });
  }
  async listAll(): Promise<Subscriber[]> { return this.rows; }
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

// A fixed "now" for deterministic expiry tests: 15 Sep 2026 03:00 SGT.
const NOW = parseDisplayDateSGT("15 September 2026 03:00")!;

// -----------------------------------------------------------------------------
// parseDisplayDateSGT
// -----------------------------------------------------------------------------

describe("parseDisplayDateSGT", () => {
  test("parses a display date as Singapore time (UTC+8)", () => {
    // 23:59 SGT on 14 Sep is 15:59 UTC on 14 Sep.
    expect(parseDisplayDateSGT("14 September 2026 23:59")!.toISOString()).toBe(
      "2026-09-14T15:59:00.000Z"
    );
  });

  test("midnight SGT rolls back to the previous UTC day", () => {
    expect(parseDisplayDateSGT("1 January 2026 00:00")!.toISOString()).toBe(
      "2025-12-31T16:00:00.000Z"
    );
  });

  test("returns null on a malformed or empty string (never silently 'past')", () => {
    expect(parseDisplayDateSGT("")).toBeNull();
    expect(parseDisplayDateSGT(undefined)).toBeNull();
    expect(parseDisplayDateSGT("not a date")).toBeNull();
    expect(parseDisplayDateSGT("14 Setember 2026 23:59")).toBeNull(); // bad month
    expect(parseDisplayDateSGT("2026-09-14")).toBeNull(); // wrong format
  });
});

// -----------------------------------------------------------------------------
// isComp / findExpiredComps
// -----------------------------------------------------------------------------

describe("findExpiredComps", () => {
  test("a comp past its expiry is returned", () => {
    const s = makeSubscriber({ subscriptionExpiry: "14 September 2026 23:59" });
    expect(findExpiredComps([s], NOW)).toEqual([s]);
  });

  test("a comp whose expiry is still in the future is left alone", () => {
    const s = makeSubscriber({ subscriptionExpiry: "14 October 2026 23:59" });
    expect(findExpiredComps([s], NOW)).toEqual([]);
  });

  test("a PAID subscriber with a past period-end is never expired (has a Stripe sub ID)", () => {
    const paid = makeSubscriber({
      stripeSubscriptionId: "sub_123",
      subscriptionExpiry: "14 September 2026 23:59",
    });
    expect(isComp(paid)).toBe(false);
    expect(findExpiredComps([paid], NOW)).toEqual([]);
  });

  test("an already-CANCELLED comp is not expired again", () => {
    const s = makeSubscriber({ status: "CANCELLED" });
    expect(findExpiredComps([s], NOW)).toEqual([]);
  });

  test("a comp with a blank/unparseable expiry is left alone", () => {
    expect(findExpiredComps([makeSubscriber({ subscriptionExpiry: "" })], NOW)).toEqual([]);
    expect(findExpiredComps([makeSubscriber({ subscriptionExpiry: "soon" })], NOW)).toEqual([]);
  });

  test("a blank/junk row (no plan) is ignored even with a past date", () => {
    const junk = makeSubscriber({ currentPlan: "", subscriptionExpiry: "14 September 2026 23:59" });
    expect(findExpiredComps([junk], NOW)).toEqual([]);
  });

  test("CANCELLATION_SCHEDULED and PAYMENT_FAILED comps still expire", () => {
    const sched = makeSubscriber({ status: "CANCELLATION_SCHEDULED", email: "a@x.com" });
    const failed = makeSubscriber({ status: "PAYMENT_FAILED", email: "b@x.com" });
    expect(findExpiredComps([sched, failed], NOW)).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// expireDueComps
// -----------------------------------------------------------------------------

describe("expireDueComps", () => {
  test("flips due comps to CANCELLED, logs, and returns them; leaves others untouched", async () => {
    const due = makeSubscriber({ email: "eric@x.com", tradingViewUsername: "ekohcw" });
    const future = makeSubscriber({
      email: "future@x.com",
      subscriptionExpiry: "14 December 2026 23:59",
    });
    const paid = makeSubscriber({ email: "paid@x.com", stripeSubscriptionId: "sub_1" });
    const store = new FakeStore([due, future, paid]);
    const log = new RecordingEventLog();

    const result = await expireDueComps(store, NOW, log);

    expect(store.applied).toHaveLength(1);
    expect(store.applied[0].row.email).toBe("eric@x.com");
    expect(store.applied[0].patch).toEqual({
      status: "CANCELLED",
      latestAction: "COMP_EXPIRED",
    });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].action).toBe("COMP_EXPIRED");
    expect(result.expired).toEqual([
      { email: "eric@x.com", tradingViewUsername: "ekohcw", plan: "ALL_MARKETS", expiry: "14 September 2026 23:59" },
    ]);
    expect(result.failures).toEqual([]);
  });

  test("one row's write failure is collected, not thrown, and the rest continue", async () => {
    const bad = makeSubscriber({ email: "bad@x.com" });
    const good = makeSubscriber({ email: "good@x.com" });
    const store = new FakeStore([bad, good]);
    store.failOnEmail = "bad@x.com";

    const result = await expireDueComps(store, NOW);

    expect(result.expired.map((e) => e.email)).toEqual(["good@x.com"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("bad@x.com");
  });
});
