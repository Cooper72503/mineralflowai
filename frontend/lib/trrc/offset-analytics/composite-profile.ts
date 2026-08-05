/**
 * Composite analog profile — aggregates already-independently-fitted
 * analog wells (analog-decline-fitting.ts, Phase 11) into a single
 * representative profile for the subject tract. Two methods, per spec:
 *
 *   A. Parameter aggregation — robust median (not mean) of qi/di/b across
 *      QC-passed fits.
 *   B. Normalized type-curve aggregation — aligns each well's series to
 *      "months since first production" (already true by construction,
 *      since fitArpsDecline's cleaned series starts at its own t=0), scales
 *      by lateral length when both the subject and a given analog's length
 *      are known (a well drilled with a 5,000ft lateral doesn't produce
 *      like one with 10,000ft — comparing raw volumes without this
 *      adjustment would be misleading), then computes P25/P50/P75 across
 *      wells at each month index.
 *
 * P50 (median) is the default baseline curve, not an unqualified mean —
 * a mean is pulled by outliers (one exceptional or one dud well can swing
 * it hard with only 2-5 analogs), median is not.
 */

import type { AnalogDeclineFitResult } from "./analog-decline-fitting";
import type { WarningEntry } from "./types";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Standard percentile via linear interpolation between order statistics (the common "R-7" method). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export interface ParameterAggregate {
  qiMedian: number;
  diMedian: number;
  bMedian: number;
  currentAnnualDeclinePctMedian: number;
  analogCount: number;
}

/** Robust median-parameter aggregation across QC-passed oil fits. */
export function aggregateParameters(fits: AnalogDeclineFitResult[]): ParameterAggregate | null {
  const qcPassed = fits.filter(f => f.qcPassed && f.oilFit !== null).map(f => f.oilFit!);
  if (qcPassed.length === 0) return null;
  return {
    qiMedian: median(qcPassed.map(f => f.qi)),
    diMedian: median(qcPassed.map(f => f.di)),
    bMedian: median(qcPassed.map(f => f.b)),
    currentAnnualDeclinePctMedian: median(qcPassed.map(f => f.currentAnnualDeclinePct)),
    analogCount: qcPassed.length,
  };
}

export interface TypeCurveMonth {
  monthIndex: number;
  p25: number;
  p50: number;
  p75: number;
  mean: number;
  wellCount: number; // how many analogs actually had data at this month index — thins out toward the tail as shorter-history wells drop off
}

export interface NormalizedTypeCurveResult {
  months: TypeCurveMonth[];
  lateralNormalizationApplied: boolean;
  warnings: WarningEntry[];
}

export interface TypeCurveAnalogInput {
  api: string;
  oilSeries: number[]; // already cleaned/aligned to start at month 0 = first production (fitArpsDecline's own convention)
  lateralLengthFt: number | null;
}

/**
 * Builds the normalized P25/P50/P75 type curve. When `subjectLateralLengthFt`
 * and a given analog's lateral length are both known, that analog's volumes
 * are scaled by (subjectLength / analogLength) before aggregation — a
 * simple, standard linear length-normalization, not a claim of exact
 * physical equivalence. Analogs missing lateral length are still included
 * UNSCALED (with a warning), rather than dropped — better to have the data
 * point than to shrink an already-small analog set over a missing field.
 */
export function buildNormalizedTypeCurve(
  analogs: TypeCurveAnalogInput[],
  subjectLateralLengthFt: number | null,
): NormalizedTypeCurveResult {
  const warnings: WarningEntry[] = [];
  if (analogs.length === 0) {
    return { months: [], lateralNormalizationApplied: false, warnings: [{ code: "NO_ANALOGS_FOR_TYPE_CURVE", message: "No analogs available to build a type curve", severity: "critical" }] };
  }

  const canNormalize = subjectLateralLengthFt !== null;
  let anyScaled = false;
  let anyUnscaledDueToMissingData = false;

  const scaledSeries = analogs.map(a => {
    if (canNormalize && a.lateralLengthFt !== null && a.lateralLengthFt > 0) {
      anyScaled = true;
      const factor = subjectLateralLengthFt! / a.lateralLengthFt;
      return a.oilSeries.map(v => v * factor);
    }
    if (canNormalize) anyUnscaledDueToMissingData = true;
    return a.oilSeries;
  });

  if (anyUnscaledDueToMissingData) {
    warnings.push({ code: "PARTIAL_LATERAL_NORMALIZATION", message: "One or more analogs are missing lateral length and are included in the type curve UNSCALED — comparing raw volumes for those wells, not length-normalized ones", severity: "warning" });
  }
  if (!canNormalize) {
    warnings.push({ code: "NO_SUBJECT_LATERAL_LENGTH", message: "Subject well's lateral length is unknown — type curve uses raw analog volumes with no length normalization at all", severity: "warning" });
  }

  const maxMonths = Math.max(...scaledSeries.map(s => s.length));
  const months: TypeCurveMonth[] = [];
  for (let m = 0; m < maxMonths; m++) {
    const valuesAtMonth = scaledSeries.map(s => s[m]).filter((v): v is number => v !== undefined);
    if (valuesAtMonth.length === 0) continue;
    months.push({
      monthIndex: m,
      p25: percentile(valuesAtMonth, 25),
      p50: percentile(valuesAtMonth, 50),
      p75: percentile(valuesAtMonth, 75),
      mean: valuesAtMonth.reduce((a, b) => a + b, 0) / valuesAtMonth.length,
      wellCount: valuesAtMonth.length,
    });
  }

  return { months, lateralNormalizationApplied: anyScaled, warnings };
}
