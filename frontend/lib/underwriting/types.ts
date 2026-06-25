/**
 * Operator Due Diligence Brain — Type definitions.
 *
 * Every field is wrapped in DataPoint<T> which carries:
 *   value     — the actual value (null when absent)
 *   source    — where it came from
 *   confidence — how sure we are
 *   note      — "Needs operator confirmation", "Not provided", "Nearby/offset only", etc.
 */

// Re-export sensitivity matrix types from economics engine so callers only need one import.
export type { SensitivityMatrix, SensitivityCell } from "./economics-engine";

// ─── Provenance wrapper ───────────────────────────────────────────────────────

export type DataSource =
  | "uploaded_doc"   // extracted from a document the user provided
  | "trrc"           // pulled directly from TRRC / state agency
  | "run_statement"  // from a run ticket or purchaser statement
  | "loe_statement"  // from an LOE / joint interest billing statement
  | "inferred"       // calculated from other verified data points
  | "missing";       // not available from any source

export type DataConfidence = "high" | "medium" | "low" | "none";

export type DataPoint<T> = {
  value: T | null;
  source: DataSource;
  source_detail?: string;     // e.g. "LOE Statement Mar-2024" or "TRRC Lease 12345/06"
  /**
   * Exact URL queried to obtain this value (public records only).
   * Enables one-click human verification of every extracted fact.
   */
  source_url?: string;
  /**
   * ISO-8601 timestamp of when the source was queried.
   * Required for audit trail — values must be tied to a specific capture event.
   */
  query_timestamp?: string;
  confidence: DataConfidence;
  note?: string;              // human-readable caveat, e.g. "Needs operator confirmation"
  /**
   * Field Audit debug trail — each entry documents one step in the 7-step provenance chain:
   * [User Input → Normalization → Identity Resolution → Source Pull → Value Parsing → Confidence → Display]
   */
  audit_trail?: string[];
};

// ─── Subject identity & matching ─────────────────────────────────────────────

export type MatchTier =
  | "exact_api"           // matched on exact 10-digit API number
  | "exact_rrc_lease"     // matched on exact RRC distCode:leaseNo
  | "operator_lease_county" // operator + lease name + county
  | "well_name_county"    // well name + county (weakest exact match)
  | "no_match";           // could not match — county-level data NOT used as subject

/**
 * Canonical API number with all standard formats derived from the raw input.
 * Texas API: state(2) + county(3) + well(5) = 10-digit base; + sidetrack(2) + event(2) = 14-digit UWI.
 */
export type NormalizedApi = {
  /** Exactly as entered by the user */
  raw_api: string;
  /** 10 digits, no hyphens: "4215101734" */
  api_10: string;
  /** 14 digits, full UWI: "42151017340000" */
  api_14: string;
  /** Display-format: "42-151-01734" */
  api_formatted: string;
  /** 2-digit FIPS state code: "42" = Texas */
  state_code: string;
  /** 3-digit county code within state: "151" = Harris */
  county_code: string;
};

export type SubjectIdentity = {
  api_numbers: string[];          // 10-digit UWI format (42-XXX-XXXXX-XX-XX)
  rrc_lease_number?: string | null; // dist_code:lease_no e.g. "06:12345"
  operator_name?: string | null;
  lease_name?: string | null;
  county?: string | null;
  state?: string | null;
  match_tier: MatchTier;
  match_confidence: DataConfidence;
  /** Normalized forms of every API number provided — populated by report-builder */
  normalized_apis: NormalizedApi[];
  /**
   * Human-readable resolution steps showing how identifiers were processed.
   * e.g. ["API input: 42-151-01734", "Normalized: 42-151-01734-00-00", "RRC lease lookup: no match"]
   */
  match_path: string[];
};

// ─── Production ──────────────────────────────────────────────────────────────

export type WellProductionRow = {
  api: string;
  well_name: string;
  lease_number: string | null;
  district_code: string | null;
  operator: string | null;
  latest_monthly_oil_bbl: DataPoint<number>;
  /** Daily equivalent of latest_monthly_oil_bbl (÷ 30.44) — shown as BOPD */
  latest_daily_oil_bbl: DataPoint<number>;
  latest_monthly_gas_mcf: DataPoint<number>;
  latest_monthly_water_bbl: DataPoint<number>;
  latest_production_month: string | null;
  water_cut_pct: DataPoint<number>;
  three_month_avg_bbl: DataPoint<number>;
  six_month_avg_bbl: DataPoint<number>;
  twelve_month_avg_bbl: DataPoint<number>;
  twenty_four_month_avg_bbl: DataPoint<number>;
  production_trend: DataPoint<"increasing" | "flat" | "declining" | "offline">;
  cum_oil_bbl: DataPoint<number>;
  formation: string | null;
  perforation_depth_ft: DataPoint<number>;
  /** Full monthly production history (all nonzero months from RRC CSV — up to 40 years / 480 months) */
  monthly_history: { period: string; oil_bbl: number; gas_mcf: number; water_bbl: number | null }[];
};

export type ProductionSection = {
  wells: WellProductionRow[];
  total_monthly_oil_bbl: DataPoint<number>;
  /** Daily equivalent of total_monthly_oil_bbl (÷ 30.44) — shown as BOPD */
  total_daily_oil_bbl: DataPoint<number>;
  total_monthly_gas_mcf: DataPoint<number>;
  total_monthly_water_bbl: DataPoint<number>;
  water_cut_pct: DataPoint<number>;
  decline_rate_pct_monthly: DataPoint<number>;
  production_trend: DataPoint<"increasing" | "flat" | "declining" | "offline">;
  last_production_date: DataPoint<string>;
  reserve_report_present: DataPoint<boolean>;
  reserve_pv10: DataPoint<number>;
  notes: string[];
};

// ─── Economics / LOE ─────────────────────────────────────────────────────────

export type LOELineItem = {
  category: string;    // "Electricity" | "Chemical" | "Labor" | "Water Disposal" | "Workover" | "Compression" | etc.
  amount_usd: number;
  source_detail: string;
};

export type LOEStatement = {
  period: string;             // "2024-03"
  source: DataSource;
  source_detail: string;
  total_loe_usd: number | null;
  revenue_usd: number | null;
  net_income_usd: number | null;
  oil_price_per_bbl: number | null;
  gas_price_per_mcf: number | null;
  line_items: LOELineItem[];
  confidence: DataConfidence;
};

export type EconomicsSection = {
  loe_statements: LOEStatement[];              // up to 24 months
  loe_months_available: number;
  avg_monthly_loe_usd: DataPoint<number>;
  avg_monthly_revenue_usd: DataPoint<number>;
  avg_monthly_net_income_usd: DataPoint<number>;
  loe_per_boe: DataPoint<number>;
  electricity_cost_monthly: DataPoint<number>;
  chemical_cost_monthly: DataPoint<number>;
  labor_cost_monthly: DataPoint<number>;
  disposal_cost_monthly: DataPoint<number>;
  compression_cost_monthly: DataPoint<number>;
  oil_price_received: DataPoint<number>;
  gas_price_received: DataPoint<number>;
  run_tickets_present: DataPoint<boolean>;
  purchaser_statements_present: DataPoint<boolean>;
  // Phase 2: verified revenue metrics from run statements (metered, signed records)
  run_statement_months: number;               // number of subject-lease run statement periods
  avg_run_net_revenue_usd: DataPoint<number>; // avg monthly net revenue from run statements
  avg_run_gross_revenue_usd: DataPoint<number>; // avg monthly gross revenue from run statements
  avg_run_severance_tax_usd: DataPoint<number>; // avg monthly severance tax from run statements
  effective_sev_rate_pct: DataPoint<number>;  // actual tax rate (gross → net), cross-checks 4.6% TX
  run_vs_rrc_discrepancy_count: number;       // periods where run statement bbl vs TRRC bbl differ >5%
  notes: string[];
};

// ─── Workovers / Maintenance ──────────────────────────────────────────────────

export type WorkoverEvent = {
  date: string | null;
  well: string | null;
  type: string;               // "Pump replacement" | "Workover" | "Stimulation" | etc.
  cost_usd: number | null;
  result: string | null;      // "Restored to X BOPD" | "Unsuccessful" | etc.
  source: DataSource;
  source_detail: string;
  confidence: DataConfidence;
};

export type WorkoverSection = {
  events: WorkoverEvent[];
  total_workover_cost_usd: DataPoint<number>;
  avg_annual_workover_cost_usd: DataPoint<number>;
  last_workover_date: DataPoint<string>;
  notes: string[];
};

// ─── Equipment ───────────────────────────────────────────────────────────────

export type EquipmentItem = {
  type: string;               // "Pump Jack" | "Rod Pump" | "Separator" | "Tank Battery" | etc.
  quantity: number | null;
  condition: string | null;   // "Good" | "Fair" | "Poor" | "Unknown"
  age_years: number | null;
  estimated_value_usd: number | null;
  notes: string | null;
  source: DataSource;
  source_detail: string;
  confidence: DataConfidence;
};

export type EquipmentSection = {
  items: EquipmentItem[];
  total_estimated_value_usd: DataPoint<number>;
  notes: string[];
};

// ─── Compliance ───────────────────────────────────────────────────────────────

export type ComplianceViolation = {
  violation_id: string | null;
  date: string | null;
  type: string;
  description: string;
  status: "open" | "closed" | "unknown";
  penalty_usd: number | null;
  api_or_lease: string | null;
  source: DataSource;
  source_detail: string;
  confidence: DataConfidence;
};

// ─── Inspection Records (ICE field inspections) ───────────────────────────────
// Distinct from violation database records — these are actual field visits.

export type InspectionResult = "compliant" | "non_compliant" | "unknown";

export type InspectionRecord = {
  api: string;
  inspection_date: string | null;
  inspection_type: string | null;
  result: InspectionResult;
  defect_summary: string | null;
  notes: string | null;
};

export type ComplianceSection = {
  violations: ComplianceViolation[];
  /** ICE field inspection records — separate from the violation database */
  inspection_records: InspectionRecord[];
  most_recent_inspection_date: DataPoint<string>;
  most_recent_inspection_result: DataPoint<InspectionResult>;
  open_violation_count: DataPoint<number>;
  most_recent_violation_date: DataPoint<string>;
  rrc_good_standing: DataPoint<boolean>;
  bond_amount_usd: DataPoint<number>;
  bond_type: DataPoint<string>;
  bond_number: DataPoint<string>;
  bonding_company: DataPoint<string>;
  notes: string[];
};

// ─── Plugging Liability ───────────────────────────────────────────────────────

export type PluggingLiabilityWell = {
  api: string;
  well_name: string | null;
  status: string;             // "Active" | "Inactive" | "Shut-In" | "P&A'd" | "Orphan"
  inactive_since: string | null;
  estimated_plug_cost_usd: number | null;
  rrc_plugging_order: boolean;
  source: DataSource;
  confidence: DataConfidence;
};

export type PluggingLiabilitySection = {
  wells: PluggingLiabilityWell[];
  total_estimated_plug_cost_usd: DataPoint<number>;
  inactive_well_count: DataPoint<number>;
  orphan_well_risk: DataPoint<"low" | "medium" | "high">;
  notes: string[];
};

// ─── SWD / Injection Wells ────────────────────────────────────────────────────

export type InjectionWellRecord = {
  api: string;
  well_name: string | null;
  permit_number: string | null;
  well_type: string;              // "SWD" | "UIC Class II" | "Enhanced Recovery" | etc.
  injection_zone: string | null;  // Formation name
  depth_ft: number | null;
  permitted_max_volume_bwpd: DataPoint<number>;
  permitted_max_pressure_psi: DataPoint<number>;
  avg_daily_injection_bwpd: DataPoint<number>;
  mit_status: DataPoint<string>;  // "Current" | "Expired" | "Not Required"
  last_mit_date: DataPoint<string>;
  next_mit_due: DataPoint<string>;
  permit_status: DataPoint<string>;
  source: DataSource;
  confidence: DataConfidence;
};

export type InjectionSection = {
  wells: InjectionWellRecord[];
  total_disposal_capacity_bwpd: DataPoint<number>;
  current_utilization_pct: DataPoint<number>;
  /** Estimated monthly disposal revenue (permitted_bwpd × utilization × disposal_rate × 30) */
  swd_disposal_revenue_monthly: DataPoint<number>;
  /** Estimated monthly SWD operating cost */
  swd_operating_cost_monthly: DataPoint<number>;
  /** Estimated monthly SWD net income */
  swd_net_income_monthly: DataPoint<number>;
  /** Annualized SWD net income */
  swd_annual_net_income: DataPoint<number>;
  /** Typical disposal rate per BBL used for estimate */
  swd_disposal_rate_per_bbl: number | null;
  swd_economics_notes: string[];
  notes: string[];
};

// ─── Ownership / Interest ─────────────────────────────────────────────────────

export type OwnershipRecord = {
  owner_name: string;
  interest_type: string;    // "WI" | "RI" | "ORRI" | "NPI" | "NPR"
  decimal_interest: number | null;
  nri_decimal: number | null;
  source: DataSource;
  source_detail: string;
  confidence: DataConfidence;
};

export type OwnershipSection = {
  records: OwnershipRecord[];
  working_interest_decimal: DataPoint<number>;
  royalty_interest_decimal: DataPoint<number>;
  nri_decimal: DataPoint<number>;
  subject_wi: DataPoint<number>;
  subject_nri: DataPoint<number>;
  notes: string[];
};

// ─── Missing Items ────────────────────────────────────────────────────────────

export type MissingItem = {
  section: string;
  field: string;
  importance: "critical" | "important" | "nice_to_have";
  note: string;
};

// ─── Three-Layer Evidence Hierarchy ──────────────────────────────────────────
//
// Every diligence field must have an evidence source classification:
//
//   Layer 1 — TRRC structured public records (wellbore query, lease production,
//             completions query, ICE inspection). Highest reliability.
//   Layer 2 — TRRC imaged records (W-1 drilling permit, W-2 completion report,
//             EWA document viewer). Reliable but requires OCR.
//   Layer 3 — Seller/operator document upload. Operator-provided; needs corroboration.
//
//   user_assumption  — user entered a value without documentary backing
//   model_estimate   — inferred from basin benchmarks or calculations
//   not_found        — not found in any source; document request generated

export type EvidenceSource =
  | "trrc_structured"   // Layer 1: TRRC structured public record
  | "trrc_imaged"       // Layer 2: TRRC imaged record (W-1/W-2, OCR)
  | "seller_document"   // Layer 3: Seller/operator provided document
  | "user_assumption"   // User-entered without external backing
  | "model_estimate"    // Inferred / basin benchmark
  | "not_found";        // No source found — document required

/**
 * A structured document request generated when a diligence field cannot be
 * satisfied from Layer 1 or Layer 2. These requests form the Layer 3 checklist
 * sent to the seller/operator before offer.
 */
export type DocumentRequest = {
  /** Short field label, e.g. "Monthly LOE" */
  field: string;
  /** Document type to request, e.g. "LOE Statement (JIB)", "Division Order" */
  document_type: string;
  /** Specific ask, e.g. "12 months of signed JIB statements covering Jan 2023–Dec 2023" */
  description: string;
  /** Who should provide this document */
  from: "seller" | "operator" | "title_attorney" | "state_agency";
  urgency: "critical" | "important" | "informational";
};

// ─── Diligence Status Engine ─────────────────────────────────────────────────
//
// Every underwriting category is classified as one of three tiers:
//   verified          — data confirmed from TRRC, signed docs, or high-confidence source
//   partially_verified — data present but incomplete, inferred, or operator-unconfirmed
//   missing           — no data available; action required before offer
//   not_applicable    — category does not apply to this asset
//
// This is the "Missing Diligence Engine" — a buyer-facing status board that
// instantly shows what is confirmed vs. what still needs to be resolved.

export type DiligenceStatusTier =
  | "verified"           // Data confirmed from authoritative source
  | "partially_verified" // Some data available, gaps remain
  | "searched_no_records"// Query ran successfully; no records returned (expected/good for compliance)
  | "missing"            // Data was never sought or not provided
  | "query_failed"       // Query was attempted but failed (technical error)
  | "not_applicable";    // Does not apply to this well/asset

export type DiligenceStatusItem = {
  /** Short category name, e.g. "Production History" */
  category: string;
  /** One-line explanation of current status */
  status_detail: string;
  tier: DiligenceStatusTier;
  /** Where the data came from — e.g. "TRRC (exact API match)" */
  source_label: string | null;
  /** What the buyer must obtain to upgrade from missing/partial → verified */
  action_required: string | null;
  /** Relative urgency — critical items block offer; important items needed before close */
  urgency: "critical" | "important" | "informational";
  /**
   * Three-layer evidence source for this field.
   * Drives the evidence-source badge and document-request generation.
   */
  evidence_source: EvidenceSource;
  /**
   * Structured document requests for this field.
   * Populated when evidence_source is "not_found", "model_estimate", or "user_assumption".
   * Forms the Layer 3 seller/operator checklist.
   */
  document_requests: DocumentRequest[];
};

// ─── Offer Gate ───────────────────────────────────────────────────────────────
//
// Prevents a final offer recommendation from being displayed until
// production, ownership, LOE, water/disposal, and downtime/workover risk
// are each backed by at least Layer 2 (TRRC imaged) evidence.
// Fields sourced only from model_estimate or not_found block the offer.

export type OfferGateField = {
  category: string;
  current_source: EvidenceSource;
  required_sources: EvidenceSource[];
  blocking: boolean;
  resolution: string;
};

export type OfferGate = {
  /**
   * true  — offer recommendation is enabled
   * false — final offer is locked until blocking fields are resolved
   */
  gate_open: boolean;
  blocking_count: number;
  blocking_fields: OfferGateField[];
  /** Human-readable summary for the UI banner */
  gate_message: string;
};

// ─── Operational Timeline ─────────────────────────────────────────────────────

export type OperationalTimelineEventType =
  | "workover"
  | "major_workover"
  | "production_drop"
  | "production_recovery"
  | "downtime_start"
  | "downtime_end"
  | "violation_opened"
  | "violation_closed"
  | "mit_test"
  | "operator_change"
  | "inspection"
  | "completion"
  | "recompletion";

export type OperationalTimelineEvent = {
  period: string | null;                    // "YYYY-MM" or "YYYY-MM-DD"
  event_type: OperationalTimelineEventType;
  well: string | null;
  description: string;
  /** "info" = operational note; "warning" = possible risk; "critical" = red flag */
  severity: "info" | "warning" | "critical";
  source: DataSource;
  /** Change in production vs prior month (negative = drop) */
  production_impact_bbl: number | null;
};

// ─── Next Questions ───────────────────────────────────────────────────────────

export type NextQuestion = {
  question: string;
  rationale: string;
  priority: "high" | "medium" | "low";
  directed_at: "operator" | "seller" | "title_attorney" | "engineer" | "state_agency";
};

// ─── Decline Curve Analysis ───────────────────────────────────────────────────

export type DcaSection = {
  model_type: DataPoint<"exponential" | "hyperbolic" | "harmonic">;
  decline_rate_monthly_pct: DataPoint<number>;
  decline_rate_annual_pct: DataPoint<number>;
  b_factor: DataPoint<number>;
  r_squared: DataPoint<number>;
  eur_bbl: DataPoint<number>;
  remaining_reserves_bbl: DataPoint<number>;
  economic_life_months: DataPoint<number>;
  current_rate_bbl: DataPoint<number>;
  /** Daily equivalent of current_rate_bbl (÷ 30.44 days/month) — shown as BOPD */
  current_rate_bopd: DataPoint<number>;
  peak_rate_bbl: DataPoint<number>;
  cum_oil_bbl: DataPoint<number>;
  // Monthly projections: month 1–60 from current
  projections: { month: number; rate_bbl: number }[];
  /** Probabilistic remaining reserves from DCA parameter variation (P90=conservative, P10=optimistic) */
  p10_remaining_bbl: DataPoint<number>;
  p50_remaining_bbl: DataPoint<number>;
  p90_remaining_bbl: DataPoint<number>;
  notes: string[];
};

// ─── Acquisition Economics ────────────────────────────────────────────────────

export type EconomicsScenario = {
  deck_label: string;
  oil_price_usd: number;
  gas_price_usd: number;
  monthly_gross_revenue: number;
  monthly_net_revenue: number;
  monthly_severance_tax: number;
  monthly_net_income: number;
  loe_per_boe: number;
  annual_net_income: number;
  npv10_usd: number;
  npv15_usd: number;
  offer_low_usd: number;
  offer_mid_usd: number;
  offer_high_usd: number;
  irr_pct: number | null;
  payout_months: number | null;
};

export type MonthlyCashFlowRow = {
  month: number;            // 1-based month from current
  rate_bbl: number;         // projected oil production (Arps)
  gross_revenue: number;    // before NRI and taxes
  net_income: number;       // after NRI, LOE, severance
  cumulative_net_income: number;  // running total from month 1
};

export type AcquisitionEconomicsSection = {
  nri_decimal: DataPoint<number>;
  wi_decimal: DataPoint<number>;
  monthly_net_income_usd: DataPoint<number>;
  annual_net_income_usd: DataPoint<number>;
  npv10_usd: DataPoint<number>;
  offer_range_low: DataPoint<number>;
  offer_range_mid: DataPoint<number>;
  offer_range_high: DataPoint<number>;
  breakeven_oil_price: DataPoint<number>;
  months_remaining: DataPoint<number>;
  scenarios: EconomicsScenario[];
  /** 4×4 production × price NPV10 sensitivity grid (IC standard) */
  sensitivity_matrix?: import("./economics-engine").SensitivityMatrix;
  /** 24-month projected cash flow schedule (base deck, Arps decline) */
  monthly_cash_flow_schedule?: MonthlyCashFlowRow[];
  /** BTAX / ATAX analysis under SEC statutory depletion (15% of gross revenue) */
  tax_analysis: import("./economics-engine").TaxAnalysis | null;
  notes: string[];
};

// ─── Risk & Recommendation ────────────────────────────────────────────────────

export type RiskCategoryResult = {
  name: string;
  score: number;
  weight: number;
  flags: string[];
  mitigants: string[];
};

export type DiligenceCheckItem = {
  item: string;
  status: "complete" | "pending" | "na";
  priority: "critical" | "important" | "nice_to_have";
};

export type RiskSection = {
  overall_score: DataPoint<number>;
  recommendation: DataPoint<"pursue" | "review" | "pass">;
  recommendation_rationale: string;
  confidence: DataConfidence;
  categories: {
    production:   RiskCategoryResult;
    financial:    RiskCategoryResult;
    compliance:   RiskCategoryResult;
    plugging:     RiskCategoryResult;
    operator:     RiskCategoryResult;
    data_quality: RiskCategoryResult;
  };
  red_flags:    string[];
  yellow_flags: string[];
  green_flags:  string[];
  diligence_checklist: DiligenceCheckItem[];
};

// ─── Data Provenance ─────────────────────────────────────────────────────────
//
// Full audit trail for every value shown in a DDReport.
// Answers: where did this number come from, what was the raw value,
// what transformation was applied, and is it in conflict with another source?

export type DocProductionRow = {
  period: string;
  oil_bbl: number | null;
  gas_mcf: number | null;
  water_bbl: number | null;
  oil_price_per_bbl: number | null;
  gross_revenue_usd: number | null;
  source_detail: string;
};

export type ProductionConflict = {
  period: string;
  doc_bbl: number;
  trrc_bbl: number;
  abs_diff: number;
  pct_diff: number;   // (trrc_bbl - doc_bbl) / doc_bbl * 100
};

export type ProductionLineage = {
  // ── Source A: document-extracted ────────────────────────────────────────
  doc_months: DocProductionRow[];
  doc_month_count: number;
  doc_date_range: string | null;

  // ── Source B: TRRC ───────────────────────────────────────────────────────
  trrc_months: { period: string; oil_bbl: number; gas_mcf: number | null }[];
  trrc_month_count: number;
  trrc_date_range: string | null;
  /** "distCode:leaseNo" format, e.g. "06:123456" */
  trrc_lease_id: string | null;

  // ── Authoritative selection ──────────────────────────────────────────────
  authoritative_source: "trrc" | "document" | "none";
  selection_reason: string;
  /** true when TRRC data was chosen and document data also existed */
  trrc_overrides_document: boolean;

  // ── Period-by-period conflict analysis ──────────────────────────────────
  overlapping_periods: string[];
  conflicting_periods: ProductionConflict[];
  /** true if any period differs by ≥20% between doc and TRRC */
  has_critical_mismatch: boolean;
  mismatch_summary: string | null;

  // ── Dataset used at each pipeline stage ─────────────────────────────────
  dca_source: "trrc" | "document" | "none";
  dca_row_count: number;
  dca_rate_bbl_used: number | null;

  economics_source: "trrc" | "document" | "none";
  economics_rate_bbl: number | null;
  economics_rate_basis: string;

  offer_range_rate_bbl: number | null;

  // ── Warnings ─────────────────────────────────────────────────────────────
  warnings: string[];
};

export type ProvenanceRecord = {
  field: string;
  category: "production" | "economics" | "ownership" | "market" | "calculated";
  /** Human-readable source label, e.g. "Run statement (3 months)" */
  source_label: string;
  /** Exact raw value as returned from source before any transformation */
  raw_value: string;
  /** What was done to convert raw → final, or null if no transformation */
  transformation: string | null;
  /** Value as shown in the report */
  final_value: string;
  confidence: "high" | "medium" | "low" | "none";
  /** Non-null when another source had a different value and was NOT used */
  conflict: {
    alt_source: string;
    alt_value: string;
    why_not_used: string;
  } | null;
};

export type DataProvenanceReport = {
  production_lineage: ProductionLineage;
  key_inputs: ProvenanceRecord[];
};

// ─── Production Audit ────────────────────────────────────────────────────────
//
// Captures every step from raw TRRC fetch through classification so discrepancies
// between MineralFlow output and run-statement/purchaser-statement values can be
// traced to their exact source.

export type ProductionAuditRawRow = {
  period: string;           // "YYYY-MM"
  oil_bbl: number;
  gas_mcf: number | null;
  source: "trrc_actual" | "doc_extracted";
};

export type ProductionAuditClassifiedRow = {
  period: string;
  oil_bbl: number;
  gas_mcf: number | null;
  classification: "active" | "downtime" | "restart" | "flush" | "incomplete";
  classification_note: string | null;
  used_in_stabilized_avg: boolean;
  used_in_dca: boolean;
};

export type ProductionAudit = {
  // ── Identity resolution ─────────────────────────────────────────────────
  /** API numbers exactly as entered by the user */
  input_apis: string[];
  /** Normalized 10-digit API numbers (e.g. "42-151-01734") */
  resolved_apis: string[];
  /** TRRC distCode:leaseNo pairs actually queried (e.g. ["06:123456"]) */
  resolved_leases: string[];
  /** TRRC district codes */
  trrc_districts: string[];
  /** Step-by-step trail from user input → lease query */
  resolution_steps: string[];
  /** URL queried for the production data */
  trrc_production_url: string | null;

  // ── Raw data ─────────────────────────────────────────────────────────────
  /** Every row as returned from TRRC or doc extraction, before any filtering */
  raw_rows: ProductionAuditRawRow[];
  raw_row_count: number;
  raw_date_range: string | null;  // "YYYY-MM → YYYY-MM"

  // ── Classification output ────────────────────────────────────────────────
  /** Each month tagged with what the production engine did to it */
  classified_rows: ProductionAuditClassifiedRow[];
  months_active: number;
  months_downtime: number;
  months_restart: number;
  months_flush: number;
  months_incomplete: number;

  // ── Final values used ────────────────────────────────────────────────────
  stabilized_rate_bbl: number | null;
  stabilized_rate_basis: string;    // e.g. "3-month stabilized average (active months only)"
  dca_input_row_count: number;

  // ── Audit notes ──────────────────────────────────────────────────────────
  notes: string[];
};

// ─── Full DD Report ───────────────────────────────────────────────────────────

export type DDReportConfidence = "high" | "medium" | "low" | "very_low";

export type DDReport = {
  report_id: string;
  generated_at: string;  // ISO timestamp
  /**
   * "quick" — preliminary scan only (3–10 s). Do NOT use for investment decisions.
   * "full"  — complete underwriting pipeline. All available sources consulted.
   */
  scan_mode: ScanMode;

  /**
   * Completion label derived from module status gate logic (Manus spec FinalGateDecision).
   *
   * "Quick Screen"            — identity resolved only; no evidence modules passed.
   * "Preliminary Diligence"   — 1–2 evidence modules returned results; major gaps remain.
   * "Public-Record Diligence" — production, violations, inventory all verified from public records;
   *                             no failed downloads; seller docs not yet provided.
   * "Failed Verification"     — a report claim is contradicted by raw evidence, OR a mandatory
   *                             download failed (district violation file, production CSV).
   * "Acquisition-Grade Diligence" — all public-record modules passed; seller docs verified;
   *                                  no contradicted claims; gate fully open.
   *
   * The report NEVER claims a higher tier than the evidence supports.
   * Gate logic drives this label — not the scan completing.
   */
  diligence_run_label:
    | "Quick Screen"
    | "Preliminary Diligence"
    | "Public-Record Diligence"
    | "Failed Verification"
    | "Acquisition-Grade Diligence";
  /**
   * Confidence Score (0–100) — Manus spec §5.
   * Computed from the percentage of critical and important evidence modules that
   * are verified. Penalizes missing critical documents (−20 pts each) and
   * missing important documents (−8 pts each). Shown at the top of every report.
   */
  confidence_score: number;
  overall_confidence: DDReportConfidence;
  overall_confidence_note: string;

  subject: SubjectIdentity;

  // Executive summary (synthesized — no extra AI call)
  executive_summary: ExecutiveSummarySection;

  // Core sections
  production: ProductionSection;
  dca: DcaSection;
  acquisition_economics: AcquisitionEconomicsSection;
  risk: RiskSection;
  economics: EconomicsSection;
  workovers: WorkoverSection;
  equipment: EquipmentSection;
  compliance: ComplianceSection;
  plugging_liability: PluggingLiabilitySection;
  injection: InjectionSection;
  ownership: OwnershipSection;
  downtime: DowntimeSection;
  buyer_qa: BuyerQASection;
  formation_completion: FormationCompletionSection;
  operator_profile: OperatorProfileSection;
  /**
   * TRRC Layer 2 imaged records — W-1, W-2, G-1, P-4 direct viewer links.
   * Null when the query was not attempted (quick scan or no API numbers).
   */
  imaged_records: ImagedRecordsSection | null;

  /**
   * TRRC EWA oil/gas proration factor records.
   * Null when not attempted (quick scan, no API + district code, or non-Texas well).
   */
  proration: ProrationSection | null;

  /**
   * TRRC P-5 operator organization status.
   * Null when operator number not resolved or query failed.
   */
  p5_operator_status: P5OperatorStatus | null;

  /**
   * OFFSET / NEARBY ACTIVITY — all wells in the same TRRC field.
   * ⚠ NEVER use as subject-asset production.
   * Null when field number not available or query not attempted.
   */
  offset_wells: OffsetWellsSection | null;

  /**
   * CMPL W-2 packet detail extracted via loadPacket.
   * Non-null when a completion packet was found and detail could be retrieved.
   * Provides formation name (from TRRC Field Name), wellbore profile, completion type.
   * Upgrades formation evidence from model_estimate → trrc_imaged.
   */
  cmpl_packet_detail: import("@/lib/wells/trrc-imaged-records").CmplPacketDetail | null;

  /**
   * Lease-well inventory — ALL wells on the subject lease, discovered from TRRC.
   *
   * Critical: lease production is ALWAYS aggregate across all wells.
   * `can_claim_single_well_production` is always false unless per-well allocation
   * evidence (metered run tickets, pooling agreements with well-level breakdowns) exists.
   *
   * Golden fixture: Lease 60509 / District 8A → 52 wells.
   * If this returns 1 well when the lease has 52, the implementation fails.
   */
  lease_well_inventory: import("@/lib/underwriting/trrc-lease-inventory").LeaseWellInventoryResult | null;

  /**
   * District violation file results — downloaded from TRRC official file transfer.
   *
   * This is the AUTHORITATIVE compliance source, covering the full historical record.
   * The ICE portal (used for `compliance.violations`) only covers from Aug 2015 onward.
   *
   * CRITICAL: if `district_violations.status === "download_failed"`, the report
   * MUST NOT claim clean compliance. Failed download ≠ no violations.
   *
   * Golden fixture: Lease 60509 / District 8A → 39 matching records.
   */
  district_violations: import("@/lib/underwriting/trrc-district-violations").DistrictViolationResult | null;

  /** Chronological event log — correlates workovers, violations, downtime, production changes */
  operational_timeline: OperationalTimelineEvent[];
  /** Three-tier diligence status board: VERIFIED / PARTIALLY VERIFIED / MISSING */
  diligence_status: DiligenceStatusItem[];
  /**
   * Auto-generated IC-memo narrative (4 paragraphs):
   *   [0] Asset description & identity
   *   [1] Production analysis & decline
   *   [2] Economics summary & offer range
   *   [3] Risk assessment & recommendation
   */
  underwriting_narrative: string[];
  missing_items: MissingItem[];
  next_questions: NextQuestion[];

  /** Documents provided as input */
  input_documents: {
    filename: string;
    doc_type: string;
    char_count: number;
  }[];

  /**
   * Full data provenance — production lineage, source conflicts, key-input audit.
   * Use this to verify every value in the report before trusting any calculation.
   */
  data_provenance: DataProvenanceReport | null;

  /**
   * Production audit trail — raw TRRC rows, identity resolution, classification.
   * Use this to diagnose divergence between MineralFlow output and run statements.
   */
  production_audit: ProductionAudit | null;

  /**
   * Offer gate — controls whether a final offer recommendation is unlocked.
   * Locked when any critical diligence field (production, ownership, LOE,
   * water/disposal, downtime/workover) is sourced only from model_estimate
   * or not_found. Must be resolved to Layer 2+ before offer is enabled.
   */
  offer_gate: OfferGate | null;

  /**
   * RRC Truth-Check Engine results (Developer Handoff, June 2026).
   *
   * Automated pass that compares every production and compliance claim in this
   * report against the underlying raw TRRC evidence. If verified public records
   * contradict the report, the gate blocks specific sections.
   *
   * gate.block_production_claims → current rate, trend, and BOPD figures are suppressed
   * gate.block_clean_compliance  → "no violations" badge is suppressed
   * gate.block_economics         → NPV, offer range, payout are suppressed
   * gate.block_offer             → offer recommendation is suppressed
   *
   * overall_verdict:
   *   "pass"  — all claims verified against raw evidence
   *   "warn"  — stale or unsupported claims (review before advancing)
   *   "block" — contradicted or failed claims (do not publish offer)
   */
  truth_check: import("./truth-check-engine").TruthCheckResult | null;

  /**
   * Cross-source contradictions detected by the contradiction engine.
   * Each entry represents a specific conflict between two evidence sources
   * (e.g. seller doc vs. TRRC wellbore query, seller production claim vs. TRRC rate).
   * Critical-severity contradictions automatically suppress economics and offer range.
   * Empty array means no contradictions detected — NOT the same as "none exist";
   * absence of evidence is not evidence of absence when sources are incomplete.
   */
  contradictions: import("./contradiction-engine").Contradiction[];

  /**
   * SEC-methodology reserve classification (Rule 4-10).
   *
   * Classifies producing reserves as PDP/PDNP/subeconomic and provides
   * P10/P50/P90 probabilistic estimates from DCA parameter variation.
   * Null when DCA could not be run (< 3 months of production data).
   *
   * IMPORTANT: This is an unaudited screening estimate. A licensed reserve
   * engineer (PE) certification is required for banking or SEC filings.
   */
  reserve_classification: import("./reserve-classification").ReserveClassification | null;

  /**
   * Peer benchmarking — offset well type curve and subject well percentile ranking.
   *
   * Finds offset wells within 5 miles, runs DCA on each, and builds P10/P50/P90
   * production type curves. Reports where the subject well sits in the peer EUR
   * and IP distributions.
   *
   * Null when subject well has no TRRC spatial location, no API number, or
   * when the query was not attempted (non-Texas, quick scan).
   */
  peer_benchmark: import("./peer-benchmarking").PeerBenchmarkResult | null;

  /** Debug / audit trail */
  _meta: {
    trrc_lookup_attempted: boolean;
    trrc_match_tier: MatchTier;
    trrc_compliance_attempted: boolean;
    trrc_injection_attempted: boolean;
    ai_extraction_model: string;
    processing_time_ms: number;
    eia_price_source?: string | null;
    eia_wti_usd?: number | null;
    edgar_operator?: string | null;
    edgar_loe_per_boe?: number | null;
    basin?: string | null;
    // Production intelligence summary
    production_confidence?: "VERIFIED" | "PARTIAL" | "INFERRED" | null;
    production_active_months?: number | null;
    production_downtime_pct?: number | null;
    production_stabilized_bbl?: number | null;
    production_restart_events?: number | null;
  };
};

// ─── Formation & Completion ───────────────────────────────────────────────────

export type PerforationInterval = {
  top_ft: number | null;
  bottom_ft: number | null;
  formation: string | null;
  /** "Producing" | "Plugged" | "Open" | "Squeezed" */
  status: string | null;
};

export type CasingSpec = {
  /** "Surface" | "Intermediate" | "Production" | "Liner" */
  type: string;
  size_inches: number | null;
  weight_lbs_ft: number | null;
  grade: string | null;
  depth_set_ft: number | null;
};

export type TubingSpec = {
  size_inches: number | null;
  depth_ft: number | null;
  material: string | null;
};

export type WellCompletionData = {
  api: string;
  well_name: string | null;
  formation_name: DataPoint<string>;
  total_depth_ft: DataPoint<number>;
  completion_type: DataPoint<"vertical" | "horizontal" | "deviated">;
  completion_date: DataPoint<string>;
  /** "Rod Pump" | "Gas Lift" | "ESP" | "Plunger" | "Flowing" | "Jet Pump" */
  artificial_lift_type: DataPoint<string>;
  producing_zone: DataPoint<string>;
  injection_zone: DataPoint<string>;
  perforations: PerforationInterval[];
  casing: CasingSpec[];
  tubing: TubingSpec[];
  notes: string[];
};

export type FormationCompletionSection = {
  wells: WellCompletionData[];
  primary_formation: DataPoint<string>;
  /** e.g. "6,200 – 6,450 ft" */
  depth_range: string | null;
  lift_types_present: string[];
  notes: string[];
};

// ─── Operator Profile ─────────────────────────────────────────────────────────

export type OperatorProfileSection = {
  name: DataPoint<string>;
  compliance_status: DataPoint<"clean" | "minor_history" | "open_violations" | "unknown">;
  open_violations: DataPoint<number>;
  total_violations: DataPoint<number>;
  bond_status: DataPoint<"confirmed" | "not_confirmed">;
  bond_amount_usd: DataPoint<number>;
  public_company: DataPoint<boolean>;
  edgar_company_name: DataPoint<string>;
  edgar_loe_per_boe: DataPoint<number>;
  /** Qualitative 1–2 sentence assessment */
  assessment: string;
  notes: string[];
};

// ─── Executive Summary ────────────────────────────────────────────────────────

export type ExecutiveSummarySection = {
  /** One-line property description */
  asset_description: string;
  /** TRRC match quality */
  identity_confidence: DataConfidence;
  match_tier: MatchTier;
  // Production snapshot
  current_gross_rate_bbl: DataPoint<number>;
  twelve_month_avg_bbl: DataPoint<number>;
  production_trend: DataPoint<"increasing" | "flat" | "declining" | "offline">;
  downtime_pct: number | null;
  // Economics snapshot
  monthly_net_income_usd: DataPoint<number>;
  npv10_usd: DataPoint<number>;
  offer_range_low: DataPoint<number>;
  offer_range_high: DataPoint<number>;
  breakeven_oil_price: DataPoint<number>;
  // Risk
  overall_risk_score: DataPoint<number>;
  recommendation: DataPoint<"pursue" | "review" | "pass">;
  recommendation_rationale: string;
  top_risks: string[];
  value_drivers: string[];
  // Diligence status
  data_completeness_score: number;   // 0–100
  critical_missing_count: number;
  important_missing_count: number;
  // Audit
  processing_time_ms: number;
  sources_used: string[];
};

// ─── Downtime Analysis ───────────────────────────────────────────────────────

export type { DowntimePeriod, DowntimePeriodClassification } from "./downtime-engine";

export type DowntimeSection = {
  total_zero_months: DataPoint<number>;
  total_months_analyzed: number;
  downtime_pct: DataPoint<number>;
  /** Each consecutive run of zero-production months */
  periods: import("./downtime-engine").DowntimePeriod[];
  /** Median of non-zero months — removes outlier spikes */
  normalized_rate_bbl: DataPoint<number>;
  /** 0–10 score based on coefficient of variation */
  volatility_score: DataPoint<number>;
  longest_downtime_months: DataPoint<number>;
  current_offline: DataPoint<boolean>;
  production_consistency: DataPoint<"consistent" | "intermittent" | "erratic">;
  underwriting_notes: string[];
};

// ─── Buyer Q&A ────────────────────────────────────────────────────────────────

export type { BuyerQAConfidence, BuyerQA } from "./buyer-qa-engine";

export type BuyerQASection = {
  items: import("./buyer-qa-engine").BuyerQA[];
};

// ─── Imaged Records ──────────────────────────────────────────────────────────
//
// Layer 2 evidence: TRRC filed documents (W-1, W-2, G-1, P-4, W-10).
// Having these links upgrades key fields from "model_estimate" to "trrc_imaged"
// evidence, which can unlock the Offer Gate.

export type ImagedRecord = {
  api10: string;
  doc_type: string;      // "W-1" | "W-2" | "G-1" | "P-4" | "W-10" | "OG-2" | "OTHER"
  doc_label: string;     // e.g. "Completion Report (Oil / W-2)"
  filing_date: string | null;
  operator: string | null;
  viewer_url: string;    // Neubus viewer link for the API (direct browser link)
  doc_id: string | null; // CMPL tracking number / packet ID
  lease_no: string | null;
  lease_name: string | null;
  status: string | null; // CMPL packet status (Approved, Pending, etc.)
};

export type ImagedRecordsSection = {
  /** Whether TRRC document query completed successfully */
  query_succeeded: boolean;
  /** All filed documents found, sorted most-recent-first */
  records: ImagedRecord[];
  /** W-2 or G-1 (completion report) found in CMPL */
  has_completion_report: boolean;
  /** P-4 (plugging record) found — always false from CMPL (plugging not in this system) */
  has_plugging_record: boolean;
  /** Direct link to most recent completion record, or Neubus viewer URL */
  latest_completion_url: string | null;
  /** Direct link to most recent P-4, if found */
  latest_plugging_url: string | null;
  /**
   * Direct Neubus viewer URL for all historical imaged records for this set of APIs.
   * Always populated. User can open this to see pre-2009 scanned records.
   */
  neubus_viewer_url: string | null;
  /** Diligence status tier for this module */
  diligence_tier: DiligenceStatusTier;
};

// ─── Proration Section ───────────────────────────────────────────────────────

/**
 * TRRC EWA proration factor record for one well.
 * Populated by oilProQueryAction.do / gasProQueryAction.do.
 */
export type ProrationRecord = {
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  field_no: string | null;
  field_name: string | null;
  field_type: string | null;
  operator_no: string | null;
  operator_name: string | null;
  unit_no: string | null;
  /** Daily potential in BBL (oil) or MCF (gas). 0 for injection/observation wells. */
  potential: number | null;
  /** Gas/Oil Ratio */
  gor: number | null;
  acres: number | null;
  /**
   * Daily allowable as returned by TRRC.
   * e.g. "14(B)(2) EXT 00/00" (extension type) or numeric "1234"
   */
  daily_allowable: string | null;
  /** PRODUCER | INJECTION | OBSERVATION | UNIT PRODUCER | etc. */
  well_type: string | null;
  commodity: "oil" | "gas";
};

export type ProrationSection = {
  records: ProrationRecord[];
  /** True if the query ran and returned at least one record */
  query_succeeded: boolean;
  /** True if any record has a non-zero daily_allowable (numeric) */
  has_allowable: boolean;
  notes: string[];
};

// ─── P-5 Operator Status Section ─────────────────────────────────────────────

/**
 * TRRC P-5 operator organization record.
 * Populated by organizationQueryAction.do.
 */
export type P5OperatorStatus = {
  operator_no: string;
  operator_name: string;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  /**
   * Active          = current, compliant
   * Active-Ext      = active on extension (conditional — renewal pending)
   * Delinquent      = P-5 renewal overdue; may have permit restrictions
   * Inactive        = no active operations
   * Cancelled       = organization cancelled
   */
  org_status: string;
  org_type: string | null;
  /**
   * Texas Natural Resources Code §91.114 flag.
   * true = unsatisfied final orders exist → TRRC will not issue new permits.
   */
  tnr_91114: boolean;
  mail_hold: boolean;
  phone: string | null;
  /** "green" | "yellow" | "red" risk flag derived from status + flags */
  risk_flag: "green" | "yellow" | "red";
};

// ─── Offset / Nearby Wells (OFFSET / NEARBY ACTIVITY) ────────────────────────
//
// ⚠ ARCHITECTURE RULE: These wells are NEVER used as subject-asset production.
//   They are always labeled "OFFSET / NEARBY ACTIVITY" in the UI.
//   Sourced from TRRC EWA field-level proration query (same field number as subject).

export type OffsetWellRecord = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  operator_no: string | null;
  operator_name: string | null;
  field_no: string;
  field_name: string | null;
  field_type: string | null;
  unit_no: string | null;
  potential_bbl: number | null;
  gor: number | null;
  acres: number | null;
  daily_allowable: string | null;
  /** PRODUCER | INJECTION | SHUT IN | OBSERVATION | etc. */
  well_type: string | null;
  /** True if this is the subject well (same API as the query) */
  is_subject_asset: boolean;
};

export type OffsetWellsSection = {
  /**
   * ⚠ OFFSET / NEARBY ACTIVITY — not subject-asset production.
   * Sourced from TRRC EWA field-level proration query.
   */
  wells: OffsetWellRecord[];
  field_no: string | null;
  field_name: string | null;
  total_count: number;
  /** True if ≥100 wells were returned (page may be truncated) */
  truncated: boolean;
  query_succeeded: boolean;
  notes: string[];
};

// ─── Scan mode ───────────────────────────────────────────────────────────────

/**
 * "quick" — fast triage scan (3–10 s). Preliminary confidence only.
 * "full"  — complete async underwriting pipeline (1–5 min). Full confidence.
 */
export type ScanMode = "quick" | "full";

// ─── Full-underwriting pipeline progress (SSE stream) ────────────────────────

export type PipelineStepId =
  | "normalize"           // 1  Parse / validate all inputs
  | "resolve_asset"       // 2  RRC wellbore query → resolve lease + district
  | "pull_production"     // 3  Fetch lease-level production history
  | "pull_inspections"    // 4  ICE inspection records + violation database + injection
  | "pull_completions"    // 5  W-1 drilling permit + CMPL W-2 packet lookup
  | "parse_documents"     // 6  AI OCR extraction of uploaded documents
  | "build_decline"       // 7  Decline-curve analysis (DCA)
  | "run_economics"       // 8  EIA prices + EDGAR + acquisition economics
  | "check_diligence"     // 9  Missing-item tracker + risk scoring
  | "peer_benchmarking"   // 9b Offset well type curve + subject percentile ranking
  | "generate_report";    // 10 Final IC memo + report assembly

export type PipelineStepStatus =
  | "pending"    // Not yet started
  | "running"    // In progress
  | "complete"   // Finished successfully (possibly with fallback data)
  | "failed"     // Step failed; pipeline continues with what was gathered
  | "skipped";   // Not applicable (e.g. no API numbers → skip completions lookup)

export type PipelineProgressEvent = {
  type: "progress";
  step: PipelineStepId;
  status: PipelineStepStatus;
  label: string;
  /** Short explanation of what happened / what was found */
  detail?: string;
  /** True when partial / fallback data was used instead of full data */
  usedFallback?: boolean;
  /** Human-readable reason for fallback (e.g. "TRRC timeout — using doc-extracted values") */
  fallbackReason?: string;
  /** Error message when status === "failed" */
  error?: string;
  /** Wall-clock duration for this step */
  durationMs?: number;
};

export type PipelineReportEvent = {
  type: "report";
  report: DDReport;
};

export type PipelineErrorEvent = {
  type: "error";
  message: string;
};

export type PipelineDoneEvent = {
  type: "done";
  totalDurationMs: number;
};

export type PipelineEvent =
  | PipelineProgressEvent
  | PipelineReportEvent
  | PipelineErrorEvent
  | PipelineDoneEvent;

// ─── API request / response ───────────────────────────────────────────────────

export type UnderwritingInput = {
  /** Well identifiers — used for TRRC matching hierarchy */
  api_numbers?: string[];
  rrc_lease_numbers?: string[];
  operator_name?: string;
  lease_name?: string;
  county?: string;
  state?: string;
  /** Interest overrides — if provided, supersede any division-order extraction */
  nri_decimal?: number;   // e.g. 0.75 for 75% NRI
  wi_decimal?: number;    // e.g. 1.0 for 100% WI
  /** Document texts to extract from (OCR'd or native) */
  documents?: {
    filename: string;
    text: string;
    doc_type?: string;  // user hint
  }[];
  /**
   * Run mode.
   * "quick" — fast triage, limited data, preliminary confidence (default for /api/underwriting).
   * "full"  — complete pipeline, all sources, SSE streaming (/api/underwriting/stream).
   */
  mode?: ScanMode;
};

export type UnderwritingResponse = {
  ok: boolean;
  report?: DDReport;
  error?: string;
};
