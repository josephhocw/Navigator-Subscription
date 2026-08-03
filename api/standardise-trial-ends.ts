// =============================================================================
// STANDARDISE TRIAL ENDS (Vercel Cron)
// =============================================================================
// Pulls every trialing campaign subscription onto its cohort's shared end
// moment, so a cohort converts together and the comms can promise one date.
// Replaces a manual Python script that had to be remembered and run by hand —
// forgetting it is exactly how the 25 July cohort ended up converting on five
// different days.
//
// Trigger: daily cron in vercel.json at 14:00 UTC = 22:00 SGT. Vercel's Hobby
// plan fires a cron anywhere in the hour AFTER the scheduled minute (observed
// live: the old 23:55 schedule fired at 00:09, past the deadline), so the
// schedule must leave headroom — 22:00 + worst-case 59 min still lands before
// the 23:59 trial deadline. Residual gap: a sign-up between this run and 23:59
// on the FINAL day keeps its rolling date and needs a manual straggler check
// just after the deadline. Auth: Vercel sends
// `Authorization: Bearer $CRON_SECRET`, same as the other jobs here.
//
// Self-retiring: once every cohort target in lib/trial-standardiser.ts is in
// the past, this does nothing and says nothing. A new campaign needs a new
// cohort entry there; no change is needed in this file.
//
// Quiet by default — it only pings Joseph when it actually moved something or
// hit a failure, so a steady-state day produces no noise.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { notifyAdmin } from "../lib/telegram.js";
import {
  standardiseTrialEnds,
  TRIAL_PRICE_ID,
  TRIAL_COHORTS,
  fmt,
  type TrialStripeClient,
  type TrialSubscription,
  type SchedulePhase,
} from "../lib/trial-standardiser.js";

// Created on demand so the env var is read at runtime, not import time.
// apiVersion matches the rest of the repo (see api/stripe-webhook.ts).
const stripeClient = (): Stripe =>
  new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-08-27.basil" });

/**
 * Adapts the Stripe SDK to the narrow seam the standardiser is tested against.
 * Exported so it can be dry-run against live Stripe before a deploy — the
 * standardiser core is unit-tested, but this adapter is the part that has to
 * match real Stripe payload shapes.
 */
export class LiveTrialStripe implements TrialStripeClient {
  constructor(private stripe: Stripe) {}

  async listTrialing(priceId: string): Promise<TrialSubscription[]> {
    const out: TrialSubscription[] = [];
    for await (const s of this.stripe.subscriptions.list({
      status: "trialing",
      price: priceId,
      limit: 100,
      expand: ["data.customer"],
    })) {
      const customer = s.customer;
      out.push({
        id: s.id,
        email:
          typeof customer === "object" && customer && !("deleted" in customer)
            ? customer.email
            : null,
        trialEnd: s.trial_end,
        ref: (s.metadata?.ref as string | undefined) ?? null,
        scheduleId: typeof s.schedule === "string" ? s.schedule : s.schedule?.id ?? null,
      });
    }
    return out;
  }

  async setTrialEnd(subscriptionId: string, trialEnd: number): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, {
      trial_end: trialEnd,
      proration_behavior: "none",
    });
  }

  async getSchedulePhases(scheduleId: string): Promise<SchedulePhase[]> {
    const sched = await this.stripe.subscriptionSchedules.retrieve(scheduleId);
    return sched.phases.map((p) => {
      const item = p.items[0];
      const price = item?.price;
      return {
        startDate: p.start_date,
        endDate: p.end_date,
        priceId: typeof price === "string" ? price : price?.id ?? "",
        quantity: item?.quantity ?? 1,
        prorationBehavior: p.proration_behavior ?? "create_prorations",
        // Best-effort only, and deliberately not trusted: a portal-created
        // schedule can report trial_end: null on a phase that IS the trial.
        // shiftPhaseBoundary forces trial on the first phase for that reason.
        trial: Boolean(p.trial_end && p.trial_end === p.end_date),
      };
    });
  }

  async getStatus(
    subscriptionId: string
  ): Promise<{ status: string; trialEnd: number | null }> {
    const s = await this.stripe.subscriptions.retrieve(subscriptionId);
    return { status: s.status, trialEnd: s.trial_end };
  }

  async setSchedulePhases(scheduleId: string, phases: SchedulePhase[]): Promise<void> {
    await this.stripe.subscriptionSchedules.update(scheduleId, {
      phases: phases.map((p) => ({
        start_date: p.startDate,
        end_date: p.endDate,
        proration_behavior:
          p.prorationBehavior as Stripe.SubscriptionScheduleUpdateParams.Phase.ProrationBehavior,
        items: [{ price: p.priceId, quantity: p.quantity }],
        ...(p.trial ? { trial: true } : {}),
      })),
    });
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const summary = await standardiseTrialEnds(
      new LiveTrialStripe(stripeClient()),
      new Date()
    );

    // Telegram caps a message at 4096 characters, and a target change moves the
    // whole cohort in one run (66 subscriptions the day the 23:55 target
    // landed). Cap the per-line lists; the JSON response has the full detail.
    const cap = (lines: string[], limit = 12): string => {
      if (!lines.length) return "—";
      if (lines.length <= limit) return lines.join("\n");
      return `${lines.slice(0, limit).join("\n")}\n…and ${lines.length - limit} more`;
    };

    if (summary.moved.length || summary.failures.length || summary.endedTrials.length) {
      const targets = TRIAL_COHORTS.filter((c) => c.target > Date.now() / 1000)
        .map((c) => `${c.label} → ${fmt(c.target)}`)
        .join(" · ");
      await notifyAdmin(
        [
          summary.endedTrials.length
            ? `<b>🚨 A TRIAL WAS ENDED BY MISTAKE (${summary.endedTrials.length}) — ACT NOW</b>\n${cap(summary.endedTrials)}\n`
            : null,
          `<b>📅 Trial ends standardised</b>`,
          targets ? `<i>${targets}</i>` : null,
          ``,
          `<b>Moved (${summary.moved.length}):</b>\n${cap(summary.moved)}`,
          summary.viaSchedule.length
            ? `<b>Via subscription schedule (${summary.viaSchedule.length}):</b> ${cap(summary.viaSchedule, 20).replace(/\n/g, ", ")}\n<i>These have a plan change queued — the schedule boundary moved, the downgrade is intact.</i>`
            : null,
          `<i>Already correct: ${summary.alreadyCorrect} of ${summary.checked} checked.</i>`,
          summary.failures.length
            ? `<b>⚠️ Failures (${summary.failures.length}) — these still have the WRONG trial end:</b>\n${cap(summary.failures)}`
            : null,
        ]
          .filter(Boolean)
          .join("\n")
      ).catch(() => {});
    }

    res.status(200).json({ ok: true, priceId: TRIAL_PRICE_ID, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Trial-end standardise failed:", message);
    await notifyAdmin(
      `<b>❌ Trial-end standardise failed</b>\n${message}\n\n<i>The cohort may still be on rolling trial dates — check before promising a date in any comms.</i>`
    ).catch(() => {});
    res.status(500).json({ error: message });
  }
}
