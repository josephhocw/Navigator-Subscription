import { describe, it, expect } from "vitest";
import { handleChatMemberUpdate, type JoinGuardDeps, type TelegramChatMemberEvent } from "./telegram-join.js";
import { MAIN_MARKET, type GroupConfig } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

const US_GROUP: GroupConfig = { key: "US_MARKET", chatId: -100, market: "US" };
const MAIN_GROUP: GroupConfig = { key: "MAIN_GROUP", chatId: -500, market: MAIN_MARKET };

let nextRow = 2;
function row(over: Partial<Subscriber>): Subscriber {
  return {
    rowIndex: nextRow++, email: "x@example.com", customerName: "", tradingViewUsername: "",
    telegramUsername: "", status: "ACTIVE", currentPlan: "", latestAction: "", previousPlan: "",
    subscriptionPrice: 0, couponDiscount: false, subscriptionStart: "", subscriptionExpiry: "",
    subscriptionCount: 1, failedPaymentCount: 0, stripeSubscriptionId: "sub_x",
    telegramUserId: "", referralSource: "", followupSent: "", mobileNumber: "", ...over,
  };
}

function joinEvent(chatId: number, userId: number, username?: string): TelegramChatMemberEvent {
  return {
    chat: { id: chatId },
    old_chat_member: { status: "left", user: { id: userId, username } },
    new_chat_member: { status: "member", user: { id: userId, username } },
  };
}

interface Recorded {
  kicks: Array<{ chatId: number; userId: string }>;
  writes: Array<{ rowIndex: number; userId: string }>;
  pings: string[];
}

function makeDeps(all: Subscriber[], over: Partial<JoinGuardDeps> = {}): { deps: JoinGuardDeps; rec: Recorded } {
  const rec: Recorded = { kicks: [], writes: [], pings: [] };
  const deps: JoinGuardDeps = {
    groups: [US_GROUP, MAIN_GROUP],
    whitelist: new Set(["joseph_ho"]),
    dryRun: false,
    listAll: async () => all,
    writeUserId: async (rowIndex, userId) => { rec.writes.push({ rowIndex, userId }); },
    kick: async (chatId, userId) => { rec.kicks.push({ chatId, userId }); return { outcome: "removed" }; },
    notify: async (m) => { rec.pings.push(m); },
    ...over,
  };
  return { deps, rec };
}

describe("handleChatMemberUpdate", () => {
  it("ignores updates for unknown chats", async () => {
    const { deps, rec } = makeDeps([]);
    const summary = await handleChatMemberUpdate(joinEvent(-999, 1, "joe"), deps);
    expect(summary).toContain("unknown chat");
    expect(rec.kicks).toEqual([]);
  });

  it("ignores non-join transitions", async () => {
    const { deps, rec } = makeDeps([]);
    const ev = joinEvent(-100, 1, "joe");
    ev.old_chat_member = { status: "member", user: { id: 1, username: "joe" } };
    ev.new_chat_member = { status: "administrator", user: { id: 1, username: "joe" } };
    const summary = await handleChatMemberUpdate(ev, deps);
    expect(summary).toContain("not a join");
    expect(rec.kicks).toEqual([]);
  });

  it("kicks an entitled-nowhere joiner from a market group and pings", async () => {
    const { deps, rec } = makeDeps([]);
    await handleChatMemberUpdate(joinEvent(-100, 42, "ghost"), deps);
    expect(rec.kicks).toEqual([{ chatId: -100, userId: "42" }]);
    expect(rec.pings.some((p) => p.includes("ghost"))).toBe(true);
  });

  it("allows an entitled joiner and writes col P to every live row", async () => {
    const a = row({ telegramUsername: "joe", currentPlan: "US" });
    const b = row({ telegramUsername: "joe", currentPlan: "HK" });
    const { deps, rec } = makeDeps([a, b]);
    await handleChatMemberUpdate(joinEvent(-100, 42, "joe"), deps);
    expect(rec.kicks).toEqual([]);
    expect(rec.writes).toEqual([
      { rowIndex: a.rowIndex, userId: "42" },
      { rowIndex: b.rowIndex, userId: "42" },
    ]);
  });

  it("dry-run: kicks nothing, writes nothing, pings the would-be kick", async () => {
    const { deps, rec } = makeDeps([], { dryRun: true });
    await handleChatMemberUpdate(joinEvent(-100, 42, "ghost"), deps);
    expect(rec.kicks).toEqual([]);
    expect(rec.writes).toEqual([]);
    expect(rec.pings.some((p) => p.includes("DRY RUN"))).toBe(true);
  });

  it("dry-run: suppresses col-P writes on an allow (bot.py still owns col P)", async () => {
    const a = row({ telegramUsername: "joe", currentPlan: "US" });
    const { deps, rec } = makeDeps([a], { dryRun: true });
    await handleChatMemberUpdate(joinEvent(-100, 42, "joe"), deps);
    expect(rec.writes).toEqual([]);
  });

  it("fails open when the sheet read throws: no kick, ping fired", async () => {
    const { deps, rec } = makeDeps([], {
      listAll: async () => { throw new Error("sheets down"); },
    });
    const summary = await handleChatMemberUpdate(joinEvent(-100, 42, "joe"), deps);
    expect(rec.kicks).toEqual([]);
    expect(summary).toContain("fail-open");
    expect(rec.pings.some((p) => p.includes("fail-open") || p.includes("sheet"))).toBe(true);
  });

  it("kicks a no-username joiner from a market group but not from main", async () => {
    const { deps, rec } = makeDeps([]);
    await handleChatMemberUpdate(joinEvent(-100, 42, undefined), deps);
    expect(rec.kicks).toEqual([{ chatId: -100, userId: "42" }]);
    rec.kicks.length = 0;
    await handleChatMemberUpdate(joinEvent(-500, 43, undefined), deps);
    expect(rec.kicks).toEqual([]);
  });

  it("allows an unrecognised-plan holder but pings Joseph to fix col F", async () => {
    const a = row({ telegramUsername: "joe", currentPlan: "BANANA" });
    const { deps, rec } = makeDeps([a]);
    await handleChatMemberUpdate(joinEvent(-100, 42, "joe"), deps);
    expect(rec.kicks).toEqual([]);
    expect(rec.writes).toEqual([{ rowIndex: a.rowIndex, userId: "42" }]);
    expect(rec.pings.some((p) => p.includes("unrecognised plan"))).toBe(true);
  });

  it("pings STILL BANNED loudly when the kick leaves a permanent ban", async () => {
    const { deps, rec } = makeDeps([], {
      kick: async () => ({ outcome: "still-banned", unbanError: "boom" }),
    });
    await handleChatMemberUpdate(joinEvent(-100, 42, "ghost"), deps);
    expect(rec.pings.some((p) => p.includes("STILL BANNED"))).toBe(true);
  });

  it("a kick that throws pings a kick-FAILED alert and reports the failure", async () => {
    const { deps, rec } = makeDeps([], {
      kick: async () => { throw new Error("no rights <html>"); },
    });
    const summary = await handleChatMemberUpdate(joinEvent(-100, 42, "ghost"), deps);
    expect(summary).toContain("FAILED");
    expect(rec.pings.some((p) => p.includes("FAILED") && !p.includes("<html>"))).toBe(true);
  });

  it("a kick TIMEOUT pings the state-unknown guidance, not the sweep-retries line", async () => {
    const { deps, rec } = makeDeps([], {
      kick: async () => { throw new Error("kick timed out after 8000ms"); },
    });
    const summary = await handleChatMemberUpdate(joinEvent(-100, 42, "ghost"), deps);
    expect(summary).toContain("FAILED");
    const ping = rec.pings.find((p) => p.includes("FAILED"));
    expect(ping).toContain("unban by hand");
    expect(ping).not.toContain("sweep retries");
  });

  it("a failed col-P write pings but the join still counts as allowed", async () => {
    const a = row({ telegramUsername: "joe", currentPlan: "US" });
    const { deps, rec } = makeDeps([a], {
      writeUserId: async () => { throw new Error("write denied"); },
    });
    const summary = await handleChatMemberUpdate(joinEvent(-100, 42, "joe"), deps);
    expect(summary).toContain("allowed");
    expect(rec.pings.some((p) => p.includes("col P"))).toBe(true);
  });

  it("a throwing notify never breaks the kick path: kick executes, summary returns", async () => {
    const { deps, rec } = makeDeps([], {
      notify: async () => { throw new Error("telegram down"); },
    });
    const summary = await handleChatMemberUpdate(joinEvent(-100, 42, "ghost"), deps);
    expect(rec.kicks).toEqual([{ chatId: -100, userId: "42" }]);
    expect(summary).toContain("kicked");
  });

  it("HTML in a username is escaped in every ping", async () => {
    const { deps, rec } = makeDeps([]);
    await handleChatMemberUpdate(joinEvent(-100, 42, "<b>evil"), deps);
    expect(rec.kicks).toEqual([{ chatId: -100, userId: "42" }]);
    expect(rec.pings.length).toBeGreaterThan(0);
    expect(rec.pings.some((p) => p.includes("<b>evil"))).toBe(false);
    expect(rec.pings.some((p) => p.includes("&lt;b&gt;evil"))).toBe(true);
  });

  it("kicks a no-username joiner from a market group even when the sheet is down", async () => {
    const { deps, rec } = makeDeps([], {
      listAll: async () => { throw new Error("sheets down"); },
    });
    await handleChatMemberUpdate(joinEvent(-100, 42, undefined), deps);
    expect(rec.kicks).toEqual([{ chatId: -100, userId: "42" }]);
  });

  it("allows a whitelisted joiner even when the sheet is down", async () => {
    const { deps, rec } = makeDeps([], {
      listAll: async () => { throw new Error("sheets down"); },
    });
    const summary = await handleChatMemberUpdate(joinEvent(-100, 42, "joseph_ho"), deps);
    expect(rec.kicks).toEqual([]);
    expect(summary).toContain("allowed");
    expect(summary).not.toContain("fail-open");
  });
});
