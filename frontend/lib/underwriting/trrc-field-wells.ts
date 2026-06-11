/**
 * TRRC Field-Level Nearby / Offset Wells (EWA)
 *
 * Source: TRRC EWA oilProQueryAction.do (field search)
 *   https://webapps2.rrc.texas.gov/EWA/oilProQueryAction.do
 *
 * Fetches all wells in the same TRRC field (by field number) from the current
 * oil proration schedule. Returns them labeled as OFFSET / NEARBY ACTIVITY
 * per the architecture rule: these are NEVER used as subject-asset production.
 *
 * Field number is obtained from a prior proration query result.
 * Query: POST oilProQueryAction.do with searchArgs.fieldNumbersArg=<fieldNo>
 *        and pager.pageSize=100 to retrieve up to 100 wells per page.
 *
 * Column mapping (same as trrc-proration.ts — confirmed live 2026):
 *   After removing nested sub-tables:
 *   [0]  blank (was API sub-table)
 *   [1]  district
 *   [2]  blank (was lease sub-table)
 *   [3]  lease name
 *   [4]  well no
 *   [5]  field no (link text)
 *   [6]  field name
 *   [7]  field type
 *   [8]  operator no
 *   [9]  operator name
 *   [10] unit no
 *   [11] potential BBL
 *   [12] GOR
 *   [13] acres
 *   [14] daily allowable
 *   [15] unit/well type
 *
 * ⚠ ARCHITECTURE RULE: All results from this module MUST be labeled
 *   "OFFSET / NEARBY ACTIVITY" in the UI. Never use as subject-asset production.
 *
 * Returns [] on failure — never throws.
 */

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcFieldWell = {
  /** 8-digit API (county3 + well5, no "42" prefix) */
  api8: string;
  district: string;
  lease_no: string;
  lease_name: string | null;
  well_no: string | null;
  field_no: string;
  field_name: string | null;
  field_type: string | null;
  operator_no: string | null;
  operator_name: string | null;
  unit_no: string | null;
  /** Potential in BBL/day. 0 for injection/shut-in/observation wells. */
  potential_bbl: number | null;
  gor: number | null;
  acres: number | null;
  /** TRRC daily allowable string, e.g. "14(B)(2) EXT 11/26" or "SHUT IN" */
  daily_allowable: string | null;
  /**
   * Well type: PRODUCER | INJECTION | SHUT IN | OBSERVATION | etc.
   * ⚠ Never use as subject-asset production — labeled OFFSET / NEARBY ACTIVITY.
   */
  well_type: string | null;
  /** True if this well is the subject asset (same API as the query) */
  is_subject_asset: boolean;
};

export type TrrcFieldWellsResult = {
  field_no: string;
  field_name: string | null;
  /**
   * ⚠ OFFSET / NEARBY ACTIVITY — not subject-asset production.
   * Sorted: producers first, then injection/shut-in, then subject asset.
   */
  wells: TrrcFieldWell[];
  total_count: number;
  /** True if the query returned ≥100 wells (may be truncated) */
  truncated: boolean;
  /** Field-level proration data extracted from the same response */
  field_info: {
    field_depth_ft: number | null;
    h2s_flag: boolean;
    max_allowable_bbl: number | null;
    allocation_formula: string | null;
    correlative_interval: string | null;
  } | null;
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
 * Parse EWA proration results HTML using the TR-depth approach.
 * Same nested-table structure as trrc-proration.ts.
 */
function parseFieldWellsHtml(html: string, fieldNo: string, subjectApi8?: string): TrrcFieldWell[] {
  const results: TrrcFieldWell[] = [];
  const seenApis = new Set<string>();

  const apiLinkPattern = /href="[^"]*apiNo=(\d{8})[^"]*"/g;
  let m: RegExpExecArray | null;

  while ((m = apiLinkPattern.exec(html)) !== null) {
    const api8 = m[1];
    if (seenApis.has(api8)) continue;
    seenApis.add(api8);

    const matchIdx = m.index;

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
    const leaseMat = rowHtml.match(/leaseNo=(\d+)/);
    const leaseNo  = leaseMat?.[1] ?? "";

    // Remove nested tables, then match outer TDs
    const cleanRow  = rowHtml.replace(/<table[\s\S]*?<\/table>/gi, "");
    const tdMatches = cleanRow.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? [];
    const vals      = tdMatches.map(td => stripHtml(td));

    if (vals.length < 12) continue;

    results.push({
      api8,
      district:        vals[1] ?? "",
      lease_no:        leaseNo,
      lease_name:      vals[3] || null,
      well_no:         vals[4] || null,
      field_no:        fieldNo,
      field_name:      vals[6] || null,
      field_type:      vals[7] || null,
      operator_no:     vals[8] || null,
      operator_name:   vals[9] || null,
      unit_no:         vals[10] || null,
      potential_bbl:   parseNum(vals[11] ?? ""),
      gor:             parseNum(vals[12] ?? ""),
      acres:           parseNum(vals[13] ?? ""),
      daily_allowable: vals[14] || null,
      well_type:       vals[15] || null,
      is_subject_asset: subjectApi8 ? api8 === subjectApi8 : false,
    });
  }

  return results;
}

/**
 * Parse the result count from EWA pagination text.
 * Looks for pattern like "10 of 49 results".
 */
function parseResultCount(html: string): number {
  const m = html.match(/(\d+)\s+of\s+(\d+)\s+results/i);
  return m ? parseInt(m[2], 10) : 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all wells in the same TRRC field as the subject well.
 *
 * ⚠ Results are OFFSET / NEARBY ACTIVITY — never use as subject-asset production.
 *
 * @param fieldNo      TRRC field number (from proration result, e.g. "66373750")
 * @param subjectApi8  8-digit API of the subject well (to flag is_subject_asset)
 *
 * Returns empty result on failure. Never throws.
 */
export async function fetchTrrcFieldWells(
  fieldNo:      string,
  subjectApi8?: string,
): Promise<TrrcFieldWellsResult> {
  const empty: TrrcFieldWellsResult = {
    field_no: fieldNo, field_name: null, wells: [], total_count: 0,
    truncated: false, field_info: null,
  };

  if (!fieldNo?.trim()) return empty;

  try {
    const params = new URLSearchParams({
      methodToCall:                       "search",
      "searchArgs.fieldNumbersArg":       fieldNo.trim(),
      "pager.pageSize":                   "100",
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

    if (!res.ok) return empty;
    const html = await res.text();

    if (/no results found/i.test(html)) return empty;

    const wells      = parseFieldWellsHtml(html, fieldNo, subjectApi8);
    const totalCount = parseResultCount(html) || wells.length;

    // Sort: producers first, then injection/shut-in, subject asset last (for easy skipping)
    const sorted = [
      ...wells.filter(w => !w.is_subject_asset && (w.well_type ?? "").toUpperCase().includes("PRODUC")),
      ...wells.filter(w => !w.is_subject_asset && !(w.well_type ?? "").toUpperCase().includes("PRODUC")),
      ...wells.filter(w => w.is_subject_asset),
    ];

    const firstName = wells[0]?.field_name ?? null;

    return {
      field_no:     fieldNo,
      field_name:   firstName,
      wells:        sorted,
      total_count:  totalCount,
      truncated:    totalCount > 100,
      field_info:   null, // populated separately by fetchTrrcFieldInfo if needed
    };
  } catch {
    return empty;
  }
}

/**
 * Convenience: fetch field wells using the field number extracted from a
 * proration record, with the subject API pre-flagged.
 *
 * Returns empty on failure. Never throws.
 */
export async function fetchTrrcOffsetWellsByField(
  api10:    string,
  fieldNo:  string,
): Promise<TrrcFieldWellsResult> {
  const digits   = api10.replace(/\D/g, "");
  const api8     = digits.startsWith("42") && digits.length === 10 ? digits.slice(2) : digits.slice(0, 8);
  return fetchTrrcFieldWells(fieldNo, api8);
}
