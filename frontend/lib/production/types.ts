/**
 * V1 directional production screening — not well-level production history or reserves.
 */

export type ProductionSnapshotInput = {
  document_id?: string;
  county?: string | null;
  state?: string | null;
  basin?: string | null;
  legal_description?: string | null;
  acreage?: number | null;
  operator?: string | null;
  document_type?: string | null;
  bopd?: number | null;
  bwpd?: number | null;
  monthly_revenue?: number | null;
  annual_revenue?: number | null;
  nearby_activity_signal?: string | null;
  location_context?: unknown;
  drill_difficulty?: unknown;
  extracted_text_sample?: string | null;
  structured_source?: unknown;
};

export type ProductionSnapshotOutput = {
  production_status:
    | "producing"
    | "likely_producing"
    | "declining_or_legacy"
    | "undeveloped"
    | "unknown";
  production_trend: "growing" | "stable" | "declining" | "unknown";
  producing_age_estimate: "newer" | "mid_life" | "legacy" | "unknown";
  estimated_first_production_year?: number | null;
  production_confidence: "low" | "medium" | "high";
  summary: string;
  reasoning: string[];
  risks: string[];
  missing_data: string[];
};

export function isProductionSnapshotOutput(value: unknown): value is ProductionSnapshotOutput {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const status = o.production_status;
  const okStatus =
    status === "producing" ||
    status === "likely_producing" ||
    status === "declining_or_legacy" ||
    status === "undeveloped" ||
    status === "unknown";
  const trend = o.production_trend;
  const okTrend =
    trend === "growing" || trend === "stable" || trend === "declining" || trend === "unknown";
  const age = o.producing_age_estimate;
  const okAge =
    age === "newer" || age === "mid_life" || age === "legacy" || age === "unknown";
  const conf = o.production_confidence;
  const okConf = conf === "low" || conf === "medium" || conf === "high";
  return (
    okStatus &&
    okTrend &&
    okAge &&
    okConf &&
    typeof o.summary === "string" &&
    Array.isArray(o.reasoning) &&
    Array.isArray(o.risks) &&
    Array.isArray(o.missing_data)
  );
}
