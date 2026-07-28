/**
 * Evidence Index — a per-source ledger of exactly what was queried, where,
 * and what came back, for a due diligence run.
 *
 * Portal URLs and query-criteria descriptions here are deliberately NOT
 * pre-filled deep links. Live testing (2026-07-27) confirmed TRRC's EWA
 * endpoints are inconsistent about honoring a bookmarkable GET query string
 * — wellboreQueryAction.do executes a real search via plain GET, but several
 * others (organizationQueryAction.do among them) just re-render the blank
 * search form unless the request carries a real session + JSF ViewState
 * token, which only the worker's authenticated POST flow establishes.
 * Shipping "click here to verify" links that silently fail for some sources
 * would be worse than no link — an analyst re-running the search by hand
 * from the portal's own form, using the criteria listed here, always works.
 */

import type { TrrcDueDiligenceRun } from "./types";
import type { LiteSourceAttempt } from "./coverage";

export type EvidenceIndexEntry = {
  source_name: string;
  label: string;
  portal: string;
  portal_url: string;
  query_criteria: string;
  status: "retrieved" | "confirmed_absent" | "manual_required" | "retrieval_failed" | "not_attempted";
  status_note: string;
  record_count: number;
  retrieved_at: string | null;
};

const EWA_MENU_URL = "https://webapps2.rrc.texas.gov/EWA/ewaMain.do";
const PDA_ICE_URL = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";
const GIS_VIEWER_URL = "https://gis.rrc.texas.gov/GISViewer/index.html";

const SOURCE_META: Record<string, { label: string; portal: string; portal_url: string }> = {
  search_by_api:               { label: "S1 — Wellbore Identity",             portal: "TRRC EWA — Wellbore Query",              portal_url: EWA_MENU_URL },
  search_by_lease:              { label: "S2 — Lease Well Inventory",          portal: "TRRC EWA — Lease Well Query",            portal_url: EWA_MENU_URL },
  search_by_operator:           { label: "S3 — P-5 Operator Registration",     portal: "TRRC EWA — Organization (P-5) Query",    portal_url: EWA_MENU_URL },
  fetch_well_status:            { label: "S4 — Well Status",                   portal: "TRRC EWA — Well Status Query",           portal_url: EWA_MENU_URL },
  fetch_inactive_well_status:   { label: "S5 — Inactive Well Designation",     portal: "TRRC EWA — Inactive Well Aging Report",  portal_url: EWA_MENU_URL },
  fetch_orphan_well:            { label: "S6 — Orphan Well Program",           portal: "TRRC EWA — Orphan Well Query",           portal_url: EWA_MENU_URL },
  fetch_severance_records:      { label: "S7 — Severance Tax Records",         portal: "TRRC EWA — Severance Query",             portal_url: EWA_MENU_URL },
  fetch_production:             { label: "S8 — Monthly Production",            portal: "TRRC EWA — Production Query",            portal_url: EWA_MENU_URL },
  fetch_p4_records:             { label: "S9 — P-4 Production Tests",          portal: "TRRC EWA — P-4 Test Query",              portal_url: EWA_MENU_URL },
  fetch_completion_records:     { label: "S10 — W-2 Completion Record",        portal: "TRRC EWA — Completion Query",            portal_url: EWA_MENU_URL },
  fetch_plugging_records:       { label: "S11 — Plugging Records (W-3C)",      portal: "TRRC EWA — Plugging Query",              portal_url: EWA_MENU_URL },
  fetch_coda_records:           { label: "S12 — CODA Imaged Documents",        portal: "TRRC CODA — Imaged Records",             portal_url: "https://webapps2.rrc.texas.gov/EWA/cogisQueryAction.do" },
  fetch_compliance_violations:  { label: "S13 — Compliance Violations",        portal: "TRRC PDA ICE — Inspection & Compliance", portal_url: PDA_ICE_URL },
  fetch_injection_records:      { label: "S14 — UIC / Injection Permits",      portal: "TRRC EWA — Injection/Disposal Query",    portal_url: EWA_MENU_URL },
  fetch_glo_survey:             { label: "S15 — Texas GLO Survey",             portal: "Texas GLO — Land Survey Records",        portal_url: "https://www.glo.texas.gov" },
  fetch_gis_plat:               { label: "S16 — RRC GIS / Plat Map",           portal: "TRRC GIS Viewer",                        portal_url: GIS_VIEWER_URL },
  fetch_drilling_permits:       { label: "S17 — Drilling Permit Records (W-1)", portal: "TRRC EWA — Drilling Permit (W-1) Query", portal_url: EWA_MENU_URL },
};

function describeQueryCriteria(sourceName: string, run: TrrcDueDiligenceRun): string {
  const api = run.resolved_primary_api;
  const lease = run.resolved_lease_number;
  const district = run.resolved_district;
  const operatorNo = run.resolved_operator_number;

  switch (sourceName) {
    case "search_by_lease":
    case "fetch_production":
    case "fetch_severance_records":
      return lease && district ? `Lease ${lease}, District ${district}` : (run.original_input ?? "—");
    case "search_by_operator":
      return operatorNo ? `Operator No. ${operatorNo}` : (run.original_input ?? "—");
    case "fetch_compliance_violations":
      return operatorNo ? `Operator No. ${operatorNo}` : api ? `API ${api}` : (run.original_input ?? "—");
    default:
      return api ? `API ${api}` : (run.original_input ?? "—");
  }
}

export function buildEvidenceIndex(
  attempts: LiteSourceAttempt[],
  run: TrrcDueDiligenceRun,
): EvidenceIndexEntry[] {
  const seen = new Set<string>();
  const entries: EvidenceIndexEntry[] = [];

  for (const a of attempts) {
    if (a.source_name === "submit_report") continue;
    if (seen.has(a.source_name)) continue;
    const meta = SOURCE_META[a.source_name];
    if (!meta) continue;
    seen.add(a.source_name);

    const d = a.result_data_json ?? {};
    let status: EvidenceIndexEntry["status"];
    let statusNote: string;

    if (a.status !== "success") {
      status = "retrieval_failed";
      statusNote = a.error_message ?? "Query failed.";
    } else if (d["data_gap"] === true || d["endpoint_available"] === false) {
      status = "manual_required";
      statusNote = "Automated access unavailable — manual review required via the portal above.";
    } else if (d["found"] === false) {
      status = "confirmed_absent";
      statusNote = "TRRC returned no records for this query.";
    } else {
      status = "retrieved";
      statusNote = `${a.result_count} record(s) retrieved.`;
    }

    entries.push({
      source_name: a.source_name,
      label: meta.label,
      portal: meta.portal,
      portal_url: meta.portal_url,
      query_criteria: describeQueryCriteria(a.source_name, run),
      status,
      status_note: statusNote,
      record_count: a.result_count,
      retrieved_at: a.attempted_at,
    });
  }

  // List sources never attempted too, so the index is a complete accounting
  // of every source this pipeline supports — not just the ones that ran.
  for (const [sourceName, meta] of Object.entries(SOURCE_META)) {
    if (seen.has(sourceName)) continue;
    entries.push({
      source_name: sourceName,
      label: meta.label,
      portal: meta.portal,
      portal_url: meta.portal_url,
      query_criteria: describeQueryCriteria(sourceName, run),
      status: "not_attempted",
      status_note: "Not attempted for this run.",
      record_count: 0,
      retrieved_at: null,
    });
  }

  return entries;
}
