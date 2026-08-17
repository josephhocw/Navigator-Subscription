// Sends a real copy of the cancellation-confirmation email to a test address,
// using the live template code. Touches no sheet, no Stripe, and no subscriber —
// it only calls the mailer function.
//
// Run: npx tsx scripts/send-test-cancellation.mts [email] [name]
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

const { sendCancellationConfirmationEmail } = await import("../lib/email.js");
const { formatDisplayDateSGT } = await import("../lib/format-date.js");

// Mirror a typical quarterly subscriber: All Markets, access ends one quarter out.
const accessEndDate = formatDisplayDateSGT(new Date("2026-11-16T23:59:00+08:00"));

await sendCancellationConfirmationEmail({
  email: to,
  name,
  planType: "ALL_MARKETS",
  accessEndDate,
});
console.log(`Sent the cancellation-confirmation email to ${to}.`);
