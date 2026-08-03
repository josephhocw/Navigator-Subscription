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

  it("omits a hex or exponent chat ID rather than coercing it to another chat", () => {
    // Number("0x10") is 16 and Number("1e5") is 100000 — both perfectly finite,
    // and both a DIFFERENT chat from the one anybody meant.
    expect(loadGroupsFromEnv({ TELEGRAM_CHAT_HK: "0x10" })).toEqual([]);
    expect(loadGroupsFromEnv({ TELEGRAM_CHAT_HK: "1e5" })).toEqual([]);
  });

  it("omits a zero chat ID", () => {
    expect(loadGroupsFromEnv({ TELEGRAM_CHAT_HK: "0" })).toEqual([]);
  });

  it("omits a chat ID too large to survive as an exact integer", () => {
    // A fat-fingered extra digit past 2^53 silently rounds to a nearby number.
    expect(loadGroupsFromEnv({ TELEGRAM_CHAT_HK: "-10031742394601234567" })).toEqual([]);
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
  it("goes live only for an explicit 'false'", () => {
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "false" })).toBe(false);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "true" })).toBe(true);
  });

  it("defaults to dry-run when the variable is unset", () => {
    // The case that actually happens: the var is set in Vercel's Preview scope
    // but never added to Production. Fail safe — report, don't remove.
    expect(isDryRun({})).toBe(true);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: undefined })).toBe(true);
  });

  it("stays in dry-run for anything that is not the word false", () => {
    // Every one of these used to mean LIVE REMOVALS under the old
    // `=== "true"` rule. For a flag whose job is "don't do the dangerous
    // thing yet", the default has to be the safe one.
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "" })).toBe(true);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "ture" })).toBe(true); // typo
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "TRUE" })).toBe(true);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "1" })).toBe(true);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "0" })).toBe(true);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "no" })).toBe(true);
  });

  it("accepts a mis-cased or padded 'false' as going live — deliberately", () => {
    // Trimmed and lowercased, so " FALSE " goes LIVE. That is intentional:
    // the strictness exists to stop an ACCIDENT from arming the removals, and
    // nobody types " FALSE " by accident — a stray space pasted into the
    // Vercel field must not silently disarm a switch Joseph meant to throw.
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: " FALSE " })).toBe(false);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "False" })).toBe(false);
    expect(isDryRun({ TELEGRAM_KICK_DRY_RUN: "false\n" })).toBe(false);
  });
});

interface RecordedCall {
  method: string;
  body: Record<string, unknown>;
}

/**
 * Build a fetch stub that answers the Telegram endpoints by name.
 *
 * Records the parsed request BODY as well as the method. Recording only method
 * names lets a swapped banChatMember/unbanChatMember pair — which would leave
 * every removed subscriber permanently banned — pass the whole suite, along
 * with sending the wrong chat, the wrong user, or dropping only_if_banned.
 */
function fakeFetch(handlers: Record<string, unknown>) {
  const calls: RecordedCall[] = [];
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = u.split("/").pop()!.split("?")[0];
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const body = handlers[method] ?? { ok: true, result: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    impl: impl as unknown as typeof fetch,
    calls,
    /** The call sequence, in order. */
    methods: () => calls.map((c) => c.method),
  };
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
    expect(result.outstandingBans).toEqual([]);
    expect(result.identityMismatches).toEqual([]);
    expect(result.reason).toBe("not-configured");
  });
});

describe("TelegramGroupApi.removeFromGroups", () => {
  it("bans then unbans in each non-entitled group where the user is a member", async () => {
    const { impl, calls, methods } = fakeFetch({
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
    expect(result.outstandingBans).toEqual([]);

    // The ORDER matters: ban then unban is a kick; unban then ban is a
    // permanent ban. Assert the exact sequence, not just the counts.
    expect(methods()).toEqual([
      "getChatMember",
      "banChatMember",
      "unbanChatMember",
      "getChatMember",
      "banChatMember",
      "unbanChatMember",
    ]);

    // …and the exact payloads: right chat, right user, and only_if_banned on
    // the unban so a race can't turn it into a second removal.
    expect(calls.map((c) => c.body)).toEqual([
      { chat_id: -111, user_id: "123" },
      { chat_id: -111, user_id: "123" },
      { chat_id: -111, user_id: "123", only_if_banned: true },
      { chat_id: -222, user_id: "123" },
      { chat_id: -222, user_id: "123" },
      { chat_id: -222, user_id: "123", only_if_banned: true },
    ]);
  });

  it("skips a group the user is not currently in, without banning", async () => {
    const { impl, methods } = fakeFetch({
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
    expect(methods()).not.toContain("banChatMember");
  });

  it("does NOT treat a restricted user who has left as a member", async () => {
    const { impl, methods } = fakeFetch({
      getChatMember: { ok: true, result: { status: "restricted", is_member: false } },
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

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual(["HK_MARKET"]);
    expect(methods()).not.toContain("banChatMember");
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
    const { impl, methods } = fakeFetch({});
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
    expect(methods()).toEqual([]);
  });

  it("puts the whitelist ahead of every other short-circuit", async () => {
    // Whitelisted AND missing a user ID. The documented order is
    // whitelisted → no-user-id → no-username → unrecognised-plan, so a
    // protected account reports as protected whatever else is wrong with it.
    const { impl } = fakeFetch({});
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(["robinhosa"]),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "",
      telegramUsername: "@RobinHoSA",
      allSubscribers: [sub({ telegramUsername: "robinhosa", currentPlan: "bogus-plan" })],
    });
    expect(result.reason).toBe("whitelisted");
  });

  it("does nothing when the Telegram User ID is blank", async () => {
    const { impl, methods } = fakeFetch({});
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
    expect(methods()).toEqual([]);
  });

  it("removes nothing when the Telegram username is blank", async () => {
    // The dangerous case: with a blank col D, entitledMarkets() returns the
    // empty set, so without this guard the user is targeted for EVERY group.
    const { impl, methods } = fakeFetch({
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
      telegramUsername: "",
      allSubscribers: [],
    });

    expect(result.reason).toBe("no-username");
    expect(result.removed).toEqual([]);
    expect(methods()).toEqual([]);
  });

  it("treats a whitespace-only username as blank", async () => {
    const { impl, methods } = fakeFetch({
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
      telegramUsername: "  @  ",
      allSubscribers: [],
    });

    expect(result.reason).toBe("no-username");
    expect(methods()).toEqual([]);
  });

  it("removes nothing when a live row has an unrecognised plan", async () => {
    const { impl, methods } = fakeFetch({
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
    expect(methods()).toEqual([]);
  });

  it("in dry-run, checks membership but never bans", async () => {
    const { impl, methods } = fakeFetch({
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
    expect(methods()).not.toContain("banChatMember");
    expect(methods()).not.toContain("unbanChatMember");
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
    const { impl, methods } = fakeFetch({
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
    expect(methods()).not.toContain("banChatMember");
  });

  it("redacts the bot token if a fetch implementation quotes the request URL back", async () => {
    const impl = (async (url: string | URL): Promise<Response> => {
      // node-fetch and friends put the whole URL in the message — and the URL
      // is the one place the token appears.
      throw new Error(`request to ${String(url)} failed, reason: ECONNRESET`);
    }) as unknown as typeof fetch;
    const api = new TelegramGroupApi({
      token: "123456:SECRET-TOKEN",
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

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).not.toContain("SECRET-TOKEN");
    expect(result.failures[0]).toContain("ECONNRESET");
  });

  it("records a failure — not a silent skip — when the membership call never answers", async () => {
    // A dead socket is not Telegram saying "I don't know this user". Swallowing
    // it would leave a partially-cancelled subscriber in a group they no longer
    // pay for, with nothing to correct it: scheduler.py only sweeps rows whose
    // status is CANCELLED, and this person is still ACTIVE.
    const impl = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
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

    expect(result.skipped).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("fetch failed");
  });

  it("reports a non-JSON body as a readable failure, not a SyntaxError full of markup", async () => {
    const impl = (async (): Promise<Response> => {
      return new Response(
        "<html><head><title>502 Bad Gateway</title></head><body>\n  nginx\n</body></html>",
        { status: 502 }
      );
    }) as unknown as typeof fetch;
    const api = new TelegramGroupApi({
      token: "SECRET-TOKEN",
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

    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure).toContain("non-JSON");
    expect(failure).toContain("502");
    // The failure string is spliced into an HTML-parsed admin ping, so it must
    // not carry markup — and must never carry the bot token.
    expect(failure).not.toContain("<");
    expect(failure).not.toContain(">");
    expect(failure).not.toContain("SECRET-TOKEN");
    expect(failure.length).toBeLessThan(300);
  });

  it("keeps the HTTP status even when Telegram supplies a description", async () => {
    const impl = (async (url: string | URL): Promise<Response> => {
      const method = String(url).split("/").pop()!;
      if (method === "getChatMember") {
        return new Response(JSON.stringify({ ok: true, result: { status: "member" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
    }) as unknown as typeof fetch;
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

    expect(result.failures[0]).toContain("Too Many Requests");
    expect(result.failures[0]).toContain("429");
  });

  it("retries a failed unban once, then reports the user as still banned", async () => {
    const attempts: string[] = [];
    const impl = (async (url: string | URL): Promise<Response> => {
      const method = String(url).split("/").pop()!;
      attempts.push(method);
      if (method === "getChatMember") {
        return new Response(JSON.stringify({ ok: true, result: { status: "member" } }), { status: 200 });
      }
      if (method === "unbanChatMember") {
        return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;

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

    // The ban landed, so the group really was removed — reporting only a
    // failure would read as "nothing happened" when half of a destructive
    // operation succeeded.
    expect(result.removed).toEqual(["HK_MARKET"]);
    expect(result.outstandingBans).toEqual(["HK_MARKET"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("123"); // the user ID to unban
    expect(result.failures[0]).toContain("-111"); // the chat to unban them in
    expect(result.failures[0]).toContain("by hand");
    // Exactly one retry — not zero, not a loop.
    expect(attempts.filter((m) => m === "unbanChatMember")).toHaveLength(2);
  });

  it("leaves no outstanding ban when the retried unban succeeds", async () => {
    let unbans = 0;
    const impl = (async (url: string | URL): Promise<Response> => {
      const method = String(url).split("/").pop()!;
      if (method === "getChatMember") {
        return new Response(JSON.stringify({ ok: true, result: { status: "member" } }), { status: 200 });
      }
      if (method === "unbanChatMember" && ++unbans === 1) {
        return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;

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
    expect(result.outstandingBans).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(unbans).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Identity verification. Entitlement is computed from col D (the username);
  // the ban executes against col P (the User ID). A wrong col P — a column the
  // docs tell Joseph to hand-fill for complimentary rows — removes a completely
  // different person, exactly the failure the whole safety rule exists to stop.
  // ---------------------------------------------------------------------------

  it("does NOT remove when Telegram says the User ID belongs to someone else", async () => {
    const { impl, methods } = fakeFetch({
      getChatMember: {
        ok: true,
        result: { status: "member", user: { username: "someoneelse" } },
      },
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

    expect(result.identityMismatches).toEqual([
      "HK_MARKET: sheet says @tanahkow, Telegram says @someoneelse",
    ]);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failures).toEqual([]);
    // The whole point: nothing was banned.
    expect(methods()).toEqual(["getChatMember"]);
    expect(methods()).not.toContain("banChatMember");
  });

  it("does not treat a case or @ difference as a mismatch", async () => {
    // Telegram usernames are case-insensitive and the sheet cell is typed by
    // hand, so "@TanAhKow" and "tanahkow" are the same person.
    const { impl } = fakeFetch({
      getChatMember: {
        ok: true,
        result: { status: "member", user: { username: "TanAhKow" } },
      },
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
      telegramUsername: "@tanahkow",
      allSubscribers: [],
    });

    expect(result.identityMismatches).toEqual([]);
    expect(result.removed).toEqual(["HK_MARKET"]);
  });

  it("proceeds when Telegram reports no username at all", async () => {
    // A user may never have set a username, or may have removed it. Absence is
    // not evidence of a wrong ID — and col P was written by the join guard
    // after a username match — so this must not become a skip.
    const { impl, methods } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member", user: { id: 123 } } },
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

    expect(result.identityMismatches).toEqual([]);
    expect(result.removed).toEqual(["HK_MARKET"]);
    expect(methods()).toContain("banChatMember");
  });

  it("records the mismatch in dry-run too, so the flag period measures it", async () => {
    const { impl } = fakeFetch({
      getChatMember: {
        ok: true,
        result: { status: "member", user: { username: "someoneelse" } },
      },
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

    expect(result.identityMismatches).toHaveLength(2);
    expect(result.removed).toEqual([]);
  });

  it("skips only the mismatching group and still processes the others", async () => {
    // Skip-and-report, not a hard block: a mismatch is one group's problem.
    const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = String(url).split("/").pop()!;
      if (method === "getChatMember") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: number };
        const username = body.chat_id === -111 ? "someoneelse" : "tanahkow";
        return new Response(
          JSON.stringify({ ok: true, result: { status: "member", user: { username } } }),
          { status: 200 }
        );
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

    expect(result.identityMismatches).toEqual([
      "HK_MARKET: sheet says @tanahkow, Telegram says @someoneelse",
    ]);
    expect(result.removed).toEqual(["MAIN_GROUP"]);
  });

  it("summarises the loaded config in dry-run, as counts only", async () => {
    // A missing TELEGRAM_KICK_WHITELIST silently means "nobody is protected".
    // The operator has to be able to see that without opening Vercel.
    const { impl } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: GROUPS,
      whitelist: new Set(["joseph_ho", "robinhosa", "noahiee", "kaixin"]),
      dryRun: true,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });

    expect(result.configSummary).toBe("5 groups, 4 whitelisted");
    // Counts only — never the protected usernames themselves, and never
    // anything derived from the bot token.
    expect(result.configSummary).not.toContain("robinhosa");
    expect(result.configSummary).not.toContain("T");
  });

  it("omits the config summary outside dry-run", async () => {
    const { impl } = fakeFetch({
      getChatMember: { ok: true, result: { status: "member" } },
    });
    const api = new TelegramGroupApi({
      token: "T",
      groups: GROUPS,
      whitelist: new Set(["robinhosa"]),
      dryRun: false,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "tanahkow",
      allSubscribers: [],
    });
    expect(result.configSummary).toBeUndefined();
  });

  it("reports the config summary even on a short-circuit", async () => {
    // The short-circuit results spread the same base, so a whitelisted or
    // blank-ID subscriber still shows what config was loaded.
    const { impl } = fakeFetch({});
    const api = new TelegramGroupApi({
      token: "T",
      groups: TWO_GROUPS,
      whitelist: new Set(["robinhosa"]),
      dryRun: true,
      fetchImpl: impl,
    });

    const result = await api.removeFromGroups({
      telegramUserId: "123",
      telegramUsername: "@RobinHoSA",
      allSubscribers: [],
    });
    expect(result.reason).toBe("whitelisted");
    expect(result.configSummary).toBe("2 groups, 1 whitelisted");
  });
});
