# Instant Telegram group removal on cancellation

**Date:** 2026-08-03
**Status:** Approved for implementation
**Scope:** Website repo (`josephhocw/Navigator-Subscription`). No changes to the bot repo.

## Problem

When a subscription ends, the webhook already flips the sheet to `CANCELLED`, removes the
TradingView script grant and logs the event — all within seconds. Telegram is the one
collaborator missing from that list. Group removal is left to `scheduler.py`, which sweeps
once a day at 12:00 PM SGT, so a cancelled subscriber keeps access to the main group and
every signal group for up to 24 hours.

Observed 2026-08-03: a subscriber was cancelled at 14:15 SGT and would have retained group
access until noon the following day.

## Goal

Remove a subscriber from every Telegram group they are no longer entitled to, within
seconds of their subscription ending, without touching anyone else.

## Non-goals

- Replacing `bot.py` (the join guard). It stays, and remains essential — it is what writes
  the Telegram User ID to col P that this feature depends on.
- Replacing `scheduler.py`. It is demoted to a reconcile/safety net, unchanged.
- Kicking at `CANCELLATION_SCHEDULED`. A subscriber who schedules a cancellation has paid
  through their period end and keeps access until `ENDED` fires.
- Notifying the removed member. Removal is silent; the existing "subscription has ended"
  email already covers it.
- Migrating the bots to Vercel. Tracked separately; see "Relationship to the bot migration".

## Key enabling fact

The website and the access bot **already share one bot token** (id `8399081613`, verified
2026-08-03: `Website/.env` `TELEGRAM_BOT_TOKEN` == `Telegram Bot/.env` `BOT_TOKEN`). That
bot is already an admin in all five groups, so Vercel can remove members with **no new
credentials, no VPS exposure and no new infrastructure**.

## Design

### New module: `lib/telegram-groups.ts`

A sixth lifecycle collaborator, mirroring the shape of `lib/tradingview-access.ts`:

```
interface TelegramGroupRemover {
  removeFromGroups(input: RemovalInput): Promise<RemovalResult>;
}
```

- `TelegramGroupApi` — the real implementation, driving the Telegram Bot API.
- `NoopTelegramGroupRemover` — used when chat IDs or the token are absent, exactly as
  `NoopTradingViewGranter` does. Fails open with a warning; never throws.

### Where it fires

Inside `handleEnded`'s existing `runSideEffects` block in `lib/subscription-lifecycle.ts`,
alongside `tvRemove`. It inherits that block's contract: a failure pings Joseph and is
logged, but never fails the webhook. Stripe must still get its 200.

### Decision logic (mirrors `access.py`)

Given the subscriber whose subscription just ended:

1. **Whitelist check.** If their Telegram username is in the whitelist, do nothing.
2. **User ID check.** If col P is empty, do nothing and report it in the ping — there is
   no way to address them. (`bot.py` fills col P on join; a subscriber who never joined has
   nothing to remove.)
3. **Entitlement calculation.** `store.listAll()`, find every row for the same Telegram
   username (case-insensitive, `@`-tolerant), and union the markets granted by each row
   whose status is **not** `CANCELLED`, using `parsePlanType()` from `lib/plans.ts`. Any
   non-cancelled row also grants the `MAIN` pseudo-market.
4. **Target groups** = every configured group whose market is not in that set. Deliberately
   independent of the cancelled row's own plan string, so a drifted or blank plan cannot
   leave someone un-removed. Same rule as `groups_to_kick()`.
5. **Per group:** `getChatMember` first; if not currently a member, skip quietly. Otherwise
   `banChatMember` then `unbanChatMember` — a rejoinable kick, identical to `common.py`
   `kick_user()`.

Reusing `parsePlanType()` means **no new plan duplication**. `plans.ts` is already the
TypeScript source of truth and is already mirrored by hand into `config.py`.

### Why this cannot touch non-subscribers

The removal is driven by one subscriber's `ENDED` action and operates only on the User ID
from that person's row. It never enumerates group membership and never makes a decision
about anyone it was not handed. A guest with no sheet row is unreachable by this code path.

Caveat to be aware of: a comped friend modelled as a sheet row (blank col O, fixed col L
expiry) *is* in the list, and their row flips to `CANCELLED` when the comp expires — but
via `comp-expiry.ts`, which does not emit `ENDED`, so they are swept by `scheduler.py` on
the normal daily cadence rather than instantly.

### Dry-run mode

`TELEGRAM_KICK_DRY_RUN=true` (the initial deployed value) performs the full lookup and
entitlement calculation, sends the admin ping describing exactly what it *would* do
(`"would remove @x from HK, SG, MAIN"`), and makes **no** `banChatMember` call. The
membership pre-check still runs, so the dry-run ping reflects real membership rather than
a guess.

Rollout: deploy with the flag on, compare the dry-run pings against what `scheduler.py`
actually removes at noon for a few real cancellations, then set the flag to `false`.

### Configuration (all env vars, nothing hardcoded)

| Var | Purpose |
|---|---|
| `TELEGRAM_CHAT_HK` / `_SG` / `_US` / `_FXMC` / `_MAIN` | The five group chat IDs |
| `TELEGRAM_KICK_WHITELIST` | Comma-separated usernames, mirroring `config.py` `WHITELIST` |
| `TELEGRAM_KICK_DRY_RUN` | `true` until the dry-run period passes |

`TELEGRAM_BOT_TOKEN` already exists and is reused.

The whitelist is an env var rather than a third hardcoded copy so it stays one value to
change. Missing or malformed chat IDs degrade to the Noop remover rather than throwing.

### Admin ping

One ping per `ENDED` summarising the outcome — groups removed, groups skipped, any
per-group failures, and the dry-run marker when applicable. Failures are collected, not
thrown: one group erroring must not prevent the other four from being processed.

## Testing

- `lib/telegram-groups.test.ts` (new) — pure entitlement and whitelist rules:
  - second active subscription keeps the person in the groups it covers
  - whitelisted username is never targeted
  - blank col P short-circuits and reports
  - unknown/blank plan string still removes from all non-entitled groups
  - dry-run performs no ban call
- `lib/subscription-lifecycle.test.ts` — extend with an in-memory fake remover; assert
  `handleEnded` calls it, and that a thrown error pings without failing the webhook.
- `npx tsc --noEmit` green.

## Relationship to the bot migration

Joseph is considering moving `bot.py` and `scheduler.py` onto Vercel wholesale — the join
guard becoming a Telegram webhook (`setWebhook` with `allowed_updates: ["chat_member"]`
plus a `secret_token`), the daily kicker becoming a Vercel Cron at `0 4 * * *` (12:00 SGT).
That is a separate project with a hard cutover: `setWebhook` disables `getUpdates`, so the
two cannot run in parallel.

`lib/telegram-groups.ts` is deliberately built as the reusable seam that migration needs —
chat IDs, whitelist, entitlement rules and the ban/unban primitive in TypeScript. This work
is slice 1 of that migration, not throwaway.

## Risks

| Risk | Mitigation |
|---|---|
| Entitlement bug removes a paying subscriber | Dry-run period before going live; `scheduler.py` uses the same rule today, so behaviour is comparable side by side |
| Whitelist drifts from `config.py` | Env var, and called out in `Website/CLAUDE.md` alongside the existing plans-sync note |
| Chat IDs drift from `config.py` | Same; the bot migration eventually removes the duplication entirely |
| Telegram API failure at the moment of `ENDED` | `runSideEffects` contract — ping and continue; `scheduler.py` catches it at noon |
| Subscriber never joined, col P blank | Skipped and reported; nothing to remove |
