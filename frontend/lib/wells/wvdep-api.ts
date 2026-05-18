/**
 * West Virginia Department of Environmental Protection (WV DEP) well data client.
 * Uses the WV DEP public ArcGIS REST API — no API key required.
 *
 * Data source: https://tagis.dep.wv.gov/arcgis/rest/services/WVDEP_OOG/WVWells/MapServer
 */

import type { WellLookupResult, WellSummary } from "./well-types";
import { fetchWvdepProductionHistory } from "./wvdep-production";


// Layer 0 = oil and gas wells
const WVDEP_WELLS_URL =
  "https://tagis.dep.wv.gov/arcgis/rest/services/WVDEP_OOG/WVWells/MapServer/0/query";

type WvdepFeature = {
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

function featureToWell(f: WvdepFeature): WellSummary {
  const a = f.attributes;
  const cumOil = safeNum(a.CUM_OIL ?? a.CUMULATIVE_OIL ?? a.CUM_OIL_BBL);
  const spudDateStr = parseDateStr(a.SPUD_DATE ?? a.SPUDDATE ?? a.SPUD_DT);
  const statusStr = safeStr(a.WELL_STATUS ?? a.STATUS ?? a.STATUS_CD ?? a.WLSTAT);
  return {
    api:       safeStr(a.API ?? a.API_NO ?? a.APINO ?? a.API_NUMBER) ?? "unknown",
    well_name: safeStr(a.WELL_NAME ?? a.WELLNAME ?? a.FARM_NAME ?? a.FARMNAME) ?? "Unknown Well",
    operator:  safeStr(a.OPERATOR ?? a.OPERATOR_NAME ?? a.OPER_NAME ?? a.COMPANY),
    county:    safeStr(a.COUNTY ?? a.COUNTY_NAME ?? a.CNTY_NAME),
    state:     "West Virginia",
    status:    statusStr,
    formation: safeStr(a.FORMATION ?? a.POOL ?? a.FORM_NAME ?? a.PRODUCING_FORMATION),
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

/**
 * Enrich up to `maxEnrich` WV wells in-place with real monthly production
 * from the WV DEP per-well HTML page.
 */
async function enrichWvWellsWithProduction(
  wells: WellSummary[],
  maxEnrich = 8,
): Promise<void> {
  const toEnrich = wells.filter(w => w.api && w.api !== "unknown").slice(0, maxEnrich);

  const tasks = toEnrich.map(well =>
    fetchWvdepProductionHistory(well.api, 12)
      .then(result => {
        if (!result || result.rows.length === 0) return;
        // Find the most recent row with non-zero oil or gas
        const rows = [...result.rows].reverse();
        const latestOil = rows.find(r => r.oil_bbl > 0);
        const latestGas = rows.find(r => (r.gas_mcf ?? 0) > 0);
        const latest    = latestOil ?? latestGas;
        if (!latest) return;

        const monthStr = `${latest.year}-${String(latest.month).padStart(2, "0")}`;
        well.latest_production_month  = monthStr;
        well.latest_monthly_oil_bbl   = latestOil ? latestOil.oil_bbl  : 0;
        well.latest_monthly_gas_mcf   = latestGas ? (latestGas.gas_mcf ?? null) : null;
      })
      .catch(() => { /* silently skip failures */ }),
  );

  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>(resolve => setTimeout(resolve, 20_000)),
  ]);
}

export async function lookupWvdepWells(county: string): Promise<WellLookupResult> {
  const countyKey = normalizeCounty(county);
  const countyUpper = countyKey.toUpperCase();
  const desc = `${county} County, WV`;

  const params = new URLSearchParams({
    where:             `UPPER(COUNTY) = '${countyUpper}' OR UPPER(COUNTY_NAME) = '${countyUpper}'`,
    outFields:         "API,WELL_NAME,OPERATOR,COUNTY,WELL_STATUS,FORMATION,SPUD_DATE,CUM_OIL",
    returnGeometry:    "true",
    resultRecordCount: "25",
    orderByFields:     "SPUD_DATE DESC",
    f:                 "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const url = `${WVDEP_WELLS_URL}?${params.toString()}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`WV DEP HTTP ${res.status}`);

    const json = await res.json() as { features?: WvdepFeature[]; error?: { message: string } };

    if (json.error) throw new Error(json.error.message);

    const features: WvdepFeature[] = json.features ?? [];
    const wells = features.map(featureToWell);

    // Enrich up to 8 wells with real per-well monthly production from WV DEP
    if (wells.length > 0) {
      await enrichWvWellsWithProduction(wells, 8);
    }

    const withProduction = wells.filter(w => w.latest_monthly_oil_bbl != null).length;

    return {
      source: "wvdep",
      wells,
      query_description: desc,
      note: wells.length === 0
        ? "No wells found in this county via WV DEP public records."
        : withProduction > 0
          ? `${wells.length} wells from WV DEP. ${withProduction} with real monthly production data.`
          : undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[wvdep-api] lookup failed:", msg);
    return {
      source: "unavailable",
      wells: [],
      query_description: desc,
      note: `WV DEP data temporarily unavailable: ${msg}`,
    };
  }
}
