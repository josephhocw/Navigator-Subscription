// =============================================================================
// TRIAL END STANDARDISER
// =============================================================================
// Campaign trials are sold through Stripe Payment Links, and a payment link can
// only express a trial as a RELATIVE day count (`trial_period_days`) — there is
// no absolute-end field. So every sign-up gets its own end moment (sign-up time
// + N days) and the count drifts by a day for every day the link stays open.
// A cohort we want to convert together, and promise a single date in the comms,
// therefore has to be pulled onto one moment after the fact.
//
// This module is that pull. It was a manual Python script
// (`Seminar Outreach/.../Scripts/set_trial_end.py`) run by hand; missing a run
// is what let the whole 25 July cohort sit on raw rolling dates until 3 Aug
// 2026. It now runs as a daily Vercel cron instead.
//
// Two behaviours worth knowing before changing anything:
//
//   1. It HARD-SETS. A trial is moved onto its cohort target whether that
//      extends or shortens it (Joseph's call, 2026-08-03 — one conversion
//      moment and one date in the comms was worth shortening some trials by a
//      few days). The payment links carry custom text naming the fixed date
//      above the subscribe button, so a new sign-up is told the real date
//      before paying.
//   2. A subscription with a portal-scheduled plan change is "managed by the
//      subscription schedule" and REJECTS a direct trial_end write with an HTTP
//      400. The fix is to move the schedule's phase boundary instead. The old
//      Python script didn't know this and died mid-run on the first one it hit,
//      silently leaving the rest of the cohort untouched. Here every
//      subscription is handled independently and a failure is reported, never
//      fatal.
//
// The cohort targets are self-expiring: once a target is in the past that
// cohort is skipped, so after the last campaign date the whole job is a quiet
// no-op and can sit in vercel.json harmlessly. A NEW campaign needs a new entry
// in TRIAL_COHORTS — nothing else.
// =============================================================================

/** Live All Markets quarterly price — the only price the trial links sell. */
export const TRIAL_PRICE_ID = "price_1Te9XoPApeZiCPK2HqYrNNK1";

/** Seconds, not milliseconds — Stripe timestamps are epoch seconds. */
const sgt = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number => Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;

export interface TrialCohort {
  key: string;
  label: string;
  /** `metadata.ref` that identifies the cohort; null matches subs with no ref. */
  ref: string | null;
  /** Epoch seconds the whole cohort's trial should end. */
  target: number;
}

/**
 * Cohorts, most specific first — a subscription is matched against `ref` in
 * order, and the null-ref entry is the catch-all that must come last.
 */
// Trials end at 23:59 SGT — that is the time in every comm and on both payment
// links. The cron time in vercel.json (22:00 SGT) is NOT the target: it is set
// early because Vercel's Hobby plan may fire a cron up to 59 minutes late, and
// the run must still land before the 23:59 deadline. Final-day sign-ups after
// the run are the one gap — check for stragglers just after each target passes.
export const TRIAL_COHORTS: TrialCohort[] = [
  {
    key: "drwealth-aug27",
    label: "DrWealth 27 Aug",
    ref: "drwealth-aug27",
    target: sgt(2026, 9, 6, 23, 59),
  },
  {
    key: "drwealth",
    label: "DrWealth",
    ref: "drwealth",
    target: sgt(2026, 8, 16, 23, 59),
  },
  {
    // One-off billing-date sync for my0cbc@yahoo.com.sg (sheet row 160):
    // asked to be charged 17 Aug 8am to match his card's billing cycle, so his
    // trial is held here instead of being pulled back to the 25 July target.
    // The ref is stamped on his subscription's metadata by hand — it is NOT a
    // partner attribution ref and must never be used in a payment link.
    key: "trial-17aug",
    label: "17 Aug extension",
    ref: "trial-17aug",
    target: sgt(2026, 8, 17, 8, 0),
  },
  {
    key: "july25",
    label: "25 July",
    ref: null,
    target: sgt(2026, 8, 9, 23, 59),
  },
];

export interface TrialSubscription {
  id: string;
  email: string | null;
  trialEnd: number | null;
  /** `metadata.ref`, or null when absent. */
  ref: string | null;
  /** Attached subscription schedule, if the customer queued a plan change. */
  scheduleId: string | null;
}

export interface SchedulePhase {
  startDate: number;
  endDate: number;
  priceId: string;
  quantity: number;
  prorationBehavior: string;
  /** True on the phase that represents the trial. */
  trial: boolean;
  /**
   * Coupon IDs on this phase, carried through every rewrite.
   *
   * NOT optional, and never omitted on a write. A phase update that leaves
   * `discounts` out strips the coupon off the LIVE subscription the instant it
   * lands - not at the phase flip (verified in test mode, 2026-08-07). Before
   * this field existed, moving a trial end on a schedule-managed subscriber
   * silently destroyed their Pepperstone discount.
   */
  discountCouponIds: string[];
}

/**
 * The slice of Stripe this module needs. Narrow on purpose: the tests drive it
 * with an in-memory fake, no SDK and no network.
 */
export interface TrialStripeClient {
  listTrialing(priceId: string): Promise<TrialSubscription[]>;
  setTrialEnd(subscriptionId: string, trialEnd: number): Promise<void>;
  getSchedulePhases(scheduleId: string): Promise<SchedulePhase[]>;
  setSchedulePhases(scheduleId: string, phases: SchedulePhase[]): Promise<void>;
  /** Status + trial end as they stand right now, for the post-write check. */
  getStatus(subscriptionId: string): Promise<{ status: string; trialEnd: number | null }>;
}

export interface StandardiseSummary {
  checked: number;
  /** Human-readable "email: old -> new" lines, one per subscription moved. */
  moved: string[];
  /** Subset of `moved` that had to go through a subscription schedule. */
  viaSchedule: string[];
  alreadyCorrect: number;
  /** Cohorts whose target has passed — nothing to do for them any more. */
  skippedPastTarget: number;
  failures: string[];
  /**
   * Subscriptions that were trialing before this job wrote to them and are not
   * trialing after. Always empty in normal operation; anything here means a
   * live subscriber has been converted by mistake and needs manual repair.
   */
  endedTrials: string[];
}

export const cohortFor = (
  ref: string | null,
  cohorts: TrialCohort[] = TRIAL_COHORTS
): TrialCohort | null =>
  cohorts.find((c) => c.ref === ref) ??
  cohorts.find((c) => c.ref === null) ??
  null;

/**
 * Rebuild a two-phase schedule with the trial/next boundary moved to `boundary`.
 * The second phase keeps its original duration (Stripe's portal writes a
 * one-second phase and then releases), and every other phase field is passed
 * back unchanged — `end_behavior` lives on the schedule, not the phases, so it
 * survives untouched.
 *
 * The first phase is ALWAYS marked as a trial, regardless of what the incoming
 * phase says. This is not defensive tidying — it is a fix for a live incident
 * (2026-08-03). A schedule the customer portal creates can carry
 * `trial_end: null` on its first phase even while the subscription itself is
 * trialing, so inferring the flag from the phase silently produced a rewrite
 * with no trial on it. Stripe read that as "this phase bills now", ended two
 * subscribers' trials on the spot and raised a $417 invoice against each. Since
 * this function is only ever reached for a subscription that is currently
 * trialing, `trial: true` is unconditionally correct here, and inference is not.
 */
export const shiftPhaseBoundary = (
  phases: SchedulePhase[],
  boundary: number
): SchedulePhase[] => {
  if (phases.length !== 2) {
    throw new Error(
      `expected 2 schedule phases, found ${phases.length} — refusing to rewrite`
    );
  }
  const [trialPhase, nextPhase] = phases;
  const nextDuration = nextPhase.endDate - nextPhase.startDate;
  return [
    { ...trialPhase, endDate: boundary, trial: true },
    { ...nextPhase, startDate: boundary, endDate: boundary + nextDuration, trial: false },
  ];
};

/**
 * Move every trialing subscription on the trial price onto its cohort's target.
 *
 * `now` is injected so tests (and a dry run) can reason about target expiry
 * without touching the clock.
 */
export async function standardiseTrialEnds(
  stripe: TrialStripeClient,
  now: Date,
  options: { cohorts?: TrialCohort[]; priceId?: string; apply?: boolean } = {}
): Promise<StandardiseSummary> {
  const cohorts = options.cohorts ?? TRIAL_COHORTS;
  const priceId = options.priceId ?? TRIAL_PRICE_ID;
  const apply = options.apply ?? true;
  const nowEpoch = Math.floor(now.getTime() / 1000);

  const summary: StandardiseSummary = {
    checked: 0,
    moved: [],
    viaSchedule: [],
    alreadyCorrect: 0,
    skippedPastTarget: 0,
    failures: [],
    endedTrials: [],
  };

  const subs = await stripe.listTrialing(priceId);
  summary.checked = subs.length;

  for (const sub of subs) {
    const who = sub.email ?? sub.id;
    const cohort = cohortFor(sub.ref, cohorts);
    if (!cohort) {
      summary.failures.push(`${who}: no cohort matches ref ${sub.ref ?? "(none)"}`);
      continue;
    }
    if (cohort.target <= nowEpoch) {
      summary.skippedPastTarget += 1;
      continue;
    }
    if (sub.trialEnd === cohort.target) {
      summary.alreadyCorrect += 1;
      continue;
    }

    const line = `${who} [${cohort.label}] ${fmt(sub.trialEnd)} → ${fmt(cohort.target)}`;
    try {
      if (!apply) {
        summary.moved.push(line);
        if (sub.scheduleId) summary.viaSchedule.push(who);
        continue;
      }
      if (sub.scheduleId) {
        // Stripe rejects a direct trial_end write on a schedule-managed
        // subscription; move the schedule's boundary and the subscription
        // follows.
        const phases = await stripe.getSchedulePhases(sub.scheduleId);
        await stripe.setSchedulePhases(
          sub.scheduleId,
          shiftPhaseBoundary(phases, cohort.target)
        );
        summary.viaSchedule.push(who);
      } else {
        await stripe.setTrialEnd(sub.id, cohort.target);
      }

      // Post-write check. This job's ONLY legitimate effect is to move a trial
      // end — it must never end a trial. On 2026-08-03 a schedule rewrite did
      // exactly that to two live subscribers, and nothing noticed: they were
      // converted, emailed and invoiced before a human spotted it. A wrong
      // write is now caught in the same run, in the same ping, instead of by
      // luck.
      const after = await stripe.getStatus(sub.id);
      if (after.status !== "trialing") {
        summary.endedTrials.push(
          `${who}: status is now ${after.status} — THE TRIAL WAS ENDED. ` +
            `Void any invoice raised and restore the trial before it finalises.`
        );
        summary.failures.push(`${who}: write ended the trial (${after.status})`);
        continue;
      }
      summary.moved.push(line);
    } catch (err) {
      // One awkward subscription must never stop the rest of the cohort.
      const message = err instanceof Error ? err.message : String(err);
      summary.failures.push(`${who}: ${message}`);
    }
  }

  return summary;
}

/** "09 Aug 2026 23:59" in Singapore time, for log and ping lines. */
export const fmt = (epoch: number | null): string => {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleString("en-GB", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};
