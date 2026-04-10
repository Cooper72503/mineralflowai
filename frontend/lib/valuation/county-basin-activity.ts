/**
 * County + state → known basin → directional activity level.
 *
 * Used as a reliable fallback when a document carries no development signals
 * (e.g. a bare mineral property summary with only county, state, and acreage).
 *
 * Coverage is intentionally focused on the highest-volume US mineral plays.
 * "high"     = active modern unconventional / conventional play (wells being drilled now)
 * "moderate" = established but lower-intensity or edge-of-play
 * "low"      = legacy or declining basin with limited current drilling
 *
 * Keys: state abbreviation (uppercase) → Set of lowercase county names (no "county" suffix).
 */

export type BasinActivityTier = "high" | "moderate" | "low";

type CountyMap = Record<string, BasinActivityTier>;
type StateMap = Record<string, CountyMap>;

const BASIN_MAP: StateMap = {
  // ── North Dakota — Williston Basin (Bakken / Three Forks) ──────────────────
  ND: {
    stark: "high",
    mckenzie: "high",
    williams: "high",
    mountrail: "high",
    dunn: "high",
    billings: "high",
    "golden valley": "high",
    mercer: "moderate",
    oliver: "moderate",
    bowman: "moderate",
    hettinger: "moderate",
    slope: "moderate",
    adams: "moderate",
    grant: "low",
    morton: "moderate",
    burleigh: "low",
    divide: "moderate",
    burke: "moderate",
  },

  // ── Montana — Williston Basin / Powder River ───────────────────────────────
  MT: {
    richland: "high",
    roosevelt: "high",
    mccone: "moderate",
    dawson: "moderate",
    prairie: "moderate",
    wibaux: "moderate",
    sheridan: "moderate",
    daniels: "low",
    valley: "low",
    // Powder River / Bakken fringe
    fallon: "moderate",
    carter: "moderate",
  },

  // ── Texas — Permian Basin ──────────────────────────────────────────────────
  TX: {
    midland: "high",
    ector: "high",
    martin: "high",
    andrews: "high",
    howard: "high",
    glasscock: "high",
    upton: "high",
    reagan: "high",
    loving: "high",
    ward: "high",
    winkler: "high",
    reeves: "high",
    pecos: "high",
    culberson: "high",
    crane: "high",
    dawson: "high",
    borden: "moderate",
    scurry: "moderate",
    mitchell: "moderate",
    nolan: "low",
    // Eagle Ford
    webb: "high",
    dimmit: "high",
    "la salle": "high",
    frio: "high",
    mcmullen: "high",
    dewitt: "high",
    karnes: "high",
    gonzales: "high",
    wilson: "high",
    atascosa: "high",
    "live oak": "high",
    "jim wells": "moderate",
    duval: "moderate",
    zavala: "moderate",
    maverick: "moderate",
    // Haynesville / East Texas
    panola: "high",
    rusk: "high",
    harrison: "high",
    marion: "moderate",
    shelby: "moderate",
    nacogdoches: "moderate",
    // Barnett
    tarrant: "moderate",
    johnson: "moderate",
    hood: "moderate",
    somervell: "low",
    // Anadarko fringe
    wheeler: "moderate",
    hemphill: "moderate",
  },

  // ── New Mexico — Permian (Delaware / Midland) ──────────────────────────────
  NM: {
    lea: "high",
    eddy: "high",
    chaves: "moderate",
    "de baca": "low",
  },

  // ── Colorado — DJ Basin / Niobrara ─────────────────────────────────────────
  CO: {
    weld: "high",
    morgan: "high",
    logan: "moderate",
    washington: "moderate",
    adams: "moderate",
    boulder: "low",
    larimer: "low",
    // Piceance Basin
    garfield: "moderate",
    mesa: "moderate",
    "rio blanco": "moderate",
  },

  // ── Wyoming — Powder River / Green River / Wind River ─────────────────────
  WY: {
    campbell: "high",
    converse: "high",
    natrona: "moderate",
    sublette: "high",
    sweetwater: "moderate",
    fremont: "moderate",
    sheridan: "moderate",
    johnson: "moderate",
    crook: "moderate",
    niobrara: "moderate",
    // Pinedale / Green River
    lincoln: "moderate",
  },

  // ── Oklahoma — SCOOP / STACK / Anadarko ───────────────────────────────────
  OK: {
    grady: "high",
    garvin: "high",
    stephens: "high",
    carter: "high",
    mcclain: "high",
    canadian: "high",
    blaine: "high",
    dewey: "moderate",
    kingfisher: "moderate",
    major: "moderate",
    woodward: "moderate",
    garfield: "moderate",
    logan: "moderate",
    cleveland: "moderate",
    caddo: "moderate",
    washita: "moderate",
    custer: "moderate",
    // Arkoma
    leflore: "moderate",
    haskell: "moderate",
    latimer: "moderate",
  },

  // ── West Virginia — Marcellus / Utica ─────────────────────────────────────
  WV: {
    marshall: "high",
    wetzel: "high",
    tyler: "high",
    pleasants: "high",
    ritchie: "moderate",
    wood: "moderate",
    doddridge: "high",
    harrison: "high",
    marion: "high",
    monongalia: "high",
    lewis: "moderate",
    upshur: "moderate",
    barbour: "moderate",
  },

  // ── Pennsylvania — Marcellus ───────────────────────────────────────────────
  PA: {
    bradford: "high",
    susquehanna: "high",
    wyoming: "high",
    tioga: "high",
    lycoming: "moderate",
    clinton: "moderate",
    sullivan: "moderate",
    washington: "moderate",
    greene: "moderate",
    fayette: "low",
  },

  // ── Ohio — Utica / Marcellus ───────────────────────────────────────────────
  OH: {
    carroll: "high",
    jefferson: "high",
    harrison: "high",
    tuscarawas: "moderate",
    guernsey: "moderate",
    noble: "moderate",
    morgan: "moderate",
    muskingum: "moderate",
    holmes: "moderate",
    wayne: "low",
    ashland: "low",
  },

  // ── Louisiana — Haynesville ────────────────────────────────────────────────
  LA: {
    caddo: "high",
    "de soto": "high",
    sabine: "high",
    "red river": "high",
    bossier: "high",
    natchitoches: "moderate",
    claiborne: "moderate",
    webster: "moderate",
  },

  // ── Arkansas — Fayetteville Shale ─────────────────────────────────────────
  AR: {
    "van buren": "moderate",
    cleburne: "moderate",
    white: "moderate",
    conway: "moderate",
    faulkner: "moderate",
    searcy: "low",
  },

  // ── Kansas — Hugoton / Anadarko ────────────────────────────────────────────
  KS: {
    seward: "moderate",
    meade: "moderate",
    grant: "moderate",
    stevens: "moderate",
    morton: "moderate",
    clark: "low",
    liberal: "low",
  },
};

/**
 * State name → abbreviation lookup for normalizing full state names.
 */
const STATE_NAME_TO_ABBR: Record<string, string> = {
  "north dakota": "ND",
  "south dakota": "SD",
  montana: "MT",
  wyoming: "WY",
  colorado: "CO",
  "new mexico": "NM",
  texas: "TX",
  oklahoma: "OK",
  kansas: "KS",
  nebraska: "NE",
  "west virginia": "WV",
  ohio: "OH",
  pennsylvania: "PA",
  louisiana: "LA",
  arkansas: "AR",
  "north carolina": "NC",
  "south carolina": "SC",
  california: "CA",
  utah: "UT",
};

function normalizeStateToAbbr(state: string | null | undefined): string | null {
  if (!state?.trim()) return null;
  const t = state.trim();
  if (t.length === 2) return t.toUpperCase();
  return STATE_NAME_TO_ABBR[t.toLowerCase()] ?? null;
}

function normalizeCountyKey(county: string | null | undefined): string | null {
  if (!county?.trim()) return null;
  return county
    .trim()
    .toLowerCase()
    .replace(/\s+county\s*$/i, "")
    .trim();
}

/**
 * Returns the known activity tier for a county+state pair, or null if not in the map.
 * Both county and state accept full names or abbreviations.
 */
export function lookupCountyBasinActivity(
  county: string | null | undefined,
  state: string | null | undefined
): BasinActivityTier | null {
  const stateAbbr = normalizeStateToAbbr(state);
  if (!stateAbbr) return null;
  const countyKey = normalizeCountyKey(county);
  if (!countyKey) return null;
  return BASIN_MAP[stateAbbr]?.[countyKey] ?? null;
}
