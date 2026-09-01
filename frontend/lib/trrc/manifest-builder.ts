/**
 * TRRC Public Records Due Diligence — Manifest Builder
 *
 * Builds the complete JSON manifest documenting every search, match, file, result, and failure.
 * The manifest is the audit trail for the entire DD run.
 */

import type {
  TrrcDueDiligenceRun,
  ResolvedSearchContext,
  TrrcFinding,
  AcquisitionScorecard,
  SourceCoverageStatus,
  TrrcIdentifierType,
  ResolvedEntity,
  SourceAttempt,
  SourceRecordRef,
  TrrcRecordCategory,
  TrrcMissingItem,
  OrchestratorResult,
} from "./types";

// ─── Manifest type ────────────────────────────────────────────────────────────

export type TrrcManifest = {
  schema_version: "1.0";
  app_version: string;
  run_id: string;
  user_input: string;
  normalized_input: string;
  input_type: TrrcIdentifierType;
  resolution_history: string[];
  selected_entities: ResolvedEntity[];
  candidate_entities: ResolvedEntity[];
  retrieval_started_at: string;
  retrieval_completed_at: string;
  source_registry_version: string;
  source_attempts: SourceAttempt[];
  discovered_records: SourceRecordRef[];
  downloaded_files: {
    filename: string;
    sha256: string;
    size: number;
    category: TrrcRecordCategory;
    url: string;
  }[];
  failed_downloads: { url: string; error: string }[];
  manual_retrieval_required: { source: string; url: string; description: string }[];
  production_records_count: number;
  findings: TrrcFinding[];
  missing_items: TrrcMissingItem[];
  scorecard: AcquisitionScorecard;
  coverage: SourceCoverageStatus[];
  report_assumptions: string[];
  disclaimer: string;
  generated_at: string;
};

// ─── Standard disclaimer ──────────────────────────────────────────────────────

const DISCLAIMER =
  "MineralFlow AI compiles and analyzes publicly available regulatory information for preliminary " +
  "acquisition screening. This report is not a title opinion, reserve report, engineering certification, " +
  "environmental assessment, legal opinion, or substitute for independent due diligence. " +
  "Public records may be incomplete, delayed, amended, incorrectly indexed, or unavailable online.";

// ─── Standard assumptions ─────────────────────────────────────────────────────

const BASE_ASSUMPTIONS: string[] = [
  "All production data is lease-level; single-well attribution requires per-well allocation evidence.",
  "canClaimSingleWellProduction is always false for lease-level sources.",
  "TRRC production reporting lags 60–90 days from the production month.",
  "Violations search covers August 1, 2015 to present only; pre-2015 records require the downloadable dataset.",
  "GIS coordinates for vintage vertical wells may reflect county centroids rather than actual surface locations.",
  "Manual fallback sources were not automatically retrieved; records must be obtained by the analyst.",
  "This analysis was performed at a single point in time; TRRC records change continuously.",
  "County-to-district mapping uses the primary district for counties that straddle district boundaries.",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect all SourceRecordRef objects from all source attempts.
 * The orchestrator stores records in source attempts; we re-derive them here
 * from the attempt result_count since the full record list lives in SourceSearchResult.
 * In practice, callers should pass a flattened list; we derive what we can from attempts.
 */
function collectDiscoveredRecords(
  orchestrator_result: OrchestratorResult,
): SourceRecordRef[] {
  // The orchestrator stores raw findings_raw but not individual SourceRecordRef arrays.
  // We build synthetic refs from the attempt metadata for completeness.
  const refs: SourceRecordRef[] = [];

  for (const attempt of orchestrator_result.source_attempts) {
    if (attempt.status !== "success") continue;
    // Build a placeholder ref for each result count
    // (concrete record refs would come from the SourceSearchResult in a full pipeline)
    for (let i = 0; i < attempt.result_count; i++) {
      refs.push({
        source_id: attempt.source_id,
        document_id: `${attempt.source_id}_result_${i + 1}`,
        title: `${attempt.source_name} — Record ${i + 1}`,
        category: "miscellaneous",
        form_type: null,
        url: attempt.request_url ?? null,
        filing_date: null,
        is_downloadable: false,
      });
    }
  }

  return refs;
}

/**
 * Build manual_retrieval_required entries from source attempts that are manual_required.
 */
function buildManualRequiredEntries(
  orchestrator_result: OrchestratorResult,
): Array<{ source: string; url: string; description: string }> {
  return orchestrator_result.source_attempts
    .filter((a) => a.status === "manual_required")
    .map((a) => ({
      source: a.source_name,
      url: a.manual_action_url ?? a.request_url ?? "",
      description:
        `Manual retrieval required for ${a.source_name}. ` +
        "Automated access unavailable due to CAPTCHA, browser rendering requirements, or other access barriers. " +
        "Navigate to the provided URL to retrieve records.",
    }));
}

/**
 * Derive missing items from coverage gaps and failed attempts.
 */
function deriveMissingItems(
  orchestrator_result: OrchestratorResult,
  coverage: SourceCoverageStatus[],
): TrrcMissingItem[] {
  const items: TrrcMissingItem[] = [];
  let idx = 0;

  for (const cov of coverage) {
    // "not_checked" is deliberately NOT skipped here — a source that was
    // never queried at all is a coverage gap, not a confirmed-clean result,
    // and must surface in missing_items rather than disappear silently.
    if (
      cov.status === "complete" ||
      cov.status === "no_applicable_record"
    ) {
      continue;
    }

    const statusMap: Record<SourceCoverageStatus["status"], TrrcMissingItem["status"]> = {
      complete: "confirmed_no_record",
      partial: "no_result_from_query",
      no_applicable_record: "confirmed_no_record",
      retrieval_failed: "retrieval_failed",
      manual_required: "manual_required",
      not_checked: "source_unavailable",
    };

    items.push({
      id: `missing_${idx++}_${cov.category}`,
      category: cov.category as TrrcMissingItem["category"],
      expected_record_type: cov.label,
      status: statusMap[cov.status],
      explanation:
        cov.status === "manual_required"
          ? `Records in category "${cov.label}" require manual analyst retrieval.`
          : cov.status === "retrieval_failed"
          ? `Automated retrieval failed for "${cov.label}" — records may exist but could not be fetched.`
          : cov.status === "not_checked"
          ? `Source "${cov.label}" was never queried during this run.`
          : `Partial or incomplete data for "${cov.label}".`,
      source_checked: cov.sources_checked.join(", "),
      manual_retrieval_url: null,
      recommended_action:
        cov.status === "manual_required"
          ? "Manually retrieve records from the source URL and document findings."
          : cov.status === "not_checked"
          ? "Run this source's query and document the result."
          : "Re-run the query or manually verify through the TRRC EWA portal.",
    });
  }

  // Also include failed attempts not already captured in coverage
  for (const attempt of orchestrator_result.source_attempts) {
    if (
      attempt.status !== "failed_transient" &&
      attempt.status !== "failed_permanent"
    ) {
      continue;
    }

    items.push({
      id: `missing_${idx++}_attempt_${attempt.source_id}`,
      category: "miscellaneous",
      expected_record_type: attempt.source_name,
      status: "retrieval_failed",
      explanation: `Source "${attempt.source_name}" failed after ${attempt.retry_count} attempt(s): ${attempt.error_message ?? "unknown error"}`,
      source_checked: attempt.source_id,
      manual_retrieval_url: attempt.request_url ?? null,
      recommended_action: "Re-run the query or check source availability. Consider manual retrieval.",
    });
  }

  return items;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function buildManifest(
  run: TrrcDueDiligenceRun,
  ctx: ResolvedSearchContext,
  orchestrator_result: OrchestratorResult,
  findings: TrrcFinding[],
  scorecard: AcquisitionScorecard,
  app_version: string,
): TrrcManifest {
  const now = new Date().toISOString();

  // Entities from the run's joined data
  const selected_entities = (run.entities ?? []).filter((e) => e.is_user_selected);
  const candidate_entities = (run.entities ?? []).filter((e) => !e.is_user_selected);

  const discovered_records = collectDiscoveredRecords(orchestrator_result);
  const manual_retrieval_required = buildManualRequiredEntries(orchestrator_result);
  const missing_items = deriveMissingItems(orchestrator_result, orchestrator_result.coverage);

  // Build additional assumptions from context
  const contextAssumptions: string[] = [...BASE_ASSUMPTIONS];

  if (ctx.api_numbers.length > 1) {
    contextAssumptions.push(
      `Multiple API numbers were in scope for this run: ${ctx.api_numbers.map((a) => a.formatted).join(", ")}.`,
    );
  }

  if (!ctx.district) {
    contextAssumptions.push(
      "District was not provided or could not be inferred — some source queries may have been skipped.",
    );
  }

  if (orchestrator_result.manual_required_count > 0) {
    contextAssumptions.push(
      `${orchestrator_result.manual_required_count} source(s) required manual retrieval and are not included in automated results.`,
    );
  }

  return {
    schema_version: "1.0",
    app_version,
    run_id: run.id,
    user_input: run.original_input,
    normalized_input: run.normalized_input,
    input_type: run.selected_input_type,
    resolution_history: [], // populated by caller from EntityResolutionResult.resolution_trace
    selected_entities,
    candidate_entities,
    retrieval_started_at: run.started_at,
    retrieval_completed_at: run.completed_at ?? now,
    source_registry_version: "1.0.0",
    source_attempts: orchestrator_result.source_attempts,
    discovered_records,
    downloaded_files: [], // populated by caller when files are actually downloaded
    failed_downloads: [], // populated by caller on download errors
    manual_retrieval_required,
    production_records_count: orchestrator_result.production.length,
    findings,
    missing_items,
    scorecard,
    coverage: orchestrator_result.coverage,
    report_assumptions: contextAssumptions,
    disclaimer: DISCLAIMER,
    generated_at: now,
  };
}
