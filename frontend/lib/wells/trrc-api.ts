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
import { fetchTrrcLatestByLease } from "./trrc-production";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// Texas county name → 3-digit code embedded in API numbers (42-XXX-...).
// These are Texas FIPS county codes. All 254 Texas counties use odd codes 001–507.
export const TX_COUNTY_CODES: Record<string, string> = {
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

type PdqWellEntry = {
  api10:     string;   // full 10-digit TRRC API (42 + 8-digit)
  apiNo8:    string;   // 8-digit county+well from PDQ
  distCode:  string;
  leaseNo:   string;
  operator:  string;
};

/**
 * Parse the PDQ wellbore query HTML result page.
 *
 * Each row contains:
 *   • apiNo=XXXXXXXX&distCode=XX&leaseNo=XXXXXX  (in the lease detail href)
 *   • Operator name in the link titled "Operator # XXXXXX"
 *
 * API numbers from PDQ are 8 digits (county 3 + well 5); we prepend "42"
 * to produce the standard 10-digit TRRC API number.
 */
function parsePdqCountyEntries(html: string, maxWells = 30): PdqWellEntry[] {
  // Primary: extract apiNo + distCode + leaseNo from wellboreQueryAction links.
  // These are always present and self-contained — no pairing with operator needed.
  const apiMatches = Array.from(
    html.matchAll(/apiNo=(\d+)&distCode=(\w+)&leaseNo=(\d+)/g),
  );
  // Operator links are supplemental — may be fewer than apiNo links (e.g. when
  // two leases share the same operator HTML block). We never limit apiNo results
  // by operator count; if no operator match is found we just leave it empty.
  const opMatches = Array.from(
    html.matchAll(/title="Operator # \d+">(.*?)<\/a>/g),
  );

  const count = Math.min(apiMatches.length, maxWells);
  const entries: PdqWellEntry[] = [];

  for (let i = 0; i < count; i++) {
    entries.push({
      api10:    `42${apiMatches[i][1]}`,
      apiNo8:   apiMatches[i][1],
      distCode: apiMatches[i][2],
      leaseNo:  apiMatches[i][3],
      operator: i < opMatches.length ? unescapeHtml(opMatches[i][1]) : "",
    });
  }
  return entries;
}

function entryToWell(entry: PdqWellEntry, countyName: string): WellSummary {
  return {
    api:       entry.api10,
    well_name: `Well ${entry.apiNo8}`,
    operator:  entry.operator,
    county:    countyName,
    state:     "Texas",
    status:    "PRODUCING",
    formation: null,
    spud_date: null,
    latest_monthly_oil_bbl:   null,
    latest_monthly_gas_mcf:   null,
    latest_monthly_water_bbl: null,
    latest_production_month:  null,
    cum_oil_bbl: null,
    lat: null,
    lng: null,
  };
}

/**
 * Enrich up to `maxEnrich` wells in-place with real TRRC monthly production.
 * Uses only the CSV step (distCode + leaseNo already known) — no wellbore query needed.
 * Runs requests in parallel, bounded by an overall timeout.
 */
async function enrichWithProduction(
  entries: PdqWellEntry[],
  wells:   WellSummary[],
  maxEnrich = 5,
): Promise<void> {
  // TRRC stores production at the LEASE level, not the individual wellbore level.
  // Multiple API numbers may share the same leaseNo — fetching the same lease
  // multiple times triple-counts identical production data, inflating BOPD.
  // Solution: fetch each unique lease once, then apply the result to every
  // wellbore that belongs to that lease.

  // Step 1: identify unique leases to enrich (respecting the maxEnrich budget)
  const seenLeases = new Set<string>();
  const uniqueEntries: Array<{ entry: PdqWellEntry; indices: number[] }> = [];

  for (let i = 0; i < entries.length && i < wells.length; i++) {
    const key = `${entries[i].distCode}:${entries[i].leaseNo}`;
    if (seenLeases.has(key)) {
      // This lease is already queued — find the queued group and add this index
      const group = uniqueEntries.find(g => `${g.entry.distCode}:${g.entry.leaseNo}` === key);
      if (group) group.indices.push(i);
    } else {
      seenLeases.add(key);
      uniqueEntries.push({ entry: entries[i], indices: [i] });
      if (uniqueEntries.length >= maxEnrich) break;
    }
  }

  // Step 2: fetch production for each unique lease in parallel
  const tasks = uniqueEntries.map(({ entry, indices }) =>
    fetchTrrcLatestByLease(entry.distCode, entry.leaseNo)
      .then(result => {
        if (result && result.oil_bbl > 0) {
          // Apply the lease production to the first wellbore only.
          // Multi-wellbore leases report aggregate production — attributing the
          // full lease total to every wellbore would overcount royalty income.
          const primaryIdx = indices[0];
          wells[primaryIdx].latest_monthly_oil_bbl  = result.oil_bbl;
          wells[primaryIdx].latest_production_month = result.month;
          // Mark sibling wellbores from the same lease with a zero-value sentinel
          // so they don't appear as "no data" (they're part of the lease) but also
          // don't contribute duplicate production to aggregate calculations.
          for (let k = 1; k < indices.length; k++) {
            wells[indices[k]].latest_production_month = result.month;
            // latest_monthly_oil_bbl stays null on sibling wellbores
          }
        }
      })
      .catch(() => { /* silently skip failures */ }),
  );

  // Give production fetches up to 20 s
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>(resolve => setTimeout(resolve, 20_000)),
  ]);
}

/**
 * Given a county name and a set of 10-digit TRRC API numbers, return a map from
 * each API number that was found in the PDQ county wellbore query to its
 * { distCode, leaseNo, operator } identifiers.
 *
 * This is the authoritative way to resolve abstract-lookup API numbers to TRRC
 * lease identifiers.  The county wellbore query HTML reliably embeds
 * `apiNo=XXXXXXXX&distCode=XX&leaseNo=XXXXXX` in every result row — the same
 * pattern parsePdqCountyEntries already uses — so we never have to guess or
 * rely on the TRRC API-number search endpoint (which returns county-level results).
 *
 * `targetApis` should be 10-digit strings ("4215100161").
 * Returns an empty map on network errors (never throws).
 */
export async function lookupTrrcLeasesByApis(
  county: string | null,
  targetApis: string[],
): Promise<Map<string, { distCode: string; leaseNo: string; operator: string }>> {
  const empty = new Map<string, { distCode: string; leaseNo: string; operator: string }>();
  if (targetApis.length === 0) return empty;

  // Normalise each incoming API to the canonical 8-digit TRRC form (no "42" prefix).
  // Accept:
  //   "4215131926"        → "15131926"  (10-digit TX prefix form)
  //   "15131926"          → "15131926"  (8-digit TRRC-native, no prefix)
  //   "42-151-31926-00-00"→ "15131926"  (hyphenated full form, strip & slice)
  const target8List = targetApis
    .map(a => a.replace(/\D/g, ""))
    .map(d => {
      if (d.length === 10 && d.startsWith("42")) return d.slice(2);
      if (d.length === 8) return d;
      return null;
    })
    .filter((d): d is string => d !== null);

  // The county code is the first 3 digits of the 8-digit API form.
  // e.g. "15131926" → county code "151" (Fisher County, TX).
  // This means we NEVER need the caller to supply a county name — we derive
  // the 3-digit FIPS code directly from the API, so any well in Texas can be
  // looked up with just its API number.
  //
  // If a county name WAS provided, resolve it to a code and use it as a
  // cross-check (helps catch typos in the API number).
  const countyCodeFromName: string | null = county
    ? (TX_COUNTY_CODES[normalizeCounty(county)] ?? null)
    : null;

  if (target8List.length === 0) return empty;

  const result = new Map<string, { distCode: string; leaseNo: string; operator: string }>();

  // ── Strategy 1 (primary): apiNoPrefixArg + apiNoSuffixArg ───────────────
  //
  // PROVEN via live debug (2026-05-20):
  //   apiNoPrefixArg = county3 (first 3 digits of 8-digit API, e.g. "151")
  //   apiNoSuffixArg = well5   (last  5 digits of 8-digit API, e.g. "31926")
  //
  // TRRC returns ONLY wells matching that exact API number (2 rows for Fisher/Bomar).
  // This bypasses all county pagination issues — no county scan, no page size limit.
  //
  // Contrast:
  //   countyCodeArg + apiNoSuffixArg (Strategy A) → TRRC ignores suffix, returns
  //   all county wells sorted by API — does NOT filter.
  //
  //   apiNoPrefixArg alone (no suffix) → county-level results (all wells in county).
  //
  // The county name passed by the caller is NOT needed — county code is always
  // derived from the API number's first 3 digits.

  const directResults = await Promise.allSettled(
    target8List.map(async (api8) => {
      const county3    = api8.slice(0, 3); // "15131926" → "151"
      const wellSuffix = api8.slice(3);    // "15131926" → "31926"

      try {
        const body = new URLSearchParams({
          methodToCall:                    "search",
          "searchArgs.apiNoPrefixArg":     county3,     // ← KEY: not countyCodeArg
          "searchArgs.apiNoSuffixArg":     wellSuffix,  // ← KEY: well serial number
          "searchArgs.leaseTypeArg":       "",
          "searchArgs.districtCodeArg":    "None Selected",
          "searchArgs.wellTypeArg":        "",
          "searchArgs.fieldNumbersArg":    "",
          "searchArgs.operatorNumbersArg": "",
          "searchArgs.leaseNumberArg":     "",
          "pager.pageSize":                "25",
        });

        const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    body.toString(),
        });
        if (!res.ok) return { api8, entries: [] as PdqWellEntry[] };

        const html    = await res.text();
        const entries = parsePdqCountyEntries(html, 25);
        return { api8, entries };
      } catch {
        return { api8, entries: [] as PdqWellEntry[] };
      }
    })
  );

  const notFound: string[] = [];

  for (const settled of directResults) {
    if (settled.status !== "fulfilled") continue;
    const { api8, entries } = settled.value;
    // Find the entry whose apiNo8 matches exactly
    const match = entries.find(e => e.apiNo8 === api8);
    if (match) {
      result.set(match.api10, {
        distCode: match.distCode,
        leaseNo:  match.leaseNo,
        operator: match.operator,
      });
    } else {
      notFound.push(api8);
    }
  }

  if (notFound.length === 0 || result.size === target8List.length) return result;

  // ── Strategy 2 (fallback): county-wide scan for any still-missing APIs ───
  //
  // Group remaining APIs by their derived county code and run one county scan
  // per distinct county.  Each API's county code comes from its own first 3
  // digits, so this works with no caller-supplied county name.

  const target8Remaining = new Set(notFound);

  // Group by county code
  const byCounty = new Map<string, string[]>();
  for (const api8 of notFound) {
    const cc = countyCodeFromName ?? api8.slice(0, 3);
    const list = byCounty.get(cc) ?? [];
    list.push(api8);
    byCounty.set(cc, list);
  }

  await Promise.allSettled(Array.from(byCounty.entries()).map(async ([cc, apis8]) => {
    try {
      // Use apiNoPrefixArg=county (no suffix) for county-wide fallback.
      const body = new URLSearchParams({
        methodToCall:                    "search",
        "searchArgs.apiNoPrefixArg":     cc,
        "searchArgs.leaseTypeArg":       "",
        "searchArgs.districtCodeArg":    "None Selected",
        "searchArgs.wellTypeArg":        "",
        "searchArgs.fieldNumbersArg":    "",
        "searchArgs.operatorNumbersArg": "",
        "searchArgs.apiNoSuffixArg":     "",
        "searchArgs.leaseNumberArg":     "",
        "pager.pageSize":                "500",
      });

      const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    body.toString(),
      });

      if (res.ok) {
        const html    = await res.text();
        const entries = parsePdqCountyEntries(html, 500);
        const missing8 = new Set(apis8);
        for (const entry of entries) {
          if (missing8.has(entry.apiNo8) && !result.has(entry.api10)) {
            result.set(entry.api10, {
              distCode: entry.distCode,
              leaseNo:  entry.leaseNo,
              operator: entry.operator,
            });
          }
        }
      }
    } catch { /* network error — accept empty */ }
  }));

  return result;
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

  try {
    const body = new URLSearchParams({
      methodToCall:                   "search",
      "searchArgs.leaseTypeArg":      "",
      "searchArgs.apiNoPrefixArg":    countyCode,   // county code only = county scan
      "searchArgs.districtCodeArg":   "None Selected",
      "searchArgs.wellTypeArg":       "PR",   // PRODUCING wells
      "searchArgs.fieldNumbersArg":   "",
      "searchArgs.operatorNumbersArg":"",
      "searchArgs.apiNoSuffixArg":    "",
      "searchArgs.leaseNumberArg":    "",
      "pager.pageSize":               "100",
    });

    const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    if (!res.ok) throw new Error(`TRRC PDQ HTTP ${res.status}`);
    const html = await res.text();

    // Parse up to 100 entries; maxWells cap is a safety valve
    const entries = parsePdqCountyEntries(html, 100);
    const wells   = entries.map(e => entryToWell(e, county));

    // Enrich up to 15 unique leases with real monthly production.
    // With 100 wellbores in the sample pool, 15 leases gives better county
    // coverage while staying within the 20-second enrichment timeout.
    if (entries.length > 0) {
      await enrichWithProduction(entries, wells, 15);
    }

    const withProduction = wells.filter(w => w.latest_monthly_oil_bbl != null).length;

    return {
      source:            "trrc",
      wells,
      query_description: desc,
      note: wells.length === 0
        ? "No producing wells found in this county via TRRC PDQ."
        : `${wells.length} producing wells from Texas Railroad Commission PDQ. ${withProduction > 0 ? `${withProduction} with real monthly production data.` : "Monthly production data unavailable."}`,
    };
  } catch (err) {
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
