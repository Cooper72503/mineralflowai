/**
 * TRRC Public Records Due Diligence — Complete type system.
 *
 * This is the single source of truth for all types used by the TRRC DD engine.
 * Every type is production-quality and compiles under TypeScript strict mode.
 */

// ─── Identifier types ─────────────────────────────────────────────────────────

export type TrrcIdentifierType =
  | "api_number"
  | "rrc_lease_number"
  | "gas_well_id"
  | "operator_name"
  | "p5_number"
  | "legal_description"
  | "lease_name"
  | "unknown";

// ─── Run status ───────────────────────────────────────────────────────────────

export type TrrcRunStatus =
  | "pending"
  | "resolving"
  | "awaiting_selection"
  | "retrieving"
  | "analyzing"
  | "generating"
  | "complete"
  | "failed"
  | "cancelled";

// ─── Source attempt status ────────────────────────────────────────────────────

export type SourceAttemptStatus =
  | "success"
  | "no_results"
  | "failed_transient"
  | "failed_permanent"
  | "manual_required"
  | "source_disabled"
  | "not_applicable"
  | "rate_limited";

// ─── Record category ──────────────────────────────────────────────────────────

export type TrrcRecordCategory =
  | "identity"
  | "drilling_permit"
  | "completion"
  | "production"
  | "well_status"
  | "injection_uic"
  | "plugging_inactive"
  | "operator_p5"
  | "p4_gatherer"
  | "compliance"
  | "gis"
  | "imaged_records"
  | "miscellaneous";

// ─── Finding severity ─────────────────────────────────────────────────────────

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

// ─── Acquisition recommendation ───────────────────────────────────────────────

export type AcquisitionRecommendation = "PURSUE" | "REVIEW" | "PASS" | "BLOCKED";

// ─── Normalized API number ────────────────────────────────────────────────────

/**
 * Fully normalized Texas API number in all standard formats.
 * Texas API: state(2) + county(3) + well(5) = 10-digit base; + sidetrack(2) + event(2) = 14-digit UWI.
 */
export type NormalizedApi = {
  /** Exactly as entered by the user */
  raw: string;
  /** 10-digit, no hyphens: "4215101734" */
  api10: string;
  /** 14-digit full UWI, no hyphens: "42151017340000" */
  api14: string;
  /** Display-format with hyphens: "42-151-01734-00-00" */
  formatted: string;
  /** 2-digit FIPS state code: "42" for Texas */
  state_code: string;
  /** 3-digit county code within state: e.g. "151" for Fisher */
  county_code: string;
  /** 5-digit well code within county: e.g. "01734" */
  well_code: string;
  /** True when state_code === "42" */
  is_texas: boolean;
};

// ─── Resolved entities ────────────────────────────────────────────────────────

export type ResolvedEntityType =
  | "wellbore"
  | "lease"
  | "completion"
  | "operator"
  | "permit"
  | "uic_authority";

export type ResolvedEntity = {
  id: string;
  entity_type: ResolvedEntityType;
  canonical_identifier: string;
  display_name: string;
  attributes: Record<string, unknown>;
  /** 0.0–1.0 confidence in this resolution */
  confidence: number;
  resolution_method: string;
  is_user_selected: boolean;
};

// ─── Source attempt ───────────────────────────────────────────────────────────

export type SourceAttempt = {
  source_id: string;
  source_name: string;
  request_parameters: Record<string, string>;
  request_url: string | null;
  started_at: string;
  completed_at: string | null;
  status: SourceAttemptStatus;
  result_count: number;
  http_status: number | null;
  retry_count: number;
  error_code: string | null;
  error_message: string | null;
  manual_action_url: string | null;
  parser_version: string;
};

// ─── Retrieved file ───────────────────────────────────────────────────────────

export type RetrievedFile = {
  id: string;
  source_id: string;
  category: TrrcRecordCategory;
  document_type: string;
  form_type: string | null;
  title: string;
  filing_date: string | null;
  source_url: string;
  storage_path: string | null;
  original_filename: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  extraction_status: "pending" | "extracted" | "failed" | "not_applicable";
  structured_data: Record<string, unknown> | null;
  is_manual_required: boolean;
};

// ─── Production record ────────────────────────────────────────────────────────

/**
 * Normalized production row from any TRRC source.
 * entity_type distinguishes lease-level (cannot claim per-well) from API-level.
 */
export type TrrcDDProductionRow = {
  entity_type: "lease" | "api";
  api_number: string | null;
  district: string;
  lease_number: string | null;
  gas_id: string | null;
  operator_number: string | null;
  /** ISO month string: "YYYY-MM" */
  production_month: string;
  oil_bbl: number | null;
  casinghead_gas_mcf: number | null;
  gas_mcf: number | null;
  condensate_bbl: number | null;
  water_bbl: number | null;
};

// ─── Finding ──────────────────────────────────────────────────────────────────

export type TrrcFinding = {
  id: string;
  category: TrrcRecordCategory;
  severity: FindingSeverity;
  finding_type: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  source_record_ids: string[];
  analytical_method: string;
  /** 0.0–1.0 confidence in this finding */
  confidence: number;
  recommended_action: string;
  /** True = directly observed in records; false = inferred/derived */
  is_directly_reported: boolean;
};

// ─── Missing item ─────────────────────────────────────────────────────────────

export type TrrcMissingItem = {
  id: string;
  category: TrrcRecordCategory;
  expected_record_type: string;
  status:
    | "confirmed_no_record"
    | "no_result_from_query"
    | "retrieval_failed"
    | "source_unavailable"
    | "manual_required"
    | "outside_date_range";
  explanation: string;
  source_checked: string;
  manual_retrieval_url: string | null;
  recommended_action: string;
};

// ─── Score dimension ──────────────────────────────────────────────────────────

export type ScoreDimension = {
  label: string;
  /** 0–100 */
  score: number;
  /** 0.0–1.0; all dimension weights must sum to 1 */
  weight: number;
  rationale: string;
  data_points: string[];
};

// ─── Acquisition scorecard ────────────────────────────────────────────────────

export type AcquisitionScorecard = {
  dimensions: {
    record_completeness: ScoreDimension;
    identity_confidence: ScoreDimension;
    production_quality: ScoreDimension;
    production_consistency: ScoreDimension;
    mechanical_integrity: ScoreDimension;
    plugging_exposure: ScoreDimension;
    regulatory_compliance: ScoreDimension;
    operator_profile: ScoreDimension;
    development_activity: ScoreDimension;
    data_confidence: ScoreDimension;
  };
  /** 0–100; higher = better opportunity */
  opportunity_score: number;
  /** 0–100; higher = more risk */
  risk_score: number;
  /** 0–100; overall confidence in the scorecard */
  overall_confidence: number;
  recommendation: AcquisitionRecommendation;
  /** Conditions that must be resolved before proceeding */
  gating_conditions: string[];
  /** Critical evidence items that were not retrievable */
  missing_critical_evidence: string[];
  reasons_for: string[];
  reasons_against: string[];
};

// ─── Coverage / completeness model ───────────────────────────────────────────

export type CompletenessCategory =
  | "complete"
  | "partial"
  | "no_applicable_record"
  | "retrieval_failed"
  | "manual_required"
  | "not_checked";

export type SourceCoverageStatus = {
  category: TrrcRecordCategory | string;
  label: string;
  status: CompletenessCategory;
  /** ISO-8601 date through which data is current, or null if unknown */
  data_current_through: string | null;
  sources_checked: string[];
  records_found: number;
  notes: string | null;
};

// ─── Full run state ───────────────────────────────────────────────────────────

/**
 * Complete in-memory / DB-backed state for a single TRRC DD run.
 * All joined arrays are optional — they are populated as retrieval progresses.
 */
export type TrrcDueDiligenceRun = {
  id: string;
  user_id: string;
  original_input: string;
  detected_input_type: TrrcIdentifierType;
  selected_input_type: TrrcIdentifierType;
  normalized_input: string;
  status: TrrcRunStatus;
  started_at: string;
  completed_at: string | null;
  /** 0–100 */
  progress_percent: number;
  result_summary: string | null;
  error_summary: string | null;
  resolved_primary_api: string | null;
  resolved_district: string | null;
  resolved_lease_number: string | null;
  resolved_gas_id: string | null;
  resolved_operator_number: string | null;
  /** Supabase Storage path for the generated PDF report */
  report_storage_path: string | null;
  /** Supabase Storage path for the zip archive of all retrieved files */
  archive_storage_path: string | null;
  /** Supabase Storage path for the JSON retrieval manifest */
  manifest_storage_path: string | null;
  created_at: string;
  updated_at: string;
  // Joined / hydrated data — not stored as DB columns directly
  entities?: ResolvedEntity[];
  source_attempts?: SourceAttempt[];
  production?: TrrcDDProductionRow[];
  findings?: TrrcFinding[];
  missing_items?: TrrcMissingItem[];
  scorecard?: AcquisitionScorecard | null;
  coverage?: SourceCoverageStatus[];
};

// ─── Source adapter interface ─────────────────────────────────────────────────

export type ResolvedSearchContext = {
  run_id: string;
  input_type: TrrcIdentifierType;
  raw_input: string;
  normalized_input: string;
  api_numbers: NormalizedApi[];
  district: string | null;
  lease_number: string | null;
  gas_id: string | null;
  operator_name: string | null;
  operator_number: string | null;
  county: string | null;
  lease_name: string | null;
  legal_description: string | null;
  search_historical: boolean;
  include_offset_wells: boolean;
  production_months: number;
};

export type RetrievalOptions = {
  timeout_ms: number;
  max_retries: number;
  dry_run: boolean;
};

export type SourceRecordRef = {
  source_id: string;
  document_id: string;
  title: string;
  category: TrrcRecordCategory;
  form_type: string | null;
  url: string | null;
  filing_date: string | null;
  is_downloadable: boolean;
};

export type SourceSearchResult = {
  source_id: string;
  status: SourceAttemptStatus;
  records: SourceRecordRef[];
  manual_action_url: string | null;
  error: string | null;
  result_count: number;
  data: Record<string, unknown> | null;
};

export type SourceRecordReference = {
  source_id: string;
  document_id: string;
  url: string;
};

export type SourceHealthResult = {
  healthy: boolean;
  latency_ms: number;
  error: string | null;
  last_checked: string;
};

/**
 * Interface every TRRC source adapter must implement.
 * Adapters are registered in source-registry.ts and instantiated by the engine.
 */
export interface TrrcSourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly base_url: string;
  readonly supported_inputs: TrrcIdentifierType[];
  readonly retrieval_strategy: "api" | "html_scrape" | "dataset_download" | "manual";
  readonly rate_limit_ms: number;
  readonly max_retries: number;
  readonly parser_version: string;
  readonly is_enabled: boolean;
  readonly requires_browser: boolean;

  search(ctx: ResolvedSearchContext, opts: RetrievalOptions): Promise<SourceSearchResult>;
  fetchRecord?(ref: SourceRecordReference, opts: RetrievalOptions): Promise<RetrievedFile | null>;
  healthCheck(): Promise<SourceHealthResult>;
}
