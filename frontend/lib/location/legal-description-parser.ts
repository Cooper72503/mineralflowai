/**
 * Texas / mineral-deed style and PLSS (Public Land Survey System) legal description parsing —
 * best-effort, regex-based. Never throws.
 */

export type LegalDescriptionParseResult = {
  abstract_number: string | null;
  survey_name: string | null;
  block: string | null;
  section: string | null;
  /** PLSS township, e.g. "140 North". */
  plss_township: string | null;
  /** PLSS range, e.g. "94 West". */
  plss_range: string | null;
  /** Quarter-section or similar aliquot when present, e.g. "SE 1/4". */
  plss_aliquot: string | null;
};

const EMPTY: LegalDescriptionParseResult = {
  abstract_number: null,
  survey_name: null,
  block: null,
  section: null,
  plss_township: null,
  plss_range: null,
  plss_aliquot: null,
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
  }

  const secM = s.match(/\bSection\s+(\d+[A-Za-z]?)\b/i);
  if (secM) out.section = secM[1].trim();

  const aliM =
    s.match(/\b((?:NE|NW|SE|SW)\s*\/\s*4)\b/i) ??
    s.match(/\b((?:NE|NW|SE|SW)\s+1\s*\/\s*4)\b/i) ??
    s.match(/\b([NSEW])\s+1\s*\/\s*2\b/i);
  if (aliM) out.plss_aliquot = aliM[1].replace(/\s+/g, " ").trim();

  return out;
}

function parseTexasStyleLegalDescription(raw: string | null | undefined): Omit<
  LegalDescriptionParseResult,
  "plss_township" | "plss_range" | "plss_aliquot"
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
 * Extract abstract number, survey name, block, section, and PLSS fields when present.
 */
export function parseLegalDescription(raw: string | null | undefined): LegalDescriptionParseResult {
  const s = normalizeWhitespace(raw);
  if (!s) return { ...EMPTY };

  const plss = parsePlssLegalDescription(s);
  const tx = parseTexasStyleLegalDescription(s);

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

/** When structured state is missing, infer US state from common phrases (Texas legacy + full state names). */
export function inferUSStateFromText(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const t = String(raw);
  if (/\bTexas\b/i.test(t)) return "Texas";
  if (/\bTX\b/.test(t)) return "Texas";
  for (let i = 0; i < US_STATE_NAMES.length; i++) {
    const name = US_STATE_NAMES[i];
    if (name === "Texas") continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${esc}\\b`, "i").test(t)) return name;
  }
  if (/\bND\b/.test(t)) return "North Dakota";
  if (/\bSD\b/.test(t)) return "South Dakota";
  return null;
}

/** @deprecated Prefer {@link inferUSStateFromText} — kept for call sites that only mention Texas. */
export function inferTexasStateFromText(raw: string | null | undefined): string | null {
  return inferUSStateFromText(raw);
}

/** Infer "X County, State" (multi-state) and legacy Texas-oriented patterns. */
export function inferCountyAndStateFromTexts(
  ...sources: (string | null | undefined)[]
): { county: string | null; state: string | null } {
  const combined = sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n\n");
  if (!combined.trim()) return { county: null, state: null };

  const countyStateRe =
    /\b([A-Za-z][A-Za-z\s'.-]{0,48}?)\s+County,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
  const mCs = combined.match(countyStateRe);
  if (mCs?.[1] && mCs[2]) {
    let countyBase = mCs[1].replace(/\s+/g, " ").trim();
    countyBase = countyBase.replace(/\s+County$/i, "");
    const state = mCs[2].replace(/\s+/g, " ").trim();
    if (countyBase.length >= 2 && !/^(the|a|an|being|all|part)$/i.test(countyBase)) {
      return { county: `${countyBase} County`, state };
    }
  }

  // "County: Stark County, North Dakota" / labeled heading lines
  const labeledCountyState =
    /County:\s*([A-Za-z][A-Za-z\s'.-]{0,56}?)\s*,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
  const mLabel = combined.match(labeledCountyState);
  if (mLabel?.[1] && mLabel[2]) {
    let chunk = mLabel[1].replace(/\s+/g, " ").trim();
    chunk = chunk.replace(/\s+County$/i, "");
    const state = mLabel[2].replace(/\s+/g, " ").trim();
    if (chunk.length >= 2 && !/^(the|a|an|being|all|part)$/i.test(chunk)) {
      const countyLabel = /\bCounty\b/i.test(mLabel[1]) ? mLabel[1].replace(/\s+/g, " ").trim() : `${chunk} County`;
      return { county: countyLabel, state };
    }
  }

  const patterns: RegExp[] = [
    /\b([A-Za-z][A-Za-z\s'.-]{1,48}?)\s+County,\s*(?:Texas|TX)\b/i,
    /\b(?:in|within|situated\s+in)\s+(?:the\s+)?([A-Za-z][A-Za-z\s'.-]{1,48}?)\s+County\b/i,
    /\bCounty\s+of\s+([A-Za-z][A-Za-z\s'.-]{1,48}?)(?:[,.]|\s+)(?:Texas|TX|State)/i,
    /\bCounty\s+of\s+([A-Za-z][A-Za-z\s'.-]{1,48}?)\b/i,
  ];

  for (const re of patterns) {
    const m = combined.match(re);
    if (m?.[1]) {
      let c = m[1].replace(/\s+/g, " ").trim();
      c = c.replace(/\s+County$/i, "");
      if (c.length >= 2 && !/^(the|a|an|being|all|part)$/i.test(c)) {
        const st = inferUSStateFromText(combined);
        return { county: `${c} County`, state: st };
      }
    }
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
 * Extract first acreage figure from phrases like "24 acres" / "12.5 acre".
 */
export function extractAcreageFromTexts(...sources: (string | null | undefined)[]): number | null {
  const combined = sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n\n");
  if (!combined.trim()) return null;
  const labeled = combined.match(/\bAcreage:\s*(\d+(?:\.\d+)?)\s*(?:acres?\b)?/i);
  if (labeled) {
    const n = Number(labeled[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const m = combined.match(/\b(\d+(?:\.\d+)?)\s+acres?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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
