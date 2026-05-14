import type { FinancialSummary } from "@/lib/financial/financial-summary";
import type { LocationContext } from "@/lib/location/location-context";
import type { LegalDescriptionParseResult } from "@/lib/location/legal-description-parser";
import type { DealScoreResult } from "@/lib/document-processing/deal-score";
import type { DrillDifficultySnapshotSnake } from "@/lib/scoring/drillDifficultyEngine";
import type { DevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";

/** How county/state landed on the merged valuation input (drives confidence weights). */
export type ValuationFieldSource = "extracted" | "inferred";

export type DealValuationInput = {
  document_id?: string;
  county?: string | null;
  /** When county is non-null: structured extraction vs text inference. */
  county_source?: ValuationFieldSource | null;
  state?: string | null;
  state_source?: ValuationFieldSource | null;
  basin?: string | null;
  legal_description?: string | null;
  /** Parsed from {@link legal_description} / merged text — used for screening and narratives. */
  legal_description_parsed?: LegalDescriptionParseResult | null;
  acreage?: number | null;
  /** When acreage is non-null: how it was resolved (drives narrative labeling). */
  acreage_source?: "extracted" | "inferred_plss" | null;
  royalty_rate?: number | null;
  ownership_percent?: number | null;
  interest_type?: string | null;
  bopd?: number | null;
  bwpd?: number | null;
  monthly_revenue?: number | null;
  annual_revenue?: number | null;
  operator?: string | null;
  document_type?: string | null;
  location_context?: LocationContext | null;
  drill_difficulty?: DrillDifficultySnapshotSnake | null;
  structured_source?: Record<string, unknown> | null;
  development_signals?: DevelopmentSignalsSnapshot | null;
  financial_summary?: FinancialSummary | null;
  extracted_text_sample?: string | null;
};

export type DealValuationDealType =
  | "producing"
  | "undeveloped"
  | "lease"
  | "infrastructure"
  | "mixed"
  | "unknown";

export type DealValuationActivityLevel = "low" | "moderate" | "high" | "unknown";

/** Explainable output from the signal-based confidence engine. */
export type ValuationConfidenceReasoning = {
  /** Short justification for the tier (conservative, user-facing). */
  summary: string;
  /** Signals that increased score (with direct vs inferred where relevant). */
  present_signals: string[];
  /** Important gaps that limited confidence. */
  missing_signals: string[];
};

export type DealValuationOutput = {
  deal_type: DealValuationDealType;
  activity_level: DealValuationActivityLevel;
  nri?: number | null;
  nri_basis?: string | null;
  value_per_acre_low?: number | null;
  value_per_acre_high?: number | null;
  estimated_total_value_low?: number | null;
  estimated_total_value_high?: number | null;
  /**
   * Single-point value estimate (midpoint of the band, or BOPD-anchored income-cap value).
   * Present whenever a numeric band is available.
   */
  point_estimate?: number | null;
  /**
   * "full_underwriting" when all analysis engines contributed (economics + decline + risk);
   * "bopd_anchored" when derived from real nearby well production data;
   * "basin_tier" when falling back to static county/basin comps.
   */
  point_estimate_basis?: "full_underwriting" | "bopd_anchored" | "basin_tier" | null;
  recommendation: "PURSUE" | "REVIEW" | "PASS";
  confidence: "low" | "medium" | "high";
  /** Added with signal-based confidence; may be absent on older stored valuations. */
  confidence_reasoning?: ValuationConfidenceReasoning;
  summary: string;
  reasoning: string[];
  risks: string[];
  missing_data: string[];
  /** Non-user-facing: how totals were derived (debug). */
  _value_method?: string;
};

export type RunPreUnderwritingValuationArgs = {
  documentId?: string | null;
  parsed: Record<string, unknown>;
  dealScoreInput: Record<string, unknown>;
  dealScore: DealScoreResult;
  financialSummary: FinancialSummary | null;
  locationContext: LocationContext | null;
  drillSnapshot: DrillDifficultySnapshotSnake;
  extractedText: string;
  /** When present, merged with {@link extractedText} inside {@link buildValuationInput} as full document text. */
  raw_text?: string | null;
  /**
   * Full combined PDF + OCR + normalized text from {@link runStructuredExtraction} artifacts when available.
   * Ensures valuation fallbacks see the same corpus the extractor used.
   */
  combinedExtractionText?: string | null;
  /**
   * User-supplied producing status override from Quick Screen form.
   * "yes" forces deal_type → "producing" even without income signals.
   * "no"  forces deal_type away from "producing".
   */
  producingStatusOverride?: "yes" | "no" | "unknown";
  /**
   * Real nearby well intelligence from state APIs.
   * When present, the value estimator anchors its formula to actual
   * median BOPD instead of broad basin-tier comps.
   */
  nearbyWells?: import("@/lib/wells/nearby-wells").NearbyWellIntelligence | null;
  /**
   * Decline curve analysis — informs economic life adjustment on value.
   * Must be computed before calling runPreUnderwritingValuation.
   */
  declineAnalysis?: import("@/lib/decline/decline-curve").DeclineCurveResult | null;
  /**
   * Mineral economics (net royalty income) — primary income anchor for value.
   * Must be computed before calling runPreUnderwritingValuation.
   * Pass WITHOUT point_estimate; cap rate will be patched after valuation.
   */
  mineralEconomics?: import("@/lib/economics/mineral-economics").MineralEconomicsResult | null;
  /**
   * P&A liability — directly deducted from estimated value.
   * Must be computed before calling runPreUnderwritingValuation.
   */
  paLiability?: import("@/lib/risk/pa-liability").PaLiabilityResult | null;
  /**
   * Risk flags — used as discount factor in value estimation.
   * Can be passed in if pre-computed, otherwise the value estimator
   * will run without a risk discount.
   */
  riskFlags?: import("@/lib/risk/risk-flags").RiskFlagsResult | null;
};
