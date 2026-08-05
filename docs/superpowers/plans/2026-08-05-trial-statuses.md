# Trial-Specific Subscriber Statuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trial subscribers get their own sheet statuses (`TRIAL_ACTIVE` / `TRIAL_CANCELLATION_SCHEDULED` / `TRIAL_CANCELLED`) and a `START_TRIAL` Latest Action, with identical access behaviour to today.

**Architecture:** The Stripe translator already knows when a subscription is trialing; two actions gain an `isTrial` flag and the lifecycle picks trial-prefixed status strings at each write-site. Every status reader (website Telegram kick, TradingView reconcile, follow-up cron, and the separate Python bot repo) is taught the new strings FIRST, so deploy order is readers → writer → backfill.

**Tech Stack:** TypeScript (Vercel serverless, vitest), Python (bot repo, unittest), Google Sheets API, Stripe API.

**Spec:** `docs/superpowers/specs/2026-08-05-trial-statuses-design.md`

**Two repos are touched:**
- Website repo: `C:\Users\josep\Documents\Claude Playground\Navigator Business\Website` (git repo `josephhocw/Navigator-Subscription`, branch `main`, auto-deploys on push — commit locally, DO NOT push until Joseph says deploy)
- Bot repo: `C:\Users\josep\Documents\Claude Playground\Navigator Business\Telegram Bot` (git repo `josephhocw/Navigator_Telegram_Bot`, branch `main`; runs on a VPS — deploy is manual pull + restart, out of scope)

Run website commands from the Website repo root. `npm test` = vitest, `npm run typecheck` = tsc --noEmit. Bot tests: `python -m unittest test_access` from the bot repo root.

---

### Task 1: Bot repo — bar TRIAL_CANCELLED (reader, deploy-first)

**Files:**
- Modify: `Telegram Bot/access.py` (BARRED_STATUS at line 19, comparisons at lines 81, 89, 117; any other `BARRED_STATUS` use — grep for it)
- Modify: `Telegram Bot/scheduler.py` (literal `'CANCELLED'` filter at line 49)
- Test: `Telegram Bot/test_access.py`

- [ ] **Step 1: Write failing tests** — add to `test_access.py` (follow the existing `make_row` style):

```python
class TestTrialStatuses(unittest.TestCase):
    """TRIAL_ACTIVE / TRIAL_CANCELLATION_SCHEDULED are entitled; TRIAL_CANCELLED is barred."""

    def test_trial_active_is_entitled(self):
        rows = find_user_rows([HEADER, make_row('joe', 'TRIAL_ACTIVE', 'ALL_MARKETS')], 'joe')
        decision, _ = evaluate_join(rows, 'US')
        self.assertEqual(decision, 'allow')

    def test_trial_cancellation_scheduled_is_entitled(self):
        rows = find_user_rows([HEADER, make_row('joe', 'TRIAL_CANCELLATION_SCHEDULED', 'ALL_MARKETS')], 'joe')
        decision, _ = evaluate_join(rows, 'US')
        self.assertEqual(decision, 'allow')

    def test_trial_cancelled_is_barred(self):
        rows = find_user_rows([HEADER, make_row('joe', 'TRIAL_CANCELLED', 'ALL_MARKETS')], 'joe')
        decision, _ = evaluate_join(rows, 'US')
        self.assertEqual(decision, 'cancelled')

    def test_trial_cancelled_barred_from_main_group(self):
        rows = find_user_rows([HEADER, make_row('joe', 'TRIAL_CANCELLED', 'ALL_MARKETS')], 'joe')
        decision, _ = evaluate_join(rows, MAIN_MARKET)
        self.assertEqual(decision, 'cancelled')

    def test_trial_cancelled_row_does_not_strip_other_active_row(self):
        all_rows = [HEADER,
                    make_row('joe', 'TRIAL_CANCELLED', 'US'),
                    make_row('joe', 'ACTIVE', 'HK')]
        entitled = entitlements_by_username(all_rows)
        self.assertIn('HK', entitled['joe'])
        self.assertNotIn('US', entitled['joe'])
```

(Import `MAIN_MARKET` from `config` at the top of the test file if not already imported; check existing imports first.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd "C:\Users\josep\Documents\Claude Playground\Navigator Business\Telegram Bot" && python -m unittest test_access -v 2>&1 | tail -15`
Expected: the new tests FAIL (TRIAL_CANCELLED rows treated as entitled).

- [ ] **Step 3: Implement** — in `access.py`, replace the single-string constant with a set:

```python
# Barred statuses lose access — ACTIVE, CANCELLATION_SCHEDULED, PAYMENT_FAILED,
# TRIAL_ACTIVE and TRIAL_CANCELLATION_SCHEDULED are all still entitled.
# TRIAL_CANCELLED = a free trial that ended without converting (website writes
# it from 2026-08 on); it bars exactly like CANCELLED.
BARRED_STATUSES = {'CANCELLED', 'TRIAL_CANCELLED'}
```

Replace every `!= BARRED_STATUS` with `not in BARRED_STATUSES` (lines 81, 89, 117 and any other hits — grep `BARRED_STATUS` across the repo, including `test_user.py` line 62's `!= 'CANCELLED'`). In `scheduler.py` line 49, import the set and use membership:

```python
from access import BARRED_STATUSES
...
        if cell(row, COL_STATUS) not in BARRED_STATUSES:
            continue
```

(Check `scheduler.py`'s existing imports from `access` and extend them rather than adding a duplicate import line.) In `test_user.py`, replace `if status != 'CANCELLED':` with `if status not in BARRED_STATUSES:` (import it).

- [ ] **Step 4: Run tests**

Run: `python -m unittest test_access -v 2>&1 | tail -5`
Expected: OK, all tests pass.

- [ ] **Step 5: Commit (bot repo)**

```bash
git add access.py scheduler.py test_access.py test_user.py
git commit -m "feat: bar TRIAL_CANCELLED like CANCELLED (trial-status rollout, readers first)"
```

---

### Task 2: Website readers — telegram-groups, tradingview-reconcile, followup

**Files:**
- Modify: `lib/telegram-groups.ts:30`
- Modify: `lib/tradingview-reconcile.ts:50-54`
- Modify: `lib/followup.ts:90`
- Test: `lib/telegram-groups.test.ts`, `lib/tradingview-reconcile.test.ts`, `lib/followup.test.ts`

- [ ] **Step 1: Write failing tests.** In each test file, find the existing row/subscriber factory helper and add cases (mirror the closest existing test's shape):
  - `telegram-groups.test.ts`: a `TRIAL_CANCELLED` row grants nothing (barred like CANCELLED); a `TRIAL_ACTIVE` row keeps its markets + MAIN.
  - `tradingview-reconcile.test.ts`: `TRIAL_ACTIVE` and `TRIAL_CANCELLATION_SCHEDULED` rows are entitled to their plan's script; `TRIAL_CANCELLED` is not.
  - `followup.test.ts`: a `TRIAL_ACTIVE` row inside the 1–14-day window is selected; a `TRIAL_CANCELLED` row is not.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- telegram-groups tradingview-reconcile followup 2>&1 | tail -15`
Expected: new cases FAIL.

- [ ] **Step 3: Implement.**

`lib/telegram-groups.ts` — replace lines 28-30:

```typescript
/** Statuses that lose access. ACTIVE, CANCELLATION_SCHEDULED, PAYMENT_FAILED,
 *  TRIAL_ACTIVE and TRIAL_CANCELLATION_SCHEDULED are all still entitled —
 *  mirrors access.py BARRED_STATUSES in the bot repo. */
const BARRED_STATUSES = new Set(["CANCELLED", "TRIAL_CANCELLED"]);
```

and change its comparison site(s) (grep `BARRED_STATUS` in the file) from `=== BARRED_STATUS` / `!== BARRED_STATUS` to `BARRED_STATUSES.has(...)` / `!BARRED_STATUSES.has(...)`.

`lib/tradingview-reconcile.ts` — extend the set (lines 50-54) and the comment above it:

```typescript
// A subscriber is entitled to access until they're fully cancelled — the same
// rule the Telegram bot uses. Trial statuses mirror their paid counterparts:
// TRIAL_ACTIVE / TRIAL_CANCELLATION_SCHEDULED keep access, TRIAL_CANCELLED
// (like CANCELLED) loses it.
const ENTITLED_STATUSES = new Set([
  "ACTIVE",
  "PAYMENT_FAILED",
  "CANCELLATION_SCHEDULED",
  "TRIAL_ACTIVE",
  "TRIAL_CANCELLATION_SCHEDULED",
]);
```

`lib/followup.ts` line 90 — trialists keep getting the day-3 follow-up (Joseph's decision 2026-08-05):

```typescript
    if (r.status !== "ACTIVE" && r.status !== "TRIAL_ACTIVE") return false;
```

- [ ] **Step 4: Run tests**

Run: `npm test -- telegram-groups tradingview-reconcile followup 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram-groups.ts lib/tradingview-reconcile.ts lib/followup.ts lib/telegram-groups.test.ts lib/tradingview-reconcile.test.ts lib/followup.test.ts
git commit -m "feat: readers accept trial statuses (TRIAL_ACTIVE/TRIAL_CANCELLATION_SCHEDULED entitled, TRIAL_CANCELLED barred)"
```

---

### Task 3: Store + sheets plumbing — types, append params, colours

**Files:**
- Modify: `lib/subscriber-store.ts` (SubscriberPatch.status union at line 84; `NewSubscriberData` interface ~line 50-65; the reset-colour branch at line 185)
- Modify: `lib/sheets.ts` (comment block lines 30-34; `NewSubscriberRow` type; hardcoded `"ACTIVE"`/`"NEW_SUBSCRIPTION"` at lines 381/383; `STATUS_COLORS` at line 142)
- Test: `lib/sheets.test.ts` (only if it covers appendNewSubscriber's row shape — check; otherwise typecheck is the safety net)

- [ ] **Step 1: Extend the status union** in `lib/subscriber-store.ts` line 84:

```typescript
  status?:
    | "ACTIVE"
    | "PAYMENT_FAILED"
    | "CANCELLATION_SCHEDULED"
    | "CANCELLED"
    | "TRIAL_ACTIVE"
    | "TRIAL_CANCELLATION_SCHEDULED"
    | "TRIAL_CANCELLED";
```

- [ ] **Step 2: Let appends carry status + latestAction.** In the `NewSubscriberData` interface (subscriber-store.ts) add:

```typescript
  /** Status (col E) to write; defaults to "ACTIVE". Trials pass "TRIAL_ACTIVE". */
  status?: "ACTIVE" | "TRIAL_ACTIVE";
  /** Latest Action (col G); defaults to "NEW_SUBSCRIPTION". Trials pass "START_TRIAL". */
  latestAction?: "NEW_SUBSCRIPTION" | "START_TRIAL";
```

Thread them through `SheetsSubscriberStore.appendNew` into `appendNewSubscriber` (check how `NewSubscriberData` maps to sheets.ts's `NewSubscriberRow` — add the same optional fields there). In `lib/sheets.ts` lines 381/383 replace the hardcoded literals:

```typescript
              data.status ?? "ACTIVE",                       // E — Status
              data.currentPlan,                              // F — Current Plan
              data.latestAction ?? "NEW_SUBSCRIPTION",       // G — Latest Action
```

- [ ] **Step 3: Colours + guard.** `lib/sheets.ts` line 142:

```typescript
const STATUS_COLORS: Record<string, Rgb> = {
  CANCELLED: hexToRgb("F4CCCC"),
  TRIAL_CANCELLED: hexToRgb("F4CCCC"), // same red — reads as cancelled at a glance
};
```

`lib/subscriber-store.ts` line 185 — the reset-colour branch also fires for TRIAL_CANCELLED:

```typescript
    } else if (patch.status === "CANCELLED" || patch.status === "TRIAL_CANCELLED") {
```

Update the sheets.ts comment block (lines 30-34) to list the three new E values and the START_TRIAL G value.

- [ ] **Step 4: Typecheck + tests**

Run: `npm run typecheck && npm test -- sheets 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/subscriber-store.ts lib/sheets.ts lib/sheets.test.ts
git commit -m "feat: store/sheets accept trial statuses + START_TRIAL, TRIAL_CANCELLED gets red fill"
```

---

### Task 4: Translator — isTrial on cancellation actions

**Files:**
- Modify: `lib/stripe-translator.ts` (action type defs at lines 107 & 132; emit sites at lines 650-662)
- Test: `lib/stripe-translator.test.ts`

- [ ] **Step 1: Write failing tests** — in the existing `customer.subscription.updated` describe blocks, add: scheduling a cancellation on a subscription whose `status` is `"trialing"` yields `CANCELLATION_SCHEDULED` with `isTrial: true` (and `isTrial: false` when `"active"`); same pair for `CANCELLATION_UNDONE`. Follow the file's existing event-fixture helpers.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- stripe-translator 2>&1 | tail -10`
Expected: FAIL (isTrial undefined).

- [ ] **Step 3: Implement.** Add to both action type definitions:

```typescript
      /** True when the subscription is still in its free trial. Optional to
       *  match STARTED's isTrial?: boolean — existing fixtures stay valid. */
      isTrial?: boolean;
```

and at the emit sites:

```typescript
      actions.push({
        kind: "CANCELLATION_SCHEDULED",
        stripeSubscriptionId: subscription.id,
        accessEndDate: new Date(accessEndSeconds * 1000),
        cancellationFeedback: subscription.cancellation_details?.feedback ?? null,
        cancellationComment: subscription.cancellation_details?.comment ?? null,
        isTrial: subscription.status === "trialing",
      });
```

```typescript
    actions.push({
      kind: "CANCELLATION_UNDONE",
      stripeSubscriptionId: subscription.id,
      isTrial: subscription.status === "trialing",
    });
```

- [ ] **Step 4: Run tests** — `npm test -- stripe-translator 2>&1 | tail -5` → PASS. (`npm run typecheck` may fail until Task 5 gives the lifecycle handlers the flag — that's fine at this step only if the failure is in subscription-lifecycle.ts; anything else, fix here.)

- [ ] **Step 5: Commit**

```bash
git add lib/stripe-translator.ts lib/stripe-translator.test.ts
git commit -m "feat: translator flags isTrial on cancellation scheduled/undone"
```

---

### Task 5: Lifecycle — write the trial statuses

**Files:**
- Modify: `lib/subscription-lifecycle.ts` (STARTED ~lines 519-555 & event-log line 660; CANCELLATION_SCHEDULED line 1011; CANCELLATION_UNDONE line 1065; ENDED lines 1222, 1237, 1239)
- Test: `lib/subscription-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests** (use the file's existing fake-store helpers; one test per behaviour):

1. STARTED with `isTrial: true`, new subscriber → `appendNew` called with `status: "TRIAL_ACTIVE"`, `latestAction: "START_TRIAL"`; event log action is `START_TRIAL`.
2. STARTED with `isTrial: true`, existing subscriber (reactivation) → patch has `status: "TRIAL_ACTIVE"`, `latestAction: "REACTIVATED"`; log action stays `REACTIVATED`.
3. STARTED paid (no isTrial) → unchanged: `ACTIVE` / `NEW_SUBSCRIPTION`.
4. CANCELLATION_SCHEDULED with `isTrial: true` → patch `status: "TRIAL_CANCELLATION_SCHEDULED"`, latestAction still `"CANCELLATION_SCHEDULED"`; with `isTrial: false` → `"CANCELLATION_SCHEDULED"`.
5. CANCELLATION_UNDONE with `isTrial: true` → `status: "TRIAL_ACTIVE"`; false → `"ACTIVE"`.
6. ENDED with `wasUnconvertedTrial: true` → `status: "TRIAL_CANCELLED"` and win-back email (existing behaviour).
7. ENDED duplicate guard: row status `"TRIAL_CANCELLED"` → returns without writing/emailing (mirror the existing CANCELLED-guard test).
8. ENDED on a row in `"TRIAL_CANCELLATION_SCHEDULED"` → treated as `wasScheduled` (no "subscription ended" email when not win-back — construct with `wasUnconvertedTrial: false` to isolate the wasScheduled path).
9. Trial conversion regression: TRIAL_CONVERTED + RENEWED still land the row on `"ACTIVE"` (existing tests likely cover RENEWED writing ACTIVE — extend one to start from a `TRIAL_ACTIVE` row).

- [ ] **Step 2: Run to verify they fail** — `npm test -- subscription-lifecycle 2>&1 | tail -15`

- [ ] **Step 3: Implement.**

STARTED reactivation patch (line 529-530):

```typescript
        status: isTrial ? "TRIAL_ACTIVE" : "ACTIVE",
        latestAction: "REACTIVATED",
```

(NOTE: `const isTrial = action.isTrial === true;` currently sits at line 566, AFTER both write paths — move it up above the `if (existing)` block.)

STARTED append path (add to the `appendNew` object):

```typescript
        status: isTrial ? "TRIAL_ACTIVE" : "ACTIVE",
        latestAction: isTrial ? "START_TRIAL" : "NEW_SUBSCRIPTION",
```

STARTED event log (line 660):

```typescript
        action: isReactivation
          ? "REACTIVATED"
          : isTrial
            ? "START_TRIAL"
            : "NEW_SUBSCRIPTION",
```

CANCELLATION_SCHEDULED (line 1011):

```typescript
      status: action.isTrial ? "TRIAL_CANCELLATION_SCHEDULED" : "CANCELLATION_SCHEDULED",
      latestAction: "CANCELLATION_SCHEDULED",
```

CANCELLATION_UNDONE (line 1065):

```typescript
      status: action.isTrial ? "TRIAL_ACTIVE" : "ACTIVE",
```

ENDED — guard (line 1222), wasScheduled (1237), write (1239):

```typescript
    if (existing.status === "CANCELLED" || existing.status === "TRIAL_CANCELLED") {
      console.log(
        `ENDED ${existing.email} — duplicate delivery, row is already cancelled (skipped)`
      );
      return;
    }
```

```typescript
    const wasScheduled =
      existing.status === "CANCELLATION_SCHEDULED" ||
      existing.status === "TRIAL_CANCELLATION_SCHEDULED";
```

```typescript
    await this.store.applyUpdate(existing, {
      status: isWinback ? "TRIAL_CANCELLED" : "CANCELLED",
    });
```

(`isWinback` is declared at line 1232, AFTER the current status write ordering — check the actual order and declare `isWinback` before the `applyUpdate` call.)

- [ ] **Step 4: Full suite + typecheck**

Run: `npm run typecheck && npm test 2>&1 | tail -8`
Expected: all green (this is where Task 4's deferred typecheck must come clean).

- [ ] **Step 5: Commit**

```bash
git add lib/subscription-lifecycle.ts lib/subscription-lifecycle.test.ts
git commit -m "feat: lifecycle writes TRIAL_ACTIVE/TRIAL_CANCELLATION_SCHEDULED/TRIAL_CANCELLED + START_TRIAL"
```

---

### Task 6: Backfill script

**Files:**
- Create: `scripts/backfill-trial-statuses.mts` (model on `scripts/dry-run-trial-standardise.mts` / `scripts/backfill-status-log.mts` for env loading + Stripe client + sheets access patterns — read both before writing)

- [ ] **Step 1: Write the script.** Behaviour:

1. List all Stripe subscriptions with `status: "trialing"` (auto-paginate).
2. Read all sheet rows (reuse `getAllSubscriberRows` from `lib/sheets.js`).
3. For each sheet row whose col-O sub ID is in the trialing set:
   - target status = `TRIAL_CANCELLATION_SCHEDULED` if that subscription has `cancel_at_period_end === true` or `cancel_at` set, else `TRIAL_ACTIVE`;
   - target latestAction = `START_TRIAL` only when the current G value is exactly `NEW_SUBSCRIPTION`; otherwise leave G alone.
4. Print a table: row number, email, current E/G → target E/G.
5. Dry-run by default; `--live` applies via the existing sheets write helpers (`updateRowFields` or targeted `values.update` on E/G per row — follow how `reconcile-subscribers-from-log.mts` writes, if it does; otherwise use the store's `applyUpdate`). No colour writes needed (all targets are white; rows being touched are currently white).
6. Print a summary count: rows moved, rows skipped (already trial-status), trialing subs with no sheet row (list them — they indicate a sheet gap).

- [ ] **Step 2: Dry-run against live data**

Run: `npx tsx --env-file=.env scripts/backfill-trial-statuses.mts`
Expected: ~60+ rows listed (the live trial cohorts), zero writes. Sanity-check a few emails against the sheet by hand.

- [ ] **Step 3: Commit (script only — the live run happens at rollout step 3)**

```bash
git add scripts/backfill-trial-statuses.mts
git commit -m "feat: one-off backfill script for trial statuses (dry-run by default)"
```

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (Website repo — sheet-schema section E/G value lists, trial-flow section)
- Modify: `README-webhook.md` only if it enumerates status values (grep first)

- [ ] **Step 1:** Update the status/action vocabulary in Website `CLAUDE.md`: col E gains `TRIAL_ACTIVE | TRIAL_CANCELLATION_SCHEDULED | TRIAL_CANCELLED`, col G gains `START_TRIAL`, and one sentence on the mapping (trial variants behave exactly like their paid counterparts for access; TRIAL_CANCELLED = ended without converting).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md README-webhook.md
git commit -m "docs: trial status vocabulary in schema docs"
```

---

## Rollout (after all tasks green — needs Joseph's go)

1. **Bot repo:** push, then pull + restart on the VPS (manual — Joseph or guided session; `About Me/vps-accounts.md` has the host).
2. **Website repo:** push to `main` (auto-deploys). Readers and writer ship together here — safe because the bot (the only external reader) already accepts the new statuses.
3. **Backfill:** `npx tsx --env-file=.env scripts/backfill-trial-statuses.mts` (review dry-run) then `--live`.
4. Spot-check the sheet: trial rows read TRIAL_ACTIVE, converted/paid rows untouched, bot join guard still admits a trialist (ask one to rejoin or use `test_user.py`).
