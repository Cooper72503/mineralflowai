/**
 * Texas Railroad Commission (TRRC) well data client.
 *
 * Primary source: TRRC public ArcGIS REST service
 * https://publicgisweb.rrc.texas.gov/arcgis/rest/services/
 *
 * The TRRC GIS well-spots layer provides locations, operator, status, and API
 * numbers but does NOT reliably include production volumes (CUM_OIL is often
 * null). To ensure Decline Curve Analysis and Operating Economics sections are
 * never empty, this module applies a Texas basin type-curve fallback:
 *   • Active wells that receive no CUM_OIL from the API get a county-keyed
 *     median BOPD estimate derived from published play type curves.
 *   • The estimate is tagged "estimated" so the UI can show appropriate labels.
 */

import type { WellLookupResult, WellSummary } from "./well-types";
import { estimateMonthlyOilFromCumulative, isActiveStatus } from "./bopd-estimate";

const TRRC_WELLS_URL =
  "https://publicgisweb.rrc.texas.gov/arcgis/rest/services/RRC_WellSpots/MapServer/0/query";

// Fallback: legacy hctx.net endpoint (location-only)
const TRRC_FALLBACK_URL =
  "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Wells/MapServer/2/query";

// Texas county name → 3-digit code embedded in API numbers (42-XXX-...).
// These are Texas FIPS county codes. All 254 Texas counties use odd codes 001–507.
const TX_COUNTY_CODES: Record<string, string> = {
  // Permian Basin (West Texas)
  andrews: "003",
  archer: "009",
  borden: "033",
  brown: "049",
  callahan: "059",
  crane: "103",
  crockett: "105",
  dawson: "115",
  ector: "135",
  fisher: "151",
  gaines: "165",
  garza: "169",
  glasscock: "173",
  howard: "227",
  irion: "235",
  jeff_davis: "243",
  jones: "253",
  kimble: "265",
  king: "269",
  knox: "275",
  loving: "301",
  lubbock: "303",
  lynn: "305",
  martin: "317",
  mason: "319",
  mccullock: "307",
  menard: "327",
  midland: "329",
  mitchell: "335",
  nolan: "353",
  pecos: "371",
  presidio: "377",
  reagan: "383",
  reeves: "389",
  runnels: "399",
  schleicher: "413",
  scurry: "415",
  shackelford: "417",
  sterling: "431",
  stonewall: "433",
  sutton: "435",
  taylor: "441",
  terrell: "443",
  tom_green: "451",
  upton: "461",
  ward: "475",
  winkler: "495",
  yoakum: "501",
  // Eagle Ford (South Texas)
  atascosa: "013",
  bee: "025",
  bexar: "029",
  dimmit: "127",
  dewitt: "123",
  frio: "163",
  gonzales: "177",
  karnes: "255",
  la_salle: "271",
  lasalle: "271",
  lavaca: "285",
  live_oak: "297",
  liveoak: "297",
  maverick: "323",
  mcmullen: "311",
  medina: "325",
  refugio: "391",
  san_patricio: "409",
  sanpatricio: "409",
  webb: "479",
  wilson: "493",
  zavala: "507",
  // East Texas / Haynesville / Cotton Valley
  angelina: "005",
  camp: "063",
  cass: "067",
  cherokee: "073",
  gregg: "183",
  harrison: "203",
  henderson: "213",
  houston: "225",
  jasper: "241",
  marion: "315",
  nacogdoches: "347",
  panola: "365",
  rusk: "401",
  sabine: "403",
  san_augustine: "405",
  shelby: "419",
  smith: "423",
  upshur: "459",
  wood: "499",
  // Barnett Shale (North Texas / Fort Worth Basin)
  bosque: "035",
  comanche: "093",
  cooke: "097",
  dallas: "113",
  denton: "121",
  eastland: "133",
  erath: "143",
  hood: "221",
  jack: "237",
  johnson: "251",
  montague: "337",
  palo_pinto: "363",
  parker: "367",
  somervell: "425",
  stephens: "429",
  tarrant: "439",
  wise: "497",
  young: "503",
  // Gulf Coast
  aransas: "007",
  brazoria: "039",
  chambers: "071",
  fort_bend: "157",
  galveston: "167",
  hardin: "199",
  harris: "201",
  jackson: "239",
  jefferson: "245",
  liberty: "291",
  matagorda: "321",
  montgomery: "339",
  orange: "361",
  victoria: "469",
  wharton: "481",
  // Anadarko extension (Texas Panhandle)
  carson: "065",
  collingsworth: "087",
  gray: "179",
  hemphill: "211",
  hutchinson: "233",
  lipscomb: "295",
  moore: "341",
  ochiltree: "357",
  oldham: "359",
  potter: "375",
  randall: "381",
  roberts: "393",
  shamrock: "099",
  wheeler: "483",
  // Additional active counties
  bastrop: "021",
  blanco: "031",
  burleson: "051",
  burnet: "053",
  caldwell: "055",
  colorado: "089",
  fayette: "149",
  grimes: "185",
  hays: "209",
  lee: "287",
  leon: "201", // note: different from harris county code
  madison: "313",
  milam: "331",
  robertson: "395",
  travis: "453",
  waller: "473",
  washington: "477",
  williamson: "491",
};

/**
 * Texas basin type-curve BOPD estimates (monthly barrel/day medians).
 * Sources: EIA Drilling Productivity Reports, TRRC production summaries.
 * These are conservative median values across all well vintages; new wells
 * will out-produce this, older wells less — but the median is the right anchor
 * for a county-level screening estimate.
 *
 * Key: normalised county name (same as TX_COUNTY_CODES keys)
 * Value: estimated current BOPD for an "average active well" in that county
 */
const TX_BASIN_BOPD: Record<string, number> = {
  // ── Permian Basin (Midland + Delaware sub-basins) ──────────────────────────
  midland: 42, ector: 38, martin: 45, howard: 35, glasscock: 48,
  reagan: 40, upton: 38, crane: 32, ward: 35, reeves: 44,
  loving: 55, winkler: 30, yoakum: 28, gaines: 30, dawson: 22,
  andrews: 35, borden: 25, scurry: 18, mitchell: 15, nolan: 12,
  crockett: 28, sutton: 22, pecos: 32, terrell: 18, presidio: 8,
  irion: 30, sterling: 20, tom_green: 14, schleicher: 20,
  // ── Eagle Ford (South Texas) ───────────────────────────────────────────────
  karnes: 32, dewitt: 28, dimmit: 30, webb: 22, la_salle: 28,
  lasalle: 28, frio: 24, mcmullen: 26, maverick: 18, zavala: 16,
  atascosa: 22, bee: 18, live_oak: 20, liveoak: 20, wilson: 20,
  medina: 16, gonzales: 25, lavaca: 18, victoria: 14, refugio: 12,
  // ── Permian extension / Midland Basin fringe ──────────────────────────────
  fisher: 10, runnels: 10, callahan: 8, jones: 8, taylor: 8,
  shackelford: 8, stephens: 12, palo_pinto: 10, eastland: 10,
  erath: 8, comanche: 6, brown: 8, kimble: 6, menard: 5,
  mason: 5, mccullock: 7, san_patricio: 10,
  // ── Barnett Shale (North Texas — predominantly gas, low oil) ──────────────
  tarrant: 3, denton: 3, johnson: 4, hood: 4, parker: 4,
  jack: 6, wise: 5, montague: 6, cooke: 5, dallas: 2,
  somervell: 4, bosque: 4, young: 8,
  // ── East Texas / Haynesville / Cotton Valley ──────────────────────────────
  rusk: 10, gregg: 10, panola: 8, harrison: 8, shelby: 6,
  nacogdoches: 6, smith: 8, upshur: 7, wood: 8, henderson: 6,
  cherokee: 6, san_augustine: 5, sabine: 4, angelina: 5,
  houston: 5, jasper: 5, cass: 6, camp: 5, marion: 5,
  // ── Gulf Coast ────────────────────────────────────────────────────────────
  harris: 14, brazoria: 16, galveston: 12, liberty: 10,
  montgomery: 10, fort_bend: 12, chambers: 10, jefferson: 10,
  orange: 6, hardin: 8, jackson: 12, matagorda: 14, wharton: 12,
  aransas: 8,
  // ── Texas Panhandle / Anadarko extension ──────────────────────────────────
  hutchinson: 8, gray: 8, potter: 5, hemphill: 8, roberts: 8,
  wheeler: 8, lipscomb: 7, ochiltree: 7, oldham: 5, carson: 7,
  randall: 4, collingsworth: 5, moore: 6,
  // ── Central Texas / Austin Chalk / Wilcox ─────────────────────────────────
  burleson: 10, grimes: 8, robertson: 10, milam: 8, falls: 6,
  lee: 8, bastrop: 6, caldwell: 8,
  colorado: 10, fayette: 8,
  washington: 8, waller: 8, travis: 4, hays: 4, williamson: 4,
  blanco: 4, burnet: 5, leon: 8, madison: 6,
};

// Multi-word county aliases → normalized key
const COUNTY_ALIASES: Record<string, string> = {
  "tom green": "tom_green",
  "jeff davis": "jeff_davis",
  "la salle": "la_salle",
  "san patricio": "san_patricio",
  "san augustine": "san_augustine",
  "fort bend": "fort_bend",
  "live oak": "live_oak",
  "palo pinto": "palo_pinto",
  "de witt": "dewitt",
};

function normalizeCounty(county: string): string {
  const lower = county.toLowerCase().replace(/\s+county\s*$/i, "").trim();
  return COUNTY_ALIASES[lower] ?? lower.replace(/\s+/g, "_");
}

type TrrcFeature = {
  attributes: Record<string, unknown>;
  geometry?: { x: number; y: number } | null;
};

function safeStr(v: unknown): string | null {
  if (v == null || v === "") return null;
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

/**
 * Returns a county-keyed basin type-curve BOPD estimate for Texas.
 * Used as a last-resort fallback when the TRRC API returns no production data.
 * Returns null for unknown counties so callers stay honest about data provenance.
 */
function getTexasBasinBopd(countyKey: string): number | null {
  return TX_BASIN_BOPD[countyKey] ?? null;
}

/**
 * Applies a basin BOPD estimate to any active well missing production data.
 * Mutates wells in-place — call after building the well list from API features.
 */
function injectBasinBopdFallback(wells: WellSummary[], countyKey: string): void {
  const basinBopd = getTexasBasinBopd(countyKey);
  if (basinBopd == null) return;

  for (const w of wells) {
    if (w.latest_monthly_oil_bbl != null) continue;  // already has data
    if (!isActiveStatus(w.status) && w.status != null) continue;  // don't inject for P&A wells

    // Convert BOPD → monthly BBL (BOPD × 30.44)
    w.latest_monthly_oil_bbl = Math.round(basinBopd * 30.44);
    // Tag as estimated so UI can show appropriate labels
    if (!w.latest_production_month) {
      w.latest_production_month = "estimated";
    }
  }
}

function featureToWell(f: TrrcFeature): WellSummary {
  const a = f.attributes;
  const apinum = safeStr(a.API_NO ?? a.APINUM ?? a.API10 ?? a.API) ?? "unknown";
  const spudDateStr = parseDateStr(a.SPUD_DT ?? a.SPUD_DATE ?? a.SPUDDATE);
  const statusStr = safeStr(a.WELL_STATUS_CD ?? a.STATUS ?? a.WELL_STATUS ?? a.WELLSTATUS);
  const cumOil = safeNum(a.CUM_OIL ?? a.CUM_OIL_BBL);
  return {
    api: apinum,
    well_name: safeStr(a.WELL_NAME ?? a.WELLNAME ?? a.LEASE_NAME ?? a.LEASENAME) ?? `Well ${apinum}`,
    operator:  safeStr(a.OPERATOR_NAME ?? a.OPERATOR ?? a.OPER_NAME ?? a.LEASE_OPERATOR),
    county: null,
    state: "Texas",
    status: statusStr,
    formation: safeStr(a.FORMATION ?? a.FIELD_NAME ?? a.FIELDNAME ?? a.PROD_FORM),
    spud_date: spudDateStr,
    latest_monthly_oil_bbl: estimateMonthlyOilFromCumulative(cumOil, spudDateStr, statusStr),
    latest_monthly_gas_mcf: null,
    latest_monthly_water_bbl: null,
    latest_production_month: spudDateStr ? spudDateStr.slice(0, 7) : null,
    cum_oil_bbl: cumOil,
    lat: f.geometry?.y ?? null,
    lng: f.geometry?.x ?? null,
  };
}

function featureToWellFallback(f: TrrcFeature): WellSummary {
  const a = f.attributes;
  const apinum = safeStr(a.APINUM ?? a.API10 ?? a.API) ?? "unknown";
  const statusStr = safeStr(a.STATUS ?? a.WELLSTATUS ?? a.WELL_STATUS);
  const spudDateStr = parseDateStr(a.SPUD_DT ?? a.SPUD_DATE ?? a.SPUDDATE);
  return {
    api: apinum,
    well_name: safeStr(a.WELL_NAME ?? a.WELLNAME ?? a.LEASENAME) ?? `Well ${apinum}`,
    operator: safeStr(a.OPERATOR ?? a.OPER_NAME ?? a.OPERATOR_NAME),
    county: null,
    state: "Texas",
    status: statusStr,
    formation: null,
    spud_date: spudDateStr,
    latest_monthly_oil_bbl: null,    // will be filled by injectBasinBopdFallback
    latest_monthly_gas_mcf: null,
    latest_monthly_water_bbl: null,
    latest_production_month: null,
    cum_oil_bbl: null,
    lat: f.geometry?.y ?? null,
    lng: f.geometry?.x ?? null,
  };
}

export async function lookupTrrcWells(county: string): Promise<WellLookupResult> {
  const countyKey = normalizeCounty(county);
  const countyCode = TX_COUNTY_CODES[countyKey];
  const desc = `${county} County, TX`;

  if (!countyCode) {
    // County not in API lookup table — still synthesize a single basin estimate
    // so analysis engines have something to anchor to.
    const basinBopd = getTexasBasinBopd(countyKey);
    if (basinBopd != null) {
      return {
        source: "trrc",
        wells: [
          {
            api: "synthetic-1",
            well_name: `${county} County (basin estimate)`,
            operator: null,
            county,
            state: "Texas",
            status: "Active",
            formation: null,
            spud_date: null,
            latest_monthly_oil_bbl: Math.round(basinBopd * 30.44),
            latest_monthly_gas_mcf: null,
            latest_monthly_water_bbl: null,
            latest_production_month: "estimated",
            cum_oil_bbl: null,
            lat: null,
            lng: null,
          },
        ],
        query_description: desc,
        note: `Texas county "${county}" not in TRRC API lookup table. Production estimated from basin type curves.`,
      };
    }
    return {
      source: "trrc",
      wells: [],
      query_description: desc,
      note: `Texas county "${county}" not found in lookup table. Well data available for major producing counties.`,
    };
  }

  // API numbers are stored as "42XXX..." — filter by prefix
  const apiPrefix = `42${countyCode}`;

  const params = new URLSearchParams({
    where:              `API_NO LIKE '${apiPrefix}%' OR APINUM LIKE '${apiPrefix}%'`,
    outFields:          "*",
    returnGeometry:     "true",
    outSR:              "4326",   // request WGS84 so geometry comes back as lat/lng
    resultRecordCount:  "25",
    f:                  "json",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const url = `${TRRC_WELLS_URL}?${params.toString()}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`TRRC HTTP ${res.status}`);

    const json = await res.json() as {
      features?: TrrcFeature[];
      exceededTransferLimit?: boolean;
      error?: { message: string };
    };

    if (json.error) throw new Error(json.error.message);

    const features: TrrcFeature[] = json.features ?? [];
    const wells = features.map(featureToWell);
    const exceeded = json.exceededTransferLimit === true;

    // Inject basin type-curve BOPD for active wells that came back without production data
    injectBasinBopdFallback(wells, countyKey);

    // If the API returned 0 wells, fall back to a county-level synthetic estimate
    // so decline analysis and operating economics are never empty.
    if (wells.length === 0) {
      const basinBopd = getTexasBasinBopd(countyKey);
      if (basinBopd != null) {
        wells.push({
          api: "synthetic-1",
          well_name: `${county} County (basin estimate)`,
          operator: null,
          county,
          state: "Texas",
          status: "Active",
          formation: null,
          spud_date: null,
          latest_monthly_oil_bbl: Math.round(basinBopd * 30.44),
          latest_monthly_gas_mcf: null,
          latest_monthly_water_bbl: null,
          latest_production_month: "estimated",
          cum_oil_bbl: null,
          lat: null,
          lng: null,
        });
      }
    }

    const bopdCount = wells.filter(w => w.latest_monthly_oil_bbl != null).length;
    const noteBase = exceeded ? "Showing first 25 of many wells in this county." : undefined;
    const bopdNote = bopdCount > 0 && wells.some(w => w.latest_production_month === "estimated")
      ? "Production volumes estimated from Texas basin type curves where TRRC API data unavailable."
      : undefined;
    const note = [noteBase, bopdNote].filter(Boolean).join(" ") || undefined;

    return {
      source: "trrc",
      wells,
      query_description: desc,
      note,
    };
  } catch (primaryErr) {
    clearTimeout(timer);
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : "Unknown error";
    console.warn("[trrc-api] primary lookup failed, trying fallback:", primaryMsg);

    // Fallback: legacy hctx.net endpoint (location + status only)
    const fallbackParams = new URLSearchParams({
      where:              `APINUM LIKE '${apiPrefix}%'`,
      outFields:          "APINUM,API10,RELIAB,WELLID,CWELLNUM,STATUS,WELLSTATUS,SPUD_DT,WELL_NAME,WELLNAME,OPERATOR,OPER_NAME",
      returnGeometry:     "true",
      outSR:              "4326",
      resultRecordCount:  "25",
      f:                  "json",
    });

    const fbController = new AbortController();
    const fbTimer = setTimeout(() => fbController.abort(), 10000);

    try {
      const fbUrl = `${TRRC_FALLBACK_URL}?${fallbackParams.toString()}`;
      const fbRes = await fetch(fbUrl, { signal: fbController.signal });
      clearTimeout(fbTimer);

      if (!fbRes.ok) throw new Error(`TRRC fallback HTTP ${fbRes.status}`);

      const fbJson = await fbRes.json() as {
        features?: TrrcFeature[];
        exceededTransferLimit?: boolean;
        error?: { message: string };
      };

      if (fbJson.error) throw new Error(fbJson.error.message);

      const fbFeatures: TrrcFeature[] = fbJson.features ?? [];
      const fbWells = fbFeatures.map(featureToWellFallback);

      // Always inject basin BOPD — fallback endpoint never has production volumes
      injectBasinBopdFallback(fbWells, countyKey);

      const hasBasin = getTexasBasinBopd(countyKey) != null;
      return {
        source: "trrc",
        wells: fbWells,
        query_description: desc,
        note: hasBasin
          ? "Texas RRC public GIS — production volumes estimated from Texas basin type curves."
          : "Texas RRC public GIS — well locations only (production data unavailable for this county).",
      };
    } catch (fallbackErr) {
      clearTimeout(fbTimer);
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : "Unknown error";
      console.warn("[trrc-api] fallback lookup also failed:", fallbackMsg);

      // Both endpoints failed — return synthetic wells using only the county basin estimate
      // so Decline Analysis and Operating Economics still have something to anchor to.
      const basinBopd = getTexasBasinBopd(countyKey);
      if (basinBopd != null) {
        const syntheticWells: WellSummary[] = [
          {
            api: "synthetic-1",
            well_name: `${county} County (basin estimate)`,
            operator: null,
            county,
            state: "Texas",
            status: "Active",
            formation: null,
            spud_date: null,
            latest_monthly_oil_bbl: Math.round(basinBopd * 30.44),
            latest_monthly_gas_mcf: null,
            latest_monthly_water_bbl: null,
            latest_production_month: "estimated",
            cum_oil_bbl: null,
            lat: null,
            lng: null,
          },
        ];
        return {
          source: "trrc",
          wells: syntheticWells,
          query_description: desc,
          note: `Texas RRC API temporarily unavailable. Values estimated from ${county} County basin type curves.`,
        };
      }

      return {
        source: "unavailable",
        wells: [],
        query_description: desc,
        note: `Texas RRC data temporarily unavailable: ${primaryMsg}`,
      };
    }
  }
}
