// Sends real copies of the two trial-END emails to a test address, using the
// live template code. Touches no sheet, no Stripe, and no subscriber — it only
// calls the two mailer functions.
//
//   1. sendTrialConvertedWelcomeEmail — trial converted (card charged)
//   2. sendTrialEndedWinbackEmail     — trial ended without charging (cancelled)
//
// Run: npx tsx scripts/send-test-trial-end.mts [email] [name]
import { readFileSync } from "node:fs";

const to = process.argv[2] || "joseph.ho1996@gmail.com";
const name = process.argv[3] || "Joseph";

// Load the keys the mailer needs straight from .env (local-dev file).
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const key of ["RESEND_API_KEY", "FROM_EMAIL"]) {
  const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in .env`);
  process.env[key] = line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}
delete process.env.BCC_EMAIL; // a test shouldn't copy the business inbox

const { sendTrialConvertedWelcomeEmail, sendTrialEndedWinbackEmail } =
  await import("../lib/email.js");
const { formatDisplayDateSGT } = await import("../lib/format-date.js");

// Mirror a real 25 July / DrWealth conversion: All Markets, next billing one
// quarter after the 9 Aug conversion moment.
const nextBilling = formatDisplayDateSGT(new Date("2026-11-09T23:59:00+08:00"));

await sendTrialConvertedWelcomeEmail({
  email: to,
  name,
  planType: "ALL_MARKETS",
  billingEndDate: nextBilling,
  telegramUsername: "Joseph_Ho",
});
console.log(`Sent the trial-converted welcome email to ${to}.`);

await sendTrialEndedWinbackEmail({
  email: to,
  name,
  planType: "ALL_MARKETS",
});
console.log(`Sent the trial-ended win-back email to ${to}.`);
