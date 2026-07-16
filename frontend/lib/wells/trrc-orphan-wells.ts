/**
 * TRRC Orphan Well Query (EWA)
 *
 * Source: TRRC EWA orphanWellQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/orphanWellQueryAction.do
 *
 * Returns wells on the TRRC Orphan Well Program list — wells where the
 * responsible operator is defunct or insolvent and TRRC has assumed
 * plugging responsibility via the Oil Field Cleanup Fund.
 *
 * Query mode — By API number:
 *   params: searchArgs.apiNoPrefixArg=<county3>
 *           searchArgs.apiNoSuffixArg=<well5>
 *
 * Column mapping (standard EWA layout):
 *   0: API No.                  — nested sub-table, apiNo= in href
 *   1: District
 *   2: Lease No.                — nested sub-table, leaseNo= in href
 *   3: Lease Name
 *   4: Well No.
 *   5: County
 *   6: Operator No. (last known)
 *   7: Operator Name (last known)
 *   8: P5 Status
 *   9: Bond Amount
 *  10: Date Added to Orphan List
 *  11: Well Status
 *
 * Returns [] on failure — never throws.
 */

import { withTrrcRetry, detectTrrcColumns, makeColResolver } from "../underwriting/trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcOrphanWellRecord = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  county: string | null;
  last_operator_no: string | null;
  last_operator_name: string | null;
  p5_status: string | null;
  bond_amount_usd: number | null;
  date_added: string | null;
  well_status: string | null;
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
 * Parse EWA orphan well results HTML.
 *
 * Strategy (same pattern as trrc-inactive-wells.ts):
 *   1. Find each apiNo= link (identifies each result row's API).
 *   2. Walk backwards: nested sub-table → outer <td> → outer <tr>.
 *   3. Find outer </tr> using TR-depth tracking.
 *   4. Remove nested <table> blocks, map outer TDs to column positions.
 *
 * Note: orphan well table has fewer columns than inactive wells — no field name
 * column; county appears at position 5 (after well no).
 */
function parseOrphanWellHtml(html: string): TrrcOrphanWellRecord[] {
  const results: TrrcOrphanWellRecord[] = [];
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
    //   [5]  county
    //   [6]  last operator no
    //   [7]  last operator name
    //   [8]  p5 status
    //   [9]  bond amount
    //   [10] date added
    //   [11] well status
    if (vals.length < 6) continue;

    // Use makeColResolver for robust column handling
    const resolve = makeColResolver(colMap, 0, vals, 0);
    void resolve; // available for future use

    results.push({
      api8,
      district:           vals[1] ?? "",
      lease_no:           leaseNo,
      lease_name:         vals[3] || null,
      well_no:            vals[4] || null,
      county:             vals[5] || null,
      last_operator_no:   vals[6] || null,
      last_operator_name: vals[7] || null,
      p5_status:          vals[8] || null,
      bond_amount_usd:    parseNum(vals[9] ?? ""),
      date_added:         vals[10] || null,
      well_status:        vals[11] || null,
    });
  }

  return results;
}

// ─── Internal fetchers ────────────────────────────────────────────────────────

async function _fetchTrrcOrphanWellByApi(
  api10:  string,
  signal: AbortSignal,
): Promise<TrrcOrphanWellRecord[]> {
  const digits = api10.replace(/\D/g, "");
  const api8   = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.apiNoPrefixArg": api8.slice(0, 3),
    "searchArgs.apiNoSuffixArg": api8.slice(3, 8),
  });
  const res = await fetch(`${EWA_BASE}/orphanWellQueryAction.do`, {
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
  return parseOrphanWellHtml(html);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if a specific well is on the TRRC Orphan Well Program list.
 * Returns [] when the well is NOT on the orphan list (good result) or on failure.
 * Never throws.
 */
export async function fetchTrrcOrphanWellByApi(api10: string): Promise<TrrcOrphanWellRecord[]> {
  if (!api10?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcOrphanWellByApi(api10, sig), [], { timeout: 15_000 });
}
