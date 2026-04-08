import type { FinancialSummary } from "@/lib/financial/financial-summary";
import type { LocationContext } from "@/lib/location/location-context";
import type { DealScoreResult } from "@/lib/document-processing/deal-score";
import type { DrillDifficultySnapshotSnake } from "@/lib/scoring/drillDifficultyEngine";
import type { DevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";

export type DealValuationInput = {
  document_id?: string;
  county?: string | null;
  state?: string | null;
  basin?: string | null;
  legal_description?: string | null;
  acreage?: number | null;
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

export type DealValuationOutput = {
  deal_type: DealValuationDealType;
  activity_level: DealValuationActivityLevel;
  nri?: number | null;
  nri_basis?: string | null;
  value_per_acre_low?: number | null;
  value_per_acre_high?: number | null;
  estimated_total_value_low?: number | null;
  estimated_total_value_high?: number | null;
  recommendation: "PURSUE" | "REVIEW" | "PASS";
  confidence: "low" | "medium" | "high";
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
};
