// Dry-run the trial-end standardiser against LIVE Stripe. Reads only — passes
// apply:false, so it lists what the cron would change and writes nothing.
//
//   npx tsx --env-file=.env scripts/dry-run-trial-standardise.mts
//
// Use this after changing cohort targets, or before trusting a deploy: the
// standardiser core has unit tests, but LiveTrialStripe is the part that has to
// line up with real Stripe payload shapes (pagination, expanded customer,
// schedule phases).

import Stripe from "stripe";
import { LiveTrialStripe } from "../api/standardise-trial-ends.js";
import {
  standardiseTrialEnds,
  shiftPhaseBoundary,
  TRIAL_COHORTS,
  fmt,
} from "../lib/trial-standardiser.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY not set (expected in .env)");
console.log(`Stripe key: ${key.slice(0, 8)}…  (${key.startsWith("sk_live") ? "LIVE" : "test"})`);

for (const c of TRIAL_COHORTS) {
  const past = c.target <= Date.now() / 1000;
  console.log(`  ${c.label.padEnd(10)} ref=${c.ref ?? "(none)"} → ${fmt(c.target)}${past ? "  [PAST — skipped]" : ""}`);
}

const stripe = new LiveTrialStripe(new Stripe(key, { apiVersion: "2025-08-27.basil" }));

// --schedule <id> reads one subscription schedule through the adapter and shows
// how its phases map, plus what the boundary shift would produce. Read-only.
// The schedule path is the one that rewrites a queued plan change, so it is
// worth eyeballing on real data before trusting it — particularly the `trial`
// flag, which is inferred from trial_end matching the phase end.
const scheduleFlag = process.argv.indexOf("--schedule");
if (scheduleFlag !== -1) {
  const id = process.argv[scheduleFlag + 1];
  const phases = await stripe.getSchedulePhases(id);
  console.log(`\n${id} — ${phases.length} phases as mapped:`);
  for (const p of phases) {
    console.log(`  ${fmt(p.startDate)} → ${fmt(p.endDate)}  ${p.priceId} x${p.quantity}  trial=${p.trial}  proration=${p.prorationBehavior}`);
  }
  const target = TRIAL_COHORTS[TRIAL_COHORTS.length - 1].target;
  console.log(`  would shift boundary to ${fmt(target)}:`);
  for (const p of shiftPhaseBoundary(phases, target)) {
    console.log(`    ${fmt(p.startDate)} → ${fmt(p.endDate)}  ${p.priceId}  trial=${p.trial}`);
  }
  process.exit(0);
}

const summary = await standardiseTrialEnds(stripe, new Date(), { apply: false });

console.log(`\nchecked: ${summary.checked}`);
console.log(`already correct: ${summary.alreadyCorrect}`);
console.log(`skipped (target passed): ${summary.skippedPastTarget}`);
console.log(`would move: ${summary.moved.length}`);
for (const line of summary.moved) console.log(`  ${line}`);
if (summary.viaSchedule.length) {
  console.log(`  via schedule: ${summary.viaSchedule.join(", ")}`);
}
if (summary.failures.length) {
  console.log(`failures: ${summary.failures.length}`);
  for (const line of summary.failures) console.log(`  ${line}`);
}
console.log("\nDry run — nothing was written.");
