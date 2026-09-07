/**
 * Assessment — determines the overall classification
 * (NO_SURFACE_DISCONTINUITIES_DETECTED/POTENTIAL_GAPS_DETECTED/
 * POTENTIAL_CONFLICTS_DETECTED/INSUFFICIENT_DATA) and confidence (HIGH/
 * MODERATE/LOW/INSUFFICIENT_DATA). No numeric score anywhere — confidence
 * reuses the same minimum-of-dimensions philosophy as offset-analytics/
 * confidence.ts and geology/assessment.ts.
 *
 * No "intact"/"clean" classification exists — Phase 1 never walks or
 * reconciles a chain, so it can only report the absence or presence of
 * surface-level discontinuities/variances in the available instruments.
 */

import type {
  CanonicalTract, TimelineResult, TitleAssessmentResult, TitleAssessmentClassification,
  EnrichedClaim, TitleConfidenceClassification,
} from "./types";
import { TITLE_ASSESSMENT_LABEL } from "./types";
import { interpretTitleEvidence } from "./interpretation";

export interface AssessmentInputs {
  tracts: CanonicalTract[];
  timeline: TimelineResult;
  enrichedByTract: Record<string, EnrichedClaim[]>;
}

const CLASSIFICATION_RANK: Record<TitleConfidenceClassification, number> = { INSUFFICIENT_DATA: 0, LOW: 1, MODERATE: 2, HIGH: 3 };

function classifyDimension(score: number): TitleConfidenceClassification {
  if (score <= 0) return "INSUFFICIENT_DATA";
  if (score >= 0.75) return "HIGH";
  if (score >= 0.45) return "MODERATE";
  return "LOW";
}

function computeConfidence(dimensions: Record<string, number>): TitleConfidenceClassification {
  const perDim = Object.values(dimensions).map(classifyDimension);
  if (perDim.length === 0) return "INSUFFICIENT_DATA";
  return perDim.reduce((worst, cur) => (CLASSIFICATION_RANK[cur] < CLASSIFICATION_RANK[worst] ? cur : worst), "HIGH" as TitleConfidenceClassification);
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function runTitleAssessment(inputs: AssessmentInputs): TitleAssessmentResult {
  const startedAt = Date.now();
  const { tracts, timeline, enrichedByTract } = inputs;

  const interpretation = interpretTitleEvidence({ tracts, timeline: timeline.tracts, enrichedByTract });

  const allClaims = Object.values(enrichedByTract).flat();
  const instrumentCount = new Set(allClaims.map(c => c.instrument.id)).size;
  const distinctPartyCount = new Set(
    allClaims.flatMap(c => [...c.grantors, ...c.grantees].map(p => p.canonicalPartyId ?? p.id)),
  ).size;

  const tractsWithClaims = timeline.tracts.filter(t => t.claims.length > 0);
  const tractsWithNoGaps = tractsWithClaims.filter(t => t.gaps.length === 0).length;

  // ── Confidence dimensions ────────────────────────────────────────────────
  const dimensions: Record<string, number> = {
    instrumentCoverage: instrumentCount > 0 ? Math.min(1, instrumentCount / 10) : 0,
  };
  if (tracts.length > 0) {
    dimensions.tractMatchConfidence = average(tracts.map(t => t.confidence));
    dimensions.surfaceCheckCoverage = tractsWithClaims.length > 0 ? tractsWithNoGaps / tractsWithClaims.length : 0;
  }
  const confidence = computeConfidence(dimensions);

  // ── Classification decision table ────────────────────────────────────────
  let classification: TitleAssessmentClassification;
  if (instrumentCount === 0 || confidence === "INSUFFICIENT_DATA") {
    classification = "INSUFFICIENT_DATA";
  } else if (interpretation.contradictingFactors.length > 0) {
    classification = "POTENTIAL_CONFLICTS_DETECTED";
  } else if (timeline.totalGapCount > 0) {
    classification = "POTENTIAL_GAPS_DETECTED";
  } else {
    classification = "NO_SURFACE_DISCONTINUITIES_DETECTED";
  }

  const dated = allClaims.map(c => c.instrument.instrumentDate ?? c.instrument.recordedDate).filter((d): d is string => !!d).sort();

  return {
    classification,
    confidence,
    confidenceDimensions: dimensions,
    diligenceImplication: interpretation.diligenceImplication,
    label: TITLE_ASSESSMENT_LABEL,

    instrumentCount,
    distinctPartyCount,
    earliestInstrumentDate: dated[0] ?? null,
    latestInstrumentDate: dated[dated.length - 1] ?? null,
    unresolvedFindingCount: timeline.totalGapCount,

    supportingFactors: interpretation.supportingFactors,
    contradictingFactors: interpretation.contradictingFactors,
    risks: interpretation.risks,
    dataGaps: interpretation.dataGaps,

    tracts,
    timeline,
    evidence: interpretation.evidence,

    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
