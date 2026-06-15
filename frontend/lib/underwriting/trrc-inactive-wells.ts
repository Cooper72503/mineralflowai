/**
 * TRRC Inactive Well / Plugging Liability Query (EWA)
 *
 * Source: TRRC EWA inactiveWellQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do
 *
 * Returns wells flagged as inactive (not producing) along with estimated
 * plugging costs, shut-in dates, and compliance due dates.
 *
 * Two query modes (confirmed live 2026):
 *
 * Mode 1 — By API number:
 *   params: searchArgs.apiNoPrefixArg=<county3>
 *           searchArgs.apiNoSuffixArg=<well5>
 *   "No results found" = well is NOT on the inactive list (good result).
 *
 * Mode 2 — By lease type + county:
 *   params: searchArgs.leaseTypeArg=O (or G)
 *           searchArgs.countyCodeArg=<3-digit FIPS code>
 *   Requires at least one of: leaseTypeArg, countyCodeArg, apiNoPrefixArg,
 *   searchArgs.leaseNumberArg, or searchArgs.operatorNumbersArg.
 *   NOTE: operator + inactiveTypeArg combo also works, but Fusion Energy Holdings
 *   had no inactive wells (confirmed — correct behavior).
 *
 * Column mapping (confirmed live 2026):
 *   0: API No.        — nested sub-table, apiNo= in href
 *   1: District
 *   2: Lease No.      — nested sub-table, leaseNo= in href
 *   3: Lease Name
 *   4: Well No.
 *   5: Field Name
 *   6: Operator Name
 *   7: County
 *   8: Oil/Gas
 *   9: API Depth (ft)
 *  10: Location       — LAND | OFFSHORE
 *  11: Shut-in Date   — MM/YYYY
 *  12: Inactivity     — e.g. "8YRS 00MOS*"
 *  13: Extension Status — Approved | Pending | (blank)
 *  14: Cost Calculation — e.g. "$51,848.00"
 *  15: Compliance Due Date — MM/DD/YYYY
 *  16: Well Plugged   — Y or blank
 *  17: Orig. Completion Date — MM/DD/YYYY
 *
 * Returns [] on failure — never throws.
 */

import { withTrrcRetry } from "./trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcInactiveWellRecord = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  field_name: string | null;
  operator_name: string | null;
  county: string | null;
  oil_or_gas: "oil" | "gas" | "unknown";
  /** API depth in feet */
  api_depth_ft: number | null;
  /** LAND | OFFSHORE */
  location: string | null;
  /** Shut-in date in MM/YYYY format */
  shut_in_date: string | null;
  /** Inactivity period string, e.g. "8YRS 00MOS*" (* = on extension) */
  inactivity_period: string | null;
  /** TRRC extension status: "Approved" | "Pending" | null */
  extension_status: string | null;
  /** Estimated plugging cost in USD (TRRC cost calculation) */
  plugging_cost_usd: number | null;
  /** Compliance / plugging due date (MM/DD/YYYY) */
  compliance_due_date: string | null;
  /** True if well has been plugged */
  well_plugged: boolean;
  /** Original completion date (MM/DD/YYYY) */
  orig_completion_date: string | null;
};

export type TrrcInactiveWellResult = {
  /**
   * True if the well is NOT on the TRRC inactive list (no results returned).
   * A well that appears in results is flagged as inactive/non-producing.
   */
  is_active_not_flagged: boolean;
  records: TrrcInactiveWellRecord[];
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
 * Detect the "no results" page vs. actual results.
 * TRRC EWA returns error code Ewa_117 for "no results found".
 */
function isNoResults(html: string): boolean {
  return /Ewa_117|No results found/i.test(html);
}

/**
 * Parse EWA inactive well results HTML.
 *
 * Strategy: same nested-table pattern as proration.
 *   1. Find each apiNo= link (identifies each result row's API).
 *   2. Walk backwards: nested sub-table → outer <td> → outer <tr>.
 *   3. Find outer </tr> using TR-depth tracking.
 *   4. Remove nested <table> blocks, map outer TDs to column positions.
 */
function parseInactiveWellHtml(html: string): TrrcInactiveWellRecord[] {
  const results: TrrcInactiveWellRecord[] = [];
  const seenApis = new Set<string>();

  const apiLinkPattern = /href="[^"]*apiNo=(\d{8})[^"]*"/g;
  let apiMatch: RegExpExecArray | null;

  while ((apiMatch = apiLinkPattern.exec(html)) !== null) {
    const api8 = apiMatch[1];
    if (seenApis.has(api8)) continue;
    seenApis.add(api8);

    const matchIdx = apiMatch.index;

    // Walk backwards: API link → nested sub-table → outer <td> → outer <tr>
    const nestedTable = html.lastIndexOf("<table>", matchIdx);
    if (nestedTable < 0) continue;
    const outerTd = html.lastIndexOf("<td>", nestedTable);
    if (outerTd < 0) continue;
    const trStart = html.lastIndexOf("<tr>", outerTd);
    if (trStart < 0) continue;

    // Find outer </tr> using TR-depth tracking
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
    if (rowHtml.includes("<th")) continue;

    // Extract lease number from link
    const leaseMatch = rowHtml.match(/leaseNo=(\d+)/);
    const leaseNo    = leaseMatch?.[1] ?? "";

    // Remove nested tables; then match outer TDs
    const cleanRow  = rowHtml.replace(/<table[\s\S]*?<\/table>/gi, "");
    const tdMatches = cleanRow.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? [];
    const vals      = tdMatches.map(td => stripHtml(td));

    // Column map after nested-table removal:
    //   [0]  "" (was API nested table)
    //   [1]  district
    //   [2]  "" (was lease nested table)
    //   [3]  lease name
    //   [4]  well no
    //   [5]  field name
    //   [6]  operator name
    //   [7]  county
    //   [8]  Oil/Gas
    //   [9]  API depth
    //   [10] location
    //   [11] shut-in date
    //   [12] inactivity
    //   [13] extension status
    //   [14] cost calculation
    //   [15] compliance due date
    //   [16] well plugged
    //   [17] orig completion date
    if (vals.length < 12) continue;

    const oilGasRaw = (vals[8] ?? "").toLowerCase();
    const oil_or_gas: "oil" | "gas" | "unknown" =
      oilGasRaw.includes("oil") ? "oil" :
      oilGasRaw.includes("gas") ? "gas" : "unknown";

    results.push({
      api8,
      district:            vals[1] ?? "",
      lease_no:            leaseNo,
      lease_name:          vals[3] || null,
      well_no:             vals[4] || null,
      field_name:          vals[5] || null,
      operator_name:       vals[6] || null,
      county:              vals[7] || null,
      oil_or_gas,
      api_depth_ft:        parseNum(vals[9] ?? ""),
      location:            vals[10] || null,
      shut_in_date:        vals[11] || null,
      inactivity_period:   vals[12] || null,
      extension_status:    vals[13] || null,
      plugging_cost_usd:   parseNum(vals[14] ?? ""),
      compliance_due_date: vals[15] || null,
      well_plugged:        (vals[16] ?? "").toUpperCase() === "Y",
      orig_completion_date: vals[17] || null,
    });
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const INACTIVE_FALLBACK: TrrcInactiveWellResult = { is_active_not_flagged: true, records: [] };

async function _fetchTrrcInactiveWellByApi(api10: string, _signal: AbortSignal): Promise<TrrcInactiveWellResult> {
  const digits = api10.replace(/\D/g, "");
  const api8   = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.apiNoPrefixArg": api8.slice(0, 3),
    "searchArgs.apiNoSuffixArg": api8.slice(3, 8),
  });
  const res = await fetch(`${EWA_BASE}/inactiveWellQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0" },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return INACTIVE_FALLBACK;
  const html = await res.text();
  if (isNoResults(html)) return INACTIVE_FALLBACK;
  const records = parseInactiveWellHtml(html);
  return { is_active_not_flagged: records.length === 0, records };
}

/**
 * Check if a specific well is on the TRRC inactive well list.
 * Never throws.
 */
export async function fetchTrrcInactiveWellByApi(api10: string): Promise<TrrcInactiveWellResult> {
  return withTrrcRetry(sig => _fetchTrrcInactiveWellByApi(api10, sig), INACTIVE_FALLBACK, { timeout: 15_000 });
}

async function _fetchTrrcInactiveWellsByOperator(operatorNo: string, leaseType: "O" | "G", _signal: AbortSignal): Promise<TrrcInactiveWellRecord[]> {
  const params = new URLSearchParams({
    methodToCall:                    "search",
    "searchArgs.operatorNumbersArg": operatorNo.trim(),
    "searchArgs.inactiveTypeArg":    "2",
    "searchArgs.leaseTypeArg":       leaseType,
  });
  const res = await fetch(`${EWA_BASE}/inactiveWellQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0" },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  if (isNoResults(html)) return [];
  return parseInactiveWellHtml(html);
}

/**
 * Fetch inactive wells for a given operator number.
 * Returns [] when the operator has no inactive wells (clean record). Never throws.
 */
export async function fetchTrrcInactiveWellsByOperator(
  operatorNo: string,
  leaseType:  "O" | "G" = "O",
): Promise<TrrcInactiveWellRecord[]> {
  if (!operatorNo?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcInactiveWellsByOperator(operatorNo, leaseType, sig), [], { timeout: 15_000 });
}

async function _fetchTrrcInactiveWellsByCounty(countyCode: string, leaseType: "O" | "G", _signal: AbortSignal): Promise<TrrcInactiveWellRecord[]> {
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.leaseTypeArg":   leaseType,
    "searchArgs.countyCodeArg":  countyCode.padStart(3, "0"),
  });
  const res = await fetch(`${EWA_BASE}/inactiveWellQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0" },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  if (isNoResults(html)) return [];
  return parseInactiveWellHtml(html);
}

/**
 * Fetch inactive wells for a county (oil wells).
 * Returns [] on failure or no results. Never throws.
 */
export async function fetchTrrcInactiveWellsByCounty(
  countyCode: string,
  leaseType:  "O" | "G" = "O",
): Promise<TrrcInactiveWellRecord[]> {
  if (!countyCode?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcInactiveWellsByCounty(countyCode, leaseType, sig), [], { timeout: 15_000 });
}

/**
 * Estimate plugging liability for a set of inactive well records.
 * Uses the TRRC cost calculation field when available; falls back to
 * a basin-average estimate of $50,000/well for Texas.
 */
export function estimatePluggingLiability(
  records: TrrcInactiveWellRecord[],
  fallbackCostPerWell = 50_000,
): number {
  return records.reduce((sum, r) => {
    return sum + (r.plugging_cost_usd ?? fallbackCostPerWell);
  }, 0);
}
