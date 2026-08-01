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

  // wellStatusQueryAction.do (fetch_well_status) has no real replacement on
  // TRRC's current EWA — confirmed live, it isn't linked anywhere on the
  // real menu and no equivalent standalone query exists in the modern app.
  // But TRRC's own public GIS well-locations layer (already queried
  // successfully by fetch_gis_plat on nearly every run) encodes real,
  // TRRC-sourced status in its map-symbol field — GIS_SYMBOL_DESCRIPTION
  // returns values like "Oil Well", "Plugged Oil Well", "Permitted
  // Location" (confirmed live against real offset wells, which already
  // surface this exact field for nearby wells on the Section 7 map). This
  // is genuine retrieved data, not an inference from absence, so when the
  // dedicated well-status query fails but GIS succeeded with a real value,
  // credit the well_status category from that instead of leaving it
  // permanently "retrieval_failed" for a source that can never succeed.
  const wellStatusIdx = coverage.findIndex(c => c.category === "well_status");
  const gisAttempt = attempts.find(a => a.source_name === "fetch_gis_plat" && a.status === "success");
  const gisWellType = typeof gisAttempt?.result_data_json?.["well_type"] === "string"
    ? (gisAttempt.result_data_json["well_type"] as string).trim()
    : "";
  if (wellStatusIdx !== -1 && coverage[wellStatusIdx].status !== "complete" && gisWellType) {
    coverage[wellStatusIdx] = {
      category: "well_status",
      label: "Well Status (Active/Inactive/Plugged)",
      status: "complete",
      records_found: 1,
      data_current_through: new Date().toISOString().slice(0, 10),
      sources_checked: ["fetch_gis_plat"],
      notes: `Derived from RRC GIS map symbol: "${gisWellType}". wellStatusQueryAction.do has no working replacement on TRRC's current EWA.`,
    };
  }

  // pluggingQueryAction.do is dead the same way (confirmed live, including
  // via a real established browser session — genuine server error, not a
  // request-format issue) with no working replacement found. But the same
  // GIS map symbol lets us answer the one thing that actually matters here
  // honestly: when GIS shows the well is NOT plugged, a W-3C plugging
  // certificate genuinely would not exist to find — that's a real,
  // TRRC-sourced confirmed-absence, not a guess. When GIS DOES show a
  // plugged symbol, this stays retrieval_failed rather than fabricating
  // plugging-certificate details (date, depths, cement volumes) we have no
  // way to actually retrieve — that gap is real and stays flagged.
  const pluggingIdx = coverage.findIndex(c => c.category === "plugging");
  if (pluggingIdx !== -1 && coverage[pluggingIdx].status === "retrieval_failed" && gisWellType) {
    if (!/plugged/i.test(gisWellType)) {
      coverage[pluggingIdx] = {
        category: "plugging",
        label: "Plugging Records (W-3C)",
        status: "no_applicable_record",
        records_found: 0,
        data_current_through: new Date().toISOString().slice(0, 10),
        sources_checked: ["fetch_gis_plat"],
        notes: `RRC GIS shows this well as "${gisWellType}", not plugged — no W-3C record expected. pluggingQueryAction.do has no working replacement on TRRC's current EWA to independently confirm.`,
      };
    } else {
      coverage[pluggingIdx] = {
        ...coverage[pluggingIdx],
        notes: `RRC GIS shows this well as "${gisWellType}" — a W-3C plugging certificate likely exists but pluggingQueryAction.do (the only source for its actual filing details) has no working replacement. Manual verification required.`,
      };
    }
  }

  return coverage;
}
