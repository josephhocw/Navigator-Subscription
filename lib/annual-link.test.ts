import { describe, it, expect } from "vitest";
import { signAnnualLink, verifyAnnualLink, annualLinkUrl } from "./annual-link.js";

const SECRET = "test-secret-please-rotate";

describe("annual link token", () => {
  it("round-trips", () => {
    const t = signAnnualLink("sub_123", "Ann@Example.com", SECRET);
    expect(verifyAnnualLink(t, SECRET)).toEqual({ subscriptionId: "sub_123", email: "ann@example.com" });
  });

  it("is URL-safe and carries no raw email", () => {
    const t = signAnnualLink("sub_123", "ann@example.com", SECRET);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toContain("@");
  });

  it("rejects a tampered token, a wrong secret and garbage", () => {
    const t = signAnnualLink("sub_123", "ann@example.com", SECRET);
    expect(verifyAnnualLink(t.slice(0, -2) + "zz", SECRET)).toBeNull();
    expect(verifyAnnualLink(t, "other")).toBeNull();
    expect(verifyAnnualLink("", SECRET)).toBeNull();
    expect(verifyAnnualLink("not-base64!!", SECRET)).toBeNull();
  });

  it("builds the page URL", () => {
    const url = annualLinkUrl("sub_123", "ann@example.com", SECRET, "https://example.test");
    expect(url.startsWith("https://example.test/annual?t=")).toBe(true);
    expect(verifyAnnualLink(new URL(url).searchParams.get("t")!, SECRET)?.subscriptionId).toBe("sub_123");
  });
});
