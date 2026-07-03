# RHO Navigator — Website & Stripe Webhook

## Identity

This repo (`josephhocw/Navigator-Subscription`, branch `main`, deployed on Vercel) is the RHO Navigator subscription website **and** the Stripe webhook that runs the whole subscription back office. The webhook replaced a set of Zapier automations in June 2026 — it is now the sole automation. On every Stripe event it: updates a Google Sheets subscriber database, sends a customer email via Resend, and pings Joseph on Telegram.

The marketing site is an Astro app under `web/` (rebuilt June 2026; the old root-level HTML site is retired). The back office is TypeScript Vercel serverless under `api/` + `lib/`.

> This repo is nested inside a larger workspace (`Navigator Business/`) that gitignores it, so the broader business context — pricing strategy, the Telegram bots, secrets map — lives one level up and is **not** in this repo. If you have it locally, see `../CLAUDE.md`, `../Navigator Business Resources/business-workflow.md`, and `../Navigator Business Resources/secrets-map.md`.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Astro site under `web/`. Pricing cards, guides/learn content (MDX), mobile slider. |
| Payments | Stripe Payment Links (one per plan, dashboard-configured) + customer portal for self-service. No checkout session is created in code. |
| Webhook | TypeScript Vercel serverless function, `api/stripe-webhook.ts`. |
| Email | Resend (`lib/email.ts`). |
| Database | Google Sheets API (`lib/sheets.ts`), 16-col schema. |
| Admin alerts | Telegram Bot API (`lib/telegram.ts`). |

## Webhook architecture

Four layers; everything past the translator speaks the subscriber domain, not Stripe shapes. Keep this separation — it's what makes the lifecycle unit-testable without Stripe payloads.

| Module | File | Job |
|---|---|---|
| Edge | `api/stripe-webhook.ts` | Receive request, verify the `stripe-signature`, call the translator, dispatch the resulting actions to the lifecycle. Owns nothing else. Satisfies the `Mailer` / `AdminNotifier` interfaces with plain object literals. |
| `StripeEventTranslator` | `lib/stripe-translator.ts` | Pure transform: `Stripe.Event` → a list of `SubscriberAction` values. May call back into Stripe (e.g. retrieve a subscription/schedule) but never touches the store, mailer, or notifier. No business rules. |
| `SubscriptionLifecycle` | `lib/subscription-lifecycle.ts` | Every per-action business rule: which fields to write, which email to send, which admin ping to fire. Driven by `apply(action)`. Knows nothing about Stripe. Collaborators (`store`, `mailer`, `notifier`) are injected. |
| `SubscriberStore` | `lib/subscriber-store.ts` | Storage seam. `SheetsSubscriberStore` is the Google Sheets implementation; patches accept real `Date` objects and the store formats them on write. Wraps `lib/sheets.ts`. |

Supporting modules: `lib/plans.ts` (price-ID → plan mapping, prices, display names, plan-change classification, invite links), `lib/format-date.ts` (the single place dates become display strings — `"16 April 2026 18:00"` Singapore time).

### `SubscriberAction` (the union the translator emits, the lifecycle consumes)

One Stripe event may produce 0, 1, or several actions.

| Kind | Triggered by | Lifecycle behaviour |
|---|---|---|
| `STARTED` | `checkout.session.completed` (subscription mode) | Append a row, or update in place + tag `REACTIVATED` if the email exists. Onboarding email + admin ping. |
| `RENEWED` | `invoice.payment_succeeded`, `billing_reason=subscription_cycle` | Refresh dates, bump `subscriptionCount`, reset `failedPaymentCount`. Admin ping (silent otherwise). |
| `PLAN_CHANGED` | `customer.subscription.updated` with `items` in `previous_attributes` | Resolve old plan from the store, classify UPGRADED / DOWNGRADED / PLAN_SWITCH by price. Sheet update + email + admin ping. Downgrades write the transient `DOWNGRADE_EXECUTED` marker instead and defer email + ping to the confirming `RENEWED`, which flips it to `DOWNGRADED`. |
| `DOWNGRADE_SCHEDULED` | `customer.subscription.updated` with a `schedule` newly attached | Tag the pending downgrade; Current Plan stays until the scheduled date. Email + admin ping. |
| `CANCELLATION_SCHEDULED` | `customer.subscription.updated`, `cancel_at_period_end` false → true | Set expiry to access-end date. Cancellation email (Undo button → billing portal) + admin ping. |
| `CANCELLATION_UNDONE` | `cancel_at_period_end` true → false | Status → ACTIVE, `UNDO_CANCELLATION`. Admin ping only. |
| `ENDED` | `customer.subscription.deleted` | Status → CANCELLED. Admin ping (TradingView removal is manual). |
| `PAYMENT_FAILED` | `invoice.payment_failed` | Increment `failedPaymentCount`. Payment-failed email + admin ping. |
| `DOWNGRADE_UNDONE` | `customer.subscription.updated`, schedule released with items unchanged (see gotcha below) | `UNDO_DOWNGRADE`. Downgrade-undone email + admin ping. |
| `CANCELLATION_REASON_RECEIVED` | `customer.subscription.updated` with only `cancellation_details` changed | Admin ping with the reason; no sheet write. |
| `COUPON_CHANGED` | `customer.subscription.updated` with `discounts` changed, items unchanged | Update price + coupon checkbox. Admin ping only. |

**Downgrade-executed gotcha (already handled — don't re-open):** when a scheduled downgrade fires at period end, Stripe sends two `customer.subscription.updated` events — the items change (correct) and the schedule release. With `end_behavior: "release"` the schedule status is `"released"` in *both* the natural-completion and manual-undo cases, so status can't disambiguate. The translator compares the subscription's current price ID against the schedule's phase-1 target price: match → already executed, skip; mismatch → subscriber cancelled the pending downgrade, emit the undo.

### Other event-handling notes

- **Payment-link sessions:** checkouts come from Stripe Payment Links (one per plan), not API-created sessions. `customer_email` can be **null** on those, so the translator uses `customer_details.email` as the dedup key. The TradingView/Telegram custom fields must be configured per payment link in the dashboard to appear in `custom_fields`.
- **Downgrade *scheduled* detection:** the customer portal queues a downgrade as a subscription schedule, so `previous_attributes.schedule` goes `null` → schedule ID while `items` is absent (items haven't changed yet). That's the signal for `DOWNGRADE_SCHEDULED`; resolve the effective date from `phases[0].end_date` (fallback `current_period_end`).
- **Events deliberately ignored:** `customer.subscription.created` (redundant — checkout covers new subs), `customer.created`, `invoice.created`, `payment_intent.*`, and `charge.refunded` (refunds are handled manually in Stripe — no sheet/notification automation). They're logged and dropped.

## Sheet schema (16 cols, A–P)

Data starts at row 2; row 1 is headers. Subscriber primary key for dedup is **email**; the post-checkout lookup key is **Stripe Subscription ID** (col O). `bot.py` (separate repo) reads this same sheet and owns col P.

`A` Email · `B` Customer Name · `C` TradingView Username · `D` Telegram Username · `E` Status (`ACTIVE`/`PAYMENT_FAILED`/`CANCELLATION_SCHEDULED`/`CANCELLED`) · `F` Current Plan · `G` Latest Action · `H` Previous Plan · `I` Subscription Price · `J` Coupon Discount (checkbox) · `K` Subscription Start · `L` Subscription Expiry · `M` Subscription Count · `N` Failed Payment Count · `O` Stripe Subscription ID · `P` Telegram User ID (bot-owned).

Col J must be formatted as a Sheets checkbox; the webhook writes `TRUE`/`FALSE` with `USER_ENTERED`.

## Plans & prices

`lib/plans.ts` holds `PRICE_TO_PLAN` (both **live and test** price IDs — they're globally unique so they coexist) and `PLAN_PRICE_SGD_QUARTERLY` (drives UPGRADED/DOWNGRADED/PLAN_SWITCH). Update both whenever a Stripe price is added or replaced. **When a price rises, add the new price ID but keep the old one** — grandfathered subscribers stay on the old ID and their renewals must still resolve. The plan strings here are mirrored by hand in the bot's `config.py` — keep them aligned.

Two things the plan *code* hides: (1) **display names can differ from codes** — e.g. `US_SG_FXMC` shows as "US + FXMC" (`PLAN_DISPLAY_NAMES`); (2) **every combo grants the SG market as a free bonus** — `parsePlanType()` appends `SG` to any combo that doesn't already name it (so `US_HK` → US/HK/SG). SG is a combo + All-Markets perk only; the single major plans don't include it. The same rule is mirrored in `config.py` `plan_markets()`.

## Dev, test, deploy

- **Env vars:** full list and meaning in `README-webhook.md`. Production values live in the Vercel dashboard; `.env` is local-dev only. Never commit real keys. Where each shared secret lives across runtimes: `../Navigator Business Resources/secrets-map.md`.
- **Typecheck:** `npx tsc --noEmit` (or `npm run typecheck`). Keep it green.
- **Local webhook testing:** `npx vercel dev` + `stripe listen --forward-to localhost:3000/api/stripe-webhook`, then `stripe trigger <event>`. Details in `README-webhook.md`.
- **Lifecycle tests:** every collaborator (`SubscriberStore`, `Mailer`, `AdminNotifier`) is an interface — drive the lifecycle with plain `SubscriberAction` objects and in-memory fakes; no Stripe payloads needed.
- **Deploy:** push to `main`; Vercel auto-deploys. The Playground workspace has a `/push-website` skill for this.
- **Don't run `npm run build` against `web/` while its dev server is live** — it corrupts the dev server's Vite cache (page serves correct SSR HTML but renders unstyled in-browser). Fix: stop the dev server, delete `web/node_modules/.vite`, restart.

## Editorial rules (customer-facing copy & emails)

Subscriber emails are sent to a 50s–60s, non-technical audience. Plain English, no jargon (no "webhook", "API", "Pine Script"). British spelling. Pricing in SGD shown as e.g. `$87 SGD`. Refer to the product as "the Navigator" for existing subscribers, "RHO Navigator" in first-touch/marketing copy. Never "RHO Market Navigator" - retired 4 July 2026 (the rho-market-navigator.vercel.app URL is the one permitted leftover). Email-template wording changes should be run past Joseph.
