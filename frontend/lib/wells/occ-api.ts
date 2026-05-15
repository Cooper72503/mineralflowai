/**
 * Oklahoma Corporation Commission (OCC) well data client.
 * Uses the OCC public ArcGIS REST API — no API key required.
 *
 * Data source: https://gis.occeweb.com/arcgis/rest/services/OGWells/OGWells/MapServer
 */

import type { WellLookupResult, WellSummary } from "./well-types";


// Layer 0 = active oil/gas well spots
const OCC_WELLS_URL =
  "https://gis.occeweb.com/arcgis/rest/services/OGWells/OGWells/MapServer/0/query";

type OccFeature = {
  attributes: Record<string, unknown>;
  geometry?: { x: number; y: number } | null;
};

function safeStr(v: unknown): string | null {
  if (v == null || v === "" || v === "N/A" || v === " ") return null;
  return String(v).trim() || null;
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function parseDateStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "0") return null;
  const asNum = Number(s);
  if (!isNaN(asNum) && asNum > 0) {
    return new Date(asNum).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

function featureToWell(f: OccFeature): WellSummary {
  const a = f.attributes;
  const cumOil = safeNum(a.CUM_OIL ?? a.CUMULATIVE_OIL ?? a.CUM_OIL_BBL);
  const spudDateStr = parseDateStr(a.SPUD_DATE ?? a.SPUDDATE ?? a.SPUD_DT);
  const statusStr = safeStr(a.WELL_STATUS ?? a.STATUS ?? a.WLSTAT ?? a.STATUS_CD);
  return {
    api:       safeStr(a.API ?? a.API_NO ?? a.APINO) ?? "unknown",
    well_name: safeStr(a.WELL_NAME ?? a.WELLNAME ?? a.WELL_LEGAL_NAME ?? a.LEGALNAME) ?? "Unknown Well",
    operator:  safeStr(a.OPERATOR ?? a.OPERATOR_NAME ?? a.OPER_NAME ?? a.CURRENT_OPERATOR),
    county:    safeStr(a.COUNTY ?? a.COUNTY_NAME ?? a.CNTY_NAME),
    state:     "Oklahoma",
    status:    statusStr,
    formation: safeStr(a.FORMATION ?? a.PRODUCING_FORMATION ?? a.FORM_NAME ?? a.POOL ?? a.POOL_NAME),
    spud_date: spudDateStr,
    latest_monthly_oil_bbl:   null,  // Monthly production not available from this state GIS layer
    latest_monthly_gas_mcf:   null,
    latest_monthly_water_bbl: null,
    latest_production_month:  spudDateStr ? spudDateStr.slice(0, 7) : null,
    cum_oil_bbl: cumOil,
    lat: f.geometry?.y ?? null,
    lng: f.geometry?.x ?? null,
  };
}

function normalizeCounty(county: string): string {
  return county.toLowerCase().replace(/\s+county\s*$/i, "").trim();
}

export async function lookupOccWells(county: string): Promise<WellLookupResult> {
  const countyKey = normalizeCounty(county);
  const countyUpper = countyKey.toUpperCase();
  const desc = `${county} County, OK`;

  const params = new URLSearchParams({
    where:             `UPPER(COUNTY) = '${countyUpper}' OR UPPER(COUNTY_NAME) = '${countyUpper}' OR UPPER(CNTY_NAME) = '${countyUpper}'`,
    outFields:         "API,WELL_NAME,OPERATOR,COUNTY,WELL_STATUS,FORMATION,SPUD_DATE,CUM_OIL",
    returnGeometry:    "true",
    resultRecordCount: "25",
    orderByFields:     "SPUD_DATE DESC",
    f:                 "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const url = `${OCC_WELLS_URL}?${params.toString()}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`OCC HTTP ${res.status}`);

    const json = await res.json() as { features?: OccFeature[]; error?: { message: string } };

    if (json.error) throw new Error(json.error.message);

    const features: OccFeature[] = json.features ?? [];
    const wells = features.map(featureToWell);

    return {
      source: "occ",
      wells,
      query_description: desc,
      note: wells.length === 0 ? "No wells found in this county via OCC public records." : undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[occ-api] lookup failed:", msg);
    return {
      source: "unavailable",
      wells: [],
      query_description: desc,
      note: `OCC data temporarily unavailable: ${msg}`,
    };
  }
}
