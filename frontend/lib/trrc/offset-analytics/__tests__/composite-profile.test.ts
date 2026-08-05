import { describe, it, expect } from "vitest";
import { aggregateParameters, buildNormalizedTypeCurve } from "../composite-profile";
import { fitAnalogDecline } from "../analog-decline-fitting";
import type { AnalogProductionRow } from "../production-loader";

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
    return { productionMonth: `${year}-${String(month).padStart(2, "0")}`, oilBbl: Math.round(v), gasMcf: null, casingheadGasMcf: null, condensateBbl: null };
  });
}

describe("aggregateParameters — median, not mean", () => {
  it("returns null when no fits passed QC", () => {
    expect(aggregateParameters([])).toBeNull();
  });

  it("uses the median qi, which is robust to one outlier analog — a mean would be pulled hard, median should not", () => {
    const fits = [
      fitAnalogDecline("low", rowsFromOilSeries(generateCurve(1000, 0.05, 0.9, 36))),
      fitAnalogDecline("mid", rowsFromOilSeries(generateCurve(1100, 0.05, 0.9, 36))),
      fitAnalogDecline("huge_outlier", rowsFromOilSeries(generateCurve(50000, 0.05, 0.9, 36))), // one exceptional well
    ];
    const result = aggregateParameters(fits);
    expect(result).not.toBeNull();
    // Median of [1000ish, 1100ish, 50000ish] is the middle value, not dragged toward the outlier the way a mean would be.
    expect(result!.qiMedian).toBeLessThan(2000);
  });

  it("only includes QC-passed fits in the aggregate", () => {
    const fits = [
      fitAnalogDecline("good", rowsFromOilSeries(generateCurve(2000, 0.05, 0.9, 36))),
      fitAnalogDecline("too_short", rowsFromOilSeries([100, 90])), // fails QC
    ];
    const result = aggregateParameters(fits);
    expect(result!.analogCount).toBe(1);
  });
});

describe("buildNormalizedTypeCurve", () => {
  it("computes P25 <= P50 <= P75 at every month index", () => {
    const analogs = [
      { api: "a", oilSeries: generateCurve(1000, 0.05, 0.9, 24), lateralLengthFt: 8000 },
      { api: "b", oilSeries: generateCurve(1500, 0.05, 0.9, 24), lateralLengthFt: 8000 },
      { api: "c", oilSeries: generateCurve(2000, 0.05, 0.9, 24), lateralLengthFt: 8000 },
    ];
    const result = buildNormalizedTypeCurve(analogs, 8000);
    for (const m of result.months) {
      expect(m.p25).toBeLessThanOrEqual(m.p50);
      expect(m.p50).toBeLessThanOrEqual(m.p75);
    }
  });

  it("scales a shorter-lateral analog UP to match a longer subject lateral length", () => {
    const analogs = [{ api: "a", oilSeries: [1000], lateralLengthFt: 5000 }];
    const result = buildNormalizedTypeCurve(analogs, 10000); // subject has a 2x longer lateral
    expect(result.lateralNormalizationApplied).toBe(true);
    expect(result.months[0].p50).toBeCloseTo(2000, 4); // 1000 * (10000/5000)
  });

  it("includes an analog missing lateral length UNSCALED, with a warning, rather than dropping it", () => {
    const analogs = [
      { api: "known", oilSeries: [1000], lateralLengthFt: 10000 },
      { api: "unknown_length", oilSeries: [1000], lateralLengthFt: null },
    ];
    const result = buildNormalizedTypeCurve(analogs, 10000);
    expect(result.months[0].wellCount).toBe(2); // both included
    expect(result.warnings.some(w => w.code === "PARTIAL_LATERAL_NORMALIZATION")).toBe(true);
  });

  it("uses raw unscaled volumes with a warning when the subject's own lateral length is unknown", () => {
    const analogs = [{ api: "a", oilSeries: [1000], lateralLengthFt: 8000 }];
    const result = buildNormalizedTypeCurve(analogs, null);
    expect(result.lateralNormalizationApplied).toBe(false);
    expect(result.months[0].p50).toBe(1000); // unscaled
    expect(result.warnings.some(w => w.code === "NO_SUBJECT_LATERAL_LENGTH")).toBe(true);
  });

  it("thins wellCount toward the tail as shorter-history analogs run out of months", () => {
    const analogs = [
      { api: "long", oilSeries: [100, 90, 80, 70, 60], lateralLengthFt: 8000 },
      { api: "short", oilSeries: [100, 90], lateralLengthFt: 8000 },
    ];
    const result = buildNormalizedTypeCurve(analogs, 8000);
    expect(result.months[0].wellCount).toBe(2);
    expect(result.months[4].wellCount).toBe(1);
  });

  it("returns a critical warning and no months for an empty analog set, not a fabricated curve", () => {
    const result = buildNormalizedTypeCurve([], 8000);
    expect(result.months).toEqual([]);
    expect(result.warnings.some(w => w.severity === "critical")).toBe(true);
  });
});
