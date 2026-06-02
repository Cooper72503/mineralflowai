/**
 * Acreage Valuation & Offset Intelligence Engine — Type System
 *
 * Used by the Legal-Description Valuation Pipeline.
 * Separate from the well-production underwriting pipeline (types.ts).
 */

export type ProvenanceLabel = "VERIFIED" | "PUBLIC_RECORD" | "INFERRED" | "ESTIMATED";

// ─── Input ────────────────────────────────────────────────────────────────────

export type AcreageInput = {
  legal_description: string;
  county?:           string | null;
  state?:            string | null;
  acreage?:          number | null;
  nri?:              number | null;   // e.g. 0.125 = 12.5% NRI
  operator_hint?:    string | null;
  formation_hint?:   string | null;
  ask_price_usd?:    number | null;
};

// ─── Geocoding ────────────────────────────────────────────────────────────────

export type AcreageLocation = {
  lat:        number;
  lng:        number;
  source:     "otls_polygon" | "plss_blm" | "plss_estimated" | "county_centroid";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  description: string;
};

// ─── Formation profile ────────────────────────────────────────────────────────

export type FormationProfile = {
  primary_formation:          string;
  secondary_formations:       string[];
  basin:                      string;
  play_type:                  "unconventional_oil" | "unconventional_gas" | "conventional_oil" | "conventional_gas" | "mixed";
  avg_lateral_length_ft:      number | null;
  benchmark_p50_eur_bbl:      number | null;   // BBL per well, P50
  benchmark_p90_eur_bbl:      number | null;   // downside
  benchmark_p10_eur_bbl:      number | null;   // upside
  benchmark_peak_month_bbl:   number | null;   // peak oil rate per well
  benchmark_spacing_acres:    number | null;   // typical well spacing
  source:                     ProvenanceLabel;
  commentary:                 string;          // 1–2 sentences on the play
};

// ─── Offset wells ─────────────────────────────────────────────────────────────

export type OffsetWellProfile = {
  api:            string;
  operator:       string;
  distance_mi:    number;
  direction:      string;   // "N", "NE", "E", "SE", "S", "SW", "W", "NW"
  lat:            number;
  lng:            number;
  monthly_history: { year: number; month: number; oil_bbl: number }[];
  cum_oil_bbl:         number;
  peak_month_bbl:      number;
  last_12mo_avg_bbl:   number | null;
  eur_bbl:             number | null;     // from Arps DCA
  decline_type:        "exponential" | "hyperbolic" | "harmonic" | null;
  decline_annual_pct:  number | null;
  months_of_data:      number;
  proximity_zone:      "SAME_SECTION" | "1_MILE" | "3_MILE" | "5_MILE" | "BEYOND";
  is_active:           boolean;
  first_prod_year:     number | null;
  last_prod_year:      number | null;
  recency_weight:      number;           // 0–1, higher = more recent / relevant
};

// ─── Type curve ───────────────────────────────────────────────────────────────

export type TypeCurveResult = {
  well_count:             number;
  p10_eur_bbl:            number;   // 90th pctl production (upside)
  p50_eur_bbl:            number;   // median
  p90_eur_bbl:            number;   // 10th pctl production (downside)
  p10_peak_bbl:           number;
  p50_peak_bbl:           number;
  p90_peak_bbl:           number;
  avg_decline_annual_pct: number | null;
  confidence:             "HIGH" | "MEDIUM" | "LOW";
  wells_used:             string[];     // API numbers
  recency_score:          number;       // 0–1
  data_quality_note:      string | null;
};

// ─── Operator intelligence ────────────────────────────────────────────────────

export type OperatorProfile = {
  name:                string;
  well_count:          number;
  avg_eur_bbl:         number | null;
  avg_peak_bbl:        number | null;
  pct_active:          number;           // 0–100
  quality_tier:        "TIER1" | "TIER2" | "TIER3";
  tier_rationale:      string;
  most_recent_well_yr: number | null;
};

// ─── Drilling momentum ────────────────────────────────────────────────────────

export type DrillingMomentum = {
  wells_spud_last_3yr:  number;
  wells_spud_last_5yr:  number;
  pct_wells_post_2020:  number;
  trend:                "ACCELERATING" | "STABLE" | "DECLINING" | "INACTIVE";
  score:                number;   // 0–100
  dominant_operator:    string | null;
  interpretation:       string;   // plain-English sentence
};

// ─── Valuation ────────────────────────────────────────────────────────────────

export type AcreageValuation = {
  // Development probability
  drill_probability_pct:      number | null;
  development_timing_label:   string | null;

  // Undeveloped well count estimate
  potential_well_count_p50:   number | null;
  spacing_assumption_acres:   number | null;

  // Expected production per royalty owner (NRI-adjusted)
  expected_royalty_boe_p10:   number | null;   // BBL/month NRI share
  expected_royalty_boe_p50:   number | null;
  expected_royalty_boe_p90:   number | null;

  // PV10 (probability-weighted by drill likelihood)
  pv10_low:   number | null;
  pv10_mid:   number | null;
  pv10_high:  number | null;

  // Per-acre value ($/NMA)
  value_per_nma_low:  number | null;
  value_per_nma_mid:  number | null;
  value_per_nma_high: number | null;

  // Total value range
  total_value_low:  number | null;
  total_value_mid:  number | null;
  total_value_high: number | null;

  // Quality & confidence
  acreage_quality_score: number;   // 0–100
  confidence_score:      number;   // 0–100

  recommendation:          "PURSUE" | "REVIEW" | "PASS";
  recommendation_rationale: string;

  // Assumptions used
  oil_price_deck:   number;   // $/BBL
  nri_used:         number;   // fraction
  discount_rate:    number;   // e.g. 0.10
};

// ─── Full report ──────────────────────────────────────────────────────────────

export type AcreageValuationReport = {
  report_id:     string;
  generated_at:  string;

  input: AcreageInput;

  parsed: {
    abstract_number: string | null;
    survey_name:     string | null;
    block:           string | null;
    section:         string | null;
    plss_township:   string | null;
    plss_range:      string | null;
    county:          string | null;
    state:           string | null;
    acreage:         number | null;
    nri:             number | null;
    format_detected: "TX_ABSTRACT" | "TX_BLOCK_SURVEY" | "PLSS" | "MIXED" | "UNKNOWN";
    parse_confidence: "HIGH" | "MEDIUM" | "LOW";
  };

  location:   AcreageLocation | null;
  formation:  FormationProfile | null;

  offset_wells:      OffsetWellProfile[];
  type_curve:        TypeCurveResult | null;
  operators:         OperatorProfile[];
  drilling_momentum: DrillingMomentum;

  nearby_activity_summary: string;
  investment_narrative:    string[];   // IC memo paragraphs

  valuation: AcreageValuation;

  flags: {
    severity:   "critical" | "warning" | "info";
    category:   "data" | "geology" | "activity" | "legal" | "economics";
    message:    string;
    provenance: ProvenanceLabel;
  }[];

  provenance: {
    field:  string;
    value:  string;
    label:  ProvenanceLabel;
    source: string;
  }[];

  _meta: {
    processing_time_ms:     number;
    geocoding_source:       string;
    offset_well_count:      number;
    wells_with_production:  number;
    formation_source:       string;
    trrc_lookup_attempted:  boolean;
    plss_lookup_attempted:  boolean;
  };
};
