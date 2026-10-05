// api/annual-switch.ts
// =============================================================================
// ANNUAL SWITCH ENDPOINT — behind the signed magic link (lib/annual-link.ts).
//   GET  /api/annual-switch?t=<token>   -> preview (what will happen)
//   POST /api/annual-switch  {t}        -> perform the switch
// Logic lives in lib/annual-switch.ts; this file only does HTTP + wiring.
// Same-origin with the Astro site (web/dist + api/ deploy together), so the
// page fetches it relatively and no CORS is needed.
// =============================================================================
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { previewAnnual, performAnnual } from "../lib/annual-switch.js";
import { StripeAnnualClient } from "../lib/annual-switch-stripe.js";
import { notifyAdmin } from "../lib/telegram.js";

const stripe = () => new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-08-27.basil" });

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const secret = process.env.ANNUAL_LINK_SECRET;
  if (!secret) {
    res.status(500).json({ ok: false, reason: "invalid", detail: "ANNUAL_LINK_SECRET not set" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");

  const token =
    req.method === "GET"
      ? String(req.query.t ?? "")
      : String((req.body as { t?: string } | undefined)?.t ?? "");
  if (!token) {
    res.status(400).json({ ok: false, reason: "invalid" });
    return;
  }

  const client = new StripeAnnualClient(stripe());
  try {
    if (req.method === "GET") {
      res.status(200).json(await previewAnnual(client, token, secret));
      return;
    }
    if (req.method === "POST") {
      res.status(200).json(await performAnnual(client, token, secret, notifyAdmin));
      return;
    }
    res.status(405).json({ ok: false, reason: "invalid" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("annual-switch failed:", message);
    await notifyAdmin(`<b>❌ Annual switch error</b>\n${message}`).catch(() => {});
    res.status(500).json({ ok: false, reason: "ineligible", detail: "Something went wrong on our side." });
  }
}
