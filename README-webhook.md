# Stripe Webhook — RHO Navigator

Serverless function that replaces the Zapier automation for handling Stripe subscription events.

## What it does

| Event | Actions |
|-------|---------|
| `checkout.session.completed` | Appends new row OR updates existing row (returning subscriber match by email). Sends onboarding email. Pings admin Telegram. |
| `invoice.payment_succeeded` (`subscription_cycle` only) | Updates start, expiry, last payment date. Sets Latest Action = RENEWAL. Increments Subscription Count. Resets Failed Payment Count. Pings admin. |
| `invoice.payment_failed` | Increments Failed Payment Count. Emails subscriber to update card. Pings admin. |
| `customer.subscription.updated` (plan change) | Updates Plan Type + Subscription Price + Coupon Discount + Previous Plan Type. Sets Latest Action = UPGRADED / DOWNGRADED / PLAN_SWITCH based on price comparison. Pings admin. |
| `customer.subscription.updated` (`cancel_at_period_end` → true) | Sets Status + Latest Action = CANCELLATION_SCHEDULED (access continues until period end). Emails subscriber cancellation confirmation with Undo Cancellation button. Pings admin. |
| `customer.subscription.updated` (coupon applied/removed) | Updates Subscription Price + Coupon Discount checkbox. No customer email. Pings admin. |
| `customer.subscription.deleted` | Sets Status = CANCELLED. Pings admin. |

Other Stripe events are logged and ignored.

## Sheet schema (A–P webhook block, Q–S manual, T attribution)

Data rows start at row 2; row 1 is a header row.

| Col | Header | Notes |
|---|---|---|
| A | Email | |
| B | Customer Name | |
| C | TradingView Username | |
| D | Telegram Username | |
| E | Status | `ACTIVE` / `PAYMENT_FAILED` / `CANCELLATION_SCHEDULED` / `CANCELLED` |
| F | Current Plan | |
| G | Latest Action | Cell background: 🟡 yellow for `CANCELLATION_SCHEDULED` / `DOWNGRADE_SCHEDULED`; 🟢 green for `UPGRADED` / `UNDO_CANCELLATION`; white for all others |
| H | Previous Plan | |
| I | Subscription Price | Effective price after any coupon |
| J | Coupon Discount | Checkbox — TRUE if Pepperstone 12.5% discount is active |
| K | Subscription Start | |
| L | Subscription Expiry | |
| M | Subscription Count | |
| N | Failed Payment Count | |
| O | Stripe Subscription ID | |
| P | Telegram User ID | Filled by bot.py |
| Q | Indicator Invited | **Manual (Joseph)** — never written by code |
| R | NOTES | **Manual (Joseph)** — never written by code |
| S | Pepperstone Acc | **Manual (Joseph)** — never written by code |
| T | Referral Source | Partner attribution from checkout `client_reference_id` (e.g. `drwealth`). Written on new subscription; reactivations fill only an empty cell. |

**Latest Action values:** `NEW_SUBSCRIPTION`, `RENEWAL`, `UPGRADED`, `DOWNGRADED`, `PLAN_SWITCH`, `CANCELLATION_SCHEDULED`, `DOWNGRADE_SCHEDULED`, `UNDO_CANCELLATION`, `UNDO_DOWNGRADE`, `REACTIVATED`.

**Column J setup:** format this column as a checkbox in Google Sheets (Format → Number → Checkbox). The webhook writes `TRUE`/`FALSE` as text with `USER_ENTERED` input, which Sheets interprets as a checkbox value.

## Environment variables

Set these in the [Vercel dashboard](https://vercel.com/dashboard) under Settings > Environment Variables.

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (`whsec_...`) — generated when you create the endpoint in Stripe |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key for a Google service account, pasted as a single line. The service account needs Editor access to the spreadsheet. |
| `GOOGLE_SHEET_ID` | The spreadsheet ID from the Google Sheets URL (`https://docs.google.com/spreadsheets/d/{THIS_PART}/edit`) |
| `GOOGLE_SHEET_TAB_NAME` | Tab name within the spreadsheet. Defaults to `Subscribers`. Use a different name when pointing at the test sheet. |
| `GOOGLE_SHEET_LOG_TAB_NAME` | Optional. Tab name for the append-only Status Log (lifecycle event history). Defaults to `Status Log`. The tab must exist with headers in row 1 — the webhook appends but never creates it. |
| `RESEND_API_KEY` | API key from [Resend](https://resend.com) (`re_...`) |
| `FROM_EMAIL` | Sender address for subscriber emails (must be verified in Resend) |
| `BCC_EMAIL` | Optional. BCC every outgoing email here. |
| `TELEGRAM_BOT_TOKEN` | Bot token for admin notifications (`123456:ABC-DEF...`) |
| `ADMIN_CHAT_ID` | Joseph's Telegram chat ID for receiving admin alerts |
| `TELEGRAM_INVITE_HK` | Telegram invite link for the HK Market group |
| `TELEGRAM_INVITE_SG` | Telegram invite link for the SG Market group |
| `TELEGRAM_INVITE_US` | Telegram invite link for the US Market group |
| `TELEGRAM_INVITE_FXMC` | Telegram invite link for the FXMC Market group |
| `UNDO_CANCELLATION_LINK` | **Deprecated / no longer required.** The "Undo Cancellation" button now links to `BILLING_PORTAL_LINK` directly (same URL as the billing portal). Safe to leave unset. |
| `REMINDER_BOT_TOKEN` | Bot token for @RobinHoReminderBot (`api/telegram-reminder.ts` — refresher-session reminder sign-ups) |
| `REMINDER_WEBHOOK_SECRET` | Secret token registered with Telegram via `setWebhook`; the reminder webhook rejects requests without it |

## Stripe webhook setup

1. Go to [Stripe Dashboard > Developers > Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **Add endpoint**
3. Set the endpoint URL to:
   ```
   https://rho-market-navigator.vercel.app/api/stripe-webhook
   ```
4. Under **Events to send**, select all five:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Click **Add endpoint**
6. Copy the **Signing secret** (`whsec_...`) and add it as `STRIPE_WEBHOOK_SECRET` in Vercel

## Price ID mapping

Stripe price IDs are mapped to plan type strings in `lib/plans.ts`. Update `PRICE_TO_PLAN` whenever a price is added or replaced in Stripe.

`lib/plans.ts` also holds `PLAN_PRICE_SGD_QUARTERLY` — used to classify a plan change as UPGRADED / DOWNGRADED / PLAN_SWITCH. Keep this in sync with the live prices.

## Local testing with Stripe CLI

1. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli)

2. Log in:
   ```bash
   stripe login
   ```

3. Create a `.env.local` file with all the env vars above (use test-mode Stripe keys, test sheet ID, and a separate tab name).

4. Start the Vercel dev server:
   ```bash
   npx vercel dev
   ```

5. In a separate terminal, forward Stripe test events to the local server:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe-webhook
   ```
   Copy the webhook signing secret it prints and set it as `STRIPE_WEBHOOK_SECRET` in `.env.local`.

6. Trigger test events:
   ```bash
   stripe trigger checkout.session.completed
   stripe trigger invoice.payment_succeeded
   stripe trigger invoice.payment_failed
   stripe trigger customer.subscription.updated
   stripe trigger customer.subscription.deleted
   ```

## Deploying

Push to main — Vercel auto-deploys from the connected GitHub repo.

```bash
git add -A && git commit -m "Update Stripe webhook" && git push
```

Verify the endpoint is live:
```bash
curl -s -o /dev/null -w "%{http_code}" https://rho-market-navigator.vercel.app/api/stripe-webhook
# Returns 405 (Method Not Allowed) because it only accepts POST
```

## Migration history (Zapier → webhook — complete)

This webhook replaced the old Zapier automations in June 2026. The cutover ran as a shadow phase (Zapier on the old sheet, the webhook writing a test sheet in parallel with customer emails suppressed) and then a full switch: the webhook became the sole automation, the test sheet became the live `Subscribers` sheet, and the Zapier zaps were disabled. **Zapier is fully retired** — there is nothing left to migrate. Kept here only as context for why the code talks about price-ID maps holding both live and test IDs.

If you ever stand the test path back up (e.g. to test a new event), point `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB_NAME` at test-mode values via the local testing flow above, and add a test-mode webhook endpoint in the Stripe dashboard subscribing to the same five events.

## File structure

```
api/
  stripe-webhook.ts    — Vercel serverless function (POST /api/stripe-webhook)
lib/
  sheets.ts            — Google Sheets reads/writes (16-col schema)
  email.ts             — Onboarding, payment-failed, cancellation emails (Resend)
  telegram.ts          — Admin notifications via Telegram Bot API
  plans.ts             — Price-ID mapping, plan prices, display names, invite links
```
