# Trial-specific subscriber statuses — design

Date: 2026-08-05. Approved by Joseph in-session.

## Goal

Trial subscribers are currently indistinguishable from paying subscribers in the sheet's Status column (E) — both read `ACTIVE`. Introduce trial-prefixed statuses so the sheet shows at a glance who is on a free trial, plus a `START_TRIAL` Latest Action for trial sign-ups. Behaviour (access, kicks, emails) must not change — same rules, new names.

## Status model (col E)

| Situation | Today | New |
|---|---|---|
| On trial, in good standing | `ACTIVE` | `TRIAL_ACTIVE` |
| On trial, cancellation scheduled | `CANCELLATION_SCHEDULED` | `TRIAL_CANCELLATION_SCHEDULED` |
| Trial ended without ever paying (win-back path) | `CANCELLED` | `TRIAL_CANCELLED` |
| Trial converts (first paid charge) | `ACTIVE` | `ACTIVE` (unchanged) |
| Trialist undoes a scheduled cancellation | `ACTIVE` | `TRIAL_ACTIVE` |
| Paid-subscriber statuses (`ACTIVE`, `PAYMENT_FAILED`, `CANCELLATION_SCHEDULED`, `CANCELLED`) | — | unchanged |

Deliberate exclusion: **no `TRIAL_PAYMENT_FAILED`.** A failed conversion charge lands on `PAYMENT_FAILED` exactly as today.

## Latest Action (col G) + Status Log

- `STARTED` with `isTrial` writes `START_TRIAL` instead of `NEW_SUBSCRIPTION` (Subscribers col G **and** the Status Log Action column). No fill colour (white), same as `NEW_SUBSCRIPTION`.
- A trial reactivation keeps `REACTIVATED` (unchanged).
- All other Latest Action values unchanged — a trialist scheduling a cancellation still gets the yellow `CANCELLATION_SCHEDULED` action in G; only col E carries the `TRIAL_` prefix.

## Where trial-awareness comes from (translator, `lib/stripe-translator.ts`)

`STARTED` already carries `isTrial` (line ~291). The `customer.subscription.updated` handler has the full subscription in scope, so add `isTrial: subscription.status === "trialing"` to the actions that can fire mid-trial:

- `CANCELLATION_SCHEDULED` (~651)
- `CANCELLATION_UNDONE` (~660)

`PLAN_CHANGED` and `COUPON_CHANGED` need no flag — their handlers never write the status column, so a mid-trial plan change (portal is `continue_trial`) cannot clobber `TRIAL_ACTIVE`.

`ENDED` already computes `wasUnconvertedTrial` — that flag selects `TRIAL_CANCELLED` over `CANCELLED`. No new Stripe reads.

## Lifecycle write-sites (`lib/subscription-lifecycle.ts`)

Every `status:` write picks the trial variant when the action says trial:

| Site (approx line) | Action | Change |
|---|---|---|
| 529 | STARTED | `isTrial ? "TRIAL_ACTIVE" : "ACTIVE"`; latestAction `isTrial ? "START_TRIAL" : "NEW_SUBSCRIPTION"` (reactivations keep `REACTIVATED`) |
| 744, 808 | RENEWED (both branches) | stay `ACTIVE` — a cycle invoice means the trial is over, no flag needed |
| 1011 | CANCELLATION_SCHEDULED | `isTrial ? "TRIAL_CANCELLATION_SCHEDULED" : "CANCELLATION_SCHEDULED"` (latestAction unchanged) |
| 1065 | CANCELLATION_UNDONE | `isTrial ? "TRIAL_ACTIVE" : "ACTIVE"` |
| 1239 | ENDED | `wasUnconvertedTrial ? "TRIAL_CANCELLED" : "CANCELLED"` |
| — | PLAN_CHANGED / COUPON_CHANGED | no status writes exist — nothing to change |
| — | TRIAL_CONVERTED | unchanged (RENEWED on the same charge writes `ACTIVE`) |

**ENDED duplicate-delivery guard:** "already `CANCELLED`" becomes "already `CANCELLED` **or** `TRIAL_CANCELLED`".

## Readers that match on status strings

Same rule everywhere: `TRIAL_ACTIVE` and `TRIAL_CANCELLATION_SCHEDULED` behave like their paid counterparts (entitled); `TRIAL_CANCELLED` behaves like `CANCELLED` (barred).

Website repo:
- `lib/telegram-groups.ts` — `BARRED_STATUS` (line 30) becomes a barred **set** `{CANCELLED, TRIAL_CANCELLED}`.
- `lib/tradingview-reconcile.ts` — entitled list (~line 51) gains `TRIAL_ACTIVE`, `TRIAL_CANCELLATION_SCHEDULED`.
- `lib/followup.ts` — day-3 selector (line 90) accepts `ACTIVE` or `TRIAL_ACTIVE` (Joseph's decision: trialists keep getting the follow-up).
- `lib/subscriber-store.ts` — status type union (line 84) gains the three values; the `patch.status === "CANCELLED"` reset-colour branch (line 185) also matches `TRIAL_CANCELLED`.
- `lib/sheets.ts` — `STATUS_COLORS` gains `TRIAL_CANCELLED: F4CCCC` (same red as `CANCELLED`). `TRIAL_ACTIVE` / `TRIAL_CANCELLATION_SCHEDULED` stay white (map fallback — no entry needed).

Bot repo (`Telegram Bot/`, separate git repo `josephhocw/Navigator_Telegram_Bot`):
- `access.py` — `BARRED_STATUS = 'CANCELLED'` becomes `BARRED_STATUSES = {'CANCELLED', 'TRIAL_CANCELLED'}`; update comparisons and the comments stating "only CANCELLED is barred".
- `scheduler.py` — the `!= 'CANCELLED'` filter (line 49) becomes membership in the barred set (import from `access.py`, no duplication).
- `test_access.py` / `test_user.py` — add `TRIAL_ACTIVE` (entitled) and `TRIAL_CANCELLED` (barred) cases.

Explicitly untouched: `lib/comp-expiry.ts` (comps are not trials — keeps writing `CANCELLED`), `lib/trial-standardiser.ts` (reads Stripe, not the sheet), `lib/email.ts` (emails key off actions, not sheet status), `Automation/generate_subscription_report.py` (reads the Stripe mirror).

## Backfill (one-off script, run after deploy)

For every sheet row whose col-O subscription is currently `trialing` in Stripe:
- Status → `TRIAL_ACTIVE`, or `TRIAL_CANCELLATION_SCHEDULED` if `cancel_at_period_end` is true.
- Col G `NEW_SUBSCRIPTION` → `START_TRIAL` on those rows only (other G values left alone).

History is not rewritten: rows for already-ended trials stay `CANCELLED`; the Status Log is append-only and untouched. Script lives in `scripts/`, dry-run by default, `--live` to write.

## Rollout order

1. Deploy readers: bot repo change (pull + restart on the VPS) and website consumer changes — harmless while no row carries a new status.
2. Deploy the writer: lifecycle/translator changes.
3. Run the backfill (dry-run, review, live).

## Testing

- `lib/subscription-lifecycle.test.ts` — new cases: trial STARTED writes `TRIAL_ACTIVE` + `START_TRIAL`; trial cancellation scheduled/undone; unconverted-trial ENDED writes `TRIAL_CANCELLED`; ENDED duplicate guard accepts `TRIAL_CANCELLED`; conversion still lands on `ACTIVE`.
- `lib/stripe-translator.test.ts` — `isTrial` set on the four updated actions when the subscription is `trialing`.
- Bot: `python -m pytest` in the bot repo for the barred-set change.
- `npm run typecheck` + `npm test` green before any deploy.
