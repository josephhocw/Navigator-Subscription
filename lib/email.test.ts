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
