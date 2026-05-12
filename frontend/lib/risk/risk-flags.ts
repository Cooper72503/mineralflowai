/**
 * Automated Risk Flag Engine
 *
 * Identifies and surfaces specific underwriting risks from all available signals:
 * nearby well data, decline analysis, legal description, location context,
 * valuation inputs, and P&A liability.
 *
 * Each flag has:
 *  - category: what type of risk
 *  - severity: critical / high / medium / low
 *  - title: short label
 *  - description: specific, data-backed explanation
 *  - evidence: the raw data point that triggered the flag
 */

import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import type { DeclineCurveResult } from "@/lib/decline/decline-curve";
import type { PaLiabilityResult } from "./pa-liability";
import type { DealValuationInput } from "@/lib/valuation/types";
import type { DealValuationActivityLevel } from "@/lib/valuation/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RiskFlagCategory =
  | "production"        // Production quality / decline issues
  | "liability"         // P&A, environmental exposure
  | "ownership"         // Title, NRI uncertainty
  | "operator"          // Operator concentration, track record
  | "geology"           // Formation/basin risk
  | "infrastructure"    // Gathering, midstream access
  | "regulatory"        // State compliance, inactive well orders
  | "valuation"         // Pricing risk, comp uncertainty
  | "data_quality";     // Missing critical underwriting data

export type RiskFlagSeverity = "critical" | "high" | "medium" | "low";

export type RiskFlag = {
  id: string;
  category: RiskFlagCategory;
  severity: RiskFlagSeverity;
  title: string;
  description: string;
  /** The specific data point that triggered this flag. */
  evidence: string;
  /** Suggested due diligence action. */
  mitigation: string;
};

export type RiskFlagsResult = {
  flags: RiskFlag[];
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  overall_risk: "low" | "moderate" | "high" | "critical";
  summary: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isInactiveStatus(status: string | null): boolean {
  if (!status) return false;
  return /inactive|shut[- ]?in|temporary abandon|idle|ta\b|si\b/i.test(status.toLowerCase());
}

function isPluggedStatus(status: string | null): boolean {
  if (!status) return false;
  return /plug|abandon|p&a|pa\b/i.test(status.toLowerCase());
}

// ── Flag Detectors ─────────────────────────────────────────────────────────────

function flagSteepDecline(decline: DeclineCurveResult | null): RiskFlag | null {
  if (!decline?.annual_decline_rate) return null;
  if (decline.annual_decline_rate < 0.25) return null;

  const pct = `${(decline.annual_decline_rate * 100).toFixed(0)}%`;
  const severity: RiskFlagSeverity = decline.annual_decline_rate > 0.50 ? "high" : "medium";

  return {
    id: "steep_decline",
    category: "production",
    severity,
    title: "Steep Production Decline",
    description: `Nearby wells show a ${pct}/year exponential decline rate, which is ${decline.annual_decline_rate > 0.50 ? "above" : "near"} the industry threshold for aggressive decline.`,
    evidence: `Dᵢ = ${pct}/yr across ${decline.well_count} producing well${decline.well_count !== 1 ? "s" : ""}`,
    mitigation: "Request actual production run statements. Compare decline to type curves for this basin. Consider shortened payback window in offer pricing.",
  };
}

function flagInactiveWells(nearby: NearbyWellIntelligence | null): RiskFlag | null {
  if (!nearby || nearby.total_count === 0) return null;
  const inactive = nearby.wells.filter(w => isInactiveStatus(w.status)).length;
  if (inactive === 0) return null;
  const pct = Math.round((inactive / nearby.total_count) * 100);
  const severity: RiskFlagSeverity = pct >= 50 ? "high" : pct >= 25 ? "medium" : "low";

  return {
    id: "inactive_wells",
    category: "production",
    severity,
    title: "Inactive Wells Detected",
    description: `${inactive} of ${nearby.total_count} nearby wells (${pct}%) are inactive or shut-in, indicating reduced current activity in the area.`,
    evidence: `${inactive} wells with inactive/shut-in status`,
    mitigation: "Verify whether inactivity is temporary (mechanical issues) or permanent (economic shut-in). Check state records for compliance filings.",
  };
}

function flagPluggedWells(nearby: NearbyWellIntelligence | null): RiskFlag | null {
  if (!nearby || nearby.total_count === 0) return null;
  const plugged = nearby.wells.filter(w => isPluggedStatus(w.status)).length;
  if (plugged === 0) return null;
  const pct = Math.round((plugged / nearby.total_count) * 100);
  const severity: RiskFlagSeverity = pct >= 40 ? "high" : "medium";

  return {
    id: "plugged_wells",
    category: "liability",
    severity,
    title: "Plugged/Abandoned Wells in Area",
    description: `${plugged} plugged or abandoned well${plugged !== 1 ? "s" : ""} detected nearby (${pct}% of total). P&A liability may indicate a maturing field with limited remaining upside.`,
    evidence: `${plugged} P&A wells within search radius`,
    mitigation: "Confirm wells are properly plugged per state regulations. Evaluate whether remaining producing wells are still economic.",
  };
}

function flagPaExposure(pa: PaLiabilityResult | null): RiskFlag | null {
  if (!pa || pa.severity === "unknown" || pa.severity === "low") return null;

  const severityMap: Record<string, RiskFlagSeverity> = {
    critical: "critical", high: "high", moderate: "medium",
  };
  const severity = severityMap[pa.severity] ?? "medium";

  return {
    id: "pa_exposure",
    category: "liability",
    severity,
    title: "Significant P&A Liability Exposure",
    description: pa.primary_driver ?? `${pa.at_risk_count} at-risk wells with estimated $${((pa.total_liability_low ?? 0) / 1000).toFixed(0)}k–$${((pa.total_liability_high ?? 0) / 1000).toFixed(0)}k plugging cost exposure.`,
    evidence: `${pa.at_risk_count} inactive/at-risk wells, est. $${((pa.total_liability_low ?? 0) / 1000).toFixed(0)}k–$${((pa.total_liability_high ?? 0) / 1000).toFixed(0)}k P&A cost`,
    mitigation: "Verify well status through state regulatory database. Obtain plugging bond information from current operator. Factor P&A costs into bid pricing.",
  };
}

function flagNoNearbyWells(nearby: NearbyWellIntelligence | null): RiskFlag | null {
  if (!nearby || nearby.total_count > 0) return null;
  if (nearby.unavailable_note) return null; // data unavailable ≠ no wells

  return {
    id: "no_nearby_activity",
    category: "geology",
    severity: "medium",
    title: "No Nearby Well Activity Detected",
    description: `No wells found within the ${nearby.radius_miles}-mile search radius. Production potential is speculative without analog well data.${
      nearby.nearest_outside_miles != null
        ? ` Nearest detected activity: ${nearby.nearest_outside_miles} miles.`
        : ""
    }`,
    evidence: `0 wells in ${nearby.radius_miles}-mile radius`,
    mitigation: "Expand well search to 10+ mile radius. Review state geological maps for formation presence. Consider upside-only pricing.",
  };
}

function flagSingleWellDependency(nearby: NearbyWellIntelligence | null): RiskFlag | null {
  if (!nearby || nearby.producing_count !== 1) return null;

  return {
    id: "single_well_dependency",
    category: "production",
    severity: "medium",
    title: "Single Producing Well — Concentration Risk",
    description: "Only 1 producing well detected in the search area. Production is entirely dependent on a single wellbore — mechanical failure or regulatory action could eliminate all income.",
    evidence: "1 producing well in radius",
    mitigation: "Assess mechanical condition of the well. Review operator's workover history. Apply concentration risk discount to offer price.",
  };
}

function flagMissingAcreage(input: DealValuationInput | null): RiskFlag | null {
  if (!input) return null;
  if (input.acreage != null && input.acreage > 0) return null;

  return {
    id: "missing_acreage",
    category: "data_quality",
    severity: "high",
    title: "Acreage Not Confirmed",
    description: "Net mineral acres could not be extracted from the legal description or document. All per-acre value calculations use assumed acreage and may be significantly off.",
    evidence: "No NMA in legal description or document",
    mitigation: "Request deed or title opinion confirming net mineral acres. Do not finalize offer without confirmed NMA.",
  };
}

function flagMissingRoyalty(input: DealValuationInput | null): RiskFlag | null {
  if (!input) return null;
  if (input.royalty_rate != null && input.royalty_rate > 0) return null;

  return {
    id: "missing_royalty",
    category: "ownership",
    severity: "medium",
    title: "Royalty Rate Not Confirmed",
    description: "No royalty rate was found in the document or legal description. The analysis assumes 12.5% (1/8) as a conservative default — actual royalty could be higher or lower.",
    evidence: "Royalty rate not parsed from document",
    mitigation: "Obtain executed lease to confirm royalty fraction. Rerun analysis with confirmed rate.",
  };
}

function flagTitleUncertainty(input: DealValuationInput | null): RiskFlag | null {
  if (!input) return null;
  const lp = input.legal_description_parsed;
  if (!lp) return null;

  // If we couldn't parse key PLSS fields, flag as uncertain
  const hasPLSS = lp.plss_township || lp.plss_range || lp.section;
  const hasAbstract = lp.abstract_number || lp.survey_name;
  const hasParcel = lp.parcel_id;

  if (hasPLSS || hasAbstract || hasParcel) return null;

  return {
    id: "title_uncertainty",
    category: "ownership",
    severity: "medium",
    title: "Legal Description Could Not Be Fully Parsed",
    description: "The legal description did not yield a complete PLSS or abstract location. Title research is required before acquisition — ownership boundaries and interests cannot be confirmed from available data.",
    evidence: "Incomplete legal description parsing",
    mitigation: "Order title opinion or run minerals title search. Do not proceed without confirmed legal description.",
  };
}

function flagLowActivityBasin(activity: DealValuationActivityLevel | null): RiskFlag | null {
  if (activity !== "low") return null;

  return {
    id: "low_activity_basin",
    category: "geology",
    severity: "low",
    title: "Low-Activity Basin — Limited Near-Term Development",
    description: "County/basin data indicates low current drilling activity. Near-term royalty upside from new wells is limited. Value is primarily driven by existing production cash flows rather than development optionality.",
    evidence: "County basin activity tier: low",
    mitigation: "Focus valuation on income approach (existing cash flow) rather than development potential. Apply appropriate discount to undeveloped acreage.",
  };
}

function flagHighDeclineEur(decline: DeclineCurveResult | null): RiskFlag | null {
  if (!decline?.economic_life_months) return null;
  if (decline.economic_life_months > 60) return null; // >5 years = acceptable

  const years = (decline.economic_life_months / 12).toFixed(1);
  const severity: RiskFlagSeverity = decline.economic_life_months < 24 ? "high" : "medium";

  return {
    id: "short_economic_life",
    category: "production",
    severity,
    title: "Short Remaining Economic Life",
    description: `Decline analysis projects only ~${years} years of remaining economic production at current decline rates. Terminal value is limited.`,
    evidence: `${decline.economic_life_months} months remaining economic life at ${decline.annual_decline_pct}/yr decline`,
    mitigation: "Accelerate payback in offer terms. Evaluate recompletion or secondary recovery potential. Verify production with run statements.",
  };
}

function flagOperatorConcentration(nearby: NearbyWellIntelligence | null): RiskFlag | null {
  if (!nearby || nearby.operators.length === 0) return null;
  if (nearby.total_count < 3) return null; // not enough data to flag

  // Single operator on all nearby wells
  if (nearby.operators.length === 1 && nearby.total_count >= 3) {
    return {
      id: "operator_concentration",
      category: "operator",
      severity: "low",
      title: "Single-Operator Concentration",
      description: `All ${nearby.total_count} nearby wells are operated by ${nearby.operators[0]}. Operational changes, financial distress, or sale of this operator could affect field development decisions.`,
      evidence: `Sole operator: ${nearby.operators[0]}`,
      mitigation: "Research operator financial health and drilling pipeline. Consider operator quality in deal scoring.",
    };
  }
  return null;
}

// ── Main function ──────────────────────────────────────────────────────────────

export function identifyRiskFlags(args: {
  nearby: NearbyWellIntelligence | null;
  decline: DeclineCurveResult | null;
  pa: PaLiabilityResult | null;
  input: DealValuationInput | null;
  activity: DealValuationActivityLevel | null;
}): RiskFlagsResult {
  const { nearby, decline, pa, input, activity } = args;

  const detected: (RiskFlag | null)[] = [
    flagSteepDecline(decline),
    flagHighDeclineEur(decline),
    flagInactiveWells(nearby),
    flagPluggedWells(nearby),
    flagPaExposure(pa),
    flagNoNearbyWells(nearby),
    flagSingleWellDependency(nearby),
    flagMissingAcreage(input),
    flagMissingRoyalty(input),
    flagTitleUncertainty(input),
    flagLowActivityBasin(activity),
    flagOperatorConcentration(nearby),
  ];

  const flags = detected.filter((f): f is RiskFlag => f !== null);

  // Sort by severity
  const order: Record<RiskFlagSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  const critical = flags.filter(f => f.severity === "critical").length;
  const high = flags.filter(f => f.severity === "high").length;
  const medium = flags.filter(f => f.severity === "medium").length;
  const low = flags.filter(f => f.severity === "low").length;

  let overall: RiskFlagsResult["overall_risk"];
  if (critical > 0) overall = "critical";
  else if (high >= 2 || (high === 1 && medium >= 2)) overall = "high";
  else if (high === 1 || medium >= 2) overall = "moderate";
  else overall = "low";

  const topFlag = flags[0];
  const summary = flags.length === 0
    ? "No significant risk flags identified from available data."
    : `${flags.length} risk flag${flags.length !== 1 ? "s" : ""} identified (${critical} critical, ${high} high, ${medium} medium, ${low} low). ${topFlag ? `Primary: ${topFlag.title}.` : ""}`;

  return {
    flags,
    critical_count: critical,
    high_count: high,
    medium_count: medium,
    low_count: low,
    overall_risk: overall,
    summary,
  };
}
