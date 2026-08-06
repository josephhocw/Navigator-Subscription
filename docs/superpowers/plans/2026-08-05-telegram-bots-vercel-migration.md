# Telegram Access Bots → Vercel Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the VPS Python bots (`bot.py` join guard, `scheduler.py` daily kicker) with Vercel serverless functions in this repo, add instant Telegram group removal on plan changes, and retire the VPS processes — with staging + shadow-soak validation and an atomic zero-downtime cutover.

**Architecture:** A Telegram webhook endpoint (`api/telegram-webhook.ts`) receives `chat_member` join events pushed by Telegram and enforces the join policy; a daily cron (`api/telegram-sweep.ts`) reconciles every known member's group access against their sheet entitlements; the existing `TelegramGroupRemover` seam gains plan-change call sites in the lifecycle. All decision logic is pure, tested, and reuses `lib/telegram-groups.ts` + `lib/plans.ts` — the bot repo's `config.py` duplication dies.

**Tech Stack:** TypeScript, Vercel serverless + cron, vitest, Telegram Bot API (webhook mode), Google Sheets via existing `lib/sheets.ts`.

**Spec:** `docs/superpowers/specs/2026-08-05-telegram-bots-vercel-migration-design.md` — read it first.

> **PROGRESS (verified against git 2026-08-07):** Tasks 1–9 complete and pushed (Tasks 1–7 code commits `d32307e`…`2b5d994` + review-fix commits; Task 8 docs + Task 9 runbook in `3af8cad`). Task 10 complete — staging rig built and E2E matrix executed 2026-08-06, 11/11 pass, recorded in `docs/runbooks/telegram-migration-cutover.md` (Phase B banner). **Next: Task 11 (prod shadow soak, runbook section C)** — before starting it, clear the runbook's open deploy-time checks (4th cron accepted, maxDuration in effect, prod whitelist non-empty) and `git pull` + restart the VPS bots so they carry the TRIAL_CANCELLED barring. Task 12 (cutover + retirement) not started. Known staging noise: the shared `vercel.json` crons also fire on the staging project, where `STRIPE_*`/`RESEND_*` are deliberately absent — the nightly `standardise-trial-ends` (and potentially `followup-send`) fail there and ping the TEST bot ("Neither apiKey nor config.authenticator provided"). Prod is unaffected; silence it by removing `CRON_SECRET` from the staging project (crons then 401 quietly; the join webhook doesn't use it).

**Conventions for this repo:**
- Run tests: `npm test` (vitest). Run one file: `npx vitest run lib/telegram-access.test.ts`. Typecheck: `npx tsc --noEmit`.
- Imports between lib files use the `.js` suffix (`from "./plans.js"`) — NodeNext resolution. Follow this everywhere.
- Commit after every green step. NEVER push to `main` unless told — every push deploys to production. All work is commit-only; Joseph pushes via `/push-website` at the deploy checkpoints marked below.
- The Python sources being ported live OUTSIDE this repo at `../Telegram Bot/` (`access.py`, `bot.py`, `scheduler.py`, `test_access.py`) — read them for reference; never modify them.

---

## Task 1: `kickFromChat` + generic dry-run flag helper in `lib/telegram-groups.ts`

The join guard and sweep need to kick through the same tested ban+unban path `removeFromGroups` uses. Extract it as a public method. Also generalise the dry-run flag parser so `TELEGRAM_JOIN_DRY_RUN` / `TELEGRAM_SWEEP_DRY_RUN` get identical fail-safe semantics.

**Files:**
- Modify: `lib/telegram-groups.ts`
- Test: `lib/telegram-groups.test.ts` (extend existing file)

- [x] **Step 1: Write the failing tests**

Add to `lib/telegram-groups.test.ts` (follow the existing test style in that file — it stubs `fetchImpl`):

```ts
import { flagIsDryRun } from "./telegram-groups.js";

describe("flagIsDryRun", () => {
  it("only the literal false goes live", () => {
    expect(flagIsDryRun("X", { X: "false" })).toBe(false);
    expect(flagIsDryRun("X", { X: " FALSE " })).toBe(false);
    expect(flagIsDryRun("X", { X: "true" })).toBe(true);
    expect(flagIsDryRun("X", { X: "" })).toBe(true);
    expect(flagIsDryRun("X", { X: "flase" })).toBe(true);
    expect(flagIsDryRun("X", {})).toBe(true);
  });
});

describe("kickFromChat", () => {
  it("bans then unbans and reports removed", async () => {
    const calls: string[] = [];
    const api = new TelegramGroupApi({
      token: "TOKEN12345",
      groups: [],
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: (async (url: string) => {
        calls.push(String(url).split("/").pop()!);
        return new Response(JSON.stringify({ ok: true, result: true }));
      }) as typeof fetch,
    });
    const out = await api.kickFromChat(-100123, "42");
    expect(out.outcome).toBe("removed");
    expect(calls).toEqual(["banChatMember", "unbanChatMember"]);
  });

  it("reports still-banned when the unban fails twice", async () => {
    const api = new TelegramGroupApi({
      token: "TOKEN12345",
      groups: [],
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: (async (url: string) => {
        const method = String(url).split("/").pop()!;
        if (method === "banChatMember")
          return new Response(JSON.stringify({ ok: true, result: true }));
        return new Response(JSON.stringify({ ok: false, description: "boom" }), { status: 400 });
      }) as typeof fetch,
    });
    const out = await api.kickFromChat(-100123, "42");
    expect(out.outcome).toBe("still-banned");
    if (out.outcome === "still-banned") expect(out.unbanError).toContain("boom");
  });

  it("throws when the ban itself fails", async () => {
    const api = new TelegramGroupApi({
      token: "TOKEN12345",
      groups: [],
      whitelist: new Set(),
      dryRun: false,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, description: "no rights" }), { status: 403 })
      ) as typeof fetch,
    });
    await expect(api.kickFromChat(-100123, "42")).rejects.toThrow();
  });
});
```

- [x] **Step 2: Run tests, verify the new ones fail**

Run: `npx vitest run lib/telegram-groups.test.ts`
Expected: FAIL — `flagIsDryRun` and `kickFromChat` don't exist.

- [x] **Step 3: Implement**

In `lib/telegram-groups.ts`:

(a) Replace the body of `isDryRun` with a generic helper (keep `isDryRun` — existing callers use it):

```ts
/**
 * Generic fail-safe dry-run flag: only the literal "false" (trimmed,
 * case-insensitive) goes live. An unset variable, a typo, or a var scoped to
 * Preview only all stay in dry-run. Shared by the kick, join-guard and sweep
 * flags so all three behave identically.
 */
export function flagIsDryRun(envVar: string, env: Env = process.env): boolean {
  return (env[envVar] ?? "true").trim().toLowerCase() !== "false";
}

export function isDryRun(env: Env = process.env): boolean {
  return flagIsDryRun("TELEGRAM_KICK_DRY_RUN", env);
}
```

(b) Add the public kick to `TelegramGroupApi` (place it above `removeFromGroups`):

```ts
export type KickOutcome =
  | { outcome: "removed" }
  | { outcome: "still-banned"; unbanError: string };

/**
 * Ban + unban — Telegram's "remove without a permanent ban" — with the same
 * retry-then-report-loudly unban semantics removeFromGroups always had.
 * Throws if the BAN fails (nothing happened); returns "still-banned" if the
 * ban landed but both unbans failed (the user is out AND locked out — needs
 * a human). Public so the join guard and daily sweep kick through this one
 * tested path.
 */
async kickFromChat(chatId: number, userId: string): Promise<KickOutcome> {
  await this.call("banChatMember", { chat_id: chatId, user_id: userId });
  try {
    await this.unban(chatId, userId);
  } catch {
    try {
      await this.unban(chatId, userId);
    } catch (err) {
      return { outcome: "still-banned", unbanError: this.describe(err) };
    }
  }
  return { outcome: "removed" };
}
```

(c) Refactor the ban/unban block inside `removeFromGroups` (the `if (!this.dryRun) { ... }` section) to use it, preserving the exact failure string:

```ts
if (!this.dryRun) {
  const kick = await this.kickFromChat(group.chatId, userId);
  if (kick.outcome === "still-banned") {
    base.removed.push(group.key);
    base.outstandingBans.push(group.key);
    base.failures.push(
      `${group.key}: BANNED BUT NOT UNBANNED — user ${userId} is still banned in chat ${group.chatId} and cannot rejoin. Unban by hand. (${kick.unbanError})`
    );
    continue;
  }
}
base.removed.push(group.key);
```

- [x] **Step 4: Run the FULL test file — new tests pass, no existing test broke**

Run: `npx vitest run lib/telegram-groups.test.ts` then `npx tsc --noEmit`
Expected: all PASS, typecheck clean. The existing `removeFromGroups` tests are the regression net for the refactor — if any fails, the refactor changed behaviour; fix the refactor, not the test.

- [x] **Step 5: Commit**

```bash
git add lib/telegram-groups.ts lib/telegram-groups.test.ts
git commit -m "refactor: extract kickFromChat + generic dry-run flag for join guard and sweep"
```

---

## Task 2: `lib/telegram-access.ts` — join-decision logic (pure, ported from access.py)

**Files:**
- Create: `lib/telegram-access.ts`
- Create: `lib/telegram-access.test.ts`
- Reference: `../Telegram Bot/access.py`, `../Telegram Bot/test_access.py`

One deliberate divergence from `access.py` (per spec): an unrecognised plan on a live row **fails safe** — allow + report — instead of granting nothing and kicking a paying subscriber over a typo. Mirrors `hasUnrecognisedLivePlan` in `telegram-groups.ts`.

- [x] **Step 1: Write the failing tests**

Create `lib/telegram-access.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  evaluateJoin,
  isJoinTransition,
  type JoinVerdict,
} from "./telegram-access.js";
import { MAIN_MARKET, type GroupConfig } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

// Minimal subscriber row — only the fields the join guard reads, plus rowIndex.
let nextRow = 2;
function row(over: Partial<Subscriber>): Subscriber {
  return {
    rowIndex: nextRow++,
    email: "x@example.com",
    customerName: "",
    tradingViewUsername: "",
    telegramUsername: "",
    status: "ACTIVE",
    currentPlan: "",
    latestAction: "",
    previousPlan: "",
    subscriptionPrice: 0,
    couponDiscount: false,
    subscriptionStart: "",
    subscriptionExpiry: "",
    subscriptionCount: 1,
    failedPaymentCount: 0,
    stripeSubscriptionId: "sub_x",
    telegramUserId: "",
    referralSource: "",
    followupSent: "",
    mobileNumber: "",
    ...over,
  };
}

const US_GROUP: GroupConfig = { key: "US_MARKET", chatId: -1, market: "US" };
const HK_GROUP: GroupConfig = { key: "HK_MARKET", chatId: -2, market: "HK" };
const SG_GROUP: GroupConfig = { key: "SG_MARKET", chatId: -3, market: "SG" };
const MAIN_GROUP: GroupConfig = { key: "MAIN_GROUP", chatId: -5, market: MAIN_MARKET };
const NO_WHITELIST = new Set<string>();

function verdictOf(v: JoinVerdict) {
  return v.decision === "kick" ? `kick:${v.reason}` : v.decision;
}

describe("evaluateJoin — market groups (ports test_access.py)", () => {
  it("kicks a joiner with no username", () => {
    expect(verdictOf(evaluateJoin(undefined, US_GROUP, [], NO_WHITELIST))).toBe("kick:no-username");
    expect(verdictOf(evaluateJoin("", US_GROUP, [], NO_WHITELIST))).toBe("kick:no-username");
  });

  it("allows a whitelisted user with no sheet lookup", () => {
    const v = evaluateJoin("@Joseph_Ho", US_GROUP, [], new Set(["joseph_ho"]));
    expect(v).toEqual({ decision: "allow", rowsToUpdate: [], reason: "whitelisted" });
  });

  it("kicks when the username is not in the sheet", () => {
    const all = [row({ telegramUsername: "other", currentPlan: "HK" })];
    expect(verdictOf(evaluateJoin("ghost", US_GROUP, all, NO_WHITELIST))).toBe("kick:not-found");
  });

  it("kicks when every row is CANCELLED", () => {
    const all = [row({ telegramUsername: "joe", status: "CANCELLED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, all, NO_WHITELIST))).toBe("kick:cancelled");
  });

  it("allows an active row whose plan covers the market, returning it for the col-P write", () => {
    const r = row({ telegramUsername: "joe", currentPlan: "US" });
    const v = evaluateJoin("joe", US_GROUP, [r], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([r]);
  });

  it("matches case-insensitively and @-tolerantly", () => {
    const r = row({ telegramUsername: "@MaxK", currentPlan: "US" });
    expect(verdictOf(evaluateJoin("maxk", US_GROUP, [r], NO_WHITELIST))).toBe("allow");
  });

  it("a second active row rescues a cancelled first row; ID written to active rows only", () => {
    const dead = row({ telegramUsername: "maxk", status: "CANCELLED", currentPlan: "US" });
    const live = row({ telegramUsername: "maxk", status: "ACTIVE", currentPlan: "US" });
    const v = evaluateJoin("maxk", US_GROUP, [dead, live], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([live]);
  });

  it("unions plans across active rows", () => {
    const a = row({ telegramUsername: "maxk", currentPlan: "US" });
    const b = row({ telegramUsername: "maxk", currentPlan: "HK" });
    const v = evaluateJoin("maxk", HK_GROUP, [a, b], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([a, b]);
  });

  it("kicks an active subscriber whose plan does not cover this market", () => {
    const all = [row({ telegramUsername: "joe", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", HK_GROUP, all, NO_WHITELIST))).toBe("kick:wrong-plan");
  });

  it("PAYMENT_FAILED and CANCELLATION_SCHEDULED are still entitled", () => {
    const pf = [row({ telegramUsername: "joe", status: "PAYMENT_FAILED", currentPlan: "US" })];
    const cs = [row({ telegramUsername: "joe", status: "CANCELLATION_SCHEDULED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", US_GROUP, pf, NO_WHITELIST))).toBe("allow");
    expect(verdictOf(evaluateJoin("joe", US_GROUP, cs, NO_WHITELIST))).toBe("allow");
  });

  it("a combo grants the SG bonus group", () => {
    const all = [row({ telegramUsername: "joe", currentPlan: "US_HK" })];
    expect(verdictOf(evaluateJoin("joe", SG_GROUP, all, NO_WHITELIST))).toBe("allow");
  });

  it("DIVERGENCE from access.py: an unrecognised live plan fails safe (allow + flag)", () => {
    const r = row({ telegramUsername: "joe", currentPlan: "BANANA" });
    const v = evaluateJoin("joe", US_GROUP, [r], NO_WHITELIST);
    expect(v.decision).toBe("allow-unrecognised-plan");
    if (v.decision === "allow-unrecognised-plan") expect(v.rowsToUpdate).toEqual([r]);
  });
});

describe("evaluateJoin — main group (lenient)", () => {
  it("welcomes a guest who is not in the sheet", () => {
    const v = evaluateJoin("stranger", MAIN_GROUP, [], NO_WHITELIST);
    expect(v).toEqual({ decision: "allow", rowsToUpdate: [], reason: "guest" });
  });

  it("welcomes a joiner with no username", () => {
    const v = evaluateJoin(undefined, MAIN_GROUP, [], NO_WHITELIST);
    expect(v).toEqual({ decision: "allow", rowsToUpdate: [], reason: "guest" });
  });

  it("kicks only when ALL rows are CANCELLED", () => {
    const all = [row({ telegramUsername: "joe", status: "CANCELLED", currentPlan: "US" })];
    expect(verdictOf(evaluateJoin("joe", MAIN_GROUP, all, NO_WHITELIST))).toBe("kick:cancelled");
  });

  it("any live row allows, even a blank or drifted plan string", () => {
    const blank = row({ telegramUsername: "joe", currentPlan: "" });
    const v1 = evaluateJoin("joe", MAIN_GROUP, [blank], NO_WHITELIST);
    expect(v1.decision).toBe("allow");
    if (v1.decision === "allow") expect(v1.rowsToUpdate).toEqual([blank]);
    const drifted = row({ telegramUsername: "moe", currentPlan: "BANANA" });
    expect(evaluateJoin("moe", MAIN_GROUP, [drifted], NO_WHITELIST).decision).toBe("allow");
  });

  it("one cancelled + one active row still allows, ID to the active row only", () => {
    const dead = row({ telegramUsername: "maxkohts", status: "CANCELLED", currentPlan: "HK" });
    const live = row({ telegramUsername: "maxkohts", status: "ACTIVE", currentPlan: "SG" });
    const v = evaluateJoin("maxkohts", MAIN_GROUP, [dead, live], NO_WHITELIST);
    expect(v.decision).toBe("allow");
    if (v.decision === "allow") expect(v.rowsToUpdate).toEqual([live]);
  });
});

describe("isJoinTransition (ports TestJoinTransition)", () => {
  const m = (status: string, is_member = false) => ({ status, is_member });
  it("left → member is a join", () => expect(isJoinTransition(m("left"), m("member"))).toBe(true));
  it("kicked → member is a join", () => expect(isJoinTransition(m("kicked"), m("member"))).toBe(true));
  it("restricted non-member → member is a join", () =>
    expect(isJoinTransition(m("restricted", false), m("member"))).toBe(true));
  it("restricted member → member is not a join", () =>
    expect(isJoinTransition(m("restricted", true), m("member"))).toBe(false));
  it("member → administrator is not a join", () =>
    expect(isJoinTransition(m("member"), m("administrator"))).toBe(false));
  it("left → restricted member is a join", () =>
    expect(isJoinTransition(m("left"), m("restricted", true))).toBe(true));
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run lib/telegram-access.test.ts`
Expected: FAIL — module doesn't exist.

- [x] **Step 3: Implement `lib/telegram-access.ts`**

```ts
// =============================================================================
// TELEGRAM JOIN-GUARD DECISION LOGIC
// =============================================================================
// TypeScript port of the join-evaluation half of the bot repo's access.py (the
// removal half already lives in telegram-groups.ts). Pure functions, no I/O —
// the webhook endpoint feeds these and acts on the verdict.
//
// One deliberate divergence from access.py, mirroring telegram-groups.ts: an
// unrecognised plan string on a live row FAILS SAFE (allow + report) instead
// of granting nothing and kicking a paying subscriber over a typo in col F.
// =============================================================================

import { parsePlanType } from "./plans.js";
import type { Subscriber } from "./subscriber-store.js";
import {
  MAIN_MARKET,
  normaliseTelegramUsername,
  liveRowsFor,
  hasUnrecognisedLivePlan,
  isWhitelisted,
  type GroupConfig,
} from "./telegram-groups.js";

/** The slice of Telegram's ChatMember object the join guard reads. */
export interface ChatMemberLite {
  status?: string;
  is_member?: boolean;
}

const MEMBER_STATUSES = new Set(["member", "administrator", "creator"]);

export function isCurrentMember(m: ChatMemberLite | undefined | null): boolean {
  if (!m?.status) return false;
  if (MEMBER_STATUSES.has(m.status)) return true;
  // A "restricted" user may be in or out of the group — the flag decides.
  return m.status === "restricted" && m.is_member === true;
}

/** True when a chat_member update represents someone actually joining. */
export function isJoinTransition(oldM: ChatMemberLite, newM: ChatMemberLite): boolean {
  return isCurrentMember(newM) && !isCurrentMember(oldM);
}

export type JoinVerdict =
  | {
      decision: "allow";
      /** Non-CANCELLED rows to write the joiner's User ID into (col P). */
      rowsToUpdate: Subscriber[];
      reason: "entitled" | "guest" | "whitelisted";
    }
  | {
      /** Fail-safe: a live row's plan string is unrecognised, so entitlement
       *  can't be trusted. Allow, write col P, and ping Joseph to fix col F. */
      decision: "allow-unrecognised-plan";
      rowsToUpdate: Subscriber[];
    }
  | { decision: "kick"; reason: "no-username" | "not-found" | "cancelled" | "wrong-plan" };

/**
 * Decide whether a joiner may stay in `group`. Mirrors access.py
 * evaluate_join(): a user is entitled if ANY non-CANCELLED row's plan covers
 * the group's market — never judge by the first row alone. The main group is
 * lenient: guests (and no-username joiners) are welcome; only a subscriber
 * whose rows are ALL CANCELLED is barred.
 */
export function evaluateJoin(
  joinerUsername: string | undefined | null,
  group: GroupConfig,
  allSubscribers: Subscriber[],
  whitelist: Set<string>
): JoinVerdict {
  const username = normaliseTelegramUsername(joinerUsername);

  // No username: market groups kick on sight (unmatchable against the sheet);
  // the open main group treats them as welcome guests. Mirrors bot.py.
  if (!username) {
    return group.market === MAIN_MARKET
      ? { decision: "allow", rowsToUpdate: [], reason: "guest" }
      : { decision: "kick", reason: "no-username" };
  }

  if (isWhitelisted(username, whitelist)) {
    return { decision: "allow", rowsToUpdate: [], reason: "whitelisted" };
  }

  const liveRows = liveRowsFor(username, allSubscribers);
  const hasAnyRow = allSubscribers.some(
    (r) => normaliseTelegramUsername(r.telegramUsername) === username
  );

  if (group.market === MAIN_MARKET) {
    if (!hasAnyRow) return { decision: "allow", rowsToUpdate: [], reason: "guest" };
    if (liveRows.length === 0) return { decision: "kick", reason: "cancelled" };
    // Any live row entitles — a blank or drifted plan string is irrelevant here.
    return { decision: "allow", rowsToUpdate: liveRows, reason: "entitled" };
  }

  if (!hasAnyRow) return { decision: "kick", reason: "not-found" };
  if (liveRows.length === 0) return { decision: "kick", reason: "cancelled" };

  if (hasUnrecognisedLivePlan(username, allSubscribers)) {
    return { decision: "allow-unrecognised-plan", rowsToUpdate: liveRows };
  }

  const entitled = new Set<string>();
  for (const r of liveRows) {
    for (const m of parsePlanType(r.currentPlan ?? "").markets) if (m) entitled.add(m);
  }
  if (!entitled.has(group.market)) return { decision: "kick", reason: "wrong-plan" };

  return { decision: "allow", rowsToUpdate: liveRows, reason: "entitled" };
}
```

- [x] **Step 4: Run tests + typecheck**

Run: `npx vitest run lib/telegram-access.test.ts` then `npx tsc --noEmit`
Expected: all PASS.

- [x] **Step 5: Commit**

```bash
git add lib/telegram-access.ts lib/telegram-access.test.ts
git commit -m "feat: port access.py join-decision logic to lib/telegram-access.ts"
```

---

## Task 3: `lib/telegram-join.ts` — join-guard orchestration (testable, deps injected)

**Files:**
- Create: `lib/telegram-join.ts`
- Create: `lib/telegram-join.test.ts`
- Reference: `../Telegram Bot/bot.py` (behaviour being replaced)

- [x] **Step 1: Write the failing tests**

Create `lib/telegram-join.test.ts`:

```ts
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
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run lib/telegram-join.test.ts`
Expected: FAIL — module doesn't exist.

- [x] **Step 3: Implement `lib/telegram-join.ts`**

```ts
// =============================================================================
// TELEGRAM JOIN GUARD — orchestration
// =============================================================================
// Replaces bot.py's on_new_member. api/telegram-webhook.ts receives the raw
// Telegram update, builds JoinGuardDeps from env + real collaborators, and
// hands the chat_member payload here. Everything is injected so tests drive
// this with fakes.
//
// FAIL OPEN: if the sheet is unreachable, the joiner is allowed and Joseph is
// pinged — never kick a paying subscriber because Google hiccuped. The daily
// sweep corrects within a day.
// =============================================================================

import { evaluateJoin, isJoinTransition } from "./telegram-access.js";
import type { GroupConfig, KickOutcome } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

/** The slice of a Telegram ChatMemberUpdated payload the guard reads. */
export interface TelegramChatMemberEvent {
  chat: { id: number; title?: string };
  old_chat_member: { status?: string; is_member?: boolean; user?: { id: number; username?: string } };
  new_chat_member: { status?: string; is_member?: boolean; user?: { id: number; username?: string } };
}

export interface JoinGuardDeps {
  groups: GroupConfig[];
  whitelist: Set<string>;
  /** TELEGRAM_JOIN_DRY_RUN — report-only. Col-P writes are also suppressed:
   *  until cutover, bot.py owns col P. */
  dryRun: boolean;
  listAll(): Promise<Subscriber[]>;
  writeUserId(rowIndex: number, userId: string): Promise<void>;
  kick(chatId: number, userId: string): Promise<KickOutcome>;
  notify(message: string): Promise<void>;
}

/** Telegram pings are parse_mode HTML; usernames are attacker-controlled text. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Handle one chat_member update. Returns a one-line summary for the console —
 * every update produces a log line, so the dry-run soak has a complete record
 * to diff against bot.py's decisions.
 */
export async function handleChatMemberUpdate(
  ev: TelegramChatMemberEvent,
  deps: JoinGuardDeps
): Promise<string> {
  const group = deps.groups.find((g) => g.chatId === ev.chat.id);
  if (!group) return `ignored: unknown chat ${ev.chat.id}`;

  if (!isJoinTransition(ev.old_chat_member, ev.new_chat_member)) {
    return `ignored: not a join (${group.key})`;
  }

  const user = ev.new_chat_member.user;
  if (!user?.id) return `ignored: join with no user object (${group.key})`;
  const userId = String(user.id);
  const username = user.username ?? "";
  const handle = username ? `@${escapeHtml(username)}` : `(no username, ID ${userId})`;
  const tag = deps.dryRun ? "[DRY RUN] " : "";

  let all: Subscriber[];
  try {
    all = await deps.listAll();
  } catch (err) {
    const detail = escapeHtml(err instanceof Error ? err.message : String(err));
    await deps.notify(
      [
        `<b>⚠️ Join guard fail-open — sheet unreachable</b>`,
        `${handle} joined ${group.key} and was ALLOWED without a check.`,
        `<i>${detail}</i>`,
        `<i>The daily sweep will correct this if they aren't entitled.</i>`,
      ].join("\n")
    ).catch(() => {});
    return `fail-open: allowed ${handle} into ${group.key} (sheet unreachable)`;
  }

  const verdict = evaluateJoin(username, group, all, deps.whitelist);

  if (verdict.decision === "kick") {
    if (deps.dryRun) {
      await deps.notify(
        [
          `<b>🧪 DRY RUN — join guard would KICK</b>`,
          `${handle} from ${group.key} (${verdict.reason})`,
        ].join("\n")
      ).catch(() => {});
      return `${tag}would kick ${handle} from ${group.key} (${verdict.reason})`;
    }
    try {
      const out = await deps.kick(group.chatId, userId);
      if (out.outcome === "still-banned") {
        await deps.notify(
          [
            `<b>🚨 STILL BANNED — unban by hand:</b> ${group.key}`,
            `${handle} (user ID ${userId}) was kicked on join but the unban failed — they cannot rejoin even if they subscribe.`,
            `<i>${escapeHtml(out.unbanError)}</i>`,
          ].join("\n")
        ).catch(() => {});
      } else {
        await deps.notify(
          `<b>🚫 Join guard kicked</b> ${handle} from ${group.key} (${verdict.reason})`
        ).catch(() => {});
      }
      return `kicked ${handle} from ${group.key} (${verdict.reason})`;
    } catch (err) {
      const detail = escapeHtml(err instanceof Error ? err.message : String(err));
      await deps.notify(
        [
          `<b>❌ Join guard kick FAILED</b>`,
          `${handle} joined ${group.key} (${verdict.reason}) and could not be removed.`,
          `<i>${detail}</i>`,
          `<i>Remove them by hand, or the daily sweep retries at noon.</i>`,
        ].join("\n")
      ).catch(() => {});
      return `kick FAILED for ${handle} in ${group.key}: ${detail}`;
    }
  }

  // Allowed. Write the User ID to every live row so whichever subscription
  // cancels later, the sweep and instant removal can still find the ID (col P).
  let writes = 0;
  if (!deps.dryRun) {
    for (const rowToUpdate of verdict.rowsToUpdate) {
      try {
        await deps.writeUserId(rowToUpdate.rowIndex, userId);
        writes++;
      } catch (err) {
        const detail = escapeHtml(err instanceof Error ? err.message : String(err));
        await deps.notify(
          [
            `<b>⚠️ Join guard — col P write failed</b>`,
            `${handle} allowed into ${group.key}, but row ${rowToUpdate.rowIndex} did not get the User ID.`,
            `<i>${detail}</i>`,
          ].join("\n")
        ).catch(() => {});
      }
    }
  }

  if (verdict.decision === "allow-unrecognised-plan") {
    await deps.notify(
      [
        `<b>⚠️ Join guard allowed — unrecognised plan</b>`,
        `${handle} joined ${group.key}. A live row for them has a plan string we don't recognise, so entitlement can't be checked. They were ALLOWED (fail-safe).`,
        `<i>Fix col F; the daily sweep applies the same guard, so nothing will auto-remove them either.</i>`,
      ].join("\n")
    ).catch(() => {});
    return `${tag}allowed ${handle} into ${group.key} (unrecognised plan — flagged)`;
  }

  return `${tag}allowed ${handle} into ${group.key} (${verdict.reason}${writes ? `, col P → ${writes} row(s)` : ""})`;
}
```

- [x] **Step 4: Run tests + typecheck**

Run: `npx vitest run lib/telegram-join.test.ts` then `npx tsc --noEmit`
Expected: all PASS.

- [x] **Step 5: Commit**

```bash
git add lib/telegram-join.ts lib/telegram-join.test.ts
git commit -m "feat: join-guard orchestration with fail-open, dry-run and col-P writes"
```

---

## Task 4: `api/telegram-webhook.ts` — the endpoint

**Files:**
- Create: `api/telegram-webhook.ts`

No unit test for this thin edge layer (matches `api/stripe-webhook.ts` convention — the logic it delegates to is fully tested). It is exercised end-to-end in the staging rig.

- [x] **Step 1: Implement**

```ts
// =============================================================================
// TELEGRAM WEBHOOK (join guard endpoint)
// =============================================================================
// Registered with Telegram via setWebhook (see docs/runbooks/
// telegram-migration-cutover.md) with allowed_updates=["chat_member"] and a
// secret_token. Telegram POSTs every chat_member change in the five groups
// here; lib/telegram-join.ts decides and acts.
//
// ALWAYS returns 200 once the secret check passes — a non-2xx makes Telegram
// retry the update, and a replayed join could double-kick. Errors are logged
// and pinged instead.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { updateRowFields } from "../lib/sheets.js";
import { notifyAdmin } from "../lib/telegram.js";
import {
  TelegramGroupApi,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  flagIsDryRun,
} from "../lib/telegram-groups.js";
import {
  handleChatMemberUpdate,
  type JoinGuardDeps,
  type TelegramChatMemberEvent,
} from "../lib/telegram-join.js";

function buildDeps(): JoinGuardDeps | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groups = loadGroupsFromEnv();
  if (!token || groups.length === 0) {
    console.warn("telegram-webhook: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_* not set — ignoring update");
    return null;
  }
  const api = new TelegramGroupApi({
    token,
    groups,
    whitelist: loadWhitelistFromEnv(),
    dryRun: false, // join-guard dry-run is handled in deps.dryRun, not inside the API client
  });
  const store = new SheetsSubscriberStore();
  return {
    groups,
    whitelist: loadWhitelistFromEnv(),
    dryRun: flagIsDryRun("TELEGRAM_JOIN_DRY_RUN"),
    listAll: () => store.listAll(),
    writeUserId: (rowIndex, userId) => updateRowFields(rowIndex, { telegramUserId: userId }),
    kick: (chatId, userId) => api.kickFromChat(chatId, userId),
    notify: notifyAdmin,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Reject anything that didn't come from Telegram. setWebhook registers this
  // secret; Telegram echoes it on every delivery. No secret configured = the
  // endpoint is dead, deliberately.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    console.warn("telegram-webhook: bad or missing secret token header");
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const update = req.body as { update_id?: number; chat_member?: TelegramChatMemberEvent };
    if (update?.chat_member) {
      const deps = buildDeps();
      if (deps) {
        const summary = await handleChatMemberUpdate(update.chat_member, deps);
        console.log(`telegram-webhook [update ${update.update_id}]: ${summary}`);
      }
    } else {
      console.log("telegram-webhook: non-chat_member update ignored");
    }
  } catch (err) {
    // Never bubble to a non-2xx — log, and let the sweep self-heal.
    console.error("telegram-webhook error:", err);
  }
  res.status(200).json({ ok: true });
}
```

- [x] **Step 2: Typecheck + full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean, all green.

- [x] **Step 3: Commit**

```bash
git add api/telegram-webhook.ts
git commit -m "feat: Telegram join-guard webhook endpoint (secret-token auth, always-200)"
```

---

## Task 5: `lib/telegram-sweep.ts` — daily reconcile logic

**Files:**
- Create: `lib/telegram-sweep.ts`
- Create: `lib/telegram-sweep.test.ts`
- Reference: `../Telegram Bot/scheduler.py` (behaviour being replaced and extended)

The sweep is deliberately thin: for every distinct username in the sheet that has a col-P User ID, it calls the already-tested `remover.removeFromGroups(...)`, which handles whitelist, entitlement union, unrecognised-plan fail-safe, membership checks, identity mismatch, and kicks. What `scheduler.py` did for CANCELLED rows only, this does for everyone — plan-drift heals too.

- [x] **Step 1: Write the failing tests**

Create `lib/telegram-sweep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runTelegramSweep, type SweepDeps } from "./telegram-sweep.js";
import type { RemovalInput, RemovalResult, TelegramGroupRemover } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

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
    const { deps } = makeDeps([a, b, c], remover);
    const summary = await runTelegramSweep(deps);
    expect(calls.map((i) => [i.telegramUsername.toLowerCase(), i.telegramUserId])).toEqual([
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
      now: () => { clock += 60; return clock; }, // 3rd check exceeds 100ms
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
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run lib/telegram-sweep.test.ts`
Expected: FAIL — module doesn't exist.

- [x] **Step 3: Implement `lib/telegram-sweep.ts`**

```ts
// =============================================================================
// TELEGRAM DAILY SWEEP
// =============================================================================
// Replaces scheduler.py, extended: instead of only CANCELLED rows, every
// distinct username with a col-P User ID has their group memberships checked
// against the union of their live rows' entitlements — so plan-change drift,
// missed webhook events and hand-edits self-heal daily, exactly like the 3am
// TradingView reconcile. Guests with no sheet row are untouchable by
// construction (the remover only acts on the person it is handed).
//
// All safety machinery (whitelist, unrecognised-plan fail-safe, identity
// mismatch, ban+unban) lives in the remover — this file only enumerates and
// aggregates.
// =============================================================================

import { normaliseTelegramUsername, type TelegramGroupRemover } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

export interface SweepDeps {
  listAll(): Promise<Subscriber[]>;
  /** A TelegramGroupApi built with the TELEGRAM_SWEEP_DRY_RUN flag. */
  remover: TelegramGroupRemover;
  notify(message: string): Promise<void>;
  recordLog(entry: {
    email: string;
    stripeSubscriptionId: string;
    action: string;
    plan?: string;
    detail?: string;
  }): Promise<void>;
  /** Stop starting new users once this much time has passed. Vercel functions
   *  have a hard max duration; a partial sweep today finishes tomorrow. */
  timeBudgetMs?: number;
  now?: () => number;
}

export interface SweepSummary {
  usersChecked: number;
  removed: Array<{ username: string; groups: string[] }>;
  unrecognised: string[];
  mismatches: string[];
  failures: string[];
  stillBanned: string[];
  partial: boolean;
  dryRun: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runTelegramSweep(deps: SweepDeps): Promise<SweepSummary> {
  const now = deps.now ?? Date.now;
  const budget = deps.timeBudgetMs ?? 240_000;
  const started = now();

  const all = await deps.listAll();

  // Distinct usernames; for each, the first row carrying a col-P User ID.
  // No ID anywhere → the person never joined through the guard → nothing to
  // kick (mirrors scheduler.py skipping blank col P).
  const candidates = new Map<string, Subscriber>();
  for (const r of all) {
    const u = normaliseTelegramUsername(r.telegramUsername);
    if (!u || candidates.has(u)) continue;
    const withId = all.find(
      (x) =>
        normaliseTelegramUsername(x.telegramUsername) === u &&
        x.telegramUserId?.trim() !== ""
    );
    if (withId) candidates.set(u, withId);
  }

  const summary: SweepSummary = {
    usersChecked: 0,
    removed: [],
    unrecognised: [],
    mismatches: [],
    failures: [],
    stillBanned: [],
    partial: false,
    dryRun: false,
  };

  for (const [username, subject] of candidates) {
    if (now() - started > budget) {
      summary.partial = true;
      break;
    }
    summary.usersChecked++;

    try {
      const result = await deps.remover.removeFromGroups({
        telegramUserId: subject.telegramUserId.trim(),
        telegramUsername: subject.telegramUsername,
        allSubscribers: all,
      });
      summary.dryRun = result.dryRun;

      if (result.reason === "unrecognised-plan") summary.unrecognised.push(username);
      if (result.removed.length) summary.removed.push({ username, groups: result.removed });
      summary.failures.push(...result.failures.map((f) => `${username} — ${f}`));
      summary.mismatches.push(
        ...(result.identityMismatches ?? []).map((m) => `${username} — ${m}`)
      );
      summary.stillBanned.push(
        ...(result.outstandingBans ?? []).map((g) => `${username} — ${g}`)
      );

      // Durable record for anything that changed (or would have, in dry-run).
      if (result.removed.length || result.failures.length || result.identityMismatches?.length) {
        const detail =
          `${result.dryRun ? "dry run — " : ""}sweep — removed: [${result.removed.join(", ")}]` +
          (result.failures.length ? ` failures: [${result.failures.join(" | ")}]` : "") +
          (result.identityMismatches?.length
            ? ` mismatches: [${result.identityMismatches.join(" | ")}]`
            : "");
        await deps
          .recordLog({
            email: subject.email,
            stripeSubscriptionId: subject.stripeSubscriptionId,
            action: "TELEGRAM_REMOVED",
            plan: subject.currentPlan,
            detail,
          })
          .catch(() => {});
      }
    } catch (err) {
      summary.failures.push(
        `${username} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const somethingToSay =
    summary.removed.length ||
    summary.unrecognised.length ||
    summary.mismatches.length ||
    summary.failures.length ||
    summary.stillBanned.length ||
    summary.partial;

  if (somethingToSay) {
    const lines = [
      summary.dryRun
        ? `<b>🧪 DRY RUN — Telegram sweep</b>`
        : `<b>🧹 Telegram sweep</b>`,
      `Checked ${summary.usersChecked} member(s)${summary.partial ? " — <b>partial run</b> (time budget hit; continues tomorrow)" : ""}`,
    ];
    if (summary.removed.length) {
      const verb = summary.dryRun ? "Would remove" : "Removed";
      lines.push(
        `<b>${verb}:</b>`,
        ...summary.removed.map(
          (r) => `• @${escapeHtml(r.username)} — ${r.groups.join(", ")}`
        )
      );
    }
    if (summary.unrecognised.length)
      lines.push(
        `<b>⚠️ Unrecognised plan (nothing removed — fix col F):</b> ${summary.unrecognised
          .map((u) => `@${escapeHtml(u)}`)
          .join(", ")}`
      );
    if (summary.mismatches.length)
      lines.push(`<b>⚠️ Identity mismatches (skipped):</b> ${escapeHtml(summary.mismatches.join(" | "))}`);
    if (summary.failures.length)
      lines.push(`<b>❌ Failures:</b> ${escapeHtml(summary.failures.join(" | "))}`);
    if (summary.stillBanned.length)
      lines.push(`<b>🚨 STILL BANNED — unban by hand:</b> ${escapeHtml(summary.stillBanned.join(", "))}`);
    await deps.notify(lines.join("\n")).catch(() => {});
  }

  return summary;
}
```

- [x] **Step 4: Run tests + typecheck**

Run: `npx vitest run lib/telegram-sweep.test.ts` then `npx tsc --noEmit`
Expected: all PASS.

- [x] **Step 5: Commit**

```bash
git add lib/telegram-sweep.ts lib/telegram-sweep.test.ts
git commit -m "feat: daily Telegram sweep — entitlement reconcile for every known member"
```

---

## Task 6: `api/telegram-sweep.ts` cron endpoint + `vercel.json` entry

**Files:**
- Create: `api/telegram-sweep.ts`
- Modify: `vercel.json` (crons array)

- [x] **Step 1: Implement the endpoint** (mirrors `api/tradingview-reconcile.ts` conventions)

```ts
// =============================================================================
// TELEGRAM SWEEP (Vercel Cron)
// =============================================================================
// Daily safety net replacing scheduler.py — see lib/telegram-sweep.ts.
// Trigger: vercel.json cron, 0 4 * * * UTC = 12:00 PM SGT (Hobby crons can
// fire up to ~1h late; fine for a backstop). Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`.
// Dry-run: TELEGRAM_SWEEP_DRY_RUN (fail-safe — only the literal "false" kicks).
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { SheetsEventLog } from "../lib/event-log.js";
import { notifyAdmin } from "../lib/telegram.js";
import {
  TelegramGroupApi,
  loadGroupsFromEnv,
  loadWhitelistFromEnv,
  flagIsDryRun,
} from "../lib/telegram-groups.js";
import { runTelegramSweep } from "../lib/telegram-sweep.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groups = loadGroupsFromEnv();
  if (!token || groups.length === 0) {
    await notifyAdmin(
      "<b>⚠️ Telegram sweep skipped</b>\nTELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_* not set."
    ).catch(() => {});
    res.status(200).json({ skipped: "not configured" });
    return;
  }

  try {
    const store = new SheetsSubscriberStore();
    const eventLog = new SheetsEventLog();
    const remover = new TelegramGroupApi({
      token,
      groups,
      whitelist: loadWhitelistFromEnv(),
      dryRun: flagIsDryRun("TELEGRAM_SWEEP_DRY_RUN"),
    });

    const summary = await runTelegramSweep({
      listAll: () => store.listAll(),
      remover,
      notify: notifyAdmin,
      recordLog: (e) => eventLog.record({ ...e, stripeSubscriptionId: e.stripeSubscriptionId ?? "" }),
    });

    res.status(200).json(summary);
  } catch (err) {
    console.error("telegram-sweep failed:", err);
    await notifyAdmin(
      `<b>❌ Telegram sweep FAILED</b>\n${err instanceof Error ? err.message : String(err)}`
    ).catch(() => {});
    res.status(500).json({ error: "sweep failed" });
  }
}
```

- [x] **Step 2: Add the cron to `vercel.json`**

In the `crons` array, add:

```json
{ "path": "/api/telegram-sweep", "schedule": "0 4 * * *" }
```

**Check the cron quota first:** the project already has 3 daily crons. Look at the Vercel dashboard (or `npx vercel project ls` / project settings) to confirm a 4th daily cron is allowed on the current plan. If it is not, do NOT add the entry — instead call `runTelegramSweep` at the end of `api/tradingview-reconcile.ts`'s handler (after the reconcile summary, same pattern of building deps) and note the fold-in in the runbook. Flag whichever path was taken in the task report.

- [x] **Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add api/telegram-sweep.ts vercel.json
git commit -m "feat: daily Telegram sweep cron endpoint (12:00 SGT, CRON_SECRET auth)"
```

---

## Task 7: Instant plan-change kicks in the lifecycle

**Files:**
- Modify: `lib/subscription-lifecycle.ts`
- Test: `lib/subscription-lifecycle.test.ts` (extend existing file)

`applyTelegramRemoval` currently excludes the subscriber's own row (correct for ENDED — the row may still read ACTIVE on a stale read). For a plan change the row must be **included with its NEW plan**, deterministically — a stale read showing the OLD plan would re-grant the very markets being removed and turn the kick into a silent no-op. So: instead of excluding, overwrite the subject row's plan in memory.

- [x] **Step 1: Write the failing tests**

In `lib/subscription-lifecycle.test.ts`, find how existing tests construct the lifecycle with a fake `TelegramGroupRemover` (the ENDED removal tests do this — follow their fake/recording pattern exactly). Add:

```ts
describe("plan-change Telegram removal", () => {
  // Follow the file's existing helpers for building a lifecycle + fake store.
  // The recording fake remover must capture removeFromGroups inputs.

  it("PLAN_CHANGED (upgrade/switch) calls the remover with the subject row carrying the NEW plan", async () => {
    // Arrange: subscriber on US_HK in the fake store, with telegramUserId "77".
    // Act: apply a PLAN_CHANGED action to US_SG_FXMC (a PLAN_SWITCH — same price).
    // Assert:
    //   - fake remover was called exactly once
    //   - input.telegramUserId === "77"
    //   - the row in input.allSubscribers matching this subscriber has
    //     currentPlan === "US_SG_FXMC" (the NEW plan), regardless of what the
    //     fake store returns from listAll (set the store to return the STALE
    //     old plan to prove the override).
  });

  it("PLAN_CHANGED downgrade-executed path also kicks", async () => {
    // Arrange: subscriber on ALL_MARKETS; PLAN_CHANGED action to HK classified
    // DOWNGRADED (lower price). Assert remover called once with the subject
    // row's plan overridden to HK.
  });

  it("PLAN_CHANGED same-plan price sync does NOT kick", async () => {
    // Arrange: same plan, different price. Assert remover never called.
  });

  it("RENEWED applying a period-boundary plan change kicks once; the marker-confirm path does not double-kick", async () => {
    // Case A (invoice-first): sheet plan ALL_MARKETS, RENEWED action with
    // planType HK → remover called once (plan override HK).
    // Case B (items-first): sheet already HK with latestAction
    // DOWNGRADE_EXECUTED, RENEWED action planType HK → remover NOT called
    // (handlePlanChanged already kicked when the items event was processed).
  });
});
```

Write these as real tests using the file's existing fakes — the comments above are the assertions to encode, not placeholders to leave. Every existing ENDED-removal test must keep passing untouched.

- [x] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run lib/subscription-lifecycle.test.ts`
Expected: new tests FAIL (remover not called / no plan override).

- [x] **Step 3: Implement**

(a) In `applyTelegramRemoval`, add an options parameter and branch the row preparation:

```ts
private async applyTelegramRemoval(
  subscriber: Subscriber,
  opts?: { newPlanOverride?: string }
): Promise<void> {
```

Replace the `const others = all.filter(...)` line with:

```ts
// ENDED: drop the subscriber's OWN row before computing entitlements — on a
// stale read it still says ACTIVE and would re-grant exactly the markets
// being removed. PLAN CHANGE: keep the row but force its plan to the NEW
// value for the same reason in mirror image — a stale read showing the OLD
// plan would also re-grant what's being removed. Both make the outcome
// independent of Sheets read-after-write timing.
const others =
  opts?.newPlanOverride !== undefined
    ? all.map((row) =>
        isSameSubscriberRow(row, subscriber)
          ? { ...row, currentPlan: opts.newPlanOverride as string }
          : row
      )
    : all.filter((row) => !isSameSubscriberRow(row, subscriber));
```

(b) Add the plan-change wrapper next to `telegramRemove`:

```ts
// Plan-change counterpart to telegramRemove: the subscription is still live,
// so the subject row is kept (with its plan forced to the new value) and the
// removal targets only the groups the NEW plan doesn't cover. Rides the same
// TELEGRAM_KICK_DRY_RUN flag and produces the same log/ping trail.
private telegramRemoveAfterPlanChange(
  subscriber: Subscriber,
  newPlanType: string
): Promise<unknown>[] {
  if (this.telegramGroups.configured === false) return [];
  return [this.applyTelegramRemoval(subscriber, { newPlanOverride: newPlanType })];
}
```

(c) Wire the three call sites:

1. `handlePlanChanged`, upgrade/switch path — in the `runSideEffects("PLAN_CHANGED", [...])` array, directly after the `...this.tvGrant(...)` line, add:

```ts
...this.telegramRemoveAfterPlanChange(existing, action.newPlanType),
```

2. `handlePlanChanged`, downgrade-executed path — in the `runSideEffects("PLAN_CHANGED (downgrade executed)", [...])` array, directly after the `...this.tvGrant(...)` line, add the same line:

```ts
...this.telegramRemoveAfterPlanChange(existing, action.newPlanType),
```

3. `handleRenewed`, plan-change-confirmed branch — in the `runSideEffects("RENEWED (plan change confirmed)", [...])` array, directly after the `...this.tvGrant(...)` line, add (note the guard — when the items event was processed first, `handlePlanChanged` already kicked; kicking again would double-log and double-ping):

```ts
...(planChangedAtBoundary
  ? this.telegramRemoveAfterPlanChange(existing, newPlan)
  : []),
```

Do NOT touch the same-plan price-sync path, `DOWNGRADE_SCHEDULED`, or `CANCELLATION_SCHEDULED` — no access changes there.

- [x] **Step 4: Run the FULL suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all green, including every pre-existing lifecycle test.

- [x] **Step 5: Commit**

```bash
git add lib/subscription-lifecycle.ts lib/subscription-lifecycle.test.ts
git commit -m "feat: instant Telegram group removal on plan changes (closes the downgrade gap)"
```

---

## Task 8: Documentation — env vars + CLAUDE.md

**Files:**
- Modify: `README-webhook.md` (env var list)
- Modify: `CLAUDE.md`

- [x] **Step 1: Add the new env vars to `README-webhook.md`'s env table**, matching its existing format:

| Var | Meaning |
| :-- | :-- |
| `TELEGRAM_WEBHOOK_SECRET` | Secret registered with Telegram `setWebhook`; the join-guard endpoint 403s any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match. Endpoint is dead if unset. |
| `TELEGRAM_JOIN_DRY_RUN` | Join guard report-only mode. Fail-safe: only the literal `false` enforces (kicks + col-P writes). |
| `TELEGRAM_SWEEP_DRY_RUN` | Daily sweep report-only mode. Same fail-safe semantics. |

Also note: `/api/telegram-sweep` uses the existing `CRON_SECRET`.

- [x] **Step 2: Update `CLAUDE.md`**: in the "Telegram group removal" section, add a short paragraph describing the join guard (`api/telegram-webhook.ts` + `lib/telegram-join.ts`/`telegram-access.ts`), the daily sweep (`api/telegram-sweep.ts` + `lib/telegram-sweep.ts`, replaces scheduler.py, extended to plan-drift healing), and the plan-change instant kicks. State that scheduler.py/bot.py references elsewhere in the file describe the PRE-migration world and are removed at retirement. Do NOT delete the "Config duplicated from the bot repo" section yet — that happens in Task 12 when the bots are actually retired.

- [x] **Step 3: Commit**

```bash
git add README-webhook.md CLAUDE.md
git commit -m "docs: env vars + architecture notes for the Telegram bot migration"
```

---

## Task 9: Cutover runbook

**Files:**
- Create: `docs/runbooks/telegram-migration-cutover.md`

- [x] **Step 1: Write the runbook.** It must contain, in order, with exact commands (fill the placeholders at execution time — they are secrets and live values, not plan content):

**A. Staging rig setup (one-time, with Joseph):**
1. BotFather: create test bot (e.g. `@RhoNavStagingBot`), save token.
2. Create 2 private test groups; add the test bot as admin (with ban rights) to both.
3. Get each group's chat ID: add the bot, then `curl -s "https://api.telegram.org/bot<TEST_TOKEN>/getUpdates"` after posting a message, or forward a message to `@userinfobot`.
4. Copy the live sheet (File → Make a copy), share with `telegram-bot-service@telegram-bot-manager-474609.iam.gserviceaccount.com` as Editor.
5. Create a second Vercel project (e.g. `navigator-telegram-staging`) from the same GitHub repo. Env vars: `TELEGRAM_BOT_TOKEN`=test token, `TELEGRAM_CHAT_US`=test group 1 ID, `TELEGRAM_CHAT_MAIN`=test group 2 ID (leave HK/SG/FXMC unset — `loadGroupsFromEnv` drops them), `TELEGRAM_WEBHOOK_SECRET`=fresh random string (`openssl rand -hex 32`), `TELEGRAM_JOIN_DRY_RUN`=`false`, `TELEGRAM_SWEEP_DRY_RUN`=`false`, `TELEGRAM_KICK_DRY_RUN`=`false`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID`=the COPY's ID, `TELEGRAM_KICK_WHITELIST`, `ADMIN_CHAT_ID`, `CRON_SECRET`. Deliberately absent: `STRIPE_*`, `RESEND_*`, `TRADINGVIEW_*` — staging must not email or touch TradingView.
6. Register the staging webhook:
```bash
curl -s "https://api.telegram.org/bot<TEST_TOKEN>/setWebhook" \
  --data-urlencode "url=https://<staging-domain>/api/telegram-webhook" \
  --data-urlencode "secret_token=<STAGING_WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["chat_member"]'
curl -s "https://api.telegram.org/bot<TEST_TOKEN>/getWebhookInfo"
```
Verify `getWebhookInfo` shows the URL and `allowed_updates: ["chat_member"]`.

**B. Staging E2E matrix** (execute with real Telegram accounts; add rows to the sheet copy by hand to stage each case; verify after each: kick happened or not, col P written or not, pings received):
- entitled join to market group → allowed, col P written to all live rows
- wrong-plan join to market group → kicked + ping
- unknown user joins market group → kicked + ping
- all-rows-CANCELLED user joins market group → kicked + ping
- no-username account joins market group → kicked; joins main group → allowed
- guest (no row) joins main group → allowed, no writes
- whitelisted user joins → allowed, no sheet lookup side effects
- unrecognised-plan row (put `BANANA` in col F) joins → allowed + warning ping
- sweep (`curl -H "Authorization: Bearer <CRON_SECRET>" https://<staging-domain>/api/telegram-sweep`): CANCELLED row with col-P ID → kicked from both groups; ACTIVE row whose plan lost a market (edit col F by hand) → kicked from that market group only; comp-style row (blank col O, future col L) → kept
- plan-change instant kick: needs Stripe test mode wired, which staging deliberately lacks — covered instead by the lifecycle unit tests (Task 7) and the prod dry-run soak (phase C); do not wire Stripe into staging for this.

**C. Prod shadow soak (~1 week):**
1. Add the test bot as admin to the 5 REAL groups (it must be admin to receive chat_member updates; dry-run means it never acts).
2. Repoint the staging project env: `TELEGRAM_CHAT_*`=the 5 real group IDs, `GOOGLE_SHEET_ID`=live sheet, `TELEGRAM_JOIN_DRY_RUN`=`true`, `TELEGRAM_SWEEP_DRY_RUN`=`true`. Redeploy staging; re-run the `setWebhook` call (same test token).
3. Prod project (this repo's main Vercel project): deploy everything (Joseph runs `/push-website`); set `TELEGRAM_SWEEP_DRY_RUN` unset (= dry-run by default) so the noon cron logs intentions. `TELEGRAM_JOIN_DRY_RUN` is irrelevant on prod until cutover (no webhook registered on the prod token yet). Confirm existing `TELEGRAM_KICK_DRY_RUN` state with Joseph — if ENDED kicks are already live, leave live.
4. Daily during the soak: compare (a) staging's join-guard pings/logs vs what bot.py actually did (VPS console/log), (b) prod sweep dry-run ping vs scheduler.py's noon actions, (c) any plan-change dry-run pings vs reality. Expected legitimate difference: the sweep flags plan-drift cases scheduler.py ignores — verify each by hand.
5. Exit criteria: one full week, zero unexplained divergence.

**D. Cutover (after soak passes):**
1. Prod Vercel env: `TELEGRAM_JOIN_DRY_RUN`=`false`, `TELEGRAM_SWEEP_DRY_RUN`=`false`, `TELEGRAM_KICK_DRY_RUN`=`false`, `TELEGRAM_WEBHOOK_SECRET`=fresh random string. Redeploy.
2. Register the PROD webhook (this instantly breaks bot.py's polling — that is the design; enforcement transfers atomically):
```bash
curl -s "https://api.telegram.org/bot<PROD_TOKEN>/setWebhook" \
  --data-urlencode "url=https://rho-market-navigator.vercel.app/api/telegram-webhook" \
  --data-urlencode "secret_token=<PROD_WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["chat_member"]'
curl -s "https://api.telegram.org/bot<PROD_TOKEN>/getWebhookInfo"
```
3. On the VPS (Elaine's ForexVPS — see `About Me/vps-accounts.md`): stop `bot.py` and `scheduler.py`, disable their auto-start (check Task Scheduler / startup scripts).
4. Test: join a real group with a test account → verify the webhook log line + expected verdict.
5. Remove the shadow test bot from the 5 real groups. Keep the staging project dormant or delete it.

**E. Rollback (any time, <5 min):**
```bash
curl -s "https://api.telegram.org/bot<PROD_TOKEN>/deleteWebhook"
```
Then restart `bot.py` + `scheduler.py` on the VPS and set the three dry-run flags back to unset. Polling resumes; everything is as before.

- [x] **Step 2: Commit**

```bash
git add docs/runbooks/telegram-migration-cutover.md
git commit -m "docs: staging, shadow-soak and cutover runbook for the bot migration"
```

---

## Task 10 (MANUAL, with Joseph): Execute staging rig + E2E matrix

- [x] Joseph creates the test bot, test groups, sheet copy, staging Vercel project (runbook section A).
- [x] **Deploy checkpoint:** Joseph runs `/push-website` to get Tasks 1–9 into prod code (all dormant: no webhook registered on the prod token; sweep cron ships in dry-run; ENDED kick behaviour unchanged).
- [x] Walk the full E2E matrix (runbook section B); record each case's result in the runbook as a checked list. Fix any failure and re-run the matrix before proceeding.

## Task 11 (MANUAL, ~1 week): Prod shadow soak

- [ ] Configure the shadow (runbook section C). Daily diff of shadow verdicts vs bot.py, sweep dry-run vs scheduler.py.
- [ ] Log every divergence in the runbook with its explanation. Unexplained divergence → fix → restart the week.

## Task 12 (MANUAL, gated on Joseph's go): Cutover + retirement

- [ ] Execute runbook section D. Watch pings closely for the first 48h.
- [ ] After 2–4 clean weeks: stop the VPS processes permanently; archive the `Navigator_Telegram_Bot` repo on GitHub (Settings → Archive) after adding a README pointer to this repo; delete CLAUDE.md's "Config duplicated from the bot repo" section and the scheduler.py/bot.py fallback references; update `../CLAUDE.md` (workstation Projects table) and `../MEMORY.md`; update `About Me/vps-accounts.md` (bots no longer run there).

---

## Self-review notes (already applied)

- Spec coverage: components 1–5 → Tasks 2–7; testing layers → Tasks 2/3/5/7 (unit), 9B/10 (staging), 9C/11 (soak); cutover/rollback → 9D/E, 12; cron-quota risk → Task 6 Step 2 fallback; comp-expiry interplay → staging sweep case in 9B.
- Naming consistency: `flagIsDryRun`, `kickFromChat`/`KickOutcome`, `evaluateJoin`/`JoinVerdict`, `handleChatMemberUpdate`/`JoinGuardDeps`/`TelegramChatMemberEvent`, `runTelegramSweep`/`SweepDeps`/`SweepSummary`, `telegramRemoveAfterPlanChange` — used identically across tasks.
- Task 7 Step 1 test bodies are specified as assertions to encode with the file's existing fakes (the fakes' constructor shapes live in that file and must be followed, not invented here).
