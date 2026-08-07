import { describe, it, expect } from "vitest";
import {
  standardiseTrialEnds,
  shiftPhaseBoundary,
  cohortFor,
  TRIAL_COHORTS,
  type TrialCohort,
  type TrialStripeClient,
  type TrialSubscription,
  type SchedulePhase,
} from "./trial-standardiser.js";

const JULY = TRIAL_COHORTS.find((c) => c.key === "july25")!.target;
const DRW = TRIAL_COHORTS.find((c) => c.key === "drwealth")!.target;
const DAY = 86400;
const BEFORE = new Date((JULY - 5 * DAY) * 1000);

const sub = (over: Partial<TrialSubscription> = {}): TrialSubscription => ({
  id: "sub_1",
  email: "a@example.com",
  trialEnd: JULY - DAY,
  ref: null,
  scheduleId: null,
  ...over,
});

const phase = (over: Partial<SchedulePhase> = {}): SchedulePhase => ({
  startDate: JULY - 15 * DAY,
  endDate: JULY - DAY,
  priceId: "price_all_markets",
  quantity: 1,
  prorationBehavior: "create_prorations",
  trial: true,
  discountCouponIds: [],
  ...over,
});

class FakeStripe implements TrialStripeClient {
  trialEndWrites: Array<[string, number]> = [];
  phaseWrites: Array<[string, SchedulePhase[]]> = [];
  failOn = new Set<string>();
  /** Subscription IDs that come back NOT trialing after a write. */
  endsTrialOn = new Set<string>();

  constructor(
    private subs: TrialSubscription[],
    private phases: Record<string, SchedulePhase[]> = {}
  ) {}

  async getStatus(id: string): Promise<{ status: string; trialEnd: number | null }> {
    return this.endsTrialOn.has(id)
      ? { status: "active", trialEnd: null }
      : { status: "trialing", trialEnd: JULY };
  }

  async listTrialing(): Promise<TrialSubscription[]> {
    return this.subs;
  }
  async setTrialEnd(id: string, trialEnd: number): Promise<void> {
    if (this.failOn.has(id)) throw new Error("managed by the subscription schedule");
    this.trialEndWrites.push([id, trialEnd]);
  }
  async getSchedulePhases(scheduleId: string): Promise<SchedulePhase[]> {
    return this.phases[scheduleId] ?? [];
  }
  async setSchedulePhases(scheduleId: string, phases: SchedulePhase[]): Promise<void> {
    this.phaseWrites.push([scheduleId, phases]);
  }
}

describe("cohortFor", () => {
  it("routes a drwealth ref to the DrWealth target", () => {
    expect(cohortFor("drwealth")!.target).toBe(DRW);
  });

  it("routes a missing ref to the catch-all cohort", () => {
    expect(cohortFor(null)!.target).toBe(JULY);
  });

  it("routes an UNKNOWN ref to the catch-all rather than dropping it", () => {
    // A partner link we forgot to add a cohort for must still get standardised,
    // not silently skipped.
    expect(cohortFor("some-new-partner")!.key).toBe("july25");
  });
});

describe("standardiseTrialEnds", () => {
  it("moves each cohort onto its own target", async () => {
    const stripe = new FakeStripe([
      sub({ id: "sub_july", ref: null }),
      sub({ id: "sub_drw", ref: "drwealth", trialEnd: DRW - DAY }),
    ]);
    const summary = await standardiseTrialEnds(stripe, BEFORE);

    expect(stripe.trialEndWrites).toEqual([
      ["sub_july", JULY],
      ["sub_drw", DRW],
    ]);
    expect(summary.moved).toHaveLength(2);
    expect(summary.failures).toEqual([]);
  });

  it("SHORTENS a trial that ends after its target", async () => {
    // The 2026-08-03 decision: hard-set, not extend-only.
    const stripe = new FakeStripe([sub({ id: "sub_late", trialEnd: JULY + 4 * DAY })]);
    await standardiseTrialEnds(stripe, BEFORE);
    expect(stripe.trialEndWrites).toEqual([["sub_late", JULY]]);
  });

  it("leaves a subscription already on target alone", async () => {
    const stripe = new FakeStripe([sub({ trialEnd: JULY })]);
    const summary = await standardiseTrialEnds(stripe, BEFORE);
    expect(stripe.trialEndWrites).toEqual([]);
    expect(summary.alreadyCorrect).toBe(1);
  });

  it("skips a cohort whose target has already passed", async () => {
    const stripe = new FakeStripe([sub()]);
    const after = new Date((JULY + DAY) * 1000);
    const summary = await standardiseTrialEnds(stripe, after);
    expect(stripe.trialEndWrites).toEqual([]);
    expect(summary.skippedPastTarget).toBe(1);
  });

  it("moves the schedule boundary when a schedule is attached", async () => {
    const stripe = new FakeStripe(
      [sub({ id: "sub_sched", scheduleId: "sched_1" })],
      {
        sched_1: [
          phase(),
          phase({
            startDate: JULY - DAY,
            endDate: JULY - DAY + 1,
            priceId: "price_combo",
            trial: false,
          }),
        ],
      }
    );
    const summary = await standardiseTrialEnds(stripe, BEFORE);

    expect(stripe.trialEndWrites).toEqual([]);
    const [scheduleId, phases] = stripe.phaseWrites[0];
    expect(scheduleId).toBe("sched_1");
    expect(phases[0].endDate).toBe(JULY);
    expect(phases[1].startDate).toBe(JULY);
    expect(phases[1].priceId).toBe("price_combo"); // downgrade preserved
    expect(phases[0].trial).toBe(true); // trial must survive the rewrite
    expect(summary.viaSchedule).toEqual(["a@example.com"]);
  });

  it("keeps going after a failure instead of aborting the run", async () => {
    // The bug that left 6 subscriptions untouched on 2026-08-03.
    const stripe = new FakeStripe([
      sub({ id: "sub_bad", email: "bad@example.com" }),
      sub({ id: "sub_good_1", email: "one@example.com" }),
      sub({ id: "sub_good_2", email: "two@example.com" }),
    ]);
    stripe.failOn.add("sub_bad");
    const summary = await standardiseTrialEnds(stripe, BEFORE);

    expect(stripe.trialEndWrites.map(([id]) => id)).toEqual([
      "sub_good_1",
      "sub_good_2",
    ]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toContain("bad@example.com");
    expect(summary.moved).toHaveLength(2);
  });

  it("flags a write that ended a trial instead of reporting success", async () => {
    // Second line of defence for the 2026-08-03 incident: even if a write goes
    // wrong in some way we have not predicted, the run must SAY SO rather than
    // report a clean move and let a converted subscriber sit unnoticed.
    const stripe = new FakeStripe([sub({ id: "sub_broken", email: "x@example.com" })]);
    stripe.endsTrialOn.add("sub_broken");
    const summary = await standardiseTrialEnds(stripe, BEFORE);

    expect(summary.endedTrials).toHaveLength(1);
    expect(summary.endedTrials[0]).toContain("x@example.com");
    expect(summary.failures).toHaveLength(1);
    expect(summary.moved).toEqual([]); // never counted as a success
  });

  it("reports a clean run with no ended trials", async () => {
    const stripe = new FakeStripe([sub()]);
    const summary = await standardiseTrialEnds(stripe, BEFORE);
    expect(summary.endedTrials).toEqual([]);
    expect(summary.moved).toHaveLength(1);
  });

  it("writes nothing when apply is false", async () => {
    const stripe = new FakeStripe([sub()]);
    const summary = await standardiseTrialEnds(stripe, BEFORE, { apply: false });
    expect(stripe.trialEndWrites).toEqual([]);
    expect(summary.moved).toHaveLength(1);
  });

  it("does nothing at all once every cohort target has passed", async () => {
    const stripe = new FakeStripe([sub(), sub({ id: "sub_2", ref: "drwealth" })]);
    const wayAfter = new Date((DRW + 30 * DAY) * 1000);
    const summary = await standardiseTrialEnds(stripe, wayAfter);
    expect(stripe.trialEndWrites).toEqual([]);
    expect(stripe.phaseWrites).toEqual([]);
    expect(summary.skippedPastTarget).toBe(2);
  });
});

describe("shiftPhaseBoundary", () => {
  it("preserves the second phase's duration", () => {
    const phases = [
      phase({ endDate: 1000 }),
      phase({ startDate: 1000, endDate: 1001, trial: false }),
    ];
    const shifted = shiftPhaseBoundary(phases, 5000);
    expect(shifted[0].endDate).toBe(5000);
    expect(shifted[1].startDate).toBe(5000);
    expect(shifted[1].endDate).toBe(5001);
  });

  it("refuses to rewrite a schedule that isn't two phases", () => {
    expect(() => shiftPhaseBoundary([phase()], 5000)).toThrow(/expected 2/);
  });

  it("forces trial on the first phase even when the source says otherwise", () => {
    // Regression, live incident 2026-08-03: a portal-created schedule reported
    // trial_end null on the trial phase, the rewrite went out without a trial
    // flag, and Stripe ended two subscribers' trials and raised $417 invoices.
    const phases = [
      phase({ endDate: 1000, trial: false }),
      phase({ startDate: 1000, endDate: 1001, trial: false }),
    ];
    const shifted = shiftPhaseBoundary(phases, 5000);
    expect(shifted[0].trial).toBe(true);
    expect(shifted[1].trial).toBe(false);
  });
});

describe("cohort targets", () => {
  it("are 9 Aug and 16 Aug 2026, 23:59 Singapore time", () => {
    const inSgt = (epoch: number) =>
      new Date(epoch * 1000).toLocaleString("en-GB", {
        timeZone: "Asia/Singapore",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    expect(inSgt(JULY)).toContain("09 Aug");
    expect(inSgt(JULY)).toContain("23:59");
    expect(inSgt(DRW)).toContain("16 Aug");
    expect(inSgt(DRW)).toContain("23:59");
  });
});

// Guards the cohort list shape the matcher depends on.
describe("TRIAL_COHORTS", () => {
  it("has exactly one catch-all and puts it last", () => {
    const catchAlls = TRIAL_COHORTS.filter((c: TrialCohort) => c.ref === null);
    expect(catchAlls).toHaveLength(1);
    expect(TRIAL_COHORTS[TRIAL_COHORTS.length - 1].ref).toBeNull();
  });
});

describe("shiftPhaseBoundary — discounts", () => {
  it("carries each phase's coupons through the rewrite", () => {
    // Regression guard. The phase write used to drop `discounts`, which strips
    // the coupon off the LIVE subscription the moment it lands — so moving a
    // trial end silently destroyed a schedule-managed subscriber's Pepperstone
    // discount. Every rewrite must preserve them.
    const [trialPhase, nextPhase] = shiftPhaseBoundary(
      [
        phase({ discountCouponIds: ["7imb0DBR"] }),
        phase({
          trial: false,
          priceId: "price_us",
          discountCouponIds: ["gcUCHGHv"],
          startDate: JULY - DAY,
          endDate: JULY + 90 * DAY,
        }),
      ],
      JULY
    );

    expect(trialPhase.discountCouponIds).toEqual(["7imb0DBR"]);
    expect(nextPhase.discountCouponIds).toEqual(["gcUCHGHv"]);
  });

  it("keeps an empty coupon list empty rather than inventing one", () => {
    const [a, b] = shiftPhaseBoundary(
      [phase(), phase({ trial: false, startDate: JULY - DAY, endDate: JULY + 90 * DAY })],
      JULY
    );
    expect(a.discountCouponIds).toEqual([]);
    expect(b.discountCouponIds).toEqual([]);
  });
});
