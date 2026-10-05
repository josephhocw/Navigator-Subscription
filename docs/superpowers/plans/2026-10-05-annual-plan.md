# Annual Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Navigator subscriber (and the 5 Oct trial cohort) move to a prepaid annual plan during October 2026 through a one-click signed link, with the webhook, sheet, emails, coupons and website all understanding yearly billing.

**Architecture:** The existing four-layer webhook (translator → lifecycle → store/mailer/notifier) learns a `billingInterval`; a same-plan quarter→year change becomes the `ANNUAL_SWITCH` lifecycle path. A new signed-link endpoint (`api/annual-switch.ts`, logic in `lib/annual-switch.ts`) performs the Stripe update with the billing anchor reset to now so the annual is paid before 1 Nov. The Astro site gets a Quarterly/Annual toggle and an `/annual` confirmation page. A terminal script prepares the offer emails; Joseph sends them.

**Tech Stack:** TypeScript, Vercel serverless (`api/`), Stripe SDK `^18.5.0` (apiVersion `2025-08-27.basil`), Resend, Google Sheets, Astro (`web/`), vitest.

Spec: `docs/superpowers/specs/2026-10-05-annual-plan-design.md`.

## Global Constraints

- Repo: `Navigator Business/Website` (its own git repo, branch `main`, Vercel auto-deploys on push). Commit after every task; do NOT push until Task 12 says so.
- Every task ends with `npx tsc --noEmit` and `npx vitest run` green (373 tests before this work).
- Lifecycle, coupon-sync and switch logic are tested with in-memory fakes only; no network in unit tests.
- Customer-facing copy: British spelling, plain English, no "webhook/API/Pine Script", prices as `$1,390 SGD`, "the Navigator" for existing subscribers. Joseph reviews every email's wording before it is sent; the scripts never send without `--apply`.
- Offer closes **30 Oct 2026 23:59 SGT** = `Date.UTC(2026, 9, 30, 15, 59)` ms. Use this exact constant everywhere (`ANNUAL_OFFER_CLOSES_MS`).
- Stripe live objects already exist (created 2026-10-05 by `scripts/setup-annual-prices.mts`). IDs:

| Plan | Annual list price ID | Grandfathered annual price ID | Annual payment link |
|---|---|---|---|
| SG | `price_1UN6bOPApeZiCPK2e2I1aTYS` | `price_1UN6bOPApeZiCPK2yYitohWn` | `https://buy.stripe.com/fZu00l5GIbpxaQlecg4ow0e` |
| FXMC | `price_1UN6bcPApeZiCPK2ClMfLN0v` | `price_1UN6bcPApeZiCPK2Ve1fhzvB` | `https://buy.stripe.com/dRm9AV3yAgJR6A5c484ow0f` |
| HK | `price_1UN6bePApeZiCPK2wOHj1JsL` | `price_1UN6bePApeZiCPK2fDOeOLLi` | `https://buy.stripe.com/7sY6oJfhi0KT9Mh2ty4ow0g` |
| US | `price_1UN6bfPApeZiCPK2wGCQompq` | `price_1UN6bgPApeZiCPK2GdOWDcwO` | `https://buy.stripe.com/bJe5kF4CEdxF1fL5FK4ow0h` |
| US_HK | `price_1UN6bhPApeZiCPK2jrb4ft2X` | `price_1UN6biPApeZiCPK2jn6Dd0v2` | `https://buy.stripe.com/7sYcN71qsdxFe2xfgk4ow0i` |
| US_SG_FXMC | `price_1UN6bjPApeZiCPK2WTGd23qf` | `price_1UN6bkPApeZiCPK2ph67Bd7n` | `https://buy.stripe.com/3cI8wR2uw65d0bH9W04ow0j` |
| HK_SG_FXMC | `price_1UN6blPApeZiCPK2Yj8wLwO4` | `price_1UN6bmPApeZiCPK2QwqTbpr8` | `https://buy.stripe.com/8x23cx7OQ1OX4rX8RW4ow0k` |
| ALL_MARKETS | `price_1UN6bnPApeZiCPK2pXHbbeX2` | `price_1UN6boPApeZiCPK2qNGhsKiH` | `https://buy.stripe.com/9B64gB3yA3X5aQl7NS4ow0l` |

  Coupons (live, id = code): `NAV70` ($70 off, forever), `NAV100` ($100 off, forever). Promo codes `NAV70` / `NAV100`. Test-mode equivalents are created in Task 11 (needs Joseph's `sk_test_` key) by the same script; until then the `test` maps in `lib/plans.ts` stay empty.
- Legacy (old-price) quarterly live price IDs — subscribers on these get the grandfathered annual: SG `price_1SOPIPPApeZiCPK2hrXFzaK3`, FXMC `price_1SOPI8PApeZiCPK2Z9OMozyV`, HK `price_1SOPIUPApeZiCPK2wSCEaEC3`, US `price_1SOPIQPApeZiCPK2B4FlKafO`, US_HK `price_1SOPIIPApeZiCPK2krxQ55XI`, US_SG_FXMC `price_1SOPIwPApeZiCPK2VlNvGRiv`, HK_SG_FXMC `price_1SumwoPApeZiCPK2aBYCsk8E`, ALL_MARKETS `price_1SOPISPApeZiCPK26eGgrPH2`.
- Existing coupon IDs: NAV21 = `gcUCHGHv`, NAV30 = `7imb0DBR`, SK50 = `zqIA0zDQ` (unmanaged, carried as is).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/annual-pricing.ts` | create | The one price table (monthly list, legacy quarterly, annual list / Pepperstone / grandfathered, coupon per tier) + `ANNUAL_OFFER_CLOSES_MS` + `annualOfferOpen()`. Consumed by plans.ts, the switch logic, emails, the send script and (copied values) the site. |
| `lib/plans.ts` | modify | Annual price IDs in `PRICE_TO_PLAN`; `getBillingInterval`, `isLegacyQuarterlyPrice`, `stripeModeOfPrice`, `annualTargetPriceFor`, `ANNUAL_COUPON_FOR_QUARTERLY`; NAV70/NAV100 in `COUPON_CODES`. |
| `lib/stripe-translator.ts` | modify | `billingInterval` on STARTED / RENEWED / TRIAL_CONVERTED; `previousBillingInterval`, `billingInterval`, `periodEnd`, `chargedToday` on PLAN_CHANGED. Export `effectivePrice`. |
| `lib/coupon-sync.ts`, `lib/coupon-sync-stripe.ts` | modify | Tier + interval → coupon; managed set grows to four. |
| `lib/subscription-lifecycle.ts` | modify | `ANNUAL_SWITCH` path in the same-plan branch of PLAN_CHANGED; `/qtr`→interval label in pings. |
| `lib/email.ts` | modify | `sendAnnualSwitchEmail` (confirmation), `sendAnnualOfferEmail` (existing / trial / reminder variants). |
| `lib/sheets.ts` | modify | `ANNUAL_SWITCH` colour in `LATEST_ACTION_COLORS`. |
| `lib/annual-link.ts` | create | HMAC token sign / verify / URL builder. |
| `lib/annual-switch.ts` | create | Snapshot type, pure `decideSwitch`, `previewAnnual`, `performAnnual`, narrow `AnnualStripe` seam. |
| `lib/annual-switch-stripe.ts` | create | `StripeAnnualClient` — the real Stripe implementation of `AnnualStripe`. |
| `api/annual-switch.ts` | create | HTTP: `GET ?t=` preview, `POST {t}` switch. |
| `api/stripe-webhook.ts` | modify | Wire `sendAnnualSwitch` into the mailer literal (both branches). |
| `web/src/pages/annual.astro` | create | The confirmation page. |
| `web/src/data/plans.ts`, `web/src/components/PriceToggle.astro`, `web/src/styles/pricing.css` | modify | Quarterly / Annual toggle, annual links, `SIGNUPS_OPEN`. |
| `web/src/content/guides/trial/start-your-free-trial.mdx` | modify | Annual callout. |
| `scripts/annual-offer-send.mts` | create | Offer / reminder sender, dry-run default. |
| `README-webhook.md`, `CLAUDE.md` | modify | `ANNUAL_LINK_SECRET`, the new action, the endpoint, the script. |

---

### Task 1: Pricing table module

**Files:**
- Create: `lib/annual-pricing.ts`
- Test: `lib/annual-pricing.test.ts`

**Interfaces:**
- Produces: `BillingInterval`, `ANNUAL_OFFER_CLOSES_MS`, `annualOfferOpen(nowMs?)`, `ANNUAL_PRICING[planType]` with `{ list, pepperstone, grandfathered, couponCode, couponOff }`, `MONTHLY_LIST`, `LEGACY_QUARTERLY`, `PLAN_TYPES`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/annual-pricing.test.ts
import { describe, it, expect } from "vitest";
import {
  ANNUAL_PRICING,
  MONTHLY_LIST,
  LEGACY_QUARTERLY,
  PLAN_TYPES,
  ANNUAL_OFFER_CLOSES_MS,
  annualOfferOpen,
} from "./annual-pricing.js";

describe("annual pricing table", () => {
  it("covers all eight plans", () => {
    expect(PLAN_TYPES).toEqual([
      "SG", "FXMC", "HK", "US", "US_HK", "US_SG_FXMC", "HK_SG_FXMC", "ALL_MARKETS",
    ]);
    for (const p of PLAN_TYPES) expect(ANNUAL_PRICING[p]).toBeDefined();
  });

  it("annual list is 10 x the monthly list ('2 months free')", () => {
    for (const p of PLAN_TYPES) {
      expect(ANNUAL_PRICING[p].list).toBe(MONTHLY_LIST[p] * 10);
    }
  });

  it("Pepperstone annual is list minus the tier coupon (70 singles, 100 combos/all)", () => {
    expect(ANNUAL_PRICING.SG).toMatchObject({ couponCode: "NAV70", couponOff: 70, pepperstone: 290 });
    expect(ANNUAL_PRICING.US).toMatchObject({ couponCode: "NAV70", couponOff: 70, pepperstone: 490 });
    expect(ANNUAL_PRICING.US_HK).toMatchObject({ couponCode: "NAV100", couponOff: 100, pepperstone: 890 });
    expect(ANNUAL_PRICING.ALL_MARKETS).toMatchObject({ couponCode: "NAV100", couponOff: 100, pepperstone: 1290 });
    for (const p of PLAN_TYPES) {
      expect(ANNUAL_PRICING[p].pepperstone).toBe(ANNUAL_PRICING[p].list - ANNUAL_PRICING[p].couponOff);
    }
  });

  it("grandfathered annual is 10 months at the legacy quarterly rate, rounded to the nearest 10", () => {
    for (const p of PLAN_TYPES) {
      const exact = (LEGACY_QUARTERLY[p] * 10) / 3;
      expect(ANNUAL_PRICING[p].grandfathered).toBe(Math.round(exact / 10) * 10);
    }
    expect(ANNUAL_PRICING.ALL_MARKETS.grandfathered).toBe(1290);
    expect(ANNUAL_PRICING.US_SG_FXMC.grandfathered).toBe(880);
  });

  it("offer closes 30 Oct 2026 23:59 SGT", () => {
    expect(ANNUAL_OFFER_CLOSES_MS).toBe(Date.UTC(2026, 9, 30, 15, 59));
    expect(annualOfferOpen(Date.UTC(2026, 9, 30, 15, 59))).toBe(true);
    expect(annualOfferOpen(Date.UTC(2026, 9, 30, 16, 0))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/annual-pricing.test.ts`
Expected: FAIL — cannot find module `./annual-pricing.js`.

- [ ] **Step 3: Write the module**

```ts
// lib/annual-pricing.ts
// =============================================================================
// ANNUAL PLAN — the one price table.
//
// "Annual, 2 months free" = 10 x the monthly list price. The Pepperstone annual
// is the list minus a fixed yearly coupon (NAV70 singles / NAV100 combos+All,
// i.e. the monthly Pepperstone discount x 10). Old-price subscribers get an
// exact grandfathered annual: 10 months at their legacy quarterly rate, rounded
// to the nearest 10. Offer window: 10 Oct – 30 Oct 2026 23:59 SGT.
// =============================================================================

export type BillingInterval = "quarter" | "year";

/** 30 Oct 2026 23:59 SGT. Every annual path checks this; nothing switches after it. */
export const ANNUAL_OFFER_CLOSES_MS = Date.UTC(2026, 9, 30, 15, 59);

export function annualOfferOpen(nowMs: number = Date.now()): boolean {
  return nowMs <= ANNUAL_OFFER_CLOSES_MS;
}

export const PLAN_TYPES = [
  "SG", "FXMC", "HK", "US", "US_HK", "US_SG_FXMC", "HK_SG_FXMC", "ALL_MARKETS",
] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/** 2026 lineup, per month (billed quarterly x3 today). */
export const MONTHLY_LIST: Record<PlanType, number> = {
  SG: 36, FXMC: 56, HK: 56, US: 56, US_HK: 99, US_SG_FXMC: 99, HK_SG_FXMC: 99, ALL_MARKETS: 139,
};

/** Pre-2026 quarterly prices still charged to grandfathered subscribers. */
export const LEGACY_QUARTERLY: Record<PlanType, number> = {
  SG: 87, FXMC: 147, HK: 147, US: 147, US_HK: 264, US_SG_FXMC: 264, HK_SG_FXMC: 264, ALL_MARKETS: 388,
};

export interface AnnualPrices {
  /** Annual list price, SGD. */
  list: number;
  /** Annual with the Pepperstone coupon applied, SGD. */
  pepperstone: number;
  /** Annual for subscribers on a legacy quarterly price ID, SGD. No coupon applies. */
  grandfathered: number;
  couponCode: "NAV70" | "NAV100";
  couponOff: 70 | 100;
}

const row = (plan: PlanType, couponCode: "NAV70" | "NAV100"): AnnualPrices => {
  const couponOff = couponCode === "NAV70" ? 70 : 100;
  const list = MONTHLY_LIST[plan] * 10;
  return {
    list,
    pepperstone: list - couponOff,
    grandfathered: Math.round((LEGACY_QUARTERLY[plan] * 10) / 3 / 10) * 10,
    couponCode,
    couponOff,
  };
};

export const ANNUAL_PRICING: Record<PlanType, AnnualPrices> = {
  SG: row("SG", "NAV70"),
  FXMC: row("FXMC", "NAV70"),
  HK: row("HK", "NAV70"),
  US: row("US", "NAV70"),
  US_HK: row("US_HK", "NAV100"),
  US_SG_FXMC: row("US_SG_FXMC", "NAV100"),
  HK_SG_FXMC: row("HK_SG_FXMC", "NAV100"),
  ALL_MARKETS: row("ALL_MARKETS", "NAV100"),
};

export function isPlanType(s: string): s is PlanType {
  return (PLAN_TYPES as readonly string[]).includes(s);
}

/** `1390` -> `$1,390 SGD` — the house money format for emails and the page. */
export function sgd(amount: number): string {
  return `$${amount.toLocaleString("en-SG", { maximumFractionDigits: 2 })} SGD`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/annual-pricing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/annual-pricing.ts lib/annual-pricing.test.ts
git commit -m "annual: pricing table module (10x monthly, Pepperstone coupons, grandfathered)"
```

---

### Task 2: Plan map — annual price IDs and lookups

**Files:**
- Modify: `lib/plans.ts` (the `PRICE_TO_PLAN` map at lines 3–33, `COUPON_CODES` at 48–52, plus new exports after `getPlanType`)
- Test: `lib/plans.test.ts` (create)

**Interfaces:**
- Consumes: `BillingInterval`, `PlanType`, `isPlanType` from Task 1.
- Produces: `getBillingInterval(priceId): BillingInterval`, `isLegacyQuarterlyPrice(priceId): boolean`, `stripeModeOfPrice(priceId): "live" | "test"`, `annualTargetPriceFor(currentPriceId): string`, `ANNUAL_LIST_PRICE_IDS`, `ANNUAL_GRANDFATHERED_PRICE_IDS`, `ANNUAL_COUPON_FOR_QUARTERLY`, `NAV70_COUPON_ID = "NAV70"`, `NAV100_COUPON_ID = "NAV100"`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/plans.test.ts
import { describe, it, expect } from "vitest";
import {
  getPlanType,
  getBillingInterval,
  isLegacyQuarterlyPrice,
  stripeModeOfPrice,
  annualTargetPriceFor,
  ANNUAL_LIST_PRICE_IDS,
  ANNUAL_GRANDFATHERED_PRICE_IDS,
  ANNUAL_COUPON_FOR_QUARTERLY,
  COUPON_CODES,
} from "./plans.js";

const LIVE_NEW_US = "price_1Te9RNPApeZiCPK2q0Dj5Cds";
const LIVE_OLD_US = "price_1SOPIQPApeZiCPK2B4FlKafO";
const LIVE_OLD_ALL = "price_1SOPISPApeZiCPK26eGgrPH2";
const TEST_US = "price_1SNb26PApeZiCPK25nSa9j6H";

describe("annual price IDs", () => {
  it("every annual price resolves to its plan and reads as yearly", () => {
    for (const mode of ["live", "test"] as const) {
      for (const [plan, id] of Object.entries(ANNUAL_LIST_PRICE_IDS[mode])) {
        expect(getPlanType(id)).toBe(plan);
        expect(getBillingInterval(id)).toBe("year");
      }
      for (const [plan, id] of Object.entries(ANNUAL_GRANDFATHERED_PRICE_IDS[mode])) {
        expect(getPlanType(id)).toBe(plan);
        expect(getBillingInterval(id)).toBe("year");
      }
    }
    expect(Object.keys(ANNUAL_LIST_PRICE_IDS.live)).toHaveLength(8);
    expect(Object.keys(ANNUAL_GRANDFATHERED_PRICE_IDS.live)).toHaveLength(8);
  });

  it("quarterly prices read as quarter", () => {
    expect(getBillingInterval(LIVE_NEW_US)).toBe("quarter");
    expect(getBillingInterval(LIVE_OLD_US)).toBe("quarter");
    expect(getBillingInterval(TEST_US)).toBe("quarter");
  });

  it("legacy detection is by price ID, never by amount", () => {
    expect(isLegacyQuarterlyPrice(LIVE_OLD_US)).toBe(true);
    expect(isLegacyQuarterlyPrice(LIVE_NEW_US)).toBe(false);
    expect(isLegacyQuarterlyPrice(TEST_US)).toBe(false);
  });

  it("knows which Stripe mode a price belongs to", () => {
    expect(stripeModeOfPrice(LIVE_NEW_US)).toBe("live");
    expect(stripeModeOfPrice(TEST_US)).toBe("test");
  });

  it("targets the grandfathered annual for a legacy price, the list annual otherwise", () => {
    expect(annualTargetPriceFor(LIVE_OLD_ALL)).toBe(ANNUAL_GRANDFATHERED_PRICE_IDS.live.ALL_MARKETS);
    expect(annualTargetPriceFor(LIVE_NEW_US)).toBe(ANNUAL_LIST_PRICE_IDS.live.US);
    expect(() => annualTargetPriceFor("price_nope")).toThrow(/Unknown Stripe price ID/);
  });

  it("maps the quarterly Pepperstone coupons to their annual counterparts", () => {
    expect(ANNUAL_COUPON_FOR_QUARTERLY).toEqual({ gcUCHGHv: "NAV70", "7imb0DBR": "NAV100" });
    expect(COUPON_CODES.NAV70).toBe("NAV70");
    expect(COUPON_CODES.NAV100).toBe("NAV100");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/plans.test.ts`
Expected: FAIL — `getBillingInterval` is not exported.

- [ ] **Step 3: Add the IDs and lookups to `lib/plans.ts`**

Insert the annual IDs into `PRICE_TO_PLAN` right after the `// Test prices` block (before the closing `};`):

```ts
  // Annual prices — October 2026 offer (lib/annual-pricing.ts has the amounts).
  // Live, list:
  "price_1UN6bOPApeZiCPK2e2I1aTYS": "SG",
  "price_1UN6bcPApeZiCPK2ClMfLN0v": "FXMC",
  "price_1UN6bePApeZiCPK2wOHj1JsL": "HK",
  "price_1UN6bfPApeZiCPK2wGCQompq": "US",
  "price_1UN6bhPApeZiCPK2jrb4ft2X": "US_HK",
  "price_1UN6bjPApeZiCPK2WTGd23qf": "US_SG_FXMC",
  "price_1UN6blPApeZiCPK2Yj8wLwO4": "HK_SG_FXMC",
  "price_1UN6bnPApeZiCPK2pXHbbeX2": "ALL_MARKETS",
  // Live, grandfathered (only reachable via the annual-switch endpoint):
  "price_1UN6bOPApeZiCPK2yYitohWn": "SG",
  "price_1UN6bcPApeZiCPK2Ve1fhzvB": "FXMC",
  "price_1UN6bePApeZiCPK2fDOeOLLi": "HK",
  "price_1UN6bgPApeZiCPK2GdOWDcwO": "US",
  "price_1UN6biPApeZiCPK2jn6Dd0v2": "US_HK",
  "price_1UN6bkPApeZiCPK2ph67Bd7n": "US_SG_FXMC",
  "price_1UN6bmPApeZiCPK2QwqTbpr8": "HK_SG_FXMC",
  "price_1UN6boPApeZiCPK2qNGhsKiH": "ALL_MARKETS",
  // Test-mode annual prices are spread in from the maps below (filled in Task 11).
  ...Object.fromEntries(
    Object.entries(TEST_ANNUAL_LIST).map(([plan, id]) => [id, plan])
  ),
  ...Object.fromEntries(
    Object.entries(TEST_ANNUAL_GRANDFATHERED).map(([plan, id]) => [id, plan])
  ),
```

Because `PRICE_TO_PLAN` is a `const` declared first, the two test maps must be declared ABOVE it. Add at the very top of the file (after the leading comment):

```ts
import { type BillingInterval, isPlanType } from "./annual-pricing.js";

// Test-mode annual prices — created by scripts/setup-annual-prices.mts with an
// sk_test_ key. Empty until that run; the switch endpoint refuses test prices
// until they are filled (annualTargetPriceFor throws).
const TEST_ANNUAL_LIST: Record<string, string> = {};
const TEST_ANNUAL_GRANDFATHERED: Record<string, string> = {};
```

Then, directly after `getPlanType`, add:

```ts
// --- Billing interval & annual lookups -------------------------------------

export const ANNUAL_LIST_PRICE_IDS: Record<"live" | "test", Record<string, string>> = {
  live: {
    SG: "price_1UN6bOPApeZiCPK2e2I1aTYS",
    FXMC: "price_1UN6bcPApeZiCPK2ClMfLN0v",
    HK: "price_1UN6bePApeZiCPK2wOHj1JsL",
    US: "price_1UN6bfPApeZiCPK2wGCQompq",
    US_HK: "price_1UN6bhPApeZiCPK2jrb4ft2X",
    US_SG_FXMC: "price_1UN6bjPApeZiCPK2WTGd23qf",
    HK_SG_FXMC: "price_1UN6blPApeZiCPK2Yj8wLwO4",
    ALL_MARKETS: "price_1UN6bnPApeZiCPK2pXHbbeX2",
  },
  test: TEST_ANNUAL_LIST,
};

export const ANNUAL_GRANDFATHERED_PRICE_IDS: Record<"live" | "test", Record<string, string>> = {
  live: {
    SG: "price_1UN6bOPApeZiCPK2yYitohWn",
    FXMC: "price_1UN6bcPApeZiCPK2Ve1fhzvB",
    HK: "price_1UN6bePApeZiCPK2fDOeOLLi",
    US: "price_1UN6bgPApeZiCPK2GdOWDcwO",
    US_HK: "price_1UN6biPApeZiCPK2jn6Dd0v2",
    US_SG_FXMC: "price_1UN6bkPApeZiCPK2ph67Bd7n",
    HK_SG_FXMC: "price_1UN6bmPApeZiCPK2QwqTbpr8",
    ALL_MARKETS: "price_1UN6boPApeZiCPK2qNGhsKiH",
  },
  test: TEST_ANNUAL_GRANDFATHERED,
};

/** Pre-2026 live quarterly prices. A subscriber still on one of these gets the
 *  grandfathered annual. Detection is by ID only — amounts collide (US at 147 is
 *  both the old list and the new list minus NAV21). */
const LEGACY_QUARTERLY_PRICE_IDS = new Set([
  "price_1SOPIPPApeZiCPK2hrXFzaK3", // SG
  "price_1SOPI8PApeZiCPK2Z9OMozyV", // FXMC
  "price_1SOPIUPApeZiCPK2wSCEaEC3", // HK
  "price_1SOPIQPApeZiCPK2B4FlKafO", // US
  "price_1SOPIIPApeZiCPK2krxQ55XI", // US_HK
  "price_1SOPIwPApeZiCPK2VlNvGRiv", // US_SG_FXMC
  "price_1SumwoPApeZiCPK2aBYCsk8E", // HK_SG_FXMC
  "price_1SOPISPApeZiCPK26eGgrPH2", // ALL_MARKETS
]);

const TEST_QUARTERLY_PRICE_IDS = new Set([
  "price_1SNb2pPApeZiCPK2uIln7piV",
  "price_1SNaZXPApeZiCPK2PZkjTiz3",
  "price_1SNbFQPApeZiCPK2YcsuDyXc",
  "price_1SNb26PApeZiCPK25nSa9j6H",
  "price_1SNasAPApeZiCPK28bMFFYhP",
  "price_1SNaqLPApeZiCPK2c7Fcenzl",
  "price_1TRnm7PApeZiCPK2hk54bsUA",
  "price_1SNau9PApeZiCPK22ZjuVaKQ",
]);

const ANNUAL_PRICE_ID_SET = (): Set<string> =>
  new Set([
    ...Object.values(ANNUAL_LIST_PRICE_IDS.live),
    ...Object.values(ANNUAL_GRANDFATHERED_PRICE_IDS.live),
    ...Object.values(ANNUAL_LIST_PRICE_IDS.test),
    ...Object.values(ANNUAL_GRANDFATHERED_PRICE_IDS.test),
  ]);

export function getBillingInterval(priceId: string): BillingInterval {
  getPlanType(priceId); // throws on an unknown price — never guess an interval
  return ANNUAL_PRICE_ID_SET().has(priceId) ? "year" : "quarter";
}

export function isLegacyQuarterlyPrice(priceId: string): boolean {
  return LEGACY_QUARTERLY_PRICE_IDS.has(priceId);
}

export function stripeModeOfPrice(priceId: string): "live" | "test" {
  getPlanType(priceId);
  const test =
    TEST_QUARTERLY_PRICE_IDS.has(priceId) ||
    Object.values(ANNUAL_LIST_PRICE_IDS.test).includes(priceId) ||
    Object.values(ANNUAL_GRANDFATHERED_PRICE_IDS.test).includes(priceId);
  return test ? "test" : "live";
}

/**
 * The annual price a subscriber on `currentPriceId` moves to: the grandfathered
 * annual when they are on a legacy quarterly price, otherwise the list annual
 * for their plan, in the same Stripe mode. Throws on an unknown price or when
 * the mode's annual maps are not filled yet.
 */
export function annualTargetPriceFor(currentPriceId: string): string {
  const plan = getPlanType(currentPriceId);
  if (!isPlanType(plan)) throw new Error(`No annual price for plan: ${plan}`);
  const mode = stripeModeOfPrice(currentPriceId);
  const table = isLegacyQuarterlyPrice(currentPriceId)
    ? ANNUAL_GRANDFATHERED_PRICE_IDS[mode]
    : ANNUAL_LIST_PRICE_IDS[mode];
  const target = table[plan];
  if (!target) throw new Error(`No ${mode} annual price configured for ${plan}`);
  return target;
}

/** Quarterly Pepperstone coupon ID -> its annual counterpart (coupon id = code). */
export const NAV70_COUPON_ID = "NAV70";
export const NAV100_COUPON_ID = "NAV100";
export const ANNUAL_COUPON_FOR_QUARTERLY: Record<string, string> = {
  gcUCHGHv: NAV70_COUPON_ID, // NAV21 -> NAV70
  "7imb0DBR": NAV100_COUPON_ID, // NAV30 -> NAV100
};
```

And extend `COUPON_CODES`:

```ts
export const COUPON_CODES: Record<string, string> = {
  "7imb0DBR": "NAV30", // Pepperstone $30/qtr off — combos + All Markets
  gcUCHGHv: "NAV21", // Pepperstone $21/qtr off — single-market plans
  zqIA0zDQ: "SK50", // LEOW SUI KIANG's personal 50%-off-forever deal
  NAV70: "NAV70", // Pepperstone $70/yr off — single-market annual
  NAV100: "NAV100", // Pepperstone $100/yr off — combo + All Markets annual
};
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run lib/plans.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests), typecheck clean. (The `test` maps are `{}`, so the loop over them is a no-op — the first test still passes on the live maps.)

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all green (no existing test enumerates `PRICE_TO_PLAN`).

- [ ] **Step 6: Commit**

```bash
git add lib/plans.ts lib/plans.test.ts
git commit -m "annual: price IDs, billing-interval and annual-target lookups in plans.ts"
```

---

### Task 3: Translator carries the billing interval

**Files:**
- Modify: `lib/stripe-translator.ts` — the `SubscriberAction` union (STARTED ~line 37, RENEWED ~63, TRIAL_CONVERTED ~91, PLAN_CHANGED ~104), `translateCheckoutCompleted` (~line 243–310), `translateInvoicePaymentSucceeded` (~line 326–395), the plan-change branch (~line 540–560), the `TRIAL_CONVERTED` push (~line 519), `effectivePrice` (~line 814, make it `export`).
- Test: `lib/stripe-translator.test.ts` (append).

**Interfaces:**
- Consumes: `getBillingInterval` (Task 2), `BillingInterval` (Task 1).
- Produces: `STARTED.billingInterval`, `RENEWED.billingInterval: BillingInterval | null`, `TRIAL_CONVERTED.billingInterval`, `PLAN_CHANGED.previousBillingInterval: BillingInterval | null`, `PLAN_CHANGED.billingInterval`, `PLAN_CHANGED.periodEnd: Date`, `PLAN_CHANGED.chargedToday: number | null`; `export function effectivePrice(...)`.

- [ ] **Step 1: Write the failing tests** (append to `lib/stripe-translator.test.ts`)

```ts
import { ANNUAL_LIST_PRICE_IDS } from "./plans.js";

const LIVE_NEW_ALL = "price_1Te9XoPApeZiCPK2HqYrNNK1";
const LIVE_ANNUAL_ALL = ANNUAL_LIST_PRICE_IDS.live.ALL_MARKETS;

describe("billing interval on actions", () => {
  test("PLAN_CHANGED quarter -> year (same plan) carries both intervals, the period end and the charge", async () => {
    const newPrice = { id: LIVE_ANNUAL_ALL, unit_amount: 139000, recurring: { interval: "year", interval_count: 1 } };
    const sub = {
      id: "sub_a",
      status: "active",
      items: { data: [{ id: "si_1", price: newPrice, current_period_end: 1_822_000_000 }] },
      discounts: [],
      latest_invoice: "in_up",
    };
    const event = updatedEvent(sub, { items: { data: [{ price: { id: LIVE_NEW_ALL } }] } });
    const stripe = {
      subscriptions: {
        retrieve: async () => ({
          ...sub,
          discounts: [{ coupon: { id: "NAV100", amount_off: 10000 } }],
          latest_invoice: { id: "in_up", status: "paid", billing_reason: "subscription_update", total: 98765 },
        }),
      },
    } as unknown as Stripe;

    const actions = await translate(event, stripe);
    const pc = actions.find((a) => a.kind === "PLAN_CHANGED") as Extract<
      SubscriberAction,
      { kind: "PLAN_CHANGED" }
    >;
    expect(pc).toBeDefined();
    expect(pc.newPlanType).toBe("ALL_MARKETS");
    expect(pc.previousBillingInterval).toBe("quarter");
    expect(pc.billingInterval).toBe("year");
    expect(pc.newSubscriptionPrice).toBe(1290);
    expect(pc.periodEnd.getTime()).toBe(1_822_000_000 * 1000);
    expect(pc.chargedToday).toBe(987.65);
  });

  test("PLAN_CHANGED on a plain quarterly plan change has chargedToday null", async () => {
    const newPrice = { id: LIVE_NEW_ALL, unit_amount: 41700, recurring: { interval: "month", interval_count: 3 } };
    const sub = {
      id: "sub_b",
      status: "active",
      items: { data: [{ id: "si_1", price: newPrice, current_period_end: 1_822_000_000 }] },
      discounts: [],
      latest_invoice: "in_cycle",
    };
    const event = updatedEvent(sub, { items: { data: [{ price: { id: US } }] } });
    const stripe = {
      subscriptions: {
        retrieve: async () => ({
          ...sub,
          latest_invoice: { id: "in_cycle", status: "paid", billing_reason: "subscription_cycle", total: 41700 },
        }),
      },
    } as unknown as Stripe;
    const pc = (await translate(event, stripe)).find((a) => a.kind === "PLAN_CHANGED") as Extract<
      SubscriberAction,
      { kind: "PLAN_CHANGED" }
    >;
    expect(pc.previousBillingInterval).toBe("quarter");
    expect(pc.billingInterval).toBe("quarter");
    expect(pc.chargedToday).toBeNull();
  });
});
```

Add `import type { SubscriberAction } from "./stripe-translator.js";` next to the existing `translate` import if it is not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/stripe-translator.test.ts`
Expected: FAIL — `previousBillingInterval` undefined.

- [ ] **Step 3: Implement**

(a) Imports at the top of `lib/stripe-translator.ts`:

```ts
import { COUPON_CODES, getPlanType, getBillingInterval } from "./plans.js";
import type { BillingInterval } from "./annual-pricing.js";
```

(b) Union changes — add these fields:

```ts
  // STARTED:
      billingInterval: BillingInterval; // "quarter" today; "year" on an annual link checkout
  // RENEWED:
      billingInterval: BillingInterval | null; // null when the line's price is unknown
  // TRIAL_CONVERTED:
      billingInterval: BillingInterval;
  // PLAN_CHANGED:
      // The interval BEFORE and AFTER the change. Same plan + quarter -> year is
      // the annual switch (lifecycle: ANNUAL_SWITCH). previous is null when the
      // old price ID is unknown to plans.ts.
      previousBillingInterval: BillingInterval | null;
      billingInterval: BillingInterval;
      // End of the period the subscription is now in. An anchor-reset annual
      // switch bills with billing_reason=subscription_update, which never emits
      // RENEWED, so this is the only carrier of the new 12-month expiry.
      periodEnd: Date;
      // Amount actually collected by the invoice this update raised (SGD), or
      // null when the update raised no paid invoice (a plain plan change at the
      // period boundary, or a trialist's price swap).
      chargedToday: number | null;
```

(c) `translateCheckoutCompleted` — in the returned STARTED object add `billingInterval: getBillingInterval(price.id),`.

(d) `translateInvoicePaymentSucceeded` — after the `planType` resolution:

```ts
  let billingInterval: BillingInterval | null = null;
  if (planType && linePriceId) billingInterval = getBillingInterval(linePriceId);
```
and add `billingInterval,` to the RENEWED object.

(e) `TRIAL_CONVERTED` push — add `billingInterval: getBillingInterval(priceId as string),` (the branch already guarantees `priceId` and `convertedPlan`).

(f) Plan-change branch — replace the `subWithDiscounts` retrieve + push with:

```ts
      const subWithDiscounts = await stripe.subscriptions.retrieve(subscription.id, {
        expand: ["discounts", "discounts.promotion_code", "latest_invoice"],
      });
      let previousBillingInterval: BillingInterval | null = null;
      if (oldPriceId) {
        try {
          previousBillingInterval = getBillingInterval(oldPriceId);
        } catch {
          previousBillingInterval = null;
        }
      }
      const latest = subWithDiscounts.latest_invoice as
        | { status?: string | null; billing_reason?: string | null; total?: number | null }
        | string
        | null;
      const chargedToday =
        latest &&
        typeof latest === "object" &&
        latest.billing_reason === "subscription_update" &&
        latest.status === "paid" &&
        typeof latest.total === "number"
          ? latest.total / 100
          : null;
      const periodEndSeconds =
        subscriptionPeriodEnd(subscription) || calculatePeriodEnd(subscription);
      actions.push({
        kind: "PLAN_CHANGED",
        stripeSubscriptionId: subscription.id,
        newPlanType: getPlanType(newPrice.id),
        newSubscriptionPrice: effectivePrice(newPrice.unit_amount ?? 0, subWithDiscounts.discounts),
        newCouponDiscount: subWithDiscounts.discounts.length > 0,
        newCouponCode: couponCodeFromDiscounts(subWithDiscounts.discounts),
        previousBillingInterval,
        billingInterval: getBillingInterval(newPrice.id),
        periodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : new Date(),
        chargedToday,
      });
```

(g) Change `function effectivePrice(` to `export function effectivePrice(`.

- [ ] **Step 4: Fix the compile errors in tests and scripts that build actions by hand**

`npx tsc --noEmit` will list every object literal of kind STARTED / RENEWED / TRIAL_CONVERTED / PLAN_CHANGED that now lacks the new fields (in `lib/subscription-lifecycle.test.ts`, `lib/followup.test.ts` if any, `scripts/apply-out-of-band-payment.mts`, `scripts/send-missed-trial-welcomes.mts`, `scripts/schedule-downgrade.mts`). Add `billingInterval: "quarter"` (and for PLAN_CHANGED literals also `previousBillingInterval: "quarter", periodEnd: new Date(...), chargedToday: null`) to each. Do not change any test's assertions.

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all green.

- [ ] **Step 6: Commit**

```bash
git add lib/stripe-translator.ts lib/stripe-translator.test.ts lib/subscription-lifecycle.test.ts scripts/
git commit -m "annual: translator carries billingInterval, periodEnd and chargedToday"
```

---

### Task 4: Coupon sync understands yearly tiers

**Files:**
- Modify: `lib/coupon-sync.ts` (`MANAGED_COUPON_CODES`, `desiredCouponForPlan`, `verdictForSubscription`, `PhaseCouponState`, `buildPhaseCouponPlan`)
- Modify: `lib/coupon-sync-stripe.ts` (wherever it calls `verdictForSubscription` / builds `PhaseCouponState` from a price — pass the interval from `getBillingInterval(priceId)`)
- Test: `lib/coupon-sync.test.ts` (append)

**Interfaces:**
- Produces: `desiredCouponForPlan(planType, interval: BillingInterval = "quarter")`, `verdictForSubscription(couponIds, planType, interval = "quarter")`, `PhaseCouponState.interval?: BillingInterval`.

- [ ] **Step 1: Write the failing tests** (append to `lib/coupon-sync.test.ts`)

```ts
import { desiredCouponForPlan, verdictForSubscription, isManagedCoupon, buildPhaseCouponPlan } from "./coupon-sync.js";

describe("yearly tiers", () => {
  it("wants NAV70 on single annuals and NAV100 on combo/all annuals", () => {
    expect(desiredCouponForPlan("US", "year")).toBe("NAV70");
    expect(desiredCouponForPlan("US_HK", "year")).toBe("NAV100");
    expect(desiredCouponForPlan("ALL_MARKETS", "year")).toBe("NAV100");
    expect(desiredCouponForPlan("US")).toBe("gcUCHGHv"); // default stays quarterly
  });

  it("treats NAV70 and NAV100 as managed", () => {
    expect(isManagedCoupon("NAV70")).toBe(true);
    expect(isManagedCoupon("NAV100")).toBe(true);
  });

  it("swaps a quarterly coupon to the yearly one when the subscription is yearly", () => {
    expect(verdictForSubscription(["7imb0DBR"], "ALL_MARKETS", "year")).toEqual({
      kind: "swap", from: "7imb0DBR", to: "NAV100",
    });
    expect(verdictForSubscription(["NAV100"], "ALL_MARKETS", "year")).toEqual({
      kind: "correct", couponId: "NAV100",
    });
  });

  it("phase planning uses each phase's own interval", () => {
    const plan = buildPhaseCouponPlan(
      [
        { planType: "ALL_MARKETS", couponIds: ["NAV100"], interval: "year" },
        { planType: "US", couponIds: ["NAV100"], interval: "year" },
      ],
      ["NAV100"]
    );
    expect(plan.phaseCouponIds).toEqual([["NAV100"], ["NAV70"]]);
    expect(plan.changed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/coupon-sync.test.ts`
Expected: FAIL — `desiredCouponForPlan("US","year")` returns `gcUCHGHv`.

- [ ] **Step 3: Implement in `lib/coupon-sync.ts`**

```ts
import { parsePlanType, NAV70_COUPON_ID, NAV100_COUPON_ID } from "./plans.js";
import type { BillingInterval } from "./annual-pricing.js";

export const MANAGED_COUPON_CODES: Record<string, string> = {
  [NAV21_COUPON_ID]: "NAV21",
  [NAV30_COUPON_ID]: "NAV30",
  [NAV70_COUPON_ID]: "NAV70",
  [NAV100_COUPON_ID]: "NAV100",
};

export function desiredCouponForPlan(
  planType: string,
  interval: BillingInterval = "quarter"
): string | null {
  const { category } = parsePlanType(planType);
  if (category === "single") return interval === "year" ? NAV70_COUPON_ID : NAV21_COUPON_ID;
  if (category === "combo" || category === "all") {
    return interval === "year" ? NAV100_COUPON_ID : NAV30_COUPON_ID;
  }
  return null;
}

export function verdictForSubscription(
  couponIds: string[],
  planType: string,
  interval: BillingInterval = "quarter"
): CouponVerdict {
  // ...body unchanged except:
  const desired = desiredCouponForPlan(planType, interval);
```

`PhaseCouponState` gains `interval?: BillingInterval;` and inside `buildPhaseCouponPlan`, where the desired coupon for a phase is computed, use `desiredCouponForPlan(phase.planType, phase.interval ?? "quarter")`.

In `lib/coupon-sync-stripe.ts`: wherever a plan is resolved from a price (`planFromPrice`) for the subscription verdict or a phase, also compute the interval:

```ts
import { getPlanType, getBillingInterval } from "./plans.js";

function intervalFromPrice(price: string | Stripe.Price | Stripe.DeletedPrice | null | undefined): BillingInterval {
  const id = typeof price === "string" ? price : price?.id;
  if (!id) return "quarter";
  try { return getBillingInterval(id); } catch { return "quarter"; }
}
```
Pass `intervalFromPrice(sub.items.data[0]?.price)` as the third argument to `verdictForSubscription`, and set `interval: intervalFromPrice(phase.items[0]?.price)` on each `PhaseCouponState` it builds.

- [ ] **Step 4: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green. Existing coupon-sync tests still pass because the default interval is `quarter`.

- [ ] **Step 5: Commit**

```bash
git add lib/coupon-sync.ts lib/coupon-sync-stripe.ts lib/coupon-sync.test.ts
git commit -m "annual: coupon sync keys on plan tier + billing interval (NAV70/NAV100)"
```

---

### Task 5: Lifecycle `ANNUAL_SWITCH` + confirmation email

**Files:**
- Modify: `lib/email.ts` (new `AnnualSwitchEmailData`, `sendAnnualSwitchEmail`)
- Modify: `lib/subscription-lifecycle.ts` (`Mailer` interface; `handlePlanChanged` same-plan branch ~line 1010–1055; the two `/qtr` pings at ~1047 and ~1838)
- Modify: `lib/sheets.ts` (`LATEST_ACTION_COLORS`)
- Modify: `api/stripe-webhook.ts` (`buildLifecycle` mailer literals, both branches)
- Test: `lib/subscription-lifecycle.test.ts` (append), `lib/email.test.ts` (append)

**Interfaces:**
- Consumes: PLAN_CHANGED fields from Task 3; `sgd`, `ANNUAL_PRICING` from Task 1.
- Produces: `Mailer.sendAnnualSwitch(data: AnnualSwitchEmailData)`; Latest Action / Status Log action `ANNUAL_SWITCH`.

- [ ] **Step 1: Write the failing lifecycle test** (append to `lib/subscription-lifecycle.test.ts`; reuse the file's existing `FakeStore`, `makeSubscriber`, `RecordingMailer`, `RecordingNotifier` and `RecordingTradingView` fakes exactly as named; the lifecycle constructor order is `(store, mailer, notifier, eventLog, tradingview, telegramRemover?, couponManager?)` as in the file's existing `new SubscriptionLifecycle(...)` calls)

```ts
describe("ANNUAL_SWITCH", () => {
  const planChangedToAnnual = (overrides: Partial<Extract<SubscriberAction, { kind: "PLAN_CHANGED" }>> = {}) =>
    ({
      kind: "PLAN_CHANGED",
      stripeSubscriptionId: "sub_annual",
      newPlanType: "ALL_MARKETS",
      newSubscriptionPrice: 1290,
      newCouponDiscount: true,
      newCouponCode: "NAV100",
      previousBillingInterval: "quarter",
      billingInterval: "year",
      periodEnd: new Date(Date.UTC(2027, 9, 5, 12, 0)),
      chargedToday: 987.65,
      ...overrides,
    }) as Extract<SubscriberAction, { kind: "PLAN_CHANGED" }>;

  it("same plan, quarter -> year: writes ANNUAL_SWITCH, new expiry, price, coupon; emails; logs; pings", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        email: "ann@example.com",
        customerName: "Ann",
        currentPlan: "ALL_MARKETS",
        subscriptionPrice: 387,
        couponCode: "NAV30",
        couponDiscount: true,
        status: "ACTIVE",
        stripeSubscriptionId: "sub_annual",
      })
    );
    const mailer = new RecordingMailer();
    const notes: string[] = [];
    const log: EventLogEntry[] = [];
    const lifecycle = new SubscriptionLifecycle(
      store,
      mailer,
      { notify: async (m) => { notes.push(m); } },
      { record: async (e) => { log.push(e); }, hasRecorded: async () => false },
      new RecordingTradingView(), // the file's existing granter fake
      new NoopTelegramGroupRemover(),
      new NoopCouponManager()
    );

    await lifecycle.apply(planChangedToAnnual());

    const patch = store.patches.at(-1)!;
    expect(patch.latestAction).toBe("ANNUAL_SWITCH");
    expect(patch.subscriptionPrice).toBe(1290);
    expect(patch.couponCode).toBe("NAV100");
    expect(patch.subscriptionExpiry?.getTime()).toBe(Date.UTC(2027, 9, 5, 12, 0));
    expect(patch.currentPlan).toBeUndefined(); // plan unchanged

    expect(mailer.annualSwitch).toHaveLength(1);
    expect(mailer.annualSwitch[0]).toMatchObject({
      email: "ann@example.com",
      planType: "ALL_MARKETS",
      annualPrice: 1290,
      chargedToday: 987.65,
      onTrial: false,
    });
    expect(log.find((e) => e.action === "ANNUAL_SWITCH")).toMatchObject({ price: 1290, coupon: true });
    expect(notes.join("\n")).toContain("Annual switch");
  });

  it("a trialist's switch keeps the trial status and says nothing is charged yet", async () => {
    const store = new FakeStore();
    store.rows.push(
      makeSubscriber({
        email: "tri@example.com",
        currentPlan: "ALL_MARKETS",
        subscriptionPrice: 417,
        status: "TRIAL_ACTIVE",
        stripeSubscriptionId: "sub_annual",
      })
    );
    const mailer = new RecordingMailer();
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, { notify: async () => {} },
      { record: async () => {}, hasRecorded: async () => false },
      new RecordingTradingView(), new NoopTelegramGroupRemover(), new NoopCouponManager()
    );
    await lifecycle.apply(planChangedToAnnual({ newSubscriptionPrice: 1390, newCouponDiscount: false, newCouponCode: "", chargedToday: null }));
    expect(store.patches.at(-1)!.status).toBeUndefined();
    expect(mailer.annualSwitch[0]).toMatchObject({ onTrial: true, chargedToday: null, annualPrice: 1390 });
  });

  it("same plan, same interval still takes the PRICE_SYNC path", async () => {
    const store = new FakeStore();
    store.rows.push(makeSubscriber({ email: "q@example.com", currentPlan: "US", subscriptionPrice: 147, stripeSubscriptionId: "sub_annual" }));
    const mailer = new RecordingMailer();
    const log: EventLogEntry[] = [];
    const lifecycle = new SubscriptionLifecycle(
      store, mailer, { notify: async () => {} },
      { record: async (e) => { log.push(e); }, hasRecorded: async () => false },
      new RecordingTradingView(), new NoopTelegramGroupRemover(), new NoopCouponManager()
    );
    await lifecycle.apply(planChangedToAnnual({ newPlanType: "US", newSubscriptionPrice: 168, previousBillingInterval: "quarter", billingInterval: "quarter", chargedToday: null }));
    expect(log.at(-1)?.action).toBe("PRICE_SYNC");
    expect(mailer.annualSwitch).toHaveLength(0);
  });
});
```

Extend `RecordingMailer` and `noopMailer` in the test file with `annualSwitch: AnnualSwitchEmailData[] = []` / `async sendAnnualSwitch(d) { this.annualSwitch.push(d); }` / `sendAnnualSwitch: async () => {}`. Import `AnnualSwitchEmailData` from `./email.js` and `EventLogEntry` from `./event-log.js`.

- [ ] **Step 2: Write the failing email test** (append to `lib/email.test.ts`)

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run lib/subscription-lifecycle.test.ts lib/email.test.ts`
Expected: FAIL — `sendAnnualSwitchEmail` not exported; `annualSwitch` undefined.

- [ ] **Step 4: Add the email** (append to `lib/email.ts`, after `sendDowngradeUndoneEmail`)

```ts
// --- Annual switch confirmation ---

export interface AnnualSwitchEmailData {
  email: string;
  name: string;
  planType: string;
  /** Annual price after any coupon, SGD. */
  annualPrice: number;
  /** What the card was charged today (annual minus the unused part of the
   *  current quarter), or null when nothing was charged (trialist). */
  chargedToday: number | null;
  /** Formatted SGT date the plan now runs to (trialists: the trial end). */
  newExpiry: string;
  onTrial: boolean;
}

export async function sendAnnualSwitchEmail(data: AnnualSwitchEmailData): Promise<void> {
  const { email, name, planType, annualPrice, chargedToday, newExpiry, onTrial } = data;
  const planName = getPlanDisplayName(planType);
  const title = "You're on the annual plan";
  const subject = "You're on the annual plan";

  const intro = onTrial
    ? `Hi ${name}, your <strong style="color:${INK};">${planName}</strong> trial will roll onto the annual plan when it ends on <strong style="color:${INK};">${newExpiry}</strong>. Nothing has been charged yet.`
    : `Hi ${name}, your <strong style="color:${INK};">${planName}</strong> plan is now paid for a full year, to <strong style="color:${INK};">${newExpiry}</strong>.`;

  const moneyRows = onTrial
    ? `<tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Charged on ${newExpiry}</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${sgd(annualPrice)}</td></tr>`
    : `<tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Charged today</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${chargedToday === null ? sgd(annualPrice) : sgd(chargedToday)}</td></tr>
       <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Annual price</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${sgd(annualPrice)}</td></tr>`;

  const detailsRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${CARD_BORDER}; border-radius:14px;">
        <tr><td style="padding:22px 22px 24px;">
          <div style="font-family:${FONT}; font-size:15px; font-weight:800; letter-spacing:.3px; color:${INK}; margin-bottom:14px;">Your subscription</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${FONT}; font-size:15px; color:${BODY_TEXT};">
            <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Plan</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${planName}</td></tr>
            <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Billing</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">Yearly</td></tr>
            ${moneyRows}
            <tr><td style="padding:7px 0;">${onTrial ? "Trial ends" : "Paid until"}</td><td align="right" style="padding:7px 0; color:${INK}; font-weight:700;">${newExpiry}</td></tr>
          </table>
          <div style="margin-top:18px;">${button(BILLING_PORTAL_LINK, "Manage subscription", "outline")}</div>
        </td></tr>
      </table>
    </td></tr>`;

  const noteText = onTrial
    ? "Your signal groups, webinars and indicator access stay exactly as they are. If you change your mind before the trial ends, cancel in 2 taps from any of our emails and nothing is charged."
    : "Your signal groups, webinars and indicator access stay exactly as they are. The unused part of your current quarter has been credited against today's charge, so the amount on your card is lower than the annual price.";

  const contentRows = [
    titleRow(title, intro),
    plainWell(para(noteText, 0, 0)),
    detailsRow,
    footerRow([SUPPORT_LINE], "Thank you for staying with us"),
  ].join("\n");

  const html = emailShell({ title, contentRows });

  const text = `${title}

Hi ${name},
${onTrial
    ? `Your ${planName} trial will roll onto the annual plan when it ends on ${newExpiry}. Nothing has been charged yet.`
    : `Your ${planName} plan is now paid for a full year, to ${newExpiry}.`}

${noteText}

Your subscription:
- Plan: ${planName}
- Billing: Yearly
${onTrial ? `- Charged on ${newExpiry}: ${sgd(annualPrice)}` : `- Charged today: ${chargedToday === null ? sgd(annualPrice) : sgd(chargedToday)}\n- Annual price: ${sgd(annualPrice)}`}
- ${onTrial ? "Trial ends" : "Paid until"}: ${newExpiry}
- Manage: ${BILLING_PORTAL_LINK}

Thank you for staying with us.
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({ to: email, subject, html, text });
}
```

Add `import { sgd } from "./annual-pricing.js";` at the top of `lib/email.ts`.

- [ ] **Step 5: Lifecycle changes**

(a) `Mailer` interface: add `sendAnnualSwitch(data: AnnualSwitchEmailData): Promise<void>;` and import the type.

(b) In `handlePlanChanged`, inside `if (oldPlanType === action.newPlanType) {`, BEFORE the `priceDrifted` computation, insert:

```ts
      if (action.previousBillingInterval === "quarter" && action.billingInterval === "year") {
        await this.handleAnnualSwitch(existing, action);
        return;
      }
```

(c) Add the handler method (place it right after `handlePlanChanged`):

```ts
  // ===========================================================================
  // ANNUAL_SWITCH — same plan, quarterly -> yearly (the October 2026 offer).
  // Reached from handlePlanChanged. The annual-switch endpoint already did the
  // Stripe write; this records it, confirms to the subscriber and pings Joseph.
  // An anchor-reset update invoices with billing_reason=subscription_update,
  // so no RENEWED follows — the new expiry is written HERE from periodEnd.
  // ===========================================================================
  private async handleAnnualSwitch(
    existing: Subscriber,
    action: Extract<SubscriberAction, { kind: "PLAN_CHANGED" }>
  ): Promise<void> {
    const onTrial = existing.status.startsWith("TRIAL_");
    const newExpiry = formatDisplayDateSGT(action.periodEnd);

    await this.store.applyUpdate(existing, {
      subscriptionPrice: action.newSubscriptionPrice,
      couponCode: action.newCouponCode ?? "",
      subscriptionExpiry: action.periodEnd,
      latestAction: "ANNUAL_SWITCH",
    });

    await this.runSideEffects("ANNUAL_SWITCH", [
      this.mailer.sendAnnualSwitch({
        email: existing.email,
        name: existing.customerName,
        planType: existing.currentPlan,
        annualPrice: action.newSubscriptionPrice,
        chargedToday: action.chargedToday,
        newExpiry,
        onTrial,
      }),
      this.eventLog.record({
        email: existing.email,
        stripeSubscriptionId: action.stripeSubscriptionId,
        action: "ANNUAL_SWITCH",
        plan: existing.currentPlan,
        price: action.newSubscriptionPrice,
        coupon: action.newCouponDiscount,
        detail: `annual; ${onTrial ? "trial, charged at trial end" : `charged ${action.chargedToday ?? "?"} today`}; expiry ${newExpiry}`,
      }),
      this.notifier.notify(
        [
          `<b>📅 Annual switch</b>`,
          ``,
          `<b>Name:</b> ${escapeHtml(existing.customerName)}`,
          `<b>Email:</b> ${escapeHtml(existing.email)}`,
          `<b>Plan:</b> ${getPlanDisplayName(existing.currentPlan)} (${existing.currentPlan})`,
          `<b>Annual price:</b> $${action.newSubscriptionPrice} SGD/yr${action.newCouponCode ? ` (${action.newCouponCode})` : ""}`,
          onTrial
            ? `<b>Charged:</b> at trial end (${newExpiry})`
            : `<b>Charged today:</b> $${action.chargedToday ?? "?"} SGD`,
          `<b>Paid until:</b> ${newExpiry}`,
        ].join("\n")
      ),
    ]);

    console.log(`ANNUAL_SWITCH ${existing.email} (${existing.currentPlan}) -> ${newExpiry}`);
  }
```

(d) The two admin pings that print `SGD/qtr` (`Price Updated (same plan)` and the one near line 1838): replace `SGD/qtr` with `` SGD/${action.billingInterval === "year" ? "yr" : "qtr"} `` where `action` is the PLAN_CHANGED action in scope; if the second ping's action has no interval (check its kind), leave it as `/qtr`.

(e) `lib/sheets.ts` → `LATEST_ACTION_COLORS`: add `ANNUAL_SWITCH: hexToRgb("01FF00"),` next to `UPGRADED`.

(f) `api/stripe-webhook.ts` → `buildLifecycle`: add `sendAnnualSwitch: noop,` to the suppressed literal and `sendAnnualSwitch: sendAnnualSwitchEmail,` to the live one; import `sendAnnualSwitchEmail`.

- [ ] **Step 6: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green. Fix any other `Mailer` implementers the compiler finds (search `sendTrialWinback:` to locate every literal).

- [ ] **Step 7: Commit**

```bash
git add lib/email.ts lib/subscription-lifecycle.ts lib/subscription-lifecycle.test.ts lib/email.test.ts lib/sheets.ts api/stripe-webhook.ts
git commit -m "annual: ANNUAL_SWITCH lifecycle path + confirmation email"
```

---

### Task 6: Signed magic link

**Files:**
- Create: `lib/annual-link.ts`
- Test: `lib/annual-link.test.ts`

**Interfaces:**
- Produces: `signAnnualLink(subscriptionId, email, secret): string`, `verifyAnnualLink(token, secret): { subscriptionId: string; email: string } | null`, `annualLinkUrl(subscriptionId, email, secret, siteUrl?): string`.

- [ ] **Step 1: Failing test**

```ts
// lib/annual-link.test.ts
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/annual-link.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// lib/annual-link.ts
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
```

- [ ] **Step 4: Run** — `npx vitest run lib/annual-link.test.ts` → PASS (4).

- [ ] **Step 5: Commit**

```bash
git add lib/annual-link.ts lib/annual-link.test.ts
git commit -m "annual: HMAC-signed magic link"
```

---

### Task 7: Switch logic with a fake Stripe

**Files:**
- Create: `lib/annual-switch.ts`
- Test: `lib/annual-switch.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ANNUAL_PRICING`, `annualOfferOpen`, `isPlanType`), Task 2 (`getPlanType`, `getBillingInterval`, `annualTargetPriceFor`, `isLegacyQuarterlyPrice`, `ANNUAL_COUPON_FOR_QUARTERLY`), Task 6 (`verifyAnnualLink`), `getPlanDisplayName`, `formatDisplayDateSGT`.
- Produces:

```ts
export interface SubscriptionSnapshot {
  id: string;
  customerEmail: string | null;
  status: string;                 // "active" | "trialing" | ...
  priceId: string;
  itemId: string;
  couponIds: string[];
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  trialEnd: number | null;        // epoch seconds
  currentPeriodEnd: number | null;
  currentEffectivePrice: number;  // SGD after coupon, what they pay per period today
}
export interface SwitchPlan {
  mode: "active" | "trialing";
  targetPriceId: string;
  couponIds: string[];            // discounts to write (may be [])
  grandfathered: boolean;
}
export type SwitchRefusal = "offer_closed" | "invalid" | "already_annual" | "ineligible" | "payment_failed";
export interface AnnualOffer {
  ok: true; mode: "active" | "trialing"; planType: string; planName: string;
  currentPrice: number; annualPrice: number; amountDueToday: number; newExpiry: string; grandfathered: boolean;
}
export interface AnnualRefusal { ok: false; reason: SwitchRefusal; detail?: string }
export interface AnnualStripe {
  getSubscription(id: string): Promise<SubscriptionSnapshot | null>;
  previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan): Promise<number>; // SGD
  performSwitch(sub: SubscriptionSnapshot, plan: SwitchPlan, idempotencyKey: string): Promise<{ periodEnd: number | null }>;
}
export class AnnualPaymentFailed extends Error {}
export function decideSwitch(sub: SubscriptionSnapshot, nowMs: number): SwitchPlan | AnnualRefusal;
export async function previewAnnual(stripe: AnnualStripe, token: string, secret: string, nowMs?: number): Promise<AnnualOffer | AnnualRefusal>;
export async function performAnnual(stripe: AnnualStripe, token: string, secret: string, notify: (msg: string) => Promise<void>, nowMs?: number): Promise<AnnualOffer | AnnualRefusal>;
```

- [ ] **Step 1: Failing tests**

```ts
// lib/annual-switch.test.ts
import { describe, it, expect } from "vitest";
import {
  decideSwitch, previewAnnual, performAnnual, AnnualPaymentFailed,
  type AnnualStripe, type SubscriptionSnapshot, type SwitchPlan,
} from "./annual-switch.js";
import { signAnnualLink } from "./annual-link.js";
import { ANNUAL_LIST_PRICE_IDS, ANNUAL_GRANDFATHERED_PRICE_IDS } from "./plans.js";

const SECRET = "s";
const NOW = Date.UTC(2026, 9, 12, 4, 0); // 12 Oct 2026, inside the window
const LIVE_NEW_ALL = "price_1Te9XoPApeZiCPK2HqYrNNK1";
const LIVE_OLD_ALL = "price_1SOPISPApeZiCPK26eGgrPH2";
const LIVE_NEW_US = "price_1Te9RNPApeZiCPK2q0Dj5Cds";

const snap = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: "sub_1", customerEmail: "ann@example.com", status: "active", priceId: LIVE_NEW_ALL, itemId: "si_1",
  couponIds: ["7imb0DBR"], cancelAtPeriodEnd: false, scheduleId: null, trialEnd: null,
  currentPeriodEnd: 1_795_000_000, currentEffectivePrice: 387, ...o,
});

class FakeStripe implements AnnualStripe {
  subs = new Map<string, SubscriptionSnapshot>();
  performed: Array<{ plan: SwitchPlan; key: string }> = [];
  failPayment = false;
  async getSubscription(id: string) { return this.subs.get(id) ?? null; }
  async previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan) {
    return plan.mode === "trialing" ? 0 : 1000.5;
  }
  async performSwitch(sub: SubscriptionSnapshot, plan: SwitchPlan, key: string) {
    if (this.failPayment) throw new AnnualPaymentFailed("card_declined");
    this.performed.push({ plan, key });
    return { periodEnd: 1_822_000_000 };
  }
}

describe("decideSwitch", () => {
  it("active NAV30 subscriber on a 2026 price -> list annual with NAV100", () => {
    expect(decideSwitch(snap(), NOW)).toEqual({
      mode: "active", targetPriceId: ANNUAL_LIST_PRICE_IDS.live.ALL_MARKETS, couponIds: ["NAV100"], grandfathered: false,
    });
  });
  it("legacy price -> grandfathered annual, no coupon", () => {
    expect(decideSwitch(snap({ priceId: LIVE_OLD_ALL, couponIds: [] }), NOW)).toEqual({
      mode: "active", targetPriceId: ANNUAL_GRANDFATHERED_PRICE_IDS.live.ALL_MARKETS, couponIds: [], grandfathered: true,
    });
  });
  it("single-market NAV21 -> NAV70; unmanaged SK50 carried as is", () => {
    expect((decideSwitch(snap({ priceId: LIVE_NEW_US, couponIds: ["gcUCHGHv"] }), NOW) as SwitchPlan).couponIds).toEqual(["NAV70"]);
    expect((decideSwitch(snap({ priceId: LIVE_NEW_US, couponIds: ["zqIA0zDQ"] }), NOW) as SwitchPlan).couponIds).toEqual(["zqIA0zDQ"]);
  });
  it("trialing -> trialing mode", () => {
    expect((decideSwitch(snap({ status: "trialing", trialEnd: 1_800_000_000 }), NOW) as SwitchPlan).mode).toBe("trialing");
  });
  it("refusals", () => {
    expect(decideSwitch(snap(), Date.UTC(2026, 9, 30, 16, 0))).toEqual({ ok: false, reason: "offer_closed" });
    expect(decideSwitch(snap({ priceId: ANNUAL_LIST_PRICE_IDS.live.ALL_MARKETS }), NOW)).toEqual({ ok: false, reason: "already_annual" });
    expect(decideSwitch(snap({ status: "past_due" }), NOW)).toMatchObject({ ok: false, reason: "ineligible" });
    expect(decideSwitch(snap({ scheduleId: "sub_sched_1" }), NOW)).toMatchObject({ ok: false, reason: "ineligible" });
    expect(decideSwitch(snap({ priceId: "price_unknown" }), NOW)).toMatchObject({ ok: false, reason: "ineligible" });
  });
});

describe("previewAnnual / performAnnual", () => {
  it("preview returns the offer with Stripe's amount due today", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap());
    const t = signAnnualLink("sub_1", "ann@example.com", SECRET);
    const r = await previewAnnual(s, t, SECRET, NOW);
    expect(r).toMatchObject({ ok: true, mode: "active", planType: "ALL_MARKETS", currentPrice: 387, annualPrice: 1290, amountDueToday: 1000.5, grandfathered: false });
  });
  it("preview of a trialist has 0 due today and the trial end as expiry", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ status: "trialing", trialEnd: 1_792_000_000, couponIds: [] }));
    const r = await previewAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, NOW);
    expect(r).toMatchObject({ ok: true, mode: "trialing", annualPrice: 1390, amountDueToday: 0 });
  });
  it("rejects a bad token and an email mismatch", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ customerEmail: "other@example.com" }));
    expect(await previewAnnual(s, "nope", SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(await previewAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
  it("perform writes once with a stable idempotency key and reports the new expiry", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap());
    const pings: string[] = [];
    const t = signAnnualLink("sub_1", "ann@example.com", SECRET);
    const r = await performAnnual(s, t, SECRET, async (m) => { pings.push(m); }, NOW);
    expect(r).toMatchObject({ ok: true, newExpiry: expect.stringContaining("2027") });
    expect(s.performed).toHaveLength(1);
    expect(s.performed[0].key).toBe("annual:sub_1");
    expect(s.performed[0].plan.couponIds).toEqual(["NAV100"]);
  });
  it("a declined card returns payment_failed and pings", async () => {
    const s = new FakeStripe(); s.failPayment = true; s.subs.set("sub_1", snap());
    const pings: string[] = [];
    const r = await performAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, async (m) => { pings.push(m); }, NOW);
    expect(r).toEqual({ ok: false, reason: "payment_failed", detail: "card_declined" });
    expect(pings[0]).toContain("payment failed");
  });
  it("an ineligible subscription pings Joseph with the reason", async () => {
    const s = new FakeStripe(); s.subs.set("sub_1", snap({ scheduleId: "sub_sched_9" }));
    const pings: string[] = [];
    await performAnnual(s, signAnnualLink("sub_1", "ann@example.com", SECRET), SECRET, async (m) => { pings.push(m); }, NOW);
    expect(pings[0]).toContain("ineligible");
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/annual-switch.ts
// =============================================================================
// ANNUAL SWITCH — decision logic + orchestration, Stripe behind a seam.
//
// The magic-link page calls previewAnnual (GET) and performAnnual (POST). The
// Stripe write itself (lib/annual-switch-stripe.ts) resets the billing anchor
// to NOW and invoices immediately, so the annual is PAID before 1 Nov — the
// customer portal cannot do that (it keeps the anchor, so the big charge would
// land at the old renewal date, after the deadline). Trialists only get the
// price swapped; Stripe collects the annual at trial end.
//
// Nothing here touches the sheet, sends the confirmation email or logs: the
// webhook sees the price change and runs the lifecycle's ANNUAL_SWITCH path.
// =============================================================================

import { ANNUAL_PRICING, annualOfferOpen, isPlanType, type PlanType } from "./annual-pricing.js";
import {
  getPlanType, getBillingInterval, annualTargetPriceFor, isLegacyQuarterlyPrice,
  ANNUAL_COUPON_FOR_QUARTERLY, getPlanDisplayName,
} from "./plans.js";
import { verifyAnnualLink } from "./annual-link.js";
import { formatDisplayDateSGT } from "./format-date.js";

export interface SubscriptionSnapshot {
  id: string;
  customerEmail: string | null;
  status: string;
  priceId: string;
  itemId: string;
  couponIds: string[];
  cancelAtPeriodEnd: boolean;
  scheduleId: string | null;
  trialEnd: number | null;
  currentPeriodEnd: number | null;
  currentEffectivePrice: number;
}

export interface SwitchPlan {
  mode: "active" | "trialing";
  targetPriceId: string;
  couponIds: string[];
  grandfathered: boolean;
}

export type SwitchRefusal = "offer_closed" | "invalid" | "already_annual" | "ineligible" | "payment_failed";
export interface AnnualRefusal { ok: false; reason: SwitchRefusal; detail?: string }
export interface AnnualOffer {
  ok: true;
  mode: "active" | "trialing";
  planType: string;
  planName: string;
  currentPrice: number;
  annualPrice: number;
  amountDueToday: number;
  newExpiry: string;
  grandfathered: boolean;
}

export interface AnnualStripe {
  getSubscription(id: string): Promise<SubscriptionSnapshot | null>;
  previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan): Promise<number>;
  performSwitch(sub: SubscriptionSnapshot, plan: SwitchPlan, idempotencyKey: string): Promise<{ periodEnd: number | null }>;
}

export class AnnualPaymentFailed extends Error {}

export function decideSwitch(sub: SubscriptionSnapshot, nowMs: number): SwitchPlan | AnnualRefusal {
  if (!annualOfferOpen(nowMs)) return { ok: false, reason: "offer_closed" };

  let planType: string;
  try {
    planType = getPlanType(sub.priceId);
  } catch {
    return { ok: false, reason: "ineligible", detail: `unknown price ${sub.priceId}` };
  }
  if (getBillingInterval(sub.priceId) === "year") return { ok: false, reason: "already_annual" };
  if (sub.status !== "active" && sub.status !== "trialing") {
    return { ok: false, reason: "ineligible", detail: `status ${sub.status}` };
  }
  if (sub.scheduleId) return { ok: false, reason: "ineligible", detail: `schedule ${sub.scheduleId} attached` };
  if (!isPlanType(planType)) return { ok: false, reason: "ineligible", detail: `plan ${planType}` };

  let targetPriceId: string;
  try {
    targetPriceId = annualTargetPriceFor(sub.priceId);
  } catch (err) {
    return { ok: false, reason: "ineligible", detail: err instanceof Error ? err.message : String(err) };
  }
  const couponIds = sub.couponIds.map((c) => ANNUAL_COUPON_FOR_QUARTERLY[c] ?? c);
  return {
    mode: sub.status === "trialing" ? "trialing" : "active",
    targetPriceId,
    couponIds,
    grandfathered: isLegacyQuarterlyPrice(sub.priceId),
  };
}

function annualPriceFor(planType: PlanType, plan: SwitchPlan): number {
  const row = ANNUAL_PRICING[planType];
  if (plan.grandfathered) return row.grandfathered;
  if (plan.couponIds.includes(row.couponCode)) return row.pepperstone;
  if (plan.couponIds.includes("zqIA0zDQ")) return row.list / 2; // SK50: 50% off forever
  return row.list;
}

async function resolve(
  stripe: AnnualStripe, token: string, secret: string, nowMs: number
): Promise<{ sub: SubscriptionSnapshot; plan: SwitchPlan; planType: PlanType } | AnnualRefusal> {
  const link = verifyAnnualLink(token, secret);
  if (!link) return { ok: false, reason: "invalid" };
  const sub = await stripe.getSubscription(link.subscriptionId);
  if (!sub) return { ok: false, reason: "invalid" };
  if ((sub.customerEmail ?? "").trim().toLowerCase() !== link.email) return { ok: false, reason: "invalid" };
  const plan = decideSwitch(sub, nowMs);
  if ("ok" in plan) return plan;
  const planType = getPlanType(sub.priceId) as PlanType;
  return { sub, plan, planType };
}

function offerFrom(
  sub: SubscriptionSnapshot, plan: SwitchPlan, planType: PlanType, amountDueToday: number, periodEnd: number | null
): AnnualOffer {
  const expiryEpoch = plan.mode === "trialing" ? sub.trialEnd : periodEnd;
  return {
    ok: true,
    mode: plan.mode,
    planType,
    planName: getPlanDisplayName(planType),
    currentPrice: sub.currentEffectivePrice,
    annualPrice: annualPriceFor(planType, plan),
    amountDueToday,
    newExpiry: expiryEpoch ? formatDisplayDateSGT(new Date(expiryEpoch * 1000)) : "",
    grandfathered: plan.grandfathered,
  };
}

export async function previewAnnual(
  stripe: AnnualStripe, token: string, secret: string, nowMs: number = Date.now()
): Promise<AnnualOffer | AnnualRefusal> {
  const r = await resolve(stripe, token, secret, nowMs);
  if ("ok" in r) return r;
  const { sub, plan, planType } = r;
  const due = plan.mode === "trialing" ? 0 : await stripe.previewAmountDueToday(sub, plan);
  // Preview: an active subscriber's new period would end one year from now.
  const projectedEnd = plan.mode === "trialing" ? sub.trialEnd : Math.floor(nowMs / 1000) + 365 * 86400;
  return offerFrom(sub, plan, planType, due, projectedEnd);
}

export async function performAnnual(
  stripe: AnnualStripe, token: string, secret: string,
  notify: (msg: string) => Promise<void>, nowMs: number = Date.now()
): Promise<AnnualOffer | AnnualRefusal> {
  const r = await resolve(stripe, token, secret, nowMs);
  if ("ok" in r) {
    if (r.reason === "ineligible") {
      await notify(`<b>⚠️ Annual switch ineligible</b>\n${token.slice(0, 12)}…\n${r.detail ?? ""}`).catch(() => {});
    }
    return r;
  }
  const { sub, plan, planType } = r;
  const due = plan.mode === "trialing" ? 0 : await stripe.previewAmountDueToday(sub, plan);
  try {
    const { periodEnd } = await stripe.performSwitch(sub, plan, `annual:${sub.id}`);
    return offerFrom(sub, plan, planType, due, periodEnd);
  } catch (err) {
    if (err instanceof AnnualPaymentFailed) {
      await notify(
        `<b>❌ Annual switch payment failed</b>\n${sub.customerEmail ?? sub.id}\n${err.message}\n<i>Quarterly subscription left as it was.</i>`
      ).catch(() => {});
      return { ok: false, reason: "payment_failed", detail: err.message };
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run** — `npx vitest run lib/annual-switch.test.ts` → PASS (11). Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add lib/annual-switch.ts lib/annual-switch.test.ts
git commit -m "annual: switch decision + orchestration behind an AnnualStripe seam"
```

---

### Task 8: Real Stripe adapter + HTTP endpoint

**Files:**
- Create: `lib/annual-switch-stripe.ts`
- Create: `api/annual-switch.ts`
- Modify: `README-webhook.md` (env var table: `ANNUAL_LINK_SECRET`)
- Test: `lib/annual-switch-stripe.test.ts` (snapshot mapping only, with a stubbed SDK object)

**Interfaces:**
- Consumes: Task 7 types; `effectivePrice` (Task 3).
- Produces: `class StripeAnnualClient implements AnnualStripe`; `GET /api/annual-switch?t=` → `AnnualOffer | AnnualRefusal` JSON; `POST /api/annual-switch` body `{ t }` → same.

- [ ] **Step 1: Failing test for the snapshot mapping**

```ts
// lib/annual-switch-stripe.test.ts
import { describe, it, expect } from "vitest";
import type Stripe from "stripe";
import { StripeAnnualClient } from "./annual-switch-stripe.js";

const LIVE_NEW_ALL = "price_1Te9XoPApeZiCPK2HqYrNNK1";

describe("StripeAnnualClient.getSubscription", () => {
  it("maps a Stripe subscription to a snapshot", async () => {
    const sdk = {
      subscriptions: {
        retrieve: async () => ({
          id: "sub_1",
          status: "active",
          customer: { email: "Ann@Example.com", deleted: false },
          items: { data: [{ id: "si_1", price: { id: LIVE_NEW_ALL, unit_amount: 41700 }, current_period_end: 1_795_000_000 }] },
          discounts: [{ coupon: { id: "7imb0DBR", amount_off: 3000 } }],
          cancel_at_period_end: true,
          schedule: null,
          trial_end: null,
        }),
      },
    } as unknown as Stripe;
    const c = new StripeAnnualClient(sdk);
    expect(await c.getSubscription("sub_1")).toEqual({
      id: "sub_1", customerEmail: "Ann@Example.com", status: "active", priceId: LIVE_NEW_ALL, itemId: "si_1",
      couponIds: ["7imb0DBR"], cancelAtPeriodEnd: true, scheduleId: null, trialEnd: null,
      currentPeriodEnd: 1_795_000_000, currentEffectivePrice: 387,
    });
  });
  it("returns null for a missing subscription", async () => {
    const sdk = { subscriptions: { retrieve: async () => { throw Object.assign(new Error("no"), { code: "resource_missing" }); } } } as unknown as Stripe;
    expect(await new StripeAnnualClient(sdk).getSubscription("sub_x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// lib/annual-switch-stripe.ts
import type Stripe from "stripe";
import { effectivePrice } from "./stripe-translator.js";
import { AnnualPaymentFailed, type AnnualStripe, type SubscriptionSnapshot, type SwitchPlan } from "./annual-switch.js";

const couponIdsOf = (sub: Stripe.Subscription): string[] =>
  (sub.discounts ?? [])
    .map((d) => {
      if (typeof d === "string") return null;
      const c = (d as Stripe.Discount).coupon;
      return typeof c === "string" ? c : c?.id ?? null;
    })
    .filter((c): c is string => !!c);

export class StripeAnnualClient implements AnnualStripe {
  constructor(private readonly stripe: Stripe) {}

  async getSubscription(id: string): Promise<SubscriptionSnapshot | null> {
    let sub: Stripe.Subscription;
    try {
      sub = await this.stripe.subscriptions.retrieve(id, {
        expand: ["discounts", "customer", "items.data.price"],
      });
    } catch (err) {
      if ((err as { code?: string }).code === "resource_missing") return null;
      throw err;
    }
    const item = sub.items.data[0];
    if (!item?.price?.id) return null;
    const customer = sub.customer as Stripe.Customer | Stripe.DeletedCustomer | string;
    const customerEmail =
      typeof customer === "object" && !("deleted" in customer && customer.deleted)
        ? (customer as Stripe.Customer).email ?? null
        : null;
    return {
      id: sub.id,
      customerEmail,
      status: sub.status,
      priceId: item.price.id,
      itemId: item.id,
      couponIds: couponIdsOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      scheduleId: typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null,
      trialEnd: sub.trial_end ?? null,
      currentPeriodEnd: item.current_period_end ?? null,
      currentEffectivePrice: effectivePrice(item.price.unit_amount ?? 0, sub.discounts),
    };
  }

  async previewAmountDueToday(sub: SubscriptionSnapshot, plan: SwitchPlan): Promise<number> {
    const preview = await this.stripe.invoices.createPreview({
      subscription: sub.id,
      subscription_details: {
        items: [{ id: sub.itemId, price: plan.targetPriceId }],
        proration_behavior: "always_invoice",
        billing_cycle_anchor: "now",
      },
      // Discounts for the preview: the ANNUAL coupon, not the quarterly one the
      // subscription still carries. [] means "no discount" (grandfathered).
      discounts: plan.couponIds.map((coupon) => ({ coupon })),
    });
    return (preview.amount_due ?? preview.total ?? 0) / 100;
  }

  async performSwitch(
    sub: SubscriptionSnapshot, plan: SwitchPlan, idempotencyKey: string
  ): Promise<{ periodEnd: number | null }> {
    const common: Stripe.SubscriptionUpdateParams = {
      items: [{ id: sub.itemId, price: plan.targetPriceId }],
      discounts: plan.couponIds.map((coupon) => ({ coupon })),
      cancel_at_period_end: false,
    };
    const params: Stripe.SubscriptionUpdateParams =
      plan.mode === "trialing"
        ? { ...common, proration_behavior: "none" }
        : {
            ...common,
            billing_cycle_anchor: "now",
            proration_behavior: "always_invoice",
            payment_behavior: "error_if_incomplete",
          };
    try {
      const updated = await this.stripe.subscriptions.update(sub.id, params, { idempotencyKey });
      return { periodEnd: updated.items.data[0]?.current_period_end ?? null };
    } catch (err) {
      const e = err as { code?: string; type?: string; message?: string; decline_code?: string };
      if (e.type === "StripeCardError" || e.code === "card_declined" || e.code === "payment_intent_authentication_failure" || e.code === "subscription_payment_intent_requires_action") {
        throw new AnnualPaymentFailed(e.decline_code ?? e.code ?? e.message ?? "payment failed");
      }
      throw err;
    }
  }
}
```

Note for the implementer: if Stripe rejects the `discounts` parameter on `invoices.createPreview` at runtime (Task 11 will show it), move the discounts onto `subscription_details.items[0].discounts` instead and keep the test-mode run as the proof.

- [ ] **Step 4: The endpoint**

```ts
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
```

- [ ] **Step 5: README** — add to the env var table in `README-webhook.md`:

`| \`ANNUAL_LINK_SECRET\` | Random 32+ char string that signs the annual-offer magic links (\`/annual?t=\`). Generate with \`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\`. Rotating it invalidates every link already sent. |`

Also add the same value to the local `.env` (generate it now with that command; Joseph pastes the same value into Vercel in Task 12).

- [ ] **Step 6: Run** — `npx tsc --noEmit && npx vitest run` → green.

- [ ] **Step 7: Commit**

```bash
git add lib/annual-switch-stripe.ts lib/annual-switch-stripe.test.ts api/annual-switch.ts README-webhook.md
git commit -m "annual: Stripe adapter (anchor reset, error_if_incomplete) + /api/annual-switch"
```

---

### Task 9: The `/annual` page

**Files:**
- Create: `web/src/pages/annual.astro`

**Interfaces:**
- Consumes: the JSON shapes from Task 7 (`AnnualOffer` / `AnnualRefusal`), via `GET/POST /api/annual-switch`.

- [ ] **Step 1: Write the page**

```astro
---
// /annual?t=<token> — the one-click annual switch page. Loads the offer from
// /api/annual-switch (GET), shows plan / price / amount today, and POSTs the
// same token on Confirm. All states are rendered client-side from the JSON;
// the server only knows the token.
import Base from '../layouts/Base.astro';
---
<Base compact title="Annual plan — RHO Navigator" description="Lock in your Navigator plan for 12 months with 2 months free.">
  <section class="page-hero flush">
    <div class="container">
      <span class="eyebrow">October offer</span>
      <h1>Annual plan, <span class="hl">2 months free</span></h1>
      <p id="lead">Checking your subscription…</p>
    </div>
  </section>

  <section class="section">
    <div class="container annual-wrap">
      <div id="offer" hidden>
        <div class="plan annual-card">
          <div class="pname" id="planName"></div>
          <table class="annual-table">
            <tr><td>You pay now</td><td id="currentPrice"></td></tr>
            <tr><td>Annual price</td><td id="annualPrice"></td></tr>
            <tr id="dueRow"><td>Charged to your card today</td><td id="amountDue"></td></tr>
            <tr><td id="expiryLabel">Paid until</td><td id="newExpiry"></td></tr>
          </table>
          <p class="annual-fine" id="fine"></p>
          <button class="btn btn-primary btn-block" id="confirm" type="button">Yes, switch me to annual</button>
          <p class="annual-fine">Your signal groups, webinars and indicator access do not change. Billing becomes yearly instead of quarterly.</p>
        </div>
      </div>

      <div id="done" hidden>
        <div class="plan annual-card">
          <div class="pname">You're on the annual plan</div>
          <p id="doneText"></p>
          <p class="annual-fine">A confirmation email is on its way.</p>
          <a class="btn btn-ghost btn-block" href="/">Back to the site</a>
        </div>
      </div>

      <div id="problem" hidden>
        <div class="plan annual-card">
          <div class="pname" id="problemTitle"></div>
          <p id="problemText"></p>
          <div id="problemActions"></div>
          <p class="annual-fine">Need a hand? WhatsApp Joseph at <a href="https://wa.me/6582007039">8200 7039</a> or message <a href="https://t.me/Joseph_Ho">@Joseph_Ho</a> on Telegram.</p>
        </div>
      </div>
    </div>
  </section>
</Base>

<style>
  .annual-wrap { max-width: 560px; margin: 0 auto; }
  .annual-card { padding: 28px; }
  .annual-table { width: 100%; border-collapse: collapse; margin: 18px 0 14px; font-size: 1.02rem; }
  .annual-table td { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .annual-table td:last-child { text-align: right; font-weight: 800; color: var(--ink, inherit); }
  .annual-fine { color: var(--muted); font-size: 0.92rem; margin: 12px 0 0; }
  #confirm { margin-top: 10px; }
  #confirm[disabled] { opacity: 0.6; cursor: wait; }
</style>

<script>
  const PORTAL = 'https://billing.stripe.com/p/login/14A28tfhi79h9Mhfgk4ow00'; // BILLING_PORTAL_LINK in lib/plans.ts
  const sgd = (n: number) => `$${n.toLocaleString('en-SG', { maximumFractionDigits: 2 })} SGD`;
  const $ = (id: string) => document.getElementById(id)!;
  const show = (id: 'offer' | 'done' | 'problem') => {
    for (const s of ['offer', 'done', 'problem']) $(s).toggleAttribute('hidden', s !== id);
  };
  const token = new URLSearchParams(location.search).get('t') ?? '';

  type Offer = { ok: true; mode: 'active' | 'trialing'; planName: string; currentPrice: number; annualPrice: number; amountDueToday: number; newExpiry: string; grandfathered: boolean };
  type Refusal = { ok: false; reason: string; detail?: string };

  const problem = (reason: string, detail?: string) => {
    const copy: Record<string, [string, string]> = {
      offer_closed: ['This offer has closed', 'The annual plan was available until 30 October 2026. Your quarterly plan carries on as before.'],
      already_annual: ["You're already on the annual plan", 'Nothing more to do. Your plan is paid for the year.'],
      payment_failed: ['The payment did not go through', `Your card was declined${detail ? ` (${detail.replace(/_/g, ' ')})` : ''}. Your quarterly plan is unchanged. Update your card in the billing portal, then open this link again.`],
      invalid: ['This link is not valid', 'Open the link from your own offer email. If you copied it, make sure the whole address came across.'],
      ineligible: ['We need to do this one by hand', 'Your subscription has a pending change on it, so the switch cannot run automatically. Message Joseph and he will sort it in a minute.'],
    };
    const [title, text] = copy[reason] ?? copy.ineligible;
    $('problemTitle').textContent = title;
    $('problemText').textContent = text;
    $('problemActions').innerHTML = reason === 'payment_failed'
      ? `<a class="btn btn-primary btn-block" href="${PORTAL}" target="_blank" rel="noopener">Update my card</a>`
      : '';
    $('lead').textContent = '';
    show('problem');
  };

  const render = (o: Offer) => {
    $('lead').textContent = o.mode === 'trialing'
      ? 'Your trial continues as normal. At the end of it, you move onto the annual plan instead of quarterly.'
      : 'Pay once for 12 months and keep your current plan and price locked in.';
    $('planName').textContent = o.planName;
    $('currentPrice').textContent = o.mode === 'trialing' ? 'Free trial' : `${sgd(o.currentPrice)} every 3 months`;
    $('annualPrice').textContent = `${sgd(o.annualPrice)} for 12 months`;
    $('dueRow').toggleAttribute('hidden', o.mode === 'trialing');
    $('amountDue').textContent = sgd(o.amountDueToday);
    $('expiryLabel').textContent = o.mode === 'trialing' ? 'Trial ends, annual starts' : 'Paid until';
    $('newExpiry').textContent = o.newExpiry;
    $('fine').textContent = o.mode === 'trialing'
      ? `On ${o.newExpiry} your card is charged ${sgd(o.annualPrice)} once, for the full year. Cancel before then and nothing is charged.`
      : `The unused part of your current quarter is credited, so today's charge is lower than the annual price.${o.grandfathered ? ' Your price is locked at your current rate.' : ''}`;
    show('offer');
  };

  const load = async () => {
    if (!token) return problem('invalid');
    const r = await fetch(`/api/annual-switch?t=${encodeURIComponent(token)}`);
    const data = (await r.json()) as Offer | Refusal;
    if (!data.ok) return problem(data.reason, data.detail);
    render(data);
  };

  $('confirm').addEventListener('click', async () => {
    const btn = $('confirm') as HTMLButtonElement;
    btn.disabled = true; btn.textContent = 'Switching…';
    try {
      const r = await fetch('/api/annual-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token }) });
      const data = (await r.json()) as Offer | Refusal;
      if (!data.ok) { btn.disabled = false; btn.textContent = 'Yes, switch me to annual'; return problem(data.reason, data.detail); }
      $('doneText').textContent = data.mode === 'trialing'
        ? `Your trial runs to ${data.newExpiry}. On that day you move onto the annual plan at ${sgd(data.annualPrice)} for 12 months.`
        : `Your ${data.planName} plan is paid until ${data.newExpiry}. Today's charge: ${sgd(data.amountDueToday)}.`;
      $('lead').textContent = '';
      show('done');
    } catch {
      btn.disabled = false; btn.textContent = 'Yes, switch me to annual';
      problem('ineligible');
    }
  });

  load().catch(() => problem('ineligible'));
</script>
```

- [ ] **Step 2: Build the site**

Run: `cd web && npm run build` (no dev server running).
Expected: `/annual/index.html` in `web/dist`, no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/annual.astro
git commit -m "annual: /annual confirmation page"
```

---

### Task 10: Website toggle, trial guide callout, sign-up flag

**Files:**
- Modify: `web/src/data/plans.ts` (add fields), `web/src/components/PriceToggle.astro` (toggle + annual markup + script), `web/src/styles/pricing.css`
- Modify: `web/src/content/guides/trial/start-your-free-trial.mdx`

- [ ] **Step 1: Plan data** — in `web/src/data/plans.ts` extend the interface and every row:

```ts
export interface Plan {
  // ...existing fields...
  annualList: number;
  annualPep: number;
  annualLink: string;
  annualPromoCode: 'NAV70' | 'NAV100';
}

/** Offer window close, 30 Oct 2026 23:59 SGT — mirrors ANNUAL_OFFER_CLOSES_MS in lib/annual-pricing.ts. */
export const ANNUAL_OFFER_CLOSES_MS = Date.UTC(2026, 9, 30, 15, 59);
/** Flip to false on 1 Nov 2026 to close new sign-ups (every Subscribe button becomes a notice). */
export const SIGNUPS_OPEN = true;
```

Per plan (annualList = monthly x 10, annualPep = annualList − 70 or 100):

| code | annualList | annualPep | annualPromoCode | annualLink |
|---|---|---|---|---|
| SG | 360 | 290 | NAV70 | `https://buy.stripe.com/fZu00l5GIbpxaQlecg4ow0e` |
| US | 560 | 490 | NAV70 | `https://buy.stripe.com/bJe5kF4CEdxF1fL5FK4ow0h` |
| HK | 560 | 490 | NAV70 | `https://buy.stripe.com/7sY6oJfhi0KT9Mh2ty4ow0g` |
| FXMC | 560 | 490 | NAV70 | `https://buy.stripe.com/dRm9AV3yAgJR6A5c484ow0f` |
| US_HK | 990 | 890 | NAV100 | `https://buy.stripe.com/7sYcN71qsdxFe2xfgk4ow0i` |
| US_FXMC | 990 | 890 | NAV100 | `https://buy.stripe.com/3cI8wR2uw65d0bH9W04ow0j` |
| HK_FXMC | 990 | 890 | NAV100 | `https://buy.stripe.com/8x23cx7OQ1OX4rX8RW4ow0k` |
| ALL | 1390 | 1290 | NAV100 | `https://buy.stripe.com/9B64gB3yA3X5aQl7NS4ow0l` |

- [ ] **Step 2: Toggle markup** — in `PriceToggle.astro`:

(a) Import `ANNUAL_OFFER_CLOSES_MS, SIGNUPS_OPEN` with `PLANS`. Add `data-billing="quarterly"` to `.pricing-wrap`.

(b) Directly under the existing `.price-toggle` div add a second switch:

```astro
  <div class="price-toggle billing-toggle" role="group" aria-label="Billing period" data-closes={String(ANNUAL_OFFER_CLOSES_MS)}>
    <button class="pt-mode on" type="button" data-billing="quarterly">Quarterly</button>
    <button class="pt-mode" type="button" data-billing="annual">Annual<span class="pt-dot"> · </span><span class="pt-save">2 Months Free</span></button>
  </div>
```

(c) Inside each plan card, after the existing `.qtr` div, add the annual block and switch the button:

```astro
          <div class="annual-block" data-show="annual">
            <div class="was-annual">${p.listQuarterly * 4} SGD on quarterly</div>
            <div class="annual-price">
              <span class="cur">$</span>
              <span class="amt" data-standard={String(p.annualList)} data-pepperstone={String(p.annualPep)}>{p.annualList}</span>
              <span class="punit"><span class="u1">SGD</span><span class="u2">/ year</span></span>
            </div>
            <div class="save">2 months free · until 30 Oct</div>
          </div>
```
and give the Subscribe anchor both links: `href={p.link} data-link-quarterly={p.link} data-link-annual={p.annualLink} data-promo-quarterly={p.promoCode} data-promo-annual={p.annualPromoCode}`. Keep `data-promo={p.promoCode}` (the script rewrites it on toggle). When `SIGNUPS_OPEN` is false render `<span class="btn btn-block btn-ghost">Sign-ups closed for now</span>` instead of the anchor.

(d) Script additions, inside `if (wrap) {` after `setMode` is defined:

```ts
    // --- billing toggle (quarterly / annual) ---
    const billingToggle = wrap.querySelector<HTMLElement>('.billing-toggle');
    const closes = Number(billingToggle?.dataset.closes ?? 0);
    if (billingToggle && Date.now() > closes) billingToggle.remove(); // offer over: quarterly only
    const setBilling = (b: 'quarterly' | 'annual') => {
      wrap.dataset.billing = b;
      wrap.querySelectorAll<HTMLElement>('.billing-toggle .pt-mode').forEach((x) => x.classList.toggle('on', x.dataset.billing === b));
      wrap.querySelectorAll<HTMLAnchorElement>('.sub-btn').forEach((a) => {
        const link = a.dataset[b === 'annual' ? 'linkAnnual' : 'linkQuarterly'];
        const promo = a.dataset[b === 'annual' ? 'promoAnnual' : 'promoQuarterly'];
        if (link) a.href = link;
        if (promo) a.dataset.promo = promo;
      });
      decorateSubscribeLinks('.sub-btn');
    };
    wrap.querySelectorAll<HTMLElement>('.billing-toggle .pt-mode').forEach((b) =>
      b.addEventListener('click', () => setBilling(b.dataset.billing === 'annual' ? 'annual' : 'quarterly')),
    );
    if (new URLSearchParams(location.search).get('billing') === 'annual' && billingToggle) setBilling('annual');
```

The existing `setMode` loop updates every `[data-standard]` element, which now includes the annual `.amt`, so the Pepperstone switch flips annual prices too. The nudge modal's `#pepSaveAmt` text ("$30 SGD less every quarter") must read the billing mode: set it to `100`/`70` and "every year" when `wrap.dataset.billing === 'annual'` — find where `pepSaveAmt` is populated (`btn.dataset.save`) and branch on the billing mode using `data-save-annual={String(p.annualList - p.annualPep)}` added to the anchor.

(e) CSS (`pricing.css`):

```css
.pricing-wrap .annual-block { display: none; }
.pricing-wrap[data-billing="annual"] .annual-block { display: block; }
.pricing-wrap[data-billing="annual"] .price,
.pricing-wrap[data-billing="annual"] .qtr,
.pricing-wrap[data-billing="annual"] .was[data-show="pepperstone"] { display: none; }
.pricing-wrap .was-annual { text-decoration: line-through; color: var(--muted); font-size: 0.95rem; font-weight: 600; margin-bottom: 2px; }
.pricing-wrap .annual-price { display: flex; align-items: baseline; gap: 2px; }
.pricing-wrap .annual-price .amt { font-size: 2.1rem; font-weight: 800; }
.billing-toggle { margin-top: -6px; }
```
(Match `.annual-price` to the existing `.price` rule's font sizes in `global.css` so the two look identical.)

- [ ] **Step 3: Trial guide callout** — in `start-your-free-trial.mdx`, directly after the existing `<GuideCallout title="Important!">…</GuideCallout>` block:

```mdx
<GuideCallout title="Prefer to pay once a year?">
Until **30 October 2026** you can take the annual plan instead of quarterly: **2 months free**, and your plan and price locked for 12 months. All Markets is **$1,390 SGD** for the year ($1,290 SGD with a Pepperstone account). Nothing changes during your trial. Before it ends, we'll email you a one-tap link to switch, and the annual amount is charged on the day your trial ends instead of the quarterly one.
</GuideCallout>
```

- [ ] **Step 4: Build and eyeball**

Run: `cd web && npm run build && npx astro preview --port 4321` then open `http://localhost:4321/#pricing`: both toggles work, annual prices flip with the Pepperstone switch, Subscribe goes to the annual link with `prefilled_promo_code=NAV100` on All Markets. Stop the preview.

- [ ] **Step 5: Commit**

```bash
git add web/src/data/plans.ts web/src/components/PriceToggle.astro web/src/styles/pricing.css web/src/content/guides/trial/start-your-free-trial.mdx
git commit -m "annual: Quarterly/Annual toggle on the pricing cards, trial guide callout, SIGNUPS_OPEN flag"
```

---

### Task 11: Offer emails + send script

**Files:**
- Modify: `lib/email.ts` (`AnnualOfferEmailData`, `sendAnnualOfferEmail`)
- Create: `scripts/annual-offer-send.mts`
- Test: `lib/email.test.ts` (append)

**Interfaces:**
- Consumes: `annualLinkUrl` (Task 6), `ANNUAL_PRICING`, `sgd` (Task 1), `getAllSubscriberRows` (`lib/sheets.ts`), `getBillingInterval`, `isLegacyQuarterlyPrice` (Task 2).
- Produces: `sendAnnualOfferEmail(data)`; `npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing|trial --phase offer|reminder|lastcall [--to email] [--apply]`.

- [ ] **Step 1: Failing email tests** (append to `lib/email.test.ts`)

```ts
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
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: The email** (append to `lib/email.ts`)

```ts
// --- Annual offer (existing subscribers + trial cohort; Joseph sends via script) ---

export interface AnnualOfferEmailData {
  email: string;
  name: string;
  planType: string;
  /** What they pay per quarter today (0 for a trialist). */
  currentPrice: number;
  /** The annual price for their tier, SGD. */
  annualPrice: number;
  link: string;
  grandfathered: boolean;
  audience: "existing" | "trial";
  phase: "offer" | "reminder" | "lastcall";
  /** Trial end, formatted, for the trial audience. */
  trialEnd?: string;
}

export async function sendAnnualOfferEmail(data: AnnualOfferEmailData): Promise<void> {
  const { email, name, planType, currentPrice, annualPrice, link, grandfathered, audience, phase, trialEnd } = data;
  const planName = getPlanDisplayName(planType);
  const isTrial = audience === "trial";

  const subject =
    phase === "lastcall"
      ? "Last call: annual plan closes tomorrow night"
      : phase === "reminder"
        ? "Reminder: annual plan, 2 months free, until 30 October"
        : isTrial
          ? "Before your trial ends: annual plan, 2 months free"
          : "Lock in your Navigator plan for a year, 2 months free";
  const title = isTrial ? "Annual plan, 2 months free" : "Lock in your plan for a year";

  const why = `TradingView is changing how indicators like the Navigator are sold from 1 November. Anything you have paid for before then is honoured in full, so we are opening a one-time annual plan this October.`;

  const intro = isTrial
    ? `Hi ${name}, your free trial runs to <strong style="color:${INK};">${trialEnd ?? ""}</strong>. Before it ends, you can choose to move onto the annual plan instead of quarterly.`
    : `Hi ${name}, you are on <strong style="color:${INK};">${planName}</strong> at <strong style="color:${INK};">${sgd(currentPrice)}</strong> every 3 months. Until 30 October you can switch to an annual plan and get 2 months free.`;

  const offerRows = `
    <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Plan</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${planName}</td></tr>
    ${isTrial ? "" : `<tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Now</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${sgd(currentPrice)} every 3 months</td></tr>`}
    <tr><td style="padding:7px 0; border-bottom:1px solid #eef2f8;">Annual</td><td align="right" style="padding:7px 0; border-bottom:1px solid #eef2f8; color:${INK}; font-weight:700;">${sgd(annualPrice)} for 12 months</td></tr>
    <tr><td style="padding:7px 0;">${isTrial ? "Charged on" : "Offer closes"}</td><td align="right" style="padding:7px 0; color:${INK}; font-weight:700;">${isTrial ? (trialEnd ?? "") : "30 October 2026, 11:59pm"}</td></tr>`;

  const detailsRow = `    <tr><td class="em-pad" style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${CARD_BORDER}; border-radius:14px;">
        <tr><td style="padding:22px 22px 24px;">
          <div style="font-family:${FONT}; font-size:15px; font-weight:800; letter-spacing:.3px; color:${INK}; margin-bottom:14px;">The annual plan</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${FONT}; font-size:15px; color:${BODY_TEXT};">${offerRows}</table>
          <div style="margin-top:18px;">${button(link, "Switch to annual", "primary")}</div>
        </td></tr>
      </table>
    </td></tr>`;

  const howText = isTrial
    ? `Tap the button, check the numbers, and confirm. Nothing is charged now. On the day your trial ends, your card is charged ${sgd(annualPrice)} once instead of the quarterly amount, and you are set for the year.`
    : `Tap the button, check the numbers, and confirm. The unused part of your current quarter is credited against the charge, so you pay less than ${sgd(annualPrice)} today, and your plan runs 12 months from today.${grandfathered ? " Your current price is locked in for the year." : ""}`;

  const contentRows = [
    titleRow(title, intro),
    plainWell(para(why, 0, 0)),
    detailsRow,
    plainWell(para(howText, 0, 0)),
    footerRow([
      "This is a one-time offer for October only. If you would rather stay quarterly, you do not need to do anything.",
      SUPPORT_LINE,
    ]),
  ].join("\n");

  const html = emailShell({ title, preheader: `${sgd(annualPrice)} for 12 months, 2 months free, until 30 October.`, contentRows });

  const text = `${title}

Hi ${name},
${isTrial
    ? `Your free trial runs to ${trialEnd ?? ""}. Before it ends, you can choose to move onto the annual plan instead of quarterly.`
    : `You are on ${planName} at ${sgd(currentPrice)} every 3 months. Until 30 October you can switch to an annual plan and get 2 months free.`}

${why}

The annual plan:
- Plan: ${planName}
${isTrial ? "" : `- Now: ${sgd(currentPrice)} every 3 months\n`}- Annual: ${sgd(annualPrice)} for 12 months
- ${isTrial ? `Charged on: ${trialEnd ?? ""}` : "Offer closes: 30 October 2026, 11:59pm"}

Switch to annual: ${link}

${howText}

This is a one-time offer for October only. If you would rather stay quarterly, you do not need to do anything.
Need help? Message @Joseph_Ho on Telegram
RHO Navigator · Trading signals service`;

  await sendEmail({ to: email, subject, html, text });
}
```

- [ ] **Step 4: The send script**

```ts
// scripts/annual-offer-send.mts
/**
 * Prepare (and, with --apply, send) the annual-offer emails. Joseph runs this
 * by hand; nothing is scheduled.
 *
 *   npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing --phase offer            (dry run)
 *   npx tsx --env-file=.env scripts/annual-offer-send.mts --audience trial --phase offer --to me@x.com  (one address)
 *   npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing --phase reminder --apply
 *
 * existing = ACTIVE + CANCELLATION_SCHEDULED rows with a Stripe sub ID (comps skipped)
 * trial    = TRIAL_ACTIVE + TRIAL_CANCELLATION_SCHEDULED rows
 * Every phase skips subscriptions already on a yearly price (checked live).
 * Dry run prints the recipient table and renders ONE sample to --to (if given).
 */
import Stripe from "stripe";
import { getAllSubscriberRows } from "../lib/sheets.js";
import { sendAnnualOfferEmail } from "../lib/email.js";
import { annualLinkUrl } from "../lib/annual-link.js";
import { ANNUAL_PRICING, isPlanType, sgd } from "../lib/annual-pricing.js";
import { getBillingInterval, isLegacyQuarterlyPrice } from "../lib/plans.js";
import { formatDisplayDateSGT } from "../lib/format-date.js";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] ?? null; };
const audience = arg("audience") as "existing" | "trial" | null;
const phase = arg("phase") as "offer" | "reminder" | "lastcall" | null;
const only = arg("to");
const apply = process.argv.includes("--apply");
if (!audience || !phase) { console.error("need --audience existing|trial --phase offer|reminder|lastcall"); process.exit(1); }
const secret = process.env.ANNUAL_LINK_SECRET;
if (!secret) { console.error("ANNUAL_LINK_SECRET not set"); process.exit(1); }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2025-08-27.basil" });
const STATUSES = audience === "existing"
  ? new Set(["ACTIVE", "CANCELLATION_SCHEDULED"])
  : new Set(["TRIAL_ACTIVE", "TRIAL_CANCELLATION_SCHEDULED"]);

const rows = (await getAllSubscriberRows()).filter(
  (r) => STATUSES.has(r.status) && r.stripeSubscriptionId.trim() !== "" && (!only || r.email.toLowerCase() === only.toLowerCase())
);

type Prepared = { email: string; name: string; plan: string; current: number; annual: number; link: string; grandfathered: boolean; trialEnd?: string; skip?: string };
const prepared: Prepared[] = [];
for (const r of rows) {
  const sub = await stripe.subscriptions.retrieve(r.stripeSubscriptionId, { expand: ["discounts"] });
  const priceId = sub.items.data[0]?.price?.id ?? "";
  let interval: "quarter" | "year" = "quarter";
  try { interval = getBillingInterval(priceId); } catch { /* unknown price -> treat as quarter, flag below */ }
  if (interval === "year") { prepared.push({ email: r.email, name: r.customerName, plan: r.currentPlan, current: r.subscriptionPrice, annual: 0, link: "", grandfathered: false, skip: "already annual" }); continue; }
  if (!isPlanType(r.currentPlan)) { prepared.push({ email: r.email, name: r.customerName, plan: r.currentPlan, current: r.subscriptionPrice, annual: 0, link: "", grandfathered: false, skip: "unknown plan" }); continue; }
  const row = ANNUAL_PRICING[r.currentPlan];
  const grandfathered = isLegacyQuarterlyPrice(priceId);
  const hasPep = (sub.discounts ?? []).some((d) => typeof d !== "string" && ["gcUCHGHv", "7imb0DBR"].includes(typeof d.coupon === "string" ? d.coupon : d.coupon?.id ?? ""));
  const annual = grandfathered ? row.grandfathered : hasPep ? row.pepperstone : row.list;
  prepared.push({
    email: r.email, name: r.customerName.split(" ")[0] || r.customerName, plan: r.currentPlan,
    current: r.subscriptionPrice, annual, grandfathered,
    link: annualLinkUrl(r.stripeSubscriptionId, r.email, secret),
    trialEnd: sub.trial_end ? formatDisplayDateSGT(new Date(sub.trial_end * 1000)) : undefined,
  });
}

console.log(`${audience}/${phase}: ${prepared.length} rows, ${prepared.filter((p) => !p.skip).length} to send, ${prepared.filter((p) => p.skip).length} skipped`);
for (const p of prepared) console.log(`${p.skip ? "SKIP " : "SEND "}${p.email.padEnd(36)} ${p.plan.padEnd(12)} ${p.skip ?? `${sgd(p.current)} -> ${sgd(p.annual)}${p.grandfathered ? " (grandfathered)" : ""}`}`);
if (!apply) { console.log("\nDRY RUN — add --apply to send"); process.exit(0); }

let sent = 0; const failures: string[] = [];
for (const p of prepared.filter((x) => !x.skip)) {
  try {
    await sendAnnualOfferEmail({ email: p.email, name: p.name, planType: p.plan, currentPrice: p.current, annualPrice: p.annual, link: p.link, grandfathered: p.grandfathered, audience, phase, trialEnd: p.trialEnd });
    sent++;
    await new Promise((r) => setTimeout(r, 600)); // Resend rate limit: 2 req/s
  } catch (err) {
    failures.push(`${p.email}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\nsent ${sent}, failures ${failures.length}`);
for (const f of failures) console.log(`  ${f}`);
```

- [ ] **Step 5: Run** — `npx tsc --noEmit && npx vitest run` → green. Then a dry run against the live sheet (reads only):

`npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing --phase offer | head -20` — expect ~173 rows listed, all `SEND`, prices matching the table (e.g. an old-price All Markets row shows `$388 SGD -> $1,290 SGD (grandfathered)`).

- [ ] **Step 6: Commit**

```bash
git add lib/email.ts lib/email.test.ts scripts/annual-offer-send.mts
git commit -m "annual: offer/reminder emails + send script (dry-run default)"
```

---

### Task 12: Test-mode end to end, deploy, live run

This task is a checklist; it needs Joseph for two inputs (test-mode key, Vercel env var) and his go-ahead for the live run.

- [ ] **Step 1: Test-mode Stripe objects.** Ask Joseph for the `sk_test_` key. Then:
  `STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/setup-annual-prices.mts --apply` (Bash: `env STRIPE_SECRET_KEY=... npx tsx ...`). Paste the printed `annualList` and `annualGrandfathered` test IDs into `TEST_ANNUAL_LIST` / `TEST_ANNUAL_GRANDFATHERED` in `lib/plans.ts`. Run `npx vitest run lib/plans.test.ts`. Commit: `git commit -am "annual: test-mode annual price IDs"`.

- [ ] **Step 2: Local stack.** Create `.env.local` entries (test key, test webhook secret from `stripe listen`, `GOOGLE_SHEET_TAB_NAME=Test` pointing at a test tab Joseph creates by duplicating the Subscribers header row, `ANNUAL_LINK_SECRET` from `.env`, `SUPPRESS_CUSTOMER_EMAILS=false`, `BCC_EMAIL` = Joseph). Run `npx vercel dev` and in a second shell `stripe listen --forward-to localhost:3000/api/stripe-webhook`.

- [ ] **Step 3: Two test subscriptions.** In test mode create (dashboard or `stripe` CLI) (a) an active All Markets subscription on the test quarterly price with coupon `7imb0DBR`'s test-mode equivalent (check which NAV30 coupon ID exists in test; if none, create `NAV30` there) started 40 days ago via a test clock, and (b) a trialing All Markets subscription with `trial_end` 10 days out. Add a sheet row for each on the test tab (email, plan, status `ACTIVE` / `TRIAL_ACTIVE`, sub ID).

- [ ] **Step 4: Magic link, active.** `node -e` the link: `npx tsx --env-file=.env.local -e "import('./lib/annual-link.js').then(m=>console.log(m.annualLinkUrl('sub_test_a','a@test.com',process.env.ANNUAL_LINK_SECRET,'http://localhost:3000')))"`. Open it: the page shows plan, current price, annual 1,290, an amount due today lower than 1,290, expiry a year out. Confirm. Expect: Stripe invoice `subscription_update` paid; webhook → `ANNUAL_SWITCH` row written on the test tab (price 1290, coupon NAV100, expiry +12 months, Latest Action ANNUAL_SWITCH, green), Status Log row, Telegram ping "Annual switch", confirmation email received. Refresh the page: "already on the annual plan". Repeat the POST with curl: idempotent, no second invoice.

- [ ] **Step 5: Magic link, trialing.** Same for sub (b): amount due 0, "Trial ends, annual starts" = trial end. Confirm. Expect: price on the subscription is the annual one, no invoice, trial end unchanged, webhook `ANNUAL_SWITCH` with "charged at trial end", email variant for trialists. Advance the test clock past the trial end: `TRIAL_CONVERTED` + `RENEWED` fire with `billingInterval: "year"`, charge = 1,390 (no coupon) or 1,290 (if NAV100 was attached), expiry +1 year.

- [ ] **Step 6: Declined card.** Attach test card `4000 0000 0000 0341` to a third active subscription; open its link; Confirm. Expect: page shows "The payment did not go through" with the Update-my-card button; subscription unchanged (still quarterly, same anchor); ping "Annual switch payment failed".

- [ ] **Step 7: Preview discounts check.** If Step 4's "amount due today" ignored NAV100 (i.e. equals list minus credit), apply the fallback noted in Task 8 (`subscription_details.items[0].discounts`) and re-run Step 4.

- [ ] **Step 8: Deploy.** Joseph adds `ANNUAL_LINK_SECRET` (same value as local `.env`) to Vercel production env. Then `git push origin main`. Wait for Ready: `npx vercel inspect <deployment-url> --wait`. Check live: `https://rho-market-navigator.vercel.app/#pricing` shows the Annual toggle; `https://rho-market-navigator.vercel.app/annual` (no token) shows "This link is not valid"; `curl -s https://rho-market-navigator.vercel.app/api/annual-switch?t=x` returns `{"ok":false,"reason":"invalid"}`.

- [ ] **Step 9: Live run on Joseph's test subscription** (`sub_1TysDTPApeZiCPK2tGRYpt2n`, his own All Markets trial-turned-sub; CONFIRM WITH JOSEPH FIRST, it charges his card). `npx tsx --env-file=.env scripts/annual-offer-send.mts --audience existing --phase offer --to <joseph's email> --apply` sends him the real email. He taps the link, confirms. Expect the full live chain: Stripe invoice, sheet row updated, Status Log, ping, confirmation email. Then Joseph refunds himself in Stripe if he wants (refunds are manual by design).

- [ ] **Step 10: Hand over.** Update `CLAUDE.md` (this repo): add `ANNUAL_SWITCH` to the `SubscriberAction` table's PLAN_CHANGED row, a paragraph on `api/annual-switch.ts` + `lib/annual-link.ts` + `lib/annual-switch.ts`, the `annual-offer-send.mts` usage line, and the 31 Oct closing checklist (deactivate the 8 annual payment links, switch off portal plan changes, confirm the toggle and endpoint closed). Commit and push. Report to Joseph with the dry-run recipient counts; the broadcast is his call.
