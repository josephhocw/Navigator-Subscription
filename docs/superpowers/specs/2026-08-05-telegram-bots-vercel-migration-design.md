# Telegram Access Bots → Vercel Migration — Design

**Date:** 2026-08-05
**Status:** Approved by Joseph (design discussion 2026-08-05)
**Scope:** Migrate `bot.py` (join guard) and `scheduler.py` (daily kicker) from the ForexVPS Python processes into this repo's Vercel serverless functions, add instant plan-change group removal, and retire the VPS bots.

## Why

1. **Kills the #1 documented breakage risk.** Plan strings are duplicated between `lib/plans.ts` (TypeScript) and the bot repo's `config.py` (Python), synced by hand. After this migration there is one `plans.ts` and zero drift surface. The "Config duplicated from the bot repo" section of `CLAUDE.md` is deleted at the end of this project.
2. **Removes the VPS as a silent failure point.** The bots are long-lived polling processes on a free Pepperstone ForexVPS; if the process dies, joins go unguarded and nothing pings Joseph.
3. **Closes the plan-change gap.** Today nothing removes a subscriber from Telegram groups on a downgrade or market switch — `scheduler.py` only processes `CANCELLED` rows, and `lib/telegram-groups.ts` only fires on `ENDED`. A downgrader keeps old signal groups forever unless removed by hand (found live 2026-08-05: Eileen Ching kept HK access after moving to US+FXMC).
4. **Real-time is preserved.** Telegram webhook mode (`setWebhook`) pushes updates to a Vercel function within seconds — as fast as or faster than the current polling.

## What already exists (do not rebuild)

- `lib/telegram-groups.ts` (+ `telegram-groups.test.ts`): instant group removal on `ENDED`, a TS port of `access.py`'s entitlement logic, with whitelist, identity-mismatch guard (col D vs col P), ban+unban kick, outstanding-ban alerting, Status Log `TELEGRAM_REMOVED` rows, and the fail-safe `TELEGRAM_KICK_DRY_RUN` flag (only the literal `false` goes live).
- The lifecycle's `TelegramGroupRemover` seam, injected in `api/stripe-webhook.ts` via `buildTelegramGroupRemover()`.
- Env config: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_*` (5 group chat IDs), `TELEGRAM_KICK_WHITELIST`.

## Decisions (locked with Joseph, 2026-08-05)

| Decision | Choice |
| :--- | :--- |
| Test depth | Staging rig (test bot + throwaway groups + sheet copy) **plus** ~1-week prod shadow/dry-run soak before going live |
| Kick scope | Plan changes trigger instant removal too, not just cancellations; daily sweep extended to catch plan-mismatch drift |
| End state | VPS bots fully retired; `Navigator_Telegram_Bot` repo kept on GitHub as a runnable archive / emergency fallback |
| Code location | Everything in this repo (`Navigator-Subscription`), same Vercel project. A separate bot project was rejected (recreates the plan-mapping duplication); a managed container for the Python bots was rejected (keeps both problems). |

## Components

### 1. `lib/telegram-access.ts` — join-decision logic (pure)

TypeScript port of the bot repo's `access.py`, structured the same way so `test_access.py` cases port 1:1:

- **Market groups:** joiner has no username → kick; username in whitelist → allow; otherwise look up **all** sheet rows for that username and allow if any non-`CANCELLED` row's plan covers the group's market (`ACTIVE`, `CANCELLATION_SCHEDULED`, `PAYMENT_FAILED` all remain entitled). Not found / all cancelled / wrong plan → kick.
- **Main group (lenient):** anyone may join, including guests with no sheet row and joiners with no username; kick only if the joiner's sheet rows are ALL `CANCELLED`. Plan strings irrelevant.
- Plan→market resolution reuses `parsePlanType()` from `plans.ts` (SG appended to combos, etc.). **Unknown-plan handling follows `telegram-groups.ts`, not `access.py`:** an unrecognised plan string on a live row fails safe (allow + ping) rather than granting nothing and kicking a paying subscriber over a typo.
- Pure functions, no I/O. All decisions return a structured verdict (allow/kick + reason) so the webhook can log and dry-run them.

### 2. `api/telegram-webhook.ts` — the join guard endpoint

- Registered with Telegram via `setWebhook`, receiving `chat_member` updates for the 5 groups.
- **Auth:** `setWebhook` is called with a `secret_token` (new env `TELEGRAM_WEBHOOK_SECRET`); the handler rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match.
- On a join event: evaluate via `lib/telegram-access.ts` → kick (ban + unban, reusing the kick machinery), or allow and write the joiner's Telegram User ID to **col P of every non-`CANCELLED` row** for that username (re-reading the sheet immediately before write to minimise webhook-vs-webhook races; the write is idempotent).
- Non-join `chat_member` transitions (leaves, promotions) are logged and ignored, mirroring bot.py.
- **Fail open:** if the sheet read fails, allow the join, ping Joseph, and let the daily sweep correct later. Never kick on infrastructure error.
- Respond 200 quickly in all cases (Telegram retries non-2xx; we never want replayed joins).
- **Dry-run flag `TELEGRAM_JOIN_DRY_RUN`**, same fail-safe semantics as `TELEGRAM_KICK_DRY_RUN`: only literal `false` (trimmed, case-insensitive) enforces; anything else logs the verdict, writes nothing, kicks nobody. Col-P writes are also suppressed in dry-run (the Python bot still owns col P until cutover).
- Every verdict (allow, kick, dry-run intention, fail-open) writes a console line; kicks and fail-opens also ping.

### 3. `api/telegram-sweep.ts` — daily reconcile cron (replaces `scheduler.py`)

- Cron `0 4 * * *` UTC (= 12:00pm SGT; Hobby-plan imprecision of up to ~1h is acceptable for a backstop).
- **Extended beyond `scheduler.py`:** instead of only `CANCELLED` rows, it computes each known member's union of entitlements across all their rows and removes them from every group not covered — so it self-heals plan-change drift, missed webhook events, and hand-edits, exactly like the 3am TradingView reconcile. Only rows with a col-P User ID are actionable; guests with no sheet row are never touched (the sweep only ever acts on people the sheet knows).
- Reuses the `telegram-groups.ts` safety machinery: whitelist, identity-mismatch guard, ban+unban with `only_if_banned` unban, outstanding-ban alerts, Status Log rows.
- **Inherits comp expiry interplay:** `comp-expiry.ts` flips expired comps to `CANCELLED` during the 3am reconcile; this sweep must then remove those people from groups their remaining rows don't cover (explicit staging test required).
- **Duration-safe:** ~200 rows × 5 groups of `getChatMember` checks can brush Vercel's function time limit. The sweep processes in bounded batches within a single invocation, checks elapsed time, and if it must stop early, pings with a "partial sweep" summary (next day's run continues; the sweep is idempotent). Verify the project's max duration setting during implementation.
- **Dry-run flag `TELEGRAM_SWEEP_DRY_RUN`**, same fail-safe semantics. In dry-run it logs and pings intended kicks only.
- One admin ping per run summarising kicks/skips/failures (quiet when nothing to do), mirroring the reconcile ping style.

### 4. Instant plan-change kicks (lifecycle change)

- `PLAN_CHANGED` (including the downgrade-executed-at-renewal path where `RENEWED` applies the plan change) calls the existing `TelegramGroupRemover` for groups the **new** plan no longer covers, using the same union-of-rows entitlement calculation (a second live subscription keeps its groups).
- `ENDED` behaviour is unchanged (already built).
- `DOWNGRADE_SCHEDULED` and `CANCELLATION_SCHEDULED` do **not** kick — access lasts until the paid period ends.
- Covered by `TELEGRAM_KICK_DRY_RUN` (the existing flag), since it rides the existing remover.

### 5. Retirement

- After the post-cutover watch period (2–4 weeks of clean pings): stop tracking the bot repo as active, mark it archived on GitHub with a README pointer to this repo, remove the bots' auto-start from the VPS, and delete the "Config duplicated from the bot repo" section plus `TELEGRAM_CHAT_*`/whitelist duplication notes from `CLAUDE.md`. Update `../CLAUDE.md` (workstation) and `../MEMORY.md` accordingly.

## Testing strategy

### Layer 1 — unit (vitest, no network)

- Port every `test_access.py` scenario to tests for `lib/telegram-access.ts`; add cases for the unknown-plan fail-safe divergence.
- Webhook translator tests: raw Telegram `chat_member` update JSON → join event (including the non-join transitions that must be ignored).
- Sweep tests with in-memory fakes: CANCELLED kick, plan-drift kick, comp-expiry follow-through, multi-row union, whitelist, no-User-ID skip, batch/early-stop behaviour.
- Lifecycle tests for the `PLAN_CHANGED` kick (extend `subscription-lifecycle.test.ts`).

### Layer 2 — staging rig (end-to-end, isolated)

- New **test bot** (fresh token from BotFather) + **2 throwaway private groups** (one configured as a market group, one as main) + a **copy of the live sheet** (shared with the service account).
- A **second Vercel project** deploying this same repo with test env values (test bot token, test group chat IDs, test sheet ID, dry-run flags off — it's all fake data).
- Walk the full matrix with real Telegram accounts: entitled join, wrong-plan join, no-username join, guest join to main, cancelled-subscriber join, col-P write verification, sweep kick, comp-expiry sweep, plan-change instant kick (fired via Stripe test-mode payment links / test clock events).

### Layer 3 — prod shadow soak (~1 week, zero enforcement risk)

- **Join guard shadow:** add the *test* bot as an admin to the *real* 5 groups. Telegram delivers `chat_member` updates to each admin bot independently, so the shadow receives every real join with no token conflict while `bot.py` keeps enforcing. The staging deployment (test token + **real** group IDs + **real** sheet + dry-run on) logs every would-be verdict. Diff daily against what `bot.py` actually did.
- **Sweep shadow:** the prod cron runs in `TELEGRAM_SWEEP_DRY_RUN`, logging intended kicks; compare with `scheduler.py`'s noon actions. Expected difference: the sweep also flags plan-drift cases the Python bot ignores — each one gets manually verified as correct.
- **Plan-change kicks:** dry-run pings on real Stripe events; verify each intention by hand.
- Exit criteria: one full week with zero incorrect verdicts (missing kicks, extra kicks, wrong group). Any divergence → fix → restart the week.

## Zero-downtime cutover

1. Soak passed → set `TELEGRAM_JOIN_DRY_RUN=false`, `TELEGRAM_SWEEP_DRY_RUN=false` (and confirm `TELEGRAM_KICK_DRY_RUN=false`) in prod Vercel env; redeploy.
2. Call `setWebhook` on the **production** bot token → `https://<prod-domain>/api/telegram-webhook`, with `secret_token` and **`allowed_updates: ["chat_member"]`** (without the explicit list Telegram silently withholds join events — the classic trap). The moment this succeeds, join events flow to Vercel; `bot.py`'s `getUpdates` starts failing with 409. **Enforcement transfers atomically — there is no unguarded window.**
3. On the VPS: stop `bot.py` and `scheduler.py`, disable their auto-start.
4. Remove the shadow test bot from the real groups; tear down the staging Vercel project (or keep it dormant for future staging).
5. Watch pings and Status Log for 2–4 weeks, then execute Retirement (above).

**Rollback (any time, <5 minutes):** `deleteWebhook` on the prod token, restart `bot.py` + `scheduler.py` on the VPS, flip the dry-run flags back on. This is why the bot repo stays runnable.

## Risks & mitigations

| Risk | Mitigation |
| :--- | :--- |
| Vercel Hobby cron quota (adding a 4th daily cron) / timing imprecision | Verify quota during implementation; noon sweep is a backstop so ±1h is fine. If quota blocks, fold the sweep into the 3am reconcile run. |
| Sweep exceeds function max duration | Bounded batches + elapsed-time check + partial-sweep ping; idempotent across days. |
| Concurrent sheet writes (join webhook vs Stripe webhook) | Col-P writes idempotent; re-read before write; volume is low. |
| `allowed_updates` misconfiguration silently drops join events | Explicit in the cutover runbook; staging rig proves the exact `setWebhook` call first. |
| Webhook endpoint spoofing | `secret_token` header check; requests without it are 403'd and logged. |
| Sheet outage during a join | Fail open (allow + ping); sweep corrects within a day. |
| Shadow bot's verdicts diverge from bot.py | That's the soak's job — divergence blocks cutover until explained/fixed. |

## Out of scope

- The website's existing admin pings, TradingView automation, email flows — untouched.
- Any change to group structure, whitelist membership, or the lenient main-group policy — behaviour parity except where explicitly extended (plan-change kicks, drift-healing sweep, unknown-plan fail-safe).
- The voucher bot (`@TV_Premium_Tracker_Bot`) and the Claude relay bot — different bots, unaffected.
