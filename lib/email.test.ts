// Trial-welcome cohort dates. The trial onboarding email promises the COHORT's
// standardised first-charge date, not the subscriber's raw rolling trial end —
// but only while the cohort's cutoff is in the future. Past the cutoff the
// hardcode self-expires and the email falls back to the real trial end
// (billingEndDate). These tests pin both sides of that line for the
// DrWealth 27 Aug cohort (ref "drwealth-aug27", first charge 6 Sep 2026).
//
// Resend is mocked out — nothing here sends a real email.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sends: Array<{ html: string; text: string; subject: string }> = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: { html: string; text: string; subject: string }) => {
        sends.push(payload);
        return { data: { id: "email_test" }, error: null };
      },
    };
  },
}));

import { sendOnboardingEmail } from "./email.js";

const trialSignup = (referralSource: string | null) => ({
  email: "trialist@example.com",
  name: "Trial Person",
  planType: "ALL_MARKETS",
  tvUsername: "trialperson",
  telegramUsername: "trialperson",
  // The subscriber's REAL rolling trial end, as the caller formats it.
  billingEndDate: "10 September 2026 21:30",
  isTrial: true,
  referralSource,
});

describe("trial welcome — DrWealth 27 Aug cohort date", () => {
  beforeEach(() => {
    sends.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the standardised 6 September date for a sign-up before the cutoff", async () => {
    // Webinar night: 27 Aug 2026, 22:00 SGT.
    vi.setSystemTime(new Date("2026-08-27T22:00:00+08:00"));
    await sendOnboardingEmail(trialSignup("drwealth-aug27"));

    expect(sends).toHaveLength(1);
    const { html, text } = sends[0];
    expect(html).toContain("6 September 2026, 11:59pm");
    expect(html).toContain("free trial is active until <strong");
    expect(html).toContain("6 September</strong>");
    expect(text).toContain("First charge: 6 September 2026, 11:59pm");
    expect(text).toContain("free trial is active until 6 September.");
    // The cohort date replaces the rolling date entirely.
    expect(html).not.toContain("10 September 2026 21:30");
    expect(text).not.toContain("10 September 2026 21:30");
  });

  it("shows a sign-up on the cutoff day the cohort date too", async () => {
    vi.setSystemTime(new Date("2026-09-06T23:00:00+08:00"));
    await sendOnboardingEmail(trialSignup("drwealth-aug27"));
    expect(sends[0].text).toContain("First charge: 6 September 2026, 11:59pm");
  });

  it("shows the standardised 18 October date for the 5 Oct cohort", async () => {
    // Webinar night: 5 Oct 2026, 21:00 SGT.
    vi.setSystemTime(new Date("2026-10-05T21:00:00+08:00"));
    await sendOnboardingEmail(trialSignup("oct5"));

    expect(sends).toHaveLength(1);
    const { html, text } = sends[0];
    expect(html).toContain("18 October 2026, 11:59pm");
    expect(html).toContain("18 October</strong>");
    expect(text).toContain("First charge: 18 October 2026, 11:59pm");
    expect(text).toContain("free trial is active until 18 October.");
    expect(text).not.toContain("10 September 2026 21:30");
  });

  it("falls back to the real trial end for the 5 Oct cohort once 18 Oct has passed", async () => {
    vi.setSystemTime(new Date("2026-10-19T09:00:00+08:00"));
    await sendOnboardingEmail(trialSignup("oct5"));
    expect(sends[0].text).not.toContain("18 October 2026, 11:59pm");
    expect(sends[0].text).toContain("First charge: 10 September 2026 21:30");
  });

  it("falls back to the real trial end once the cutoff has passed", async () => {
    vi.setSystemTime(new Date("2026-09-07T09:00:00+08:00"));
    await sendOnboardingEmail(trialSignup("drwealth-aug27"));

    expect(sends).toHaveLength(1);
    const { html, text } = sends[0];
    expect(html).not.toContain("6 September 2026, 11:59pm");
    expect(text).not.toContain("6 September 2026, 11:59pm");
    expect(text).toContain("First charge: 10 September 2026 21:30");
    expect(html).toContain("10 September 2026 21:30");
  });

  it("does not give the old drwealth ref the new cohort date (its own hardcode expired 2 Aug)", async () => {
    vi.setSystemTime(new Date("2026-08-27T22:00:00+08:00"));
    await sendOnboardingEmail(trialSignup("drwealth"));
    const { text } = sends[0];
    expect(text).not.toContain("6 September 2026, 11:59pm");
    expect(text).not.toContain("16 August 2026, 11:59pm");
    expect(text).toContain("First charge: 10 September 2026 21:30");
  });
});

import { sendAnnualSwitchEmail } from "./email.js";

describe("annual switch confirmation", () => {
  beforeEach(() => { sends.length = 0; });

  it("active subscriber: states the charge today and the new expiry", async () => {
    await sendAnnualSwitchEmail({
      email: "ann@example.com", name: "Ann", planType: "ALL_MARKETS",
      annualPrice: 1290, chargedToday: 987.65, newExpiry: "5 October 2027 20:00", onTrial: false,
    });
    const { subject, text, html } = sends[0];
    expect(subject).toBe("You're on the annual plan");
    expect(text).toContain("$987.65 SGD");
    expect(text).toContain("5 October 2027");
    expect(text).toContain("$1,290 SGD");
    expect(html).toContain("All Markets");
  });

  it("trialist: nothing charged yet, annual collected at trial end", async () => {
    await sendAnnualSwitchEmail({
      email: "t@example.com", name: "Tri", planType: "ALL_MARKETS",
      annualPrice: 1390, chargedToday: null, newExpiry: "18 October 2026 23:59", onTrial: true,
    });
    expect(sends[0].text).toContain("Nothing has been charged yet");
    expect(sends[0].text).toContain("18 October 2026");
  });
});

import { sendAnnualOfferEmail } from "./email.js";

describe("annual offer email", () => {
  beforeEach(() => { sends.length = 0; });
  const base = { email: "ann@example.com", name: "Ann", planType: "ALL_MARKETS", currentPrice: 387, annualPrice: 1290, link: "https://x.test/annual?t=abc", grandfathered: false };

  it("existing subscriber offer", async () => {
    await sendAnnualOfferEmail({ ...base, audience: "existing", phase: "offer" });
    const { subject, text, html } = sends[0];
    expect(subject).toBe("Lock in your Navigator plan for a year, 2 months free");
    expect(text).toContain("$1,290 SGD");
    expect(text).toContain("$387 SGD every 3 months");
    expect(text).toContain("https://x.test/annual?t=abc");
    expect(text).toContain("30 October");
    expect(html).toContain("https://x.test/annual?t=abc");
  });

  it("trial offer mentions the trial end", async () => {
    await sendAnnualOfferEmail({ ...base, audience: "trial", phase: "offer", trialEnd: "18 October 2026, 11:59pm" });
    expect(sends[0].text).toContain("18 October 2026");
    expect(sends[0].subject).toBe("Before your trial ends: annual plan, 2 months free");
  });

  it("last call subject", async () => {
    await sendAnnualOfferEmail({ ...base, audience: "existing", phase: "lastcall" });
    expect(sends[0].subject).toBe("Last call: annual plan closes tomorrow night");
  });
});
