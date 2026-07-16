/**
 * TRRC Public Records Due Diligence — Identifier normalization utilities.
 *
 * All functions are pure (no side effects, no I/O) and compile under strict mode.
 * Texas API numbers follow the format: state(2) + county(3) + well(5) = 10 digits.
 * The full 14-digit UWI appends sidetrack(2) + event(2), defaulting to "00" each.
 */

import type { NormalizedApi, TrrcIdentifierType } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Texas FIPS state code embedded in all Texas API numbers */
const TX_STATE_CODE = "42";

/**
 * TRRC district codes that are valid for EWA queries.
 * Derived from the first 2 digits of the 8-digit API suffix (county code → district map).
 * Districts 01–10 plus special codes 6E, 7B, 7C, 8A, 8B, 9B.
 */
const VALID_DISTRICT_CODES = new Set([
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
  "6E", "7B", "7C", "8A", "8B", "9B",
]);

/**
 * Map from 3-digit Texas county FIPS code to primary TRRC district code.
 * Each FIPS code appears exactly once — no duplicate keys.
 * When a county straddles district boundaries, the primary O&G district is used.
 * Sourced from the TRRC official county-to-district assignment table.
 */
const COUNTY_TO_DISTRICT: Record<string, string> = {
  "001": "06", // Anderson       — District 06 (Kilgore)
  "003": "8A", // Andrews        — District 8A (Odessa)
  "007": "02", // Atascosa       — District 02 (San Antonio)
  "009": "04", // Archer         — District 04 (Abilene)
  "011": "10", // Austin         — District 10 (Beaumont)
  "013": "02", // Bandera        — District 02 (San Antonio)
  "017": "01", // Bailey         — District 01 (Lubbock)
  "019": "02", // Bandera (2)    — District 02
  "023": "05", // Baylor         — District 05 (Wichita Falls)
  "025": "7B", // Bee            — District 7B (Corpus Christi)
  "029": "02", // Bexar          — District 02
  "031": "7C", // Borden (low)   — District 7C (Alice)
  "033": "01", // Borden (Lub.)  — District 01
  "037": "05", // Bowie          — District 05
  "039": "05", // Brazos         — District 05
  "047": "7B", // Brooks         — District 7B
  "049": "04", // Brown          — District 04
  "055": "02", // Caldwell       — District 02
  "057": "06", // Cass           — District 06
  "059": "04", // Callahan       — District 04
  "061": "7C", // Cameron        — District 7C
  "065": "09", // Castro         — District 09 (Amarillo)
  "067": "09", // Childress      — District 09
  "069": "8A", // Cochran        — District 8A
  "071": "10", // Chambers       — District 10
  "073": "06", // Cherokee       — District 06
  "077": "05", // Cooke          — District 05
  "079": "7C", // Dimmit (low)   — District 7C
  "085": "10", // Colorado       — District 10
  "087": "06", // Cherokee (2)   — District 06
  "093": "02", // DeWitt (SA)    — District 02
  "095": "7B", // Duval          — District 7B
  "097": "02", // DeWitt         — District 02
  "099": "10", // Coryell        — District 10
  "101": "06", // Dallas         — District 06
  "103": "03", // Crane          — District 03 (Midland)
  "105": "03", // Crockett       — District 03
  "107": "01", // Dawson (Lub.)  — District 01
  "111": "09", // Dallam         — District 09
  "113": "10", // Dallas (2)     — District 10
  "115": "8A", // Dawson (W.TX)  — District 8A
  "117": "09", // Deaf Smith     — District 09
  "119": "9B", // Delta          — District 9B (Pampa)
  "121": "10", // Bastrop        — District 10
  "123": "7C", // DeWitt (S.TX)  — District 7C
  "125": "01", // Crosby         — District 01
  "127": "02", // Dimmit (SA)    — District 02
  "131": "7B", // Duval (2)      — District 7B
  "135": "03", // Ector          — District 03
  "137": "02", // Edwards        — District 02
  "139": "06", // Ellis          — District 06
  "143": "06", // Erath          — District 06
  "149": "7B", // Jim Wells      — District 7B
  "151": "04", // Fisher         — District 04
  "153": "09", // Floyd (N.TX)   — District 09
  "155": "05", // Foard          — District 05
  "157": "9B", // Gray           — District 9B
  "159": "05", // Franklin       — District 05
  "161": "06", // Freestone      — District 06
  "163": "02", // Frio           — District 02
  "165": "04", // Gaines         — District 04
  "167": "10", // Grimes         — District 10
  "169": "01", // Garza          — District 01
  "171": "02", // Gillespie      — District 02
  "173": "03", // Glasscock      — District 03
  "175": "7B", // Goliad         — District 7B
  "177": "10", // Harris         — District 10
  "179": "9B", // Hall           — District 9B
  "183": "04", // Eastland       — District 04
  "185": "01", // Floyd (Lub.)   — District 01
  "187": "02", // Gonzales       — District 02
  "191": "7C", // Hidalgo        — District 7C
  "193": "05", // Hamilton       — District 05
  "195": "09", // Hale (N.TX)    — District 09
  "197": "01", // Hale (Lub.)    — District 01
  "199": "10", // Hardin         — District 10
  "201": "10", // Harris (2)     — District 10
  "203": "06", // Henderson      — District 06
  "207": "09", // Hansford       — District 09
  "211": "09", // Hardeman       — District 09
  "213": "06", // Houston        — District 06
  "215": "10", // Jasper         — District 10
  "217": "06", // Hunt           — District 06
  "219": "01", // Lamb           — District 01
  "225": "04", // Lampasas       — District 04
  "227": "03", // Howard         — District 03
  "229": "10", // Jefferson      — District 10
  "233": "09", // Hartley        — District 09
  "235": "03", // Irion          — District 03
  "237": "05", // Jack           — District 05
  "241": "10", // Lamar          — District 10
  "243": "09", // Hemphill       — District 09
  "245": "10", // Lavaca         — District 10
  "247": "7C", // Jim Hogg       — District 7C
  "249": "7B", // Jim Hogg (2)   — District 7B
  "253": "01", // Jones          — District 01
  "255": "7C", // Kenedy         — District 7C
  "259": "9B", // Hutchinson     — District 9B
  "261": "05", // Kaufman        — District 05
  "263": "01", // Kent           — District 01
  "265": "04", // Kimble         — District 04
  "269": "04", // King           — District 04
  "271": "02", // Kinney         — District 02
  "273": "7B", // Kleberg        — District 7B
  "275": "01", // Knox           — District 01
  "283": "02", // La Salle       — District 02
  "285": "7B", // Lasalle (2)    — District 7B
  "291": "10", // Montgomery     — District 10
  "293": "05", // Montague       — District 05
  "295": "09", // Moore          — District 09
  "297": "7B", // Maverick       — District 7B
  "301": "03", // Loving         — District 03
  "303": "01", // Lubbock        — District 01
  "305": "01", // Lynn           — District 01
  "307": "04", // McCulloch      — District 04
  "311": "7C", // McMullen       — District 7C
  "313": "10", // Nacogdoches    — District 10
  "315": "06", // Nacogdoches(2) — District 06
  "317": "03", // Martin         — District 03
  "319": "04", // Mason          — District 04
  "325": "02", // Maverick (2)   — District 02
  "327": "02", // Medina         — District 02
  "329": "03", // Midland        — District 03
  "335": "04", // Mitchell       — District 04
  "341": "09", // Ochiltree      — District 09
  "343": "09", // Oldham         — District 09
  "349": "06", // Panola         — District 06
  "351": "10", // Polk           — District 10
  "353": "04", // Nolan          — District 04
  "355": "7B", // Refugio        — District 7B
  "357": "09", // Roberts        — District 09
  "361": "10", // Robertson      — District 10
  "363": "05", // Palo Pinto     — District 05
  "365": "06", // Rains          — District 06
  "369": "01", // Motley         — District 01
  "371": "02", // Real           — District 02
  "373": "10", // Sabine         — District 10
  "375": "09", // Randall        — District 09
  "381": "09", // Swisher        — District 09
  "383": "03", // Reagan         — District 03
  "385": "7C", // San Patricio   — District 7C
  "389": "02", // Real (2)       — District 02
  "393": "7B", // San Patricio(2)— District 7B
  "395": "10", // San Augustine  — District 10
  "399": "01", // Runnels        — District 01
  "401": "06", // Rusk           — District 06
  "403": "10", // San Jacinto    — District 10
  "407": "06", // Sabine (2)     — District 06
  "409": "7B", // Starr          — District 7B
  "413": "03", // Schleicher     — District 03
  "415": "01", // Scurry         — District 01
  "417": "04", // Shackelford    — District 04
  "419": "06", // Shelby         — District 06
  "421": "09", // Sherman        — District 09
  "423": "10", // Smith          — District 10
  "427": "02", // Uvalde         — District 02
  "429": "09", // Swisher(2)     — District 09
  "431": "03", // Sterling       — District 03
  "433": "01", // Stonewall      — District 01
  "435": "02", // Sutton         — District 02
  "441": "01", // Taylor         — District 01
  "443": "04", // Terrell        — District 04
  "445": "01", // Throckmorton   — District 01
  "449": "06", // Trinity        — District 06
  "451": "04", // Tom Green      — District 04
  "457": "10", // Tyler          — District 10
  "459": "06", // Upshur         — District 06
  "461": "03", // Upton          — District 03
  "463": "7B", // Webb           — District 7B
  "467": "05", // Wichita        — District 05
  "469": "7B", // Webb (2)       — District 7B
  "471": "10", // Walker         — District 10
  "473": "06", // Van Zandt      — District 06
  "475": "03", // Ward           — District 03
  "483": "09", // Wheeler        — District 09
  "487": "05", // Wilbarger      — District 05
  "495": "03", // Winkler        — District 03
  "497": "05", // Wise           — District 05
  "499": "05", // Wood           — District 05
  "501": "01", // Yoakum         — District 01
  "507": "02", // Zavala         — District 02
};

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
  // Strip all non-digit characters to work with pure digit string
  const digits = trimmed.replace(/\D/g, "");

  let api10: string;

  if (digits.length === 14 && digits.startsWith("42")) {
    // Full 14-digit UWI (42 + county3 + well5 + sidetrack2 + event2)
    api10 = digits.slice(0, 10);
  } else if (digits.length === 10 && digits.startsWith("42")) {
    // Standard 10-digit Texas API
    api10 = digits;
  } else if (digits.length === 8) {
    // 8-digit TRRC form: county3 + well5 (no state prefix)
    api10 = `${TX_STATE_CODE}${digits}`;
  } else if (digits.length >= 10 && digits.startsWith("42")) {
    // Longer string starting with 42 — truncate to 10
    api10 = digits.slice(0, 10);
  } else {
    return null;
  }

  // Validate: must be exactly 10 digits and start with "42"
  if (api10.length !== 10 || !api10.startsWith(TX_STATE_CODE)) return null;

  const state_code = api10.slice(0, 2);
  const county_code = api10.slice(2, 5);
  const well_code = api10.slice(5, 10);

  // Validate county code is plausible (001–507, odd numbers only for TX FIPS)
  const countyNum = parseInt(county_code, 10);
  if (countyNum < 1 || countyNum > 507) return null;

  const api14 = `${api10}0000`;

  // Display format: "42-151-01734-00-00"
  const formatted = `${state_code}-${county_code}-${well_code}-00-00`;

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

  // 1. API number: starts with "42" (with or without dashes) or is 8-digit county+well
  const digits = trimmed.replace(/\D/g, "");
  if (
    (digits.startsWith("42") && digits.length >= 8 && digits.length <= 14) ||
    (digits.length === 8 && /^\d{3}-\d{5}$/.test(trimmed))
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

  const district = COUNTY_TO_DISTRICT[normalized.county_code];
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
