// =============================================================================
// SHEET ROW PARSING TESTS
// =============================================================================
// parseRow turns a raw Google Sheets row (all cells arrive as strings under the
// default FORMATTED_VALUE render) into a typed SheetRow. The price column is the
// sharp edge: a manually-typed "$264 SGD" or a currency-formatted cell read back
// as "$264.00" must still parse to a bare number. When it doesn't, the price
// reads as 0 and every same-plan renewal looks like a price drift, firing a
// spurious "Price Updated (same plan)" admin ping.
// =============================================================================

import { describe, test, expect } from "vitest";
import { parseRow } from "./sheets.js";

// A full A–T row. Index matches the column letters in sheets.ts COL map.
function row(priceCell: string, couponCell = "TRUE"): string[] {
  return [
    "tan@example.com",     // A email
    "Tan Ah Kow",          // B name
    "tanahkow",            // C tradingview
    "tanahkow",            // D telegram
    "ACTIVE",              // E status
    "US_SG_FXMC",          // F plan
    "RENEWAL",             // G latest action
    "",                    // H previous plan
    priceCell,             // I subscription price  <-- under test
    couponCell,            // J coupon code (legacy rows may carry TRUE/FALSE)
    "16 April 2026 18:00", // K start
    "16 July 2026 18:00",  // L expiry
    "3",                   // M count
    "0",                   // N failed payments
    "sub_123",             // O stripe sub id
    "",                    // P telegram user id
    "", "", "",            // Q/R/S manual columns
    "",                    // T referral
  ];
}

describe("parseRow — price cell", () => {
  test("parses a bare number", () => {
    expect(parseRow(row("264"), 2).subscriptionPrice).toBe(264);
  });

  test("parses a manually-typed '$264 SGD' as 264", () => {
    expect(parseRow(row("$264 SGD"), 2).subscriptionPrice).toBe(264);
  });

  test("parses a currency-formatted '$264.00' as 264", () => {
    expect(parseRow(row("$264.00"), 2).subscriptionPrice).toBe(264);
  });

  test("parses a thousands-separated '$1,299' as 1299", () => {
    expect(parseRow(row("$1,299"), 2).subscriptionPrice).toBe(1299);
  });

  test("an empty price cell is 0", () => {
    expect(parseRow(row(""), 2).subscriptionPrice).toBe(0);
  });

  test("pure non-numeric text is 0", () => {
    expect(parseRow(row("free"), 2).subscriptionPrice).toBe(0);
  });
});

// Col J migrated from a TRUE/FALSE checkbox to the coupon code text
// (2026-08-06). Both shapes must parse: code cells carry the code and read as
// discounted; legacy checkbox values keep their old boolean meaning with no
// code to report.
describe("parseRow — coupon cell (J)", () => {
  test("a coupon code reads as discounted, code preserved", () => {
    const r = parseRow(row("264", "NAV30"), 2);
    expect(r.couponCode).toBe("NAV30");
    expect(r.couponDiscount).toBe(true);
  });

  test("legacy checkbox TRUE means discounted, code unknown", () => {
    const r = parseRow(row("264", "TRUE"), 2);
    expect(r.couponCode).toBe("");
    expect(r.couponDiscount).toBe(true);
  });

  test("legacy checkbox FALSE means no discount", () => {
    const r = parseRow(row("264", "FALSE"), 2);
    expect(r.couponCode).toBe("");
    expect(r.couponDiscount).toBe(false);
  });

  test("an empty cell means no discount", () => {
    const r = parseRow(row("264", ""), 2);
    expect(r.couponCode).toBe("");
    expect(r.couponDiscount).toBe(false);
  });
});
