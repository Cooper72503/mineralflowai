/**
 * Transparent, multi-factor analog similarity scoring — every score
 * returns its contributing facts, never a black-box number. No LLM call
 * anywhere in this file (non-negotiable principle #10).
 *
 * DATA AVAILABILITY NOTE: the spec's example weighting includes a
 * "completion_design" (proppant/fluid intensity) dimension. That data
 * isn't reliably available anywhere in this pipeline — it would require
 * per-well W-2/completion-report parsing, which worker/src/tools/ewa.ts's
 * own doc comments document as unreliable this session (completionQueryAction.do
 * returning HTTP 500). Rather than fabricate a placeholder value for it,
 * this scorer omits it entirely and redistributes its weight
 * proportionally across the dimensions that DO have real data sources:
 * formation match (formation-normalization.ts, Phase 7), distance
 * (well-search.ts, Phase 5), lateral length (lateral-path.ts, already
 * shipped — real straight_line_length_ft from surface/bottomhole
 * coordinates), completion vintage and true vertical depth (from W-1
 * drilling permit records, already shipped in worker/src/tools/ewa.ts's
 * getDrillingPermits). When an INDIVIDUAL candidate is missing one of
 * those fields (e.g. no lateral path resolvable for a particular well),
 * that comparison's weight is further redistributed across whatever
 * fields that specific candidate does have — never silently scored as
 * zero, which would unfairly penalize a well this pipeline just hasn't
 * fully enriched yet versus one that's genuinely a poor analog.
 */

import type { FormationMatchResult } from "./formation-normalization";

export interface AnalogScoringInput {
  formationMatch: FormationMatchResult;
  distanceMiles: number;
  searchRadiusMiles: number; // for normalizing distance score into [0,1]
  subjectLateralLengthFt: number | null;
  candidateLateralLengthFt: number | null;
  subjectCompletionYear: number | null;
  candidateCompletionYear: number | null;
  subjectTvdFt: number | null;
  candidateTvdFt: number | null;
}

// Base weights when every dimension has real data — proportional to the
// spec's example table (30/20/15/10/10/5) with completion_design's 10
// points removed and the remainder rescaled to sum to 1.0.
const BASE_WEIGHTS = {
  formationMatch: 30 / 90,
  distance: 20 / 90,
  lateralLength: 15 / 90,
  completionVintage: 10 / 90,
  depthSimilarity: 10 / 90,
  dataCompleteness: 5 / 90,
} as const;

export interface DimensionScore {
  dimension: keyof typeof BASE_WEIGHTS;
  available: boolean;
  rawScore: number | null; // 0-1, before weighting; null when not available
  weightApplied: number; // the actual weight used after redistribution
  fact: string;
}

export interface AnalogScoreResult {
  totalScore: number; // 0-100
  dimensions: DimensionScore[];
}

function formationDimensionScore(match: FormationMatchResult): number {
  switch (match.tier) {
    case "EXACT_LANDING_ZONE": return 1.0;
    case "SAME_FORMATION": return 0.9;
    case "SAME_GROUP_AND_BASIN": return 0.6;
    case "UNKNOWN_BUT_SIMILAR": return 0.3;
    case "INCOMPATIBLE": return 0;
  }
}

function distanceDimensionScore(distanceMiles: number, radiusMiles: number): number {
  if (radiusMiles <= 0) return 0;
  return Math.max(0, 1 - distanceMiles / radiusMiles);
}

function ratioSimilarityScore(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.min(a, b) / Math.max(a, b);
  return ratio; // 1.0 for identical, approaches 0 as they diverge
}

function vintageSimilarityScore(subjectYear: number, candidateYear: number): number {
  const diffYears = Math.abs(subjectYear - candidateYear);
  // Full credit within 2 years, linearly decaying to 0 by 10 years apart —
  // completion technology/practice shifts meaningfully over a decade.
  return Math.max(0, 1 - Math.max(0, diffYears - 2) / 8);
}

export function scoreAnalog(input: AnalogScoringInput): AnalogScoreResult {
  const dims: DimensionScore[] = [];

  dims.push({
    dimension: "formationMatch", available: true,
    rawScore: formationDimensionScore(input.formationMatch), weightApplied: 0,
    fact: input.formationMatch.explanation,
  });

  dims.push({
    dimension: "distance", available: true,
    rawScore: distanceDimensionScore(input.distanceMiles, input.searchRadiusMiles), weightApplied: 0,
    fact: `${input.distanceMiles.toFixed(2)} mi of ${input.searchRadiusMiles} mi search radius`,
  });

  if (input.subjectLateralLengthFt !== null && input.candidateLateralLengthFt !== null) {
    dims.push({
      dimension: "lateralLength", available: true,
      rawScore: ratioSimilarityScore(input.subjectLateralLengthFt, input.candidateLateralLengthFt), weightApplied: 0,
      fact: `${Math.round(input.candidateLateralLengthFt)}ft vs subject ${Math.round(input.subjectLateralLengthFt)}ft`,
    });
  } else {
    dims.push({ dimension: "lateralLength", available: false, rawScore: null, weightApplied: 0, fact: "Lateral length not resolvable for one or both wells" });
  }

  if (input.subjectCompletionYear !== null && input.candidateCompletionYear !== null) {
    dims.push({
      dimension: "completionVintage", available: true,
      rawScore: vintageSimilarityScore(input.subjectCompletionYear, input.candidateCompletionYear), weightApplied: 0,
      fact: `Completed ${input.candidateCompletionYear} vs subject ${input.subjectCompletionYear}`,
    });
  } else {
    dims.push({ dimension: "completionVintage", available: false, rawScore: null, weightApplied: 0, fact: "Completion date not available for one or both wells" });
  }

  if (input.subjectTvdFt !== null && input.candidateTvdFt !== null) {
    dims.push({
      dimension: "depthSimilarity", available: true,
      rawScore: ratioSimilarityScore(input.subjectTvdFt, input.candidateTvdFt), weightApplied: 0,
      fact: `${Math.round(input.candidateTvdFt)}ft TVD vs subject ${Math.round(input.subjectTvdFt)}ft`,
    });
  } else {
    dims.push({ dimension: "depthSimilarity", available: false, rawScore: null, weightApplied: 0, fact: "True vertical depth not available for one or both wells" });
  }

  const availableCount = dims.filter(d => d.available).length;
  const completeness = availableCount / (dims.length); // dataCompleteness itself isn't in `dims` yet
  dims.push({
    dimension: "dataCompleteness", available: true,
    rawScore: completeness, weightApplied: 0,
    fact: `${availableCount} of ${dims.length} scoring dimensions had real data`,
  });

  // Redistribute weight: sum the base weight of every AVAILABLE dimension,
  // scale each available dimension's weight up proportionally so the
  // available weights sum to 1.0 — unavailable dimensions get 0 weight,
  // not a zero SCORE (a real difference: missing data isn't penalized as
  // "bad," it's just excluded from the total).
  const availableBaseWeightSum = dims.filter(d => d.available).reduce((s, d) => s + BASE_WEIGHTS[d.dimension], 0);
  let totalScore = 0;
  for (const d of dims) {
    if (!d.available || d.rawScore === null) continue;
    d.weightApplied = availableBaseWeightSum > 0 ? BASE_WEIGHTS[d.dimension] / availableBaseWeightSum : 0;
    totalScore += d.rawScore * d.weightApplied;
  }

  return { totalScore: Math.round(totalScore * 1000) / 10, dimensions: dims };
}
