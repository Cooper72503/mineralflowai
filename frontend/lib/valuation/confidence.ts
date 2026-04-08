import type { DealValuationInput } from "./types";
import type { DealValuationDealType } from "./types";
import type { ValuationConfidenceReasoning } from "./types";
import { logValuationDev } from "./normalize";

/** Max ~100 — strong commercial + location + tract signals. */
const W = {
  county_direct: 17,
  county_inferred: 9,
  state_direct: 4,
  state_inferred: 2,
  acreage: 16,
  royalty: 12,
  ownership: 8,
  /** Single block: annual revenue (strongest), then BOPD, then monthly. */
  annual_revenue: 22,
  bopd: 17,
  monthly_revenue: 14,
  location_ctx_high: 10,
  location_ctx_medium: 6,
  location_ctx_low: 3,
  /** Section/block/survey/abstract from legal parse — supports legal-only workflows. */
  legal_structure: 5,
  drill_known: 5,
  drill_partial: 2,
  basin: 2,
  operator: 2,
  financial_summary_high: 3,
} as const;

const INFERRED_MULT = 0.55;

function scaledCountyWeight(source: DealValuationInput["county_source"]): number {
  if (source === "extracted") return W.county_direct;
  if (source === "inferred") return W.county_inferred;
  return 0;
}

function scaledStateWeight(source: DealValuationInput["state_source"]): number {
  if (source === "extracted") return W.state_direct;
  if (source === "inferred") return W.state_inferred;
  return 0;
}

function hasStructuredLegal(lp: DealValuationInput["legal_description_parsed"]): boolean {
  if (!lp) return false;
  return Boolean(
    lp.section ||
      lp.block ||
      lp.survey_name ||
      lp.abstract_number ||
      (lp.plss_township && lp.plss_range)
  );
}

function hasProductionEconomics(input: DealValuationInput): boolean {
  const rev =
    (input.annual_revenue != null && input.annual_revenue > 0) ||
    (input.monthly_revenue != null && input.monthly_revenue > 0);
  const prod = input.bopd != null && input.bopd > 0;
  return rev || prod;
}

function econWeight(input: DealValuationInput): { pts: number; label: string | null } {
  if (input.annual_revenue != null && input.annual_revenue > 0) {
    return { pts: W.annual_revenue, label: "Annual revenue (document-derived band)" };
  }
  if (input.bopd != null && input.bopd > 0) {
    return { pts: W.bopd, label: `Oil production (~${input.bopd} BOPD indication)` };
  }
  if (input.monthly_revenue != null && input.monthly_revenue > 0) {
    return { pts: W.monthly_revenue, label: "Monthly revenue (document-derived band)" };
  }
  return { pts: 0, label: null };
}

function locationContextWeight(
  input: DealValuationInput
): { pts: number; label: string | null } {
  const lc = input.location_context;
  if (!lc) return { pts: 0, label: null };
  if (lc.confidence === "High") return { pts: W.location_ctx_high, label: "Location context (high)" };
  if (lc.confidence === "Medium") return { pts: W.location_ctx_medium, label: "Location context (medium)" };
  return { pts: W.location_ctx_low, label: "Location context (low)" };
}

function drillWeight(input: DealValuationInput): { pts: number; label: string | null } {
  const d = input.drill_difficulty;
  if (!d) return { pts: 0, label: null };
  const diff = d.drill_difficulty?.trim();
  const known = diff && diff !== "Unknown";
  if (known) {
    return {
      pts: W.drill_known,
      label: `Drill / geology context (${diff})`,
    };
  }
  if (d.estimated_formation && d.estimated_formation !== "Unknown") {
    return { pts: W.drill_partial, label: `Formation hint (${d.estimated_formation})` };
  }
  return { pts: 0, label: null };
}

/** True when tract placement is anchored without a county name (legal + state + assistive context). */
function hasWeakLocationAnchor(input: DealValuationInput): boolean {
  if (input.county?.trim()) return true;
  const st = input.state?.trim();
  if (!st) return false;
  return hasStructuredLegal(input.legal_description_parsed);
}

export type ValuationConfidenceComputation = {
  tier: "low" | "medium" | "high";
  weighted_score: number;
  reasoning: ValuationConfidenceReasoning;
  critical_gap_count: number;
};

function countCriticalGaps(input: DealValuationInput, dealType: DealValuationDealType): number {
  let n = 0;
  const hasCounty = Boolean(input.county?.trim());
  if (!hasCounty && !hasWeakLocationAnchor(input)) n++;
  if (input.acreage == null || input.acreage <= 0) n++;
  if (input.royalty_rate == null || input.royalty_rate <= 0) n++;
  if (input.ownership_percent == null) n++;

  const econMatters =
    dealType === "producing" || dealType === "mixed" || dealType === "infrastructure";
  if (econMatters && !hasProductionEconomics(input)) n++;

  return n;
}

/**
 * Weighted signal score — not a simple field count; inferred fields use partial weights via sources and INFERRED_MULT where applicable.
 */
export function computeValuationConfidence(
  input: DealValuationInput,
  dealType: DealValuationDealType
): ValuationConfidenceComputation {
  const present: string[] = [];
  const missing: string[] = [];
  let score = 0;

  const countyPts = scaledCountyWeight(input.county_source);
  if (countyPts > 0 && input.county?.trim()) {
    const src = input.county_source === "inferred" ? "inferred" : "extracted";
    score += countyPts;
    present.push(`County (${src}): ${input.county.trim()}`);
  } else {
    missing.push("County (no extracted or inferred match)");
  }

  const statePts = scaledStateWeight(input.state_source);
  if (statePts > 0 && input.state?.trim()) {
    const src = input.state_source === "inferred" ? "inferred" : "extracted";
    score += statePts;
    present.push(`State (${src}): ${input.state.trim()}`);
  } else {
    missing.push("State");
  }

  if (input.acreage != null && input.acreage > 0) {
    score += W.acreage;
    present.push(`Acreage: ${input.acreage} acres`);
  } else {
    missing.push("Acreage");
  }

  if (input.royalty_rate != null && input.royalty_rate > 0) {
    score += W.royalty;
    present.push(`Royalty: ${(input.royalty_rate * 100).toFixed(1)}% (decimal)`);
  } else {
    missing.push("Royalty");
  }

  if (input.ownership_percent != null) {
    score += W.ownership;
    present.push(`Ownership: ${(input.ownership_percent * 100).toFixed(1)}% (decimal)`);
  } else {
    missing.push("Ownership (NRI / interest %)");
  }

  const econ = econWeight(input);
  if (econ.pts > 0 && econ.label) {
    let pts = econ.pts;
    const fin = input.financial_summary;
    if (fin?.has_financials && fin.confidence === "High") {
      pts += W.financial_summary_high;
      present.push("Financial summary (high confidence) supports revenue band");
    }
    score += pts;
    present.push(econ.label);
  } else {
    const econMatters =
      dealType === "producing" || dealType === "mixed" || dealType === "infrastructure";
    if (econMatters) {
      missing.push("Production or revenue indication");
    }
  }

  const loc = locationContextWeight(input);
  if (loc.pts > 0 && loc.label) {
    let pts = loc.pts;
    if (input.county_source === "inferred") pts = Math.round(pts * INFERRED_MULT);
    score += pts;
    present.push(loc.label + (input.county_source === "inferred" ? " — discounted (county inferred)" : ""));
  } else {
    missing.push("Location context (assistive)");
  }

  const lp = input.legal_description_parsed;
  if (hasStructuredLegal(lp)) {
    score += W.legal_structure;
    const bits: string[] = [];
    if (lp?.plss_township) bits.push(`township ${lp.plss_township}`);
    if (lp?.plss_range) bits.push(`range ${lp.plss_range}`);
    if (lp?.abstract_number) bits.push(`abstract ${lp.abstract_number}`);
    if (lp?.survey_name) bits.push(lp.survey_name);
    if (lp?.block) bits.push(`block ${lp.block}`);
    if (lp?.section) bits.push(`section ${lp.section}`);
    present.push(`Legal structure (parsed): ${bits.join(", ")}`);
  } else {
    missing.push("Structured legal cues (section / block / survey / abstract / PLSS)");
  }

  const drill = drillWeight(input);
  if (drill.pts > 0 && drill.label) {
    score += drill.pts;
    present.push(drill.label);
  } else {
    missing.push("Drill difficulty / geology (county-level)");
  }

  if (input.basin?.trim()) {
    score += W.basin;
    present.push(`Basin: ${input.basin.trim()}`);
  }

  if (input.operator?.trim()) {
    score += W.operator;
    present.push(`Operator: ${input.operator.trim()}`);
  }

  const critical_gap_count = countCriticalGaps(input, dealType);

  const hasStrongEcon = econ.pts >= W.bopd;
  const hasDirectCounty = input.county_source === "extracted" && Boolean(input.county?.trim());
  const strongCommercial = hasStrongEcon || (hasDirectCounty && (input.annual_revenue ?? 0) > 0);
  const tractCompleteDirect =
    hasDirectCounty &&
    input.acreage != null &&
    input.acreage > 0 &&
    input.royalty_rate != null &&
    input.royalty_rate > 0 &&
    input.ownership_percent != null;
  const undevelopedStyle =
    dealType === "undeveloped" || dealType === "lease" || dealType === "unknown";

  let tier: "low" | "medium" | "high" = "low";

  // Thresholds: conservative. "High" needs strong commercial OR a complete direct tract picture (undeveloped/lease).
  if (
    score >= 56 &&
    critical_gap_count <= 1 &&
    (strongCommercial ||
      (hasDirectCounty && hasProductionEconomics(input)) ||
      (tractCompleteDirect && undevelopedStyle && score >= 58))
  ) {
    tier = "high";
  } else if (
    score >= 30 &&
    critical_gap_count <= 2 &&
    (strongCommercial || hasDirectCounty || (hasWeakLocationAnchor(input) && score >= 36))
  ) {
    tier = "medium";
  } else if (score >= 22 || (hasWeakLocationAnchor(input) && score >= 18)) {
    tier = "medium";
  } else {
    tier = "low";
  }

  // Sparse / weak: pull down only when the score is very thin (location-inferred bundles may sit in the high-teens).
  if (score < 15 && tier !== "low") tier = "low";
  if (critical_gap_count >= 4) tier = tier === "high" ? "medium" : "low";
  if (critical_gap_count >= 5) tier = "low";

  // Inferred-only location without economics caps high
  if (tier === "high" && !hasDirectCounty && !hasStrongEcon) tier = "medium";

  if (dealType === "unknown" || dealType === "infrastructure") {
    tier = tier === "high" ? "medium" : tier;
  }

  let summary: string;
  if (tier === "high") {
    summary =
      "High confidence for screening: multiple strong signals (location and/or economics) with at most one critical gap. Treat as directional only.";
  } else if (tier === "medium") {
    summary =
      "Medium confidence: several signals or solid inferred location/legal context, but material gaps remain—validate before relying on the dollar band.";
  } else {
    summary =
      "Low confidence: sparse inputs, weak location anchor, or many critical gaps—use manual diligence; the range is illustrative.";
  }

  const reasoning: ValuationConfidenceReasoning = {
    summary,
    present_signals: present,
    missing_signals: missing,
  };

  logValuationDev("confidence_path", {
    weighted_score: score,
    tier,
    deal_type: dealType,
    critical_gap_count,
    county_source: input.county_source,
  });

  return { tier, weighted_score: score, reasoning, critical_gap_count };
}

/** @deprecated Prefer {@link computeValuationConfidence}; retained for tests and call sites that only need a number. */
export function scoreInputCompleteness(input: DealValuationInput): number {
  return computeValuationConfidence(input, "unknown").weighted_score;
}

export function deriveValuationConfidence(
  input: DealValuationInput,
  dealType: DealValuationDealType
): "low" | "medium" | "high" {
  return computeValuationConfidence(input, dealType).tier;
}
