/**
 * Ohio DNR Division of Oil and Gas Resources Management (DOGRM) well data client.
 * Uses the Ohio DNR public ArcGIS REST API — no API key required.
 *
 * Data source: https://gis.ohiodnr.gov/arcgis/rest/services/OIT_Services/ODNR_Oil_Gas/MapServer
 */

import type { WellLookupResult, WellSummary } from "./well-types";


const ODNR_WELLS_URL =
  "https://gis.ohiodnr.gov/arcgis/rest/services/OIT_Services/ODNR_Oil_Gas/MapServer/0/query";

type OdnrFeature = {
  attributes: Record<string, unknown>;
  geometry?: { x: number; y: number } | null;
};

function safeStr(v: unknown): string | null {
  if (v == null || v === "" || v === "N/A" || v === " " || v === "NULL") return null;
  return String(v).trim() || null;
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) || n < 0 ? null : n;
}

function parseDateStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "0") return null;
  // Epoch ms (ArcGIS standard)
  const asNum = Number(s);
  if (!isNaN(asNum) && asNum > 0) {
    return new Date(asNum).toISOString().slice(0, 10);
  }
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function featureToWell(f: OdnrFeature): WellSummary {
  const a = f.attributes;
  const cumOil = safeNum(
    a.CUM_OIL ?? a.CUM_OIL_BBL ?? a.CUMULATIVE_OIL ?? a.CUM_PROD_OIL
  );
  const spudDateStr = parseDateStr(a.SPUD_DATE ?? a.SPUDDATE ?? a.SPUD_DT ?? a.DATE_SPUD);
  const statusStr = safeStr(
    a.WELL_STATUS ?? a.STATUS ?? a.CURRENT_STATUS ?? a.STATUS_CD ?? a.WLSTAT
  );
  return {
    api: safeStr(
      a.API_NUMBER ?? a.API_NO ?? a.API ?? a.APINO ?? a.API_NUM
    ) ?? "unknown",
    well_name: safeStr(
      a.FARM_NAME ?? a.WELL_NAME ?? a.FARMNAME ?? a.WELLNAME ?? a.FARM
    ) ?? "Unknown Well",
    operator: safeStr(
      a.COMPANY ?? a.OPERATOR ?? a.OPERATOR_NAME ?? a.COMPANY_NAME ?? a.CURRENT_OPERATOR
    ),
    county: safeStr(a.COUNTY ?? a.COUNTY_NAME ?? a.CNTY_NAME ?? a.CNTY),
    state: "Ohio",
    status: statusStr,
    formation: safeStr(
      a.FORMATION ?? a.PRODUCING_FORMATION ?? a.POOL ?? a.FORM_NAME ?? a.PROD_FORM
    ),
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

export async function lookupOdnrWells(county: string): Promise<WellLookupResult> {
  const countyKey = normalizeCounty(county);
  const countyUpper = countyKey.toUpperCase();
  const desc = `${county} County, OH`;

  // Ohio DNR stores county as name (e.g. "HOLMES", "STARK") without the word "County"
  const whereClause =
    `UPPER(COUNTY) = '${countyUpper}' OR UPPER(COUNTY_NAME) = '${countyUpper}'`;

  const params = new URLSearchParams({
    where:             whereClause,
    outFields:         "API_NUMBER,FARM_NAME,COMPANY,COUNTY,WELL_STATUS,FORMATION,SPUD_DATE,CUM_OIL",
    returnGeometry:    "true",
    resultRecordCount: "25",
    orderByFields:     "SPUD_DATE DESC",
    f:                 "json",
  });

  try {
    const url = `${ODNR_WELLS_URL}?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) throw new Error(`Ohio DNR HTTP ${res.status}`);

    const json = await res.json() as {
      features?: OdnrFeature[];
      exceededTransferLimit?: boolean;
      error?: { message: string };
    };

    if (json.error) throw new Error(json.error.message);

    const features: OdnrFeature[] = json.features ?? [];

    // If county name query returns nothing, try a broader text match
    if (features.length === 0) {
      const fallbackParams = new URLSearchParams({
        where:             `UPPER(COUNTY) LIKE '%${countyUpper}%'`,
        outFields:         "API_NUMBER,FARM_NAME,COMPANY,COUNTY,WELL_STATUS,FORMATION,SPUD_DATE,CUM_OIL",
        returnGeometry:    "true",
        resultRecordCount: "25",
        orderByFields:     "SPUD_DATE DESC",
        f:                 "json",
      });
      try {
        const fbRes = await fetch(`${ODNR_WELLS_URL}?${fallbackParams.toString()}`);
        if (fbRes.ok) {
          const fbJson = await fbRes.json() as {
            features?: OdnrFeature[];
            exceededTransferLimit?: boolean;
          };
          features.push(...(fbJson.features ?? []));
        }
      } catch {
        // fallback failed silently
      }
    }

    const wells = features.map(featureToWell);

    return {
      source: "odnr",
      wells,
      exceeded_transfer_limit: json.exceededTransferLimit === true,
      query_description: desc,
      note: wells.length === 0
        ? "No wells found in this county via Ohio DNR public records."
        : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[odnr-api] lookup failed:", msg);
    return {
      source: "unavailable",
      wells: [],
      query_description: desc,
      note: `Ohio DNR data temporarily unavailable: ${msg}`,
    };
  }
}
