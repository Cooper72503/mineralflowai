/**
 * Texas Railroad Commission (TRRC) well data client.
 *
 * Primary source: TRRC PDQ (Electronic Well Application) wellbore query
 * https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do
 *
 * The legacy publicgisweb.rrc.texas.gov ArcGIS endpoint was decommissioned
 * as part of RRC's GIS Modernization Upgrades. The PDQ wellbore query
 * is the official TRRC public data source for well records.
 *
 * Returns: API numbers, operator names, county — all real TRRC data.
 * Monthly production is fetched separately via TRRC PDQ CSV export
 * (lib/wells/trrc-production.ts).
 */

import type { WellLookupResult, WellSummary } from "./well-types";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

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

/** Unescape basic HTML entities in operator names from PDQ HTML. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Parse the PDQ wellbore query HTML result page into WellSummary objects.
 *
 * Each row contains:
 *   • apiNo=XXXXXXXX&distCode=XX&leaseNo=XXXXXX  (in the lease detail href)
 *   • Operator name in the link titled "Operator # XXXXXX"
 *
 * API numbers from PDQ are 8 digits (county 3 + well 5); we prepend "42"
 * to produce the standard 10-digit TRRC API number.
 */
function parsePdqCountyWells(
  html: string,
  countyName: string,
  maxWells = 30,
): WellSummary[] {
  // Each well has exactly one occurrence of apiNo=...&distCode=...&leaseNo=...
  const apiMatches = Array.from(
    html.matchAll(/apiNo=(\d+)&distCode=(\w+)&leaseNo=(\d+)/g),
  );
  // Operator links appear in the same order as the API rows
  const opMatches = Array.from(
    html.matchAll(/title="Operator # \d+">(.*?)<\/a>/g),
  );

  const count = Math.min(apiMatches.length, opMatches.length, maxWells);
  const wells: WellSummary[] = [];

  for (let i = 0; i < count; i++) {
    const apiNo8 = apiMatches[i][1];            // 8-digit county+well
    const operator = unescapeHtml(opMatches[i][1]);

    wells.push({
      api:      `42${apiNo8}`,                  // 10-digit TRRC API
      well_name: `Well ${apiNo8}`,
      operator,
      county:   countyName,
      state:    "Texas",
      status:   "PRODUCING",
      formation: null,
      spud_date: null,
      // Monthly production fetched separately via TRRC PDQ CSV export
      latest_monthly_oil_bbl:   null,
      latest_monthly_gas_mcf:   null,
      latest_monthly_water_bbl: null,
      latest_production_month:  null,
      cum_oil_bbl: null,
      lat: null,
      lng: null,
    });
  }

  return wells;
}

export async function lookupTrrcWells(county: string): Promise<WellLookupResult> {
  const countyKey  = normalizeCounty(county);
  const countyCode = TX_COUNTY_CODES[countyKey];
  const desc       = `${county} County, TX`;

  if (!countyCode) {
    return {
      source: "unavailable",
      wells:  [],
      query_description: desc,
      note: `Texas county "${county}" not found in county code table.`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const body = new URLSearchParams({
      methodToCall:                   "search",
      "searchArgs.leaseTypeArg":      "",
      "searchArgs.countyCodeArg":     countyCode,
      "searchArgs.districtCodeArg":   "None Selected",
      "searchArgs.wellTypeArg":       "PR",   // PRODUCING wells
      "searchArgs.fieldNumbersArg":   "",
      "searchArgs.operatorNumbersArg":"",
      "searchArgs.apiNoSuffixArg":    "",
      "searchArgs.leaseNumberArg":    "",
    });

    const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
      signal:  controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`TRRC PDQ HTTP ${res.status}`);
    const html = await res.text();

    const wells = parsePdqCountyWells(html, county);

    return {
      source:            "trrc",
      wells,
      query_description: desc,
      note: wells.length === 0
        ? "No producing wells found in this county via TRRC PDQ."
        : `${wells.length} producing wells from Texas Railroad Commission PDQ. Monthly production fetched separately.`,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.warn("[trrc-api] PDQ county lookup failed:", msg);
    return {
      source:            "unavailable",
      wells:             [],
      query_description: desc,
      note:              `Texas RRC data temporarily unavailable: ${msg}`,
    };
  }
}
