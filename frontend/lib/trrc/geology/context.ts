/**
 * Subject asset resolution for the Geological Due Diligence Engine.
 *
 * Deliberately does NOT re-resolve identity (API, lease, district, operator)
 * — the existing TRRC due-diligence run already did that (see
 * trrc_due_diligence_runs.resolved_primary_api etc., migration 019). This
 * module's only new work is fetching the one thing that pipeline doesn't
 * store: the subject well's lat/long, needed as the center point for the
 * 1/3/5-mile offset search in offsets.ts.
 *
 * Uses the same TRRC public ArcGIS "Well Locations" layer (MapServer/1)
 * already proven live this session (worker/src/tools/ewa.ts's
 * getGisLocation, offset-analytics/well-search.ts) — not a new data source,
 * just a direct point lookup by API instead of a radius search.
 */

import type { SubjectAssetContext, WarningEntry } from "./types";

const GIS_MAPSERVER_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

/** Minimal shape of the fields this module actually reads off an existing trrc_due_diligence_runs row — callers pass the row they already loaded rather than this module re-querying Supabase itself. */
export interface ResolvedRunIdentity {
  resolved_primary_api: string | null;
  resolved_district: string | null;
  resolved_lease_number: string | null;
  resolved_operator_number: string | null;
  resolved_operator_name?: string | null;
}

// Real bug, same class as production-loader.ts's splitApi (fixed live
// 2026-08-10) and agent.ts's resolved_primary_api persistence (fixed live
// 2026-08-13): TRRC's own "API" values show up in this codebase in two
// real shapes — the bare 8-digit "county+well" form (what
// wellboreQueryAction.do's confirmed api_no field returns, and what
// agent.ts now persists into resolved_primary_api) and the 10+-digit
// state-prefixed form (what a user often types, "42-329-42230"). This
// function only ever accepted the second, so a real, fully-resolved
// subject well with resolved_primary_api = "32942230" (8 digits, TRRC-
// confirmed) still failed as INVALID_API_NUMBER — the same
// "structurally correct but silently unusable" failure mode, just one
// layer further down the chain than the one already fixed today.
function fullApiToApi8(apiNumber: string): string | null {
  const digits = apiNumber.replace(/\D/g, "");
  if (digits.length === 8) return digits;
  if (digits.length >= 10) return digits.slice(2, 10);
  return null;
}

async function fetchSubjectLocation(apiNumber: string): Promise<{ latitude: number | null; longitude: number | null; sourceUrlOrQueryId: string | null; warnings: WarningEntry[] }> {
  const warnings: WarningEntry[] = [];
  const api8 = fullApiToApi8(apiNumber);
  if (!api8) {
    warnings.push({ code: "INVALID_API_NUMBER", message: `API number "${apiNumber}" does not have enough digits to resolve a district/county/well suffix`, severity: "critical" });
    return { latitude: null, longitude: null, sourceUrlOrQueryId: null, warnings };
  }
  const url = `${GIS_MAPSERVER_BASE}/1/query?f=json&where=API%3D%27${api8}%27&outFields=*&returnGeometry=false`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      warnings.push({ code: "GIS_LOCATION_HTTP_ERROR", message: `TRRC GIS well layer returned HTTP ${res.status} for API ${apiNumber}`, severity: "critical" });
      return { latitude: null, longitude: null, sourceUrlOrQueryId: url, warnings };
    }
    const json = await res.json() as { features?: Array<{ attributes?: Record<string, unknown> }> };
    const feat = json.features?.[0];
    if (!feat) {
      warnings.push({ code: "GIS_LOCATION_NOT_FOUND", message: `Well API ${apiNumber} not found in TRRC's public GIS well-location database — offset/spatial analysis cannot run without a subject location`, severity: "critical" });
      return { latitude: null, longitude: null, sourceUrlOrQueryId: url, warnings };
    }
    const lat = Number(feat.attributes?.["GIS_LAT83"]);
    const lng = Number(feat.attributes?.["GIS_LONG83"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      warnings.push({ code: "GIS_LOCATION_MISSING_COORDINATES", message: `TRRC GIS record for API ${apiNumber} was found but has no usable NAD83 coordinates`, severity: "critical" });
      return { latitude: null, longitude: null, sourceUrlOrQueryId: url, warnings };
    }
    return { latitude: lat, longitude: lng, sourceUrlOrQueryId: url, warnings };
  } catch (e) {
    warnings.push({ code: "GIS_LOCATION_FETCH_FAILED", message: `TRRC GIS well layer request failed for API ${apiNumber}: ${String(e).slice(0, 150)}`, severity: "critical" });
    return { latitude: null, longitude: null, sourceUrlOrQueryId: url, warnings };
  }
}

export async function resolveGeologySubjectContext(run: ResolvedRunIdentity, extras?: { county?: string | null; wellName?: string | null; targetFormation?: string | null; producingFormation?: string | null; wellStatus?: string | null }): Promise<SubjectAssetContext> {
  const retrievedAt = new Date().toISOString();

  if (!run.resolved_primary_api) {
    return {
      apiNumber: "", leaseNumber: run.resolved_lease_number, district: run.resolved_district,
      operatorNumber: run.resolved_operator_number, operatorName: extras?.wellName ? null : (run.resolved_operator_name ?? null),
      wellName: extras?.wellName ?? null, county: extras?.county ?? null,
      latitude: null, longitude: null,
      targetFormation: extras?.targetFormation ?? null, producingFormation: extras?.producingFormation ?? null,
      wellStatus: extras?.wellStatus ?? null,
      sourceUrlOrQueryId: null, retrievedAt,
      warnings: [{ code: "NO_SUBJECT_API", message: "This run has no resolved API number — geological due diligence requires a specific well identifier and cannot run against a lease-only or operator-only run", severity: "critical" }],
    };
  }

  const location = await fetchSubjectLocation(run.resolved_primary_api);

  return {
    apiNumber: run.resolved_primary_api,
    leaseNumber: run.resolved_lease_number,
    district: run.resolved_district,
    operatorNumber: run.resolved_operator_number,
    operatorName: run.resolved_operator_name ?? null,
    wellName: extras?.wellName ?? null,
    county: extras?.county ?? null,
    latitude: location.latitude,
    longitude: location.longitude,
    targetFormation: extras?.targetFormation ?? null,
    producingFormation: extras?.producingFormation ?? null,
    wellStatus: extras?.wellStatus ?? null,
    sourceUrlOrQueryId: location.sourceUrlOrQueryId,
    retrievedAt,
    warnings: location.warnings,
  };
}
