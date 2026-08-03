# Instant Telegram Removal on Cancellation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a subscription ends, remove the subscriber from every Telegram group they are no longer entitled to within seconds, instead of waiting up to 24 hours for `scheduler.py`'s noon sweep.

**Architecture:** A new sixth lifecycle collaborator, `TelegramGroupRemover`, mirroring the existing `TradingViewGranter` seam exactly. Pure decision logic (entitlements, whitelist, target groups) is separated from the HTTP client so it can be unit-tested without network. It fires inside `handleEnded`'s existing `runSideEffects` block, so a failure pings Joseph and never fails the webhook. Ships behind a dry-run flag.

**Tech Stack:** TypeScript, Vercel serverless, vitest, Telegram Bot API (`getChatMember` / `banChatMember` / `unbanChatMember`), Google Sheets via the existing `SubscriberStore`.

**Spec:** `docs/superpowers/specs/2026-08-03-instant-telegram-removal-on-cancellation-design.md`

---

## Background the engineer needs

- The website and the Python access bot **share one bot token** (`TELEGRAM_BOT_TOKEN`, already in env). That bot is an admin in all five groups, so no new credentials are needed.
- A "kick" is **ban then unban** — a plain ban is permanent, and the subscriber must be able to rejoin if they resubscribe. This mirrors `kick_user()` in the bot repo's `common.py`.
- Entitlement rule: a subscriber is entitled until their row's status is `CANCELLED`. One person can have several rows (one per Stripe subscription), so a cancelled row must never remove someone whose *other* row is still live.
- Every combo plan grants the SG market as a free bonus. `parsePlanType()` in `lib/plans.ts` already encodes this — reuse it, never reimplement it.
- The main group has no plan mapped to it. It uses a pseudo-market, `MAIN`, which **any** non-cancelled row grants regardless of plan string.
- Never enumerate group membership. The code only ever acts on the one User ID handed to it. People with no sheet row (Joseph's comped friends) must remain unreachable by this code path.

## File Structure

| File | Responsibility |
|---|---|
| Create: `lib/telegram-groups.ts` | Group config, pure entitlement/whitelist rules, the `TelegramGroupRemover` seam, `TelegramGroupApi` (HTTP), `NoopTelegramGroupRemover` |
| Create: `lib/telegram-groups.test.ts` | Unit tests for the pure rules, env loaders, and the API client with an injected fetch |
| Modify: `lib/subscription-lifecycle.ts` | Add the sixth collaborator; call it from `handleEnded` |
| Modify: `lib/subscription-lifecycle.test.ts` | In-memory fake remover; assert `handleEnded` behaviour |
| Modify: `api/stripe-webhook.ts` | Build the real remover from env, or fall back to the Noop |
| Modify: `CLAUDE.md`, `README-webhook.md` | Document the collaborator, env vars, and the config-drift note |

---

### Task 1: Pure entitlement and whitelist rules

**Files:**
- Create: `lib/telegram-groups.ts`
- Create: `lib/telegram-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/telegram-groups.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  MAIN_MARKET,
  normaliseTelegramUsername,
  entitledMarkets,
  groupsToRemove,
  isWhitelisted,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: FAIL — `Failed to resolve import "./telegram-groups.js"`

- [ ] **Step 3: Write the module with the pure rules**

Create `lib/telegram-groups.ts`:

```typescript
// =============================================================================
// TELEGRAM GROUP ACCESS
// =============================================================================
// Removes a cancelled subscriber from the Telegram groups they are no longer
// entitled to, at the moment their subscription ends — instead of waiting for
// the bot repo's scheduler.py sweep at 12:00 PM SGT.
//
// This is a TypeScript port of the decision logic in the bot repo's access.py
// (entitlements_by_username / groups_to_kick / is_whitelisted) plus the kick
// itself from common.py (ban + unban). The bot keeps running: bot.py still
// guards joins and writes col P, and scheduler.py stays as the daily reconcile.
//
// SAFETY PROPERTY: this module only ever acts on the single Telegram User ID it
// is handed. It never lists group members and never decides anything about a
// person it was not given. Someone with no row in the sheet — e.g. a friend
// given free group access by hand — is unreachable by this code path.
// =============================================================================

import { parsePlanType } from "./plans.js";
import type { Subscriber } from "./subscriber-store.js";

/** Pseudo-market for the open main "RHO Navigator Subscribers" group. No plan
 *  maps to it — ANY non-cancelled row grants it, whatever the plan string. */
export const MAIN_MARKET = "MAIN";

/** The one status that loses access. ACTIVE, CANCELLATION_SCHEDULED and
 *  PAYMENT_FAILED are all still entitled — mirrors access.py BARRED_STATUS. */
const BARRED_STATUS = "CANCELLED";

export interface GroupConfig {
  /** Stable key used in logs and pings, e.g. "HK_MARKET". */
  key: string;
  chatId: number;
  /** "HK" | "SG" | "US" | "FXMC" | MAIN_MARKET */
  market: string;
}

/** Lowercase, @-stripped, trimmed. Telegram usernames are case-insensitive. */
export function normaliseTelegramUsername(username: string | undefined | null): string {
  if (!username) return "";
  return username.trim().replace(/^@/, "").toLowerCase();
}

/**
 * Markets this username is STILL entitled to, from their non-cancelled rows.
 *
 * A subscriber can hold several rows (one per Stripe subscription), so the
 * cancelled row must never be judged alone — that would remove someone whose
 * second subscription is still live.
 */
export function entitledMarkets(
  username: string,
  all: Subscriber[]
): Set<string> {
  const target = normaliseTelegramUsername(username);
  const markets = new Set<string>();
  if (!target) return markets;

  for (const row of all) {
    if (normaliseTelegramUsername(row.telegramUsername) !== target) continue;
    if (row.status === BARRED_STATUS) continue;
    // Any live subscription keeps main-group access, even if the plan string
    // is blank or has drifted from plans.ts.
    markets.add(MAIN_MARKET);
    for (const m of parsePlanType(row.currentPlan ?? "").markets) {
      // Filter falsy: parsePlanType("") returns markets [""], and a stray ""
      // in the set would make entitledMarkets' return value wrong.
      if (m) markets.add(m);
    }
  }
  return markets;
}

/**
 * The groups to remove from: every configured group whose market is not in the
 * entitled set. Deliberately independent of the cancelled row's own plan
 * string, so a drifted or blank plan cannot leave someone un-removed.
 */
export function groupsToRemove(
  entitled: Set<string>,
  groups: GroupConfig[]
): GroupConfig[] {
  return groups.filter((g) => !entitled.has(g.market));
}

/** Whitelisted usernames are never removed from anything. */
export function isWhitelisted(
  username: string | undefined,
  whitelist: Set<string>
): boolean {
  const u = normaliseTelegramUsername(username);
  return u !== "" && whitelist.has(u);
}
```

Note: `parsePlanType("")` returns `{ category: "unknown", markets: [""] }`. The empty string must be filtered out — it would never match a `GroupConfig.market`, so it is harmless for `groupsToRemove`, but the blank-plan test asserts on `entitledMarkets`' return value directly with `toEqual`, so a stray `""` in the set fails it. Hence the `if (m)` guard.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: PASS — 17 tests

- [ ] **Step 5: Commit**

```bash
git add lib/telegram-groups.ts lib/telegram-groups.test.ts
git commit -m "feat(telegram): pure entitlement + whitelist rules for group removal"
```

---

### Task 2: Env configuration loaders

**Files:**
- Modify: `lib/telegram-groups.ts`
- Modify: `lib/telegram-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/telegram-groups.test.ts`:

```typescript
import { loadGroupsFromEnv, loadWhitelistFromEnv, isDryRun } from "./telegram-groups.js";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: FAIL — `loadGroupsFromEnv is not a function`

- [ ] **Step 3: Implement the loaders**

Append to `lib/telegram-groups.ts`:

```typescript
// -----------------------------------------------------------------------------
// Configuration. Everything comes from env so nothing is hardcoded twice.
//
// These chat IDs and the whitelist are duplicated from the bot repo's
// config.py. That duplication disappears when the bots move onto Vercel; until
// then, change both. See CLAUDE.md.
// -----------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const GROUP_ENV: ReadonlyArray<{ key: string; market: string; envVar: string }> = [
  { key: "HK_MARKET", market: "HK", envVar: "TELEGRAM_CHAT_HK" },
  { key: "SG_MARKET", market: "SG", envVar: "TELEGRAM_CHAT_SG" },
  { key: "US_MARKET", market: "US", envVar: "TELEGRAM_CHAT_US" },
  { key: "FXMC_MARKET", market: "FXMC", envVar: "TELEGRAM_CHAT_FXMC" },
  { key: "MAIN_GROUP", market: MAIN_MARKET, envVar: "TELEGRAM_CHAT_MAIN" },
];

/**
 * Build the group list from env. A missing or malformed chat ID drops that one
 * group rather than throwing — a typo must never take the webhook down, and a
 * partially configured deployment should still remove from the groups it knows.
 */
export function loadGroupsFromEnv(env: Env = process.env): GroupConfig[] {
  const groups: GroupConfig[] = [];
  for (const { key, market, envVar } of GROUP_ENV) {
    const raw = env[envVar]?.trim();
    if (!raw) continue;
    const chatId = Number(raw);
    if (!Number.isFinite(chatId)) {
      console.warn(`${envVar} is not a number ("${raw}") — skipping ${key}`);
      continue;
    }
    groups.push({ key, chatId, market });
  }
  return groups;
}

/** Usernames never removed from anything. Mirrors config.py WHITELIST. */
export function loadWhitelistFromEnv(env: Env = process.env): Set<string> {
  const raw = env.TELEGRAM_KICK_WHITELIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => normaliseTelegramUsername(s))
      .filter((s) => s !== "")
  );
}

/** Dry-run reports what it would do without calling banChatMember. */
export function isDryRun(env: Env = process.env): boolean {
  return env.TELEGRAM_KICK_DRY_RUN === "true";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: PASS — 27 tests

- [ ] **Step 5: Commit**

```bash
git add lib/telegram-groups.ts lib/telegram-groups.test.ts
git commit -m "feat(telegram): env loaders for group chat IDs, whitelist and dry-run"
```

---

### Task 3: The remover seam, Noop, and the Telegram API client

**Files:**
- Modify: `lib/telegram-groups.ts`
- Modify: `lib/telegram-groups.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/telegram-groups.test.ts`:

```typescript
import { TelegramGroupApi, NoopTelegramGroupRemover } from "./telegram-groups.js";

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: FAIL — `TelegramGroupApi is not a constructor`

- [ ] **Step 3: Implement the seam, the Noop and the API client**

Append to `lib/telegram-groups.ts`:

```typescript
// -----------------------------------------------------------------------------
// The seam the lifecycle uses. It knows nothing about HTTP or chat IDs — only
// "this person's subscription ended; remove them from what they've lost".
// In tests it's satisfied by a recording fake; in production by TelegramGroupApi.
// -----------------------------------------------------------------------------

export interface RemovalInput {
  /** Col P. Blank means the subscriber never joined — nothing to remove. */
  telegramUserId: string;
  /** Col D. Used for the whitelist check and entitlement matching. */
  telegramUsername: string;
  /** Every sheet row, so other live subscriptions can be honoured. */
  allSubscribers: Subscriber[];
}

export interface RemovalResult {
  /** Group keys actually removed from (or, in dry-run, that would have been). */
  removed: string[];
  /** Group keys where the user was not a member — nothing to do. */
  skipped: string[];
  /** "GROUP_KEY: message" for each group that errored. */
  failures: string[];
  dryRun: boolean;
  /** Set when the whole removal was short-circuited. */
  reason?: "whitelisted" | "no-user-id" | "not-configured";
}

export interface TelegramGroupRemover {
  /** False on the Noop so callers don't claim a removal that never happened. */
  readonly configured?: boolean;
  removeFromGroups(input: RemovalInput): Promise<RemovalResult>;
}

/** Used when no chat IDs or no bot token are configured. Never throws. */
export class NoopTelegramGroupRemover implements TelegramGroupRemover {
  readonly configured = false;

  async removeFromGroups(): Promise<RemovalResult> {
    return { removed: [], skipped: [], failures: [], dryRun: false, reason: "not-configured" };
  }
}

/** Chat-member statuses that mean "currently in the group". */
const MEMBER_STATUSES = new Set(["member", "administrator", "creator"]);

function isCurrentMember(result: { status?: string; is_member?: boolean }): boolean {
  if (!result?.status) return false;
  if (MEMBER_STATUSES.has(result.status)) return true;
  // A "restricted" user may be in or out of the group — the flag decides.
  return result.status === "restricted" && result.is_member === true;
}

export interface TelegramGroupApiOptions {
  token: string;
  groups: GroupConfig[];
  whitelist: Set<string>;
  dryRun: boolean;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class TelegramGroupApi implements TelegramGroupRemover {
  readonly configured = true;

  private readonly token: string;
  private readonly groups: GroupConfig[];
  private readonly whitelist: Set<string>;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramGroupApiOptions) {
    if (!opts.token) throw new Error("TelegramGroupApi needs a bot token");
    this.token = opts.token;
    this.groups = opts.groups;
    this.whitelist = opts.whitelist;
    this.dryRun = opts.dryRun;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async removeFromGroups(input: RemovalInput): Promise<RemovalResult> {
    const base: RemovalResult = {
      removed: [],
      skipped: [],
      failures: [],
      dryRun: this.dryRun,
    };

    if (isWhitelisted(input.telegramUsername, this.whitelist)) {
      return { ...base, reason: "whitelisted" };
    }

    const userId = input.telegramUserId?.trim();
    if (!userId) return { ...base, reason: "no-user-id" };

    const entitled = entitledMarkets(input.telegramUsername, input.allSubscribers);
    const targets = groupsToRemove(entitled, this.groups);

    for (const group of targets) {
      try {
        if (!(await this.isMember(group.chatId, userId))) {
          base.skipped.push(group.key);
          continue;
        }
        if (!this.dryRun) {
          await this.call("banChatMember", { chat_id: group.chatId, user_id: userId });
          // only_if_banned so a race can't turn the unban into a second removal.
          await this.call("unbanChatMember", {
            chat_id: group.chatId,
            user_id: userId,
            only_if_banned: true,
          });
        }
        base.removed.push(group.key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        base.failures.push(`${group.key}: ${message}`);
      }
    }

    return base;
  }

  /**
   * Is this user currently in the chat? A failed lookup means Telegram doesn't
   * know them there (they never joined) — treat as "not a member" and skip
   * quietly, exactly as common.py kick_user() does. A ban would fail the same
   * way, and transient errors self-heal on scheduler.py's next sweep.
   */
  private async isMember(chatId: number, userId: string): Promise<boolean> {
    try {
      const result = await this.call<{ status?: string; is_member?: boolean }>(
        "getChatMember",
        { chat_id: chatId, user_id: userId }
      );
      return isCurrentMember(result);
    } catch {
      return false;
    }
  }

  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const res = await this.fetchImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      }
    );
    const body = (await res.json()) as { ok?: boolean; result?: T; description?: string };
    if (!body.ok) {
      throw new Error(body.description ?? `Telegram ${method} failed (HTTP ${res.status})`);
    }
    return body.result as T;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean)

- [ ] **Step 6: Commit**

```bash
git add lib/telegram-groups.ts lib/telegram-groups.test.ts
git commit -m "feat(telegram): group remover seam, Noop and Bot API client"
```

---

### Task 4: Wire the remover into the ENDED handler

**Files:**
- Modify: `lib/subscription-lifecycle.ts`
- Modify: `lib/subscription-lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/subscription-lifecycle.test.ts`, next to the other fakes (after `UnconfiguredTradingView`):

```typescript
import type {
  TelegramGroupRemover,
  RemovalInput,
  RemovalResult,
} from "./telegram-groups.js";

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
```

Then add this test block:

```typescript
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
      store,
      noopMailer,
      new RecordingNotifier(),
      new RecordingEventLog(),
      new RecordingTradingView(),
      groups
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(groups.calls).toHaveLength(1);
    expect(groups.calls[0].telegramUserId).toBe("999");
    expect(groups.calls[0].telegramUsername).toBe("tanahkow");
    // The whole sheet is passed so other live subscriptions are honoured.
    expect(groups.calls[0].allSubscribers).toHaveLength(1);
  });

  it("pings the outcome", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store,
      noopMailer,
      notifier,
      new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups()
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
      store,
      noopMailer,
      notifier,
      new RecordingEventLog(),
      new RecordingTradingView(),
      new RecordingTelegramGroups({ dryRun: true })
    );

    await lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" });

    expect(notifier.messages.join("\n")).toContain("DRY RUN");
  });

  it("does not fail the webhook when Telegram throws", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const notifier = new RecordingNotifier();
    const lifecycle = new SubscriptionLifecycle(
      store,
      noopMailer,
      notifier,
      new RecordingEventLog(),
      new RecordingTradingView(),
      new ThrowingTelegramGroups()
    );

    await expect(
      lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" })
    ).resolves.toBeUndefined();

    expect(notifier.messages.join("\n")).toContain("telegram is down");
    // The status write still happened. FakeStore.applyUpdate records patches
    // rather than mutating the row, so assert on `.patches`.
    expect(store.patches.some((p) => p.status === "CANCELLED")).toBe(true);
  });

  it("still works when no remover is injected (defaults to Noop)", async () => {
    const store = storeWith(
      makeSubscriber({ stripeSubscriptionId: "sub_123", telegramUserId: "999" })
    );
    const lifecycle = new SubscriptionLifecycle(
      store,
      noopMailer,
      new RecordingNotifier(),
      new RecordingEventLog(),
      new RecordingTradingView()
    );

    await expect(
      lifecycle.apply({ kind: "ENDED", stripeSubscriptionId: "sub_123" })
    ).resolves.toBeUndefined();
  });
});
```

Harness names verified against `lib/subscription-lifecycle.test.ts` on 2026-08-03 — use them exactly as written: `FakeStore` (fields `.rows` and `.patches`, **no constructor arguments**; `applyUpdate` records a patch and does not mutate the row; `listAll()` returns `.rows`), `RecordingNotifier` (field `.messages`), `RecordingEventLog`, `RecordingTradingView`, `noopMailer`, `makeSubscriber`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/subscription-lifecycle.test.ts`
Expected: FAIL — `Expected 5 arguments, but got 6` / `groups.calls` is empty

- [ ] **Step 3: Add the collaborator to the constructor**

In `lib/subscription-lifecycle.ts`, add the import next to the TradingView one:

```typescript
import {
  NoopTelegramGroupRemover,
  type TelegramGroupRemover,
} from "./telegram-groups.js";
```

Change the constructor (around line 81) to:

```typescript
  constructor(
    private readonly store: SubscriberStore,     // reads/writes the sheet
    private readonly mailer: Mailer,             // sends customer emails
    private readonly notifier: AdminNotifier,    // pings Joseph on Telegram
    private readonly eventLog: EventLog,         // appends to the Status Log tab
    private readonly tradingview: TradingViewGranter, // grants/removes TV script access
    // Removes cancelled subscribers from the Telegram groups. Optional and
    // defaulted so existing call sites (and tests) keep compiling; production
    // injects the real one from api/stripe-webhook.ts.
    private readonly telegramGroups: TelegramGroupRemover = new NoopTelegramGroupRemover()
  ) {}
```

- [ ] **Step 4: Add the side-effect builder**

Add these methods immediately after `pingTv` (around line 178):

```typescript
  // ---------------------------------------------------------------------------
  // Telegram group removal — the counterpart to tvRemove. Returns an array of
  // 0 or 1 promises so it spreads into runSideEffects([...]).
  //
  // Fires only on ENDED: a subscriber whose cancellation is merely SCHEDULED has
  // paid through their period end and keeps group access until it arrives.
  //
  // Never rejects. Group removal failing must not fail the webhook, and
  // scheduler.py's noon sweep is the safety net that catches whatever this misses.
  // ---------------------------------------------------------------------------
  private telegramRemove(subscriber: Subscriber): Promise<unknown>[] {
    if (this.telegramGroups.configured === false) return [];
    return [this.applyTelegramRemoval(subscriber)];
  }

  private async applyTelegramRemoval(subscriber: Subscriber): Promise<void> {
    const handle = subscriber.telegramUsername
      ? `@${subscriber.telegramUsername}`
      : "(not in sheet)";

    try {
      const all = await this.store.listAll();
      const result = await this.telegramGroups.removeFromGroups({
        telegramUserId: subscriber.telegramUserId,
        telegramUsername: subscriber.telegramUsername,
        allSubscribers: all,
      });

      if (result.reason === "whitelisted") {
        await this.pingTv(
          [`<b>🛡️ Telegram groups skipped — whitelisted</b>`, handle].join("\n")
        );
        return;
      }
      if (result.reason === "no-user-id") {
        await this.pingTv(
          [
            `<b>⚠️ Telegram groups — no User ID on file</b>`,
            handle,
            `<i>Col P is blank, so there's nobody to remove. If they are in the groups, remove them by hand.</i>`,
          ].join("\n")
        );
        return;
      }

      const prefix = result.dryRun ? `<b>🧪 DRY RUN — Telegram groups</b>` : `<b>🗑️ Telegram groups removed</b>`;
      const verb = result.dryRun ? "would remove from" : "removed from";
      const lines = [
        prefix,
        handle,
        `<b>${verb}:</b> ${result.removed.length ? result.removed.join(", ") : "(nothing)"}`,
      ];
      if (result.skipped.length) lines.push(`<b>Not a member of:</b> ${result.skipped.join(", ")}`);
      if (result.failures.length) lines.push(`<b>❌ Failed:</b> ${result.failures.join(" | ")}`);
      await this.pingTv(lines.join("\n"));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.pingTv(
        [
          `<b>❌ Telegram group removal FAILED</b>`,
          handle,
          detail,
          `<i>Remove them by hand, or leave it — scheduler.py sweeps at 12:00 PM SGT.</i>`,
        ].join("\n")
      );
      // Swallowed on purpose: reported above, and group removal must never fail
      // the webhook. Same contract as applyTvAccess.
    }
  }
```

- [ ] **Step 5: Call it from `handleEnded`**

In `handleEnded`, add to the `tasks` array immediately after the `tvRemove` line (around line 1007):

```typescript
      ...this.tvRemove(existing.tradingViewUsername, existing.currentPlan),
      // Telegram access ends at the same moment TradingView access does.
      ...this.telegramRemove(existing),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/subscription-lifecycle.test.ts`
Expected: PASS — including the five new tests

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors. The existing 5-argument `new SubscriptionLifecycle(...)` call sites still compile because the sixth parameter is defaulted.

- [ ] **Step 8: Commit**

```bash
git add lib/subscription-lifecycle.ts lib/subscription-lifecycle.test.ts
git commit -m "feat(telegram): remove cancelled subscribers from groups on ENDED"
```

---

### Task 5: Build the real remover in the webhook edge

**Files:**
- Modify: `api/stripe-webhook.ts`

- [ ] **Step 1: Add the import**

Next to the TradingView imports (around line 41):

```typescript
import {
  TelegramGroupApi,
  NoopTelegramGroupRemover,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  isDryRun,
  type TelegramGroupRemover,
} from "../lib/telegram-groups.js";
```

- [ ] **Step 2: Add the builder**

Immediately after `buildTradingViewGranter()` (around line 61):

```typescript
// Build the Telegram group remover. Reuses TELEGRAM_BOT_TOKEN — the same bot
// the Python access bot runs on, which is already an admin in every group. If
// the token or the chat IDs are missing, fall back to a no-op: the webhook
// keeps working and scheduler.py's noon sweep remains the only remover.
function buildTelegramGroupRemover(): TelegramGroupRemover {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groups = loadGroupsFromEnv();
  if (!token || groups.length === 0) {
    console.warn(
      "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_* not set — instant group removal disabled (scheduler.py fallback)"
    );
    return new NoopTelegramGroupRemover();
  }
  return new TelegramGroupApi({
    token,
    groups,
    whitelist: loadWhitelistFromEnv(),
    dryRun: isDryRun(),
  });
}
```

- [ ] **Step 3: Pass it into the lifecycle**

In `buildLifecycle()`, the `new SubscriptionLifecycle(...)` call currently ends with `buildTradingViewGranter()` as its fifth argument. Add a sixth:

```typescript
    buildTradingViewGranter(),
    buildTelegramGroupRemover()
  );
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add api/stripe-webhook.ts
git commit -m "feat(telegram): wire the group remover into the webhook edge"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README-webhook.md`

- [ ] **Step 1: Document the collaborator in `CLAUDE.md`**

In the "Webhook architecture" section, after the **TradingView access automation** paragraph, add:

```markdown
**Telegram group removal** (`lib/telegram-groups.ts`): removes a cancelled subscriber from
the Telegram groups they've lost, on `ENDED`, within seconds — instead of waiting for the
bot repo's `scheduler.py` sweep at 12:00 PM SGT. Injected as a sixth lifecycle collaborator
via the `TelegramGroupRemover` seam (`NoopTelegramGroupRemover` when the token or chat IDs
are absent). Reuses `TELEGRAM_BOT_TOKEN` — the same bot the Python access bot runs on, which
is already an admin in all five groups. The entitlement rule is a port of the bot's
`access.py`: any non-`CANCELLED` row for the same Telegram username keeps the markets it
covers plus the `MAIN` pseudo-market, and removal targets every group not covered — so a
second live subscription can't be removed by a cancelled one. Plan→market resolution reuses
`parsePlanType()`, so no new plan duplication. **It only ever acts on the one User ID it is
handed — it never enumerates group membership, so people with no sheet row (comped friends
added by hand) are unreachable by it.** Fires only on `ENDED`, never on
`CANCELLATION_SCHEDULED` — a scheduled cancellation keeps access until the paid period ends.
`comp-expiry.ts` writes `CANCELLED` directly without emitting `ENDED`, so expiring comps are
still swept by `scheduler.py` on the daily cadence. Behind `TELEGRAM_KICK_DRY_RUN` while
being validated. Design: `docs/superpowers/specs/2026-08-03-instant-telegram-removal-on-cancellation-design.md`.

**Config duplicated from the bot repo (keep in sync, like `plans.ts`):** the five group chat
IDs (`TELEGRAM_CHAT_*`) and the kick whitelist (`TELEGRAM_KICK_WHITELIST`) mirror `GROUPS`
and `WHITELIST` in the bot's `config.py`. Change both. This duplication disappears if the
bots are migrated onto Vercel.
```

- [ ] **Step 2: Add the env vars to `README-webhook.md`**

Add to the environment-variable table:

| Var | Purpose |
|---|---|
| `TELEGRAM_CHAT_HK` | HK signal group chat ID (`-1003174239460`) |
| `TELEGRAM_CHAT_SG` | SG signal group chat ID (`-1003120184464`) |
| `TELEGRAM_CHAT_US` | US signal group chat ID (`-1002970318018`) |
| `TELEGRAM_CHAT_FXMC` | FXMC signal group chat ID (`-1002929109438`) |
| `TELEGRAM_CHAT_MAIN` | Main subscribers group chat ID (`-1003175647154`) |
| `TELEGRAM_KICK_WHITELIST` | Comma-separated usernames never removed. Mirrors `config.py` `WHITELIST`: `Joseph_Ho,robinhosa,noahiee,christianadr` |
| `TELEGRAM_KICK_DRY_RUN` | `true` → report what would be removed without removing. Set `false` to go live. |

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README-webhook.md
git commit -m "docs: instant Telegram group removal on cancellation"
```

---

### Task 7: Deploy in dry-run and validate

**Files:** none (operational)

- [ ] **Step 1: Set the env vars in Vercel (Production)**

All seven from Task 6 Step 2. `TELEGRAM_KICK_DRY_RUN` must be **`true`**.

Also add them to the local `Website/.env` for parity. `.env` is gitignored — never commit it.

- [ ] **Step 2: Deploy**

Run the Playground `/push-website` skill, or `git push origin main`. Vercel auto-deploys from `main`.

- [ ] **Step 3: Verify the dry-run on the next real cancellation**

On the next `ENDED`, expect a `🧪 DRY RUN — Telegram groups` ping listing the groups it would remove from. Cross-check against what `scheduler.py` actually removes at 12:00 PM SGT the following day. They should agree.

If nobody cancels naturally, verify against a test-mode subscription instead: subscribe via a Stripe **test** payment link (see `../MEMORY.md` for the test links), then cancel it immediately in the Stripe dashboard in test mode.

- [ ] **Step 4: Go live**

Once the dry-run pings match the noon sweep for at least two cancellations, set `TELEGRAM_KICK_DRY_RUN=false` in Vercel and redeploy.

- [ ] **Step 5: Confirm `scheduler.py` is untouched**

No change was made to the bot repo. It should keep running exactly as before, now finding nothing left to remove on most days. That is the expected steady state and proves the webhook path is working.

---

## Out of scope (tracked separately)

Migrating `bot.py` and `scheduler.py` onto Vercel — the join guard becoming a Telegram webhook (`setWebhook` with `allowed_updates: ["chat_member"]` and a `secret_token`), the daily kicker becoming a Vercel Cron at `0 4 * * *` (12:00 PM SGT). `lib/telegram-groups.ts` is deliberately built as the seam that migration will reuse. Note that `setWebhook` disables `getUpdates`, so that migration is a hard cutover and cannot run in parallel with `bot.py`.
