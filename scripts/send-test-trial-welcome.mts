// Sends a real copy of the TRIAL onboarding (welcome) email to a test address,
// using the live template code — exactly what a drwealth-aug27 trial sign-up
// receives: trial variant (no Telegram buttons), "First charge" framing, and
// the cohort's standardised 6 September date while the cutoff is in the future.
// Touches no sheet, no Stripe, and no subscriber — it only calls the mailer.
//
// Run: npx tsx scripts/send-test-trial-welcome.mts [email] [name] [ref]
import { readFileSync } from "node:fs";

const to = process.argv[2] || "joseph.ho1996@gmail.com";
const name = process.argv[3] || "Joseph";
const ref = process.argv[4] || "drwealth-aug27";

// Load the keys the mailer needs straight from .env (local-dev file).
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const key of ["RESEND_API_KEY", "FROM_EMAIL"]) {
  const line = env.split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} not found in .env`);
  process.env[key] = line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
}
delete process.env.BCC_EMAIL; // a test shouldn't copy the business inbox

const { sendOnboardingEmail } = await import("../lib/email.js");
const { formatDisplayDateSGT } = await import("../lib/format-date.js");

// Mirror a real drwealth-aug27 trialist: All Markets, 10-day trial from now.
// While today is on/before 6 Sep the email must show the cohort's
// "6 September 2026, 11:59pm" instead of this rolling date.
const rollingTrialEnd = formatDisplayDateSGT(
  new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
);

await sendOnboardingEmail({
  email: to,
  name,
  planType: "ALL_MARKETS",
  tvUsername: "josephho96",
  telegramUsername: "Joseph_Ho",
  billingEndDate: rollingTrialEnd,
  isTrial: true,
  referralSource: ref,
});
console.log(`Sent the trial welcome email (ref ${ref}) to ${to}.`);
