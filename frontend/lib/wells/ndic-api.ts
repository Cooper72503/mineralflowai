/**
 * North Dakota Industrial Commission (NDIC) well data client.
 * Uses the free ND GIS Hub ArcGIS REST API — no API key required.
 *
 * Data source: https://gis.nd.gov/arcgis/rest/services/Energy/ND_OilGas/MapServer
 */

import type { WellLookupResult, WellSummary } from "./well-types";

// Layer 2 = oil/gas wells with location and status
const NDIC_WELLS_URL =
  "https://gis.nd.gov/arcgis/rest/services/Energy/ND_OilGas/MapServer/2/query";

type NdicFeature = {
  attributes: Record<string, unknown>;
  geometry?: { x: number; y: number } | null;
};

function safeStr(v: unknown): string | null {
  if (v == null || v === "" || v === "N/A") return null;
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
  // NDIC dates often come as epoch ms (number) or "MM/DD/YYYY"
  const asNum = Number(s);
  if (!isNaN(asNum) && asNum > 0) {
    return new Date(asNum).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

function featureToWell(f: NdicFeature): WellSummary {
  const a = f.attributes;
  return {
    api:         safeStr(a.API_NO ?? a.API ?? a.FILE_NO) ?? "unknown",
    well_name:   safeStr(a.WELL_NAME ?? a.WELLNAME ?? a.NAME) ?? "Unknown Well",
    operator:    safeStr(a.CURRENT_OPERATOR ?? a.OPERATOR ?? a.OPER_NAME),
    county:      safeStr(a.COUNTY ?? a.COUNTY_NAME),
    state:       "North Dakota",
    status:      safeStr(a.STATUS ?? a.WELL_STATUS ?? a.STATUS_CD),
    formation:   safeStr(a.POOL ?? a.FORMATION ?? a.POOL_NAME ?? a.FORMATION_NAME),
    spud_date:   parseDateStr(a.SPUD_DATE ?? a.SPUDDATE),
    latest_monthly_oil_bbl:  null, // not in this layer; requires production layer
    latest_monthly_gas_mcf:  null,
    latest_monthly_water_bbl: null,
    latest_production_month: null,
    cum_oil_bbl: safeNum(a.CUM_OIL ?? a.CUMULOIL ?? a.CUMULATIVE_OIL),
    lat: f.geometry?.y ?? null,
    lng: f.geometry?.x ?? null,
  };
}

const ND_COUNTY_CODES: Record<string, number> = {
  adams: 1, barnes: 3, benson: 5, billings: 7, bottineau: 9, bowman: 11,
  burke: 13, burleigh: 15, cass: 17, cavalier: 19, dickey: 21, divide: 23,
  dunn: 25, eddy: 27, emmons: 29, foster: 31, "golden valley": 33,
  grand_forks: 35, grant: 37, griggs: 39, hettinger: 41, kidder: 43,
  lamoure: 45, logan: 47, mchenry: 49, mcintosh: 51, mckenzie: 53,
  mclean: 55, mercer: 57, morton: 59, mountrail: 61, nelson: 63,
  oliver: 65, pembina: 67, pierce: 69, ramsey: 71, ransom: 73,
  renville: 75, richland: 77, rolette: 79, sargent: 81, sheridan: 83,
  sioux: 85, slope: 87, stark: 89, steele: 91, stutsman: 93,
  towner: 95, traill: 97, walsh: 99, ward: 101, wells: 103, williams: 105,
};

function normalizeCounty(county: string): string {
  return county.toLowerCase().replace(/\s+county\s*$/i, "").trim();
}

export async function lookupNdicWells(county: string): Promise<WellLookupResult> {
  const countyKey = normalizeCounty(county);
  const desc = `${county} County, ND`;

  const params = new URLSearchParams({
    where:         `UPPER(COUNTY) = '${countyKey.toUpperCase()}'`,
    outFields:     "API_NO,WELL_NAME,CURRENT_OPERATOR,COUNTY,STATUS,POOL,SPUD_DATE,CUM_OIL",
    returnGeometry: "true",
    resultRecordCount: "25",
    orderByFields: "SPUD_DATE DESC",
    f:             "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const url = `${NDIC_WELLS_URL}?${params.toString()}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`NDIC HTTP ${res.status}`);

    const json = await res.json() as { features?: NdicFeature[]; error?: { message: string } };

    if (json.error) throw new Error(json.error.message);

    const features: NdicFeature[] = json.features ?? [];
    const wells = features.map(featureToWell);

    return {
      source: "ndic",
      wells,
      query_description: desc,
      note: wells.length === 0 ? "No wells found in this county via NDIC public records." : undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[ndic-api] lookup failed:", msg);
    return {
      source: "unavailable",
      wells: [],
      query_description: desc,
      note: `NDIC data temporarily unavailable: ${msg}`,
    };
  }
}
