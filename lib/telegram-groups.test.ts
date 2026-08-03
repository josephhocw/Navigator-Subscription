import { describe, it, expect } from "vitest";
import {
  MAIN_MARKET,
  normaliseTelegramUsername,
  entitledMarkets,
  groupsToRemove,
  isWhitelisted,
  hasUnrecognisedLivePlan,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  isDryRun,
  TelegramGroupApi,
  NoopTelegramGroupRemover,
  type GroupConfig,
} from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

const GROUPS: GroupConfig[] = [
  { key: "HK_MARKET", chatId: -1003174239460, market: "HK" },
  { key: "SG_MARKET", chatId: -1003120184464, market: "SG" },
  { key: "US_MARKET", chatId: -1002970318018, market: "US" },
  { key: "FXMC_MARKET", chatId: -1002929109438, market: "FXMC" },
  { key: "MAIN_GROUP", chatId: -1003175647154, market: MAIN_MARKET },
];

function sub(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    rowIndex: 2,
    email: "tan@example.com",
    customerName: "Tan Ah Kow",
    tradingViewUsername: "tanahkow",
    telegramUsername: "tanahkow",
    status: "ACTIVE",
    currentPlan: "HK",
    latestAction: "NEW_SUBSCRIPTION",
    previousPlan: "",
    subscriptionPrice: 147,
    couponDiscount: false,
    subscriptionStart: "3 May 2026 13:00",
    subscriptionExpiry: "3 August 2026 13:00",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_123",
    telegramUserId: "1148435918",
    referralSource: "",
    followupSent: "",
    mobileNumber: "",
    ...overrides,
  };
}

describe("normaliseTelegramUsername", () => {
  it("strips a leading @ and lowercases", () => {
    expect(normaliseTelegramUsername("@TanAhKow")).toBe("tanahkow");
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseTelegramUsername("  tanahkow  ")).toBe("tanahkow");
  });

  it("returns an empty string for undefined", () => {
    expect(normaliseTelegramUsername(undefined)).toBe("");
  });
});

describe("entitledMarkets", () => {
  it("returns nothing when every row for the user is cancelled", () => {
    const all = [sub({ status: "CANCELLED", currentPlan: "HK" })];
    expect(entitledMarkets("tanahkow", all)).toEqual(new Set());
  });

  it("keeps the markets of a second, still-active subscription", () => {
    const all = [
      sub({ rowIndex: 2, status: "CANCELLED", currentPlan: "HK" }),
      sub({ rowIndex: 3, status: "ACTIVE", currentPlan: "US" }),
    ];
    expect(entitledMarkets("tanahkow", all)).toEqual(
      new Set(["US", MAIN_MARKET])
    );
  });

  it("grants SG as a free bonus on a combo plan", () => {
    const all = [sub({ status: "ACTIVE", currentPlan: "US_HK" })];
    expect(entitledMarkets("tanahkow", all)).toEqual(
      new Set(["US", "HK", "SG", MAIN_MARKET])
    );
  });

  it("treats CANCELLATION_SCHEDULED and PAYMENT_FAILED as still entitled", () => {
    const all = [
      sub({ rowIndex: 2, status: "CANCELLATION_SCHEDULED", currentPlan: "HK" }),
      sub({ rowIndex: 3, status: "PAYMENT_FAILED", currentPlan: "US" }),
    ];
    expect(entitledMarkets("tanahkow", all)).toEqual(
      new Set(["HK", "US", MAIN_MARKET])
    );
  });

  it("grants MAIN from a live row even when the plan string is blank", () => {
    const all = [sub({ status: "ACTIVE", currentPlan: "" })];
    expect(entitledMarkets("tanahkow", all)).toEqual(new Set([MAIN_MARKET]));
  });

  it("ignores rows belonging to other people", () => {
    const all = [
      sub({ rowIndex: 2, status: "CANCELLED", telegramUsername: "tanahkow" }),
      sub({ rowIndex: 3, status: "ACTIVE", telegramUsername: "someoneelse", currentPlan: "US" }),
    ];
    expect(entitledMarkets("tanahkow", all)).toEqual(new Set());
  });

  it("matches usernames case-insensitively and tolerates a leading @", () => {
    const all = [sub({ status: "ACTIVE", telegramUsername: "@TanAhKow", currentPlan: "HK" })];
    expect(entitledMarkets("tanahkow", all)).toEqual(
      new Set(["HK", MAIN_MARKET])
    );
  });

  it("a cancelled row listed after a live one does not revoke it", () => {
    const all = [
      sub({ rowIndex: 2, status: "ACTIVE", currentPlan: "US" }),
      sub({ rowIndex: 3, status: "CANCELLED", currentPlan: "HK" }),
    ];
    expect(entitledMarkets("tanahkow", all)).toEqual(new Set(["US", MAIN_MARKET]));
  });

  it("keeps a market that a cancelled row and a live row share", () => {
    const all = [
      sub({ rowIndex: 2, status: "CANCELLED", currentPlan: "HK" }),
      sub({ rowIndex: 3, status: "ACTIVE", currentPlan: "HK" }),
    ];
    expect(entitledMarkets("tanahkow", all)).toEqual(new Set(["HK", MAIN_MARKET]));
  });

  it("does not match every blank-username row when the query is empty", () => {
    const all = [sub({ status: "ACTIVE", telegramUsername: "", currentPlan: "US" })];
    expect(entitledMarkets("", all)).toEqual(new Set());
  });
});

describe("groupsToRemove", () => {
  it("targets every group whose market is not entitled", () => {
    const targets = groupsToRemove(new Set(["US", MAIN_MARKET]), GROUPS);
    expect(targets.map((g) => g.key).sort()).toEqual([
      "FXMC_MARKET",
      "HK_MARKET",
      "SG_MARKET",
    ]);
  });

  it("targets every group when nothing is entitled", () => {
    const targets = groupsToRemove(new Set(), GROUPS);
    expect(targets).toHaveLength(5);
  });

  it("targets nothing for an All Markets subscriber", () => {
    const entitled = new Set(["HK", "SG", "US", "FXMC", MAIN_MARKET]);
    expect(groupsToRemove(entitled, GROUPS)).toEqual([]);
  });
});

describe("isWhitelisted", () => {
  const whitelist = new Set(["joseph_ho", "robinhosa"]);

  it("matches case-insensitively", () => {
    expect(isWhitelisted("Joseph_Ho", whitelist)).toBe(true);
  });

  it("tolerates a leading @", () => {
    expect(isWhitelisted("@robinhosa", whitelist)).toBe(true);
  });

  it("is false for anyone else", () => {
    expect(isWhitelisted("tanahkow", whitelist)).toBe(false);
  });

  it("is false for an empty username", () => {
    expect(isWhitelisted("", whitelist)).toBe(false);
  });
});

describe("hasUnrecognisedLivePlan", () => {
  it("is true for a live row whose plan string is a typo", () => {
    expect(hasUnrecognisedLivePlan("tanahkow", [sub({ status: "ACTIVE", currentPlan: "HK " })])).toBe(true);
  });

  it("is false for a blank plan on a live row", () => {
    expect(hasUnrecognisedLivePlan("tanahkow", [sub({ status: "ACTIVE", currentPlan: "" })])).toBe(false);
  });

  it("is false when every recognised plan is valid", () => {
    expect(hasUnrecognisedLivePlan("tanahkow", [sub({ status: "ACTIVE", currentPlan: "US_HK" })])).toBe(false);
  });

  it("ignores a typo on a CANCELLED row", () => {
    expect(hasUnrecognisedLivePlan("tanahkow", [sub({ status: "CANCELLED", currentPlan: "hk" })])).toBe(false);
  });

  it("ignores rows belonging to other people", () => {
    expect(
      hasUnrecognisedLivePlan("tanahkow", [
        sub({ status: "ACTIVE", telegramUsername: "someoneelse", currentPlan: "bogus" }),
      ])
    ).toBe(false);
  });
});

describe("loadGroupsFromEnv", () => {
  it("builds all five groups when every chat ID is present", () => {
    const groups = loadGroupsFromEnv({
      TELEGRAM_CHAT_HK: "-1003174239460",
      TELEGRAM_CHAT_SG: "-1003120184464",
      TELEGRAM_CHAT_US: "-1002970318018",
      TELEGRAM_CHAT_FXMC: "-1002929109438",
      TELEGRAM_CHAT_MAIN: "-1003175647154",
    });
    expect(groups).toHaveLength(5);
    expect(groups.find((g) => g.market === "HK")?.chatId).toBe(-1003174239460);
    expect(groups.find((g) => g.market === MAIN_MARKET)?.chatId).toBe(-1003175647154);
  });

  it("omits a group whose chat ID is missing", () => {
    const groups = loadGroupsFromEnv({ TELEGRAM_CHAT_HK: "-1003174239460" });
    expect(groups.map((g) => g.market)).toEqual(["HK"]);
  });

  it("omits a group whose chat ID is not a number", () => {
    const groups = loadGroupsFromEnv({ TELEGRAM_CHAT_HK: "not-a-number" });
    expect(groups).toEqual([]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(loadGroupsFromEnv({})).toEqual([]);
  });
});

describe("loadWhitelistFromEnv", () => {
  it("splits on commas, trims, strips @ and lowercases", () => {
    const wl = loadWhitelistFromEnv({
      TELEGRAM_KICK_WHITELIST: "Joseph_Ho, @robinhosa ,noahiee",
    });
    expect(wl).toEqual(new Set(["joseph_ho", "robinhosa", "noahiee"]));
  });

  it("is empty when unset", () => {
    expect(loadWhitelistFromEnv({})).toEqual(new Set());
  });

  it("ignores empty segments from stray commas", () => {
    expect(loadWhitelistFromEnv({ TELEGRAM_KICK_WHITELIST: "a,,b," })).toEqual(
      new Set(["a", "b"])
    );
  });
});

describe("isDryRun", () => {
  it("is true only for the exact string 'true'", () => {
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "true" })).toBe(true);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "false" })).toBe(false);
  });

  it("defaults to false when unset", () => {
    expect(isDryRun({})).toBe(false);
  });
});

/** Build a fetch stub that answers the Telegram endpoints by name. */
function fakeFetch(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = async (url: string | URL): Promise<Response> => {
    const u = String(url);
    const method = u.split("/").pop()!.split("?")[0];
    calls.push(method);
    const body = handlers[method] ?? { ok: true, result: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const TWO_GROUPS: GroupConfig[] = [
  { key: "HK_MARKET", chatId: -111, market: "HK" },
  { key: "MAIN_GROUP", chatId: -222, market: MAIN_MARKET },
];

describe("NoopTelegramGroupRemover", () => {
  it("reports itself unconfigured and removes nothing", async () => {
    const noop = new NoopTelegramGroupRemover();
    expect(noop.configured).toBe(false);
    const result = await noop.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });
    expect(result.removed).toEqual([]);
    expect(result.reason).toBe("not-configured");
  });
});

describe("TelegramGroupApi.removeFromGroups", () => {
  it("bans then unbans in each non-entitled group where the user is a member", async () => {
    const { impl, calls } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });

    expect(result.removed.sort()).toEqual(["HK_MARKET", "MAIN_GROUP"]);
    expect(result.failures).toEqual([]);
    expect(calls.filter((c) => c === "banChatMember")).toHaveLength(2);
    expect(calls.filter((c) => c === "unbanChatMember")).toHaveLength(2);
  });

  it("skips a group the user is not currently in, without banning", async () => {
    const { impl, calls } = fakeFetch({
      getChatMember: { ok: true, result: { status: "left" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped.sort()).toEqual(["HK_MARKET", "MAIN_GROUP"]);
    expect(calls).not.toContain("banChatMember");
  });

  it("treats a restricted-but-still-member user as present", async () => {
    const { impl } = fakeFetch({
      getChatMember: { ok: true, result: { status: "restricted", is_member: true } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: [TWO_GROUPS[0]],
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });
    expect(result.removed).toEqual(["HK_MARKET"]);
  });

  it("leaves a group the user is still entitled to", async () => {
    const { impl } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    // A second live HK row means HK and MAIN both stay.
    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [sub({ status: "ACTIVE", currentPlan: "HK" })],
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("does nothing for a whitelisted username", async () => {
    const { impl, calls } = fakeFetch({});
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(["robinhosa"]),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "@RobinHoSA",
      allSubscribers: [],
    });
    expect(result.reason).toBe("whitelisted");
    expect(result.removed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does nothing when the Telegram User ID is blank", async () => {
    const { impl, calls } = fakeFetch({});
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });
    expect(result.reason).toBe("no-user-id");
    expect(calls).toEqual([]);
  });

  it("removes nothing when a live row has an unrecognised plan", async () => {
    const { impl, calls } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [sub({ status: "ACTIVE", currentPlan: "HK-typo" })],
    });

    expect(result.reason).toBe("unrecognised-plan");
    expect(result.removed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("in dry-run, checks membership but never bans", async () => {
    const { impl, calls } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: true,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });

    expect(result.dryRun).toBe(true);
    expect(result.removed.sort()).toEqual(["HK_MARKET", "MAIN_GROUP"]);
    expect(calls).not.toContain("banChatMember");
    expect(calls).not.toContain("unbanChatMember");
  });

  it("records a per-group failure and still processes the other groups", async () => {
    let first = true;
    const impl = (async (url: string | URL): Promise<Response> => {
      const method = String(url).split("/").pop()!.split("?")[0];
      if (method === "getChatMember") {
        return new Response(JSON.stringify({ ok: true, result: { status: "member" } }), { status: 200 });
      }
      if (method === "banChatMember" && first) {
        first = false;
        return new Response(JSON.stringify({ ok: false, description: "not enough rights" }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("not enough rights");
    expect(result.removed).toEqual(["MAIN_GROUP"]);
  });

  it("skips quietly when getChatMember errors (user never joined that group)", async () => {
    const { impl, calls } = fakeFetch({
      getChatMember: { ok: false, description: "user not found" },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: [TWO_GROUPS[0]],
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });
    expect(result.skipped).toEqual(["HK_MARKET"]);
    expect(result.failures).toEqual([]);
    expect(calls).not.toContain("banChatMember");
  });
});
