# Annual plan — design

*Date: 2026-10-05. Status: approved in brainstorm, awaiting written-spec review.*

## Why

TradingView bans selling invite-only script access outside its Marketplace from
**1 November 2026**. Access a customer **paid for before that date** is honoured
for the paid period. Every Navigator subscriber today is quarterly, so 154 of 173
renew after 1 Nov. A prepaid annual bought in October moves every taker's paid
period out to October 2027, inside the grace clause, while the Marketplace
question (email to creators@tradingview.com, Paid Space application) plays out.

Non-goals: lifetime plans (rejected — refund exposure if scripts are blocked, and
the Marketplace has no lifetime), changing the quarterly product, closing new
sign-ups (separate decision later in October; a flag is added but left on).

## Offer

"Annual, 2 months free" = **10 × monthly list**, all 8 plans, existing
subscribers and the 5 Oct trial cohort, **10 Oct – 30 Oct 2026 23:59 SGT**.
Quarterly stays as is; annual is an added option. Trials stay on quarterly by
default.

| Plan | Qtr list | Annual list | Annual Pepperstone | Old qtr | Grandfathered annual |
| --- | --- | --- | --- | --- | --- |
| SG | 108 | 360 | 290 | 87 | 290 |
| FXMC / HK / US | 168 | 560 | 490 | 147 | 490 |
| US_HK / US_SG_FXMC / HK_SG_FXMC | 297 | 990 | 890 | 264 | 880 |
| ALL_MARKETS | 417 | 1,390 | 1,290 | 388 | 1,290 (rounded from 1,293.33) |

- Pepperstone annual = annual list minus two new `amount_off`, `forever`
  coupons: **NAV70** (singles) and **NAV100** (combos + All Markets). Promotion
  codes of the same names so payment links can prefill them.
- Grandfathered annuals are **separate price IDs**, reachable only through the
  switch endpoint when the subscriber's current price ID is an old quarterly
  one. Old-price subscribers carry no Pepperstone coupon today and keep none.
- Who is "old price": by current **price ID** (the `PRICE_TO_PLAN` legacy set),
  never by amount — US at 147 exists both as old-list and as new-list-with-NAV21.

## Stripe setup (data, both modes)

Created by a script (`scripts/setup-annual-prices.mts`, dry-run by default) so
test and live match, output pasted into `lib/plans.ts`:

- 8 annual list prices + 8 grandfathered annual prices on the existing plan
  products, `recurring.interval = year`, SGD, nicknamed `Annual` /
  `Annual (grandfathered)`.
- Coupons NAV70 / NAV100 + promotion codes.
- 8 annual **payment links** (live) cloned from the quarterly ones: same custom
  fields (`tradingviewusername`, `telegramusernamewithoutthe`), phone collection,
  hosted confirmation, NAV70/NAV100 prefilled. Deactivated on 31 Oct.
- Customer portal: **unchanged**. Annual prices are NOT added to the portal's
  plan-change list — a portal switch keeps the billing anchor, so the full annual
  charge would land after 1 Nov. On 31 Oct, portal plan changes are switched off.

## Webhook changes (`lib/`)

- `plans.ts`: 32 new price IDs (16 live, 16 test) in `PRICE_TO_PLAN`; new
  lookups `getBillingInterval(priceId): "quarter" | "year"`,
  `annualPriceFor(planType, mode)`, `grandfatheredAnnualFor(oldQuarterlyPriceId)`,
  `isLegacyQuarterlyPrice(priceId)`; NAV70 / NAV100 in `COUPON_CODES`.
  `classifyPlanChange` stays on plan type (unchanged).
- `stripe-translator.ts`: `billingInterval` on `STARTED`, `RENEWED`,
  `TRIAL_CONVERTED`, `PLAN_CHANGED` (read from the item price's `recurring`).
- `subscription-lifecycle.ts`: in the same-plan branch of `PLAN_CHANGED`, an
  interval change quarter→year writes Latest Action **`ANNUAL_SWITCH`**, a
  Status Log row (`ANNUAL_SWITCH`, price, coupon, detail = new expiry), sends
  `sendAnnualSwitchEmail` (amount charged today, new expiry, "nothing else
  changes") and pings Joseph. year→quarter (should not happen in October) logs
  `PRICE_SYNC` as today and pings. Admin pings print `/qtr` or `/yr` from the
  interval.
- `coupon-sync.ts`: `desiredCouponForPlan(planType, interval)` — NAV21/NAV30 on
  quarter, NAV70/NAV100 on year; managed set = all four. Callers pass the
  interval from the action.
- Sheet schema: **unchanged**. Price (col I) and the 12-month expiry (col L)
  identify annual rows; Latest Action records the switch.
- `trial-standardiser.ts`: unchanged (cohort pinning is on `trial_end`, price
  irrelevant).

## Magic link + switch endpoint

- **Token**: `base64url(subId|email|hmacSHA256(subId|email, ANNUAL_LINK_SECRET))`.
  New env `ANNUAL_LINK_SECRET`. Offer close `ANNUAL_OFFER_CLOSES = 2026-10-30
  23:59 SGT` as a code constant checked on every request.
- **Page**: `web/src/pages/annual.astro` — reads `?t=`, calls preview, renders:
  plan, current price/quarter, annual price, amount charged today (Stripe's
  preview number), new expiry; **Confirm** button → switch call; success state
  shows the new expiry; error states: expired offer, already annual, payment
  declined (with a portal link to update the card and "try again"), and a
  generic "message Joseph" with the WhatsApp/Telegram links.
- **Endpoint**: `api/annual-switch.ts`, `GET ?t=` = preview, `POST {t}` =
  switch. Pure decision logic in `lib/annual-switch.ts` (unit-tested with a fake
  Stripe); the API file owns only HTTP + the real Stripe client.
  - Verify token, load subscription (expand discounts, items.price).
  - Guards (in order): offer closed → `offer_closed`; sub not found / email
    mismatch → `invalid`; item price interval already `year` → `already_annual`;
    status not `active`/`trialing` → `ineligible`; `schedule` attached (pending
    downgrade) → `ineligible`; unknown price ID → `ineligible`. Every
    `ineligible` pings Joseph with the reason.
  - Target price: `isLegacyQuarterlyPrice(current)` ? grandfathered annual :
    annual list for the plan. Coupon: NAV21→NAV70, NAV30→NAV100, SK50 and
    anything else carried as is, none stays none.
  - **Active**: `subscriptions.update(sub, { items:[{id, price}],
    billing_cycle_anchor:"now", proration_behavior:"always_invoice",
    payment_behavior:"error_if_incomplete", discounts:[...],
    cancel_at_period_end:false })` with idempotency key `annual:<subId>`.
    A declined card throws → `payment_failed`, nothing changed.
  - **Trialing**: `subscriptions.update(sub, { items:[{id, price}],
    proration_behavior:"none", discounts:[...], cancel_at_period_end:false })`
    — trial end untouched; the annual is collected at trial end.
  - Preview uses `invoices.createPreview` with the same `subscription_details`
    so the page shows Stripe's number.
  - Nothing else in the endpoint: sheet, email, ping all come from the webhook's
    `ANNUAL_SWITCH` path.

## Comms (Joseph sends; scripts only prepare)

- `scripts/annual-offer-send.mts --audience existing|trial --phase offer|reminder|lastcall [--to email] [--apply]`.
  Dry run prints the recipient list and one rendered sample. Reads the sheet:
  existing = `ACTIVE` + `CANCELLATION_SCHEDULED` with a Stripe sub ID (comps
  skipped); trial = `TRIAL_ACTIVE` + `TRIAL_CANCELLATION_SCHEDULED`. Reminders
  skip rows whose subscription is already on a yearly price (checked live in
  Stripe). Per-row: plan, current price, annual price for their tier, magic link.
- Three email variants in `lib/email.ts` (existing offer, trial offer,
  reminder), subscriber editorial rules, from Joseph's name. Joseph owns the
  wording and timing; nothing sends without `--apply`.
- Planned timing (Joseph's call): existing offer 10 Oct, reminders 24 + 29 Oct;
  trial cohort offer 13 Oct, last call 17 Oct (trial ends 18 Oct 23:59 SGT).

## Website

- `web/src/data/plans.ts`: `annualList`, `annualPep`, `annualLink` per plan.
- `PriceToggle.astro`: second toggle **Quarterly / Annual**; annual view shows
  yearly price, struck-through 4-quarter total, "2 months free" badge; button →
  annual link with the promo prefilled the same way as today. The annual
  toggle hides itself client-side once the browser clock passes
  `ANNUAL_OFFER_CLOSES` (same constant value as the API's, duplicated in the site
  data), so it disappears on 31 Oct without a redeploy; the 31 Oct checklist
  still confirms it.
- Trial guide: one callout under the price callout about the annual option.
- `SIGNUPS_OPEN` flag in the site data (default true) that, when false, replaces
  every checkout button with a closed notice. Not flipped in this work.

## Testing gate (in order)

1. Unit: lifecycle (`ANNUAL_SWITCH`), coupon-sync interval rule, plans lookups,
   `annual-switch` decision logic with a fake Stripe, token sign/verify,
   email variants render. `npm test` + `npx tsc --noEmit` green on every task.
2. Stripe **test mode** end to end: one trialing and one active mid-quarter
   test subscription through the real page + endpoint (`vercel dev` + `stripe
   listen`), webhook writes checked on the test sheet, invoice amounts checked.
3. Website build + deploy, toggle checked on the live site.
4. **Live run on Joseph's own test subscription** (`sub_1TysDTPApeZiCPK2tGRYpt2n`)
   before any email goes out.

## Rollout / closing

- Build starts 5 Oct, in this order: Stripe setup → plans/webhook → endpoint +
  page → website toggle → emails/script → test-mode E2E → deploy → live run.
- 31 Oct: deactivate annual payment links, turn off portal plan changes,
  confirm the toggle and endpoint have closed themselves.
- After 18 Oct: trial guide goes back to a rolling link or a closed notice
  (depends on whether any trial runs after 20 Oct).
