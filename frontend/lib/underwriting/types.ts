/**
 * Operator Due Diligence Brain — Type definitions.
 *
 * Every field is wrapped in DataPoint<T> which carries:
 *   value     — the actual value (null when absent)
 *   source    — where it came from
 *   confidence — how sure we are
 *   note      — "Needs operator confirmation", "Not provided", "Nearby/offset only", etc.
 */

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
  source_detail?: string;   // e.g. "LOE Statement Mar-2024" or "TRRC Lease 12345/06"
  confidence: DataConfidence;
  note?: string;            // human-readable caveat, e.g. "Needs operator confirmation"
};

// ─── Subject identity & matching ─────────────────────────────────────────────

export type MatchTier =
  | "exact_api"           // matched on exact 10-digit API number
  | "exact_rrc_lease"     // matched on exact RRC distCode:leaseNo
  | "operator_lease_county" // operator + lease name + county
  | "well_name_county"    // well name + county (weakest exact match)
  | "no_match";           // could not match — county-level data NOT used as subject

export type SubjectIdentity = {
  api_numbers: string[];          // 10-digit UWI format (42-XXX-XXXXX-XX-XX)
  rrc_lease_number?: string | null; // dist_code:lease_no e.g. "06:12345"
  operator_name?: string | null;
  lease_name?: string | null;
  county?: string | null;
  state?: string | null;
  match_tier: MatchTier;
  match_confidence: DataConfidence;
};

// ─── Production ──────────────────────────────────────────────────────────────

export type WellProductionRow = {
  api: string;
  well_name: string;
  lease_number: string | null;
  district_code: string | null;
  operator: string | null;
  latest_monthly_oil_bbl: DataPoint<number>;
  latest_monthly_gas_mcf: DataPoint<number>;
  latest_monthly_water_bbl: DataPoint<number>;
  latest_production_month: string | null;
  water_cut_pct: DataPoint<number>;
  six_month_avg_bbl: DataPoint<number>;
  twelve_month_avg_bbl: DataPoint<number>;
  production_trend: DataPoint<"increasing" | "flat" | "declining" | "offline">;
  cum_oil_bbl: DataPoint<number>;
  formation: string | null;
  perforation_depth_ft: DataPoint<number>;
};

export type ProductionSection = {
  wells: WellProductionRow[];
  total_monthly_oil_bbl: DataPoint<number>;
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

export type ComplianceSection = {
  violations: ComplianceViolation[];
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
  peak_rate_bbl: DataPoint<number>;
  cum_oil_bbl: DataPoint<number>;
  // Monthly projections: month 1–60 from current
  projections: { month: number; rate_bbl: number }[];
  notes: string[];
};

// ─── Acquisition Economics ────────────────────────────────────────────────────

export type EconomicsScenario = {
  deck_label: string;
  oil_price_usd: number;
  gas_price_usd: number;
  monthly_gross_revenue: number;
  monthly_net_revenue: number;
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

// ─── Full DD Report ───────────────────────────────────────────────────────────

export type DDReportConfidence = "high" | "medium" | "low" | "very_low";

export type DDReport = {
  report_id: string;
  generated_at: string;  // ISO timestamp
  overall_confidence: DDReportConfidence;
  overall_confidence_note: string;

  subject: SubjectIdentity;

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
  missing_items: MissingItem[];
  next_questions: NextQuestion[];

  /** Documents provided as input */
  input_documents: {
    filename: string;
    doc_type: string;
    char_count: number;
  }[];

  /** Debug / audit trail */
  _meta: {
    trrc_lookup_attempted: boolean;
    trrc_match_tier: MatchTier;
    trrc_compliance_attempted: boolean;
    trrc_injection_attempted: boolean;
    ai_extraction_model: string;
    processing_time_ms: number;
  };
};

// ─── API request / response ───────────────────────────────────────────────────

export type UnderwritingInput = {
  /** Well identifiers — used for TRRC matching hierarchy */
  api_numbers?: string[];
  rrc_lease_numbers?: string[];
  operator_name?: string;
  lease_name?: string;
  county?: string;
  state?: string;
  /** Document texts to extract from (OCR'd or native) */
  documents?: {
    filename: string;
    text: string;
    doc_type?: string;  // user hint
  }[];
};

export type UnderwritingResponse = {
  ok: boolean;
  report?: DDReport;
  error?: string;
};
