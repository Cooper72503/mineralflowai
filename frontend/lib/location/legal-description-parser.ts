/**
 * Texas / mineral-deed style, PLSS (Public Land Survey System), and Ohio-specific legal
 * description parsing — best-effort, regex-based. Never throws.
 *
 * Ohio uses three survey systems:
 *  - PLSS (northwest Ohio): standard township/range, ranges run East
 *  - Virginia Military Survey (VMS): southeast/east Ohio, lot + survey number
 *  - US Military Survey (USMS) / Congressional Lands: east Ohio, township/range East without N/S
 */

export type LegalDescriptionParseResult = {
  abstract_number: string | null;
  survey_name: string | null;
  block: string | null;
  section: string | null;
  /** PLSS township, e.g. "140 North" or Ohio congressional "4" (no direction). */
  plss_township: string | null;
  /** PLSS range, e.g. "94 West" or Ohio East "9 East". */
  plss_range: string | null;
  /** Quarter-section or similar aliquot when present, e.g. "SE 1/4". */
  plss_aliquot: string | null;
  /** Virginia Military Survey or US Military Survey number (Ohio-specific). */
  vms_survey_number: string | null;
  /** Lot number — common in Ohio VMS/USMS and some other states. */
  lot_number: string | null;
};

const EMPTY: LegalDescriptionParseResult = {
  abstract_number: null,
  survey_name: null,
  block: null,
  section: null,
  plss_township: null,
  plss_range: null,
  plss_aliquot: null,
  vms_survey_number: null,
  lot_number: null,
};

function normalizeWhitespace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** Best-effort PLSS: township, range, section number, optional aliquot (e.g. SE 1/4). */
export function parsePlssLegalDescription(raw: string | null | undefined): Pick<
  LegalDescriptionParseResult,
  "plss_township" | "plss_range" | "section" | "plss_aliquot"
> {
  const s = normalizeWhitespace(raw);
  const out = {
    plss_township: null as string | null,
    plss_range: null as string | null,
    section: null as string | null,
    plss_aliquot: null as string | null,
  };
  if (!s) return out;

  // Standard PLSS township with direction (North/South)
  const twn =
    s.match(/\bTownship\s+(\d+)\s*(North|South)\b/i) ??
    s.match(/\bT\.?\s*(\d+)\s*(N|S|North|South)\b/i);
  if (twn) {
    const rawH = twn[2];
    const hem =
      /^n/i.test(rawH) || rawH.toUpperCase() === "N"
        ? "North"
        : /^s/i.test(rawH) || rawH.toUpperCase() === "S"
          ? "South"
          : rawH.replace(/\s+/g, " ").trim();
    out.plss_township = `${twn[1]} ${hem}`;
  } else {
    // Ohio Congressional / USMS: "Township 4" with no direction
    const ohnTwn = s.match(/\bTownship\s+(\d+)\b(?!\s*(?:North|South|N\b|S\b))/i);
    if (ohnTwn) out.plss_township = ohnTwn[1];
  }

  const rng =
    s.match(/\bRange\s+(\d+)\s*(East|West)\b/i) ?? s.match(/\bR\.?\s*(\d+)\s*(E|W|East|West)\b/i);
  if (rng) {
    const rawH = rng[2];
    const hem =
      /^e/i.test(rawH) || rawH.toUpperCase() === "E"
        ? "East"
        : /^w/i.test(rawH) || rawH.toUpperCase() === "W"
          ? "West"
          : rawH.replace(/\s+/g, " ").trim();
    out.plss_range = `${rng[1]} ${hem}`;
  } else if (!out.plss_range) {
    // Ohio Congressional range without direction: "Range 9"
    const ohRng = s.match(/\bRange\s+(\d+)\b(?!\s*(?:East|West|E\b|W\b))/i);
    if (ohRng) out.plss_range = ohRng[1];
  }

  const secM = s.match(/\bSection\s+(\d+[A-Za-z]?)\b/i);
  if (secM) out.section = secM[1].trim();

  const aliM =
    s.match(/\b((?:NE|NW|SE|SW)\s*\/\s*4)\b/i) ??
    s.match(/\b((?:NE|NW|SE|SW)\s+1\s*\/\s*4)\b/i) ??
    s.match(/\b((?:NE|NW|SE|SW)(?:\s+Quarter)?)\s+Quarter\b/i) ??
    s.match(/\b([NSEW])\s+(?:1\s*\/\s*2|Half)\b/i);
  if (aliM) {
    // Normalize "NE Quarter" → "NE/4" for downstream acreage inference
    const raw = aliM[1].replace(/\s+/g, " ").trim();
    const quarterWord = /^(NE|NW|SE|SW)\s+Quarter$/i.exec(raw);
    out.plss_aliquot = quarterWord ? `${quarterWord[1].toUpperCase()}/4` : raw;
  }

  return out;
}

/**
 * Ohio-specific survey systems:
 * - Virginia Military Survey (VMS): "Virginia Military Survey No. 4873"
 * - US Military Survey (USMS): "U.S. Military Survey No. 12" / "USMS 14"
 * - Lot numbers common in both: "Lot 47"
 */
function parseOhioSurvey(raw: string | null | undefined): Pick<
  LegalDescriptionParseResult,
  "vms_survey_number" | "lot_number"
> {
  const s = normalizeWhitespace(raw);
  const out = { vms_survey_number: null as string | null, lot_number: null as string | null };
  if (!s) return out;

  // Virginia Military Survey
  const vmsM =
    s.match(/\bVirginia\s+Military\s+Survey\s+(?:No\.?\s*)?(\d+)\b/i) ??
    s.match(/\bV\.?M\.?S\.?\s+(?:No\.?\s*)?(\d+)\b/i);
  if (vmsM) out.vms_survey_number = vmsM[1];

  // US Military Survey / Congressional Lands
  if (!out.vms_survey_number) {
    const usmsM =
      s.match(/\bU\.?S\.?\s+Military\s+Survey\s+(?:No\.?\s*)?(\d+)\b/i) ??
      s.match(/\bU\.?S\.?M\.?S\.?\s+(?:No\.?\s*)?(\d+)\b/i) ??
      s.match(/\bCongress(?:ional)?\s+(?:Lands?\s+)?(?:No\.?\s*)?Survey\s+(\d+)\b/i);
    if (usmsM) out.vms_survey_number = usmsM[1];
  }

  // Lot number (Ohio VMS, USMS, and some other states)
  const lotM = s.match(/\bLot\s+(?:No\.?\s*)?(\d+[A-Za-z]?)\b/i);
  if (lotM) out.lot_number = lotM[1];

  return out;
}

function parseTexasStyleLegalDescription(raw: string | null | undefined): Omit<
  LegalDescriptionParseResult,
  "plss_township" | "plss_range" | "plss_aliquot" | "vms_survey_number" | "lot_number"
> {
  const s = normalizeWhitespace(raw);
  const empty = { abstract_number: null, survey_name: null, block: null, section: null as string | null };
  if (!s) return empty;

  let section: string | null = null;
  const secM =
    s.match(/\bSection\s+(\d+[A-Za-z]?(?:\s*\/\s*\d+)?)\b/i) ??
    s.match(/\bSec\.?\s+(\d+[A-Za-z]?(?:\s*\/\s*\d+)?)\b/i);
  if (secM) section = secM[1].trim();

  let block: string | null = null;
  const blockM =
    s.match(/\bBlock\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/i) ??
    s.match(/\bBlock\s+(\d+[A-Za-z]?)\b/i);
  if (blockM) block = blockM[1].trim();

  let survey_name: string | null = null;
  const surveyM = s.match(
    /\b((?:[A-Z][A-Za-z0-9&'.\s-]{1,64}?)(?:Survey|Srvy|Surv)\.?)\b/i
  );
  if (surveyM) {
    survey_name = surveyM[1].replace(/\s+/g, " ").trim();
  }

  let abstract_number: string | null = null;
  const absM =
    s.match(/\bAbstract\s+(?:No\.?\s*)?([A-Z]?\d+[A-Za-z]?)\b/i) ??
    s.match(/\bA(?:bstract)?[- ](\d+[A-Za-z]?)\b/i);
  if (absM) abstract_number = absM[1].trim();

  return { abstract_number, survey_name, block, section };
}

/**
 * Extract abstract number, survey name, block, section, PLSS fields, and Ohio-specific
 * survey system fields (VMS, USMS, lot number) when present.
 */
export function parseLegalDescription(raw: string | null | undefined): LegalDescriptionParseResult {
  const s = normalizeWhitespace(raw);
  if (!s) return { ...EMPTY };

  const plss = parsePlssLegalDescription(s);
  const tx = parseTexasStyleLegalDescription(s);
  const ohio = parseOhioSurvey(s);

  const hasPlssAnchor = Boolean(plss.plss_township && plss.plss_range);

  let section = tx.section;
  if (hasPlssAnchor && plss.section) section = plss.section;
  else if (!section && plss.section) section = plss.section;

  return {
    abstract_number: tx.abstract_number,
    survey_name: tx.survey_name,
    block: tx.block,
    section,
    plss_township: plss.plss_township,
    plss_range: plss.plss_range,
    plss_aliquot: plss.plss_aliquot,
    vms_survey_number: ohio.vms_survey_number,
    lot_number: ohio.lot_number,
  };
}

function isNonEmptyLegalField(v: string | null | undefined): boolean {
  return v != null && String(v).trim().length > 0;
}

/**
 * Merge multiple {@link parseLegalDescription} results. Earlier entries win per field
 * (useful when full OCR text is parsed first and structured legal fills gaps).
 */
export function mergeLegalDescriptionParseResults(
  ...parts: LegalDescriptionParseResult[]
): LegalDescriptionParseResult {
  const keys: (keyof LegalDescriptionParseResult)[] = [
    "abstract_number",
    "survey_name",
    "block",
    "section",
    "plss_township",
    "plss_range",
    "plss_aliquot",
    "vms_survey_number",
    "lot_number",
  ];
  const out: LegalDescriptionParseResult = { ...EMPTY };
  for (const p of parts) {
    if (!p) continue;
    for (const k of keys) {
      if (!isNonEmptyLegalField(out[k]) && isNonEmptyLegalField(p[k])) {
        out[k] = p[k];
      }
    }
  }
  return out;
}

/**
 * Maps common 2-letter postal abbreviations to full state names.
 * Covers all oil-and-gas producing states plus the full US list.
 */
const STATE_ABBREV_MAP: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/**
 * Convert ALL-CAPS words to Title Case for pattern matching purposes.
 * Does not modify mixed-case or lowercase words. Used to normalize scanned/OCR text.
 */
function softTitleCase(text: string): string {
  return text.replace(/\b([A-Z]{2,})\b/g, (m) => m.charAt(0) + m.slice(1).toLowerCase());
}

const US_STATE_NAMES: readonly string[] = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
];

/** When structured state is missing, infer US state from common phrases (full names + 2-letter abbreviations). */
export function inferUSStateFromText(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const t = String(raw);
  // Full state names first (most reliable)
  for (let i = 0; i < US_STATE_NAMES.length; i++) {
    const name = US_STATE_NAMES[i];
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}\\b`, "i").test(t)) return name;
  }
  // 2-letter abbreviations (word-boundary anchored to avoid false positives like "IN" inside words)
  // Try all-caps first, then soft-title-case version
  for (const [abbr, name] of Object.entries(STATE_ABBREV_MAP)) {
    if (new RegExp(`\\b${abbr}\\b`).test(t)) return name;
  }
  // Handle all-caps document text: normalize then retry full names
  const normalized = softTitleCase(t);
  if (normalized !== t) {
    for (let i = 0; i < US_STATE_NAMES.length; i++) {
      const name = US_STATE_NAMES[i];
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${esc}\\b`, "i").test(normalized)) return name;
    }
  }
  return null;
}

/** @deprecated Prefer {@link inferUSStateFromText} — kept for call sites that only mention Texas. */
export function inferTexasStateFromText(raw: string | null | undefined): string | null {
  return inferUSStateFromText(raw);
}

function resolveStateFromCapture(raw: string, fallbackText: string): string | null {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return inferUSStateFromText(fallbackText);
  // 2-letter abbreviation
  if (/^[A-Z]{2}$/.test(trimmed)) {
    return STATE_ABBREV_MAP[trimmed] ?? inferUSStateFromText(fallbackText);
  }
  // All-caps full state name → normalize then look up
  const normalized = softTitleCase(trimmed);
  return inferUSStateFromText(normalized) ?? inferUSStateFromText(trimmed) ?? inferUSStateFromText(fallbackText);
}

function tryCountyStateMatch(
  text: string,
  fallbackText: string
): { county: string; state: string | null } | null {
  const JUNK = /^(the|a|an|being|all|part|of|in|at|to)$/i;

  // Pattern 1: "X County, State" or "X County State" (comma optional, handles newlines)
  const p1 = text.match(
    /\b([A-Za-z][A-Za-z\s'.-]{0,48}?)\s+County[,\s][\s\n]*([A-Za-z][A-Za-z\s.]{2,32}?)(?=\s*[\n,.]|$)/i
  );
  if (p1?.[1] && p1[2]) {
    let base = p1[1].replace(/\s+/g, " ").trim().replace(/\s+County$/i, "");
    if (base.length >= 2 && !JUNK.test(base)) {
      const state = resolveStateFromCapture(p1[2].trim(), fallbackText);
      return { county: `${base} County`, state };
    }
  }

  // Pattern 2: "County: X County, State" or "County: X, State"
  const p2 = text.match(
    /County:\s*([A-Za-z][A-Za-z\s'.-]{0,56}?)\s*[,\n]\s*([A-Za-z][A-Za-z\s.]{2,32}?)(?=\s*[\n,.]|$)/i
  );
  if (p2?.[1] && p2[2]) {
    let chunk = p2[1].replace(/\s+/g, " ").trim().replace(/\s+County$/i, "");
    if (chunk.length >= 2 && !JUNK.test(chunk)) {
      const countyLabel = /\bCounty\b/i.test(p2[1]) ? p2[1].replace(/\s+/g, " ").trim() : `${chunk} County`;
      const state = resolveStateFromCapture(p2[2].trim(), fallbackText);
      return { county: countyLabel, state };
    }
  }

  // Pattern 3: contextual ("situated in X County", "located in X County")
  const p3 = text.match(
    /\b(?:in|within|situated\s+in|located\s+in)\s+(?:the\s+)?([A-Za-z][A-Za-z\s'.-]{1,48}?)\s+County\b/i
  );
  if (p3?.[1]) {
    let c = p3[1].replace(/\s+/g, " ").trim();
    if (c.length >= 2 && !JUNK.test(c)) {
      const state = inferUSStateFromText(fallbackText);
      return { county: `${c} County`, state };
    }
  }

  // Pattern 4: "County of X"
  const p4 = text.match(
    /\bCounty\s+of\s+([A-Za-z][A-Za-z\s'.-]{1,48}?)\b/i
  );
  if (p4?.[1]) {
    let c = p4[1].replace(/\s+/g, " ").trim().replace(/[,.].*$/, "").trim();
    if (c.length >= 2 && !JUNK.test(c)) {
      const state = inferUSStateFromText(fallbackText);
      return { county: `${c} County`, state };
    }
  }

  return null;
}

/** Infer "X County, State" (multi-state) and legacy Texas-oriented patterns. Handles all-caps, abbreviations, and newlines. */
export function inferCountyAndStateFromTexts(
  ...sources: (string | null | undefined)[]
): { county: string | null; state: string | null } {
  const combined = sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n\n");
  if (!combined.trim()) return { county: null, state: null };

  // First pass: try on original text
  const result = tryCountyStateMatch(combined, combined);
  if (result) return result;

  // Second pass: normalize all-caps words (scanned PDFs often produce all-caps text)
  const normalized = softTitleCase(combined);
  if (normalized !== combined) {
    const result2 = tryCountyStateMatch(normalized, combined);
    if (result2) return result2;
  }

  return { county: null, state: null };
}

/**
 * Infer county name from legal language or raw extracted text (Texas-oriented + "County, State" patterns).
 */
export function inferCountyFromTexts(...sources: (string | null | undefined)[]): string | null {
  const { county } = inferCountyAndStateFromTexts(...sources);
  return county;
}

/**
 * Extract first acreage figure from phrases like "24 acres", "160 NMA", "12.5 net mineral acres", etc.
 */
export function extractAcreageFromTexts(...sources: (string | null | undefined)[]): number | null {
  const combined = sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n\n");
  if (!combined.trim()) return null;

  const patterns: RegExp[] = [
    // Labeled: "Acreage: 160" or "Acreage: 160 acres"
    /\bAcreage:\s*(\d+(?:\.\d+)?)\s*(?:acres?\b)?/i,
    // "160 NMA" or "160.5 NMAs" (net mineral acres abbreviation)
    /\b(\d+(?:\.\d+)?)\s*NMAs?\b/i,
    // "160 net mineral acres" or "160 net acres"
    /\b(\d+(?:\.\d+)?)\s+net(?:\s+mineral)?\s+acres?\b/i,
    // "160 gross acres" / "160 acres" / "160 acre"
    /\b(\d+(?:\.\d+)?)\s+(?:gross\s+)?acres?\b/i,
    // "containing 160 acres, more or less"
    /\bcontaining\s+(\d+(?:\.\d+)?)\s+acres?\b/i,
  ];

  for (const re of patterns) {
    const m = combined.match(re);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * When `legal_description` is empty, pull the block after a "Legal Description:" label from full OCR/PDF text.
 */
export function extractLegalDescriptionBlockFromText(raw: string | null | undefined): string | null {
  const s = normalizeWhitespace(raw);
  if (!s) return null;
  const m = s.match(
    /\bLegal\s+Description\s*:\s*([\s\S]{20,12000}?)(?=\n\s*(?:County|State|Acreage|Recording|Effective|Witness|Notary|Mineral|PAGE)\b|$)/i
  );
  if (m?.[1]) {
    const block = normalizeWhitespace(m[1]);
    return block.length >= 12 ? block : null;
  }
  return null;
}
