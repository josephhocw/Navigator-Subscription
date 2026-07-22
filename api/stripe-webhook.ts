// =============================================================================
// STRIPE WEBHOOK — THE EDGE
// =============================================================================
// This is the front door. When Stripe sends a webhook event (new sub, renewal,
// cancellation, etc.) it hits this file first.
//
// Job of this file (and ONLY this file):
//   1. Make sure the request is really from Stripe (signature check).
//   2. Read the raw body Stripe sent.
//   3. Hand the event to the translator.
//   4. Hand each resulting "note" (SubscriberAction) to the lifecycle.
//   5. If anything blows up, ping Joseph on Telegram so he knows.
//
// What this file does NOT do:
//   - It does not contain any subscription rules.
//   - It does not talk to the Google Sheet directly.
//   - It does not send any customer emails directly.
//
// All of that lives in the lifecycle module.
// =============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { translate } from "../lib/stripe-translator.js";
import { SubscriptionLifecycle } from "../lib/subscription-lifecycle.js";
import { SheetsSubscriberStore } from "../lib/subscriber-store.js";
import { SheetsEventLog } from "../lib/event-log.js";
import {
  sendOnboardingEmail,
  sendPaymentFailedEmail,
  sendCancellationConfirmationEmail,
  sendCancellationUndoneEmail,
  sendSubscriptionEndedEmail,
  sendPlanChangeEmail,
  sendDowngradeScheduledEmail,
  sendDowngradeUndoneEmail,
} from "../lib/email.js";
import { notifyAdmin } from "../lib/telegram.js";
import {
  TradingViewAccessClient,
  NoopTradingViewGranter,
  type TradingViewGranter,
} from "../lib/tradingview-access.js";

// Build the TradingView granter. Needs the logged-in session cookie (two parts)
// as env vars. If either is missing, fall back to a no-op that logs — the
// webhook keeps working and Joseph grants access manually until the cookie is
// set/refreshed.
function buildTradingViewGranter(): TradingViewGranter {
  const sessionId = process.env.TRADINGVIEW_SESSIONID;
  const sessionIdSign = process.env.TRADINGVIEW_SESSIONID_SIGN;
  if (!sessionId || !sessionIdSign) {
    console.warn(
      "TRADINGVIEW_SESSIONID / _SIGN not set — TradingView grants disabled (manual fallback)"
    );
    return new NoopTradingViewGranter();
  }
  return new TradingViewAccessClient({ sessionId, sessionIdSign });
}

// A Stripe client, created on demand (so the env var is read at runtime, not
// import time — important on Vercel). apiVersion is pinned to match the webhook
// endpoint version in the Stripe dashboard, so payload shapes (e.g. invoice.parent.
// subscription_details.subscription) stay in lockstep with the SDK's types.
const stripe = () => new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-08-27.basil",
});

// Tell Vercel NOT to parse the body. Stripe's signature check requires the
// raw, untouched bytes — if Vercel parses it into JSON first, the signature
// would no longer match.
export const config = {
  api: { bodyParser: false },
};

// Read the raw HTTP body into a Buffer. This is the buffer Stripe will check
// the signature against.
async function getRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// -----------------------------------------------------------------------------
// Build a lifecycle instance with its three collaborators wired up:
//   - store     → reads/writes the Google Sheet
//   - mailer    → sends customer emails via Resend
//   - notifier  → sends admin pings via Telegram
//
// The mailer and notifier here are plain object literals — they just point at
// the existing functions in lib/email.ts and lib/telegram.ts. In a test, you'd
// pass in fakes instead.
// -----------------------------------------------------------------------------
function buildLifecycle(): SubscriptionLifecycle {
  const suppressEmails = process.env.SUPPRESS_CUSTOMER_EMAILS === "true";

  // During a shadow/parallel run alongside Zapier, set SUPPRESS_CUSTOMER_EMAILS=true
  // so subscribers don't receive duplicate emails. Sheet writes and Telegram pings
  // still fire normally — only outbound customer emails are suppressed.
  const noop = async () => {};

  return new SubscriptionLifecycle(
    new SheetsSubscriberStore(),
    suppressEmails
      ? {
          sendOnboarding: noop,
          sendPaymentFailed: noop,
          sendCancellationConfirmation: noop,
          sendCancellationUndone: noop,
          sendSubscriptionEnded: noop,
          sendPlanChange: noop,
          sendDowngradeScheduled: noop,
          sendDowngradeUndone: noop,
        }
      : {
          sendOnboarding: sendOnboardingEmail,
          sendPaymentFailed: sendPaymentFailedEmail,
          sendCancellationConfirmation: sendCancellationConfirmationEmail,
          sendCancellationUndone: sendCancellationUndoneEmail,
          sendSubscriptionEnded: sendSubscriptionEndedEmail,
          sendPlanChange: sendPlanChangeEmail,
          sendDowngradeScheduled: sendDowngradeScheduledEmail,
          sendDowngradeUndone: sendDowngradeUndoneEmail,
        },
    { notify: notifyAdmin },
    new SheetsEventLog(),
    buildTradingViewGranter()
  );
}

// =============================================================================
// The actual webhook handler — Vercel calls this on every POST.
// =============================================================================
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only POST requests are valid webhooks. Anything else gets 405.
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Stripe must include this header on every legitimate webhook.
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  // ---------------------------------------------------------------------------
  // STEP 1 — verify the signature.
  // If this throws, the request did not come from Stripe (or our secret is
  // wrong). Either way: reject with 400, do not process.
  // ---------------------------------------------------------------------------
  const stripeClient = stripe();
  let event: Stripe.Event;
  try {
    const rawBody = await getRawBody(req);
    event = stripeClient.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Signature verification failed:", message);
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  console.log(`Stripe event: ${event.type} | ${event.id}`);

  // ---------------------------------------------------------------------------
  // STEP 2 — translate the event into 0..N "notes" (SubscriberActions).
  // STEP 3 — feed each note to the lifecycle, which runs the rule.
  //
  // If anything in here throws, we ping Joseph on Telegram with the error and
  // return 500. Stripe will retry the event automatically on 5xx.
  // ---------------------------------------------------------------------------
  try {
    const actions = await translate(event, stripeClient);
    if (actions.length === 0) {
      console.log(`No actions for event type: ${event.type}`);
    }
    const lifecycle = buildLifecycle();
    for (const action of actions) {
      await lifecycle.apply(action);
    }
    res.status(200).json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error handling ${event.type}:`, message);

    // Best-effort admin notification. If even the Telegram ping fails, we
    // only log it — we don't want one failure to mask another.
    await notifyAdmin(
      `<b>Webhook Error</b>\nEvent: ${event.type}\nID: ${event.id}\nError: ${message}`
    ).catch((telegramErr) =>
      console.error("Failed to send Telegram error alert:", telegramErr)
    );

    res.status(500).json({ error: "Internal handler error" });
  }
}
