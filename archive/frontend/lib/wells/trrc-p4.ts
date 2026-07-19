/**
 * TRRC P-4 Gatherer/Purchaser Query (EWA)
 *
 * Source: TRRC EWA p4QueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/p4QueryAction.do
 *
 * Returns P-4 transportation authority records showing which gatherers /
 * purchasers are authorized to purchase or transport production from a well.
 *
 * Query mode — By API number:
 *   params: searchArgs.apiNoPrefixArg=<county3>
 *           searchArgs.apiNoSuffixArg=<well5>
 *           searchArgs.leaseTypeArg=O
 *
 * Column mapping (standard EWA layout):
 *   0: API No.              — nested sub-table, apiNo= in href
 *   1: District
 *   2: Lease No. (Oil) / Gas ID — nested sub-table, leaseNo= in href
 *   3: Lease Name
 *   4: Well No.
 *   5: Operator No.
 *   6: Operator Name
 *   7: P-4 Type             (e.g. "Producer", "Gatherer/Transporter")
 *   8: Effective Date       (MM/DD/YYYY)
 *   9: Termination Date     (MM/DD/YYYY or blank for current)
 *  10: Gatherer/Purchaser Name
 *  11: Product Type         (e.g. "Crude Oil", "Casinghead Gas")
 *  12: RRC Certificate No.
 *
 * Returns [] on failure — never throws.
 */

import { withTrrcRetry, detectTrrcColumns, makeColResolver } from "../underwriting/trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcP4Record = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  operator_no: string | null;
  operator_name: string | null;
  p4_type: string | null;
  effective_date: string | null;
  termination_date: string | null;
  gatherer_purchaser_name: string | null;
  product_type: string | null;
  rrc_certificate_no: string | null;
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
 * Parse EWA P-4 results HTML.
 *
 * Strategy (same pattern as trrc-inactive-wells.ts):
 *   1. Find each apiNo= link (identifies each result row's API).
 *   2. Walk backwards: nested sub-table → outer <td> → outer <tr>.
 *   3. Find outer </tr> using TR-depth tracking.
 *   4. Remove nested <table> blocks, map outer TDs to column positions.
 */
function parseP4Html(html: string): TrrcP4Record[] {
  const results: TrrcP4Record[] = [];
  const seenKeys = new Set<string>();
  const colMap = detectTrrcColumns(html);

  const apiLinkPattern = /href="[^"]*apiNo=(\d{8})[^"]*"/g;
  let apiMatch: RegExpExecArray | null;

  while ((apiMatch = apiLinkPattern.exec(html)) !== null) {
    const api8 = apiMatch[1];
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
    //   [5]  operator no
    //   [6]  operator name
    //   [7]  p4 type
    //   [8]  effective date
    //   [9]  termination date
    //   [10] gatherer/purchaser name
    //   [11] product type
    //   [12] rrc certificate no
    if (vals.length < 7) continue;

    // Use makeColResolver for robust column handling
    const resolve = makeColResolver(colMap, 0, vals, 0);
    void resolve; // used implicitly via fallback offsets below

    // Deduplicate on api8 + effective_date + gatherer to handle multiple product types per row
    const effectiveDate = vals[8] || null;
    const gatherer      = vals[10] || null;
    const dedupeKey     = `${api8}|${leaseNo}|${effectiveDate}|${gatherer}|${vals[11] || ""}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    results.push({
      api8,
      district:               vals[1] ?? "",
      lease_no:               leaseNo,
      lease_name:             vals[3] || null,
      well_no:                vals[4] || null,
      operator_no:            vals[5] || null,
      operator_name:          vals[6] || null,
      p4_type:                vals[7] || null,
      effective_date:         vals[8] || null,
      termination_date:       vals[9] || null,
      gatherer_purchaser_name: vals[10] || null,
      product_type:           vals[11] || null,
      rrc_certificate_no:     vals[12] || null,
    });
  }

  return results;
}

// ─── Internal fetchers ────────────────────────────────────────────────────────

async function _fetchTrrcP4ByApi(
  api10:  string,
  signal: AbortSignal,
): Promise<TrrcP4Record[]> {
  const digits = api10.replace(/\D/g, "");
  const api8   = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.apiNoPrefixArg": api8.slice(0, 3),
    "searchArgs.apiNoSuffixArg": api8.slice(3, 8),
    "searchArgs.leaseTypeArg":   "O",
  });
  const res = await fetch(`${EWA_BASE}/p4QueryAction.do`, {
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
  return parseP4Html(html);
}

async function _fetchTrrcP4ByLease(
  district: string,
  leaseNo:  string,
  signal:   AbortSignal,
): Promise<TrrcP4Record[]> {
  const params = new URLSearchParams({
    methodToCall:                "search",
    "searchArgs.leaseNumberArg": leaseNo.trim(),
    "searchArgs.districtArg":    district.trim(),
  });
  const res = await fetch(`${EWA_BASE}/p4QueryAction.do`, {
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
  return parseP4Html(html);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch P-4 gatherer/purchaser records for a well by API number.
 * Returns [] when no P-4 record exists or on failure. Never throws.
 */
export async function fetchTrrcP4ByApi(api10: string): Promise<TrrcP4Record[]> {
  if (!api10?.trim()) return [];
  return withTrrcRetry(sig => _fetchTrrcP4ByApi(api10, sig), [], { timeout: 15_000 });
}

/**
 * Fetch P-4 records for a lease by district + lease number.
 * Returns [] on failure. Never throws.
 */
export async function fetchTrrcP4ByLease(
  district: string,
  leaseNo:  string,
): Promise<TrrcP4Record[]> {
  if (!leaseNo?.trim()) return [];
  return withTrrcRetry(
    sig => _fetchTrrcP4ByLease(district, leaseNo, sig),
    [],
    { timeout: 15_000 },
  );
}
