// @ts-nocheck
/**
 * TRRC Public Records Due Diligence — Scoring Engine
 *
 * Computes the multi-dimensional acquisition scorecard.
 * Does NOT collapse to one unexplained score.
 * Gates recommendation when critical evidence is missing.
 */

import type {
  TrrcFinding,
  AcquisitionScorecard,
  AcquisitionRecommendation,
  ScoreDimension,
  ResolvedSearchContext,
  SourceCoverageStatus,
  SourceAttemptStatus,
} from "./types";
import type { OrchestratorResult } from "./retrieval-orchestrator";

// ─── Weights (must sum to 1.0) ────────────────────────────────────────────────

const WEIGHTS: Record<keyof AcquisitionScorecard["dimensions"], number> = {
  record_completeness:    0.10,
  identity_confidence:    0.12,
  production_quality:     0.15,
  production_consistency: 0.13,
  mechanical_integrity:   0.08,
  plugging_exposure:      0.10,
  regulatory_compliance:  0.12,
  operator_profile:       0.08,
  development_activity:   0.07,
  data_confidence:        0.05,
};

// Verify weights sum to 1 at module load (dev guard only)
const _weightSum = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
if (Math.abs(_weightSum - 1.0) > 0.001) {
  throw new Error(`Scoring weights must sum to 1.0, got ${_weightSum}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function findingsBySeverity(
  findings: TrrcFinding[],
  severity: TrrcFinding["severity"],
): TrrcFinding[] {
  return findings.filter((f) => f.severity === severity);
}

function findingsByType(findings: TrrcFinding[], finding_type: string): TrrcFinding[] {
  return findings.filter((f) => f.finding_type === finding_type);
}

function hasFindings(findings: TrrcFinding[], finding_type: string): boolean {
  return findingsByType(findings, finding_type).length > 0;
}

function attemptSuccessRate(attempts: OrchestratorResult["source_attempts"]): number {
  if (attempts.length === 0) return 0;
  const failed: SourceAttemptStatus[] = ["failed_transient", "failed_permanent"];
  const successCount = attempts.filter((a) => !failed.includes(a.status)).length;
  return successCount / attempts.length;
}

// ─── Dimension computers ──────────────────────────────────────────────────────

function computeRecordCompleteness(
  coverage: SourceCoverageStatus[],
  orchestrator_result: OrchestratorResult,
): ScoreDimension {
  const total = orchestrator_result.source_attempts.length;
  const failed = orchestrator_result.source_attempts.filter(
    (a) => a.status === "failed_transient" || a.status === "failed_permanent",
  ).length;
  const notApplicable = orchestrator_result.source_attempts.filter(
    (a) => a.status === "not_applicable",
  ).length;

  const denominator = total - notApplicable;
  const score =
    denominator > 0 ? clamp(Math.round(((denominator - failed) / denominator) * 100)) : 50;

  const completeCats = coverage.filter((c) => c.status === "complete").length;
  const totalCats = coverage.filter((c) => c.status !== "not_checked").length;

  return {
    label: "Record Completeness",
    score,
    weight: WEIGHTS.record_completeness,
    rationale: `${total - failed} of ${total} source attempts succeeded (${failed} failed). ` +
      `${completeCats} of ${totalCats} data categories complete.`,
    data_points: [
      `total_attempts: ${total}`,
      `failed_attempts: ${failed}`,
      `not_applicable: ${notApplicable}`,
      `complete_categories: ${completeCats}/${totalCats}`,
      `manual_required: ${orchestrator_result.manual_required_count}`,
    ],
  };
}

function computeIdentityConfidence(
  ctx: ResolvedSearchContext,
  findings: TrrcFinding[],
): ScoreDimension {
  const apiVerified = hasFindings(findings, "api_verified");
  const apiUnverified = hasFindings(findings, "api_not_verified");
  const multipleApis = hasFindings(findings, "multiple_apis_on_lease");
  const operatorDiscrepancy = hasFindings(findings, "operator_name_discrepancy");

  let score = 70; // baseline when identity is partially known
  const dataPoints: string[] = [];

  if (apiVerified) {
    score = 95;
    dataPoints.push("api_verified: true");
  } else if (apiUnverified) {
    score = 15;
    dataPoints.push("api_not_verified: true");
  } else if (ctx.input_type === "rrc_lease_number" && ctx.district) {
    score = 75;
    dataPoints.push("lease_number_with_district: true");
  } else if (ctx.input_type === "rrc_lease_number") {
    score = 50;
    dataPoints.push("lease_number_no_district: true");
  }

  if (multipleApis) {
    score = Math.round(score * 0.85);
    dataPoints.push("multiple_apis_on_lease: confidence_reduced");
  }
  if (operatorDiscrepancy) {
    score = Math.round(score * 0.9);
    dataPoints.push("operator_name_discrepancy: confidence_reduced");
  }

  dataPoints.push(`input_type: ${ctx.input_type}`);
  dataPoints.push(`normalized_input: ${ctx.normalized_input}`);

  return {
    label: "Identity Confidence",
    score: clamp(score),
    weight: WEIGHTS.identity_confidence,
    rationale:
      apiVerified
        ? "API number confirmed in TRRC wellbore database with high confidence."
        : apiUnverified
        ? "API number could not be verified in TRRC wellbore database — critical gap."
        : `Identity based on ${ctx.input_type} with${ctx.district ? "" : "out"} district context.`,
    data_points: dataPoints,
  };
}

function computeProductionQuality(
  findings: TrrcFinding[],
  orchestrator_result: OrchestratorResult,
): ScoreDimension {
  const noProduction = hasFindings(findings, "no_production_records");
  const prodNotQueried = hasFindings(findings, "production_not_queried");
  const lastProdStale = hasFindings(findings, "last_production_stale");
  const prodFound = hasFindings(findings, "production_records_found");
  const extendedZero = hasFindings(findings, "extended_zero_production");

  let score = 50;
  const dataPoints: string[] = [];

  if (noProduction) {
    score = 0;
    dataPoints.push("production_records: none_found");
  } else if (prodNotQueried) {
    score = 20;
    dataPoints.push("production_records: not_queried");
  } else if (prodFound) {
    score = 80;
    dataPoints.push("production_records: found");

    // Get the info finding to extract month count
    const infoFinding = findingsByType(findings, "production_records_found")[0];
    const months =
      typeof infoFinding?.evidence["months_count"] === "number"
        ? infoFinding.evidence["months_count"]
        : 0;

    dataPoints.push(`months_of_data: ${months}`);

    if (months >= 24) score = 90;
    else if (months >= 12) score = 80;
    else score = 65;

    if (lastProdStale) {
      score = Math.round(score * 0.6);
      dataPoints.push("last_production_stale: score_reduced");
    }
    if (extendedZero) {
      score = Math.round(score * 0.7);
      dataPoints.push("extended_zero_months: score_reduced");
    }
  }

  const productionMonths = orchestrator_result.production.length;
  dataPoints.push(`total_production_rows: ${productionMonths}`);

  return {
    label: "Production Data Quality",
    score: clamp(score),
    weight: WEIGHTS.production_quality,
    rationale: noProduction
      ? "No production records found — cannot assess production quality."
      : prodFound
      ? `Production data available. Recency and zero-month factors applied.`
      : "Production data status unknown or retrieval failed.",
    data_points: dataPoints,
  };
}

function computeProductionConsistency(
  findings: TrrcFinding[],
  orchestrator_result: OrchestratorResult,
): ScoreDimension {
  const declining = hasFindings(findings, "production_declining");
  const extendedZero = hasFindings(findings, "extended_zero_production");
  const noProduction = hasFindings(findings, "no_production_records");
  const partialData = hasFindings(findings, "production_data_partial");

  const dataPoints: string[] = [];

  if (noProduction) {
    dataPoints.push("no_production_data: cannot_assess_consistency");
    return {
      label: "Production Consistency",
      score: 0,
      weight: WEIGHTS.production_consistency,
      rationale: "No production data available to assess consistency.",
      data_points: dataPoints,
    };
  }

  let score = 80;

  if (declining) {
    const decliningFinding = findingsByType(findings, "production_declining")[0];
    const declinePct =
      typeof decliningFinding?.evidence["decline_percent"] === "number"
        ? (decliningFinding.evidence["decline_percent"] as number)
        : 30;
    const declinePenalty = Math.min(40, Math.round(declinePct * 0.8));
    score -= declinePenalty;
    dataPoints.push(`decline_percent: ${declinePct.toFixed(0)}%`, `decline_penalty: -${declinePenalty}`);
  }

  if (extendedZero) {
    const zeroFinding = findingsByType(findings, "extended_zero_production")[0];
    const zeroCount =
      typeof zeroFinding?.evidence["zero_months_count"] === "number"
        ? (zeroFinding.evidence["zero_months_count"] as number)
        : 0;
    const zeroPenalty = Math.min(30, zeroCount * 2);
    score -= zeroPenalty;
    dataPoints.push(`zero_months: ${zeroCount}`, `zero_months_penalty: -${zeroPenalty}`);
  }

  if (partialData) {
    score -= 10;
    dataPoints.push("partial_data_penalty: -10");
  }

  dataPoints.push(`total_production_rows: ${orchestrator_result.production.length}`);

  return {
    label: "Production Consistency",
    score: clamp(score),
    weight: WEIGHTS.production_consistency,
    rationale: declining
      ? "Production trend is declining. Consistency score reduced by decline severity."
      : extendedZero
      ? "Extended zero-production months reduce consistency score."
      : "Production data available with acceptable consistency.",
    data_points: dataPoints,
  };
}

function computeMechanicalIntegrity(
  findings: TrrcFinding[],
  orchestrator_result: OrchestratorResult,
): ScoreDimension {
  // Check if injection/UIC data was retrieved (mechanical integrity tests)
  const injectionAttempt = orchestrator_result.source_attempts.find(
    (a) => a.source_id === "injection_uic_query",
  );

  const dataPoints: string[] = [];

  if (!injectionAttempt || injectionAttempt.status === "not_applicable") {
    dataPoints.push("injection_uic: not_applicable");
    return {
      label: "Mechanical Integrity",
      score: 100,
      weight: WEIGHTS.mechanical_integrity,
      rationale: "Injection/UIC records not applicable for this well type. Mechanical integrity scoring not reduced.",
      data_points: dataPoints,
    };
  }

  if (injectionAttempt.status === "success" && injectionAttempt.result_count === 0) {
    dataPoints.push("injection_uic: queried_no_records");
    return {
      label: "Mechanical Integrity",
      score: 100,
      weight: WEIGHTS.mechanical_integrity,
      rationale: "No UIC injection records found — well is not an injection well. Mechanical integrity not flagged.",
      data_points: dataPoints,
    };
  }

  if (injectionAttempt.status === "no_results") {
    dataPoints.push("injection_uic: no_results");
    return {
      label: "Mechanical Integrity",
      score: 100,
      weight: WEIGHTS.mechanical_integrity,
      rationale: "No UIC records found — not an injection well.",
      data_points: dataPoints,
    };
  }

  if (
    injectionAttempt.status === "failed_transient" ||
    injectionAttempt.status === "failed_permanent"
  ) {
    dataPoints.push("injection_uic: retrieval_failed");
    return {
      label: "Mechanical Integrity",
      score: 50,
      weight: WEIGHTS.mechanical_integrity,
      rationale: "Injection/UIC query failed — mechanical integrity status unknown for this well.",
      data_points: dataPoints,
    };
  }

  // Injection well with records — check for MIT issues from findings_raw
  const injectionData = orchestrator_result.findings_raw.find(
    (r) => r["source_id"] === "injection_uic_query",
  );

  const mitLapsed =
    typeof injectionData?.["mit_lapsed"] === "boolean"
      ? injectionData["mit_lapsed"]
      : false;

  const mitDueDays =
    typeof injectionData?.["mit_due_in_days"] === "number"
      ? injectionData["mit_due_in_days"]
      : null;

  dataPoints.push("injection_uic: records_found");
  if (mitLapsed) dataPoints.push("mit_status: lapsed");
  if (mitDueDays !== null) dataPoints.push(`mit_due_in_days: ${mitDueDays}`);

  let score = 70; // Injection wells with active permits
  if (mitLapsed) score -= 40;
  else if (mitDueDays !== null && mitDueDays < 90) score -= 15;

  return {
    label: "Mechanical Integrity",
    score: clamp(score),
    weight: WEIGHTS.mechanical_integrity,
    rationale: mitLapsed
      ? "Injection well with lapsed mechanical integrity test (MIT). Significant compliance exposure."
      : "Injection well with UIC permit records. MIT status reviewed.",
    data_points: dataPoints,
  };
}

function computePluggingExposure(findings: TrrcFinding[]): ScoreDimension {
  const inactiveConfirmed = hasFindings(findings, "well_inactive_confirmed");
  const notOnInactiveList = hasFindings(findings, "well_not_on_inactive_list");
  const apiVerified = hasFindings(findings, "api_verified");

  const dataPoints: string[] = [];
  let score = 70;

  if (notOnInactiveList && apiVerified) {
    score = 95;
    dataPoints.push("inactive_list: not_found", "api_verified: true");
  } else if (notOnInactiveList) {
    score = 85;
    dataPoints.push("inactive_list: not_found");
  } else if (inactiveConfirmed) {
    const inactiveFinding = findingsByType(findings, "well_inactive_confirmed")[0];
    const yearsInactive =
      typeof inactiveFinding?.evidence["years_inactive"] === "number"
        ? (inactiveFinding.evidence["years_inactive"] as number)
        : null;
    const pluggingCost =
      typeof inactiveFinding?.evidence["estimated_plugging_cost_usd"] === "number"
        ? (inactiveFinding.evidence["estimated_plugging_cost_usd"] as number)
        : null;

    if (yearsInactive !== null && yearsInactive > 5) {
      score = 20;
      dataPoints.push(`years_inactive: ${yearsInactive}`, "exposure_level: high");
    } else {
      score = 45;
      dataPoints.push(
        `years_inactive: ${yearsInactive ?? "unknown"}`,
        "exposure_level: moderate",
      );
    }

    if (pluggingCost !== null) {
      dataPoints.push(`estimated_plugging_cost_usd: ${pluggingCost}`);
    }
  } else {
    dataPoints.push("inactive_status: unknown");
    score = 60;
  }

  return {
    label: "Plugging & Abandonment Exposure",
    score: clamp(score),
    weight: WEIGHTS.plugging_exposure,
    rationale: inactiveConfirmed
      ? "Well is on the TRRC inactive list — P&A liability attaches to acquisition."
      : notOnInactiveList
      ? "Well not found on TRRC inactive list — low plugging exposure indicated."
      : "Plugging exposure status not fully determined from available data.",
    data_points: dataPoints,
  };
}

function computeRegulatoryCompliance(findings: TrrcFinding[]): ScoreDimension {
  const dataPoints: string[] = [];

  const openViolCritical = findingsByType(findings, "open_violations_critical");
  const openViolHigh = findingsByType(findings, "open_violations_high");
  const openViolMed = findingsByType(findings, "open_violations_medium");
  const recentViol = findingsByType(findings, "violations_in_last_12m");
  const noViol = hasFindings(findings, "no_violations_on_record");
  const noInspection = hasFindings(findings, "no_inspection_records");
  const retrievalFailed = hasFindings(findings, "compliance_retrieval_failed");

  if (retrievalFailed) {
    dataPoints.push("compliance_retrieval: failed");
    return {
      label: "Regulatory Compliance",
      score: 40,
      weight: WEIGHTS.regulatory_compliance,
      rationale: "Compliance data retrieval failed — regulatory status unknown.",
      data_points: dataPoints,
    };
  }

  let score = 100;

  const criticalCount = openViolCritical.reduce((s, f) => {
    const c = typeof f.evidence["open_violations_count"] === "number"
      ? (f.evidence["open_violations_count"] as number) : 6;
    return s + c;
  }, 0);
  const highCount = openViolHigh.reduce((s, f) => {
    const c = typeof f.evidence["open_violations_count"] === "number"
      ? (f.evidence["open_violations_count"] as number) : 3;
    return s + c;
  }, 0);
  const medCount = openViolMed.reduce((s, f) => {
    const c = typeof f.evidence["open_violations_count"] === "number"
      ? (f.evidence["open_violations_count"] as number) : 1;
    return s + c;
  }, 0);

  const totalOpen = criticalCount + highCount + medCount;
  const recentCount = recentViol.reduce((s, f) => {
    const c = typeof f.evidence["violations_last_12m"] === "number"
      ? (f.evidence["violations_last_12m"] as number) : 1;
    return s + c;
  }, 0);

  const openPenalty = Math.min(60, totalOpen * 10);
  const recentPenalty = Math.min(25, recentCount * 5);
  score = clamp(score - openPenalty - recentPenalty);

  dataPoints.push(
    `open_violations_total: ${totalOpen}`,
    `recent_violations_12m: ${recentCount}`,
    `open_violation_penalty: -${openPenalty}`,
    `recent_violation_penalty: -${recentPenalty}`,
  );

  if (noViol) dataPoints.push("no_violations_found: true");
  if (noInspection) dataPoints.push("no_inspection_records: true");

  return {
    label: "Regulatory Compliance",
    score,
    weight: WEIGHTS.regulatory_compliance,
    rationale: totalOpen > 0
      ? `${totalOpen} open violation(s) found. Score reduced by ${openPenalty + recentPenalty} points.`
      : noViol
      ? "No violations on record (2015–present). Score reflects clean compliance history."
      : "Compliance data present with no material violations.",
    data_points: dataPoints,
  };
}

function computeOperatorProfile(
  source_data_raw: OrchestratorResult["findings_raw"],
): ScoreDimension {
  const p5Data = source_data_raw.find((r) => r["source_id"] === "p5_operator_query");
  const dataPoints: string[] = [];

  if (!p5Data) {
    dataPoints.push("p5_data: not_retrieved");
    return {
      label: "Operator Profile (P-5 Status)",
      score: 50,
      weight: WEIGHTS.operator_profile,
      rationale: "P-5 operator data not retrieved — operator profile score is unknown (50 default).",
      data_points: dataPoints,
    };
  }

  const p5Status =
    typeof p5Data["p5_status"] === "string" ? (p5Data["p5_status"] as string) : "unknown";
  const financialAssurance =
    typeof p5Data["financial_assurance_flag"] === "boolean"
      ? (p5Data["financial_assurance_flag"] as boolean)
      : false;

  dataPoints.push(`p5_status: ${p5Status}`);

  let score: number;
  switch (p5Status.toLowerCase()) {
    case "active":
      score = 80;
      break;
    case "active-ext":
      score = 70;
      break;
    case "delinquent":
      score = 20;
      dataPoints.push("delinquent_operator: significant_red_flag");
      break;
    case "inactive":
      score = 25;
      break;
    case "cancelled":
      score = 0;
      dataPoints.push("cancelled_operator: critical_flag");
      break;
    default:
      score = 50;
      dataPoints.push("p5_status_unknown: default_score");
  }

  if (financialAssurance) {
    score = Math.max(0, score - 10);
    dataPoints.push("financial_assurance_flag: true, score_reduced");
  }

  return {
    label: "Operator Profile (P-5 Status)",
    score: clamp(score),
    weight: WEIGHTS.operator_profile,
    rationale: `Operator P-5 status is "${p5Status}". ` +
      (p5Status.toLowerCase() === "delinquent"
        ? "TRRC will not issue new permits to delinquent operators."
        : p5Status.toLowerCase() === "cancelled"
        ? "Cancelled P-5 is a critical compliance finding."
        : "P-5 status appears acceptable."),
    data_points: dataPoints,
  };
}

function computeDevelopmentActivity(
  orchestrator_result: OrchestratorResult,
): ScoreDimension {
  // Check GIS / offset well data from findings_raw
  const gisData = orchestrator_result.findings_raw.find(
    (r) => r["source_id"] === "gis_wellbore",
  );
  const dataPoints: string[] = [];

  if (!gisData) {
    dataPoints.push("gis_data: not_retrieved");
    return {
      label: "Development Activity",
      score: 50,
      weight: WEIGHTS.development_activity,
      rationale: "GIS / offset well data not retrieved — development activity score is unknown (50 default).",
      data_points: dataPoints,
    };
  }

  const offsetWellCount =
    typeof gisData["offset_well_count"] === "number"
      ? (gisData["offset_well_count"] as number)
      : null;
  const recentPermits =
    typeof gisData["recent_permits_count"] === "number"
      ? (gisData["recent_permits_count"] as number)
      : null;

  if (offsetWellCount !== null) dataPoints.push(`offset_well_count: ${offsetWellCount}`);
  if (recentPermits !== null) dataPoints.push(`recent_permits: ${recentPermits}`);

  let score = 50;
  if (offsetWellCount !== null && offsetWellCount > 10) score += 20;
  else if (offsetWellCount !== null && offsetWellCount > 3) score += 10;

  if (recentPermits !== null && recentPermits > 0) score += 10;

  return {
    label: "Development Activity",
    score: clamp(score),
    weight: WEIGHTS.development_activity,
    rationale: offsetWellCount !== null
      ? `${offsetWellCount} offset wells identified in area. Development context available.`
      : "Development activity data unavailable — default score applied.",
    data_points: dataPoints,
  };
}

function computeDataConfidence(
  orchestrator_result: OrchestratorResult,
): ScoreDimension {
  const rate = attemptSuccessRate(orchestrator_result.source_attempts);
  const score = clamp(Math.round(rate * 100));
  const total = orchestrator_result.source_attempts.length;
  const succeeded = orchestrator_result.source_attempts.filter(
    (a) => a.status === "success" || a.status === "no_results" || a.status === "manual_required",
  ).length;

  return {
    label: "Data Retrieval Confidence",
    score,
    weight: WEIGHTS.data_confidence,
    rationale: `${succeeded} of ${total} source attempts completed without error. ` +
      `Success rate: ${(rate * 100).toFixed(0)}%.`,
    data_points: [
      `total_attempts: ${total}`,
      `non_error_attempts: ${succeeded}`,
      `success_rate: ${(rate * 100).toFixed(1)}%`,
    ],
  };
}

// ─── Gating & recommendation ──────────────────────────────────────────────────

function computeGating(
  findings: TrrcFinding[],
  ctx: ResolvedSearchContext,
  coverage: SourceCoverageStatus[],
): { blocked: boolean; conditions: string[]; missing_critical: string[] } {
  const conditions: string[] = [];
  const missing_critical: string[] = [];

  // Gate 1: Primary well identifier unverified
  if (hasFindings(findings, "api_not_verified")) {
    conditions.push("Primary well identifier (API number) could not be verified in TRRC database");
    missing_critical.push("Well identity verification");
  }

  // Gate 2: No production records found
  if (hasFindings(findings, "no_production_records")) {
    conditions.push("No production records found — production history cannot be assessed");
    missing_critical.push("Production history");
  }

  // Gate 3: Lease uniquely unidentified
  if (
    ctx.input_type === "lease_name" ||
    (ctx.input_type === "rrc_lease_number" && !ctx.district)
  ) {
    const leaseAmbiguous = coverage.find(
      (c) => c.category === "identity" && c.status !== "complete",
    );
    if (leaseAmbiguous) {
      conditions.push(
        "Lease not uniquely identified — multiple candidates unresolved or district unknown",
      );
      missing_critical.push("Unique lease identification");
    }
  }

  // Gate 4: 2+ critical findings
  const criticalCount = findingsBySeverity(findings, "critical").length;
  if (criticalCount >= 2) {
    conditions.push(`${criticalCount} critical findings require resolution before proceeding`);
    missing_critical.push(`${criticalCount} critical finding resolution`);
  }

  return {
    blocked: conditions.length > 0,
    conditions,
    missing_critical,
  };
}

function computeRecommendation(
  opportunity_score: number,
  risk_score: number,
  blocked: boolean,
): AcquisitionRecommendation {
  if (blocked) return "BLOCKED";
  if (opportunity_score >= 70 && risk_score <= 30) return "PURSUE";
  if (risk_score > 60 || opportunity_score < 40) return "PASS";
  if (opportunity_score >= 50 && risk_score <= 60) return "REVIEW";
  return "REVIEW";
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function computeAcquisitionScorecard(
  _run_id: string,
  ctx: ResolvedSearchContext,
  findings: TrrcFinding[],
  coverage: SourceCoverageStatus[],
  orchestrator_result: OrchestratorResult,
): AcquisitionScorecard {
  // Compute all dimensions
  const dimensions: AcquisitionScorecard["dimensions"] = {
    record_completeness: computeRecordCompleteness(coverage, orchestrator_result),
    identity_confidence: computeIdentityConfidence(ctx, findings),
    production_quality: computeProductionQuality(findings, orchestrator_result),
    production_consistency: computeProductionConsistency(findings, orchestrator_result),
    mechanical_integrity: computeMechanicalIntegrity(findings, orchestrator_result),
    plugging_exposure: computePluggingExposure(findings),
    regulatory_compliance: computeRegulatoryCompliance(findings),
    operator_profile: computeOperatorProfile(orchestrator_result.findings_raw),
    development_activity: computeDevelopmentActivity(orchestrator_result),
    data_confidence: computeDataConfidence(orchestrator_result),
  };

  // Weighted composite score
  const weightedSum = (Object.keys(dimensions) as Array<keyof typeof dimensions>).reduce(
    (sum, key) => sum + dimensions[key].score * dimensions[key].weight,
    0,
  );
  const overall_confidence = clamp(Math.round(weightedSum));

  // Opportunity score: driven by production quality, development activity, identity confidence
  const opportunity_score = clamp(
    Math.round(
      dimensions.production_quality.score * 0.35 +
      dimensions.production_consistency.score * 0.25 +
      dimensions.identity_confidence.score * 0.20 +
      dimensions.development_activity.score * 0.20,
    ),
  );

  // Risk score: driven by compliance, plugging exposure, operator profile (inverted), mechanical integrity (inverted)
  const risk_score = clamp(
    Math.round(
      (100 - dimensions.regulatory_compliance.score) * 0.30 +
      (100 - dimensions.plugging_exposure.score) * 0.25 +
      (100 - dimensions.operator_profile.score) * 0.20 +
      (100 - dimensions.mechanical_integrity.score) * 0.15 +
      (100 - dimensions.record_completeness.score) * 0.10,
    ),
  );

  // Gating
  const { blocked, conditions, missing_critical } = computeGating(findings, ctx, coverage);

  // Recommendation
  const recommendation = computeRecommendation(opportunity_score, risk_score, blocked);

  // Reasons for / against
  const reasons_for: string[] = [];
  const reasons_against: string[] = [];

  if (dimensions.production_quality.score >= 75) {
    reasons_for.push("Production data available with good quality and recency");
  }
  if (dimensions.regulatory_compliance.score >= 85) {
    reasons_for.push("Clean compliance history — no material violations");
  }
  if (dimensions.identity_confidence.score >= 90) {
    reasons_for.push("Well identity verified with high confidence");
  }
  if (dimensions.plugging_exposure.score >= 85) {
    reasons_for.push("No plugging liability indicated from available records");
  }
  if (dimensions.development_activity.score >= 65) {
    reasons_for.push("Active development activity in the area");
  }

  if (dimensions.production_quality.score < 40) {
    reasons_against.push("Production data poor quality or absent");
  }
  if (dimensions.regulatory_compliance.score < 60) {
    reasons_against.push("Open violations or recent compliance issues");
  }
  if (dimensions.plugging_exposure.score < 50) {
    reasons_against.push("Plugging liability exposure on inactive well");
  }
  if (dimensions.identity_confidence.score < 50) {
    reasons_against.push("Well identity not confirmed");
  }
  if (dimensions.operator_profile.score < 40) {
    reasons_against.push("Operator P-5 status is delinquent, inactive, or cancelled");
  }

  findingsBySeverity(findings, "critical").forEach((f) => {
    reasons_against.push(`Critical finding: ${f.title}`);
  });

  return {
    dimensions,
    opportunity_score,
    risk_score,
    overall_confidence,
    recommendation,
    gating_conditions: conditions,
    missing_critical_evidence: missing_critical,
    reasons_for,
    reasons_against,
  };
}
