import { Resend } from "resend";
import {
  getMarketLinks,
  getPlanDisplayName,
  parsePlanType,
  MAIN_CHANNEL_LINK,
  BILLING_PORTAL_LINK,
  EMAIL_LOGO_URL,
  MASTER_GUIDE_LINK,
  ATTACH_GUIDE_LINK,
  PLACE_TRADE_LINK,
  TRADING_GUIDE_LINK,
  type MarketLink,
} from "./plans.js";

const resend = () => new Resend(process.env.RESEND_API_KEY!);

// --- Shared helpers ---

async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  // The Resend SDK does NOT throw on API errors — it resolves with
  // { data, error }. Without this check a bad API key, an unverified domain,
  // or a rejected recipient would "succeed" silently and the email would
  // simply never arrive.
  const result = await resend().emails.send({
    from: process.env.FROM_EMAIL!,
    to: opts.to,
    bcc: process.env.BCC_EMAIL,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
  if (result.error) {
    throw new Error(
      `Resend rejected "${opts.subject}" to ${opts.to}: ${result.error.message}`
    );
  }
}

// =============================================================================
// BRAND SHELL + COMPONENTS
// =============================================================================
// The RHO Navigator email look (locked 2026-06-04, brand system §Surfaces):
// "Plain & warm; small logo mark + one blue accent button. Do NOT carry the
// dark hero into email bodies — light, readable email wins." Light card on a
// soft blue-grey, Plus Jakarta Sans (Arial fallback where webfonts are blocked),
// 16–17px body, high contrast — sized for a 50s–60s audience.

const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const INK = "#0c1a33"; // headings
const BODY_TEXT = "#38475f"; // body copy (AA on white)
const MUTED = "#5b6b82"; // captions / help text
const BLUE = "#1f6fff"; // primary accent
const WELL = "#f5f9ff"; // step / section wells
const WELL_BORDER = "#e2ebfa";
const INFO = "#eaf2ff"; // info-note tint
const CARD_BORDER = "#e6ecf6";

/** Full HTML document: page bg, the branded card (top strip + logo header),
 *  then the caller's content rows, closed off. Content rows own their own
 *  title, body sections, and footer (see footerRow / titleRow helpers). */
function emailShell(opts: {
  title: string;
  preheader?: string;
  contentRows: string;
}): string {
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${opts.preheader}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${opts.title}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
  a.btn:hover { filter:brightness(1.06); }
  @media (max-width:620px){ .em-pad { padding-left:22px !important; padding-right:22px !important; } }
</style>
</head>
<body style="margin:0; padding:0; background:#dde5f0; -webkit-font-smoothing:antialiased;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#dde5f0;">
<tr><td align="center" style="padding:24px 12px 40px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 20px 60px -34px rgba(12,26,51,.55); border:1px solid ${CARD_BORDER};">
    <tr><td style="height:5px; background:linear-gradient(90deg,#1f6fff,#38bdf8); font-size:0; line-height:0;">&nbsp;</td></tr>
    <tr><td class="em-pad" align="center" style="padding:34px 40px 8px;">
      <img src="${EMAIL_LOGO_URL}" width="56" height="56" alt="RHO Navigator" style="display:block; border-radius:13px; margin:0 auto 14px;">
      <div style="font-family:${FONT}; font-size:15px; font-weight:800; letter-spacing:.3px; color:${INK};">RHO <span style="color:#8aa0c0;">NAVIGATOR</span></div>
    </td></tr>
${opts.contentRows}
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** Centred title + subtitle block, sits under the logo header. */
function titleRow(h1: string, subHtml: string): string {
  return `    <tr><td class="em-pad" align="center" style="padding:14px 44px 6px;">
      <h1 style="margin:0 0 12px; font-family:${FONT}; font-size:27px; font-weight:800; letter-spacing:-.5px; line-height:1.18; color:${INK};">${h1}</h1>
      <p style="margin:0; font-family:${FONT}; font-size:17px; line-height:1.6; color:${BODY_TEXT};">${subHtml}</p>
    </td></tr>`;
}

/** Numbered step well. `body` is raw HTML (paragraphs, buttons, notes). */
function stepBox(num: number, title: string, body: string, topPad = 16): string {
  return `    <tr><td class="em-pad" style="padding:${topPad}px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${WELL}; border:1px solid ${WELL_BORDER}; border-radius:14px;">
        <tr><td style="padding:22px 22px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" style="width:34px;"><div style="width:34px; height:34px; border-radius:999px; background:${BLUE}; color:#fff; font-family:${FONT}; font-size:16px; font-weight:800; text-align:center; line-height:34px;">${num}</div></td>
            <td valign="middle" style="padding-left:12px; font-family:${FONT}; font-size:19px; font-weight:700; color:${INK};">${title}</td>
          </tr></table>
          ${body}
        </td></tr>
      </table>
    </td></tr>`;
}

/** Plain light well without a number badge. */
function plainWell(body: string, topPad = 16): string {
  return `    <tr><td class="em-pad" style="padding:${topPad}px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${WELL}; border:1px solid ${WELL_BORDER}; border-radius:14px;">
        <tr><td style="padding:22px 22px 24px;">${body}</td></tr>
      </table>
    </td></tr>`;
}

type ButtonVariant = "primary" | "dark" | "outline";

function button(href: string, label: string, variant: ButtonVariant = "primary"): string {
  const base = `display:inline-block; text-decoration:none; font-family:${FONT}; font-weight:700; line-height:1; border-radius:999px;`;
  const styles: Record<ButtonVariant, string> = {
    primary: `${base} background:${BLUE}; color:#ffffff; font-size:16px; padding:15px 28px; box-shadow:0 12px 26px -14px rgba(31,111,255,.85);`,
    dark: `${base} background:#0f1c33; color:#ffffff; font-size:15px; padding:14px 22px;`,
    outline: `${base} background:#ffffff; color:${BLUE}; font-size:15px; padding:13px 24px; border:1.5px solid ${BLUE};`,
  };
  return `<a class="btn" href="${href}" target="_blank" style="${styles[variant]}">${label}</a>`;
}

/** Light-blue info note (username verification, small confirmations). */
function infoNote(html: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px; background:${INFO}; border-radius:10px;"><tr>
            <td style="padding:12px 14px; font-family:${FONT}; font-size:14px; line-height:1.5; color:#334867;">${html}</td>
          </tr></table>`;
}

function para(html: string, mt = 14, mb = 0): string {
  return `<p style="margin:${mt}px 0 ${mb}px; font-family:${FONT}; font-size:16px; line-height:1.6; color:${BODY_TEXT};">${html}</p>`;
}

/** Standard footer row. `heading` optional (e.g. "Happy trading"). */
function footerRow(lines: string[], heading?: string): string {
  const head = heading
    ? `<p style="margin:0 0 8px; font-family:${FONT}; font-size:16px; font-weight:700; color:${INK};">${heading}</p>`
    : "";
  const body = lines
    .map(
      (l) =>
        `<p style="margin:0 0 4px; font-family:${FONT}; font-size:14px; line-height:1.6; color:${MUTED};">${l}</p>`
    )
    .join("\n      ");
  return `    <tr><td class="em-pad" align="center" style="padding:30px 40px 34px;">
      <div style="height:1px; background:#eef2f8; margin-bottom:22px;"></div>
      ${head}
      ${body}
      <p style="margin:12px 0 0; font-family:${FONT}; font-size:12px; color:#93a1b8;">RHO Navigator · Trading signals service</p>
    </td></tr>`;
}

const SUPPORT_LINE = `Need help? Message <a href="https://t.me/Joseph_Ho" style="color:${BLUE}; text-decoration:none; font-weight:700;">@Joseph_Ho</a> on Telegram.`;

// --- Onboarding email (new subscribers + reactivations) ---

export interface OnboardingEmailData {
  email: string;
  name: string;
  planType: string;
  tvUsername: string;
  telegramUsername: string;
  billingEndDate: string; // formatted display date
}

export async function sendOnboardingEmail(
  data: OnboardingEmailData
): Promise<void> {
  const { email, name, planType, tvUsername, telegramUsername, billingEndDate } =
    data;
  const marketLinks = getMarketLinks(planType);
  const planName = getPlanDisplayName(planType);
  const telegramButtonsHtml = generateTelegramButtons(marketLinks);

  const step1 =
    para("Start here. This is where the guides, updates and resources land.", 14, 18) +
    button(MAIN_CHANNEL_LINK, "Join the channel", "primary");

  const step2 =
    para("Tap each button to enter the live signal group for that market.", 14, 16) +
    telegramButtonsHtml +
    infoNote(
      `Our bot checks your Telegram username: <strong style="color:${BLUE};">${telegramUsername || "(not provided)"}</strong>`
    );

  const attachSteps = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff; border:1px solid ${WELL_BORDER}; border-radius:10px; margin-bottom:16px;"><tr><td style="padding:14px 16px;">
            <p style="margin:0 0 9px; font-family:${FONT}; font-size:15px; line-height:1.5; color:${BODY_TEXT};"><strong style="color:${BLUE};">1.</strong>&nbsp;&nbsp;Log in to TradingView and open your chart.</p>
            <p style="margin:0 0 9px; font-family:${FONT}; font-size:15px; line-height:1.5; color:${BODY_TEXT};"><strong style="color:${BLUE};">2.</strong>&nbsp;&nbsp;Click <strong style="color:${INK};">Indicators</strong>, then the <strong style="color:${INK};">Invite-Only</strong> tab.</p>
            <p style="margin:0; font-family:${FONT}; font-size:15px; line-height:1.5; color:${BODY_TEXT};"><strong style="color:${BLUE};">3.</strong>&nbsp;&nbsp;Left-click <strong style="color:${INK};">RHO Navigator</strong> once, and it's on your chart.</p>
          </td></tr></table>`;

  const step3 =
    para(
      `Your access switches on by <strong style="color:${INK};">12 noon Singapore time the next day</strong>. Once it's on, here's how to add the Navigator to a chart:`,
      14,
      14
    ) +
    attachSteps +
    `<p style="margin:0 0 16px; font-family:${FONT}; font-size:15px; line-height:1.55; color:${MUTED};">New to TradingView? The full walk-through with screenshots is worth a look.</p>` +
    button(ATTACH_GUIDE_LINK, "How to attach the Navigator", "outline") +
    infoNote(
      `We switch it on for your TradingView username: <strong style="color:${BLUE};">${tvUsername || "(not provided)"}</strong>`
    );

  const step4 =
    para(
      "The signals make more sense once you know the tool behind them. Our guide walks you through every feature on the chart, how to trade with it, and how to read the signals. Don't skip the four core skills — that's the real groundwork.",
      14,
      18
    ) +
    button(MASTER_GUIDE_LINK, "Open the Master guide", "primary");

  const detailsRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${CARD_BORDER}; border-radius:14px;">
        <tr><td style="padding:22px 22px 24px;">
          <div style="font-family:${FONT}; font-size:15px; font-weight:800; letter-spacing:.3px; color:${INK}; margin-bottom:14px;">Your subscription</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${FONT}; font-size:15px; color:${BODY_TEXT};">
            <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Plan</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${planName}</td></tr>
            <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Status</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:#16a34a; font-weight:700;">● Active</td></tr>
            <tr><td style="padding:7px 0;">Next billing</td><td align="right" style="padding:7px 0; color:${INK}; font-weight:700;">${billingEndDate}</td></tr>
          </table>
          <div style="margin-top:18px;">${button(BILLING_PORTAL_LINK, "Manage subscription", "outline")}</div>
        </td></tr>
      </table>
    </td></tr>`;

  const contentRows = [
    titleRow(
      "Welcome to RHO Navigator",
      `Hi ${name}, your <strong style="color:${INK};">${planName}</strong> subscription is now active. Here's how to get set up.`
    ),
    stepBox(1, "Join the announcement channel", step1, 20),
    stepBox(2, "Join your signal groups", step2),
    stepBox(3, "Attach the Navigator to your charts", step3),
    stepBox(4, "Get to know the Navigator", step4),
    detailsRow,
    footerRow([SUPPORT_LINE], "Happy trading"),
  ].join("\n");

  const html = emailShell({
    title: "Welcome to RHO Navigator",
    preheader: "Your subscription is active — here's how to get set up.",
    contentRows,
  });

  const text = `Welcome to RHO Navigator

Hi ${name},
Your ${planName} subscription is now active. Here's how to get set up.

STEP 1: Join the announcement channel (guides, updates, resources)
${MAIN_CHANNEL_LINK}

STEP 2: Join your signal groups
${marketLinks.map((m) => `- ${m.displayName}: ${m.url}`).join("\n")}
Our bot checks your Telegram username: ${telegramUsername || "(not provided)"}

STEP 3: Attach the Navigator to your charts
Your access switches on by 12 noon Singapore time the next day. Once it's on:
1. Log in to TradingView and open your chart.
2. Click Indicators, then the Invite-Only tab.
3. Left-click RHO Navigator once, and it's on your chart.
Full walk-through: ${ATTACH_GUIDE_LINK}
We switch it on for your TradingView username: ${tvUsername || "(not provided)"}

STEP 4: Get to know the Navigator
Our guide covers every feature, how to trade with it, and how to read the signals. Don't skip the four core skills.
${MASTER_GUIDE_LINK}

Your subscription:
- Plan: ${planName}
- Status: Active
- Next billing: ${billingEndDate}
- Manage: ${BILLING_PORTAL_LINK}

Happy trading!
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Welcome to RHO Navigator - ${planName}`,
    html,
    text,
  });
}

// --- Onboarding follow-up email (day 3: Pepperstone + free TradingView) ---

export interface FollowupEmailData {
  email: string;
  name: string;
}

export async function sendFollowupEmail(data: FollowupEmailData): Promise<void> {
  const { email, name } = data;

  const valueWell = plainWell(
    para(
      `When you open a Pepperstone account through our link and place one trade, Pepperstone gives you 3 months of TradingView Premium free. That's about <strong style="color:${INK};">$297 SGD</strong> you don't pay. Premium lets you set far more alerts and run more charts, so the Navigator is easier to use day to day.`,
      0,
      0
    ),
    22
  );

  const stepRow = (n: number, html: string, last = false) =>
    `<tr>
          <td valign="top" style="width:34px; ${last ? "" : "padding-bottom:16px;"}"><div style="width:34px; height:34px; border-radius:999px; background:${BLUE}; color:#fff; font-family:${FONT}; font-size:16px; font-weight:800; text-align:center; line-height:34px;">${n}</div></td>
          <td valign="middle" style="padding:0 0 ${last ? "0" : "16px"} 14px; font-family:${FONT}; font-size:16px; line-height:1.55; color:${BODY_TEXT};">${html}</td>
        </tr>`;

  const stepsRow = `    <tr><td class="em-pad" style="padding:20px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${stepRow(1, "Open a Pepperstone account under our link, or link your existing one to us.")}
        ${stepRow(2, "Fund it and make your first trade.")}
        ${stepRow(3, "Pepperstone emails you the coupon within a day. Apply it, and your Premium is on.", true)}
      </table>
    </td></tr>`;

  const bonusRow = `    <tr><td class="em-pad" style="padding:22px 40px 0;">
      ${para("Trading through Pepperstone also gets you a lower price on your subscription, so you come out ahead on both.", 0, 0)}
    </td></tr>`;

  const ctaRow = `    <tr><td class="em-pad" align="center" style="padding:26px 40px 4px;">
      ${para("Ready to place your first trade? We'll walk you through it step by step, right up to claiming your 3 months of TradingView Premium.", 0, 18)}
      ${button(PLACE_TRADE_LINK, "See how to place a trade", "primary")}
    </td></tr>`;

  const tradingWell = plainWell(
    `<div style="font-family:${FONT}; font-size:19px; font-weight:700; color:${INK}; margin-bottom:12px;">New to this kind of trading?</div>` +
      para(
        "If terms like CFDs, lot size, leverage and margin are new to you, start here. Our trading guide explains how it all works, the fees to expect, and the platforms you can trade on.",
        0,
        18
      ) +
      button(TRADING_GUIDE_LINK, "Read the trading guide", "outline"),
    26
  );

  const contentRows = [
    titleRow(
      "Get 3 months of TradingView Premium, free",
      `Hi ${name}, here's something worth doing in your first week or two.`
    ),
    valueWell,
    stepsRow,
    bonusRow,
    ctaRow,
    tradingWell,
    footerRow([
      `Stuck anywhere? Message <a href="https://t.me/Joseph_Ho" style="color:${BLUE}; text-decoration:none; font-weight:700;">@Joseph_Ho</a> on Telegram and I'll walk you through it.`,
    ]),
  ].join("\n");

  const html = emailShell({
    title: "Get 3 months of TradingView Premium, free",
    preheader: "Open Pepperstone, place one trade, and claim 3 months of TradingView Premium.",
    contentRows,
  });

  const text = `Get 3 months of TradingView Premium, free

Hi ${name},

Here's something worth doing in your first week or two.

When you open a Pepperstone account through our link and place one trade, Pepperstone gives you 3 months of TradingView Premium free — about $297 SGD you don't pay. Premium lets you set far more alerts and run more charts, so the Navigator is easier to use day to day.

Three steps:
1. Open a Pepperstone account under our link, or link your existing one to us.
2. Fund it and make your first trade.
3. Pepperstone emails you the coupon within a day. Apply it, and your Premium is on.

Trading through Pepperstone also gets you a lower price on your subscription, so you come out ahead on both.

Ready to place your first trade? We'll walk you through it step by step:
${PLACE_TRADE_LINK}

New to this kind of trading? If CFDs, lot size, leverage and margin are new to you, start with the trading guide — how it works, the fees, and the platforms you can use:
${TRADING_GUIDE_LINK}

Stuck anywhere? Message @Joseph_Ho on Telegram and I'll walk you through it.
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Claim your 3 months of TradingView Premium`,
    html,
    text,
  });
}

// --- Payment failed email ---

export interface PaymentFailedEmailData {
  email: string;
  name: string;
  planType: string;
  attemptCount: number;
  nextAttemptDate?: string; // optional formatted date for next retry
}

export async function sendPaymentFailedEmail(
  data: PaymentFailedEmailData
): Promise<void> {
  const { email, name, planType, attemptCount, nextAttemptDate } = data;
  const planName = getPlanDisplayName(planType);
  const attemptLine =
    attemptCount > 1
      ? `This was attempt ${attemptCount}. Stripe will keep retrying for a few days.`
      : `Stripe will retry automatically over the next few days.`;
  const retryLine = nextAttemptDate ? `Next retry: ${nextAttemptDate}.` : "";

  const bodyRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      ${para(`Your latest payment for the <strong style="color:${INK};">${planName}</strong> plan did not go through.`, 0, 12)}
      ${para(`${attemptLine} ${retryLine}`, 0, 12)}
      ${para("To avoid losing access, please update your card details now.", 0, 20)}
      <div align="center" style="text-align:center;">${button(BILLING_PORTAL_LINK, "Update payment method", "primary")}</div>
    </td></tr>`;

  const warnRow = plainWell(
    para(
      "If the retries all fail, your subscription will be cancelled and you will lose access to the Telegram groups and the indicator.",
      0,
      0
    ),
    18
  );

  const contentRows = [
    titleRow("Payment failed", `Hi ${name},`),
    bodyRow,
    warnRow,
    footerRow([SUPPORT_LINE]),
  ].join("\n");

  const html = emailShell({
    title: "Payment failed",
    preheader: "Your latest payment didn't go through — please update your card.",
    contentRows,
  });

  const text = `Payment failed

Hi ${name},

Your latest payment for the ${planName} plan did not go through.
${attemptLine} ${retryLine}

To avoid losing access, please update your card details now:
${BILLING_PORTAL_LINK}

If the retries all fail, your subscription will be cancelled and you will lose access to the Telegram groups and the indicator.

Need help? Message @Joseph_Ho on Telegram.
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Payment failed for your RHO Navigator subscription`,
    html,
    text,
  });
}

// --- Cancellation confirmation email ---

export interface CancellationEmailData {
  email: string;
  name: string;
  planType: string;
  accessEndDate: string; // formatted display date
}

export async function sendCancellationConfirmationEmail(
  data: CancellationEmailData
): Promise<void> {
  const { email, name, planType, accessEndDate } = data;
  const planName = getPlanDisplayName(planType);

  const bodyRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      ${para(`We have received your cancellation request for the <strong style="color:${INK};">${planName}</strong> plan.`, 0, 12)}
      ${para(`Your subscription stays active until <strong style="color:${INK};">${accessEndDate}</strong>. After that, access to the Telegram groups and the indicator ends.`, 0, 0)}
    </td></tr>`;

  const undoWell = plainWell(
    `<div align="center" style="text-align:center;">
      <p style="margin:0 0 12px; font-family:${FONT}; font-size:15px; font-weight:700; color:${INK};">Changed your mind?</p>
      ${para(`You can undo the cancellation any time before ${accessEndDate} and keep your subscription running.`, 0, 16)}
      ${button(BILLING_PORTAL_LINK, "Undo cancellation", "primary")}
    </div>`,
    16
  );

  const contentRows = [
    titleRow("Your subscription is set to cancel", `Hi ${name},`),
    bodyRow,
    undoWell,
    footerRow([SUPPORT_LINE]),
  ].join("\n");

  const html = emailShell({
    title: "Your subscription is set to cancel",
    preheader: `Your access continues until ${accessEndDate}. You can still undo this.`,
    contentRows,
  });

  const text = `Your subscription is set to cancel

Hi ${name},

We have received your cancellation request for the ${planName} plan.
Your subscription stays active until ${accessEndDate}. After that, access to the Telegram groups and the indicator ends.

Changed your mind? You can undo the cancellation any time before ${accessEndDate} and keep your subscription running:
${BILLING_PORTAL_LINK}

Need help? Message @Joseph_Ho on Telegram.
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Your RHO Navigator subscription is set to cancel`,
    html,
    text,
  });
}

// --- Plan change email (upgrades, downgrades, switches) ---

export interface PlanChangeEmailData {
  email: string;
  name: string;
  oldPlanType: string;
  newPlanType: string;
  changeKind: "UPGRADED" | "DOWNGRADED" | "PLAN_SWITCH";
  telegramUsername: string;
  tvUsername: string;
  billingEndDate: string;
}

function getGroupsToLeave(oldPlanType: string, newPlanType: string): MarketLink[] {
  const oldMarkets = getMarketLinks(oldPlanType);
  const { markets: newMarketCodes } = parsePlanType(newPlanType);
  const newMarketSet = new Set(newMarketCodes);
  return oldMarkets.filter((m) => !newMarketSet.has(m.code));
}

export async function sendPlanChangeEmail(
  data: PlanChangeEmailData
): Promise<void> {
  const {
    email, name, oldPlanType, newPlanType, changeKind,
    telegramUsername, tvUsername, billingEndDate,
  } = data;

  const oldPlanName = getPlanDisplayName(oldPlanType);
  const newPlanName = getPlanDisplayName(newPlanType);
  const marketLinks = getMarketLinks(newPlanType);
  const telegramButtonsHtml = generateTelegramButtons(marketLinks);
  const groupsToLeave =
    changeKind === "DOWNGRADED" ? getGroupsToLeave(oldPlanType, newPlanType) : [];

  const emailTitle =
    changeKind === "UPGRADED"
      ? "Your plan has been upgraded"
      : changeKind === "PLAN_SWITCH"
        ? "Your plan has been updated"
        : "Your plan has changed";

  const subject =
    changeKind === "UPGRADED"
      ? `Your RHO Navigator plan has been upgraded`
      : changeKind === "PLAN_SWITCH"
        ? `Your RHO Navigator plan has been updated`
        : `Your RHO Navigator plan has changed`;

  const step1 =
    para("These are the groups for your new plan.", 14, 16) +
    telegramButtonsHtml +
    infoNote(
      `Our bot checks your Telegram username: <strong style="color:${BLUE};">${telegramUsername || "(not provided)"}</strong>`
    );

  const leaveWell =
    groupsToLeave.length > 0
      ? plainWell(
          `<div style="font-family:${FONT}; font-size:17px; font-weight:700; color:${INK}; margin-bottom:10px;">Please leave these group(s)</div>` +
            para("Your new plan does not include access to the following groups. Please leave them at your convenience.", 0, 10) +
            `<ul style="margin:0; padding-left:20px; font-family:${FONT}; font-size:15px; color:${BODY_TEXT};">${groupsToLeave.map((g) => `<li style="padding:4px 0;">${g.displayName}</li>`).join("")}</ul>`
        )
      : "";

  const step2 =
    para("We will update your access within 1 business day.", 14, 12) +
    infoNote(`Your TradingView username: <strong style="color:${BLUE};">${tvUsername || "(not provided)"}</strong>`);

  const detailsRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${CARD_BORDER}; border-radius:14px;">
        <tr><td style="padding:22px 22px 24px;">
          <div style="font-family:${FONT}; font-size:15px; font-weight:800; letter-spacing:.3px; color:${INK}; margin-bottom:14px;">Your subscription</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${FONT}; font-size:15px; color:${BODY_TEXT};">
            <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Plan</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${newPlanName}</td></tr>
            <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Status</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:#16a34a; font-weight:700;">● Active</td></tr>
            <tr><td style="padding:7px 0;">Next billing</td><td align="right" style="padding:7px 0; color:${INK}; font-weight:700;">${billingEndDate}</td></tr>
          </table>
          <div style="margin-top:18px;">${button(BILLING_PORTAL_LINK, "Manage subscription", "outline")}</div>
        </td></tr>
      </table>
    </td></tr>`;

  const contentRows = [
    titleRow(
      emailTitle,
      `Hi ${name}, your subscription has been updated from <strong style="color:${INK};">${oldPlanName}</strong> to <strong style="color:${INK};">${newPlanName}</strong>.`
    ),
    stepBox(1, "Join your signal group(s)", step1, 20),
    leaveWell,
    stepBox(2, "TradingView indicator access", step2),
    detailsRow,
    footerRow([SUPPORT_LINE], "Happy trading"),
  ]
    .filter(Boolean)
    .join("\n");

  const html = emailShell({ title: emailTitle, contentRows });

  const groupsToLeaveText =
    groupsToLeave.length > 0
      ? `\nPlease leave these groups (your new plan does not include them):\n${groupsToLeave.map((g) => `- ${g.displayName}`).join("\n")}\n`
      : "";

  const text = `${emailTitle}

Hi ${name},
Your subscription has been updated from ${oldPlanName} to ${newPlanName}.

STEP 1: Join your signal group(s)
${marketLinks.map((m) => `- ${m.displayName}: ${m.url}`).join("\n")}
Our bot checks your Telegram username: ${telegramUsername || "(not provided)"}
${groupsToLeaveText}
STEP 2: TradingView indicator access
We will update your access within 1 business day.
Your TradingView username: ${tvUsername || "(not provided)"}

Your subscription:
- Plan: ${newPlanName}
- Status: Active
- Next billing: ${billingEndDate}
- Manage: ${BILLING_PORTAL_LINK}

Happy trading!
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({ to: email, subject, html, text });
}

// --- Downgrade scheduled email ---

export interface DowngradeScheduledEmailData {
  email: string;
  name: string;
  currentPlanType: string;
  pendingPlanType: string;
  effectiveDate: string; // formatted display date when the downgrade executes
  telegramUsername: string;
  tvUsername: string;
}

export async function sendDowngradeScheduledEmail(
  data: DowngradeScheduledEmailData
): Promise<void> {
  const { email, name, currentPlanType, pendingPlanType, effectiveDate, tvUsername } = data;

  const currentPlanName = getPlanDisplayName(currentPlanType);
  const pendingPlanName = getPlanDisplayName(pendingPlanType);
  const groupsToLeave = getGroupsToLeave(currentPlanType, pendingPlanType);

  const unchangedWell = plainWell(
    `<p style="margin:0 0 10px; font-family:${FONT}; font-size:15px; font-weight:700; color:${INK};">Your current plan is unchanged until ${effectiveDate}</p>` +
      para(`After that, your plan changes automatically to <strong style="color:${INK};">${pendingPlanName}</strong>. There is nothing you need to do right now.`, 0, 0),
    10
  );

  const leaveWell =
    groupsToLeave.length > 0
      ? plainWell(
          `<div style="font-family:${FONT}; font-size:17px; font-weight:700; color:${INK}; margin-bottom:10px;">Groups to leave on ${effectiveDate}</div>` +
            para(`Your new plan does not include these groups. You can leave them before ${effectiveDate}, or our bot will remove your access when the change takes effect.`, 0, 10) +
            `<ul style="margin:0; padding-left:20px; font-family:${FONT}; font-size:15px; color:${BODY_TEXT};">${groupsToLeave.map((g) => `<li style="padding:4px 0;">${g.displayName}</li>`).join("")}</ul>`
        )
      : "";

  const tvWell = plainWell(
    `<div style="font-family:${FONT}; font-size:17px; font-weight:700; color:${INK}; margin-bottom:8px;">TradingView indicator access</div>` +
      para(`We will update your TradingView access on ${effectiveDate} when the change takes effect.`, 0, 0) +
      infoNote(`Your TradingView username: <strong style="color:${BLUE};">${tvUsername || "(not provided)"}</strong>`)
  );

  const undoWell = plainWell(
    `<div align="center" style="text-align:center;">
      <p style="margin:0 0 12px; font-family:${FONT}; font-size:15px; font-weight:700; color:${INK};">Changed your mind?</p>
      ${para(`You can reverse this any time before ${effectiveDate} from your billing portal.`, 0, 16)}
      ${button(BILLING_PORTAL_LINK, "Manage subscription", "primary")}
    </div>`
  );

  const contentRows = [
    titleRow(
      "Your plan change is scheduled",
      `Hi ${name}, we have received your request to change from <strong style="color:${INK};">${currentPlanName}</strong> to <strong style="color:${INK};">${pendingPlanName}</strong>.`
    ),
    unchangedWell,
    leaveWell,
    tvWell,
    undoWell,
    footerRow([SUPPORT_LINE], "Happy trading"),
  ]
    .filter(Boolean)
    .join("\n");

  const html = emailShell({ title: "Your plan change is scheduled", contentRows });

  const groupsToLeaveText =
    groupsToLeave.length > 0
      ? `\nGroups to leave on ${effectiveDate}:\n${groupsToLeave.map((g) => `- ${g.displayName}`).join("\n")}\n`
      : "";

  const text = `Your plan change is scheduled

Hi ${name},

We have received your request to change from ${currentPlanName} to ${pendingPlanName}.

Your current plan is unchanged until ${effectiveDate}. After that, your plan changes automatically to ${pendingPlanName}. There is nothing you need to do right now.
${groupsToLeaveText}
TradingView indicator access:
We will update your TradingView access on ${effectiveDate} when the change takes effect.
Your TradingView username: ${tvUsername || "(not provided)"}

Changed your mind? You can reverse this any time before ${effectiveDate}:
${BILLING_PORTAL_LINK}

Happy trading!
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Your RHO Navigator plan change is scheduled`,
    html,
    text,
  });
}

// --- Subscription ended email (immediate/forced cancellation only) ---

export interface SubscriptionEndedEmailData {
  email: string;
  name: string;
  planType: string;
}

export async function sendSubscriptionEndedEmail(
  data: SubscriptionEndedEmailData
): Promise<void> {
  const { email, name, planType } = data;
  const planName = getPlanDisplayName(planType);

  const bodyRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      ${para(`Your <strong style="color:${INK};">${planName}</strong> subscription has been cancelled and your access has now ended.`, 0, 12)}
      ${para("If you have any questions, feel free to reach out.", 0, 0)}
    </td></tr>`;

  const contentRows = [
    titleRow("Your subscription has ended", `Hi ${name},`),
    bodyRow,
    footerRow([SUPPORT_LINE], "Happy trading"),
  ].join("\n");

  const html = emailShell({ title: "Your subscription has ended", contentRows });

  const text = `Your subscription has ended

Hi ${name},

Your ${planName} subscription has been cancelled and your access has now ended.

If you have any questions, feel free to reach out.

Happy trading!
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Your RHO Navigator subscription has ended`,
    html,
    text,
  });
}

// --- Cancellation undone email ---

export interface CancellationUndoneEmailData {
  email: string;
  name: string;
  planType: string;
}

export async function sendCancellationUndoneEmail(
  data: CancellationUndoneEmailData
): Promise<void> {
  const { email, name, planType } = data;
  const planName = getPlanDisplayName(planType);

  const bodyRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      ${para("Just to confirm — your cancellation has been reversed and your subscription is still running.", 0, 12)}
      ${para(`You are still on the <strong style="color:${INK};">${planName}</strong> plan. Nothing else has changed.`, 0, 20)}
      <div align="center" style="text-align:center;">${button(BILLING_PORTAL_LINK, "Manage subscription", "outline")}</div>
    </td></tr>`;

  const contentRows = [
    titleRow("Your subscription is still active", `Hi ${name},`),
    bodyRow,
    footerRow([SUPPORT_LINE], "Happy trading"),
  ].join("\n");

  const html = emailShell({ title: "Your subscription is still active", contentRows });

  const text = `Your subscription is still active

Hi ${name},

Just to confirm — your cancellation has been reversed and your subscription is still running.

You are still on the ${planName} plan. Nothing else has changed.

Manage your subscription: ${BILLING_PORTAL_LINK}

Happy trading!
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Your RHO Navigator subscription is still active`,
    html,
    text,
  });
}

// --- Downgrade undone email ---

export interface DowngradeUndoneEmailData {
  email: string;
  name: string;
  planType: string;
  pendingPlanType: string;
}

export async function sendDowngradeUndoneEmail(
  data: DowngradeUndoneEmailData
): Promise<void> {
  const { email, name, planType, pendingPlanType } = data;
  const planName = getPlanDisplayName(planType);
  const pendingPlanName = getPlanDisplayName(pendingPlanType);

  const bodyRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      ${para(`Just to confirm — your scheduled change from the <strong style="color:${INK};">${planName}</strong> plan to the <strong style="color:${INK};">${pendingPlanName}</strong> plan has been cancelled. You will remain on the <strong style="color:${INK};">${planName}</strong> plan as before.`, 0, 12)}
      ${para("Your access to the Telegram groups and the indicator is unchanged.", 0, 20)}
      <div align="center" style="text-align:center;">${button(BILLING_PORTAL_LINK, "Manage subscription", "outline")}</div>
    </td></tr>`;

  const contentRows = [
    titleRow("Your scheduled plan change has been cancelled", `Hi ${name},`),
    bodyRow,
    footerRow([SUPPORT_LINE], "Happy trading"),
  ].join("\n");

  const html = emailShell({
    title: "Your scheduled plan change has been cancelled",
    contentRows,
  });

  const text = `Your scheduled plan change has been cancelled

Hi ${name},

Just to confirm — your scheduled change from the ${planName} plan to the ${pendingPlanName} plan has been cancelled. You will remain on the ${planName} plan as before.

Your access to the Telegram groups and the indicator is unchanged.

Manage your subscription: ${BILLING_PORTAL_LINK}

Happy trading!
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({
    to: email,
    subject: `Your scheduled RHO Navigator plan change has been cancelled`,
    html,
    text,
  });
}

// --- Telegram button HTML generator (used by onboarding + plan-change emails) ---

// Stack each market as its own dark pill, one per line. Simpler and more legible
// than side-by-side rows for a 50s–60s audience, and it never overflows on
// mobile for the 3- and 4-market plans.
function generateTelegramButtons(markets: MarketLink[]): string {
  return markets
    .map(
      (m) =>
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;"><tr><td>${button(m.url, `Join ${m.displayName}`, "dark")}</td></tr></table>`
    )
    .join("");
}
