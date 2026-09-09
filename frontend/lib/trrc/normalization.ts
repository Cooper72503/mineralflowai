/**
 * TRRC Public Records Due Diligence — Identifier normalization utilities.
 *
 * All functions are pure (no side effects, no I/O) and compile under strict mode.
 * Texas API numbers follow the format: state(2) + county(3) + well(5) = 10 digits.
 * The full 14-digit UWI appends sidetrack(2) + event(2), defaulting to "00" each.
 */

import { COUNTY_DISTRICTS } from "./county-districts";
import type { NormalizedApi, TrrcIdentifierType } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Texas API state code (not the Census FIPS state code) */
const TX_STATE_CODE = "42";

/**
 * TRRC district codes that are valid for EWA queries.
 * County office assignments are hints; retrieved lease districts take precedence.
 */
const VALID_DISTRICT_CODES = new Set([
  "01", "02", "03", "04", "05", "06", "08", "09", "10",
  "6E", "7B", "7C", "8A",
]);

// ─── API number normalization ──────────────────────────────────────────────────

/**
 * Normalize any Texas API number string into its canonical forms.
 *
 * Accepted input formats:
 *   - "42-151-01734"           (10-digit dashed, no sidetrack/event)
 *   - "4215101734"             (10-digit plain)
 *   - "42151017340000"         (14-digit full UWI, no hyphens)
 *   - "42-151-01734-00-00"     (14-digit dashed UWI)
 *   - "151-01734"              (8-digit, no state prefix)
 *   - "15101734"               (8-digit plain, no state prefix)
 *
 * Returns null when the input cannot be parsed as a valid Texas API number.
 * State code must be "42" (Texas).
 */
export function normalizeApiNumber(raw: string): NormalizedApi | null {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!/^[\d\s-]+$/.test(trimmed)) return null;
  if (trimmed.includes("-")) {
    const shape = trimmed.split("-").map(s => s.trim().length).join(",");
    if (!["3,5", "2,3,5", "2,3,5,2", "2,3,5,2,2"].includes(shape)) return null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (![8, 10, 12, 14].includes(digits.length)) return null;
  if (digits.length !== 8 && !digits.startsWith(TX_STATE_CODE)) return null;
  const full = digits.length === 8 ? `${TX_STATE_CODE}${digits}` : digits;
  const api10 = full.slice(0, 10);
  const state_code = api10.slice(0, 2);
  const county_code = api10.slice(2, 5);
  const well_code = api10.slice(5, 10);
  if (!COUNTY_DISTRICTS[county_code]) return null;
  const api14 = full.padEnd(14, "0");
  const formatted = `${state_code}-${county_code}-${well_code}-${api14.slice(10, 12)}-${api14.slice(12, 14)}`;

  return {
    raw: trimmed,
    api10,
    api14,
    formatted,
    state_code,
    county_code,
    well_code,
    is_texas: state_code === TX_STATE_CODE,
  };
}

// ─── Validity check ───────────────────────────────────────────────────────────

/**
 * Returns true if the raw string is parseable as a valid Texas API number.
 * Convenience wrapper around normalizeApiNumber.
 */
export function isValidTexasApiNumber(raw: string): boolean {
  return normalizeApiNumber(raw) !== null;
}

// ─── Input type detection ─────────────────────────────────────────────────────

/**
 * Detect the most likely TrrcIdentifierType for a raw user input string.
 *
 * Detection order (most-specific to least-specific):
 *   1. API number — digits + optional hyphens, starts with 42 or 8-digit county form
 *   2. Gas well ID — "G" prefix followed by digits, or "GW" + digits
 *   3. P5 number — 6–7 digit pure numeric string in plausible P5 range
 *   4. RRC lease number — 4–6 digit pure numeric (less specific than P5)
 *   5. Legal description — contains survey/abstract/section/block keywords
 *   6. Lease name — multi-word string not matching other patterns
 *   7. Operator name — alphabetic / company name fallback
 *   8. unknown — cannot classify
 */
export function detectInputType(raw: string): TrrcIdentifierType {
  if (!raw || typeof raw !== "string") return "unknown";

  const trimmed = raw.trim();
  if (trimmed.length === 0) return "unknown";

  // 1. API number: starts with "42" (with or without dashes) or is 8-digit county+well.
  // Real API numbers contain only digits/dashes/spaces — reject anything with a letter
  // (e.g. "G42123456") before stripping non-digits, otherwise a Gas Well ID prefix like
  // "G" gets silently stripped and the remaining digits get misparsed as a fabricated API.
  const isDigitsAndPunctuationOnly = /^[\d\s-]+$/.test(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  if (
    isDigitsAndPunctuationOnly &&
    (digits.startsWith("42") || digits.length === 8)
  ) {
    const parsed = normalizeApiNumber(trimmed);
    if (parsed) return "api_number";
  }

  // 2. Gas well ID: "G" or "GW" prefix followed by digits (TRRC gas well numbering)
  if (/^G[W]?\d{4,8}$/i.test(trimmed.replace(/[-\s]/g, ""))) {
    return "gas_well_id";
  }
  // Also match "G-NNNNN" dash-separated
  if (/^G-\d{4,7}$/i.test(trimmed)) {
    return "gas_well_id";
  }

  // 3. P5 number: 6–7 digit numeric string (TRRC P-5 operator numbers are in this range)
  if (/^\d{6,7}$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    // TRRC P-5 numbers typically range 100000–9999999
    if (num >= 100000 && num <= 9999999) return "p5_number";
  }

  // 4. RRC lease number: 4–6 digit numeric (shorter than P5)
  if (/^\d{4,6}$/.test(trimmed)) {
    return "rrc_lease_number";
  }

  // 5. Legal description: contains survey/abstract/section/block keywords
  const legalKeywords = /\b(survey|abstract|abst|abs|section|sec|blk|block|tract|twp|township|range|rng|labor|league|lot)\b/i;
  if (legalKeywords.test(trimmed)) {
    return "legal_description";
  }

  // 6. Lease name: multi-word string with at least one alpha character,
  //    no company suffix markers, and no digits (or minimal digits)
  const alphaPct = (trimmed.match(/[a-zA-Z]/g) ?? []).length / trimmed.length;
  const hasCompanySuffix = /\b(llc|inc|corp|ltd|lp|co\.?|company|oil|gas|energy|resources|petroleum|production|operating|operations)\b/i.test(trimmed);

  if (!hasCompanySuffix && alphaPct > 0.5 && trimmed.split(/\s+/).length >= 2 && !/\d/.test(trimmed)) {
    // Contains words but no company identifiers — likely a lease name
    if (trimmed.split(/\s+/).length <= 5) return "lease_name";
  }

  // 7. Operator name: alphabetic string with company-style words
  if (hasCompanySuffix && alphaPct > 0.4) {
    return "operator_name";
  }

  // 8. Pure alpha or short alpha string — likely operator or lease name
  if (/^[a-zA-Z\s&',.()-]+$/.test(trimmed) && trimmed.length >= 3) {
    return "operator_name";
  }

  return "unknown";
}

// ─── Lease number normalization ───────────────────────────────────────────────

/**
 * Normalize a raw TRRC lease number string.
 * Strips leading zeros, removes non-digit characters, and returns a clean string.
 * Lease numbers in TRRC are up to 6 digits; the padded form used in URLs is 6 digits.
 *
 * Returns the stripped numeric string (no leading zeros) suitable for display.
 * Returns the raw trimmed value if it contains non-numeric characters.
 */
export function normalizeLeaseNumber(raw: string): string {
  if (!raw || typeof raw !== "string") return raw ?? "";

  const trimmed = raw.trim();
  // If purely numeric, strip leading zeros
  if (/^\d+$/.test(trimmed)) {
    return String(parseInt(trimmed, 10));
  }
  // District-prefixed format: "06:12345" or "06-12345"
  const prefixed = trimmed.match(/^(\w+)[:\-](\d+)$/);
  if (prefixed) {
    const [, district, leaseNo] = prefixed;
    return `${district}:${String(parseInt(leaseNo, 10))}`;
  }
  return trimmed;
}

// ─── Operator name normalization ──────────────────────────────────────────────

/**
 * Normalize an operator name for comparison and canonical storage.
 *
 * Operations applied (in order):
 *   1. Trim whitespace
 *   2. Uppercase
 *   3. Collapse internal whitespace to single spaces
 *   4. Normalize common legal suffix variants:
 *      L.L.C. → LLC, L.P. → LP, INC. → INC, CORP. → CORP, CO. → CO
 *   5. Remove trailing punctuation
 */
export function normalizeOperatorName(raw: string): string {
  if (!raw || typeof raw !== "string") return raw ?? "";

  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    // Normalize dotted legal suffixes
    .replace(/\bL\.L\.C\.?/g, "LLC")
    .replace(/\bL\.P\.?/g, "LP")
    .replace(/\bINC\./g, "INC")
    .replace(/\bCORP\./g, "CORP")
    .replace(/\bCO\.\s*$/g, "CO")
    .replace(/\bLTD\./g, "LTD")
    // Remove trailing comma or period
    .replace(/[,.]$/, "")
    .trim();
}

// ─── Display formatting ───────────────────────────────────────────────────────

/**
 * Format a 10-digit API number for human display as "42-XXX-XXXXX".
 * Does NOT include sidetrack/event suffixes.
 *
 * Input must be a 10-digit string (no hyphens).
 * Returns the raw input unchanged if it does not match the expected pattern.
 */
export function formatApiForDisplay(api10: string): string {
  if (!api10 || typeof api10 !== "string") return api10 ?? "";

  const digits = api10.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("42")) {
    const state = digits.slice(0, 2);
    const county = digits.slice(2, 5);
    const well = digits.slice(5, 10);
    return `${state}-${county}-${well}`;
  }
  if (digits.length === 8) {
    // 8-digit TRRC form without state prefix — format as "XXX-XXXXX"
    const county = digits.slice(0, 3);
    const well = digits.slice(3, 8);
    return `${county}-${well}`;
  }
  return api10;
}

// ─── District extraction ──────────────────────────────────────────────────────

/**
 * Extract the TRRC district code from a 10-digit Texas API number.
 *
 * Uses the county code (digits 3–5 of the API) to look up the corresponding
 * TRRC district. Returns null if the county code has no known district mapping
 * or if the API is not a valid Texas number.
 *
 * Note: district assignment is not always unique — some counties straddle
 * district boundaries. This returns the primary district for the county.
 */
export function extractDistrictFromApi(api10: string): string | null {
  if (!api10 || typeof api10 !== "string") return null;

  const normalized = normalizeApiNumber(api10);
  if (!normalized) return null;

  const district = COUNTY_DISTRICTS[normalized.county_code]?.district;
  return district ?? null;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Returns true if the given district code is a known valid TRRC district.
 */
export function isValidTrrcDistrict(districtCode: string): boolean {
  return VALID_DISTRICT_CODES.has(districtCode.toUpperCase());
}

/**
 * Pad a lease number to the 6-digit zero-padded form used in TRRC EWA URLs.
 * e.g. "12345" → "012345", "123456" → "123456".
 */
export function padLeaseNumber(leaseNo: string): string {
  const digits = leaseNo.replace(/\D/g, "");
  return digits.padStart(6, "0");
}

/**
 * Convert a 10-digit API to the 8-digit TRRC form (county3 + well5, no state prefix).
 * Returns null if the input is not a valid Texas 10-digit API.
 */
export function api10ToApi8(api10: string): string | null {
  const normalized = normalizeApiNumber(api10);
  if (!normalized) return null;
  return `${normalized.county_code}${normalized.well_code}`;
}

/**
 * Convert a 10-digit API to the ICE InputMask format used by TRRC PDA violations search.
 * Format: "NNN-NNNNN" (county3 + dash + well5, no state prefix).
 */
export function api10ToIceMask(api10: string): string | null {
  const normalized = normalizeApiNumber(api10);
  if (!normalized) return null;
  return `${normalized.county_code}-${normalized.well_code}`;
}
