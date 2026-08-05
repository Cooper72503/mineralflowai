/**
 * Per-well independent decline fitting for analogs — reuses the existing,
 * already-tested Arps engine (decline-curve.ts) rather than rebuilding it.
 * Each analog is fit on its OWN production history, independently, never
 * averaged together with other wells first — averaging raw histories
 * before fitting would blend wells with different start dates, ramp-up
 * behavior, and reporting gaps into a single misleading curve. Aggregation
 * across already-fitted wells happens later, in composite-profile.ts
 * (Phase 12).
 */

import { fitArpsDecline, estimateEur, type DeclineCurveFit, type EurEstimate } from "../decline-curve";
import type { AnalogProductionRow } from "./production-loader";
import type { WarningEntry } from "./types";

export interface AnalogDeclineFitQcThresholds {
  minRSquared: number;
  minMonthsOfHistory: number;
}

export const DEFAULT_QC_THRESHOLDS: AnalogDeclineFitQcThresholds = {
  minRSquared: 0.5,
  minMonthsOfHistory: 6, // matches fitArpsDecline's own internal minimum
};

export interface AnalogDeclineFitResult {
  api: string;
  oilFit: DeclineCurveFit | null;
  oilEur: EurEstimate | null;
  gasFit: DeclineCurveFit | null;
  gasEur: EurEstimate | null;
  qcPassed: boolean;
  qcRejectionReason: string | null;
  warnings: WarningEntry[];
}

function sumNonNull(values: (number | null)[]): number {
  return values.reduce((s: number, v) => s + (v ?? 0), 0);
}

/**
 * Fits one analog well's production independently. `rows` must already be
 * this well's own lease-level history (production-loader.ts, Phase 10) —
 * this function does no aggregation across wells, only within one well's
 * oil and gas series.
 */
export function fitAnalogDecline(
  api: string,
  rows: AnalogProductionRow[],
  thresholds: AnalogDeclineFitQcThresholds = DEFAULT_QC_THRESHOLDS,
): AnalogDeclineFitResult {
  const warnings: WarningEntry[] = [];
  const sorted = [...rows].sort((a, b) => a.productionMonth.localeCompare(b.productionMonth));

  const oilSeries = sorted.map(r => r.oilBbl ?? 0);
  const gasSeries = sorted.map(r => r.gasMcf ?? 0);

  const oilFit = fitArpsDecline(oilSeries);
  const gasFit = fitArpsDecline(gasSeries);

  const oilEur = oilFit ? estimateEur(oilFit, sumNonNull(sorted.map(r => r.oilBbl))) : null;
  const gasEur = gasFit ? estimateEur(gasFit, sumNonNull(sorted.map(r => r.gasMcf))) : null;

  if (!oilFit && !gasFit) {
    return {
      api, oilFit: null, oilEur: null, gasFit: null, gasEur: null,
      qcPassed: false, qcRejectionReason: "No valid Arps fit for either oil or gas — insufficient or non-declining production history", warnings,
    };
  }

  // QC: the BEST available fit (oil preferred, since that's this analog
  // scoring pipeline's primary commodity focus) must clear the configured
  // thresholds, or this well is excluded from composite aggregation
  // entirely rather than silently dragging down the group with a poor fit.
  const primaryFit = oilFit ?? gasFit!;
  if (primaryFit.rSquared < thresholds.minRSquared) {
    return {
      api, oilFit, oilEur, gasFit, gasEur,
      qcPassed: false, qcRejectionReason: `Fit quality R²=${primaryFit.rSquared.toFixed(2)} below the minimum threshold ${thresholds.minRSquared}`, warnings,
    };
  }
  if (primaryFit.monthsOfHistory < thresholds.minMonthsOfHistory) {
    return {
      api, oilFit, oilEur, gasFit, gasEur,
      qcPassed: false, qcRejectionReason: `Only ${primaryFit.monthsOfHistory} month(s) of usable history, below the minimum ${thresholds.minMonthsOfHistory}`, warnings,
    };
  }

  if (primaryFit.rSquared < 0.7) {
    warnings.push({ code: "MARGINAL_FIT_QUALITY", message: `Fit quality R²=${primaryFit.rSquared.toFixed(2)} is above the QC minimum but still marginal — weight this analog's contribution to the composite curve accordingly`, severity: "warning" });
  }

  return { api, oilFit, oilEur, gasFit, gasEur, qcPassed: true, qcRejectionReason: null, warnings };
}

/** Fits every accepted analog independently, in the correct sequence: normalize -> fit -> QC each -> (aggregation happens separately, in composite-profile.ts). */
export function fitAllAnalogs(
  analogs: Array<{ api: string; rows: AnalogProductionRow[] }>,
  thresholds: AnalogDeclineFitQcThresholds = DEFAULT_QC_THRESHOLDS,
): AnalogDeclineFitResult[] {
  return analogs.map(a => fitAnalogDecline(a.api, a.rows, thresholds));
}
