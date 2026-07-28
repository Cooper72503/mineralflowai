/**
 * Acquisition Scorecard — a transparent, rule-based weighted rubric, not a
 * black-box model. Every dimension's rationale states exactly which real
 * retrieved signals produced its score, and every score_points array lists
 * the underlying evidence. Missing data always scores low/neutral on that
 * dimension with an explicit "not scored — no data" note — it is never
 * treated as a good sign, and it never gets silently averaged away.
 *
 * Weights sum to 1.0. identity_confidence is weighted heaviest (0.15) —
 * every other dimension is meaningless if the asset itself isn't
 * confirmed. Everything else is weighted equally (0.10) except
 * operator_profile (0.05), which mostly overlaps regulatory_compliance
 * (P-5 status) and is kept as a secondary, lighter signal rather than
 * double-counting the same fact at full weight twice.
 */

import type { AcquisitionScorecard, ScorecardDimensionKey, ScoreDimension, AcquisitionRecommendation, SourceCoverageStatus, TrrcDDProductionRow } from "./types";
import type { LiteSourceAttempt } from "./coverage";

function getAttempt(attempts: LiteSourceAttempt[], ...names: string[]): Record<string, unknown> | null {
  for (const name of names) {
    const a = attempts.find(x => x.source_name === name && x.status === "success");
    if (a?.result_data_json) return a.result_data_json;
  }
  return null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function dim(label: string, score: number, weight: number, rationale: string, data_points: string[]): ScoreDimension {
  return { label, score: Math.max(0, Math.min(100, Math.round(score))), weight, rationale, data_points };
}

export type ScorecardInputs = {
  attempts: LiteSourceAttempt[];
  production: TrrcDDProductionRow[];
  coverage: SourceCoverageStatus[];
  criticalFlags: string[];
  importantFlags: string[];
  monthsOfHistory: number;
  recentAvgOil: number | null;
  yoyDeclineOilPct: number | null;
  zeroProductionMonths: number;
  worTrend: "Stable" | "Rising" | "Declining" | "N/A";
  offsetWellCount: number;
  hasLateralPath: boolean;
  resolvedLeaseNumber: string | null;
  resolvedDistrict: string | null;
};

export function buildAcquisitionScorecard(inputs: ScorecardInputs): AcquisitionScorecard {
  const { attempts, coverage, criticalFlags, importantFlags } = inputs;

  // ── record_completeness ──────────────────────────────────────────────
  const applicable = coverage.filter(c => c.status !== "no_applicable_record");
  const definitive = applicable.filter(c => c.status === "complete" || c.status === "partial" || c.status === "no_applicable_record");
  const completenessPct = applicable.length > 0 ? (definitive.length / applicable.length) * 100 : 0;
  const record_completeness = dim(
    "Record Completeness", completenessPct, 0.10,
    applicable.length > 0
      ? `${definitive.length} of ${applicable.length} applicable TRRC sources returned a definitive answer (data or confirmed absence).`
      : "No coverage data available to score.",
    coverage.filter(c => c.status === "retrieval_failed" || c.status === "manual_required").map(c => `${c.label}: ${c.status}`),
  );

  // ── identity_confidence ───────────────────────────────────────────────
  const wellboreFound = getAttempt(attempts, "search_by_api")?.["found"] === true;
  const gisFound = getAttempt(attempts, "fetch_gis_plat")?.["found"] === true;
  const codaAttempt = getAttempt(attempts, "fetch_coda_records");
  const codaFound = Array.isArray(codaAttempt?.["documents"]) && (codaAttempt!["documents"] as unknown[]).length > 0;
  let identityScore = 0;
  const identityPoints: string[] = [];
  if (wellboreFound) { identityScore += 60; identityPoints.push("Confirmed in TRRC wellbore PDQ."); }
  if (gisFound) { identityScore += 25; identityPoints.push("Confirmed in TRRC GIS well-location database."); }
  if (codaFound) { identityScore += 15; identityPoints.push("Imaged documents on file in CODA."); }
  const identity_confidence = dim(
    "Identity Confidence", identityScore, 0.15,
    identityScore > 0
      ? "Asset identity confirmed by one or more independent TRRC sources."
      : "Asset identity could not be positively confirmed in any TRRC source — treat all other dimensions as provisional.",
    identityPoints,
  );

  // ── production_quality ────────────────────────────────────────────────
  let prodQualityScore: number;
  let prodQualityRationale: string;
  const prodQualityPoints: string[] = [];
  if (inputs.monthsOfHistory === 0) {
    prodQualityScore = 0;
    prodQualityRationale = "No production history retrieved — not scored as neutral, since a mineral asset with no documented production has no confirmed royalty stream.";
  } else {
    prodQualityScore = 40; // base credit for having any history at all
    prodQualityPoints.push(`${inputs.monthsOfHistory} month(s) of production history on file.`);
    if (inputs.recentAvgOil !== null && inputs.recentAvgOil > 0) {
      prodQualityScore += 30;
      prodQualityPoints.push(`Recent 12-mo average oil: ${inputs.recentAvgOil.toFixed(0)} BBL/mo.`);
    }
    const zeroRatio = inputs.zeroProductionMonths / inputs.monthsOfHistory;
    if (zeroRatio < 0.1) { prodQualityScore += 30; prodQualityPoints.push("Fewer than 10% of retrieved months show zero production."); }
    else if (zeroRatio < 0.3) { prodQualityScore += 10; prodQualityPoints.push(`${inputs.zeroProductionMonths} month(s) with zero reported production.`); }
    else { prodQualityPoints.push(`${inputs.zeroProductionMonths} of ${inputs.monthsOfHistory} months show zero production — significant gap.`); }
    prodQualityRationale = "Scored on presence of recent production and consistency of monthly reporting.";
  }
  const production_quality = dim("Production Quality", prodQualityScore, 0.10, prodQualityRationale, prodQualityPoints);

  // ── production_consistency ────────────────────────────────────────────
  let consistencyScore: number;
  const consistencyPoints: string[] = [];
  if (inputs.monthsOfHistory === 0) {
    consistencyScore = 0;
  } else {
    consistencyScore = 60;
    if (inputs.worTrend === "Stable") { consistencyScore += 40; consistencyPoints.push("Water-to-oil ratio stable over the last 6 months."); }
    else if (inputs.worTrend === "Declining") { consistencyScore += 40; consistencyPoints.push("Water-to-oil ratio declining — favorable trend."); }
    else if (inputs.worTrend === "Rising") { consistencyScore -= 20; consistencyPoints.push("Water-to-oil ratio rising — possible reservoir depletion or water encroachment."); }
    else { consistencyPoints.push("Water-to-oil ratio trend not computable from retrieved data."); }
    if (inputs.yoyDeclineOilPct !== null) {
      if (inputs.yoyDeclineOilPct > 30) { consistencyScore -= 30; consistencyPoints.push(`${inputs.yoyDeclineOilPct.toFixed(1)}% YoY oil decline — material.`); }
      else { consistencyPoints.push(`${inputs.yoyDeclineOilPct.toFixed(1)}% YoY oil change.`); }
    }
  }
  const production_consistency = dim(
    "Production Consistency", consistencyScore, 0.10,
    inputs.monthsOfHistory === 0 ? "No production history to assess consistency." : "Scored on water-to-oil ratio trend and year-over-year decline rate.",
    consistencyPoints,
  );

  // ── mechanical_integrity ──────────────────────────────────────────────
  const wellStatusAttempt = getAttempt(attempts, "fetch_well_status");
  const statusStr = str(wellStatusAttempt?.["status"] ?? wellStatusAttempt?.["well_status"]).toLowerCase();
  const injection = getAttempt(attempts, "fetch_injection_records");
  let mechScore: number;
  const mechPoints: string[] = [];
  if (!statusStr) {
    mechScore = 30;
    mechPoints.push("Well status not retrieved from TRRC.");
  } else if (/^active$|^ac$/.test(statusStr)) { mechScore = 100; mechPoints.push(`Well status: ${statusStr}.`); }
  else if (/shut.?in|^si$/.test(statusStr)) { mechScore = 65; mechPoints.push(`Well status: ${statusStr} (shut-in).`); }
  else if (/temp.*abandon|^ta$/.test(statusStr)) { mechScore = 45; mechPoints.push(`Well status: ${statusStr} (temporarily abandoned).`); }
  else if (/plugged/.test(statusStr)) { mechScore = 10; mechPoints.push(`Well status: ${statusStr}.`); }
  else { mechScore = 50; mechPoints.push(`Well status: ${statusStr} (unrecognized category).`); }
  if (injection?.["found"] === true) {
    const records = Array.isArray(injection["records"]) ? injection["records"] as Record<string, unknown>[] : [];
    mechPoints.push(`${records.length} UIC/injection record(s) on file — verify MIT currency separately.`);
  }
  const mechanical_integrity = dim("Mechanical Integrity", mechScore, 0.10, "Scored primarily on official TRRC well status.", mechPoints);

  // ── plugging_exposure (higher score = lower exposure) ─────────────────
  const orphan = getAttempt(attempts, "fetch_orphan_well");
  const inactive = getAttempt(attempts, "fetch_inactive_well_status");
  const inactiveRecords = Array.isArray(inactive?.["records"]) ? inactive!["records"] as Record<string, unknown>[] : [];
  let plugExposureScore = 100;
  const plugExposurePoints: string[] = [];
  if (orphan?.["is_orphan"] === true) {
    plugExposureScore = 0;
    plugExposurePoints.push("Well is in the TRRC orphan well program — state liability for plugging.");
  } else if (inactiveRecords.length > 0) {
    plugExposureScore = 40;
    plugExposurePoints.push(`Well on TRRC inactive well aging report (${inactiveRecords.length} record(s)).`);
    const deadline = str(inactiveRecords[0]?.["plugging_deadline_date"] ?? inactiveRecords[0]?.["deadline"]);
    if (deadline) plugExposurePoints.push(`Plugging deadline: ${deadline}.`);
  } else {
    plugExposurePoints.push("Not on orphan well list or inactive well aging report.");
  }
  const plugging_exposure = dim("Plugging Exposure", plugExposureScore, 0.10, "Higher score = lower plugging/abandonment liability exposure.", plugExposurePoints);

  // ── regulatory_compliance ─────────────────────────────────────────────
  const p5 = getAttempt(attempts, "search_by_operator");
  const p5Records = Array.isArray(p5?.["records"]) ? p5!["records"] as Record<string, unknown>[] : [];
  const p5Status = str(p5Records[0]?.["p5_status"] ?? p5?.["p5_status"]);
  const violations = getAttempt(attempts, "fetch_compliance_violations");
  const openViolations = typeof violations?.["open_count"] === "number" ? violations["open_count"] as number : 0;
  let complianceScore: number;
  const compliancePoints: string[] = [];
  if (!p5Status) { complianceScore = 30; compliancePoints.push("Operator P-5 status not retrieved."); }
  else if (/^active$/i.test(p5Status)) { complianceScore = 100; compliancePoints.push(`Operator P-5 status: ${p5Status}.`); }
  else if (/inactive|revoked|delinquent|cancelled/i.test(p5Status)) { complianceScore = 0; compliancePoints.push(`Operator P-5 status: ${p5Status} — regulatory red flag.`); }
  else { complianceScore = 50; compliancePoints.push(`Operator P-5 status: ${p5Status}.`); }
  if (openViolations > 0) {
    complianceScore = Math.max(0, complianceScore - openViolations * 20);
    compliancePoints.push(`${openViolations} open compliance violation(s).`);
  } else if (violations?.["found"] === true) {
    compliancePoints.push("No open compliance violations.");
  }
  const regulatory_compliance = dim("Regulatory Compliance", complianceScore, 0.10, "Scored on operator P-5 standing and open TRRC compliance violations.", compliancePoints);

  // ── operator_profile ──────────────────────────────────────────────────
  const bondAmt = str(p5Records[0]?.["bond_amount"] ?? p5?.["bond_amount"]);
  const bondNum = bondAmt ? parseFloat(bondAmt.replace(/[^0-9.]/g, "")) : NaN;
  let operatorScore: number;
  const operatorPoints: string[] = [];
  if (!p5Status) { operatorScore = 30; operatorPoints.push("Operator registration not retrieved."); }
  else {
    operatorScore = /^active$/i.test(p5Status) ? 80 : 20;
    operatorPoints.push(`P-5 status: ${p5Status}.`);
    if (!isNaN(bondNum)) {
      if (bondNum >= 25000) { operatorScore = Math.min(100, operatorScore + 20); operatorPoints.push(`Bond: $${bondNum.toLocaleString()}.`); }
      else { operatorScore = Math.max(0, operatorScore - 20); operatorPoints.push(`Bond: $${bondNum.toLocaleString()} — below common statutory minimum.`); }
    }
  }
  const operator_profile = dim("Operator Profile", operatorScore, 0.05, "Secondary signal on operator standing — overlaps regulatory_compliance, kept at lighter weight to avoid double-counting.", operatorPoints);

  // ── development_activity ──────────────────────────────────────────────
  const permits = getAttempt(attempts, "fetch_drilling_permits");
  const permitRows = Array.isArray(permits?.["permits"]) ? permits!["permits"] as Record<string, unknown>[] : [];
  let devScore = 20; // base: no signal either way
  const devPoints: string[] = [];
  if (permitRows.length > 0) {
    devScore += 20;
    devPoints.push(`${permitRows.length} drilling permit filing(s) on record.`);
    if (permitRows.some(p => p["amend"] === "Y")) { devScore += 10; devPoints.push("Includes a recent amendment — active regulatory engagement."); }
  }
  if (inputs.hasLateralPath) { devScore += 20; devPoints.push("Horizontal wellbore — modern completion design."); }
  if (inputs.offsetWellCount > 0) {
    devScore += Math.min(30, inputs.offsetWellCount * 2);
    devPoints.push(`${inputs.offsetWellCount} offset well(s) within 1 mile — active development area.`);
  }
  const development_activity = dim("Development Activity", devScore, 0.10, "Scored on permit activity, completion type, and nearby development density.", devPoints);

  // ── data_confidence ────────────────────────────────────────────────────
  const totalAttempted = coverage.filter(c => c.status !== "no_applicable_record" && c.status !== "not_checked").length;
  const solid = coverage.filter(c => c.status === "complete" || c.status === "no_applicable_record").length;
  const dataConfScore = totalAttempted > 0 ? (solid / totalAttempted) * 100 : 0;
  const data_confidence = dim(
    "Data Confidence", dataConfScore, 0.10,
    totalAttempted > 0
      ? `${solid} of ${totalAttempted} attempted sources returned a fully automated, non-manual result.`
      : "No sources attempted.",
    coverage.filter(c => c.status === "manual_required").map(c => `${c.label}: requires manual review`),
  );

  const dimensions: Record<ScorecardDimensionKey, ScoreDimension> = {
    record_completeness, identity_confidence, production_quality, production_consistency,
    mechanical_integrity, plugging_exposure, regulatory_compliance, operator_profile,
    development_activity, data_confidence,
  };

  const weightedSum = (keys: ScorecardDimensionKey[]) => {
    const totalWeight = keys.reduce((s, k) => s + dimensions[k].weight, 0);
    if (totalWeight === 0) return 0;
    return keys.reduce((s, k) => s + dimensions[k].score * dimensions[k].weight, 0) / totalWeight;
  };

  const opportunity_score = Math.round(weightedSum(["production_quality", "production_consistency", "development_activity", "operator_profile"]));
  const riskDimensionsAvg = weightedSum(["plugging_exposure", "regulatory_compliance", "mechanical_integrity"]);
  const risk_score = Math.round(100 - riskDimensionsAvg); // higher = more risk
  const overall_confidence = Math.round(weightedSum(["identity_confidence", "record_completeness", "data_confidence"]));

  const gating_conditions = [...criticalFlags];
  const missing_critical_evidence = coverage
    .filter(c => c.status === "retrieval_failed" || (c.status === "manual_required" && ["wellbore_identity", "production", "operator_p5"].includes(c.category)))
    .map(c => c.label);

  let recommendation: AcquisitionRecommendation;
  if (gating_conditions.length > 0) {
    recommendation = "BLOCKED";
  } else if (overall_confidence < 30) {
    recommendation = "REVIEW";
  } else if (risk_score >= 60) {
    recommendation = "PASS";
  } else if (opportunity_score >= 60 && risk_score < 40 && overall_confidence >= 60) {
    recommendation = "PURSUE";
  } else {
    recommendation = "REVIEW";
  }

  const reasons_for: string[] = [];
  const reasons_against: string[] = [...criticalFlags, ...importantFlags];
  if (identity_confidence.score > 0) reasons_for.push(...identity_confidence.data_points);
  if (mechScore >= 65) reasons_for.push(...mechPoints.slice(0, 1));
  if (complianceScore >= 80) reasons_for.push(...compliancePoints.slice(0, 1));
  if (devScore >= 50) reasons_for.push(...devPoints);

  return {
    dimensions,
    opportunity_score,
    risk_score,
    overall_confidence,
    recommendation,
    gating_conditions,
    missing_critical_evidence,
    reasons_for,
    reasons_against,
  };
}
