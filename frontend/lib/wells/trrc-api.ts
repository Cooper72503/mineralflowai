/**
 * Texas Railroad Commission (TRRC) well data client.
 *
 * Data source: TXRRC/Wells MapServer (hosted at gis.hctx.net)
 * Free, no API key required.
 *
 * Limitation: the public GIS layer contains well locations and API numbers only.
 * Operator, formation, and production data are not exposed in the public REST API.
 * County filtering works via the API number prefix (42-XXX-...) where XXX is the
 * 3-digit Texas county code embedded in every API number.
 */

import type { WellLookupResult, WellSummary } from "./well-types";

const TRRC_WELLS_URL =
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

function featureToWell(f: TrrcFeature): WellSummary {
  const a = f.attributes;
  const apinum = safeStr(a.APINUM ?? a.API10 ?? a.API) ?? "unknown";

  // Convert Texas State Plane NAD83 coordinates to lat/lng
  // The geometry comes in the projection of the service (EPSG:2278 or 4326 depending on returnGeometry)
  // We'll request geographic coordinates by setting outSR=4326
  const lat = f.geometry?.y ?? null;
  const lng = f.geometry?.x ?? null;

  return {
    api: apinum,
    well_name: `API ${apinum}`,
    operator: null,       // not available in public layer
    county: null,
    state: "Texas",
    status: null,         // not available
    formation: null,      // not available
    spud_date: null,      // not available
    latest_monthly_oil_bbl: null,
    latest_monthly_gas_mcf: null,
    latest_monthly_water_bbl: null,
    latest_production_month: null,
    cum_oil_bbl: null,
    lat,
    lng,
  };
}

export async function lookupTrrcWells(county: string): Promise<WellLookupResult> {
  const countyKey = normalizeCounty(county);
  const countyCode = TX_COUNTY_CODES[countyKey];
  const desc = `${county} County, TX`;

  if (!countyCode) {
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
    where:              `APINUM LIKE '${apiPrefix}%'`,
    outFields:          "APINUM,API10,RELIAB,WELLID,CWELLNUM",
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

    const note = [
      "Texas RRC public GIS — well locations only.",
      "Operator, formation, and production data not available in the public API.",
      exceeded ? "Showing first 25 of many wells in this county." : null,
    ].filter(Boolean).join(" ");

    return {
      source: "trrc",
      wells,
      query_description: desc,
      note,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[trrc-api] lookup failed:", msg);
    return {
      source: "unavailable",
      wells: [],
      query_description: desc,
      note: `Texas RRC data temporarily unavailable: ${msg}`,
    };
  }
}
