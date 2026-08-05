// =============================================================================
// TELEGRAM DAILY SWEEP
// =============================================================================
// Replaces scheduler.py, extended: instead of only CANCELLED rows, every
// distinct username with a col-P User ID has their group memberships checked
// against the union of their live rows' entitlements — so plan-change drift,
// missed webhook events and hand-edits self-heal daily, exactly like the 3am
// TradingView reconcile. Guests with no sheet row are untouchable by
// construction (the remover only acts on the person it is handed).
//
// All safety machinery (whitelist, unrecognised-plan fail-safe, identity
// mismatch, ban+unban) lives in the remover — this file only enumerates and
// aggregates.
// =============================================================================

import { normaliseTelegramUsername, type TelegramGroupRemover } from "./telegram-groups.js";
import type { Subscriber } from "./subscriber-store.js";

export interface SweepDeps {
  listAll(): Promise<Subscriber[]>;
  /** A TelegramGroupApi built with the TELEGRAM_SWEEP_DRY_RUN flag. */
  remover: TelegramGroupRemover;
  notify(message: string): Promise<void>;
  recordLog(entry: {
    email: string;
    stripeSubscriptionId: string;
    action: string;
    plan?: string;
    detail?: string;
  }): Promise<void>;
  /** Stop starting new users once this much time has passed. Vercel functions
   *  have a hard max duration; a partial sweep today finishes tomorrow. */
  timeBudgetMs?: number;
  now?: () => number;
}

export interface SweepSummary {
  usersChecked: number;
  removed: Array<{ username: string; groups: string[] }>;
  unrecognised: string[];
  mismatches: string[];
  failures: string[];
  stillBanned: string[];
  partial: boolean;
  dryRun: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runTelegramSweep(deps: SweepDeps): Promise<SweepSummary> {
  const now = deps.now ?? Date.now;
  const budget = deps.timeBudgetMs ?? 240_000;
  const started = now();

  const all = await deps.listAll();

  // Distinct usernames; for each, the first row carrying a col-P User ID.
  // No ID anywhere → the person never joined through the guard → nothing to
  // kick (mirrors scheduler.py skipping blank col P).
  const candidates = new Map<string, Subscriber>();
  for (const r of all) {
    const u = normaliseTelegramUsername(r.telegramUsername);
    if (!u || candidates.has(u)) continue;
    const withId = all.find(
      (x) =>
        normaliseTelegramUsername(x.telegramUsername) === u &&
        x.telegramUserId?.trim() !== ""
    );
    if (withId) candidates.set(u, withId);
  }

  const summary: SweepSummary = {
    usersChecked: 0,
    removed: [],
    unrecognised: [],
    mismatches: [],
    failures: [],
    stillBanned: [],
    partial: false,
    dryRun: false,
  };

  for (const [username, subject] of candidates) {
    if (now() - started > budget) {
      summary.partial = true;
      break;
    }
    summary.usersChecked++;

    try {
      const result = await deps.remover.removeFromGroups({
        telegramUserId: subject.telegramUserId.trim(),
        telegramUsername: subject.telegramUsername,
        allSubscribers: all,
      });
      summary.dryRun = result.dryRun;

      if (result.reason === "unrecognised-plan") summary.unrecognised.push(username);
      if (result.removed.length) summary.removed.push({ username, groups: result.removed });
      summary.failures.push(...result.failures.map((f) => `${username} — ${f}`));
      summary.mismatches.push(
        ...(result.identityMismatches ?? []).map((m) => `${username} — ${m}`)
      );
      summary.stillBanned.push(
        ...(result.outstandingBans ?? []).map((g) => `${username} — ${g}`)
      );

      // Durable record for anything that changed (or would have, in dry-run).
      if (result.removed.length || result.failures.length || result.identityMismatches?.length) {
        const detail =
          `${result.dryRun ? "dry run — " : ""}sweep — removed: [${result.removed.join(", ")}]` +
          (result.failures.length ? ` failures: [${result.failures.join(" | ")}]` : "") +
          (result.identityMismatches?.length
            ? ` mismatches: [${result.identityMismatches.join(" | ")}]`
            : "");
        await deps
          .recordLog({
            email: subject.email,
            stripeSubscriptionId: subject.stripeSubscriptionId,
            action: "TELEGRAM_REMOVED",
            plan: subject.currentPlan,
            detail,
          })
          .catch(() => {});
      }
    } catch (err) {
      summary.failures.push(
        `${username} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const somethingToSay =
    summary.removed.length ||
    summary.unrecognised.length ||
    summary.mismatches.length ||
    summary.failures.length ||
    summary.stillBanned.length ||
    summary.partial;

  if (somethingToSay) {
    const lines = [
      summary.dryRun ? `<b>🧪 DRY RUN — Telegram sweep</b>` : `<b>🧹 Telegram sweep</b>`,
      `Checked ${summary.usersChecked} member(s)${summary.partial ? " — <b>partial run</b> (time budget hit; continues tomorrow)" : ""}`,
    ];
    if (summary.removed.length) {
      const verb = summary.dryRun ? "Would remove" : "Removed";
      lines.push(
        `<b>${verb}:</b>`,
        ...summary.removed.map((r) => `• @${escapeHtml(r.username)} — ${r.groups.join(", ")}`)
      );
    }
    if (summary.unrecognised.length)
      lines.push(
        `<b>⚠️ Unrecognised plan (nothing removed — fix col F):</b> ${summary.unrecognised
          .map((u) => `@${escapeHtml(u)}`)
          .join(", ")}`
      );
    if (summary.mismatches.length)
      lines.push(`<b>⚠️ Identity mismatches (skipped):</b> ${escapeHtml(summary.mismatches.join(" | "))}`);
    if (summary.failures.length)
      lines.push(`<b>❌ Failures:</b> ${escapeHtml(summary.failures.join(" | "))}`);
    if (summary.stillBanned.length)
      lines.push(`<b>🚨 STILL BANNED — unban by hand:</b> ${escapeHtml(summary.stillBanned.join(", "))}`);
    await deps.notify(lines.join("\n")).catch(() => {});
  }

  return summary;
}
