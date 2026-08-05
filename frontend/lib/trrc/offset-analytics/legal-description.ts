/**
 * Legal description parsing — best-effort, deterministic regex extraction,
 * never AI. Produces one of TexasLegalDescription, PlssLegalDescription, or
 * UnparsedLegalDescription (types.ts) — the caller (geocoding.ts) decides
 * what to do with a low-confidence or unparsed result; this module never
 * silently drops information, only classifies what it found and what it
 * couldn't.
 *
 * Regex patterns adapted from a legitimate prior implementation found in
 * archive/frontend/lib/location/legal-description-parser.ts during the
 * Phase 0 audit — that parser is real, deterministic pattern-matching
 * (abstract/survey/block/section extraction, PLSS township/range/section),
 * not fabrication, so its patterns are reused as a starting point. This
 * file adds what that version didn't have: canonical abstract-number
 * normalization, a genuine nested aliquot tree (not just a single flat
 * quarter-call), and TypeScript types matching this engine's schema.
 */

import type { AliquotDescription, AliquotHalf, AliquotNode, AliquotQuarter, LegalDescription, PlssLegalDescription, TexasLegalDescription, UnparsedLegalDescription } from "./types";

function normalizeWhitespace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

// ─── Abstract number normalization ──────────────────────────────────────────
//
// "A-123", "A123", "Abstract 123", "Abstract No. 123" all mean the same
// tract identifier. Canonical form is "A-<digits><optional letter suffix>".

export function normalizeAbstractNumber(raw: string | null | undefined): string | null {
  const s = normalizeWhitespace(raw);
  if (!s) return null;
  const m =
    s.match(/\bAbstract\s+(?:No\.?\s*)?A?[- ]?(\d+[A-Za-z]?)\b/i) ??
    s.match(/\bA(?:bstract)?[- ]?(\d+[A-Za-z]?)\b/i);
  if (!m) return null;
  return `A-${m[1].toUpperCase()}`;
}

// ─── Texas land grid parsing ────────────────────────────────────────────────

const SECTION_PATTERN = /\bSec(?:tion)?\.?\s+(\d+[A-Za-z]?(?:\s*\/\s*\d+)?)\b/i;
const BLOCK_PATTERN = /\bBlock\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/i;
const SURVEY_PATTERN = /\b((?:[A-Z][A-Za-z0-9&'.\s-]{1,64}?)(?:Survey|Srvy|Surv)\.?)\b/i;
const COUNTY_PATTERN = /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+County\b/i;
const GRANTEE_PATTERN = /\b(?:Original\s+Grantee|Grantee)\s*:?\s*([A-Z][A-Za-z0-9&'.\s-]{1,64})\b/i;
const TRACT_PATTERN = /\bTract\s+(?:No\.?\s*)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/i;
const ACREAGE_PATTERN = /\b(\d+(?:\.\d+)?)\s*(?:gross\s+)?acres\b/i;

/**
 * Attempts Texas land-grid extraction. Returns null (not a low-confidence
 * object) when neither an abstract number nor a survey name was found —
 * those two are the identifying anchors for this jurisdiction; without at
 * least one, this isn't a Texas land-grid description at all, and the
 * caller should try PLSS or fall back to unparsed rather than emit a
 * hollow, mostly-null TexasLegalDescription.
 */
export function parseTexasLegalDescription(
  rawText: string,
  opts: { sourceDocumentId?: string | null; sourcePage?: number | null } = {},
): TexasLegalDescription | null {
  const s = normalizeWhitespace(rawText);
  if (!s) return null;

  const abstractMatch = s.match(/\bAbstract\s+(?:No\.?\s*)?A?[- ]?\d+[A-Za-z]?\b|\bA[- ]?\d{2,5}[A-Za-z]?\b/i);
  const abstractNumber = abstractMatch ? abstractMatch[0].trim() : null;
  const canonicalAbstractNumber = normalizeAbstractNumber(abstractNumber);

  const surveyMatch = s.match(SURVEY_PATTERN);
  const surveyName = surveyMatch ? surveyMatch[1].replace(/\s+/g, " ").trim() : null;

  if (!canonicalAbstractNumber && !surveyName) return null;

  const countyMatch = s.match(COUNTY_PATTERN);
  const blockMatch = s.match(BLOCK_PATTERN);
  const sectionMatch = s.match(SECTION_PATTERN);
  const granteeMatch = s.match(GRANTEE_PATTERN);
  const tractMatch = s.match(TRACT_PATTERN);
  const acreageMatch = s.match(ACREAGE_PATTERN);

  // Confidence reflects how many identifying fields were actually found,
  // not a guess — abstract+survey+county is a strong match, abstract alone
  // with no county is weak (can't disambiguate which county's abstract
  // numbering scheme applies, since abstract numbers repeat across counties).
  let confidence = 0.3;
  if (canonicalAbstractNumber) confidence += 0.25;
  if (surveyName) confidence += 0.15;
  if (countyMatch) confidence += 0.2;
  if (blockMatch || sectionMatch) confidence += 0.1;
  confidence = Math.min(0.95, confidence); // regex extraction never earns full 1.0 — reserved for human-verified

  return {
    jurisdiction: "TX_LAND_GRID",
    county: countyMatch ? countyMatch[1].trim() : "",
    abstractNumber,
    canonicalAbstractNumber,
    surveyName,
    originalGrantee: granteeMatch ? granteeMatch[1].replace(/\s+/g, " ").trim() : null,
    block: blockMatch ? blockMatch[1].trim() : null,
    section: sectionMatch ? sectionMatch[1].trim() : null,
    subdivision: null, // not reliably distinguishable from survey_name via regex alone — left null rather than guessed
    tractNumber: tractMatch ? tractMatch[1].trim() : null,
    grossAcres: acreageMatch ? parseFloat(acreageMatch[1]) : null,
    metesAndBounds: /metes\s+and\s+bounds/i.test(s) ? s : null,
    sourceDocumentId: opts.sourceDocumentId ?? null,
    sourcePage: opts.sourcePage ?? null,
    extractionConfidence: confidence,
    humanVerified: false,
  };
}

// ─── PLSS parsing ────────────────────────────────────────────────────────────

const TOWNSHIP_PATTERN = /\bT(?:ownship)?\.?\s*(\d+)\s*([NS])(?:orth|outh)?\b/i;
const RANGE_PATTERN = /\bR(?:ange)?\.?\s*(\d+)\s*([EW])(?:ast|est)?\b/i;
const PLSS_SECTION_PATTERN = /\bSection\s+(\d{1,2})\b/i;
const MERIDIAN_WITH_PRINCIPAL_PATTERN = /\b([A-Za-z0-9]+(?:\s+[A-Za-z]+){0,2})\s+Principal\s+Meridian\b/i;
const MERIDIAN_BARE_PATTERN = /\b([A-Za-z0-9]+(?:\s+[A-Za-z]+){0,2})\s+Meridian\b/i;
const GOVT_LOT_PATTERN = /\bLot\s+(\d+)\b/i;

const QUARTER_TOKENS: Record<string, AliquotQuarter> = { NE: "NE", NW: "NW", SE: "SE", SW: "SW" };
const HALF_TOKENS: Record<string, AliquotHalf> = { N: "N", S: "S", E: "E", W: "W" };

/**
 * Parses a nested aliquot call into an ordered outer-to-inner tree.
 * "NE/4" -> [quarter NE]. "S/2 NW/4" -> [half S, quarter NW] (the S/2 is
 * the outer, coarser subdivision; NW/4 further divides it — read
 * left-to-right in the source text, which is the PLSS convention: the
 * LAST call is the smallest/innermost subdivision). "SE/4 SE/4" -> two
 * quarter calls, a common "quarter-quarter" (40-acre) description.
 * "Lot 3" -> governmentLot:3, empty parts.
 */
export function parseAliquot(raw: string): AliquotDescription | null {
  const s = normalizeWhitespace(raw);
  if (!s) return null;

  const lotMatch = s.match(GOVT_LOT_PATTERN);
  const governmentLot = lotMatch ? parseInt(lotMatch[1], 10) : null;

  const parts: AliquotNode[] = [];
  // Match every quarter call (NE/4, NE 1/4, NE Quarter) and half call
  // (N/2, N Half) in source order — order matters, PLSS reads outer calls
  // first, so we preserve the order they appear left-to-right.
  const tokenPattern = /\b(NE|NW|SE|SW)\s*(?:\/\s*4|1\s*\/\s*4|Quarter)\b|\b([NSEW])\s*(?:\/\s*2|Half)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenPattern.exec(s)) !== null) {
    if (m[1]) {
      const q = QUARTER_TOKENS[m[1].toUpperCase()];
      if (q) parts.push({ kind: "quarter", value: q });
    } else if (m[2]) {
      const h = HALF_TOKENS[m[2].toUpperCase()];
      if (h) parts.push({ kind: "half", value: h });
    }
  }

  if (parts.length === 0 && governmentLot === null) return null;
  return { parts, governmentLot, raw: s };
}

/**
 * Requires township, range, AND section — PLSS's three defining
 * coordinates. Without all three this isn't a resolvable PLSS location
 * (a bare aliquot or meridian name alone can't be geocoded), so this
 * returns null rather than a description with holes a geocoder can't use.
 */
export function parsePlssLegalDescription(
  rawText: string,
  opts: { county?: string | null; sourceDocumentId?: string | null; sourcePage?: number | null } = {},
): PlssLegalDescription | null {
  const s = normalizeWhitespace(rawText);
  if (!s) return null;

  const twpMatch = s.match(TOWNSHIP_PATTERN);
  const rngMatch = s.match(RANGE_PATTERN);
  const secMatch = s.match(PLSS_SECTION_PATTERN);
  if (!twpMatch || !rngMatch || !secMatch) return null;

  const section = parseInt(secMatch[1], 10);
  if (section < 1 || section > 36) return null; // PLSS sections are always 1-36 — out of range means this matched something else

  const meridianMatch = s.match(MERIDIAN_WITH_PRINCIPAL_PATTERN) ?? s.match(MERIDIAN_BARE_PATTERN);
  const aliquot = parseAliquot(s);

  let confidence = 0.5; // twp+rng+section alone is a real, resolvable PLSS quarter-township at minimum
  if (aliquot) confidence += 0.25;
  if (meridianMatch) confidence += 0.1;
  confidence = Math.min(0.95, confidence);

  return {
    jurisdiction: "PLSS",
    state: "", // filled by the caller from context — not reliably extractable from the description text alone
    principalMeridian: meridianMatch ? meridianMatch[1].trim() : "",
    townshipNumber: parseInt(twpMatch[1], 10),
    townshipDirection: twpMatch[2].toUpperCase() as "N" | "S",
    rangeNumber: parseInt(rngMatch[1], 10),
    rangeDirection: rngMatch[2].toUpperCase() as "E" | "W",
    section,
    aliquot,
    county: opts.county ?? null,
    sourceDocumentId: opts.sourceDocumentId ?? null,
    sourcePage: opts.sourcePage ?? null,
    extractionConfidence: confidence,
    humanVerified: false,
  };
}

// ─── Top-level dispatcher ────────────────────────────────────────────────────

/**
 * Tries Texas land-grid first (this engine's primary use case is Texas
 * TRRC subject wells), then PLSS, then falls back to an explicit
 * UnparsedLegalDescription that retains the raw text and what was tried —
 * never silently returns nothing.
 */
export function parseLegalDescription(
  rawText: string,
  opts: { sourceDocumentId?: string | null; sourcePage?: number | null } = {},
): LegalDescription {
  const normalized = normalizeWhitespace(rawText);
  const warnings: string[] = [];

  const tx = parseTexasLegalDescription(rawText, opts);
  if (tx) return tx;
  warnings.push("No Texas land-grid abstract number or survey name found");

  const plss = parsePlssLegalDescription(rawText, opts);
  if (plss) return plss;
  warnings.push("No PLSS township/range/section found");

  const unresolvedComponents: string[] = [];
  if (!SECTION_PATTERN.test(normalized) && !PLSS_SECTION_PATTERN.test(normalized)) unresolvedComponents.push("section");
  if (!COUNTY_PATTERN.test(normalized)) unresolvedComponents.push("county");

  return {
    jurisdiction: "UNPARSED",
    rawText,
    normalizedText: normalized,
    parserWarnings: warnings,
    unresolvedComponents,
    parserConfidence: 0,
  };
}
