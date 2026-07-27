# Invalid TradingView username → welcome email variant (+ trial group section removed)

Date: 2026-07-27. Approved by Joseph in session.

## Problem

The welcome email (normal and trial variants) promises "your access switches on by 12 noon the next day" even when the TradingView username the customer typed at checkout doesn't exist. The grant then fails, Joseph gets a ❌ ping, but the customer sits waiting for access that can never arrive.

Separately: the trial welcome's "Join your trial Telegram group" section is no longer wanted and should be removed entirely.

## Design

### 1. Username check before the email (`lib/subscription-lifecycle.ts`)

`TradingViewGranter` gains an **optional** `validateUsername(username): Promise<string | null>` method. `TradingViewAccessClient` already implements it (TradingView's public `username_hint` lookup — works independently of the session cookie, so it only flags genuinely wrong usernames, never our own auth problems). `NoopTradingViewGranter` does not implement it.

In `handleStarted`, before building side effects, resolve one flag `tvUsernameInvalid`:

- Username blank/missing → **invalid** (Joseph's decision: treat same as wrong).
- `validateUsername` returns null → **invalid**.
- Lookup succeeds, lookup throws, or the granter has no validator → **valid** (fail open; the normal email goes out and the existing failure pings still cover Joseph).

When invalid: **skip the grant** (it could only fail) and send one clear admin ping instead — "⚠️ Invalid TradingView username — grant skipped; welcome email asked them to contact you." Pass the flag into `sendOnboarding`.

Reactivations take the same path (they also send the onboarding email).

### 2. Email variant (`lib/email.ts`)

`OnboardingEmailData` gains `tvUsernameInvalid?: boolean`. In the "Attach the Navigator to your charts" step — both normal and trial variants, HTML **and** plain text — the flag swaps:

- The amber warning note LEADS the step (Joseph's revision, same day: the note used to trail the attach steps, which read out of order): the username they gave (shown) doesn't match any TradingView account, so access can't be switched on yet; WhatsApp Joseph at 8200 7039 (tappable `https://wa.me/6582007039` link) or message @Joseph_Ho on Telegram with the correct username. Slightly different first sentence when the username was blank ("We didn't get your TradingView username at checkout…").
- The attach steps then follow under a short "Once it's fixed, here's how to add the Navigator to a chart:" line, replacing the normal "access switches on by 12 noon" intro. The trailing blue "We switch it on for your TradingView username: X" note only appears on the valid path.

The three attach instructions and the guide button are unchanged. The trial *conversion* email is untouched.

### 3. Trial welcome: trial group section removed

The trial variant drops the "Join your trial Telegram group" step (HTML + text). Steps renumber: 1. Attach the Navigator, 2. Get to know the Navigator. Trialists get **no Telegram button at all** in the welcome (Joseph confirmed). `TRIAL_GROUP_LINK` is deleted if nothing else uses it; `TRIAL_END_DISPLAY` stays (still used for the "First charge" framing).

## Error handling

- Validation network error → log, assume valid, proceed (never block or mis-warn a customer over our own hiccup).
- Invalid path never throws: the ping uses the existing never-throws `pingTv` helper; the email send failure is handled by `runSideEffects` as today.

## Tests (`lib/subscription-lifecycle.test.ts`)

Fake granter's `validateUsername` defaults to "valid" so existing tests are untouched. New cases:

1. Lookup returns null → mailer receives `tvUsernameInvalid: true`, no grant recorded, notifier message mentions the invalid username.
2. Blank username → same as (1).
3. Lookup throws → `tvUsernameInvalid` falsy, grant still attempted.
4. Lookup returns a canonical name → flag falsy, grant recorded.

All existing tests stay green; `npm run typecheck` stays green.

## Docs to update

- `Website/CLAUDE.md`: STARTED row + free-trials section (no more trial-group button; username validated before the welcome email).
- `../Navigator Business Resources/business-workflow.md`: same two spots.
- `About Me/memory.md`: dated Recent Log entry.
