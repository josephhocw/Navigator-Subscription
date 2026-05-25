# Stripe Webhook — RHO Market Navigator

Serverless function that replaces the Zapier automation for handling Stripe subscription events.

## What it does

| Event | Actions |
|-------|---------|
| `checkout.session.completed` | Appends new row OR updates existing row (returning subscriber match by email). Sends onboarding email. Pings admin Telegram. |
| `invoice.payment_succeeded` (`subscription_cycle` only) | Updates start, expiry, last payment date. Sets Latest Action = RENEWAL. Increments Subscription Count. Resets Failed Payment Count. Pings admin. |
| `invoice.payment_failed` | Increments Failed Payment Count. Emails subscriber to update card. Pings admin. |
| `customer.subscription.updated` (plan change) | Updates Plan Type + Previous Plan Type. Sets Latest Action = UPGRADED / DOWNGRADED / PLAN_SWITCH based on price comparison. Pings admin. |
| `customer.subscription.updated` (`cancel_at_period_end` → true) | Sets Latest Action = CANCELLED (Status stays ACTIVE until period ends). Emails subscriber cancellation confirmation with Undo Cancellation button. Pings admin. |
| `customer.subscription.updated` (status → past_due) | Pings admin only. |
| `customer.subscription.deleted` | Sets Status = CANCELLED. Pings admin. |

Other Stripe events are logged and ignored.

## Sheet schema (16 columns, A–P)

Data rows start at row 2; row 1 is a header row.

| Col | Field |
|---|---|
| A | Email |
| B | Customer Name |
| C | TradingView Username |
| D | Telegram Username |
| E | Telegram User ID (filled by bot.py) |
| F | Plan Type |
| G | Subscription Price |
| H | Previous Plan Type |
| I | Subscription Start |
| J | Subscription Expiry |
| K | Status (ACTIVE / CANCELLED) |
| L | Latest Action |
| M | Subscription Count |
| N | Failed Payment Count |
| O | Stripe Subscription ID |

**Latest Action values:** `NEW_SUBSCRIPTION`, `RENEWAL`, `UPGRADED`, `DOWNGRADED`, `PLAN_SWITCH`, `CANCELLED`, `REACTIVATED`.

## Environment variables

Set these in the [Vercel dashboard](https://vercel.com/dashboard) under Settings > Environment Variables.

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (`whsec_...`) — generated when you create the endpoint in Stripe |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key for a Google service account, pasted as a single line. The service account needs Editor access to the spreadsheet. |
| `GOOGLE_SHEET_ID` | The spreadsheet ID from the Google Sheets URL (`https://docs.google.com/spreadsheets/d/{THIS_PART}/edit`) |
| `GOOGLE_SHEET_TAB_NAME` | Tab name within the spreadsheet. Defaults to `Subscribers`. Use a different name when pointing at the test sheet. |
| `RESEND_API_KEY` | API key from [Resend](https://resend.com) (`re_...`) |
| `FROM_EMAIL` | Sender address for subscriber emails (must be verified in Resend) |
| `BCC_EMAIL` | Optional. BCC every outgoing email here. |
| `TELEGRAM_BOT_TOKEN` | Bot token for admin notifications (`123456:ABC-DEF...`) |
| `ADMIN_CHAT_ID` | Joseph's Telegram chat ID for receiving admin alerts |
| `TELEGRAM_INVITE_HK` | Telegram invite link for the HK Market group |
| `TELEGRAM_INVITE_SG` | Telegram invite link for the SG Market group |
| `TELEGRAM_INVITE_US` | Telegram invite link for the US Market group |
| `TELEGRAM_INVITE_FXMC` | Telegram invite link for the FXMC Market group |
| `UNDO_CANCELLATION_LINK` | Placeholder URL for the "Undo Cancellation" button in the cancellation email. Replace with the real reactivation URL when ready. |

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

## Parallel-run plan (migrating from Zapier)

Zapier stays running on the live Stripe account during testing. The new webhook only hits a test sheet, so the live sheet (which bot.py and scheduler.py read) is untouched.

### Step 1 — Build out the test sheet
1. Create a new spreadsheet (or new tab) using the 16-column schema above. Row 1 = headers, data starts at row 2.
2. Note its sheet ID and tab name.

### Step 2 — Vercel env vars (test mode)
1. `STRIPE_SECRET_KEY` = test key (`sk_test_...`)
2. `STRIPE_WEBHOOK_SECRET` = signing secret from the **test mode** webhook endpoint
3. `GOOGLE_SHEET_ID` = test spreadsheet ID
4. `GOOGLE_SHEET_TAB_NAME` = test tab name
5. All other vars (Resend, Telegram, market invites) can stay the same.

### Step 3 — Create the test-mode webhook endpoint
1. Switch the Stripe dashboard to **test mode**
2. Add a webhook endpoint pointing to the deployed Vercel URL, subscribing to the five events listed above
3. Paste the new signing secret into `STRIPE_WEBHOOK_SECRET` in Vercel

### Step 4 — Run through every flow in test mode
1. Create a test subscription via Stripe Checkout — verify row appears, onboarding email arrives, Telegram ping fires.
2. Modify the test subscription's plan — verify Plan Type and Previous Plan Type update, Latest Action is correct, Telegram ping fires.
3. Cancel the test subscription via the customer portal — verify Latest Action = CANCELLED, cancellation email arrives, Telegram ping fires.
4. Wait for (or fast-forward) the period end — verify Status flips to CANCELLED on `customer.subscription.deleted`.
5. Trigger a failed payment with Stripe's `4000000000000341` test card — verify Failed Payment Count increments, payment-failed email arrives, Telegram ping fires.
6. Force a renewal cycle — verify dates roll, Renewal Count increments, Latest Action = RENEWAL.

### Step 5 — Cut over to live
1. In **live mode** Stripe dashboard, add a webhook endpoint to the same Vercel URL subscribing to the same five events. Copy the signing secret.
2. Update Vercel env vars:
   - `STRIPE_SECRET_KEY` → live key
   - `STRIPE_WEBHOOK_SECRET` → live signing secret
   - `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB_NAME` → real subscriber sheet (must match the 16-column schema — migrate first if it still uses the old layout)
3. Disable the Zapier zaps.
4. Watch the first real subscription flow through end to end.

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
