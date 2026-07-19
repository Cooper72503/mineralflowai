// @ts-nocheck
/**
 * TRRC Public Records Due Diligence — Finding Engine
 *
 * Analyzes collected data and generates findings.
 * Each finding has evidence, source, confidence, and recommended_action.
 * NEVER invents severity levels — only uses FindingSeverity enum values.
 * NEVER claims guaranteed completeness.
 */

import type {
  TrrcFinding,
  FindingSeverity,
  TrrcRecordCategory,
  ResolvedSearchContext,
  SourceSearchResult,
  TrrcDDProductionRow,
  SourceCoverageStatus,
} from "./types";
import type { OrchestratorResult } from "./retrieval-orchestrator";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(): string {
  return `finding_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeFinding(
  category: TrrcRecordCategory,
  severity: FindingSeverity,
  finding_type: string,
  title: string,
  description: string,
  evidence: Record<string, unknown>,
  source_record_ids: string[],
  analytical_method: string,
  confidence: number,
  recommended_action: string,
  is_directly_reported: boolean,
): TrrcFinding {
  return {
    id: makeId(),
    category,
    severity,
    finding_type,
    title,
    description,
    evidence,
    source_record_ids,
    analytical_method,
    confidence,
    recommended_action,
    is_directly_reported,
  };
}

// ─── Production analysis utilities ────────────────────────────────────────────

/**
 * Compute a simple average of non-null values. Returns null when the slice is empty.
 */
function average(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * Parse "YYYY-MM" month strings into sortable numbers (YYYYMM integer).
 */
function monthToInt(month: string): number {
  return parseInt(month.replace("-", ""), 10);
}

/**
 * Filter production rows to only those within the last N calendar months
 * from the most recent row in the dataset.
 */
function lastNMonths(rows: TrrcDDProductionRow[], n: number): TrrcDDProductionRow[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => monthToInt(b.production_month) - monthToInt(a.production_month));
  const mostRecentInt = monthToInt(sorted[0].production_month);
  const cutoffInt = mostRecentInt - n; // approximate: works for n < 12
  // Convert to actual year-month cutoff
  const cutoffYear = Math.floor(cutoffInt / 100);
  const cutoffMonth = cutoffInt % 100;
  const cutoff = cutoffYear * 100 + (cutoffMonth <= 0 ? 12 + cutoffMonth : cutoffMonth);

  return sorted.filter((r) => monthToInt(r.production_month) >= cutoff);
}

function totalBarrels(rows: TrrcDDProductionRow[]): number {
  return rows.reduce((s, r) => s + (r.oil_bbl ?? 0) + (r.condensate_bbl ?? 0), 0);
}

function countZeroProductionMonths(rows: TrrcDDProductionRow[]): number {
  return rows.filter(
    (r) =>
      (r.oil_bbl ?? 0) === 0 &&
      (r.gas_mcf ?? 0) === 0 &&
      (r.casinghead_gas_mcf ?? 0) === 0 &&
      (r.condensate_bbl ?? 0) === 0,
  ).length;
}

// ─── Identity consistency findings ───────────────────────────────────────────

function generateIdentityFindings(
  ctx: ResolvedSearchContext,
  source_data: Record<string, SourceSearchResult>,
): TrrcFinding[] {
  const findings: TrrcFinding[] = [];

  // Check if primary well identifier was found
  const wellboreResult = source_data["wellbore_query"];
  const apiFound =
    wellboreResult?.status === "success" && (wellboreResult.result_count ?? 0) > 0;

  if (ctx.input_type === "api_number" && !apiFound) {
    findings.push(
      makeFinding(
        "identity",
        "high",
        "api_not_verified",
        "Primary Well Identifier Unverified",
        "The submitted API number was not found in the TRRC EWA wellbore database. " +
        "The well may not exist, the API number may be incorrect, or the well may be " +
        "indexed under a different county code than expected.",
        {
          submitted_api: ctx.raw_input,
          normalized_api: ctx.normalized_input,
          wellbore_query_status: wellboreResult?.status ?? "not_queried",
        },
        [],
        "wellbore_query_result_check",
        0.9,
        "Verify the API number against the TRRC PDQ database directly. " +
        "Confirm county code and well number are correct.",
        true,
      ),
    );
  } else if (ctx.input_type === "api_number" && apiFound) {
    findings.push(
      makeFinding(
        "identity",
        "info",
        "api_verified",
        "Well Identity Verified in TRRC Database",
        "The submitted API number was found in the TRRC EWA wellbore database with matching records.",
        {
          submitted_api: ctx.raw_input,
          normalized_api: ctx.normalized_input,
          records_found: wellboreResult?.result_count,
        },
        wellboreResult?.records.map((r) => r.document_id) ?? [],
        "wellbore_query_result_check",
        0.95,
        "No action required for identity verification.",
        true,
      ),
    );
  }

  // Multi-API under one lease warning
  const wellboreData = wellboreResult?.data;
  const apiCount =
    typeof wellboreData?.["api_count"] === "number" ? wellboreData["api_count"] : null;

  if (apiCount !== null && apiCount > 1) {
    findings.push(
      makeFinding(
        "identity",
        "medium",
        "multiple_apis_on_lease",
        "Lease-Level Production Allocation Warning — Multiple Wells",
        `The lease record shows ${apiCount} API numbers. Production data for this lease cannot be ` +
        "attributed to any single wellbore without per-well allocation records. " +
        "This is a structural constraint of TRRC lease-level reporting.",
        {
          lease_number: ctx.lease_number,
          district: ctx.district,
          api_count: apiCount,
          can_claim_single_well_production: false,
        },
        [],
        "lease_api_count_analysis",
        0.85,
        "Obtain per-well allocation records or production test data before attributing " +
        "production volumes to the subject wellbore.",
        true,
      ),
    );
  }

  // Operator name discrepancy check
  const p5Result = source_data["p5_operator_query"];
  const wellboreOp =
    typeof wellboreData?.["operator_name"] === "string"
      ? (wellboreData["operator_name"] as string).toUpperCase().trim()
      : null;
  const p5Op =
    typeof p5Result?.data?.["operator_name"] === "string"
      ? (p5Result.data["operator_name"] as string).toUpperCase().trim()
      : null;

  if (
    wellboreOp &&
    p5Op &&
    wellboreOp !== p5Op &&
    !wellboreOp.startsWith(p5Op.slice(0, 10)) &&
    !p5Op.startsWith(wellboreOp.slice(0, 10))
  ) {
    findings.push(
      makeFinding(
        "identity",
        "medium",
        "operator_name_discrepancy",
        "Operator Name Discrepancy Between Lease and P-5 Records",
        `The operator name in the wellbore/lease inventory ("${wellboreOp}") does not match ` +
        `the P-5 query result ("${p5Op}"). This may indicate a name change, DBA, or ` +
        "that the P-5 query returned the wrong operator.",
        { lease_operator: wellboreOp, p5_operator: p5Op },
        [],
        "operator_name_cross_check",
        0.75,
        "Confirm the correct operator of record by requesting the current P-5 from TRRC " +
        "and comparing with the lease transfer history.",
        true,
      ),
    );
  }

  // If no identity findings yet, add a catch-all info note
  if (findings.length === 0) {
    findings.push(
      makeFinding(
        "identity",
        "info",
        "identity_check_complete",
        "Identity Check Complete",
        "No identity consistency issues detected in available records.",
        { input_type: ctx.input_type, normalized_input: ctx.normalized_input },
        [],
        "identity_cross_check",
        0.7,
        "No action required.",
        false,
      ),
    );
  }

  return findings;
}

// ─── Production findings ──────────────────────────────────────────────────────

function generateProductionFindings(
  ctx: ResolvedSearchContext,
  production: TrrcDDProductionRow[],
  coverage: SourceCoverageStatus[],
): TrrcFinding[] {
  const findings: TrrcFinding[] = [];

  const prodCoverage = coverage.find((c) => c.category === "production");

  if (production.length === 0) {
    // Check if production was actually queried or just not applicable
    const prodStatus = prodCoverage?.status;

    if (prodStatus === "no_applicable_record" || prodStatus === "not_checked") {
      findings.push(
        makeFinding(
          "production",
          "medium",
          "production_not_queried",
          "Production Data Not Retrieved",
          "Production records were not queried for this run, likely because a lease number " +
          "or API number could not be resolved. Production history is a core diligence data point.",
          { coverage_status: prodStatus },
          [],
          "coverage_gap_analysis",
          0.8,
          "Resolve the well or lease identifier and re-run to retrieve production history.",
          false,
        ),
      );
    } else {
      findings.push(
        makeFinding(
          "production",
          "critical",
          "no_production_records",
          "No Production Records Found",
          "No production records were found for this asset in any queried TRRC source. " +
          "This may indicate: (1) the well has never produced, (2) the identifier is incorrect, " +
          "(3) the operator reports under a different lease, or (4) the well is recently drilled " +
          "and has not yet filed production reports.",
          {
            sources_checked: prodCoverage?.sources_checked ?? [],
            coverage_status: prodCoverage?.status,
          },
          [],
          "production_record_absence_check",
          0.85,
          "Independently verify production via TRRC Wellbore Query and confirm the correct " +
          "lease number and district. Request prior operator run statements if available.",
          true,
        ),
      );
    }

    return findings;
  }

  // Sort production rows newest first
  const sortedProd = [...production].sort(
    (a, b) => monthToInt(b.production_month) - monthToInt(a.production_month),
  );

  const mostRecentMonth = sortedProd[0].production_month;
  const oldestMonth = sortedProd[sortedProd.length - 1].production_month;

  // Last production date check
  const now = new Date();
  const [recentYear, recentMonthNum] = mostRecentMonth.split("-").map(Number);
  const monthsAgo =
    (now.getFullYear() - recentYear) * 12 + (now.getMonth() + 1 - recentMonthNum);

  if (monthsAgo > 12) {
    findings.push(
      makeFinding(
        "production",
        "high",
        "last_production_stale",
        "Last Production Report Over 12 Months Ago",
        `The most recent production record is from ${mostRecentMonth} (approximately ${monthsAgo} months ago). ` +
        "This may indicate the well has been shut-in, plugged, or is no longer producing. " +
        "Note: TRRC reporting lags 60–90 days; recent months may not yet be reported.",
        {
          most_recent_month: mostRecentMonth,
          months_since_last_production: monthsAgo,
          reporting_lag_note: "TRRC reports lag 60–90 days from production month",
        },
        [],
        "production_recency_analysis",
        0.8,
        "Confirm well status through inactive well query and request current operator run statements.",
        true,
      ),
    );
  }

  // Zero production months in last 24
  const last24 = lastNMonths(sortedProd, 24);
  const zeroMonths = countZeroProductionMonths(last24);

  if (zeroMonths > 6) {
    findings.push(
      makeFinding(
        "production",
        "high",
        "extended_zero_production",
        `${zeroMonths} Zero-Production Months in Last 24 Months`,
        `${zeroMonths} of the last 24 reported months show zero production across all product types. ` +
        "Extended zero-production periods may indicate well mechanical issues, curtailment, " +
        "infrastructure constraints, or abandonment.",
        {
          zero_months_count: zeroMonths,
          window_months: 24,
          rows_in_window: last24.length,
        },
        [],
        "zero_production_month_count",
        0.85,
        "Review well status records and request an explanation from the operator for shut-in periods.",
        true,
      ),
    );
  }

  // Declining production check (last 12 months)
  const last12 = lastNMonths(sortedProd, 12);
  const last24b = lastNMonths(sortedProd, 24);
  const prior12 = last24b.filter((r) => !last12.includes(r));

  const recent12Total = totalBarrels(last12);
  const prior12Total = totalBarrels(prior12);

  if (prior12.length > 0 && prior12Total > 0) {
    const declinePercent = ((prior12Total - recent12Total) / prior12Total) * 100;

    if (declinePercent > 20) {
      findings.push(
        makeFinding(
          "production",
          "medium",
          "production_declining",
          `Production Declining — ${declinePercent.toFixed(0)}% Decline Over 12 Months`,
          `Liquid production (oil + condensate) declined approximately ${declinePercent.toFixed(0)}% ` +
          "comparing the most recent 12 months to the prior 12-month period. " +
          "This is consistent with natural decline but should be analyzed against type curve expectations.",
          {
            recent_12m_bbl: recent12Total,
            prior_12m_bbl: prior12Total,
            decline_percent: declinePercent,
            note: "Lease-level production only — cannot attribute to single wellbore",
          },
          [],
          "year_over_year_production_trend",
          0.75,
          "Obtain a reservoir engineer's assessment of decline curve trajectory and EUR estimate.",
          true,
        ),
      );
    }
  }

  // Missing production reports
  if (prodCoverage?.status === "partial") {
    findings.push(
      makeFinding(
        "production",
        "medium",
        "production_data_partial",
        "Production Data Incomplete — Some Sources Failed",
        "Production data was retrieved from at least one source but one or more sources " +
        "encountered errors. The production record may be incomplete.",
        {
          sources_checked: prodCoverage.sources_checked,
          records_found: prodCoverage.records_found,
          coverage_status: "partial",
        },
        [],
        "coverage_gap_analysis",
        0.7,
        "Review failed source attempts and consider re-running or querying the TRRC EWA directly.",
        false,
      ),
    );
  }

  // Positive finding: production data present
  const windowMonths = Math.min(36, sortedProd.length);
  findings.push(
    makeFinding(
      "production",
      "info",
      "production_records_found",
      `Production History Available — ${sortedProd.length} Months`,
      `Production records found spanning ${oldestMonth} through ${mostRecentMonth} ` +
      `(${sortedProd.length} months). ` +
      "IMPORTANT: This is lease-level production data. Single-well attribution requires " +
      "per-well allocation evidence.",
      {
        months_count: sortedProd.length,
        date_range: `${oldestMonth} to ${mostRecentMonth}`,
        window_analyzed_months: windowMonths,
        can_claim_single_well_production: false,
      },
      [],
      "production_record_availability_check",
      0.9,
      "Proceed with production analysis. Note lease-level limitation before quoting per-well volumes.",
      true,
    ),
  );

  return findings;
}

// ─── Compliance findings ──────────────────────────────────────────────────────

function generateComplianceFindings(
  source_data: Record<string, SourceSearchResult>,
  coverage: SourceCoverageStatus[],
): TrrcFinding[] {
  const findings: TrrcFinding[] = [];

  const iceResult = source_data["inspections_violations"];
  const complianceCoverage = coverage.find((c) => c.category === "compliance");

  if (!iceResult || iceResult.status === "not_applicable") {
    findings.push(
      makeFinding(
        "compliance",
        "info",
        "compliance_not_queried",
        "Compliance Records Not Queried",
        "Inspection and violation records were not retrieved for this run. " +
        "Compliance query requires an API number or lease number.",
        { coverage_status: complianceCoverage?.status ?? "not_checked" },
        [],
        "coverage_gap_analysis",
        0.7,
        "If an API number or lease number is available, re-run with that identifier to retrieve compliance records.",
        false,
      ),
    );
    return findings;
  }

  if (iceResult.status === "no_results") {
    findings.push(
      makeFinding(
        "compliance",
        "info",
        "no_violations_on_record",
        "No Violations Found (Aug 2015 – Present)",
        "The TRRC ICE violations database shows no violations for this asset from August 2015 onward. " +
        "This is a positive signal but does not cover pre-2015 records, which require the " +
        "downloadable historical dataset.",
        {
          sources_checked: ["inspections_violations"],
          coverage_window: "2015-08-01 to present",
        },
        [],
        "ice_violation_absence_check",
        0.85,
        "Consider reviewing pre-2015 violation history from the TRRC downloadable violations dataset.",
        true,
      ),
    );
    return findings;
  }

  if (iceResult.status === "failed_transient" || iceResult.status === "failed_permanent") {
    findings.push(
      makeFinding(
        "compliance",
        "medium",
        "compliance_retrieval_failed",
        "Compliance Record Retrieval Failed",
        "The TRRC ICE violations query failed to return results due to a technical error. " +
        "Compliance status is unknown.",
        { error: iceResult.error, status: iceResult.status },
        [],
        "ice_query_failure_analysis",
        0.8,
        "Manually query TRRC PDA ICE portal for violation history before proceeding.",
        false,
      ),
    );
    return findings;
  }

  // Parse violation data from the result
  const data = iceResult.data ?? {};
  const openViolations =
    typeof data["open_violations_count"] === "number"
      ? data["open_violations_count"]
      : iceResult.result_count;
  const recentViolationsCount =
    typeof data["violations_last_12m"] === "number"
      ? data["violations_last_12m"]
      : 0;
  const totalViolations =
    typeof data["total_violations_count"] === "number"
      ? data["total_violations_count"]
      : openViolations;

  // No inspection records at all
  if (iceResult.status === "success" && totalViolations === 0) {
    findings.push(
      makeFinding(
        "compliance",
        "low",
        "no_inspection_records",
        "No Inspection Records Found",
        "No field inspection records were found in the TRRC ICE database. " +
        "This may mean the well has not been inspected recently, or inspection records " +
        "are filed under a different identifier. Absence of inspection records is not " +
        "necessarily a negative indicator.",
        { sources_checked: ["inspections_violations"], records_found: 0 },
        [],
        "inspection_record_absence_check",
        0.7,
        "No immediate action required. Note that absence of records does not confirm compliance.",
        true,
      ),
    );
    return findings;
  }

  // Open violations severity
  if (openViolations >= 6) {
    findings.push(
      makeFinding(
        "compliance",
        "critical",
        "open_violations_critical",
        `${openViolations} Open Violations — Critical Compliance Exposure`,
        `${openViolations} open violations are on record with TRRC. ` +
        "A high number of unresolved violations represents significant regulatory exposure " +
        "and may affect the operator's ability to obtain new permits.",
        {
          open_violations_count: openViolations,
          total_violations_count: totalViolations,
          violations_last_12m: recentViolationsCount,
        },
        iceResult.records.map((r) => r.document_id),
        "ice_open_violation_count",
        0.9,
        "Obtain a full violation report and remediation status before proceeding. " +
        "Consult regulatory counsel.",
        true,
      ),
    );
  } else if (openViolations >= 3) {
    findings.push(
      makeFinding(
        "compliance",
        "high",
        "open_violations_high",
        `${openViolations} Open Violations`,
        `${openViolations} open violations are on record with TRRC for this asset.`,
        {
          open_violations_count: openViolations,
          total_violations_count: totalViolations,
        },
        iceResult.records.map((r) => r.document_id),
        "ice_open_violation_count",
        0.85,
        "Review each open violation and confirm remediation plan with current operator.",
        true,
      ),
    );
  } else if (openViolations > 0) {
    findings.push(
      makeFinding(
        "compliance",
        "medium",
        "open_violations_medium",
        `${openViolations} Open Violation${openViolations === 1 ? "" : "s"}`,
        `${openViolations} open violation${openViolations === 1 ? "" : "s"} on record with TRRC.`,
        {
          open_violations_count: openViolations,
          total_violations_count: totalViolations,
        },
        iceResult.records.map((r) => r.document_id),
        "ice_open_violation_count",
        0.8,
        "Review the open violation(s) and confirm resolution timeline with current operator.",
        true,
      ),
    );
  }

  // Recent violations
  if (recentViolationsCount > 0) {
    findings.push(
      makeFinding(
        "compliance",
        "high",
        "violations_in_last_12m",
        `${recentViolationsCount} Violation${recentViolationsCount === 1 ? "" : "s"} in Last 12 Months`,
        "Recent violations indicate active regulatory scrutiny of this asset or operator.",
        {
          violations_last_12m: recentViolationsCount,
          total_violations_count: totalViolations,
        },
        [],
        "ice_recent_violation_trend",
        0.8,
        "Request details on each recent violation and confirm current compliance status.",
        true,
      ),
    );
  }

  return findings;
}

// ─── Inactive well findings ───────────────────────────────────────────────────

function generateInactiveWellFindings(
  source_data: Record<string, SourceSearchResult>,
): TrrcFinding[] {
  const findings: TrrcFinding[] = [];

  const inactiveResult = source_data["inactive_well_query"];

  if (!inactiveResult || inactiveResult.status === "not_applicable") {
    findings.push(
      makeFinding(
        "plugging_inactive",
        "info",
        "inactive_check_not_run",
        "Inactive Well Check Not Run",
        "The TRRC inactive well query was not executed for this run.",
        {},
        [],
        "coverage_gap_analysis",
        0.6,
        "Include an API number in the next run to enable inactive well status check.",
        false,
      ),
    );
    return findings;
  }

  if (inactiveResult.status === "no_results") {
    findings.push(
      makeFinding(
        "plugging_inactive",
        "info",
        "well_not_on_inactive_list",
        "Well Not on TRRC Inactive List",
        "The well does not appear on the TRRC inactive/non-producing list. " +
        "This is a positive signal indicating the well is either actively producing or " +
        "exempt from the inactive well program.",
        { inactive_query_result: "no_match" },
        [],
        "inactive_well_list_absence_check",
        0.85,
        "No action required for inactive status.",
        true,
      ),
    );
    return findings;
  }

  if (inactiveResult.status !== "success") {
    findings.push(
      makeFinding(
        "plugging_inactive",
        "medium",
        "inactive_check_failed",
        "Inactive Well Status Check Failed",
        "The TRRC inactive well query returned an error. Inactive status is unknown.",
        { error: inactiveResult.error, status: inactiveResult.status },
        [],
        "inactive_query_failure",
        0.7,
        "Manually query the TRRC inactive well database before proceeding.",
        false,
      ),
    );
    return findings;
  }

  // Well found on inactive list
  const data = inactiveResult.data ?? {};
  const shutInDate =
    typeof data["shut_in_date"] === "string" ? data["shut_in_date"] : null;
  const inactiveSince =
    typeof data["inactive_since"] === "string" ? data["inactive_since"] : shutInDate;
  const pluggingCostEstimate =
    typeof data["estimated_plugging_cost"] === "number"
      ? data["estimated_plugging_cost"]
      : null;

  // Calculate years inactive if date is available
  let yearsInactive: number | null = null;
  if (inactiveSince) {
    const sinceYear = parseInt(inactiveSince.slice(0, 4), 10);
    if (!isNaN(sinceYear)) {
      yearsInactive = new Date().getFullYear() - sinceYear;
    }
  }

  const severity: FindingSeverity = yearsInactive !== null && yearsInactive > 5 ? "high" : "medium";

  findings.push(
    makeFinding(
      "plugging_inactive",
      severity,
      "well_inactive_confirmed",
      yearsInactive !== null && yearsInactive > 5
        ? `Well Inactive for ${yearsInactive}+ Years — Plugging Obligation Flag`
        : "Well on TRRC Inactive List — Plugging Obligation Flag",
      "This wellbore appears on the TRRC inactive well list, triggering a potential plugging obligation. " +
      "Acquiring an inactive well may transfer plugging liability to the buyer.",
      {
        shut_in_date: shutInDate,
        inactive_since: inactiveSince,
        years_inactive: yearsInactive,
        estimated_plugging_cost_usd: pluggingCostEstimate,
        plugging_liability_transfers_on_acquisition: true,
      },
      inactiveResult.records.map((r) => r.document_id),
      "inactive_well_list_match",
      0.9,
      yearsInactive !== null && yearsInactive > 5
        ? "Obtain a plugging cost estimate from a licensed well service contractor. " +
          "Factor plugging liability into acquisition economics. Consider requesting TRRC re-entry permit review."
        : "Confirm current well status and reason for inactive designation. " +
          "Assess whether return to production is feasible before acquisition.",
      true,
    ),
  );

  return findings;
}

// ─── Manual required findings ─────────────────────────────────────────────────

function generateManualRequiredFindings(
  source_data: Record<string, SourceSearchResult>,
): TrrcFinding[] {
  const findings: TrrcFinding[] = [];

  const manualSources = Object.values(source_data).filter(
    (r) => r.status === "manual_required",
  );

  for (const ms of manualSources) {
    findings.push(
      makeFinding(
        "miscellaneous",
        "info",
        "manual_retrieval_required",
        `Manual Retrieval Required — ${ms.source_id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
        `The source "${ms.source_id}" requires manual analyst retrieval. ` +
        "Automated access is unavailable due to CAPTCHA, browser-rendering requirements, " +
        "or other access barriers. See the manual_action_url for direct access.",
        {
          source_id: ms.source_id,
          manual_action_url: ms.manual_action_url,
          reason: "Manual retrieval strategy — automated access blocked",
        },
        [],
        "manual_fallback_source_detection",
        1.0,
        `Navigate to ${ms.manual_action_url ?? "the source URL"} and manually retrieve records. ` +
        "Document any findings in the acquisition file.",
        false,
      ),
    );
  }

  return findings;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runFindingEngine(
  _run_id: string,
  ctx: ResolvedSearchContext,
  orchestrator_result: OrchestratorResult,
  source_data: Record<string, SourceSearchResult>,
): Promise<TrrcFinding[]> {
  const findings: TrrcFinding[] = [];

  // 1. Identity consistency
  findings.push(...generateIdentityFindings(ctx, source_data));

  // 2. Production
  findings.push(
    ...generateProductionFindings(ctx, orchestrator_result.production, orchestrator_result.coverage),
  );

  // 3. Compliance
  findings.push(...generateComplianceFindings(source_data, orchestrator_result.coverage));

  // 4. Inactive well / plugging
  findings.push(...generateInactiveWellFindings(source_data));

  // 5. Manual required notices
  findings.push(...generateManualRequiredFindings(source_data));

  return findings;
}
