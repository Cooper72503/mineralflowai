/**
 * TRRC Severance / Seal Order Query (EWA)
 *
 * Source: TRRC EWA severanceQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do
 *
 * Returns severance and seal order records for wells. A severance order
 * prohibits production until TRRC directive is complied with. A seal order
 * physically locks the wellhead. Either is a critical diligence finding.
 *
 * Two query modes:
 *
 * Mode 1 — By API number:
 *   params: searchArgs.apiNoPrefixArg=<county3>
 *           searchArgs.apiNoSuffixArg=<well5>
 *
 * Mode 2 — By operator:
 *   params: searchArgs.operatorNumbersArg=<operator_no>
 *
 * Column mapping (standard EWA layout):
 *   0: API No.           — nested sub-table, apiNo= in href
 *   1: District
 *   2: Lease No.         — nested sub-table, leaseNo= in href
 *   3: Lease Name
 *   4: Well No.
 *   5: Operator Name
 *   6: County
 *   7: Severance Date    (MM/DD/YYYY)
 *   8: Release Date      (MM/DD/YYYY or blank)
 *   9: Severance Reason
 *  10: Status            ("Active" | "Released")
 *
 * Returns [] on failure — never throws.
 */

import { withTrrcRetry, detectTrrcColumns, makeColResolver } from "../underwriting/trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcSeveranceRecord = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  operator_name: string | null;
  county: string | null;
  severance_date: string | null;
  release_date: string | null;
  severance_reason: string | null;
  status: "active" | "released" | "unknown";
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

function isNoResults(html: string): boolean {
  return /Ewa_117|No results found/i.test(html);
}

/**
 * Parse EWA severance results HTML.
 *
 * Strategy (same pattern as trrc-inactive-wells.ts):
 *   1. Find each apiNo= link (identifies each result row's API).
 *   2. Walk backwards: nested sub-table → outer <td> → outer <tr>.
 *   3. Find outer </tr> using TR-depth tracking.
 *   4. Remove nested <table> blocks, map outer TDs to column positions.
 *
 * Note: severance table has fewer columns than inactive wells — no field name
 * column; operator name appears at position 5 directly after well no.
 */
function parseSeveranceHtml(html: string): TrrcSeveranceRecord[] {
  const results: TrrcSeveranceRecord[] = [];
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
    //   [5]  operator name
    //   [6]  county
    //   [7]  severance date
    //   [8]  release date
    //   [9]  severance reason
    //   [10] status
    if (vals.length < 7) continue;

    // Use makeColResolver for robust column handling
    const resolve = makeColResolver(colMap, 0, vals, 0);
    void resolve; // available for future use

    const statusRaw = (vals[10] ?? "").toLowerCase().trim();
    const status: "active" | "released" | "unknown" =
      statusRaw.includes("active")   ? "active"   :
      statusRaw.includes("released") ? "released" : "unknown";

    results.push({
      api8,
      district:         vals[1] ?? "",
      lease_no:         leaseNo,
      lease_name:       vals[3] || null,
      well_no:          vals[4] || null,
      operator_name:    vals[5] || null,
      county:           vals[6] || null,
      severance_date:   vals[7] || null,
      release_date:     vals[8] || null,
      severance_reason: vals[9] || null,
      status,
    });
  }

  return results;
}

// ─── Internal fetchers ────────────────────────────────────────────────────────

async function _fetchTrrcSeveranceByApi(
  api10:  string,
  signal: AbortSignal,
): Promise<TrrcSeveranceRecord[]> {
  const digits = api10.replace(/\D/g, "");
  const api8   = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.apiNoPrefixArg": api8.slice(0, 3),
    "searchArgs.apiNoSuffixArg": api8.slice(3, 8),
  });
  const res = await fetch(`${EWA_BASE}/severanceQueryAction.do`, {
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
  return parseSeveranceHtml(html);
}

async function _fetchTrrcSeveranceByOperator(
  operatorNo: string,
  signal:     AbortSignal,
): Promise<TrrcSeveranceRecord[]> {
  const params = new URLSearchParams({
    methodToCall:                    "search",
    "searchArgs.operatorNumbersArg": operatorNo.trim(),
  });
  const res = await fetch(`${EWA_BASE}/severanceQueryAction.do`, {
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
  return parseSeveranceHtml(html);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch severance / seal order records for a well by API number.
 * Returns [] when no severance record exists (good result) or on failure. Never throws.
 */
export async function fetchTrrcSeveranceByApi(api10: string): Promise<TrrcSeveranceRecord[]> {
  if (!api10?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcSeveranceByApi(api10, sig), [], { timeout: 15_000 });
}

/**
 * Fetch severance / seal order records for all wells under an operator number.
 * Returns [] on failure. Never throws.
 */
export async function fetchTrrcSeveranceByOperator(operatorNo: string): Promise<TrrcSeveranceRecord[]> {
  if (!operatorNo?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcSeveranceByOperator(operatorNo, sig), [], { timeout: 15_000 });
}
