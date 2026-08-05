/**
 * Top analog selection — picks up to 5 qualified analogs from scored
 * candidates. Never pads a weak set up to exactly 5; never silently
 * returns nothing when the real answer is "we found some, just not many."
 */

import type { AnalogScoreResult } from "./analog-scoring";
import { haversineDistanceMiles } from "./geometry";

export interface ScoredCandidate {
  api: string;
  latitude: number;
  longitude: number;
  score: AnalogScoreResult;
}

export type AnalogSetStatus = "SUFFICIENT_ANALOG_SET" | "LIMITED_ANALOG_SET" | "NO_VALID_ANALOGS" | "MANUAL_REVIEW_REQUIRED";

export interface AnalogSelectionOptions {
  maxAnalogs: number;
  minAnalogCount: number; // below this, status is LIMITED rather than SUFFICIENT even if some were found
  minAnalogScore: number; // 0-100
  /** Wells closer together than this are treated as the same pad — only the highest-scored one from a cluster is kept, so 5 wellheads off one battery don't crowd out real geographic diversity. */
  samePadRadiusMiles: number;
}

export const DEFAULT_ANALOG_SELECTION_OPTIONS: AnalogSelectionOptions = {
  maxAnalogs: 5,
  minAnalogCount: 2,
  minAnalogScore: 40,
  samePadRadiusMiles: 0.05,
};

export interface AnalogSelectionResult {
  selected: ScoredCandidate[];
  status: AnalogSetStatus;
  rejectedForLowScore: number;
  rejectedForPadOverconcentration: number;
  explanation: string;
}

export function selectTopAnalogs(
  scoredCandidates: ScoredCandidate[],
  options: AnalogSelectionOptions = DEFAULT_ANALOG_SELECTION_OPTIONS,
): AnalogSelectionResult {
  const aboveThreshold = scoredCandidates.filter(c => c.score.totalScore >= options.minAnalogScore);
  const rejectedForLowScore = scoredCandidates.length - aboveThreshold.length;

  // Highest score first, so the pad-clustering pass below always keeps the
  // BEST representative of each cluster, not just the first one encountered.
  const sorted = [...aboveThreshold].sort((a, b) => b.score.totalScore - a.score.totalScore);

  const kept: ScoredCandidate[] = [];
  let rejectedForPadOverconcentration = 0;
  for (const candidate of sorted) {
    const tooClose = kept.some(k => haversineDistanceMiles(k.latitude, k.longitude, candidate.latitude, candidate.longitude) < options.samePadRadiusMiles);
    if (tooClose) {
      rejectedForPadOverconcentration++;
      continue;
    }
    kept.push(candidate);
    if (kept.length >= options.maxAnalogs) break;
  }

  let status: AnalogSetStatus;
  let explanation: string;
  if (kept.length === 0) {
    status = scoredCandidates.length > 0 ? "MANUAL_REVIEW_REQUIRED" : "NO_VALID_ANALOGS";
    explanation = scoredCandidates.length > 0
      ? `${scoredCandidates.length} candidate(s) were found but none scored above the minimum threshold (${options.minAnalogScore}) — manual review recommended before concluding no analogs exist`
      : "No candidate wells were found within the search radius at all";
  } else if (kept.length < options.minAnalogCount) {
    status = "LIMITED_ANALOG_SET";
    explanation = `Only ${kept.length} qualified analog(s) found (minimum recommended: ${options.minAnalogCount}) — treat any resulting forecast as lower-confidence`;
  } else {
    status = "SUFFICIENT_ANALOG_SET";
    explanation = `${kept.length} qualified analog(s) selected out of ${scoredCandidates.length} candidate(s) considered`;
  }

  return { selected: kept, status, rejectedForLowScore, rejectedForPadOverconcentration, explanation };
}
