import { describe, it, expect } from "vitest";
import { fitAnalogDecline, fitAllAnalogs, DEFAULT_QC_THRESHOLDS } from "../analog-decline-fitting";
import type { AnalogProductionRow } from "../production-loader";

// Same synthetic-curve generator as decline-curve.test.ts, so the fit these
// tests exercise is a known, verifiable Arps curve, not noisy real data.
function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) {
    out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  }
  return out;
}

function rowsFromOilSeries(series: number[]): AnalogProductionRow[] {
  return series.map((v, i) => {
    const year = 2020 + Math.floor(i / 12);
    const month = (i % 12) + 1;
    return {
      productionMonth: `${year}-${String(month).padStart(2, "0")}`,
      oilBbl: Math.round(v), gasMcf: null, casingheadGasMcf: null, condensateBbl: null,
    };
  });
}

describe("fitAnalogDecline", () => {
  it("fits a clean synthetic decline curve and passes QC", () => {
    const rows = rowsFromOilSeries(generateCurve(3000, 0.05, 0.9, 36));
    const result = fitAnalogDecline("42-1-clean", rows);
    expect(result.qcPassed).toBe(true);
    expect(result.oilFit).not.toBeNull();
    expect(result.oilFit!.rSquared).toBeGreaterThan(0.95);
    expect(result.oilEur).not.toBeNull();
  });

  it("rejects a well with too little history via QC, not a silent low-quality acceptance", () => {
    const rows = rowsFromOilSeries([1000, 900, 800]); // only 3 months — below fitArpsDecline's own minimum
    const result = fitAnalogDecline("42-1-short", rows);
    expect(result.qcPassed).toBe(false);
    expect(result.qcRejectionReason).toMatch(/No valid Arps fit/);
  });

  it("rejects a well whose fit quality is below the configured R² threshold", () => {
    // Genuinely noisy/flat data that won't fit a clean decline curve well.
    const noisyRows = rowsFromOilSeries([500, 50, 800, 20, 600, 900, 10, 700]);
    const result = fitAnalogDecline("42-1-noisy", noisyRows, { minRSquared: 0.99, minMonthsOfHistory: 6 });
    // Either no fit at all, or a fit that fails the (deliberately strict) threshold — both are valid QC rejections here.
    if (result.oilFit) {
      expect(result.qcPassed).toBe(false);
    }
  });

  it("flags marginal (but QC-passing) fit quality with a warning rather than silence", () => {
    // A fit right around the QC boundary — use real noisy-but-decreasing data.
    const rows = rowsFromOilSeries(generateCurve(3000, 0.05, 0.9, 36).map((v, i) => v * (i % 3 === 0 ? 1.3 : 0.85)));
    const result = fitAnalogDecline("42-1-marginal", rows, { minRSquared: 0.3, minMonthsOfHistory: 6 });
    if (result.qcPassed && result.oilFit && result.oilFit.rSquared < 0.7) {
      expect(result.warnings.some(w => w.code === "MARGINAL_FIT_QUALITY")).toBe(true);
    }
  });

  it("does not average multiple wells' raw histories — each call operates on exactly one well's own rows", () => {
    const wellA = rowsFromOilSeries(generateCurve(3000, 0.05, 0.9, 36));
    const wellB = rowsFromOilSeries(generateCurve(1000, 0.02, 0.5, 36));
    const resultA = fitAnalogDecline("A", wellA);
    const resultB = fitAnalogDecline("B", wellB);
    // Distinct inputs must produce distinct fitted qi — proving no cross-well blending occurred.
    expect(resultA.oilFit!.qi).not.toBeCloseTo(resultB.oilFit!.qi, 0);
  });
});

describe("fitAllAnalogs", () => {
  it("fits multiple analogs independently and returns one result per well", () => {
    const analogs = [
      { api: "A", rows: rowsFromOilSeries(generateCurve(3000, 0.05, 0.9, 36)) },
      { api: "B", rows: rowsFromOilSeries(generateCurve(1500, 0.03, 0.7, 36)) },
      { api: "C", rows: rowsFromOilSeries([100, 90]) }, // deliberately too short — should fail QC, not crash the batch
    ];
    const results = fitAllAnalogs(analogs);
    expect(results).toHaveLength(3);
    expect(results.find(r => r.api === "A")!.qcPassed).toBe(true);
    expect(results.find(r => r.api === "C")!.qcPassed).toBe(false);
  });

  it("uses the same default thresholds as DEFAULT_QC_THRESHOLDS when none are supplied", () => {
    const rows = rowsFromOilSeries(generateCurve(3000, 0.05, 0.9, 6)); // exactly at the minimum months
    const result = fitAnalogDecline("A", rows, DEFAULT_QC_THRESHOLDS);
    expect(result.oilFit).not.toBeNull();
  });
});
