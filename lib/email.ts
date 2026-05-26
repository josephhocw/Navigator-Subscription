import { Resend } from "resend";
import {
  getMarketLinks,
  getPlanDisplayName,
  parsePlanType,
  MAIN_CHANNEL_LINK,
  BILLING_PORTAL_LINK,
  type MarketLink,
} from "./plans.js";

const resend = () => new Resend(process.env.RESEND_API_KEY!);

// --- Shared helpers ---

function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<unknown> {
  return resend().emails.send({
    from: process.env.FROM_EMAIL!,
    to: opts.to,
    bcc: process.env.BCC_EMAIL,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}

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
  const { category } = parsePlanType(planType);
  const telegramButtonsHtml = generateTelegramButtons(marketLinks, category);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to RHO Navigator</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <!-- Header -->
                    <tr>
                        <td style="padding: 30px 30px 20px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Welcome to RHO Navigator</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                            <p style="margin: 10px 0 0 0; color: #666; font-size: 16px;">Your ${planName} subscription is now active.</p>
                        </td>
                    </tr>

                    <!-- Step 1: Announcement Channel -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #4CAF50;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">STEP 1: Join Our Announcement Channel</h2>
                                        <p style="margin: 0 0 15px 0; color: #666; font-size: 14px; line-height: 1.6;">Start here to get guides, updates, and resources.</p>
                                        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="border-radius: 5px; background-color: #0088cc;">
                                                    <a href="${MAIN_CHANNEL_LINK}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; text-align: center;">Join Announcement Channel</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Step 2: Telegram Signal Groups -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #2196F3;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">STEP 2: Join these Telegram Group(s) for your live signals!</h2>
                                        <p style="margin: 0 0 15px 0; color: #666; font-size: 14px; line-height: 1.6;">Get real-time trading signals for your markets:</p>
                                        ${telegramButtonsHtml}
                                        <div style="margin-top: 15px; padding: 12px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                            <p style="margin: 0; color: #666; font-size: 13px;"><strong>Important:</strong> Our bot will verify your username: <strong>${telegramUsername || "(not provided)"}</strong></p>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Step 3: TradingView -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #9C27B0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">STEP 3: TradingView Indicator Access</h2>
                                        <p style="margin: 0 0 10px 0; color: #666; font-size: 14px; line-height: 1.6;">We will send you an invite within 1 business day.</p>
                                        <div style="padding: 10px; background-color: #ffffff; border-radius: 4px;">
                                            <p style="margin: 0; color: #666; font-size: 13px;"><strong>Your TradingView username:</strong> ${tvUsername || "(not provided)"}</p>
                                        </div>
                                        <p style="margin: 10px 0 0 0; color: #999; font-size: 13px;">Check your TradingView account tomorrow to access the indicator.</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Subscription Details -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 6px; border: 1px solid #e0e0e0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Your Subscription Details</h2>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding: 6px 0; border-bottom: 1px solid #e0e0e0;">
                                                    <span style="color: #666; font-size: 14px;"><strong>Plan:</strong> ${planName}</span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; border-bottom: 1px solid #e0e0e0;">
                                                    <span style="color: #666; font-size: 14px;"><strong>Status:</strong> <span style="color: #4CAF50; font-weight: bold;">Active</span></span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0;">
                                                    <span style="color: #666; font-size: 14px;"><strong>Next Billing:</strong> ${billingEndDate}</span>
                                                </td>
                                            </tr>
                                        </table>
                                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top: 15px;">
                                            <tr>
                                                <td align="center" style="border-radius: 5px; background-color: #FF9800;">
                                                    <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: inline-block; padding: 10px 20px; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: bold;">Manage Subscription</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Happy Trading</p>
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Contact support at <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a></p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Welcome to RHO Navigator

Hi ${name},
Your ${planName} subscription is now active.

STEP 1: Join Our Announcement Channel
${MAIN_CHANNEL_LINK}

STEP 2: Join your Telegram Signal Groups
${marketLinks.map((m) => `- ${m.displayName}: ${m.url}`).join("\n")}
Important: Our bot will verify your username: ${telegramUsername || "(not provided)"}

STEP 3: TradingView Indicator Access
We will send you an invite within 1 business day.
Your TradingView username: ${tvUsername || "(not provided)"}

Subscription Details:
- Plan: ${planName}
- Status: Active
- Next Billing: ${billingEndDate}
- Manage: ${BILLING_PORTAL_LINK}

Happy Trading!
Need help? Contact @Joseph_Ho on Telegram
RHO Market Navigator | Trading Signals Service`;

  await sendEmail({
    to: email,
    subject: `Welcome to RHO Navigator - ${planName}`,
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
  const attemptLine = attemptCount > 1
    ? `This was attempt ${attemptCount}. Stripe will keep retrying for a few days.`
    : `Stripe will retry automatically over the next few days.`;
  const retryLine = nextAttemptDate
    ? `Next retry: ${nextAttemptDate}.`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment failed</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <tr>
                        <td style="padding: 30px 30px 10px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Payment failed</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 10px 30px 20px 30px;">
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                Your latest payment for the <strong>${planName}</strong> plan did not go through.
                            </p>
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                ${attemptLine} ${retryLine}
                            </p>
                            <p style="margin: 0 0 20px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                To avoid losing access, please update your card details now.
                            </p>

                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                                <tr>
                                    <td style="border-radius: 5px; background-color: #FF9800;">
                                        <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; text-align: center;">Update Payment Method</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 20px 30px;">
                            <div style="padding: 12px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                <p style="margin: 0; color: #666; font-size: 13px;">If the retries all fail, your subscription will be cancelled and you will lose access to the Telegram groups and the indicator.</p>
                            </div>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Reply to this email or message <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a> on Telegram.</p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Payment failed

Hi ${name},

Your latest payment for the ${planName} plan did not go through.
${attemptLine} ${retryLine}

To avoid losing access, please update your card details now:
${BILLING_PORTAL_LINK}

If the retries all fail, your subscription will be cancelled and you will lose access to the Telegram groups and the indicator.

Need help? Reply to this email or message @Joseph_Ho on Telegram.
RHO Market Navigator | Trading Signals Service`;

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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your subscription is set to cancel</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <tr>
                        <td style="padding: 30px 30px 10px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Your subscription is set to cancel</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 10px 30px 20px 30px;">
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                We have received your cancellation request for the <strong>${planName}</strong> plan.
                            </p>
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                Your subscription stays active until <strong>${accessEndDate}</strong>. After that, access to the Telegram groups and the indicator ends.
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 0 30px 20px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #4CAF50;">
                                <tr>
                                    <td style="padding: 20px; text-align: center;">
                                        <p style="margin: 0 0 12px 0; color: #2c3e50; font-size: 15px; font-weight: bold;">Changed your mind?</p>
                                        <p style="margin: 0 0 16px 0; color: #666; font-size: 14px; line-height: 1.6;">You can undo the cancellation any time before ${accessEndDate} and keep your subscription running.</p>
                                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                                            <tr>
                                                <td style="border-radius: 5px; background-color: #4CAF50;">
                                                    <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; text-align: center;">Undo Cancellation</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Reply to this email or message <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a> on Telegram.</p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Your subscription is set to cancel

Hi ${name},

We have received your cancellation request for the ${planName} plan.
Your subscription stays active until ${accessEndDate}. After that, access to the Telegram groups and the indicator ends.

Changed your mind? You can undo the cancellation any time before ${accessEndDate} and keep your subscription running:
${BILLING_PORTAL_LINK}

Need help? Reply to this email or message @Joseph_Ho on Telegram.
RHO Market Navigator | Trading Signals Service`;

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
  const { category } = parsePlanType(newPlanType);
  const telegramButtonsHtml = generateTelegramButtons(marketLinks, category);
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

  const groupsToLeaveHtml =
    groupsToLeave.length > 0
      ? `
                    <!-- Groups to leave -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #fff3cd; border-radius: 6px; border-left: 4px solid #ffc107;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Please leave these group(s)</h2>
                                        <p style="margin: 0 0 12px 0; color: #666; font-size: 14px; line-height: 1.6;">Your new plan does not include access to the following groups. Please leave them at your convenience.</p>
                                        <ul style="margin: 0; padding-left: 20px;">
                                            ${groupsToLeave.map((g) => `<li style="color: #666; font-size: 14px; padding: 4px 0;">${g.displayName}</li>`).join("")}
                                        </ul>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>`
      : "";

  const groupsToLeaveText =
    groupsToLeave.length > 0
      ? `\nPlease leave these groups (your new plan does not include them):\n${groupsToLeave.map((g) => `- ${g.displayName}`).join("\n")}\n`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${emailTitle}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <!-- Header -->
                    <tr>
                        <td style="padding: 30px 30px 20px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">${emailTitle}</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                            <p style="margin: 10px 0 0 0; color: #666; font-size: 16px;">Your subscription has been updated from <strong>${oldPlanName}</strong> to <strong>${newPlanName}</strong>.</p>
                        </td>
                    </tr>

                    <!-- Step 1: Telegram Signal Groups -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #2196F3;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">STEP 1: Join your Telegram signal group(s)</h2>
                                        <p style="margin: 0 0 15px 0; color: #666; font-size: 14px; line-height: 1.6;">These are the groups for your new plan:</p>
                                        ${telegramButtonsHtml}
                                        <div style="margin-top: 15px; padding: 12px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                                            <p style="margin: 0; color: #666; font-size: 13px;"><strong>Important:</strong> Our bot will verify your username: <strong>${telegramUsername || "(not provided)"}</strong></p>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    ${groupsToLeaveHtml}

                    <!-- Step 2: TradingView -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #9C27B0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">STEP 2: TradingView Indicator Access</h2>
                                        <p style="margin: 0 0 10px 0; color: #666; font-size: 14px; line-height: 1.6;">We will update your access within 1 business day.</p>
                                        <div style="padding: 10px; background-color: #ffffff; border-radius: 4px;">
                                            <p style="margin: 0; color: #666; font-size: 13px;"><strong>Your TradingView username:</strong> ${tvUsername || "(not provided)"}</p>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Subscription Details -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 6px; border: 1px solid #e0e0e0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Your Subscription Details</h2>
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding: 6px 0; border-bottom: 1px solid #e0e0e0;">
                                                    <span style="color: #666; font-size: 14px;"><strong>Plan:</strong> ${newPlanName}</span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0; border-bottom: 1px solid #e0e0e0;">
                                                    <span style="color: #666; font-size: 14px;"><strong>Status:</strong> <span style="color: #4CAF50; font-weight: bold;">Active</span></span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 6px 0;">
                                                    <span style="color: #666; font-size: 14px;"><strong>Next Billing:</strong> ${billingEndDate}</span>
                                                </td>
                                            </tr>
                                        </table>
                                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top: 15px;">
                                            <tr>
                                                <td align="center" style="border-radius: 5px; background-color: #FF9800;">
                                                    <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: inline-block; padding: 10px 20px; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: bold;">Manage Subscription</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Happy Trading</p>
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Contact support at <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a></p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `${emailTitle}

Hi ${name},
Your subscription has been updated from ${oldPlanName} to ${newPlanName}.

STEP 1: Join your Telegram signal group(s)
${marketLinks.map((m) => `- ${m.displayName}: ${m.url}`).join("\n")}
Important: Our bot will verify your username: ${telegramUsername || "(not provided)"}
${groupsToLeaveText}
STEP 2: TradingView Indicator Access
We will update your access within 1 business day.
Your TradingView username: ${tvUsername || "(not provided)"}

Subscription Details:
- Plan: ${newPlanName}
- Status: Active
- Next Billing: ${billingEndDate}
- Manage: ${BILLING_PORTAL_LINK}

Happy Trading!
Need help? Contact @Joseph_Ho on Telegram
RHO Market Navigator | Trading Signals Service`;

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
  const { email, name, currentPlanType, pendingPlanType, effectiveDate, telegramUsername, tvUsername } = data;

  const currentPlanName = getPlanDisplayName(currentPlanType);
  const pendingPlanName = getPlanDisplayName(pendingPlanType);
  const groupsToLeave = getGroupsToLeave(currentPlanType, pendingPlanType);

  const groupsToLeaveHtml =
    groupsToLeave.length > 0
      ? `
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #fff3cd; border-radius: 6px; border-left: 4px solid #ffc107;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 12px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Groups to leave on ${effectiveDate}</h2>
                                        <p style="margin: 0 0 12px 0; color: #666; font-size: 14px; line-height: 1.6;">Your new plan does not include these groups. You can leave them before ${effectiveDate}, or our bot will remove your access when the change takes effect.</p>
                                        <ul style="margin: 0; padding-left: 20px;">
                                            ${groupsToLeave.map((g) => `<li style="color: #666; font-size: 14px; padding: 4px 0;">${g.displayName}</li>`).join("")}
                                        </ul>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>`
      : "";

  const groupsToLeaveText =
    groupsToLeave.length > 0
      ? `\nGroups to leave on ${effectiveDate}:\n${groupsToLeave.map((g) => `- ${g.displayName}`).join("\n")}\n`
      : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your plan change is scheduled</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <!-- Header -->
                    <tr>
                        <td style="padding: 30px 30px 20px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Your plan change is scheduled</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                            <p style="margin: 10px 0 0 0; color: #666; font-size: 16px;">We have received your request to change from <strong>${currentPlanName}</strong> to <strong>${pendingPlanName}</strong>.</p>
                        </td>
                    </tr>

                    <!-- Current plan unchanged until date -->
                    <tr>
                        <td style="padding: 10px 30px 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #4CAF50;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 15px; font-weight: bold;">Your current plan is unchanged until ${effectiveDate}</p>
                                        <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.6;">After that, your plan changes automatically to <strong>${pendingPlanName}</strong>. There is nothing you need to do right now.</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    ${groupsToLeaveHtml}

                    <!-- TradingView -->
                    <tr>
                        <td style="padding: 15px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #9C27B0;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <h2 style="margin: 0 0 8px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">TradingView Indicator Access</h2>
                                        <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.6;">We will update your TradingView access on ${effectiveDate} when the change takes effect.</p>
                                        <div style="margin-top: 10px; padding: 10px; background-color: #ffffff; border-radius: 4px;">
                                            <p style="margin: 0; color: #666; font-size: 13px;"><strong>Your TradingView username:</strong> ${tvUsername || "(not provided)"}</p>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Changed your mind -->
                    <tr>
                        <td style="padding: 0 30px 20px 30px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8f9fa; border-radius: 6px; border-left: 4px solid #2196F3;">
                                <tr>
                                    <td style="padding: 20px; text-align: center;">
                                        <p style="margin: 0 0 12px 0; color: #2c3e50; font-size: 15px; font-weight: bold;">Changed your mind?</p>
                                        <p style="margin: 0 0 16px 0; color: #666; font-size: 14px; line-height: 1.6;">You can reverse this any time before ${effectiveDate} from your billing portal.</p>
                                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                                            <tr>
                                                <td style="border-radius: 5px; background-color: #FF9800;">
                                                    <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; text-align: center;">Manage Subscription</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Happy Trading</p>
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Contact support at <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a></p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Your plan change is scheduled

Hi ${name},

We have received your request to change from ${currentPlanName} to ${pendingPlanName}.

Your current plan is unchanged until ${effectiveDate}. After that, your plan changes automatically to ${pendingPlanName}. There is nothing you need to do right now.
${groupsToLeaveText}
TradingView Indicator Access:
We will update your TradingView access on ${effectiveDate} when the change takes effect.
Your TradingView username: ${tvUsername || "(not provided)"}

Changed your mind? You can reverse this any time before ${effectiveDate}:
${BILLING_PORTAL_LINK}

Happy Trading!
Need help? Contact @Joseph_Ho on Telegram
RHO Market Navigator | Trading Signals Service`;

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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your subscription has ended</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <tr>
                        <td style="padding: 30px 30px 10px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Your subscription has ended</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 10px 30px 20px 30px;">
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                Your <strong>${planName}</strong> subscription has been cancelled and your access has now ended.
                            </p>
                            <p style="margin: 0 0 20px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                If you have any questions, feel free to reach out.
                            </p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Happy Trading</p>
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Contact support at <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a></p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Your subscription has ended

Hi ${name},

Your ${planName} subscription has been cancelled and your access has now ended.

If you have any questions, feel free to reach out.

Happy Trading!
Need help? Contact @Joseph_Ho on Telegram
RHO Market Navigator | Trading Signals Service`;

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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your subscription is still active</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <tr>
                        <td style="padding: 30px 30px 10px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Your subscription is still active</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 10px 30px 20px 30px;">
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                Just to confirm — your cancellation has been reversed and your subscription is still running.
                            </p>
                            <p style="margin: 0 0 20px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                You are still on the <strong>${planName}</strong> plan. Nothing else has changed.
                            </p>

                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                                <tr>
                                    <td style="border-radius: 5px; background-color: #FF9800;">
                                        <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; text-align: center;">Manage Subscription</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Happy Trading</p>
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Contact support at <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a></p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Your subscription is still active

Hi ${name},

Just to confirm — your cancellation has been reversed and your subscription is still running.

You are still on the ${planName} plan. Nothing else has changed.

Manage your subscription: ${BILLING_PORTAL_LINK}

Happy Trading!
Need help? Contact @Joseph_Ho on Telegram
RHO Market Navigator | Trading Signals Service`;

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

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your scheduled plan change has been cancelled</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; background-color: #f4f4f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td align="center" style="padding: 20px 0;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 8px;">

                    <tr>
                        <td style="padding: 30px 30px 10px 30px; text-align: center;">
                            <h1 style="margin: 0 0 10px 0; color: #2c3e50; font-size: 24px; font-weight: normal;">Your scheduled plan change has been cancelled</h1>
                            <p style="margin: 0; color: #666; font-size: 16px;">Hi ${name},</p>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 10px 30px 20px 30px;">
                            <p style="margin: 0 0 12px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                Just to confirm — your scheduled change from the <strong>${planName}</strong> plan to the <strong>${pendingPlanName}</strong> plan has been cancelled. You will remain on the <strong>${planName}</strong> plan as before.
                            </p>
                            <p style="margin: 0 0 20px 0; color: #666; font-size: 15px; line-height: 1.6;">
                                Your access to the Telegram groups and the indicator is unchanged.
                            </p>

                            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                                <tr>
                                    <td style="border-radius: 5px; background-color: #FF9800;">
                                        <a href="${BILLING_PORTAL_LINK}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; text-align: center;">Manage Subscription</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px; text-align: center; border-top: 2px solid #e0e0e0;">
                            <p style="margin: 0 0 10px 0; color: #2c3e50; font-size: 16px; font-weight: bold;">Happy Trading</p>
                            <p style="margin: 0; color: #999; font-size: 13px;">Need help? Contact support at <a href="https://t.me/Joseph_Ho" style="color: #0088cc; text-decoration: none;">@Joseph_Ho</a></p>
                            <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">RHO Market Navigator | Trading Signals Service</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

  const text = `Your scheduled plan change has been cancelled

Hi ${name},

Just to confirm — your scheduled change from the ${planName} plan to the ${pendingPlanName} plan has been cancelled. You will remain on the ${planName} plan as before.

Your access to the Telegram groups and the indicator is unchanged.

Manage your subscription: ${BILLING_PORTAL_LINK}

Happy Trading!
Need help? Contact @Joseph_Ho on Telegram
RHO Market Navigator | Trading Signals Service`;

  await sendEmail({
    to: email,
    subject: `Your scheduled RHO Navigator plan change has been cancelled`,
    html,
    text,
  });
}

// --- Telegram button HTML generators (used by onboarding email) ---

function generateTelegramButtons(
  markets: MarketLink[],
  category: string
): string {
  if (category === "single") {
    return singleButton(markets[0]);
  }
  if (category === "combo" && markets.length === 2) {
    return sideBySideButtons(markets);
  }
  if (category === "combo" && markets.length === 3) {
    return threeButtonRow(markets);
  }
  if (category === "all" && markets.length === 4) {
    return twoByTwoGrid(markets);
  }
  // Fallback: stacked
  return markets.map((m) => singleButton(m)).join("");
}

function singleButton(market: MarketLink): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
        <td style="border-radius: 5px; background-color: #0088cc;">
            <a href="${market.url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 200px; text-align: center;">Join ${market.displayName}</a>
        </td>
    </tr>
</table>`;
}

function sideBySideButtons(markets: MarketLink[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
        <td style="padding-right: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[0].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[0].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
        <td>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[1].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[1].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>`;
}

function threeButtonRow(markets: MarketLink[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
        <td style="padding-right: 10px; padding-bottom: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[0].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[0].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
        <td style="padding-right: 10px; padding-bottom: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[1].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[1].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
        <td style="padding-bottom: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[2].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[2].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>`;
}

function twoByTwoGrid(markets: MarketLink[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
        <td style="padding-right: 10px; padding-bottom: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[0].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[0].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
        <td style="padding-bottom: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[1].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[1].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
    <tr>
        <td style="padding-right: 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[2].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[2].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
        <td>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td style="border-radius: 5px; background-color: #0088cc;">
                        <a href="${markets[3].url}" target="_blank" style="display: block; padding: 12px 24px; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: bold; min-width: 180px; text-align: center;">Join ${markets[3].displayName}</a>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>`;
}
