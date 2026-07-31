/**
 * Type-curve / analog benchmarking — compares the subject well's decline
 * curve and EUR against nearby offset wells' own production, the way a
 * geologist or reservoir engineer sizing up a new lease actually checks
 * whether a well is performing in line with, better than, or worse than its
 * neighbors in the same play.
 *
 * Requires production history for the offset wells, which fetchOffsetWells()
 * (offset-wells.ts) deliberately does not fetch — that would mean one extra
 * TRRC production query per offset well (often 15-20 of them) on every
 * report, which isn't practical against TRRC's live EWA portal. This module
 * only produces a comparison when analog production is actually supplied;
 * callers without it should render the section as "not available" rather
 * than silently omitting it or fabricating a comparison.
 */

import { fitArpsDecline, estimateEur, type DeclineCurveFit, type EurEstimate } from "./decline-curve";

export interface AnalogWell {
  api: string;
  wellNumber: string;
  distanceMiles: number;
  monthlyOilBbl: number[]; // chronological, oldest first
}

export interface AnalogWellResult {
  api: string;
  wellNumber: string;
  distanceMiles: number;
  fit: DeclineCurveFit | null;
  eur: EurEstimate | null;
}

export interface TypeCurveComparison {
  subjectEur: number;
  analogsProvided: number;
  analogsWithUsableFit: number;
  avgAnalogEur: number | null;
  medianAnalogEur: number | null;
  subjectPercentile: number | null; // 0-100 — what % of analogs the subject beats
  assessment: "Outperforming analogs" | "In line with analogs" | "Underperforming analogs" | "Insufficient analog data";
  analogs: AnalogWellResult[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function compareToAnalogs(subjectEur: number, analogs: AnalogWell[]): TypeCurveComparison {
  const analogResults: AnalogWellResult[] = analogs.map(a => {
    const fit = fitArpsDecline(a.monthlyOilBbl);
    const cumulative = a.monthlyOilBbl.reduce((s, v) => s + v, 0);
    const eur = fit ? estimateEur(fit, cumulative) : null;
    return { api: a.api, wellNumber: a.wellNumber, distanceMiles: a.distanceMiles, fit, eur };
  });

  const usable = analogResults.filter(a => a.eur !== null);
  const analogEurs = usable.map(a => a.eur!.eur);

  if (usable.length === 0) {
    return {
      subjectEur, analogsProvided: analogs.length, analogsWithUsableFit: 0,
      avgAnalogEur: null, medianAnalogEur: null, subjectPercentile: null,
      assessment: "Insufficient analog data", analogs: analogResults,
    };
  }

  const avgAnalogEur = analogEurs.reduce((s, v) => s + v, 0) / analogEurs.length;
  const medianAnalogEur = median(analogEurs);
  const beatCount = analogEurs.filter(e => subjectEur > e).length;
  const subjectPercentile = (beatCount / analogEurs.length) * 100;

  const assessment: TypeCurveComparison["assessment"] =
    subjectPercentile >= 65 ? "Outperforming analogs"
    : subjectPercentile >= 35 ? "In line with analogs"
    : "Underperforming analogs";

  return {
    subjectEur, analogsProvided: analogs.length, analogsWithUsableFit: usable.length,
    avgAnalogEur, medianAnalogEur, subjectPercentile, assessment, analogs: analogResults,
  };
}
