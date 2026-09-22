import { describe, it, expect } from "vitest";
import { fitArpsDecline, fitArpsDeclineWindowed } from "../decline-curve";

// Real lease production, CMC Buttercup 25-37 Unit (lease 59990, Midland),
// as retrieved in production run c0a6fc7e on 2026-09-22. Reported months only.
const BUTTERCUP = [430, 35933, 62536, 63941, 55457, 52419, 48571, 41606, 30163, 31225, 33550, 36826, 25657, 41076, 155023, 137307, 115337, 113217, 99748, 82360, 80012, 75642, 68835, 58847, 54372, 51304, 51647, 41406, 36017, 43702, 38544, 35949, 35114, 36492];

function curve(qi: number, di: number, b: number, months: number): number[] {
  return Array.from({ length: months }, (_, t) => Math.round(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b)));
}

describe("fitArpsDeclineWindowed — infill step changes on lease production", () => {
  it("fits the real Buttercup lease, which has no whole-series fit at all", () => {
    expect(fitArpsDecline(BUTTERCUP)).toBeNull();
    const w = fitArpsDeclineWindowed(BUTTERCUP);
    expect(w.fit).not.toBeNull();
    expect(w.startIndex).toBe(14);          // the 155,023 step
    expect(w.fit!.monthsOfHistory).toBe(20);
    expect(w.fit!.rSquared).toBeGreaterThan(0.95);
    expect(w.reason).toMatch(/step change/i);
    expect(w.reason).toMatch(/excluded from the forecast, not from the record/);
  });

  it("leaves an ordinary declining series completely untouched", () => {
    const series = curve(3000, 0.08, 0.9, 36);
    const w = fitArpsDeclineWindowed(series);
    expect(w.startIndex).toBe(0);
    expect(w.monthsExcluded).toBe(0);
    expect(w.reason).toBeNull();
    expect(w.fit).toEqual(fitArpsDecline(series));
  });

  it("does not window on noise — a small bump is not a step change", () => {
    const series = curve(3000, 0.08, 0.9, 30);
    series[20] = Math.round(series[20] * 1.25);
    const w = fitArpsDeclineWindowed(series);
    expect(w.startIndex).toBe(0);
    expect(w.reason).toBeNull();
  });

  it("refuses a step too close to the end to fit", () => {
    const series = [...curve(3000, 0.08, 0.9, 24), 40000, 38000, 36000];
    const w = fitArpsDeclineWindowed(series);
    expect(w.startIndex).toBe(0);
    expect(w.reason).toBeNull();
  });

  it("picks the most recent step when a lease was drilled twice", () => {
    const series = [...curve(1000, 0.09, 0.8, 12), ...curve(5000, 0.09, 0.8, 12), ...curve(20000, 0.09, 0.8, 14)];
    const w = fitArpsDeclineWindowed(series);
    expect(w.startIndex).toBe(24);
    expect(w.fit!.monthsOfHistory).toBe(14);
  });
});
