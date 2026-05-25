# RHO Market Navigator — Business Workflow Reference

## Overview

Subscription-based trading signals service. Subscribers get access to a TradingView indicator and a private Telegram signal group based on their plan. Website: https://rho-market-navigator.vercel.app (GitHub repo: Indicator Subscription). Hosted on Vercel.

---

## Subscription Plans & Plan Type Strings

| Plan | Type String | Price | Markets Covered |
|---|---|---|---|
| FXMC | `FXMC` | $29/mo ($87/qtr) | Forex, BTC/ETH, Gold/Silver |
| SG | `SG` | $29/mo ($87/qtr) | SG stocks/futures/indices |
| HK | `HK` | $49/mo ($147/qtr) | HK stocks/futures/indices |
| US | `US` | $49/mo ($147/qtr) | US stocks/futures/indices + DAX40/Nikkei |
| US + HK | `US_HK` | $88/mo ($264/qtr) | US + HK |
| US + SG + FXMC | `US_SG_FXMC` | $88/mo ($264/qtr) | US + SG + FXMC |
| HK + SG + FXMC | `HK_SG_FXMC` | $88/mo ($264/qtr) | HK + SG + FXMC |
| All Markets | `ALL_MARKETS` | $129/mo ($388/qtr) | All 4 markets |

All plans are billed quarterly (3-month commitment, no refunds).

---

## Google Sheets Database

**Spreadsheet name:** `RHO Navigator Subscriptions`  
**One row per subscriber. Columns (left to right):**

| Col | Field | Source |
|---|---|---|
| A | Email | Zapier (from Stripe) |
| B | Customer Name | Zapier (from Stripe) |
| C | TradingView Username | Zapier (from Stripe checkout field) |
| D | Telegram Username | Zapier (from Stripe checkout field) |
| E | Telegram User ID | bot.py (written when user joins group) |
| F | Plan Type | Zapier (from Stripe) |
| G | Subscription Start | Zapier on new sub; manual on renewal |
| H | Subscription Expiry | Zapier on new sub; manual on renewal |
| I | Status | Zapier (ACTIVE on new; CANCELLED on cancellation trigger) |
| J | Stripe Customer ID | Zapier (from Stripe) |
| K | Previous Plan Type | Webhook (set on upgrade/plan change/returning subscriber) |
| L | Renewal Count | Webhook (incremented on each renewal cycle and on returning subscriber) |
| M | Change Type | Webhook (Upgraded / Downgraded / Switched Plan; cleared on renewal) |

---

## Infrastructure Stack

| Layer | Tool | Role |
|---|---|---|
| Website | Vercel (HTML/CSS/JS) | Marketing, pricing, disclaimer modal |
| Payments | Stripe | Subscription processing, customer portal |
| Automation | Zapier | New sub → Sheets + email + Telegram notify |
| Database | Google Sheets | Subscriber records |
| Access Control | Python Telegram bots | Group join guard + daily expiry kicker |
| Indicators | TradingView (Pine Script) | 8 separate scripts, one per plan, invite-only |

---

## Website Flow

1. User browses pricing → clicks Subscribe
2. **Disclaimer modal** intercepts click — user must read and tick acknowledgement
3. On confirm → redirected to Stripe checkout (buy.stripe.com link)
4. Stripe checkout collects: email, name, TradingView username, Telegram username
5. Payment completes → Stripe fires webhook to Zapier

**Mobile:** pricing cards render as a swipeable slider (destroyed + rebuilt on tab switch). Desktop: CSS grid layout.

**Manage Subscription:** navbar link → Stripe customer portal (billing.stripe.com) where clients self-manage cancellations.

---

## Zapier Automation

### Trigger: New Subscription
1. Stripe fires new subscription event → Zapier
2. Zapier appends new row to Google Sheet with all subscriber fields
3. Zapier sends onboarding email to subscriber
4. Zapier sends Telegram notification to **RHO Navigator Bot** (Joseph's admin bot) with: plan type, TradingView username, Telegram username

### Trigger: Cancellation
1. Stripe fires cancellation event → Zapier
2. Zapier looks up Stripe Customer ID in spreadsheet
3. If found → updates that row's Status column to `CANCELLED`
4. (Not fully tested yet)

### Not automated (manual):
- Renewals: Joseph manually updates Subscription Start, Subscription Expiry, Renewal Count in sheet
- Upgrades: fully manual (see below)

---

## TradingView Indicator Access

- **8 Pine Script indicator scripts**, one per plan tier
- On new subscription: Joseph receives Telegram notification → manually invites TradingView username to the correct script
- On cancellation/expiry: Joseph manually finds and removes username from the script
- Pine Script cannot make HTTP requests — no live DB lookups possible; access control is purely via TradingView's native invite system

---

## Telegram Group Access Control

Four private groups, managed by bot.py:

| Group | chat_id | Allowed Plan Types |
|---|---|---|
| HK_MARKET | -1003174239460 | HK, US_HK, HK_SG_FXMC, ALL_MARKETS |
| SG_MARKET | -1003120184464 | SG, US_SG_FXMC, HK_SG_FXMC, ALL_MARKETS |
| US_MARKET | -1002970318018 | US, US_SG_FXMC, US_HK, ALL_MARKETS |
| FXMC_MARKET | -1002929109438 | FXMC, US_SG_FXMC, HK_SG_FXMC, ALL_MARKETS |

**Whitelist** (allowed in any group, no checks): Joseph_Ho, robinhosa, noahiee, christianadr

---

## Python Bot Files

### `bot.py` — Join Guard
Monitors all group join events. On each new member:
1. No Telegram username → kick
2. Username in whitelist → allow
3. Username not in spreadsheet → kick
4. Status = CANCELLED → kick
5. Plan type not in group's allowed list → kick
6. All checks pass → write Telegram User ID to col E, allow

### `scheduler.py` — Daily Expiry Kicker
Runs at **12:00 PM SGT** daily. Scans sheet for rows with Status = CANCELLED or EXPIRED → kicks user from all groups their plan had access to → clears Telegram User ID cell (col E).

### `send_tele_msg.py` — Manual Message Sender
Sends a new message to any Telegram topic by pasting a message link. Used for ad-hoc announcements.

### `edit_tele_msg.py` — Manual Message Editor
Edits an existing Telegram message by pasting its link.

### `daily_initialization.py` — **REMOVED**
This script no longer exists/runs. Bar replay initialization messages are no longer sent automatically.

---

## Upgrade Process (Fully Manual)

1. Client verbally requests upgrade
2. Joseph modifies subscription in Stripe portal (no downgrade allowed)
3. Joseph updates sheet: Plan Type, Previous Plan Type
4. Joseph removes TradingView access for old script, grants access for new script
5. Telegram bot handles group access automatically on next join (or scheduler handles removal)

---

## Cancellation Flow

1. Client goes to website → Manage Subscription (navbar) → Stripe customer portal
2. Client cancels — access continues to end of billing period
3. Zapier updates Status to CANCELLED in sheet
4. scheduler.py daily run kicks user from Telegram groups and clears User ID
5. Joseph manually removes TradingView access

---

## Key Technical Constraints

- Pine Script cannot make HTTP requests — no live access control from indicators
- Zapier uses a single dynamic JS code step (not separate paths per plan) — plan type drives all logic
- Mobile slider must be fully destroyed and rebuilt on tab switch (not re-initialized) to avoid stale state
- CSS mobile overrides scoped to `.active` states only to avoid breaking tab show/hide
- `window.open(null)` coerces to the string `"null"` — always capture Stripe URL in local variable before opening modal

---

## Webhook Architecture

The Stripe webhook is split into four modules. Each one has a single job; everything past the translator speaks the subscriber domain rather than Stripe shapes.

| Module | File | Job |
|---|---|---|
| Edge | `api/stripe-webhook.ts` | Receive HTTP request, verify signature, call translator, dispatch actions to lifecycle. Owns nothing else. |
| `StripeEventTranslator` | `lib/stripe-translator.ts` | Pure transformation from `Stripe.Event` to a list of `SubscriberAction` values. May call back into Stripe (e.g. retrieve a subscription) but does not touch the store, mailer, or notifier. No business rules. |
| `SubscriptionLifecycle` | `lib/subscription-lifecycle.ts` | Owns every per-action rule: which fields to write, which emails to send, which admin pings to fire. Driven by `apply(action)`. Knows nothing about Stripe. Collaborators (`store`, `mailer`, `notifier`) are passed into the constructor. |
| `SubscriberStore` | `lib/subscriber-store.ts` | Storage seam for subscriber rows. `SheetsSubscriberStore` is the current Google Sheets implementation; intended to deepen further so `lib/sheets.ts` becomes an internal detail. Patches accept real `Date` values; the store formats internally. |

### `SubscriberAction`

The discriminated union the translator emits and the lifecycle consumes. One Stripe event may produce 0, 1, or several actions.

| Kind | Triggered by | What the lifecycle does |
|---|---|---|
| `STARTED` | `checkout.session.completed` (subscription mode) | Append a new subscriber row, or — if email already exists — update in place and tag `REACTIVATED`. Email onboarding + admin ping. |
| `RENEWED` | `invoice.payment_succeeded` with `billing_reason=subscription_cycle` | Refresh dates, bump `subscriptionCount`, reset `failedPaymentCount`. Admin ping. |
| `PLAN_CHANGED` | `customer.subscription.updated` with `items` in `previous_attributes` | Lifecycle resolves the old plan from the store and classifies the change (`UPGRADED`/`DOWNGRADED`/`PLAN_SWITCH`). Sheet update + admin ping. |
| `CANCELLATION_SCHEDULED` | `customer.subscription.updated` with `cancel_at_period_end` flipping false → true | Update expiry to the access-end date. Send cancellation confirmation email + admin ping. |
| `ENDED` | `customer.subscription.deleted` | Flip status to `CANCELLED`. Admin ping (TradingView removal still manual). |
| `PAYMENT_FAILED` | `invoice.payment_failed` | Increment `failedPaymentCount`. Send payment-failed email + admin ping. |
| `PAST_DUE` | `customer.subscription.updated` with status → `past_due` | Admin Telegram ping only. No sheet write — `PAYMENT_FAILED` is expected to follow. |

### Test seam

Every collaborator (`SubscriberStore`, `Mailer`, `AdminNotifier`) is an interface. Tests drive the lifecycle with plain `SubscriberAction` objects and substitute in-memory implementations — no Stripe payloads, no live HTTP. The `Mailer` and `AdminNotifier` interfaces are satisfied by plain object literals in `api/stripe-webhook.ts`; no class wrappers are needed.

### Dates

All in-memory date values in the lifecycle and the action payloads are JavaScript `Date` objects. The only place dates are converted to display strings (`"16 April 2026 18:00"` in Singapore time) is `lib/format-date.ts`, called from the store on write and from the lifecycle on outbound admin/email messages.
