/**
 * Dry-run the coupon sync against live Stripe. READ-ONLY.
 *
 *   npx tsx --env-file=.env scripts/dry-run-coupon-sync.mts
 *   npx tsx --env-file=.env scripts/dry-run-coupon-sync.mts --sub sub_123
 *
 * Walks every subscription that currently carries a discount and reports what
 * the sync WOULD do. Forces dry-run regardless of COUPON_SYNC_DRY_RUN, so it
 * can never write — this is the safe way to check the rules against real data.
 */
import Stripe from "stripe";
import { StripeCouponManager } from "../lib/coupon-sync-stripe.js";
import { getPlanType } from "../lib/plans.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

const only = process.argv.includes("--sub")
  ? process.argv[process.argv.indexOf("--sub") + 1]
  : null;

// dryRun forced true — this script must never write.
const manager = new StripeCouponManager(stripe, true);

function planOf(sub: Stripe.Subscription): string {
  const priceId = sub.items.data[0]?.price?.id;
  if (!priceId) return "(no price)";
  try {
    return getPlanType(priceId);
  } catch {
    return `(unknown price ${priceId})`;
  }
}

async function main(): Promise<void> {
  const subs: Stripe.Subscription[] = [];

  if (only) {
    subs.push(await stripe.subscriptions.retrieve(only, { expand: ["discounts"] }));
  } else {
    // Explicit pagination. `for await (... of stripe.subscriptions.list())` was
    // used here first and silently stopped after the first page — it reported 22
    // discount holders when the account had 54. Never trust an unverified page
    // count on an audit script.
    let startingAfter: string | undefined;
    let total = 0;
    for (;;) {
      const page = await stripe.subscriptions.list({
        status: "all",
        limit: 100,
        expand: ["data.discounts"],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      total += page.data.length;
      for (const sub of page.data) {
        if (sub.status === "canceled" || sub.status === "incomplete_expired") continue;
        if ((sub.discounts ?? []).length === 0) continue;
        subs.push(sub);
      }
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1]?.id;
      if (!startingAfter) break;
    }
    console.log(`scanned ${total} subscription(s) across all pages`);
  }

  console.log(`${subs.length} live subscription(s) carrying a discount\n`);

  let wouldChange = 0;
  for (const sub of subs) {
    const plan = planOf(sub);
    const result = await manager.sync(sub.id, plan);
    const flag = /would/.test(result.summary) ? "CHANGE" : "ok    ";
    if (flag === "CHANGE") wouldChange += 1;
    console.log(
      `${flag}  ${sub.id}  ${sub.status.padEnd(9)} ${plan.padEnd(12)} [${result.route}]  ${result.summary}`
    );
    for (const b of result.blockers) console.log(`         ⚠️  ${b}`);
  }

  console.log(`\n${wouldChange} subscription(s) would be changed by a live run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
