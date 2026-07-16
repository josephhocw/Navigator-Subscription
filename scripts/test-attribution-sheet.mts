// One-off integration check for the Referral Source (col T) sheet plumbing.
// Runs against a SCRATCH spreadsheet — never the live one. Reads only
// GOOGLE_SERVICE_ACCOUNT_JSON from .env; sheet ID is hardcoded to the scratch
// sheet created for this test.
//
// Run: npx tsx scripts/test-attribution-sheet.mts
import { readFileSync } from "node:fs";

const TEST_SHEET_ID = "1zTfMoXiJyHee_uRh7_-I_uIg_RViROO5G4gqGq_-wNA"; // scratch, deletable

// Pull the service-account JSON out of .env without loading anything else.
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

const {
  appendNewSubscriber,
  findRowBySubscriptionId,
  updateRowFields,
} = await import("../lib/sheets.js");

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

// 1. New subscriber WITH a referral source
const row1 = await appendNewSubscriber({
  email: "attribution-test-1@example.com",
  customerName: "Attribution Test One",
  tradingViewUsername: "attr_tv_1",
  telegramUsername: "attr_tg_1",
  currentPlan: "SG",
  subscriptionPrice: 108,
  couponDiscount: false,
  subscriptionStart: "16 July 2026 12:00",
  subscriptionExpiry: "16 October 2026 12:00",
  stripeSubscriptionId: "sub_attr_test_1",
  referralSource: "drwealth-test",
});
check("append with ref returned a row number", row1 >= 2, String(row1));

// 2. New subscriber WITHOUT a referral source
const row2 = await appendNewSubscriber({
  email: "attribution-test-2@example.com",
  customerName: "Attribution Test Two",
  tradingViewUsername: "attr_tv_2",
  telegramUsername: "attr_tg_2",
  currentPlan: "US",
  subscriptionPrice: 168,
  couponDiscount: true,
  subscriptionStart: "16 July 2026 12:00",
  subscriptionExpiry: "16 October 2026 12:00",
  stripeSubscriptionId: "sub_attr_test_2",
  referralSource: "",
});
check("second append landed on the next row", row2 === row1 + 1, `${row1} then ${row2}`);

// 3. Read back through the store's own parser
const found1 = await findRowBySubscriptionId("sub_attr_test_1");
check("row 1 found by subscription ID", !!found1);
check("row 1 referralSource reads back as drwealth-test", found1?.referralSource === "drwealth-test", found1?.referralSource);
check("row 1 core fields intact (email/plan/price)",
  found1?.email === "attribution-test-1@example.com" && found1?.currentPlan === "SG" && found1?.subscriptionPrice === 108);

const found2 = await findRowBySubscriptionId("sub_attr_test_2");
check("row 2 referralSource is empty", found2?.referralSource === "");

// 4. Patch path (the reactivation fill)
await updateRowFields(row2, { referralSource: "drwealth-test" });
const found2b = await findRowBySubscriptionId("sub_attr_test_2");
check("patch fills referralSource on an existing row", found2b?.referralSource === "drwealth-test", found2b?.referralSource);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
