/**
 * TRRC injection / SWD well data lookup.
 *
 * TRRC maintains a Disposal / Injection Well database.
 * We query the EWA wellbore query filtered to injection/SWD well types
 * to find permitted injection volumes, pressure limits, and MIT status.
 *
 * TRRC Well Types for injection: "SWD" (Salt Water Disposal), "UIC" (Underground Injection Control)
 * Query: https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do
 *
 * Returns [] on failure — never throws.
 */

import { withTrrcRetry } from "./trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export type TrrcInjectionRecord = {
  api10: string;
  well_name: string | null;
  /** Lease name extracted from the TRRC wellbore query HTML table (best-effort). */
  lease_name: string | null;
  permit_number: string | null;
  well_type: string;
  county: string | null;
  operator: string | null;
  dist_code: string | null;
  lease_no: string | null;
  injection_zone: string | null;
  depth_ft: number | null;
  permitted_max_volume_bwpd: number | null;
  permitted_max_pressure_psi: number | null;
  mit_status: string | null;
  last_mit_date: string | null;
  permit_status: string | null;
};

async function _fetchTrrcInjectionByApi(api10: string, signal: AbortSignal): Promise<TrrcInjectionRecord[]> {
  const bare = api10.replace(/[^0-9]/g, "").slice(-10);
  const prefix = bare.slice(0, 2);
  const suffix = bare.slice(2);
  const params = new URLSearchParams({
    "searchArgs.apiNoPrefixArg": prefix,
    "searchArgs.apiNoSuffixArg": suffix,
    "searchArgs.wellTypeCodeArg": "D",
    "pager.offset": "0",
    "pager.pageSize": "25",
  });
  const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0" },
    body: params.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return [];
  return parseInjectionHtml(await res.text(), api10);
}

export async function fetchTrrcInjectionByApi(api10: string): Promise<TrrcInjectionRecord[]> {
  return withTrrcRetry(sig => _fetchTrrcInjectionByApi(api10, sig), []);
}

async function _fetchTrrcInjectionByOperator(operatorName: string, county: string, signal: AbortSignal): Promise<TrrcInjectionRecord[]> {
  const params = new URLSearchParams({
    "searchArgs.operatorNameArg": operatorName,
    "searchArgs.countyNameArg": county,
    "searchArgs.wellTypeCodeArg": "D",
    "pager.offset": "0",
    "pager.pageSize": "50",
  });
  const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0" },
    body: params.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return [];
  return parseInjectionHtml(await res.text(), null);
}

/**
 * Look up SWD / injection wells by operator + county.
 */
export async function fetchTrrcInjectionByOperator(operatorName: string, county: string): Promise<TrrcInjectionRecord[]> {
  return withTrrcRetry(sig => _fetchTrrcInjectionByOperator(operatorName, county, sig), []);
}

// ─── HTML parser ──────────────────────────────────────────────────────────────

function parseInjectionHtml(html: string, targetApi: string | null): TrrcInjectionRecord[] {
  const results: TrrcInjectionRecord[] = [];

  // Extract apiNo=XXXXXXXX&distCode=XX&leaseNo=XXXXXX links (same pattern as wellbore query)
  const linkPattern = /apiNo=(\d{8})&distCode=(\w+)&leaseNo=(\d+)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = linkPattern.exec(html)) !== null) {
    const apiNo8 = m[1];
    const distCode = m[2];
    const leaseNo = m[3];
    const key = `${apiNo8}:${distCode}:${leaseNo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Reconstruct 10-digit API (TX prefix 42 + 3-digit county from apiNo8 + remaining)
    const api10 = `42${apiNo8}`;

    // If we have a target API, only include if it matches
    if (targetApi) {
      const targetBare = targetApi.replace(/[^0-9]/g, "").slice(-10);
      if (!api10.endsWith(targetBare.slice(2))) continue;
    }

    // Extract operator name from surrounding context (URL param)
    const operatorMatch = html.slice(
      Math.max(0, m.index - 300),
      m.index + 300
    ).match(/operatorName=([^&"]+)/);
    const operator = operatorMatch ? decodeURIComponent(operatorMatch[1]) : null;

    // ── Extract well_name and lease_name from adjacent table cells ────────────
    // TRRC EWA wellbore query rows have the API link in the first cell.
    // The subsequent cells (in order) are typically:
    //   [0] API No (with link — already consumed)
    //   [1] Well No / Well Name
    //   [2] Lease Name
    //   [3] Operator
    //   [4] County
    //   [5..] other fields
    // We locate the end of the <td> containing the link, then parse the next cells.
    const htmlFromMatch = html.slice(m.index, m.index + 1500);
    // Skip past the closing </td> of the cell that contains this link
    const afterFirstCell = htmlFromMatch.replace(/^[\s\S]*?<\/td>/i, "");
    const adjacentCells: string[] = [];
    const cellPat = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm: RegExpExecArray | null;
    let cellCount = 0;
    cellPat.lastIndex = 0;
    while ((cm = cellPat.exec(afterFirstCell)) !== null && cellCount < 5) {
      const raw = cm[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        .replace(/\s+/g, " ").trim();
      adjacentCells.push(raw);
      cellCount++;
    }
    // [0] = Well No / Well Name, [1] = Lease Name
    const wellName   = adjacentCells[0] ?? null;
    const leaseName  = adjacentCells[1] ?? null;

    results.push({
      api10,
      well_name:   wellName  || null,
      lease_name:  leaseName || null,
      permit_number: null,
      well_type: "SWD",
      county: null,
      operator: operator?.replace(/\+/g, " ") ?? null,
      dist_code: distCode,
      lease_no: leaseNo,
      injection_zone: null,
      depth_ft: null,
      permitted_max_volume_bwpd: null,
      permitted_max_pressure_psi: null,
      mit_status: null,
      last_mit_date: null,
      permit_status: null,
    });
  }

  return results;
}
