// Renders every annual-plan email variant to files WITHOUT sending anything:
// fetch is stubbed before the mailer loads, so the Resend call is captured
// locally and never reaches the network. For Joseph's wording sign-off.
//
// Run: npx tsx scripts/dump-annual-emails.mts <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: dump-annual-emails.mts <out-dir>");
mkdirSync(outDir, { recursive: true });

process.env.RESEND_API_KEY = "re_fake_key_never_used";
process.env.FROM_EMAIL = "RHO Navigator <rho_navigator@robinhosmartrade.com>";
delete process.env.BCC_EMAIL;

let current = "unnamed";
globalThis.fetch = (async (_url: unknown, opts: { body?: string }) => {
  const body = JSON.parse(opts?.body ?? "{}");
  writeFileSync(join(outDir, `${current}.html`), body.html, "utf8");
  writeFileSync(join(outDir, `${current}.txt`), `Subject: ${body.subject}\n\n${body.text}`, "utf8");
  return new Response(JSON.stringify({ id: "captured-not-sent" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { sendAnnualOfferEmail, sendAnnualSwitchEmail } = await import("../lib/email.js");

const link = "https://rho-market-navigator.vercel.app/annual?t=EXAMPLE_TOKEN";
const base = { email: "subscriber@example.com", name: "Robin Ho", link };

const runs: Array<[string, () => Promise<void>]> = [
  ["offer-existing-all-markets-pepperstone", () => sendAnnualOfferEmail({ ...base, planType: "ALL_MARKETS", currentPrice: 387, annualPrice: 1290, grandfathered: false, audience: "existing", phase: "offer" })],
  ["offer-existing-us-grandfathered", () => sendAnnualOfferEmail({ ...base, planType: "US", currentPrice: 147, annualPrice: 490, grandfathered: true, audience: "existing", phase: "offer" })],
  ["reminder-existing", () => sendAnnualOfferEmail({ ...base, planType: "ALL_MARKETS", currentPrice: 387, annualPrice: 1290, grandfathered: false, audience: "existing", phase: "reminder" })],
  ["lastcall-existing", () => sendAnnualOfferEmail({ ...base, planType: "ALL_MARKETS", currentPrice: 387, annualPrice: 1290, grandfathered: false, audience: "existing", phase: "lastcall" })],
  ["offer-trial", () => sendAnnualOfferEmail({ ...base, planType: "ALL_MARKETS", currentPrice: 0, annualPrice: 1390, grandfathered: false, audience: "trial", phase: "offer", trialEnd: "18 October 2026, 11:59pm" })],
  ["lastcall-trial", () => sendAnnualOfferEmail({ ...base, planType: "ALL_MARKETS", currentPrice: 0, annualPrice: 1390, grandfathered: false, audience: "trial", phase: "lastcall", trialEnd: "18 October 2026, 11:59pm" })],
  ["confirmation-active", () => sendAnnualSwitchEmail({ email: base.email, name: base.name, planType: "ALL_MARKETS", annualPrice: 1290, chargedToday: 987.6, newExpiry: "12 October 2027 20:15", onTrial: false })],
  ["confirmation-trial", () => sendAnnualSwitchEmail({ email: base.email, name: base.name, planType: "ALL_MARKETS", annualPrice: 1390, chargedToday: null, newExpiry: "18 October 2026 23:59", onTrial: true })],
];

for (const [name, fn] of runs) {
  current = name;
  await fn();
  console.log(`captured ${name}`);
}
console.log(`\nWrote ${runs.length} variants to ${outDir} (nothing was sent).`);
