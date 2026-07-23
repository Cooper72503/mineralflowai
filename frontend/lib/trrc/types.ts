// ─── Retrieval method ─────────────────────────────────────────────────────────
// stored      — we fetched the file and stored it in Supabase Storage
// link_only   — we have structured data and a direct TRRC source URL
// manual_required — automated retrieval not possible; user must visit TRRC
export type RetrievalMethod = 'stored' | 'link_only' | 'manual_required';

export type RecordStatus =
  | 'found'            // record exists and was retrieved
  | 'not_found'        // source was queried, no matching record
  | 'unavailable'      // source endpoint not publicly accessible
  | 'manual_required'  // CAPTCHA-gated or session-required
  | 'failed';          // retrieval attempted, error occurred

export type RecordCategory =
  | 'well_identity'
  | 'production'
  | 'completion'
  | 'permits'
  | 'mechanical_integrity'
  | 'compliance'
  | 'plugging'
  | 'inactive_well'
  | 'injection'
  | 'operator'
  | 'proration'
  | 'severance'
  | 'other';

// ─── A single retrieved TRRC record ──────────────────────────────────────────
export interface TrrcRecord {
  id: string;
  runId: string;
  // Identity
  documentName: string;
  category: RecordCategory;
  recordType: string;          // e.g. "W-2 Completion Report", "Monthly Production"
  filingDate: string | null;   // ISO date string or null
  retrievedAt: string;         // ISO datetime
  // Source
  sourceSystem: string;        // e.g. "TRRC EWA", "TRRC OGIMS"
  sourceUrl: string;           // URL to the TRRC page for this record (always present)
  // Document access
  retrievalMethod: RetrievalMethod;
  downloadUrl: string | null;  // direct file URL if retrievable
  storagePath: string | null;  // Supabase Storage path if we stored it
  fileType: string | null;     // 'pdf', 'html', etc.
  fileSize: number | null;
  sha256: string | null;
  // Associated identifiers
  apiNumber: string | null;
  leaseNumber: string | null;
  operatorNumber: string | null;
  district: string | null;
  // Parsed structured data (always populated when record found)
  structuredData: Record<string, unknown>;
  // If manual_required, direct user here
  manualRetrievalUrl: string | null;
  manualRetrievalNote: string | null;
}

// ─── Result from a single source adapter ─────────────────────────────────────
export interface SourceResult {
  sourceId: string;
  sourceName: string;
  status: RecordStatus;
  records: TrrcRecord[];
  error: string | null;
  queriedAt: string;
  durationMs: number;
}

// ─── Well identity (resolved from API number) ────────────────────────────────
export interface ResolvedWell {
  api10: string;              // 10-digit API number, no dashes
  apiFormatted: string;       // e.g. "42-165-02733"
  wellName: string | null;
  operatorName: string | null;
  operatorNumber: string | null;
  leaseNumber: string | null;
  leaseName: string | null;
  district: string | null;
  county: string | null;
  field: string | null;
  wellStatus: string | null;
  wellType: string | null;
  onSchedule: boolean | null;
}

// ─── A complete due diligence run ─────────────────────────────────────────────
export type RunStatus =
  | 'pending'
  | 'resolving'
  | 'retrieving'
  | 'complete'
  | 'failed'
  | 'ambiguous';  // multiple wells matched — requires user selection

export interface TrrcRun {
  id: string;
  userId: string;
  apiNumber: string;           // normalized 10-digit
  apiFormatted: string;        // display format
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  progressPercent: number;
  well: ResolvedWell | null;
  candidateWells: ResolvedWell[];  // populated when status === 'ambiguous'
  sourceResults: SourceResult[];
  records: TrrcRecord[];
  errorMessage: string | null;
}

// ─── Legacy types preserved for existing underwriting workflow ────────────────
// (do not remove — used by /app/(app)/underwriting)
export type TrrcIdentifierType =
  | 'api_number'
  | 'rrc_lease_number'
  | 'gas_well_id'
  | 'operator_name'
  | 'p5_number'
  | 'legal_description'
  | 'lease_name'
  | 'unknown';

export type SourceAttemptStatus =
  | 'success'
  | 'failed_transient'
  | 'failed_permanent'
  | 'manual_required'
  | 'no_results'
  | 'rate_limited';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AcquisitionRecommendation = 'BLOCKED' | 'PURSUE' | 'REVIEW' | 'PASS';

// Keep these as they may be referenced in underwriting
export interface TrrcFinding {
  id: string;
  category: string;
  severity: FindingSeverity;
  finding_type: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  source_record_ids: string[];
  analytical_method: string;
  confidence: number;
  recommended_action: string;
  is_directly_reported: boolean;
}

export type ScorecardDimensionKey =
  | 'record_completeness'
  | 'identity_confidence'
  | 'production_quality'
  | 'production_consistency'
  | 'mechanical_integrity'
  | 'plugging_exposure'
  | 'regulatory_compliance'
  | 'operator_profile'
  | 'development_activity'
  | 'data_confidence';

export interface ScoreDimension {
  label: string;
  score: number;
  weight: number;
  rationale: string;
  data_points: string[];
}

export interface AcquisitionScorecard {
  dimensions: Record<ScorecardDimensionKey, ScoreDimension>;
  opportunity_score: number;
  risk_score: number;
  overall_confidence: number;
  recommendation: AcquisitionRecommendation;
  gating_conditions: string[];
  missing_critical_evidence: string[];
  reasons_for: string[];
  reasons_against: string[];
}

export interface SourceCoverageStatus {
  category: string;
  label: string;
  status: 'complete' | 'partial' | 'retrieval_failed' | 'manual_required' | 'no_applicable_record' | 'not_checked';
  records_found: number;
  data_current_through: string | null;
  sources_checked: string[];
  notes: string | null;
}

export interface TrrcDDProductionRow {
  entity_type: 'lease' | 'api';
  api_number: string | null;
  district: string;
  lease_number: string | null;
  gas_id: string | null;
  operator_number: string | null;
  production_month: string;
  oil_bbl: number | null;
  casinghead_gas_mcf: number | null;
  gas_mcf: number | null;
  condensate_bbl: number | null;
  water_bbl: number | null;
}

export interface TrrcMissingItem {
  category: string;
  expected_record_type: string;
  status: string;
  explanation: string;
  manual_retrieval_url: string | null;
  recommended_action: string | null;
}

export interface ResolvedEntity {
  id: string;
  entity_type: 'wellbore' | 'lease' | 'completion' | 'operator' | 'permit' | 'uic_authority';
  canonical_identifier: string;
  display_name: string;
  attributes: Record<string, unknown>;
  confidence: number;
  resolution_method: string;
  is_user_selected: boolean;
}

export interface TrrcDueDiligenceRun {
  id: string;
  user_id: string;
  original_input: string;
  detected_input_type: TrrcIdentifierType;
  selected_input_type: TrrcIdentifierType;
  normalized_input: string;
  status: 'pending' | 'running' | 'resolving' | 'retrieving' | 'analyzing' | 'generating' | 'complete' | 'failed' | 'cancelled' | 'awaiting_selection';
  started_at: string;
  completed_at: string | null;
  progress_percent: number;
  result_summary: string | null;
  error_summary: string | null;
  resolved_primary_api: string | null;
  resolved_district: string | null;
  resolved_lease_number: string | null;
  resolved_gas_id: string | null;
  resolved_operator_number: string | null;
  report_storage_path: string | null;
  archive_storage_path: string | null;
  manifest_storage_path: string | null;
  created_at: string;
  updated_at: string;
  entities?: ResolvedEntity[];
  findings?: TrrcFinding[];
  production?: TrrcDDProductionRow[];
  missing_items?: TrrcMissingItem[];
  scorecard?: AcquisitionScorecard | null;
  coverage?: SourceCoverageStatus[];
  source_attempts?: Array<{
    source_id: string;
    source_name: string;
    status: string;
    result_count: number;
    error_message: string | null;
    attempted_at: string;
    result_data_json: Record<string, unknown> | null;
  }>;
}

export interface SourceAttempt {
  source_id: string;
  source_name: string;
  status: SourceAttemptStatus;
  result_count: number;
  http_status?: number;
  retry_count: number;
  error_code?: string;
  error_message: string | null;
  manual_action_url?: string;
  started_at: string;
  completed_at: string;
  request_parameters?: Record<string, unknown>;
  request_url?: string;
  result_data_json?: Record<string, unknown> | null;
}

// ─── Orchestrator result (returned by the edge function retrieval engine) ─────

export type OrchestratorResult = {
  run_id: string;
  source_attempts: SourceAttempt[];
  production: TrrcDDProductionRow[];
  findings_raw: Record<string, unknown>[];
  coverage: SourceCoverageStatus[];
  total_records_found: number;
  manual_required_count: number;
  error: string | null;
};

// ─── Source adapter types (used by frontend/lib/trrc/sources/) ───────────────

export interface ResolvedApiRef {
  raw: string;          // original input string
  api10: string;        // 10-digit normalized
  api14: string;        // 14-digit UWI form
  formatted: string;    // "42-165-02733"
  state_code: string;   // "42"
  county_code: string;  // "165"
  well_code: string;    // "02733"
  is_texas: boolean;
}

export interface ResolvedSearchContext {
  run_id: string;
  input_type: TrrcIdentifierType;
  raw_input: string;
  normalized_input: string;
  api_numbers: ResolvedApiRef[];
  district: string | null;
  lease_number: string | null;
  lease_name: string | null;
  gas_id: string | null;
  operator_name: string | null;
  operator_number: string | null;
  county: string | null;
  legal_description: string | null;
  include_offset_wells: boolean;
  search_historical: boolean;
  production_months: number;
}

export interface RetrievalOptions {
  max_records?: number;
  timeout_ms?: number;
}

export interface SourceRecordRef {
  source_id: string;
  document_id: string;
  title: string;
  category: string;
  form_type: string;
  url: string;
  filing_date: string | null;
  is_downloadable: boolean;
}

export interface SourceSearchResult {
  source_id: string;
  status: 'success' | 'no_results' | 'not_applicable' | 'manual_required' | 'failed_transient' | 'failed_permanent';
  records: SourceRecordRef[];
  result_count: number;
  data: Record<string, unknown> | null;
  error: string | null;
  manual_action_url: string | null;
}

export interface SourceRecordReference {
  source_id: string;
  document_id: string;
  url: string;
}

export interface RetrievedFile {
  document_id: string;
  content_type: string;
  data: Uint8Array;
  size_bytes: number;
  sha256: string | null;
}

export interface SourceHealthResult {
  healthy: boolean;
  latency_ms: number;
  error: string | null;
  last_checked: string;
}

export interface TrrcSourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly base_url: string;
  readonly supported_inputs: string[];
  readonly retrieval_strategy: 'html_scrape' | 'api' | 'manual';
  readonly rate_limit_ms: number;
  readonly max_retries: number;
  readonly parser_version: string;
  readonly is_enabled: boolean;
  readonly requires_browser: boolean;
  search(ctx: ResolvedSearchContext, opts: RetrievalOptions): Promise<SourceSearchResult>;
  fetchRecord(ref: SourceRecordReference, opts: RetrievalOptions): Promise<RetrievedFile | null>;
  healthCheck(): Promise<SourceHealthResult>;
}
