# Telegram Bots → Vercel Migration: Staging, Shadow Soak & Cutover Runbook

**Plan:** `docs/superpowers/plans/2026-08-05-telegram-bots-vercel-migration.md` · **Design:** `docs/superpowers/specs/2026-08-05-telegram-bots-vercel-migration-design.md`

This runbook covers the manual phases of the migration (plan Tasks 10–12): standing up the staging rig, walking the E2E matrix, running the ~1-week production shadow soak, the atomic cutover, and the <5-minute rollback. Execute the sections **in order** — each phase gates the next.

Placeholders like `<TEST_TOKEN>` are secrets and live values filled in at execution time. Never commit real values into this file.

> **Deploy-time checks (verify on the first prod deploy carrying this work, before relying on anything below):**
>
> - [x] The Vercel plan accepted the **4th daily cron** (`/api/telegram-sweep`, `0 4 * * *` in `vercel.json`) — **verified 2026-08-07 via `vercel crons ls`: all four crons scheduled on the prod `navigator` project.**
> - [ ] The `functions` maxDuration entries took effect — `api/telegram-webhook.ts` shows **60s** and `api/telegram-sweep.ts` shows **300s** in the deployment's function settings.
> - [x] `TELEGRAM_KICK_WHITELIST` is **non-empty** in prod — **set 2026-08-07** (see prod-env note below).
> - [x] **Record the current prod value of `TELEGRAM_KICK_DRY_RUN` here before deploying: `UNSET (= dry-run) — confirmed by Joseph 2026-08-05`.** So ENDED kicks have been report-only in prod, and the whole deploy ships dormant with nothing to decide. Rollback (section E) restores "unset", which matches "flags back on" there. The new plan-change kicks ride this SAME flag. If it is `false` (ENDED kicks already live), this deploy makes plan-change kicks live enforcement immediately — un-soaked. Decide deliberately: leave it live and accept that, or set it to dry for the soak (which also pauses live ENDED instant kicks; scheduler.py still backstops full cancellations until cutover). Rollback (section E) must restore the value recorded here, NOT blindly unset it.
> **Prod-env note (2026-08-07):** prod had NONE of `TELEGRAM_CHAT_*` / `TELEGRAM_KICK_WHITELIST` configured — the instant ENDED removal had been running as the Noop remover (not even dry-run pings), and the new noon sweep cron was hitting its "not configured — skipped" branch. Fixed via CLI: all five `TELEGRAM_CHAT_*` IDs + the whitelist (values from the bot repo's `config.py`) added to prod Production env, then redeployed (same commit, alias confirmed). All three dry-run flags remain UNSET = report-only, so from the next noon SGT run the prod sweep emits real dry-run pings (soak stream b) and ENDED events produce dry-run removal pings + `TELEGRAM_REMOVED` Status Log rows. Also: `CRON_SECRET` was REMOVED from the `navigator-telegram-staging` project — the shared `vercel.json` crons fire there too, and with `STRIPE_*`/`RESEND_*` deliberately absent the nightly `standardise-trial-ends` was failure-pinging the test bot ("Neither apiKey nor config.authenticator provided"). Without `CRON_SECRET`, staging crons 401 quietly; the join webhook doesn't use it. Re-add a fresh `CRON_SECRET` only if a staging sweep must ever be triggered by hand again.
>
> - [ ] **Update the VPS bots before starting the soak.** The VPS copy predates the trial statuses: it kicks on `CANCELLED` only, while the new sweep also bars `TRIAL_CANCELLED`. Un-updated, every `TRIAL_CANCELLED` member produces a guaranteed soak divergence and pollutes the "zero unexplained divergence" exit criterion. `git pull` + restart `bot.py`/`scheduler.py` on the ForexVPS first.

---

## A. Staging rig setup (one-time, with Joseph)

1. **BotFather: create the test bot.** `/newbot` in [@BotFather](https://t.me/BotFather), e.g. `@RhoNavStagingBot`. Save the token as `<TEST_TOKEN>`. **Then open a DM with the new bot and send `/start` once** — Telegram bots cannot message a user who never initiated a chat, and all `notifyAdmin` failures are swallowed by design, so without this every staging ping silently vanishes and phase B reports phantom "missing ping" failures.
2. **Create 2 private test groups** (one plays a market group, one plays the main group); add the test bot as **admin with ban rights** to both.
3. **Get each group's chat ID:** with the bot added, post a message in the group, then:
   ```bash
   curl -s "https://api.telegram.org/bot<TEST_TOKEN>/getUpdates"
   ```
   and read `chat.id` from the response (a `-100...` number). Alternatively forward a message from the group to `@userinfobot`.
4. **Copy the live sheet** (File → Make a copy) and share the copy with `telegram-bot-service@telegram-bot-manager-474609.iam.gserviceaccount.com` as **Editor**.
5. **Create a second Vercel project** (e.g. `navigator-telegram-staging`) from the same GitHub repo. Env vars:

   | Var | Staging value |
   | :-- | :-- |
   | `TELEGRAM_BOT_TOKEN` | `<TEST_TOKEN>` |
   | `TELEGRAM_CHAT_US` | test group 1 chat ID |
   | `TELEGRAM_CHAT_MAIN` | test group 2 chat ID |
   | `TELEGRAM_CHAT_HK` / `TELEGRAM_CHAT_SG` / `TELEGRAM_CHAT_FXMC` | **unset** — `loadGroupsFromEnv` drops them |
   | `TELEGRAM_WEBHOOK_SECRET` | fresh random string (`openssl rand -hex 32`) = `<STAGING_WEBHOOK_SECRET>` |
   | `TELEGRAM_JOIN_DRY_RUN` | `false` |
   | `TELEGRAM_SWEEP_DRY_RUN` | `false` |
   | `TELEGRAM_KICK_DRY_RUN` | `false` |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | same service-account key |
   | `GOOGLE_SHEET_ID` | the **COPY**'s ID |
   | `TELEGRAM_KICK_WHITELIST` | same as prod |
   | `ADMIN_CHAT_ID` | Joseph's chat ID |
   | `CRON_SECRET` | fresh random string for staging |

   **Deliberately absent:** `STRIPE_*`, `RESEND_*`, `TRADINGVIEW_*` — staging must not email anyone or touch TradingView.
6. **Register the staging webhook:**
   ```bash
   curl -s "https://api.telegram.org/bot<TEST_TOKEN>/setWebhook" \
     --data-urlencode "url=https://<staging-domain>/api/telegram-webhook" \
     --data-urlencode "secret_token=<STAGING_WEBHOOK_SECRET>" \
     --data-urlencode 'allowed_updates=["chat_member"]'
   curl -s "https://api.telegram.org/bot<TEST_TOKEN>/getWebhookInfo"
   ```
   Verify `getWebhookInfo` shows the URL and `allowed_updates: ["chat_member"]` — without the explicit list Telegram silently withholds join events.

> **✅ PHASE B EXECUTED 2026-08-06 — ALL PASS (11/11).** Staging rig: bot `8770545037` ("Staging 1" `-1003973708249` as US market, "Staging 2" `-1003945662464` as main), sheet copy `1hgOJLiS1tMa-AqlCdX9buT2sgDOSnD1_JokOeqjYXdw`, project `navigator-telegram-staging` (`navigator-telegram-staging.vercel.app`). Test account @kxjiuhao (User ID 198695486). Verified: not-found kick · TRIAL_ACTIVE allow + col-P write · wrong-plan kick · TRIAL_CANCELLED kick (market) · cancelled kick (main) · guest allow (main) · unrecognised-plan fail-safe allow + ping · sweep removed a cancelled member from both groups with 124 real rows untouched · sweep healed plan drift (market removed, main kept) · comp row protected access · duplicate-col-P guard skipped both and reported. Webhook auth verified (403 no-secret / 200 with). Deliberately skipped as unit-covered: no-username join, whitelist join, instant plan-change kicks (prod dry-run soak validates those on real events).

## B. Staging E2E matrix

Execute with real Telegram accounts. Stage each case by hand-editing rows in the **sheet copy**, then have the account join the relevant test group. After each case verify: the kick happened (or didn't), col P was written (or wasn't), and the expected pings arrived. Record the result against each box; fix any failure and re-run the whole matrix before moving to phase C.

- [ ] Entitled join to market group → allowed, col P written to **all** live rows for that username
- [ ] Wrong-plan join to market group → kicked + ping
- [ ] Unknown user (no sheet row) joins market group → kicked + ping
- [ ] All-rows-CANCELLED user joins market group → kicked + ping
- [ ] No-username account joins market group → kicked; same account joins main group → allowed
- [ ] Guest (no sheet row) joins main group → allowed, no writes
- [ ] Whitelisted user joins → allowed, no sheet lookup side effects
- [ ] Unrecognised-plan row (put `BANANA` in col F) joins → allowed + warning ping
- [ ] Sweep — trigger by hand:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" https://<staging-domain>/api/telegram-sweep
  ```
  - [ ] CANCELLED row with a col-P ID → kicked from both test groups
  - [ ] ACTIVE row whose plan lost a market (edit col F by hand) → kicked from that market group only
  - [ ] Comp-style row (blank col O, future date in col L) → kept
- [ ] Plan-change instant kick — **not testable in staging by design** (needs Stripe test mode, which staging deliberately lacks). Covered by the lifecycle unit tests (plan Task 7) and the prod dry-run soak (phase C). Do not wire Stripe into staging for this.

## C. Prod shadow soak (~1 week)

1. **Add the test bot as admin to the 5 REAL groups.** It must be admin to receive `chat_member` updates; Telegram delivers updates to each admin bot independently, so the shadow sees every real join with no token conflict while `bot.py` keeps enforcing. Dry-run means it never acts.
2. **Repoint the staging project's env:** `TELEGRAM_CHAT_US/HK/SG/FXMC/MAIN` = the 5 real group IDs, `GOOGLE_SHEET_ID` = the **live** sheet, `TELEGRAM_JOIN_DRY_RUN` = `true`, `TELEGRAM_SWEEP_DRY_RUN` = `true`. Redeploy staging, then re-run the section-A `setWebhook` call (same `<TEST_TOKEN>`, same staging URL).
3. **Prod project** (this repo's main Vercel project): deploy everything — **Joseph runs `/push-website`**; this is his step, not the agent's. Leave `TELEGRAM_SWEEP_DRY_RUN` **unset** (= dry-run by default, fail-safe) so the noon cron logs intentions only. `TELEGRAM_JOIN_DRY_RUN` is irrelevant on prod until cutover — no webhook is registered on the prod token yet. Confirm the existing `TELEGRAM_KICK_DRY_RUN` state with Joseph — if ENDED kicks are already live, leave them live.
4. **Daily during the soak, diff three streams:**
   - (a) staging's join-guard pings/logs vs what `bot.py` actually did (VPS console/log);
   - (b) the prod sweep's dry-run ping vs `scheduler.py`'s noon actions;
   - (c) any plan-change dry-run pings vs reality.

   Expected legitimate difference: the sweep flags plan-drift cases `scheduler.py` ignores — verify each one by hand and log it with its explanation. Any **unexplained** divergence → fix → restart the week.
5. **Exit criteria:** one full clean week — zero unexplained divergence (no missing kicks, no extra kicks, no wrong group).

## D. Cutover (after the soak passes)

1. **Prod Vercel env:** `TELEGRAM_JOIN_DRY_RUN` = `false`, `TELEGRAM_SWEEP_DRY_RUN` = `false`, `TELEGRAM_KICK_DRY_RUN` = `false`, `TELEGRAM_WEBHOOK_SECRET` = fresh random string (`openssl rand -hex 32`) = `<PROD_WEBHOOK_SECRET>`. Redeploy.
2. **Register the PROD webhook.** This instantly breaks `bot.py`'s polling (its `getUpdates` starts returning 409) — that is the design: enforcement transfers atomically, with no unguarded window.
   ```bash
   curl -s "https://api.telegram.org/bot<PROD_TOKEN>/setWebhook" \
     --data-urlencode "url=https://rho-market-navigator.vercel.app/api/telegram-webhook" \
     --data-urlencode "secret_token=<PROD_WEBHOOK_SECRET>" \
     --data-urlencode 'allowed_updates=["chat_member"]'
   curl -s "https://api.telegram.org/bot<PROD_TOKEN>/getWebhookInfo"
   ```
   Verify `getWebhookInfo` shows the prod URL and `allowed_updates: ["chat_member"]`.
3. **On the VPS** (Elaine's ForexVPS — access details in `About Me/vps-accounts.md`): stop `bot.py` and `scheduler.py`, and **disable their auto-start** (check Task Scheduler / startup scripts) so a reboot can't resurrect them.
4. **Verification join:** join a real group with a test account → verify the webhook log line in Vercel and the expected verdict (kick or allow + col-P write).
5. **Shadow teardown:** remove the shadow test bot from the 5 real groups. Keep the staging Vercel project dormant for future staging, or delete it.

Watch pings and the Status Log closely for the first 48h, then for 2–4 clean weeks before executing the retirement steps (plan Task 12).

## E. Rollback (any time, <5 min)

```bash
curl -s "https://api.telegram.org/bot<PROD_TOKEN>/deleteWebhook"
```

Then restart `bot.py` + `scheduler.py` on the VPS and set the three dry-run flags (`TELEGRAM_JOIN_DRY_RUN` / `TELEGRAM_SWEEP_DRY_RUN` / `TELEGRAM_KICK_DRY_RUN`) back to unset. Polling resumes; everything is as before. This is why the bot repo stays runnable until retirement is final.
