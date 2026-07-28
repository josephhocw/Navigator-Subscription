// Sends ONE real copy of the T+1 follow-up email (Pepperstone + free
// TradingView) to a test address, using the live template code. Touches no
// sheet, no Stripe, and no subscriber — it only calls sendFollowupEmail.
//
// Run: npx tsx scripts/send-test-followup.mts [email] [name]
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

const { sendFollowupEmail } = await import("../lib/email.js");
await sendFollowupEmail({ email: to, name });
console.log(`Sent the follow-up email to ${to} (name: ${name}).`);
