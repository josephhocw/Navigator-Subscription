// Writes the trial-converted welcome email's HTML to a file WITHOUT sending
// anything: fetch is stubbed before the mailer loads, so the Resend call is
// captured locally and never reaches the network. Used to screenshot the email
// for webinar slides.
//
// Run: npx tsx scripts/dump-trial-converted-html.mts <out.html>
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("usage: dump-trial-converted-html.mts <out.html>");

process.env.RESEND_API_KEY = "re_fake_key_never_used";
process.env.FROM_EMAIL = "RHO Navigator <rho_navigator@robinhosmartrade.com>";
delete process.env.BCC_EMAIL;

globalThis.fetch = (async (_url: unknown, opts: { body?: string }) => {
  const body = JSON.parse(opts?.body ?? "{}");
  writeFileSync(out, body.html, "utf8");
  return new Response(JSON.stringify({ id: "captured-not-sent" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { sendTrialConvertedWelcomeEmail } = await import("../lib/email.js");
const { formatDisplayDateSGT } = await import("../lib/format-date.js");

await sendTrialConvertedWelcomeEmail({
  email: "subscriber@example.com",
  name: "Robin",
  planType: "ALL_MARKETS",
  billingEndDate: formatDisplayDateSGT(new Date("2026-11-09T23:59:00+08:00")),
  telegramUsername: "your_username",
});
console.log(`Captured the email HTML to ${out} (nothing was sent).`);
