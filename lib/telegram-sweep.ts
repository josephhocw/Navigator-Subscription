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
  /**
   * Stop starting new users once this much time has passed. Vercel functions
   * have a hard max duration; a partial sweep today finishes tomorrow.
   *
   * A budget-tripped run does NOT resume from the top of the list next time —
   * candidates iterate in stable sheet order, so that would sweep the same
   * head of the list every day and starve the tail forever. Instead the start
   * point rotates by calendar day (see `offset` below), so a partial run still
   * makes forward progress across the whole list over time.
   */
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
  /** "id 123: @a, @b" for each col-P User ID claimed by more than one distinct
   *  username. Neither username is processed — see the dedup step below. */
  duplicateIds: string[];
  partial: boolean;
  dryRun: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Accumulate items until `maxChars` is spent, then replace the remainder with
 * a single "…and N more" line. Telegram silently drops any message over 4096
 * chars, and an aggregated ping (e.g. hundreds of accumulated failures) can
 * blow well past that — a capped, useful slice beats a vanished alert.
 *
 * Always keeps at least one item (if any exist) even if it alone exceeds the
 * budget, so a single oversized entry can't make a section disappear.
 */
export function capList(items: string[], maxChars: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.length + 2; // rough per-item separator/bullet overhead
    if (used + cost > maxChars && out.length > 0) break;
    out.push(item);
    used += cost;
  }
  const remaining = items.length - out.length;
  if (remaining > 0) out.push(`…and ${remaining} more`);
  return out;
}

const DAY_MS = 86_400_000;

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
        (x.telegramUserId ?? "").trim() !== ""
    );
    if (withId) candidates.set(u, withId);
  }

  // Duplicate col-P User ID guard: two different usernames sharing one
  // trimmed User ID is a data-entry error, and if the Telegram account behind
  // it has no public username, the remover's identity-mismatch guard has
  // nothing to compare against and can't save it. Rather than guess which
  // username is the real owner, skip both entirely and surface it for a
  // human to fix the sheet.
  const usernamesById = new Map<string, Set<string>>();
  for (const [username, subject] of candidates) {
    const id = subject.telegramUserId.trim();
    if (!usernamesById.has(id)) usernamesById.set(id, new Set());
    usernamesById.get(id)!.add(username);
  }
  const duplicateIds: string[] = [];
  for (const [id, usernames] of usernamesById) {
    if (usernames.size > 1) {
      duplicateIds.push(
        `id ${id}: ${[...usernames].map((u) => `@${u}`).join(", ")}`
      );
      for (const u of usernames) candidates.delete(u);
    }
  }

  // Rotate the start point by calendar day so a budget-tripped run sweeps a
  // different slice of the list each time, instead of always restarting at
  // the top and never reaching the tail. `started` comes from the injected
  // `now()`, so this stays deterministic in tests.
  const list = [...candidates.entries()];
  const offset = list.length ? Math.floor(started / DAY_MS) % list.length : 0;
  const rotated = [...list.slice(offset), ...list.slice(0, offset)];

  const summary: SweepSummary = {
    usersChecked: 0,
    removed: [],
    unrecognised: [],
    mismatches: [],
    failures: [],
    stillBanned: [],
    duplicateIds,
    partial: false,
    dryRun: false,
  };

  for (const [username, subject] of rotated) {
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

      // Deliberately no Status Log row for a bare unrecognised-plan
      // short-circuit — logging it daily would just re-record a standing
      // data problem every run; the ping section below is the record.
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
          .catch((e) => console.error("telegram-sweep: recordLog failed", e));
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
    summary.duplicateIds.length ||
    summary.partial;

  if (somethingToSay) {
    const lines = [
      summary.dryRun ? `<b>🧪 DRY RUN — Telegram sweep</b>` : `<b>🧹 Telegram sweep</b>`,
      `Checked ${summary.usersChecked} member(s)${summary.partial ? " — <b>partial run</b> (time budget hit; tomorrow starts from a different point in the list)" : ""}`,
    ];
    if (summary.removed.length) {
      const verb = summary.dryRun ? "Would remove" : "Removed";
      lines.push(
        `<b>${verb}:</b>`,
        ...capList(
          summary.removed.map((r) => `• @${escapeHtml(r.username)} — ${r.groups.join(", ")}`),
          1500
        )
      );
    }
    if (summary.unrecognised.length)
      lines.push(
        `<b>⚠️ Unrecognised plan (nothing removed — fix col F):</b> ${capList(
          summary.unrecognised.map((u) => `@${escapeHtml(u)}`),
          400
        ).join(", ")}`
      );
    if (summary.mismatches.length)
      lines.push(
        `<b>⚠️ Identity mismatches (skipped):</b> ${escapeHtml(
          capList(summary.mismatches, 500).join(" | ")
        )}`
      );
    if (summary.failures.length)
      lines.push(
        `<b>❌ Failures:</b> ${escapeHtml(capList(summary.failures, 700).join(" | "))}`
      );
    if (summary.stillBanned.length)
      lines.push(
        `<b>🚨 STILL BANNED — unban by hand:</b> ${escapeHtml(
          capList(summary.stillBanned, 300).join(", ")
        )}`
      );
    if (summary.duplicateIds.length)
      lines.push(
        `<b>⚠️ Duplicate col-P User IDs (skipped — fix the sheet):</b> ${escapeHtml(
          capList(summary.duplicateIds, 400).join(" | ")
        )}`
      );
    await deps.notify(lines.join("\n")).catch((e) => console.error("telegram-sweep: notify failed", e));
  }

  return summary;
}
