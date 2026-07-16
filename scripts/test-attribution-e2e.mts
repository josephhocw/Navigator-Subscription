// End-to-end attribution check, TEST MODE only.
// Takes the real checkout.session.completed event produced by the sandbox
// checkout (client_reference_id=drwealth-test), runs it through the REAL
// translator + lifecycle, and verifies:
//   1. the translator extracts referralSource from the session
//   2. the subscription gets metadata.ref stamped in Stripe (test mode)
//   3. the lifecycle writes Referral Source to col T of the (scratch) sheet
//   4. the Status Log entry carries the ref
//
// Env: STRIPE_SECRET_KEY must be a TEST key (passed by the caller, never
// printed). Sheet writes go to the scratch spreadsheet only.
//
// Run: npx tsx scripts/test-attribution-e2e.mts
import { readFileSync } from "node:fs";
import Stripe from "stripe";

const TEST_SHEET_ID = "1zTfMoXiJyHee_uRh7_-I_uIg_RViROO5G4gqGq_-wNA"; // scratch, deletable
const REF = "drwealth-test";

const key = process.env.STRIPE_SECRET_KEY || "";
if (!/^(rk|sk)_test_/.test(key)) {
  throw new Error("STRIPE_SECRET_KEY must be a TEST-mode key for this script");
}

const envLine = readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n")
  .find((l) => l.startsWith("GOOGLE_SERVICE_ACCOUNT_JSON="));
if (!envLine) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not found in .env");
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = envLine
  .slice("GOOGLE_SERVICE_ACCOUNT_JSON=".length)
  .trim()
  .replace(/^"|"$/g, "");
process.env.GOOGLE_SHEET_ID = TEST_SHEET_ID;
process.env.GOOGLE_SHEET_TAB_NAME = "Subscribers";
process.env.GOOGLE_SHEET_LOG_TAB_NAME = "Status Log";

const { translate } = await import("../lib/stripe-translator.js");
const { SubscriptionLifecycle } = await import("../lib/subscription-lifecycle.js");
const { SheetsSubscriberStore } = await import("../lib/subscriber-store.js");
const { SheetsEventLog } = await import("../lib/event-log.js");
const { findRowBySubscriptionId } = await import("../lib/sheets.js");

const stripe = new Stripe(key);

let passed = 0,
  failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

// Find the completed sandbox checkout event.
const events = await stripe.events.list({
  type: "checkout.session.completed",
  limit: 5,
});
const event = events.data.find((e) => {
  const s = e.data.object as Stripe.Checkout.Session;
  return s.client_reference_id === REF && s.payment_status === "paid";
});
if (!event) throw new Error("No paid checkout.session.completed with the test ref found");
const session = event.data.object as Stripe.Checkout.Session;
console.log(`Using event ${event.id}, session ${session.id}`);
check("session carries client_reference_id", session.client_reference_id === REF);

// 1+2. Translator: extract ref + stamp metadata
const actions = await translate(event as Stripe.Event, stripe);
check("translator produced exactly one STARTED action", actions.length === 1 && actions[0].kind === "STARTED");
const started = actions[0] as Extract<(typeof actions)[0], { kind: "STARTED" }>;
check("STARTED.referralSource extracted", started.referralSource === REF, String(started.referralSource));

const sub = await stripe.subscriptions.retrieve(started.stripeSubscriptionId);
check("subscription metadata.ref stamped in Stripe", sub.metadata?.ref === REF, JSON.stringify(sub.metadata));

// 3+4. Lifecycle → scratch sheet (fake mailer/notifier, real store + log)
const sent: string[] = [];
const fakeMailer = new Proxy({} as Record<string, unknown>, {
  get: (_t, prop) => async () => { sent.push(String(prop)); },
});
const notes: string[] = [];
const lifecycle = new SubscriptionLifecycle(
  new SheetsSubscriberStore(),
  fakeMailer as never,
  { notify: async (m: string) => { notes.push(m); } },
  new SheetsEventLog()
);
for (const a of actions) await lifecycle.apply(a);

const row = await findRowBySubscriptionId(started.stripeSubscriptionId);
check("sheet row written", !!row);
check("sheet Referral Source (col T) = drwealth-test", row?.referralSource === REF, row?.referralSource);
check("onboarding email path invoked (faked)", sent.includes("sendOnboarding"));
check("admin ping includes Referred by line", notes.some((n) => n.includes("Referred by:") && n.includes(REF)));

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`Cleanup: test subscription ${started.stripeSubscriptionId} can now be cancelled.`);
process.exit(failed ? 1 : 0);
