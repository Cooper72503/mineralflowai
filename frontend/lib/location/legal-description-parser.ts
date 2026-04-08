/**
 * Texas / mineral-deed style legal description parsing — best-effort, regex-based.
 * Never throws.
 */

export type LegalDescriptionParseResult = {
  abstract_number: string | null;
  survey_name: string | null;
  block: string | null;
  section: string | null;
};

const EMPTY: LegalDescriptionParseResult = {
  abstract_number: null,
  survey_name: null,
  block: null,
  section: null,
};

/**
 * Extract abstract number, survey name, block, and section when present.
 */
export function parseLegalDescription(raw: string | null | undefined): LegalDescriptionParseResult {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { ...EMPTY };

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
 * Infer county name from legal language or raw extracted text (Texas-oriented patterns).
 */
export function inferCountyFromTexts(...sources: (string | null | undefined)[]): string | null {
  const combined = sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n\n");
  if (!combined.trim()) return null;

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
      if (c.length >= 2 && !/^(the|a|an|being|all|part)$/i.test(c)) return c;
    }
  }
  return null;
}

/** When structured state is missing, set state to Texas if the text indicates Texas. */
export function inferTexasStateFromText(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const t = String(raw);
  if (/\bTexas\b/i.test(t)) return "Texas";
  if (/\bTX\b/.test(t)) return "Texas";
  return null;
}
