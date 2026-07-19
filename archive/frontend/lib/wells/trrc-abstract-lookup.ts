/**
 * Texas-specific well lookup via land survey abstract polygons.
 *
 * Two public ArcGIS services are used:
 *
 * 1. Original Texas Land Survey (OTLS) — UT Austin / RRC version
 *    https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/Original_Texas_Land_Survey/FeatureServer/0
 *    Fields: ABSTRACT_N (county FIPS prefix + abstract), LEVEL1_SUR (survey grantee),
 *            LEVEL2_BLO (block), LEVEL3_SUR (section), ABSTRACT_L ("A-XXXX")
 *    Geometry: polygon, requested in WGS84 (outSR=4326)
 *
 * 2. Statewide Surface Wells (Jan 2020)
 *    https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0
 *    Fields: API (8-digit county+well), LAT83, LONG83
 *
 * Approach:
 *   Parse legal description → look up the OTLS polygon for that survey tract →
 *   spatial query (bbox) on the wells layer → API numbers → TRRC production fetch.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const OTLS_URL =
  "https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/Original_Texas_Land_Survey/FeatureServer/0/query";

const STATEWIDE_WELLS_URL =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0/query";

// Texas FIPS county codes (3-digit, odd 001-507) — subset of common O&G counties.
// These must match the prefix used in OTLS ABSTRACT_N field.
const TX_COUNTY_FIPS: Record<string, string> = {
  anderson: "001", andrews: "003", angelina: "005", aransas: "007",
  archer: "009", armstrong: "011", atascosa: "013", austin: "015",
  bailey: "017", bandera: "019", bastrop: "021", baylor: "023",
  bee: "025", bell: "027", bexar: "029", blanco: "031",
  borden: "033", bosque: "035", bowie: "037", brazoria: "039",
  brazos: "041", brewster: "043", briscoe: "045", brooks: "047",
  brown: "049", burleson: "051", burnet: "053", caldwell: "055",
  calhoun: "057", callahan: "059", cameron: "061", camp: "063",
  carson: "065", cass: "067", castro: "069", chambers: "071",
  cherokee: "073", childress: "075", clay: "077", cochran: "079",
  coke: "081", coleman: "083", collin: "085", collingsworth: "087",
  colorado: "089", comal: "091", comanche: "093", concho: "095",
  cooke: "097", coryell: "099", cottle: "101", crane: "103",
  crockett: "105", crosby: "107", culberson: "109", dallam: "111",
  dallas: "113", dawson: "115", "deaf smith": "117", delta: "119",
  denton: "121", dewitt: "123", dickens: "125", dimmit: "127",
  donley: "129", duval: "131", eastland: "133", ector: "135",
  edwards: "137", ellis: "139", "el paso": "141", erath: "143",
  falls: "145", fannin: "147", fayette: "149", fisher: "151",
  floyd: "153", foard: "155", "fort bend": "157", franklin: "159",
  freestone: "161", frio: "163", gaines: "165", galveston: "167",
  garza: "169", gillespie: "171", glasscock: "173", goliad: "175",
  gonzales: "177", gray: "179", grayson: "181", gregg: "183",
  grimes: "185", guadalupe: "187", hale: "189", hall: "191",
  hamilton: "193", hansford: "195", hardeman: "197", hardin: "199",
  harris: "201", harrison: "203", hartley: "205", haskell: "207",
  hays: "209", hemphill: "211", henderson: "213", hidalgo: "215",
  hill: "217", hockley: "219", hood: "221", hopkins: "223",
  houston: "225", howard: "227", hudspeth: "229", hunt: "231",
  hutchinson: "233", irion: "235", jack: "237", jackson: "239",
  jasper: "241", "jeff davis": "243", jefferson: "245", "jim hogg": "247",
  "jim wells": "249", johnson: "251", jones: "253", karnes: "255",
  kaufman: "257", kendall: "259", kenedy: "261", kent: "263",
  kerr: "265", kimble: "267", king: "269", kinney: "271",
  kleberg: "273", knox: "275", lamar: "277", lamb: "279",
  lampasas: "281", "la salle": "283", lavaca: "285", lee: "287",
  leon: "289", liberty: "291", limestone: "293", lipscomb: "295",
  "live oak": "297", llano: "299", loving: "301", lubbock: "303",
  lynn: "305", "mc culloch": "307", mcmullen: "311", madison: "313",
  marion: "315", martin: "317", mason: "319", matagorda: "321",
  maverick: "323", medina: "325", menard: "327", midland: "329",
  milam: "331", mills: "333", mitchell: "335", montague: "337",
  montgomery: "339", moore: "341", morris: "343", motley: "345",
  nacogdoches: "347", navarro: "349", newton: "351", nolan: "353",
  nueces: "355", ochiltree: "357", oldham: "359", orange: "361",
  "palo pinto": "363", panola: "365", parker: "367", parmer: "369",
  pecos: "371", polk: "373", potter: "375", presidio: "377",
  rains: "379", randall: "381", reagan: "383", real: "385",
  "red river": "387", reeves: "389", refugio: "391", roberts: "393",
  robertson: "395", rockwall: "397", runnels: "399", rusk: "401",
  sabine: "403", "san augustine": "405", "san jacinto": "407",
  "san patricio": "409", "san saba": "411", schleicher: "413",
  scurry: "415", shackelford: "417", shelby: "419", sherman: "421",
  smith: "423", somervell: "425", starr: "427", stephens: "429",
  sterling: "431", stonewall: "433", sutton: "435", swisher: "437",
  tarrant: "439", taylor: "441", terrell: "443", terry: "445",
  throckmorton: "447", titus: "449", "tom green": "451", travis: "453",
  trinity: "455", tyler: "457", upshur: "459", upton: "461",
  uvalde: "463", "val verde": "465", "van zandt": "467", victoria: "469",
  walker: "471", waller: "473", ward: "475", washington: "477",
  webb: "479", wharton: "481", wheeler: "483", wichita: "485",
  wilbarger: "487", willacy: "489", williamson: "491", wilson: "493",
  winkler: "495", wise: "497", wood: "499", yoakum: "501",
  young: "503", zapata: "505", zavala: "507",
  // Common aliases
  mcculloch: "307", "mc mullen": "311",
};

// Normalize survey company names from legal descriptions to OTLS LEVEL1_SUR values.
// Each entry: [pattern, canonical OTLS name].
//
// Patterns must handle:
//  • Ampersand forms: "H&TC", "H & TC"
//  • Dot/period forms: "H.T.C.", "T.P.", "G.C.&S.F."
//  • Spelled-out forms: "Houston and Texas Central"
//  • Mixed abbreviations: "H.&T.C.", "T. & P."
const SURVEY_NORMALIZATIONS: Array<[RegExp, string]> = [
  // H&TC / Houston & Texas Central  ("H.T.C.", "H&TC", "Houston and Texas Central")
  [/h\.?\s*[&.+and\s]*\s*t\.?c\.?|houston\s*(?:[&+]|and)\s*texas\s*central/i,  "H&TC RR CO"],
  // GC&SF / Gulf, Colorado & Santa Fe  ("G.C.&S.F.", "GC&SF", "Gulf Colorado Santa Fe")
  [/g\.?c\.?\s*[&.+]*\s*s\.?f\.?|gulf[\s,]+colorado\s*(?:[&+]|and)\s*santa\s*fe/i, "GC&SF RR CO"],
  // T&P / Texas & Pacific  ("T.P.", "T&P", "T. & P.", "Texas Pacific")
  [/t\.?\s*[&.+]?\s*p\.?(?:\s*(?:rr|railroad|railway))?(?!\w)|texas\s*(?:[&+]|and)\s*pacific/i, "T&P RR CO"],
  // I&GN / International & Great Northern  ("I.&G.N.", "I&GN")
  [/i\.?\s*[&.+]?\s*g\.?n\.?|international\s*(?:[&+]|and)\s*great\s*northern/i, "I&GN RR CO"],
  // H&GN / Houston & Great Northern  ("H.&G.N.", "H&GN")
  [/h\.?\s*[&.+]?\s*g\.?n\.?(?!\s*tc)|houston\s*(?:[&+]|and)\s*great\s*northern/i, "H&GN RR CO"],
  // MK&T / Missouri-Kansas-Texas / Katy
  [/m\.?k\.?\s*[&.+]?\s*t\.?|missouri[\s,.-]+kansas[\s,.-]+texas|katy\s+r/i,    "MK&T"],
  // SP / Southern Pacific  ("S.P.", "SP RR")
  [/s\.?p\.?\s*(?:rr|railroad)?(?=\s|$)|southern\s*pacific(?!\s*st)/i,           "SP RR CO"],
  // A&M / Agriculture & Mechanical
  [/a\.?\s*[&.+]?\s*m\.?\s+(?:college|university|survey|rr)?|agriculture\s*(?:[&+]|and)\s*mechanical/i, "A&M"],
  // AB&M / Austin-Brazoria & Mississippi  ("A.B.&M.", "AB&M")
  [/a\.?b\.?\s*[&.+]\s*m\.?|austin\s*(?:[&+]|and)\s*brazoria/i,                 "AB&M RR CO"],
  // ACH&B
  [/a\.?c\.?h\.?\s*[&.+]\s*b\.?/i,                                               "ACH&B RR CO"],
  // International  (catch-all for International RR)
  [/\binternat(?:ional)?\s+(?:rr|railroad|railway)\b/i,                           "I&GN RR CO"],
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCountyKey(county: string): string {
  return county.toLowerCase().replace(/\s*county\s*$/i, "").trim();
}

function getFipsByCounty(county: string | null): string | null {
  if (!county) return null;
  const key = normalizeCountyKey(county);
  return TX_COUNTY_FIPS[key] ?? null;
}

/** Normalize user-supplied survey name to OTLS LEVEL1_SUR canonical value. */
export function normalizeSurveyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  for (const [re, canonical] of SURVEY_NORMALIZATIONS) {
    if (re.test(s)) return canonical;
  }
  // Fallback: strip common noise words and upper-case
  return s
    .replace(/\b(?:Railway|Railroad|Ry|Rr|Company|Co\.?|Survey|Srvy)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase() || null;
}

/** Convert the 8-digit OTLS/wells-layer API to standard 10-digit TRRC API (with "42" prefix). */
function toTrrcApi(shortApi: string): string | null {
  const clean = shortApi.replace(/\D/g, "");
  if (clean.length === 8) return `42${clean}`;
  if (clean.length === 10 && clean.startsWith("42")) return clean;
  return null;
}

function polygonCentroid(rings: number[][][]): { lat: number; lng: number } {
  const ring = rings[0] ?? [];
  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  return {
    lat: lats.reduce((a, b) => a + b, 0) / lats.length,
    lng: lons.reduce((a, b) => a + b, 0) / lons.length,
  };
}

function polygonBbox(rings: number[][][]): {
  minLat: number; maxLat: number; minLng: number; maxLng: number;
} {
  const ring = rings[0] ?? [];
  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lons),
    maxLng: Math.max(...lons),
  };
}

/**
 * Ray-casting point-in-polygon test (Jordan curve theorem).
 * `ring` is an array of [lng, lat] pairs (the first polygon ring in WGS84).
 * Returns true when the point (px=lng, py=lat) lies inside the ring.
 *
 * A small tolerance (~0.0004° ≈ 40m) is added to the bbox pre-check so that
 * directional wells whose surface location is just outside the survey boundary
 * are still captured.
 */
function pointInPolygonWithBuffer(
  px: number, py: number,
  ring: number[][],
  buf = 0.0004,
): boolean {
  // Quick bbox pre-check with buffer — skip expensive ray cast for obvious misses
  const lngs = ring.map(p => p[0]);
  const lats  = ring.map(p => p[1]);
  if (
    px < Math.min(...lngs) - buf || px > Math.max(...lngs) + buf ||
    py < Math.min(...lats) - buf || py > Math.max(...lats) + buf
  ) return false;

  // Ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  // If the strict test says outside, re-run with buffered polygon vertices.
  // This handles edge cases where the well surface is just over the tract boundary.
  if (!inside) {
    // Compute buffered ring: each vertex expanded outward from centroid
    const cx = lngs.reduce((a, b) => a + b, 0) / lngs.length;
    const cy = lats.reduce((a, b) => a + b, 0) / lats.length;
    const bufferedRing = ring.map(([x, y]) => [
      cx + (x - cx) * (1 + buf / Math.max(Math.abs(x - cx), 0.0001)),
      cy + (y - cy) * (1 + buf / Math.max(Math.abs(y - cy), 0.0001)),
    ]);
    let insideBuffered = false;
    for (let i = 0, j = bufferedRing.length - 1; i < bufferedRing.length; j = i++) {
      const xi = bufferedRing[i][0], yi = bufferedRing[i][1];
      const xj = bufferedRing[j][0], yj = bufferedRing[j][1];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        insideBuffered = !insideBuffered;
      }
    }
    return insideBuffered;
  }

  return inside;
}

// ── OTLS polygon lookup ────────────────────────────────────────────────────────

type OtlsFeature = {
  attributes: {
    ABSTRACT_N: string;
    LEVEL1_SUR: string;
    LEVEL2_BLO: string;
    LEVEL3_SUR: string;
    ABSTRACT_L: string;
  };
  geometry?: { rings: number[][][] };
};

/**
 * Look up one or more OTLS polygons for the specified survey tract.
 * Accepts EITHER abstract number (most precise) OR survey+block+section.
 */
async function fetchOtlsPolygons(params: {
  countyFips: string;
  abstract_number?: string | null;
  survey_level1?: string | null;   // normalized OTLS LEVEL1_SUR
  block?: string | null;
  section?: string | null;
}, signal?: AbortSignal): Promise<OtlsFeature[]> {
  const whereClauses: string[] = [];

  // Always constrain to county via ABSTRACT_N prefix
  whereClauses.push(`ABSTRACT_N LIKE '${params.countyFips}%'`);

  if (params.abstract_number) {
    // Match ABSTRACT_L = "A-{abstract_number}"
    whereClauses.push(`ABSTRACT_L = 'A-${params.abstract_number}'`);
  } else {
    if (params.survey_level1) {
      whereClauses.push(`LEVEL1_SUR = '${params.survey_level1.replace(/'/g, "''")}'`);
    }
    if (params.block) {
      whereClauses.push(`LEVEL2_BLO = '${params.block.replace(/'/g, "''")}'`);
    }
    if (params.section) {
      // OTLS stores section numbers with inconsistent zero-padding ("79", "079", "0079").
      // Build an IN clause covering the raw value plus zero-padded variants.
      const sec = params.section.replace(/'/g, "''");
      const padded2 = sec.padStart(3, "0");  // "79" → "079"
      const padded3 = sec.padStart(4, "0");  // "79" → "0079"
      const variantSet: string[] = [];
      for (const v of [sec, padded2, padded3]) { if (!variantSet.includes(v)) variantSet.push(v); }
      const variants = variantSet.map(v => `'${v}'`).join(",");
      whereClauses.push(`LEVEL3_SUR IN (${variants})`);
    }
  }

  if (whereClauses.length <= 1) {
    // County-only filter would return thousands of records — abort
    return [];
  }

  const qp = new URLSearchParams({
    where:         whereClauses.join(" AND "),
    outFields:     "ABSTRACT_N,LEVEL1_SUR,LEVEL2_BLO,LEVEL3_SUR,ABSTRACT_L",
    returnGeometry:"true",
    outSR:         "4326",
    resultRecordCount: "10",
    f:             "json",
  });

  const res = await fetch(`${OTLS_URL}?${qp}`, { signal });
  if (!res.ok) throw new Error(`OTLS HTTP ${res.status}`);
  const json = await res.json() as { features?: OtlsFeature[]; error?: { message: string } };
  if (json.error) throw new Error(`OTLS error: ${json.error.message}`);
  return json.features ?? [];
}

// ── Statewide wells spatial query ─────────────────────────────────────────────

type WellsFeature = {
  attributes: { API: string; LAT83: number | null; LONG83: number | null };
};

/**
 * Fetch wells whose surface location falls within the bounding box of the given polygon.
 * Uses a 0.002° bbox buffer to catch wells near the boundary, but the caller is
 * responsible for filtering to the actual polygon geometry via `pointInPolygonWithBuffer`.
 */
async function fetchWellsInBbox(
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  signal?: AbortSignal,
): Promise<WellsFeature[]> {
  const { minLat, maxLat, minLng, maxLng } = bbox;

  // Use a conservative 0.002° bbox buffer so we don't miss wells near the boundary.
  // Results are post-filtered to the actual polygon in the caller.
  const buf = 0.002;
  const qp = new URLSearchParams({
    where: `LAT83 BETWEEN ${minLat - buf} AND ${maxLat + buf} AND LONG83 BETWEEN ${minLng - buf} AND ${maxLng + buf}`,
    outFields:     "API,LAT83,LONG83",
    returnGeometry:"false",
    resultRecordCount: "200",
    f:             "json",
  });

  const res = await fetch(`${STATEWIDE_WELLS_URL}?${qp}`, { signal });
  if (!res.ok) throw new Error(`Statewide Wells HTTP ${res.status}`);
  const json = await res.json() as { features?: WellsFeature[]; error?: { message: string } };
  if (json.error) throw new Error(`Statewide Wells error: ${json.error.message}`);
  return json.features ?? [];
}

// ── Public API ────────────────────────────────────────────────────────────────

export type AbstractLookupResult = {
  /** Full 10-digit TRRC API numbers (42XXXXXXXX) found on this tract */
  api_numbers: string[];
  /** Centroid of the matched polygon (WGS84) */
  centroid: { lat: number; lng: number } | null;
  /** Human-readable description of what was matched */
  description: string;
  /** How many OTLS polygons matched the legal description */
  polygon_count: number;
};

/**
 * Given a Texas legal description (parsed), find TRRC API numbers for wells on that tract.
 *
 * Returns null when:
 *  - State is not Texas
 *  - County FIPS cannot be determined
 *  - No survey identifiers to query (no abstract#, no survey+block+section)
 *  - Network errors
 */
export async function lookupWellsByLegalDescription(params: {
  county: string | null;
  state:  string | null;
  abstract_number: string | null;
  survey_name:     string | null;
  block:           string | null;
  section:         string | null;
}): Promise<AbstractLookupResult | null> {
  // Only applies to Texas (accept both "Texas" and "TX")
  if (!params.state || !/^texas$|^tx$/i.test(params.state.trim())) return null;

  const countyFips = getFipsByCounty(params.county);
  if (!countyFips) return null;

  // Need at least one survey identifier beyond county
  const hasAbstract  = !!params.abstract_number;
  const hasSurveyIds = !!(params.survey_name || params.block || params.section);
  if (!hasAbstract && !hasSurveyIds) return null;

  // Need at least 2 identifiers to avoid overly broad queries
  const idCount = [params.abstract_number, params.survey_name, params.block, params.section].filter(Boolean).length;
  if (!hasAbstract && idCount < 2) return null;

  try {
    const normalizedSurvey = normalizeSurveyName(params.survey_name);
    const signal = AbortSignal.timeout(30_000);

    const polygons = await fetchOtlsPolygons({
      countyFips,
      abstract_number: params.abstract_number,
      survey_level1:   normalizedSurvey,
      block:           params.block,
      section:         params.section,
    }, signal);

    if (polygons.length === 0) {
      return null;
    }

    // Collect all API numbers across all matched polygons
    const apiSet = new Set<string>();
    let overallCentroid: { lat: number; lng: number } | null = null;

    for (const poly of polygons) {
      const rings = poly.geometry?.rings;
      if (!rings || rings.length === 0) continue;

      if (!overallCentroid) overallCentroid = polygonCentroid(rings);
      const bbox = polygonBbox(rings);
      const wellFeatures = await fetchWellsInBbox(bbox, signal);

      // The bbox query over-fetches (includes neighboring tracts).
      // Filter to wells whose surface location actually falls within THIS polygon
      // using a ray-casting point-in-polygon test with a small buffer for edge cases.
      // Wells with missing coordinates fall back to bbox-only (kept to be safe).
      const ring = rings[0];

      for (const wf of wellFeatures) {
        const rawApi = String(wf.attributes.API ?? "").replace(/\D/g, "");
        // Skip stub records that only contain the county code
        if (rawApi.length < 8) continue;

        // Polygon filter: skip wells outside this tract
        const lat = wf.attributes.LAT83;
        const lng = wf.attributes.LONG83;
        if (lat != null && lng != null && ring && ring.length > 2) {
          if (!pointInPolygonWithBuffer(lng, lat, ring)) continue;
        }

        const full = toTrrcApi(rawApi);
        if (full) apiSet.add(full);
      }
    }

    const apis = Array.from(apiSet);
    if (apis.length === 0) return null;

    // Build human-readable description
    const firstPoly = polygons[0].attributes;
    const descParts: string[] = [];
    if (firstPoly.ABSTRACT_L) descParts.push(firstPoly.ABSTRACT_L);
    if (firstPoly.LEVEL1_SUR?.trim()) descParts.push(firstPoly.LEVEL1_SUR.trim());
    if (firstPoly.LEVEL2_BLO?.trim()) descParts.push(`Block ${firstPoly.LEVEL2_BLO.trim()}`);
    if (firstPoly.LEVEL3_SUR?.trim()) descParts.push(`Section ${firstPoly.LEVEL3_SUR.trim()}`);
    if (params.county) {
      // Avoid "Fisher County County" if county already ends with "County"
      const countyLabel = /\bcounty\b/i.test(params.county) ? params.county : `${params.county} County`;
      descParts.push(countyLabel);
    }
    const description = descParts.join(", ");

    return {
      api_numbers:   apis,
      centroid:      overallCentroid,
      description,
      polygon_count: polygons.length,
    };
  } catch {
    return null;
  }
}
