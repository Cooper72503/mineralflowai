/**
 * Texas land-grid geocoding via the Original Texas Land Survey (OTLS)
 * public ArcGIS FeatureServer — real survey/abstract polygons, not
 * fabricated tract boundaries. This is the "Texas GLO or county GIS
 * records" tier of the Phase 3 provider priority (there is no existing
 * Mineral Flow AI survey/parcel database — confirmed in the Phase 0 audit
 * — so this is the first tier actually available).
 *
 * County -> abstract-prefix table adapted from a real prior implementation
 * found in archive/frontend/lib/wells/trrc-abstract-lookup.ts during the
 * Phase 0 audit, WITH A REAL GAP FIXED: that table was missing McLennan
 * County (prefix 309) entirely — confirmed live 2026-08-04 by querying
 * OTLS directly for ABSTRACT_N LIKE '309%' and getting real survey-grantee
 * records back (O'ROURKE, WELCH, CALL — genuine 19th-century Texas
 * land-grant names in the Waco area, not synthetic data).
 *
 * Also fixes a real CRS bug the archived version had: it read raw OTLS
 * ring coordinates as if they were lat/lng, but the service's native
 * spatial reference is wkid 102039 (a projected, meters-based CRS), NOT
 * WGS84 — confirmed live by requesting the same feature both ways. This
 * provider requests outSR=4326 explicitly so every coordinate it returns
 * is genuine WGS84 lat/lng, not silently wrong.
 */

import type { GeocodeResult, TexasLegalDescription, WarningEntry } from "../types";
import { withDefaultTimeout, DEFAULT_CONFIG } from "../constants";

const OTLS_URL = "https://services1.arcgis.com/7DRakJXKPEhwv0fM/arcgis/rest/services/Original_Texas_Land_Survey/FeatureServer/0/query";

// County name -> 3-digit abstract-prefix used in OTLS's ABSTRACT_N field.
// Real, complete 254-county Texas list (the archived source this was
// adapted from covered 253 — McLennan added here after live verification).
export const TX_COUNTY_ABSTRACT_PREFIX: Record<string, string> = {
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
  lynn: "305", mcculloch: "307", "mc culloch": "307",
  mclennan: "309", // real gap in the prior implementation — fixed after live OTLS verification (see file doc comment)
  mcmullen: "311", "mc mullen": "311",
  madison: "313", marion: "315", martin: "317", mason: "319", matagorda: "321",
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
};

const SURVEY_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/h\.?\s*[&.+and\s]*\s*t\.?c\.?|houston\s*(?:[&+]|and)\s*texas\s*central/i, "H&TC RR CO"],
  [/g\.?c\.?\s*[&.+]*\s*s\.?f\.?|gulf[\s,]+colorado\s*(?:[&+]|and)\s*santa\s*fe/i, "GC&SF RR CO"],
  [/t\.?\s*[&.+]?\s*p\.?(?:\s*(?:rr|railroad|railway))?(?!\w)|texas\s*(?:[&+]|and)\s*pacific/i, "T&P RR CO"],
  [/i\.?\s*[&.+]?\s*g\.?n\.?|international\s*(?:[&+]|and)\s*great\s*northern/i, "I&GN RR CO"],
  [/h\.?\s*[&.+]?\s*g\.?n\.?(?!\s*tc)|houston\s*(?:[&+]|and)\s*great\s*northern/i, "H&GN RR CO"],
  [/m\.?k\.?\s*[&.+]?\s*t\.?|missouri[\s,.-]+kansas[\s,.-]+texas|katy\s+r/i, "MK&T"],
  [/s\.?p\.?\s*(?:rr|railroad)?(?=\s|$)|southern\s*pacific(?!\s*st)/i, "SP RR CO"],
];

export function normalizeCountyKey(county: string): string {
  return county.toLowerCase().replace(/\s*county\s*$/i, "").trim();
}

export function getAbstractPrefixByCounty(county: string | null): string | null {
  if (!county) return null;
  return TX_COUNTY_ABSTRACT_PREFIX[normalizeCountyKey(county)] ?? null;
}

export function normalizeSurveyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  for (const [re, canonical] of SURVEY_NORMALIZATIONS) {
    if (re.test(s)) return canonical;
  }
  return s
    .replace(/\b(?:Railway|Railroad|Ry|Rr|Company|Co\.?|Survey|Srvy)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase() || null;
}

interface OtlsFeature {
  attributes: { ABSTRACT_N: string; LEVEL1_SUR: string; ABSTRACT_L: string; LEVEL2_BLO?: string; LEVEL3_SUR?: string };
  geometry?: { rings: number[][][] };
}

async function queryOtls(where: string, signal?: AbortSignal): Promise<OtlsFeature[]> {
  const qs = new URLSearchParams({
    where,
    outFields: "ABSTRACT_N,LEVEL1_SUR,ABSTRACT_L,LEVEL2_BLO,LEVEL3_SUR",
    outSR: "4326", // request WGS84 explicitly — the service's native SRS (wkid 102039) is projected, not lat/lng
    returnGeometry: "true",
    resultRecordCount: "5",
    f: "json",
  });
  const res = await fetch(`${OTLS_URL}?${qs}`, { signal: withDefaultTimeout(signal, DEFAULT_CONFIG.providerTimeoutMs) });
  if (!res.ok) return [];
  const json = await res.json() as { features?: OtlsFeature[]; error?: unknown };
  if (json.error) return [];
  return json.features ?? [];
}

export async function geocodeTexasLegalDescription(desc: TexasLegalDescription, signal?: AbortSignal): Promise<GeocodeResult> {
  const now = new Date().toISOString();
  const warnings: WarningEntry[] = [];
  const prefix = getAbstractPrefixByCounty(desc.county);

  if (!prefix) {
    warnings.push({ code: "UNKNOWN_COUNTY", message: `County "${desc.county}" not recognized in the Texas abstract-prefix table`, severity: "critical" });
    return unmappable(warnings, now);
  }

  // Tier 1: exact abstract number match, if we have one.
  if (desc.canonicalAbstractNumber) {
    const digits = desc.canonicalAbstractNumber.replace(/^A-/, "").replace(/\D/g, "");
    const abstractN = `${prefix}${digits}`;
    const where = `ABSTRACT_N='${abstractN.replace(/'/g, "''")}'`;
    const features = await queryOtls(where, signal).catch(() => []);
    if (features.length === 1) {
      const surveyConfirmed = desc.surveyName
        ? normalizeSurveyName(desc.surveyName) === normalizeSurveyName(features[0].attributes.LEVEL1_SUR)
        : false;
      if (!surveyConfirmed && desc.surveyName) {
        warnings.push({
          code: "SURVEY_NAME_MISMATCH",
          message: `Abstract number matched, but survey name "${desc.surveyName}" doesn't match OTLS's recorded grantee "${features[0].attributes.LEVEL1_SUR}" — verify this is the right tract`,
          severity: "warning",
        });
      }
      return buildResult(features[0], surveyConfirmed ? "EXACT_SURVEY" : "ABSTRACT_MATCH", surveyConfirmed ? 0.9 : 0.75, warnings, now, where);
    }
    if (features.length > 1) {
      warnings.push({ code: "AMBIGUOUS_ABSTRACT_MATCH", message: `${features.length} OTLS polygons matched abstract ${abstractN} — cannot pick one without human review`, severity: "critical" });
      return manualReview(warnings, now);
    }
    warnings.push({ code: "ABSTRACT_NOT_FOUND", message: `No OTLS polygon found for abstract ${abstractN} in ${desc.county} County`, severity: "warning" });
  }

  // Tier 2: survey-name-only match within the county, when no abstract number resolved.
  if (desc.surveyName) {
    const canonical = normalizeSurveyName(desc.surveyName);
    if (canonical) {
      const where = `ABSTRACT_N LIKE '${prefix}%' AND UPPER(LEVEL1_SUR) LIKE '%${canonical.replace(/'/g, "''")}%'`;
      const features = await queryOtls(where, signal).catch(() => []);
      if (features.length === 1) {
        return buildResult(features[0], "EXACT_SURVEY", 0.7, warnings, now, where);
      }
      if (features.length > 1) {
        warnings.push({ code: "AMBIGUOUS_SURVEY_MATCH", message: `${features.length} OTLS polygons matched survey "${desc.surveyName}" in ${desc.county} County — cannot pick one without human review`, severity: "critical" });
        return manualReview(warnings, now);
      }
    }
  }

  warnings.push({ code: "NO_OTLS_MATCH", message: `No OTLS survey polygon could be matched for this Texas land-grid description in ${desc.county} County`, severity: "critical" });
  return manualReview(warnings, now);
}

function buildResult(feature: OtlsFeature, matchMethod: GeocodeResult["matchMethod"], confidence: number, warnings: WarningEntry[], retrievedAt: string, whereClause: string): GeocodeResult {
  const rings = feature.geometry?.rings ?? [];
  return {
    canonicalIdentifier: feature.attributes.ABSTRACT_L,
    centroidLatitude: null, // computed by geometry.ts (Phase 4) from the real polygon, not naively averaged here
    centroidLongitude: null,
    geometry: rings.length > 0 ? { type: "Polygon", coordinates: rings } : null,
    geometryType: rings.length > 0 ? "Polygon" : null,
    sourceProvider: "TEXAS_OTLS",
    sourceRecordId: feature.attributes.ABSTRACT_N,
    sourceUrlOrQueryId: `${OTLS_URL}?where=${encodeURIComponent(whereClause)}`,
    spatialReferenceSystem: "EPSG:4326",
    retrievedAt,
    matchMethod,
    confidence,
    warnings,
  };
}

function manualReview(warnings: WarningEntry[], retrievedAt: string): GeocodeResult {
  return {
    canonicalIdentifier: null, centroidLatitude: null, centroidLongitude: null,
    geometry: null, geometryType: null, sourceProvider: "TEXAS_OTLS", sourceRecordId: null,
    sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326", retrievedAt,
    matchMethod: "MANUAL_REVIEW_REQUIRED", confidence: 0, warnings,
  };
}

function unmappable(warnings: WarningEntry[], retrievedAt: string): GeocodeResult {
  return {
    canonicalIdentifier: null, centroidLatitude: null, centroidLongitude: null,
    geometry: null, geometryType: null, sourceProvider: "TEXAS_OTLS", sourceRecordId: null,
    sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326", retrievedAt,
    matchMethod: "UNMAPPABLE", confidence: 0, warnings,
  };
}
