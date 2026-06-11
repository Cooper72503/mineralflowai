/**
 * TRRC Oil & Gas Proration Factor Lookup (EWA)
 *
 * Source: TRRC EWA oilProQueryAction.do / gasProQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/oilProQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/gasProQueryAction.do
 *
 * Returns daily allowable, potential (BBL for oil / MCF for gas), GOR, acreage,
 * field and unit information for a specific well API or lease.
 *
 * Column mapping (confirmed live 2026):
 *   0: API No.        — nested sub-table, extracted from apiNo= link param
 *   1: District
 *   2: Lease No.      — nested sub-table, extracted from leaseNo= link param
 *   3: Lease Name
 *   4: Well No.       — may contain a link; link text is the well number
 *   5: Field No.      — may contain a link
 *   6: Field Name
 *   7: Field Type     — REGULAR | SPECIAL | EXCEPTION
 *   8: Operator No.
 *   9: Operator Name
 *  10: Unit No.       — may contain a link
 *  11: Potential (BBL or MCF)
 *  12: Gas/Oil Ratio
 *  13: Acres
 *  14: Daily Allowable — e.g. "14(B)(2) EXT 00/00" or a numeric allowable
 *  15: Unit or Well Type — PRODUCER | INJECTION | OBSERVATION | etc.
 *
 * The first and third columns contain nested <table> elements (API and lease links).
 * We extract API via regex on the href rather than parsing column position.
 *
 * Returns [] on failure — never throws.
 */

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcProrationRecord = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  field_no: string | null;
  field_name: string | null;
  /** REGULAR | SPECIAL | EXCEPTION */
  field_type: string | null;
  operator_no: string | null;
  operator_name: string | null;
  unit_no: string | null;
  /** Potential in BBL/day (oil) or MCF/day (gas). 0 for injection/observation wells. */
  potential: number | null;
  /** Gas/Oil Ratio — 0 for injection wells or if not assigned */
  gor: number | null;
  /** Proration tract acreage */
  acres: number | null;
  /**
   * Daily allowable, e.g.:
   *   "14(B)(2) EXT 00/00"  — extension allowable type (injection / unit extension)
   *   "1234"                — numeric daily allowable in BBL or MCF
   *   "EXEMPT"              — exempt from proration
   */
  daily_allowable: string | null;
  /**
   * Unit or Well Type:
   *   PRODUCER | INJECTION | OBSERVATION | UNIT PRODUCER | etc.
   */
  well_type: string | null;
  /** "oil" for oilProQueryAction results, "gas" for gasProQueryAction */
  commodity: "oil" | "gas";
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNum(s: string): number | null {
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
}

/**
 * Parse the EWA proration results HTML.
 *
 * Strategy:
 *   1. Locate each API link (apiNo=XXXXXXXX) in the results table.
 *   2. Walk backwards from the API link: nested <table> → outer <td> → outer <tr>.
 *   3. Find the outer </tr> using TR-depth tracking (correctly skips nested <tr>s).
 *   4. Remove nested <table>…</table> blocks, then map remaining outer <td>s.
 */
function parseProrationHtml(html: string, commodity: "oil" | "gas"): TrrcProrationRecord[] {
  const results: TrrcProrationRecord[] = [];
  const seenApis = new Set<string>();

  // Find all API link occurrences (href contains apiNo=XXXXXXXX)
  const apiLinkPattern = /href="[^"]*apiNo=(\d{8})[^"]*"/g;
  let apiMatch: RegExpExecArray | null;

  while ((apiMatch = apiLinkPattern.exec(html)) !== null) {
    const api8 = apiMatch[1];
    if (seenApis.has(api8)) continue;
    seenApis.add(api8);

    const matchIdx = apiMatch.index;

    // Walk backwards: API link → nested sub-table start → outer <td> → outer <tr>
    const nestedTable = html.lastIndexOf("<table>", matchIdx);
    if (nestedTable < 0) continue;
    const outerTd = html.lastIndexOf("<td>", nestedTable);
    if (outerTd < 0) continue;
    const trStart = html.lastIndexOf("<tr>", outerTd);
    if (trStart < 0) continue;

    // Find outer </tr> using TR-depth tracking (correctly handles nested <tr>s)
    const outerTrEnd = (() => {
      let trDepth = 1;
      let i = trStart + 4;
      while (i < html.length && i < trStart + 50000) {
        if (html[i] === "<") {
          const seg = html.slice(i, i + 6).toLowerCase();
          if (seg.startsWith("<tr>") || seg.startsWith("<tr ")) trDepth++;
          else if (seg.startsWith("</tr>")) {
            trDepth--;
            if (trDepth === 0) return i + 5;
          }
        }
        i++;
      }
      return -1;
    })();

    if (outerTrEnd < 0) continue;

    const rowHtml = html.slice(trStart, outerTrEnd);

    // Skip header rows and nested-table inner rows
    if (rowHtml.includes("<th")) continue;

    // Extract lease number from link
    const leaseMatch = rowHtml.match(/leaseNo=(\d{5,6})/);
    const leaseNo = leaseMatch?.[1] ?? "";

    // Remove nested tables so we can safely match outer TDs
    const cleanRow = rowHtml.replace(/<table[\s\S]*?<\/table>/gi, "");

    // Match outer TDs
    const tdMatches = cleanRow.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? [];
    const vals = tdMatches.map(td => stripHtml(td));

    // After removing nested tables, the TD positions shift:
    //   TD[0] = "" (was API nested table)         → [0] blank
    //   TD[1] = "8A"                              → district
    //   TD[2] = "" (was lease nested table)        → [2] blank
    //   TD[3] = "ODC /SAN ANDRES/ UNIT"           → lease name
    //   TD[4] = "* 9"                             → well no (may have link)
    //   TD[5] = "66373750"                        → field no (may have link)
    //   TD[6] = "O D C (SAN ANDRES)"             → field name
    //   TD[7] = "REGULAR"                         → field type
    //   TD[8] = "102004"                          → operator no
    //   TD[9] = "FUSION ENERGY HOLDINGS, LLC"    → operator name
    //   TD[10] = "Unit 1"                         → unit no (may have link)
    //   TD[11] = "0.0"                            → potential
    //   TD[12] = "0"                              → GOR
    //   TD[13] = "0.0"                            → acres
    //   TD[14] = "14(B)(2) EXT 00/00"            → daily allowable
    //   TD[15] = "INJECTION"                      → well type

    if (vals.length < 12) continue;

    results.push({
      api8,
      district:        vals[1] ?? "",
      lease_no:        leaseNo,
      lease_name:      vals[3] || null,
      well_no:         vals[4] || null,
      field_no:        vals[5] || null,
      field_name:      vals[6] || null,
      field_type:      vals[7] || null,
      operator_no:     vals[8] || null,
      operator_name:   vals[9] || null,
      unit_no:         vals[10] || null,
      potential:       parseNum(vals[11] ?? ""),
      gor:             parseNum(vals[12] ?? ""),
      acres:           parseNum(vals[13] ?? ""),
      daily_allowable: vals[14] || null,
      well_type:       vals[15] || null,
      commodity,
    });
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch oil proration factor record(s) for a given well API number.
 *
 * @param api10     10-digit API number (42 + county3 + well5)
 * @param distCode  TRRC district code (e.g. "8A", "02")
 *
 * Returns [] on failure or when no proration record exists. Never throws.
 */
export async function fetchTrrcOilProration(
  api10:    string,
  distCode: string,
): Promise<TrrcProrationRecord[]> {
  const digits = api10.replace(/\D/g, "");
  // Strip "42" state prefix to get 8-digit API
  const api8    = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const prefix  = api8.slice(0, 3);
  const suffix  = api8.slice(3, 8);

  try {
    const params = new URLSearchParams({
      methodToCall:                    "search",
      "searchArgs.apiPrefixArg":       prefix,
      "searchArgs.apiSuffixArg":       suffix,
      "searchArgs.districtCodeArg":    distCode,
    });

    const res = await fetch(`${EWA_BASE}/oilProQueryAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":       "text/html,application/xhtml+xml",
        "User-Agent":   "Mozilla/5.0",
      },
      body: params.toString(),
    });

    if (!res.ok) return [];
    const html = await res.text();

    // Quick check — if server says "no results" skip parsing
    if (/no results found/i.test(html)) return [];

    return parseProrationHtml(html, "oil");
  } catch {
    return [];
  }
}

/**
 * Fetch gas proration (allowable) record(s) for a given well API number.
 *
 * @param api10     10-digit API number
 * @param distCode  TRRC district code
 *
 * Returns [] on failure. Never throws.
 */
export async function fetchTrrcGasProration(
  api10:    string,
  distCode: string,
): Promise<TrrcProrationRecord[]> {
  const digits = api10.replace(/\D/g, "");
  const api8   = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const prefix = api8.slice(0, 3);
  const suffix = api8.slice(3, 8);

  try {
    const params = new URLSearchParams({
      methodToCall:                    "search",
      "searchArgs.apiPrefixArg":       prefix,
      "searchArgs.apiSuffixArg":       suffix,
      "searchArgs.districtCodeArg":    distCode,
    });

    const res = await fetch(`${EWA_BASE}/gasProQueryAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":       "text/html,application/xhtml+xml",
        "User-Agent":   "Mozilla/5.0",
      },
      body: params.toString(),
    });

    if (!res.ok) return [];
    const html = await res.text();
    if (/no results found/i.test(html)) return [];

    return parseProrationHtml(html, "gas");
  } catch {
    return [];
  }
}

/**
 * Fetch both oil and gas proration records for a well, merging results.
 * Returns [] on failure. Never throws.
 */
export async function fetchTrrcProration(
  api10:    string,
  distCode: string,
): Promise<TrrcProrationRecord[]> {
  const [oil, gas] = await Promise.all([
    fetchTrrcOilProration(api10, distCode),
    fetchTrrcGasProration(api10, distCode),
  ]);
  return [...oil, ...gas];
}
