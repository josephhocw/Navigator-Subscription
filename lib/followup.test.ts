import { describe, it, expect } from "vitest";
import {
  selectFollowupRecipients,
  runFollowupSend,
  parseDisplayDateSGT,
  FOLLOWUP_MIN_DAYS,
  FOLLOWUP_MAX_DAYS,
  type FollowupMailer,
} from "./followup.js";
import type { Subscriber, SubscriberStore, SubscriberPatch } from "./subscriber-store.js";
import { formatDisplayDateSGT } from "./format-date.js";

// A fixed "now" so the day-window maths is deterministic.
const NOW = new Date("2026-07-23T04:00:00+08:00");

// Build a Subscription Start display string exactly `days` before NOW.
function startedDaysAgo(days: number): string {
  return formatDisplayDateSGT(new Date(NOW.getTime() - days * 86_400_000));
}

function row(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    rowIndex: 2,
    email: "a@example.com",
    customerName: "Alex",
    tradingViewUsername: "alex_tv",
    telegramUsername: "alex_tg",
    status: "ACTIVE",
    currentPlan: "US",
    latestAction: "NEW_SUBSCRIPTION",
    previousPlan: "",
    subscriptionPrice: 168,
    couponDiscount: false,
    subscriptionStart: startedDaysAgo(FOLLOWUP_MIN_DAYS),
    subscriptionExpiry: "",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_1",
    telegramUserId: "",
    referralSource: "",
    followupSent: "",
    ...overrides,
  };
}

describe("parseDisplayDateSGT", () => {
  it("round-trips the system display format", () => {
    const d = new Date("2026-04-16T18:00:00+08:00");
    const parsed = parseDisplayDateSGT(formatDisplayDateSGT(d));
    expect(parsed?.getTime()).toBe(d.getTime());
  });

  it("returns null on blank or malformed input", () => {
    expect(parseDisplayDateSGT("")).toBeNull();
    expect(parseDisplayDateSGT("not a date")).toBeNull();
    expect(parseDisplayDateSGT("16 Foo 2026 18:00")).toBeNull();
  });
});

describe("selectFollowupRecipients", () => {
  it("selects a brand-new, active subscriber inside the window", () => {
    const out = selectFollowupRecipients([row()], NOW);
    expect(out.map((r) => r.email)).toEqual(["a@example.com"]);
  });

  it("includes the window boundaries (min and max days)", () => {
    const min = row({ email: "min@x.com", subscriptionStart: startedDaysAgo(FOLLOWUP_MIN_DAYS) });
    const max = row({ email: "max@x.com", subscriptionStart: startedDaysAgo(FOLLOWUP_MAX_DAYS) });
    const out = selectFollowupRecipients([min, max], NOW);
    expect(out.map((r) => r.email).sort()).toEqual(["max@x.com", "min@x.com"]);
  });

  it("excludes anyone too recent (< min days)", () => {
    const out = selectFollowupRecipients([row({ subscriptionStart: startedDaysAgo(1) })], NOW);
    expect(out).toHaveLength(0);
  });

  it("excludes anyone too old (> max days) so the first run skips the back catalogue", () => {
    const out = selectFollowupRecipients([row({ subscriptionStart: startedDaysAgo(20) })], NOW);
    expect(out).toHaveLength(0);
  });

  it("excludes anyone already sent (col U set)", () => {
    const out = selectFollowupRecipients([row({ followupSent: "20 July 2026 04:00" })], NOW);
    expect(out).toHaveLength(0);
  });

  it("excludes renewals (subscriptionCount >= 2) even inside the window", () => {
    const out = selectFollowupRecipients([row({ subscriptionCount: 2 })], NOW);
    expect(out).toHaveLength(0);
  });

  it("excludes non-active statuses", () => {
    for (const status of ["PAYMENT_FAILED", "CANCELLATION_SCHEDULED", "CANCELLED"]) {
      expect(selectFollowupRecipients([row({ status })], NOW)).toHaveLength(0);
    }
  });

  it("excludes rows with a blank email or unparseable start date", () => {
    expect(selectFollowupRecipients([row({ email: "" })], NOW)).toHaveLength(0);
    expect(selectFollowupRecipients([row({ subscriptionStart: "" })], NOW)).toHaveLength(0);
  });
});

// --- runFollowupSend ---

class FakeStore implements SubscriberStore {
  updates: Array<{ email: string; patch: SubscriberPatch }> = [];
  constructor(private rows: Subscriber[]) {}
  listAll = async () => this.rows;
  applyUpdate = async (sub: Subscriber, patch: SubscriberPatch) => {
    this.updates.push({ email: sub.email, patch });
  };
  findByEmail = async () => null;
  findBySubscriptionId = async () => null;
  findByTradingViewUsername = async () => null;
  findByTelegramUsername = async () => null;
  appendNew = async () => {};
}

describe("runFollowupSend", () => {
  it("sends to eligible subscribers and stamps col U", async () => {
    const store = new FakeStore([
      row({ email: "new@x.com" }),
      row({ email: "old@x.com", subscriptionStart: startedDaysAgo(60) }),
    ]);
    const sent: string[] = [];
    const mailer: FollowupMailer = {
      sendFollowup: async ({ email }) => void sent.push(email),
    };

    const summary = await runFollowupSend(store, mailer, NOW);

    expect(sent).toEqual(["new@x.com"]);
    expect(summary.sent).toBe(1);
    expect(summary.eligible).toBe(1);
    expect(summary.considered).toBe(2);
    expect(store.updates).toEqual([
      { email: "new@x.com", patch: { followupSent: formatDisplayDateSGT(NOW) } },
    ]);
  });

  it("does NOT mark col U when the send fails (send-then-mark), and records the failure", async () => {
    const store = new FakeStore([row({ email: "boom@x.com" })]);
    const mailer: FollowupMailer = {
      sendFollowup: async () => {
        throw new Error("resend down");
      },
    };

    const summary = await runFollowupSend(store, mailer, NOW);

    expect(summary.sent).toBe(0);
    expect(summary.failures).toEqual(["boom@x.com: resend down"]);
    expect(store.updates).toHaveLength(0); // never marked → retried next run
  });
});
