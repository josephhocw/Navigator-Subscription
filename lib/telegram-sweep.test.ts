import { describe, it, expect } from "vitest";
import { runTelegramSweep, type SweepDeps } from "./telegram-sweep.js";
import type { RemovalInput, RemovalResult, TelegramGroupRemover } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

let nextRow = 2;
function row(over: Partial<Subscriber>): Subscriber {
  return {
    rowIndex: nextRow++, email: "x@example.com", customerName: "", tradingViewUsername: "",
    telegramUsername: "", status: "ACTIVE", currentPlan: "", latestAction: "", previousPlan: "",
    subscriptionPrice: 0, couponDiscount: false, couponCode: "", subscriptionStart: "", subscriptionExpiry: "",
    subscriptionCount: 1, failedPaymentCount: 0, stripeSubscriptionId: "sub_x",
    telegramUserId: "", referralSource: "", followupSent: "", mobileNumber: "", ...over,
  };
}

function emptyResult(over: Partial<RemovalResult> = {}): RemovalResult {
  return {
    removed: [], skipped: [], failures: [], outstandingBans: [],
    identityMismatches: [], dryRun: false, ...over,
  };
}

function recordingRemover(results: Record<string, RemovalResult>): {
  remover: TelegramGroupRemover; calls: RemovalInput[];
} {
  const calls: RemovalInput[] = [];
  return {
    calls,
    remover: {
      configured: true,
      async removeFromGroups(input) {
        calls.push(input);
        return results[input.telegramUsername.toLowerCase()] ?? emptyResult();
      },
    },
  };
}

function makeDeps(all: Subscriber[], remover: TelegramGroupRemover, over: Partial<SweepDeps> = {}) {
  const pings: string[] = [];
  const logs: Array<{ email: string; action: string; detail?: string }> = [];
  const deps: SweepDeps = {
    listAll: async () => all,
    remover,
    notify: async (m) => { pings.push(m); },
    recordLog: async (e) => { logs.push(e); },
    ...over,
  };
  return { deps, pings, logs };
}

describe("runTelegramSweep", () => {
  it("processes each distinct username once, using the first non-blank col-P ID", async () => {
    const a = row({ telegramUsername: "joe", telegramUserId: "", currentPlan: "US" });
    const b = row({ telegramUsername: "@Joe", telegramUserId: "111", currentPlan: "HK" });
    const c = row({ telegramUsername: "ann", telegramUserId: "222", currentPlan: "SG" });
    const { remover, calls } = recordingRemover({});
    // Fixed clock (day-index 0 -> rotation offset 0) so this test asserts the
    // "first non-blank ID wins" selection, independent of the day-rotation
    // feature covered separately below.
    const { deps } = makeDeps([a, b, c], remover, { now: () => 0 });
    const summary = await runTelegramSweep(deps);
    expect(calls.map((i) => [i.telegramUsername.toLowerCase().replace(/^@/, ""), i.telegramUserId])).toEqual([
      ["joe", "111"],
      ["ann", "222"],
    ]);
    expect(summary.usersChecked).toBe(2);
  });

  it("skips usernames with no col-P ID anywhere (nobody to kick)", async () => {
    const a = row({ telegramUsername: "joe", telegramUserId: "" });
    const { remover, calls } = recordingRemover({});
    const { deps } = makeDeps([a], remover);
    await runTelegramSweep(deps);
    expect(calls).toEqual([]);
  });

  it("aggregates removals into the summary, Status Log and ping", async () => {
    const a = row({ telegramUsername: "gone", telegramUserId: "9", status: "CANCELLED", email: "gone@x.com" });
    const { remover } = recordingRemover({
      gone: emptyResult({ removed: ["US_MARKET", "MAIN_GROUP"] }),
    });
    const { deps, pings, logs } = makeDeps([a], remover);
    const summary = await runTelegramSweep(deps);
    expect(summary.removed).toEqual([{ username: "gone", groups: ["US_MARKET", "MAIN_GROUP"] }]);
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe("TELEGRAM_REMOVED");
    expect(logs[0].email).toBe("gone@x.com");
    expect(pings.length).toBe(1);
    expect(pings[0]).toContain("gone");
  });

  it("stays quiet when nothing happened", async () => {
    const a = row({ telegramUsername: "fine", telegramUserId: "9", currentPlan: "US" });
    const { remover } = recordingRemover({ fine: emptyResult({ skipped: ["HK_MARKET"] }) });
    const { deps, pings, logs } = makeDeps([a], remover);
    await runTelegramSweep(deps);
    expect(pings).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("collects unrecognised-plan flags, mismatches, failures and still-banned into the ping", async () => {
    const a = row({ telegramUsername: "odd", telegramUserId: "1", email: "odd@x.com" });
    const b = row({ telegramUsername: "bad", telegramUserId: "2", email: "bad@x.com" });
    const { remover } = recordingRemover({
      odd: emptyResult({ reason: "unrecognised-plan" }),
      bad: emptyResult({
        removed: ["US_MARKET"],
        failures: ["HK_MARKET: boom"],
        identityMismatches: ["SG_MARKET: sheet says @bad, Telegram says @worse"],
        outstandingBans: ["US_MARKET"],
      }),
    });
    const { deps, pings } = makeDeps([a, b], remover);
    const summary = await runTelegramSweep(deps);
    expect(summary.unrecognised).toEqual(["odd"]);
    expect(summary.failures).toEqual(["bad — HK_MARKET: boom"]);
    expect(summary.mismatches).toEqual(["bad — SG_MARKET: sheet says @bad, Telegram says @worse"]);
    expect(summary.stillBanned).toEqual(["bad — US_MARKET"]);
    expect(pings.length).toBe(1);
    expect(pings[0]).toContain("STILL BANNED");
  });

  it("stops at the time budget, marks the run partial, and says so in the ping", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ telegramUsername: `u${i}`, telegramUserId: String(i + 1) })
    );
    let clock = 0;
    const { remover, calls } = recordingRemover({});
    const { deps, pings } = makeDeps(rows, remover, {
      timeBudgetMs: 100,
      now: () => { clock += 60; return clock; },
    });
    const summary = await runTelegramSweep(deps);
    expect(summary.partial).toBe(true);
    expect(calls.length).toBeLessThan(5);
    expect(pings.some((p) => p.includes("partial"))).toBe(true);
  });

  it("one user's error does not abort the run", async () => {
    const a = row({ telegramUsername: "boom", telegramUserId: "1", email: "boom@x.com" });
    const b = row({ telegramUsername: "fine", telegramUserId: "2", status: "CANCELLED", email: "fine@x.com" });
    const throwing: TelegramGroupRemover = {
      configured: true,
      async removeFromGroups(input) {
        if (input.telegramUsername === "boom") throw new Error("exploded");
        return emptyResult({ removed: ["MAIN_GROUP"] });
      },
    };
    const { deps } = makeDeps([a, b], throwing);
    const summary = await runTelegramSweep(deps);
    expect(summary.failures.some((f) => f.includes("boom"))).toBe(true);
    expect(summary.removed).toEqual([{ username: "fine", groups: ["MAIN_GROUP"] }]);
  });

  it("dry-run results mark the summary and ping as dry-run", async () => {
    const a = row({ telegramUsername: "gone", telegramUserId: "9", status: "CANCELLED", email: "gone@x.com" });
    const { remover } = recordingRemover({
      gone: emptyResult({ removed: ["US_MARKET"], dryRun: true }),
    });
    const { deps, pings, logs } = makeDeps([a], remover);
    const summary = await runTelegramSweep(deps);
    expect(summary.dryRun).toBe(true);
    expect(pings[0]).toContain("DRY RUN");
    expect(logs[0].detail).toContain("dry run — ");
  });

  it("rotates the start offset per run so a budget-tripped run sweeps a different slice each day", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ telegramUsername: `u${i}`, telegramUserId: String(i + 1) })
    );
    const dayMs = 86_400_000;
    // floor(startedAt / dayMs) === 2, and 2 % 5 (list length) === 2, so the
    // rotated list should start at u2, not u0.
    const startedAt = 2 * dayMs;
    let clock = startedAt - 60;
    const { remover, calls } = recordingRemover({});
    const { deps } = makeDeps(rows, remover, {
      timeBudgetMs: 150,
      now: () => { clock += 60; return clock; },
    });
    const summary = await runTelegramSweep(deps);
    expect(calls[0]?.telegramUsername.toLowerCase()).toBe("u2");
    expect(summary.partial).toBe(true);
    expect(calls.length).toBeLessThan(5);
  });

  it("caps the ping at a safe size even with hundreds of failures", async () => {
    const a = row({ telegramUsername: "busy", telegramUserId: "1", email: "busy@x.com" });
    const manyFailures = Array.from(
      { length: 200 },
      (_, i) => `GROUP_${i}: boom number ${i} with a fairly long message to pad the size out`
    );
    const { remover } = recordingRemover({ busy: emptyResult({ failures: manyFailures }) });
    const { deps, pings } = makeDeps([a], remover);
    await runTelegramSweep(deps);
    expect(pings.length).toBe(1);
    expect(pings[0].length).toBeLessThan(4000);
    expect(pings[0]).toContain("and ");
  });

  it("skips ALL usernames sharing one col-P User ID and reports them as duplicates", async () => {
    const a = row({ telegramUsername: "alice", telegramUserId: "555", email: "alice@x.com" });
    const b = row({ telegramUsername: "bob", telegramUserId: "555", email: "bob@x.com" });
    const { remover, calls } = recordingRemover({});
    const { deps, pings } = makeDeps([a, b], remover);
    const summary = await runTelegramSweep(deps);
    expect(calls).toEqual([]);
    expect(summary.duplicateIds.length).toBe(1);
    expect(summary.duplicateIds[0]).toContain("alice");
    expect(summary.duplicateIds[0]).toContain("bob");
    expect(pings.length).toBe(1);
    expect(pings[0]).toContain("alice");
    expect(pings[0]).toContain("bob");
  });

  it("a rejecting recordLog does not abort the run", async () => {
    const a = row({ telegramUsername: "gone", telegramUserId: "9", status: "CANCELLED", email: "gone@x.com" });
    const { remover } = recordingRemover({ gone: emptyResult({ removed: ["US_MARKET"] }) });
    const { deps, pings } = makeDeps([a], remover, {
      recordLog: async () => { throw new Error("sheet down"); },
    });
    const summary = await runTelegramSweep(deps);
    expect(summary.removed).toEqual([{ username: "gone", groups: ["US_MARKET"] }]);
    expect(pings.length).toBe(1);
  });

  it("a rejecting notify does not throw out of runTelegramSweep", async () => {
    const a = row({ telegramUsername: "gone", telegramUserId: "9", status: "CANCELLED", email: "gone@x.com" });
    const { remover } = recordingRemover({ gone: emptyResult({ removed: ["US_MARKET"] }) });
    const { deps } = makeDeps([a], remover, {
      notify: async () => { throw new Error("telegram down"); },
    });
    await expect(runTelegramSweep(deps)).resolves.toBeDefined();
  });
});
