/**
 * Assessment — determines the overall classification
 * (FAVORABLE/MIXED/UNFAVORABLE/INSUFFICIENT_DATA) and confidence
 * (HIGH/MODERATE/LOW/INSUFFICIENT_DATA), on top of interpretation.ts's
 * findings. No numeric score anywhere — confidence reuses the
 * offset-analytics engine's own minimum-of-dimensions philosophy
 * (confidence.ts): one badly-confident dimension pulls the whole
 * assessment down rather than being diluted into a false average.
 *
 * Classification is decided by a small, explicit decision table over real
 * counts — never left to free-form judgment, and INSUFFICIENT_DATA is a
 * first-class, frequently-correct outcome, not a fallback to avoid.
 */

import type {
  OffsetSearchResult, ProductionDistributionStats, DevelopmentActivitySummary, FormationDepthContext,
  GeologicalAssessmentResult, GeologicalAssessmentClassification, ComparableGroup, ConfidenceClassification,
} from "./types";
import { interpretGeologicalEvidence } from "./interpretation";

export interface AssessmentInputs {
  offsets: OffsetSearchResult;
  comparableGroups: ComparableGroup[];
  productionStats: ProductionDistributionStats[];
  activity: DevelopmentActivitySummary;
  formationContext: FormationDepthContext;
  subjectLocationResolved: boolean;
}

const CLASSIFICATION_RANK: Record<ConfidenceClassification, number> = { INSUFFICIENT_DATA: 0, LOW: 1, MODERATE: 2, HIGH: 3 };

function classifyDimension(score: number): ConfidenceClassification {
  if (score <= 0) return "INSUFFICIENT_DATA";
  if (score >= 0.75) return "HIGH";
  if (score >= 0.45) return "MODERATE";
  return "LOW";
}

function computeConfidence(dimensions: Record<string, number>): ConfidenceClassification {
  const perDim = Object.values(dimensions).map(classifyDimension);
  return perDim.reduce((worst, cur) => (CLASSIFICATION_RANK[cur] < CLASSIFICATION_RANK[worst] ? cur : worst), "HIGH" as ConfidenceClassification);
}

export function runGeologicalAssessment(inputs: AssessmentInputs): GeologicalAssessmentResult {
  const startedAt = Date.now();
  const { offsets, comparableGroups, productionStats, activity, formationContext, subjectLocationResolved } = inputs;

  const interpretation = interpretGeologicalEvidence({ offsets, productionStats, activity, formationContext });

  const count3mi = offsets.countByRadius[3];
  const producingCount3mi = offsets.wells.filter(w => w.distanceMiles <= 3 && (w.classifiedStatus === "PRODUCING" || w.classifiedStatus === "RECENTLY_ACTIVE")).length;
  const validGroups = productionStats.filter(g => g.validComparison);
  const hasMaterialRisk = interpretation.risks.length > 0;

  // ── Confidence dimensions ────────────────────────────────────────────────
  // comparableGroupQuality is only meaningful when there's actual production
  // to have grouped — if every nearby well is genuinely plugged/dry (a real,
  // observed, confident finding in its own right), the absence of a
  // production comp group isn't a data gap and shouldn't drag the whole
  // assessment down to INSUFFICIENT_DATA; it's excluded from the minimum
  // rather than counted as a zero.
  const dimensions: Record<string, number> = {
    subjectLocation: subjectLocationResolved ? 1.0 : 0,
    offsetWellCount: Math.min(1, count3mi / 8),
    offsetDataEnrichment: offsets.wells.length > 0
      ? offsets.wells.filter(w => w.monthsOfHistory !== null).length / Math.min(offsets.wells.length, 40)
      : 0,
    formationDataQuality: formationContext.subjectFormation !== null ? 0.6 : 0, // capped below 0.75 (never HIGH alone) — field-name matching is coarser than true landing-zone data, see formations.ts
  };
  if (producingCount3mi > 0) {
    dimensions.comparableGroupQuality = validGroups.length > 0 ? 1.0 : (comparableGroups.length > 0 ? 0.3 : 0);
  }
  const confidence = computeConfidence(dimensions);

  // ── Classification decision table ────────────────────────────────────────
  let classification: GeologicalAssessmentClassification;
  if (count3mi === 0 || confidence === "INSUFFICIENT_DATA") {
    classification = "INSUFFICIENT_DATA";
  } else if (count3mi >= 5 && producingCount3mi >= 3 && validGroups.length > 0 && !hasMaterialRisk) {
    classification = "FAVORABLE";
  } else if (hasMaterialRisk && producingCount3mi === 0) {
    classification = "UNFAVORABLE";
  } else {
    classification = "MIXED";
  }

  return {
    classification,
    confidence,
    confidenceDimensions: dimensions,
    diligenceImplication: interpretation.diligenceImplication,
    supportingFactors: interpretation.supportingFactors,
    contradictingFactors: interpretation.contradictingFactors,
    risks: interpretation.risks,
    dataGaps: interpretation.dataGaps,
    formationDepthContext: formationContext,
    offsetSummary: offsets,
    developmentActivity: activity,
    comparableGroups,
    productionStats,
    evidence: interpretation.evidence,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}
