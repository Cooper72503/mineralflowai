/**
 * TRRC compliance & violations lookup.
 *
 * Primary path (Strategy A) — district violation CSV download:
 *   POST /EWA/violationCSVAction.do with districtCodeArg
 *   Returns the full violation history for the district in one structured CSV.
 *   Filter locally by API number, lease number, and operator number.
 *   Same approach used by authoritative diligence tools (Manus reference).
 *
 * Fallback (Strategy B) — per-API HTML scrape:
 *   POST /EWA/violationQueryAction.do with apiNumberArg
 *   Returns paginated HTML table — fragile but catches records when CSV fails.
 *
 * Returns empty arrays on failure — callers always label missing data appropriately.
 */

import * as cheerio from "cheerio";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcViolation = {
  violation_id: string | null;
  date: string | null;
  type: string;
  description: string;
  status: "open" | "closed" | "unknown";
  penalty_usd: number | null;
  api_or_lease: string | null;
};

// ─── CSV utilities (mirrors trrc-production.ts approach) ──────────────────────

function parseCsvLines(raw: string): Record<string, string>[] {
  const lines = raw.replace(/\r/g, "").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes("|") ? "|" : ",";

  const splitLine = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === delimiter && !inQuotes) {
        fields.push(cur.trim()); cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, "_"));

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    if (cells.every(c => !c)) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    rows.push(obj);
  }
  return rows;
}

function colVal(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const key = Object.keys(row).find(k => k.includes(alias));
    if (key && row[key]) return row[key];
  }
  return "";
}

/** Normalise a raw API string to 10 digits for comparison */
function norm10(raw: string): string {
  return raw.replace(/[-\s]/g, "").replace(/^0+/, "").slice(0, 10);
}

function csvRowToViolation(row: Record<string, string>): TrrcViolation | null {
  const violId   = colVal(row, ["enforcement_number", "violation_id", "enf_no", "violation_no"]);
  const date     = colVal(row, ["violation_date", "date_of_violation", "enf_date", "date"]);
  const vType    = colVal(row, ["violation_type", "enf_type", "type"]);
  const desc     = colVal(row, ["violation_description", "description", "comments", "comment"]);
  const statusRaw = colVal(row, ["violation_status", "status", "enf_status"]).toLowerCase();
  const penaltyRaw = colVal(row, ["penalty_amount", "penalty_usd", "amount_paid", "fine_amount"]);
  const apiRaw   = colVal(row, ["api_number", "api_no", "api"]);
  const leaseRaw = colVal(row, ["lease_number", "lease_no"]);

  // Need at least a type or description to be useful
  if (!vType && !desc) return null;

  let status: "open" | "closed" | "unknown" = "unknown";
  if (statusRaw.includes("closed") || statusRaw.includes("resolved") || statusRaw.includes("compli")) status = "closed";
  else if (statusRaw.includes("open") || statusRaw.includes("active") || statusRaw.includes("pending") || statusRaw.includes("issued")) status = "open";

  let penalty_usd: number | null = null;
  if (penaltyRaw) {
    const n = parseFloat(penaltyRaw.replace(/[$,]/g, ""));
    if (isFinite(n) && n > 0) penalty_usd = n;
  }

  return {
    violation_id: violId || null,
    date: date || null,
    type: vType || "Violation",
    description: desc || vType || "See TRRC records",
    status,
    penalty_usd,
    api_or_lease: apiRaw || leaseRaw || null,
  };
}

// ─── Strategy A: District violation CSV ──────────────────────────────────────

/**
 * Download the full violation CSV for a TRRC district and filter to the
 * records matching our subject well (by API, lease number, or operator number).
 *
 * Manus downloads violations at district granularity rather than per-API so
 * that violations filed against the operator or lease — rather than the exact
 * API — are not missed.  This is especially important for operators with
 * multiple wells sharing a lease/permit.
 *
 * Returns null if the CSV endpoint is unavailable — falls through to HTML.
 */
async function fetchViolationsDistrictCsv(
  distCode: string,
  api10: string | null,
  leaseNo: string | null,
  operatorNo: string | null,
): Promise<TrrcViolation[] | null> {
  try {
    const body = new URLSearchParams({
      "methodToCall":                "search",
      "searchArgs.districtCodeArg":  distCode,
      "searchArgs.apiNumberArg":     "",       // empty = district-wide download
      "searchArgs.operatorNoArg":    "",
      "searchArgs.violationTypeArg": "",
      "searchArgs.violationStatusArg": "",
    });

    const res = await fetch(`${EWA_BASE}/violationCSVAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
        "Accept":       "text/csv,text/plain,*/*",
      },
      body: body.toString(),
    });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();

    // Reject if we got HTML back (endpoint not available or returned error page)
    if (
      contentType.includes("text/html") ||
      text.trimStart().startsWith("<!") ||
      text.trimStart().startsWith("<html") ||
      text.trimStart().startsWith("<HTML")
    ) {
      return null;
    }

    const parsed = parseCsvLines(text);
    if (parsed.length === 0) return [];

    // Filter rows to our subject well
    const api10Norm = api10 ? norm10(api10) : null;

    const matched: TrrcViolation[] = [];
    for (const row of parsed) {
      // Match by API, lease number, or operator number
      const rowApi  = norm10(colVal(row, ["api_number", "api_no", "api"]));
      const rowLease = colVal(row, ["lease_number", "lease_no"]);
      const rowOpNo  = colVal(row, ["operator_number", "operator_no", "oper_no"]);

      const apiMatch  = api10Norm && rowApi && rowApi === api10Norm;
      const leaseMatch = leaseNo && rowLease && rowLease.trim() === leaseNo.trim();
      const opMatch   = operatorNo && rowOpNo && rowOpNo.trim() === operatorNo.trim();

      if (!apiMatch && !leaseMatch && !opMatch) continue;

      const v = csvRowToViolation(row);
      if (v) matched.push(v);
    }

    return matched;
  } catch {
    return null;
  }
}

// ─── Strategy B: Per-API HTML scrape ─────────────────────────────────────────

/**
 * Look up TRRC violations for a specific API number (10-digit, no dashes).
 * Used as fallback when the district CSV is unavailable.
 */
async function fetchViolationsHtml(
  params: URLSearchParams,
): Promise<TrrcViolation[]> {
  try {
    const res = await fetch(`${EWA_BASE}/violationQueryAction.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
      },
      body: params.toString(),
    });

    if (!res.ok) return [];
    const html = await res.text();
    return parseViolationsHtml(html);
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up TRRC violations for a specific API number.
 *
 * Strategy A: Download district-level CSV and filter locally.
 *   Catches violations filed against operator or lease — not just API.
 *   Requires distCode (from production lookup) to target the correct district.
 *
 * Strategy B: Per-API HTML scrape fallback.
 *   Slower but available even when the CSV endpoint is down.
 */
export async function fetchTrrcViolations(
  api10: string,
  distCode?: string | null,
  leaseNo?: string | null,
  operatorNo?: string | null,
): Promise<TrrcViolation[]> {
  // Strategy A: district CSV (if we have a distCode)
  if (distCode) {
    const csvResult = await fetchViolationsDistrictCsv(distCode, api10, leaseNo ?? null, operatorNo ?? null);
    if (csvResult !== null) return csvResult; // null = endpoint unavailable; empty = searched, none found
  }

  // Strategy B: per-API HTML
  return fetchViolationsHtml(new URLSearchParams({
    "searchArgs.apiNumberArg":        api10,
    "searchArgs.violationTypeArg":    "",
    "searchArgs.violationStatusArg":  "",
    "pager.offset":                   "0",
    "pager.pageSize":                 "50",
  }));
}

/**
 * Look up TRRC violations by operator name (fuzzy).
 * Only use when no API number is available.
 */
export async function fetchTrrcViolationsByOperator(
  operatorName: string,
  county: string,
): Promise<TrrcViolation[]> {
  return fetchViolationsHtml(new URLSearchParams({
    "searchArgs.operatorNameArg":    operatorName,
    "searchArgs.countyNameArg":      county,
    "searchArgs.violationTypeArg":   "",
    "searchArgs.violationStatusArg": "",
    "pager.offset":                  "0",
    "pager.pageSize":                "50",
  }));
}

// ─── HTML parser ──────────────────────────────────────────────────────────────

function parseViolationsHtml(html: string): TrrcViolation[] {
  const $ = cheerio.load(html);
  const violations: TrrcViolation[] = [];

  $("table tr").each((_i, tr) => {
    const cells: string[] = [];
    $(tr).find("td").each((_j, td) => {
      cells.push($(td).text().replace(/\s+/g, " ").trim());
    });

    if (cells.length < 4) return;

    // Heuristic: first cell looks like a violation/enforcement ID
    const id = cells[0];
    if (!/^[VWvEe\d]/.test(id)) return;

    const rowHtml = $(tr).html() ?? "";
    const rowLower = rowHtml.toLowerCase();

    let status: "open" | "closed" | "unknown" = "unknown";
    if (rowLower.includes("closed") || rowLower.includes("resolved")) status = "closed";
    else if (rowLower.includes("open") || rowLower.includes("active") || rowLower.includes("pending")) status = "open";

    let penalty: number | null = null;
    for (const cell of cells) {
      const m = cell.match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (m) { penalty = parseFloat(m[1].replace(/,/g, "")); break; }
    }

    violations.push({
      violation_id: id || null,
      date: cells[1] || null,
      type: cells[2] || "Unknown",
      description: cells[3] || "See TRRC records",
      status,
      penalty_usd: penalty,
      api_or_lease: null,
    });
  });

  return violations;
}
