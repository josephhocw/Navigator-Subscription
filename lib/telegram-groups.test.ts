import { describe, it, expect } from "vitest";
import {
  MAIN_MARKET,
  normaliseTelegramUsername,
  entitledMarkets,
  groupsToRemove,
  isWhitelisted,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  isDryRun,
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
