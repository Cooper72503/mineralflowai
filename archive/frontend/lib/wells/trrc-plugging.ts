/**
 * TRRC Plugging Record Query (EWA)
 *
 * Source: TRRC EWA pluggingQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/pluggingQueryAction.do
 *
 * Returns plugging records for wells that have been plugged and abandoned,
 * including plugging method, depth intervals, and final status.
 *
 * Two query modes:
 *
 * Mode 1 — By API number:
 *   params: searchArgs.apiNoPrefixArg=<county3>
 *           searchArgs.apiNoSuffixArg=<well5>
 *
 * Mode 2 — By lease:
 *   params: searchArgs.leaseNumberArg=<lease_no>
 *           searchArgs.leaseTypeArg=O  (or G)
 *           searchArgs.districtArg=<district>
 *
 * Column mapping (standard EWA layout):
 *   0: API No.           — nested sub-table, apiNo= in href
 *   1: District
 *   2: Lease No.         — nested sub-table, leaseNo= in href
 *   3: Lease Name
 *   4: Well No.
 *   5: Field Name
 *   6: Operator Name
 *   7: County
 *   8: Oil/Gas
 *   9: Plug Start Date   (MM/DD/YYYY)
 *  10: Plug End Date     (MM/DD/YYYY)
 *  11: Plugging Method   (e.g. "Balanced Plug")
 *  12: Total Depth (ft)
 *  13: Plug Back Depth (ft)
 *  14: Status            (e.g. "Plugged and Abandoned")
 *
 * Returns [] on failure — never throws.
 */

import { withTrrcRetry, detectTrrcColumns, makeColResolver } from "../underwriting/trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcPluggingRecord = {
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
  /** Plug start date in MM/DD/YYYY format */
  plug_start_date: string | null;
  /** Plug end date in MM/DD/YYYY format */
  plug_end_date: string | null;
  plugging_method: string | null;
  total_depth_ft: number | null;
  plug_back_depth_ft: number | null;
  status: string | null;
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

function isNoResults(html: string): boolean {
  return /Ewa_117|No results found/i.test(html);
}

/**
 * Parse EWA plugging results HTML.
 *
 * Strategy (same pattern as trrc-inactive-wells.ts):
 *   1. Find each apiNo= link (identifies each result row's API).
 *   2. Walk backwards: nested sub-table → outer <td> → outer <tr>.
 *   3. Find outer </tr> using TR-depth tracking.
 *   4. Remove nested <table> blocks, map outer TDs to column positions.
 */
function parsePluggingHtml(html: string): TrrcPluggingRecord[] {
  const results: TrrcPluggingRecord[] = [];
  const seenApis = new Set<string>();
  const colMap = detectTrrcColumns(html);

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

    // After nested-table removal, TDs shift:
    //   [0]  "" (was API nested table)
    //   [1]  district
    //   [2]  "" (was lease nested table)
    //   [3]  lease name
    //   [4]  well no
    //   [5]  field name
    //   [6]  operator name
    //   [7]  county
    //   [8]  oil/gas
    //   [9]  plug start date
    //   [10] plug end date
    //   [11] plugging method
    //   [12] total depth
    //   [13] plug back depth
    //   [14] status
    if (vals.length < 9) continue;

    // Use makeColResolver for robust column handling when header detection works
    const resolve = makeColResolver(colMap, 0, vals, 0);

    const oilGasRaw = (resolve("oil_gas", 8) ?? vals[8] ?? "").toLowerCase();
    const oil_or_gas: "oil" | "gas" | "unknown" =
      oilGasRaw.includes("oil") ? "oil" :
      oilGasRaw.includes("gas") ? "gas" : "unknown";

    results.push({
      api8,
      district:          vals[1] ?? "",
      lease_no:          leaseNo,
      lease_name:        vals[3] || null,
      well_no:           vals[4] || null,
      field_name:        vals[5] || null,
      operator_name:     vals[6] || null,
      county:            vals[7] || null,
      oil_or_gas,
      plug_start_date:   vals[9] || null,
      plug_end_date:     vals[10] || null,
      plugging_method:   vals[11] || null,
      total_depth_ft:    parseNum(vals[12] ?? ""),
      plug_back_depth_ft: parseNum(vals[13] ?? ""),
      status:            vals[14] || null,
    });
  }

  return results;
}

// ─── Internal fetchers ────────────────────────────────────────────────────────

async function _fetchTrrcPluggingByApi(
  api10:  string,
  signal: AbortSignal,
): Promise<TrrcPluggingRecord[]> {
  const digits = api10.replace(/\D/g, "");
  const api8   = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.apiNoPrefixArg": api8.slice(0, 3),
    "searchArgs.apiNoSuffixArg": api8.slice(3, 8),
  });
  const res = await fetch(`${EWA_BASE}/pluggingQueryAction.do`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept":       "text/html,application/xhtml+xml",
      "User-Agent":   "Mozilla/5.0",
    },
    body: params.toString(),
    signal,
  });
  if (!res.ok) return [];
  const html = await res.text();
  if (isNoResults(html)) return [];
  return parsePluggingHtml(html);
}

async function _fetchTrrcPluggingByLease(
  district:  string,
  leaseNo:   string,
  leaseType: "O" | "G",
  signal:    AbortSignal,
): Promise<TrrcPluggingRecord[]> {
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.leaseNumberArg": leaseNo.trim(),
    "searchArgs.leaseTypeArg":   leaseType,
    "searchArgs.districtArg":    district.trim(),
  });
  const res = await fetch(`${EWA_BASE}/pluggingQueryAction.do`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept":       "text/html,application/xhtml+xml",
      "User-Agent":   "Mozilla/5.0",
    },
    body: params.toString(),
    signal,
  });
  if (!res.ok) return [];
  const html = await res.text();
  if (isNoResults(html)) return [];
  return parsePluggingHtml(html);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch plugging records for a well by API number.
 * Returns [] when no plugging record exists or on failure. Never throws.
 */
export async function fetchTrrcPluggingByApi(api10: string): Promise<TrrcPluggingRecord[]> {
  if (!api10?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcPluggingByApi(api10, sig), [], { timeout: 15_000 });
}

/**
 * Fetch plugging records for a lease by district + lease number.
 * Returns [] on failure. Never throws.
 */
export async function fetchTrrcPluggingByLease(
  district:  string,
  leaseNo:   string,
  leaseType: "O" | "G" = "O",
): Promise<TrrcPluggingRecord[]> {
  if (!leaseNo?.trim()) return [];
  return withTrrcRetry(
    sig => _fetchTrrcPluggingByLease(district, leaseNo, leaseType, sig),
    [],
    { timeout: 15_000 },
  );
}
