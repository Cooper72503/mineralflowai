/**
 * Derives per-source coverage status from raw trrc_source_attempts rows.
 *
 * This is the single source of truth for turning attempt rows into the
 * SourceCoverageStatus[] shape used by the PDF report, the ZIP manifest, and
 * the dashboard. It used to be duplicated inline in the /report route only —
 * the /archive route read a stale/always-empty coverage_json column instead,
 * since nothing in the current worker pipeline ever writes that column.
 */

import type { SourceCoverageStatus } from "./types";

export type LiteSourceAttempt = {
  source_id: string;
  source_name: string;
  status: string;
  result_count: number;
  error_message: string | null;
  attempted_at: string;
  result_data_json: Record<string, unknown> | null;
};

// Every key here must be a source_name the worker actually writes (see the
// `sourceName = "..."` assignments in worker/src/agent.ts's dispatchTool) —
// confirmed live: "legal_description" was previously keyed to
// search_by_legal_description, a source name nothing in the worker ever
// writes, while fetch_gis_plat (the real GIS/survey fetcher, which succeeds
// on most runs and is what Section 6 of the PDF actually renders) wasn't in
// this map at all. Every run's real, successfully-retrieved GIS data was
// therefore invisible to coverage/completeness scoring — this dragged down
// the "Record Completeness" scorecard dimension on every single run,
// regardless of what was actually retrieved. A "fetch_proration" entry with
// the same problem (no such fetcher exists anywhere in the worker — no
// automated Proration data source has been built) was removed rather than
// pointed at a real source, since there isn't one; it's an unimplemented
// feature, not an operational gap.
export const TOOL_COVERAGE_MAP: Record<string, { category: string; label: string }> = {
  search_by_api:              { category: "wellbore_identity",  label: "Well Identity (API Lookup)" },
  search_by_lease:            { category: "lease_inventory",    label: "Lease Inventory" },
  search_by_operator:         { category: "operator_p5",        label: "Operator / P5 Organization" },
  fetch_gis_plat:              { category: "legal_description",  label: "Legal Description (GIS)" },
  fetch_production:           { category: "production",         label: "Production History (Proration Proxy)" },
  fetch_completion_records:   { category: "completion",         label: "Completion Records (W-2)" },
  fetch_well_status:          { category: "well_status",        label: "Well Status (Active/Inactive/Plugged)" },
  fetch_inactive_well_status: { category: "inactive_well",      label: "Inactive Well Aging Report (IWAR)" },
  fetch_orphan_well:          { category: "orphan_well",        label: "Orphan Well / P5 Insolvent Operator" },
  fetch_plugging_records:     { category: "plugging",           label: "Plugging Records (W-3C)" },
  fetch_compliance_violations:{ category: "compliance",         label: "Compliance Violations" },
  fetch_p4_records:           { category: "p4_records",         label: "P-4 Gatherer/Purchaser Records" },
  fetch_injection_records:    { category: "injection",          label: "UIC / Injection Well Records" },
  fetch_severance_records:    { category: "severance",          label: "Wellbore Severance Records" },
  fetch_coda_records:         { category: "imaged_records",     label: "Imaged Document Packets (CODA)" },
  fetch_drilling_permits:     { category: "drilling_permits",   label: "Drilling Permit Records (W-1)" },
  fetch_county_records:       { category: "county_records",     label: "County Real Property Records (Deeds/Leases)" },
};

export function deriveCoverageFromAttempts(attempts: LiteSourceAttempt[]): SourceCoverageStatus[] {
  const coverage: SourceCoverageStatus[] = [];
  const seen = new Set<string>();

  for (const a of attempts) {
    if (a.source_name === "submit_report") continue;
    const meta = TOOL_COVERAGE_MAP[a.source_name];
    if (!meta || seen.has(meta.category)) continue;
    seen.add(meta.category);

    const data = a.result_data_json ?? {};
    const isDataGap = data["data_gap"] === true || data["endpoint_available"] === false;
    const found = data["found"];

    let status: SourceCoverageStatus["status"];
    let notes: string | null = null;

    if (a.status === "failed_transient" || a.status === "failed_permanent") {
      status = "retrieval_failed";
      notes = a.error_message?.slice(0, 120) ?? "Query failed.";
    } else if (isDataGap) {
      status = "manual_required";
      notes = typeof data["message"] === "string" ? data["message"].slice(0, 120) : "Automated access unavailable — manual review required via TRRC EWA.";
    } else if (found === false) {
      status = "no_applicable_record";
      notes = typeof data["message"] === "string" ? data["message"].slice(0, 120) : "No records found.";
    } else {
      status = a.result_count > 0 ? "complete" : "partial";
      notes = a.result_count > 0 ? `${a.result_count} record(s) retrieved.` : "Query succeeded but returned 0 rows.";
    }

    coverage.push({
      category: meta.category,
      label: meta.label,
      status,
      records_found: a.result_count,
      data_current_through: new Date().toISOString().slice(0, 10),
      sources_checked: [a.source_name],
      notes,
    });
  }

  // Fill in "not_checked" for any tool never called
  for (const [, meta] of Object.entries(TOOL_COVERAGE_MAP)) {
    if (!seen.has(meta.category)) {
      coverage.push({
        category: meta.category,
        label: meta.label,
        status: "not_checked",
        records_found: 0,
        data_current_through: null,
        sources_checked: [],
        notes: null,
      });
    }
  }

  return coverage;
}
