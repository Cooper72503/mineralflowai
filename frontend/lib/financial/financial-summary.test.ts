import { describe, expect, it } from "vitest";
import {
  buildFinancialSummary,
  extractExplicitAnnualRevenueRange,
  extractExplicitMonthlyRevenueRange,
  parseFinancialSignalsFromText,
  parseMoneyToken,
  parseRoyaltyOrDecimalFraction,
} from "./financial-summary";

describe("parseMoneyToken", () => {
  it("parses K and M suffixes", () => {
    expect(parseMoneyToken("30", "K")).toBe(30_000);
    expect(parseMoneyToken("1.2", "M")).toBe(1_200_000);
  });
});

describe("extractExplicitMonthlyRevenueRange", () => {
  it("parses explicit $30,000 per month", () => {
    const r = extractExplicitMonthlyRevenueRange("Owner receives $30,000 per month from royalties.");
    expect(r).toEqual({ min: 30_000, max: 30_000 });
  });

  it("parses range $30,000 to $40,000 per month", () => {
    const r = extractExplicitMonthlyRevenueRange(
      "Average checks ranged from $30,000 to $40,000 per month in 2023."
    );
    expect(r).toEqual({ min: 30_000, max: 40_000 });
  });

  it("parses $30K monthly", () => {
    const r = extractExplicitMonthlyRevenueRange("Net revenue about $30K monthly.");
    expect(r).toEqual({ min: 30_000, max: 30_000 });
  });
});

describe("extractExplicitAnnualRevenueRange", () => {
  it("parses annual range", () => {
    const r = extractExplicitAnnualRevenueRange("Gross revenue was $360,000 to $480,000 per year.");
    expect(r).toEqual({ min: 360_000, max: 480_000 });
  });
});

describe("parseRoyaltyOrDecimalFraction", () => {
  it("parses fraction and percent", () => {
    expect(parseRoyaltyOrDecimalFraction("1/8")).toBeCloseTo(0.125);
    expect(parseRoyaltyOrDecimalFraction("12.5%")).toBeCloseTo(0.125);
  });
});

describe("buildFinancialSummary", () => {
  const baseInput = { county: "Midland", acreage: 40, development_signals: { has_development_signals: true } };

  it("CASE 1: explicit monthly revenue yields valuation 24x–48x monthly", () => {
    const text = "The royalty checks average $30,000 per month.";
    const s = buildFinancialSummary({
      extractedText: text,
      dealScoreInput: baseInput,
      royaltyRateStr: null,
      county: "Midland",
    });
    expect(s.has_financials).toBe(true);
    expect(s.monthly_revenue_estimate_min).toBe(30_000);
    expect(s.monthly_revenue_estimate_max).toBe(30_000);
    expect(s.annual_revenue_estimate_min).toBe(30_000 * 12);
    expect(s.valuation_estimate_min).toBe(30_000 * 24);
    expect(s.valuation_estimate_max).toBe(30_000 * 48);
    expect(s.confidence).toBe("High");
  });

  it("CASE 1: monthly range sets min/max", () => {
    const s = buildFinancialSummary({
      extractedText: "$30,000 to $40,000 per month",
      dealScoreInput: {},
      royaltyRateStr: null,
      county: null,
    });
    expect(s.has_financials).toBe(true);
    expect(s.monthly_revenue_estimate_min).toBe(30_000);
    expect(s.monthly_revenue_estimate_max).toBe(40_000);
    expect(s.confidence).toBe("Medium");
  });

  it("explicit annual revenue converts to monthly and valuation bands", () => {
    const s = buildFinancialSummary({
      extractedText: "Total royalty income was $360,000 per year.",
      dealScoreInput: {},
      royaltyRateStr: null,
      county: null,
    });
    expect(s.has_financials).toBe(true);
    expect(s.monthly_revenue_estimate_min).toBe(30_000);
    expect(s.monthly_revenue_estimate_max).toBe(30_000);
    expect(s.annual_revenue_estimate_min).toBe(360_000);
    expect(s.valuation_estimate_min).toBe(30_000 * 24);
    expect(s.valuation_estimate_max).toBe(30_000 * 48);
  });

  it("does not invent dollars when text lacks financial signals", () => {
    const s = buildFinancialSummary({
      extractedText: "MINERAL DEED for 40 acres in Reeves County, Texas.",
      dealScoreInput: { acreage: 40, county: "Reeves" },
      royaltyRateStr: null,
      county: "Reeves",
    });
    expect(s.has_financials).toBe(false);
    expect(s.monthly_revenue_estimate_min).toBeUndefined();
    expect(s.valuation_estimate_min).toBeUndefined();
  });

  it("regional mode: acreage + county + development without dollars stays non-numeric", () => {
    const s = buildFinancialSummary({
      extractedText: "Wolfcamp lease; 80 net mineral acres in Midland County.",
      dealScoreInput: {
        acreage: 80,
        county: "Midland",
        development_signals: { has_development_signals: true, matched_signals: ["a", "b"] },
      },
      royaltyRateStr: "1/8",
      county: "Midland",
    });
    expect(s.has_financials).toBe(false);
    expect(s.monthly_revenue_estimate_min).toBeUndefined();
    expect(s.payback_context).toMatch(/directional|potential|infer/i);
  });
});

describe("parseFinancialSignalsFromText", () => {
  it("detects keywords", () => {
    const p = parseFinancialSignalsFromText("net revenue and royalty on 100 MCF per month", "12.5%");
    expect(p.hasNetRevenueKeyword).toBe(true);
    expect(p.hasRoyaltyKeyword).toBe(true);
    expect(p.royaltyFraction).toBeCloseTo(0.125);
  });
});
