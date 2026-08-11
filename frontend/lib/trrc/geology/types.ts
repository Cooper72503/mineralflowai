/**
 * Shared schemas for the Geological Due Diligence Engine. Reuses the
 * offset-analytics engine's WarningEntry/ConfidenceClassification types
 * (../offset-analytics/types.ts) rather than redefining them — the two
 * engines share a domain and a caller shouldn't have to reconcile two
 * near-identical warning shapes.
 *
 * The classification vocabulary below (StatementClassification, in
 * particular) is the single most important type in this module — it's
 * what stops an inferred conclusion from masquerading as an observed fact
 * anywhere downstream (report, UI, evidence ledger). See interpretation.ts.
 */

import type { WarningEntry, ConfidenceClassification } from "../offset-analytics/types";

export type { WarningEntry, ConfidenceClassification };

/** Every material statement in a geological assessment is tagged with exactly one of these — never left ambiguous. */
export type StatementClassification = "observed" | "calculated" | "inferred";

export type GeologicalAssessmentClassification = "FAVORABLE" | "MIXED" | "UNFAVORABLE" | "INSUFFICIENT_DATA";

export type RadiusBandMiles = 1 | 3 | 5;

export type OffsetWellStatus =
  | "PRODUCING"
  | "RECENTLY_ACTIVE"
  | "SHUT_IN"
  | "PLUGGED"
  | "PERMITTED_NOT_DRILLED"
  | "DRY_HOLE"
  | "INJECTION_DISPOSAL"
  | "UNKNOWN";

// ─── Context (subject asset) ────────────────────────────────────────────────

export interface SubjectAssetContext {
  apiNumber: string;
  leaseNumber: string | null;
  district: string | null;
  operatorNumber: string | null;
  operatorName: string | null;
  wellName: string | null;
  county: string | null;
  latitude: number | null;
  longitude: number | null;
  targetFormation: string | null;    // from permit, when known
  producingFormation: string | null; // from field name, when known
  wellStatus: string | null;         // TRRC's own status text, when the source was reachable — see the disclosed permanent gap on wellStatusQueryAction.do
  sourceUrlOrQueryId: string | null;
  retrievedAt: string;
  warnings: WarningEntry[];
}

// ─── Offset wells ────────────────────────────────────────────────────────────

export interface OffsetWellRecord {
  apiNumber: string;
  wellNumber: string | null;
  latitude: number;
  longitude: number;
  distanceMiles: number;
  bearing: string;
  radiusBandMiles: RadiusBandMiles;
  gisStatusSymbol: string;
  classifiedStatus: OffsetWellStatus;
  operatorName: string | null;
  fieldName: string | null;
  canonicalFormation: string | null;
  formationMatch: boolean | null;   // null = not yet evaluated against the subject formation
  lateralLengthFt: number | null;
  completionYear: number | null;
  firstProductionMonth: string | null;
  sixMonthOilBbl: number | null;
  twelveMonthOilBbl: number | null;
  cumulativeOilBbl: number | null;
  cumulativeGasMcf: number | null;
  cumulativeWaterBbl: number | null;
  monthsOfHistory: number | null;
  comparableGroupId: string | null;
}

export interface OffsetSearchResult {
  wells: OffsetWellRecord[];
  countByRadius: Record<RadiusBandMiles, number>;
  horizontalCountByRadius: Record<RadiusBandMiles, number>;
  warnings: WarningEntry[];
  sourceUrlOrQueryId: string;
  retrievedAt: string;
}

// ─── Comparable groups + production stats ──────────────────────────────────

export interface ComparableGroup {
  groupId: string;
  canonicalFormation: string;
  lateralLengthBand: string;        // e.g. "5000-7500ft", "UNKNOWN"
  completionVintageBand: string;    // e.g. "2020-2022", "UNKNOWN"
  memberApis: string[];
}

export interface ProductionDistributionStats {
  groupId: string;
  wellCount: number;
  medianTwelveMonthOilBbl: number | null;
  averageTwelveMonthOilBbl: number | null;
  bestPerformerApi: string | null;
  bestPerformerTwelveMonthOilBbl: number | null;
  lowestPerformerApi: string | null;
  lowestPerformerTwelveMonthOilBbl: number | null;
  distanceWeightedTwelveMonthOilBbl: number | null;
  validComparison: boolean;         // false when the group is too small/mixed to support a real apples-to-apples read
  invalidComparisonReason: string | null;
}

// ─── Development activity ───────────────────────────────────────────────────

export type PermitRecencyBucket = "LAST_6_MONTHS" | "LAST_12_MONTHS" | "LAST_24_MONTHS" | "OLDER" | "UNKNOWN";

export interface PermitRecord {
  apiNumber: string | null;
  permitNumber: string | null;
  distanceMiles: number | null;
  radiusBandMiles: RadiusBandMiles | null;
  filedDate: string | null;
  monthsSinceFiled: number | null;
  recencyBucket: PermitRecencyBucket;
  targetFormation: string | null;
  operatorName: string | null;
  wellStatusAtQuery: string | null;
  sourceUrlOrQueryId: string | null;
  retrievedAt: string;
}

export interface DevelopmentActivitySummary {
  permits: PermitRecord[];
  permitCountByRadius: Record<RadiusBandMiles, number>;
  permitCountByRecency: Record<PermitRecencyBucket, number>;
  operatorConcentration: { operatorName: string; wellCount: number; sharePct: number }[];
  activeOperatorCount: number;
  recentlyCompletedWellCount: number;
  developmentDensityPerSqMile: number | null;
  developmentRecencyNote: string;
  warnings: WarningEntry[];
}

// ─── Formation / depth context ──────────────────────────────────────────────

export interface FormationDepthContext {
  subjectFormation: string | null;
  producingFormation: string | null;
  permittedFormation: string | null;
  subjectTvdFt: number | null;
  subjectTvdSource: string | null;
  subjectTvdssFt: number | null;
  tvdssElevationSource: string | null;
  tvdssMethodology: string | null;   // null when TVDSS could not be calculated
  formationTopsAvailable: false;     // always false in V1 — see formations.ts's doc comment
  dataGapNote: string;
}

// ─── Findings ────────────────────────────────────────────────────────────────

export type FindingCategory = "supporting" | "contradicting" | "risk" | "gap";

export interface GeologicalFinding {
  category: FindingCategory;
  classification: StatementClassification;
  title: string;
  description: string;
  evidenceIds: string[];
}

// ─── Evidence ────────────────────────────────────────────────────────────────

export interface EvidenceEntry {
  id: string;
  fieldName: string;
  classification: StatementClassification;
  source: string;
  sourceUrlOrDocId: string | null;
  retrievedAt: string;
  rawValue: string | null;
  normalizedValue: string | null;
  confidence: number | null;
  transformationMethod: string | null;
}

// ─── Assessment ──────────────────────────────────────────────────────────────

export interface GeologicalAssessmentResult {
  classification: GeologicalAssessmentClassification;
  confidence: ConfidenceClassification;
  confidenceDimensions: Record<string, number>;
  diligenceImplication: string;
  supportingFactors: GeologicalFinding[];
  contradictingFactors: GeologicalFinding[];
  risks: GeologicalFinding[];
  dataGaps: GeologicalFinding[];
  formationDepthContext: FormationDepthContext;
  offsetSummary: OffsetSearchResult;
  developmentActivity: DevelopmentActivitySummary;
  comparableGroups: ComparableGroup[];
  productionStats: ProductionDistributionStats[];
  evidence: EvidenceEntry[];
  generatedAt: string;
  durationMs: number;
}
