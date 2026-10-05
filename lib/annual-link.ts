// =============================================================================
// Per-subscriber signed link for the annual offer.
//
// token = base64url( subscriptionId | email | hmac )
//   hmac = HMAC-SHA256( secret, subscriptionId | email ) as hex
//
// Only the server holds the secret (env ANNUAL_LINK_SECRET), so nobody can mint
// a link for another subscriber, and a tampered link fails verification. The
// subscription ID is not secret (it is on invoices) — the HMAC is what makes
// the link proof of issuance. No storage: verification recomputes the HMAC.
// =============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import { SITE_URL } from "./plans.js";

const SEP = "|";

function hmacFor(subscriptionId: string, email: string, secret: string): string {
  return createHmac("sha256", secret).update(`${subscriptionId}${SEP}${email}`).digest("hex");
}

export function signAnnualLink(subscriptionId: string, email: string, secret: string): string {
  const e = email.trim().toLowerCase();
  const payload = `${subscriptionId}${SEP}${e}${SEP}${hmacFor(subscriptionId, e, secret)}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function verifyAnnualLink(
  token: string,
  secret: string
): { subscriptionId: string; email: string } | null {
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(SEP);
  if (parts.length !== 3) return null;
  const [subscriptionId, email, sig] = parts;
  if (!subscriptionId.startsWith("sub_") || !email.includes("@") || sig.length !== 64) return null;
  const expected = hmacFor(subscriptionId, email, secret);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { subscriptionId, email };
}

export function annualLinkUrl(
  subscriptionId: string,
  email: string,
  secret: string,
  siteUrl: string = SITE_URL
): string {
  return `${siteUrl}/annual?t=${signAnnualLink(subscriptionId, email, secret)}`;
}
