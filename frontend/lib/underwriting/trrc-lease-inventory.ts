/**
 * TRRC Lease-Well Inventory Fetcher
 *
 * Discovers ALL wells on a lease by querying the TRRC EWA wellbore query
 * with lease number + district code.  This is necessary because:
 *
 *   1. A user inputs ONE API number to identify the asset.
 *   2. The asset is a LEASE — which may have dozens of wells.
 *   3. Production is always reported at the lease level.
 *   4. Claiming single-well production for a multi-well lease is WRONG.
 *
 * Golden fixture requirement:
 *   Lease 60509 / District 8A → 52 wells
 *   If this returns 1 well, the implementation FAILS.
 *
 * Architecture rule:
 *   `canClaimSingleWellProduction` MUST be false unless explicit per-well
 *   allocation evidence exists (e.g. metered tank gauges, run tickets per API).
 *   This module NEVER asserts single-well production.
 */

import { detectTrrcColumns } from "./trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";
const SESSION_TIMEOUT_MS = 20_000;
const QUERY_TIMEOUT_MS   = 45_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type LeaseWellRecord = {
  /** 10-digit API (42-CCC-WWWWW) */
  api10: string;
  /** 8-digit TRRC API (county + well, no state prefix) */
  api8: string;
  /** TRRC well number within the lease */
  well_number: string | null;
  /** District code, e.g. "8A" */
  district_code: string;
  /** Lease number, e.g. "60509" */
  lease_number: string;
  /** Operator name as recorded in TRRC */
  operator_name: string | null;
  /** County name */
  county: string | null;
  /** Well type code, e.g. "OW", "GW", "OGW" */
  well_type: string | null;
  /** Well status / activity code */
  status: string | null;
};

export type LeaseWellInventoryResult = {
  district_code: string;
  lease_number: string;
  /** Total wells discovered on this lease */
  well_count: number;
  wells: LeaseWellRecord[];
  /** True if we could not retrieve the full list (TRRC session failure, etc.) */
  query_failed: boolean;
  /**
   * CRITICAL: always false unless per-well allocation evidence is available.
   * This value must propagate into every report and FinalGateDecision.
   */
  can_claim_single_well_production: false;
  /**
   * Standard lease-level attribution warning.
   * Must appear in every report when well_count > 1 OR when well_count is unknown.
   */
  lease_level_warning: string;
  /** ISO-8601 timestamp of the query */
  query_timestamp: string;
};

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw API string from TRRC HTML to a clean 10-digit form.
 * TRRC uses "CCC-WWWWW" (8-digit, no state prefix) in most contexts.
 */
function normApi(raw: string): { api10: string; api8: string } | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return { api10: `42${digits}`, api8: digits };
  if (digits.length === 10 && digits.startsWith("42")) return { api10: digits, api8: digits.slice(2) };
  if (digits.length >= 14 && digits.startsWith("42")) return { api10: digits.slice(0, 10), api8: digits.slice(2, 10) };
  return null;
}

/**
 * Parse the wellbore search result HTML into a list of well records.
 *
 * TRRC EWA wellbore search result table columns (confirmed June 2026):
 *   API No | Well Type | District | Operator | Lease Name | Lease No | County | Well No | Status
 *
 * The table has class="activeTable" or is identified by its header row.
 * Each data row has the well API as a link.
 */
function parseWellboreHtml(
  html: string,
  districtCode: string,
  leaseNumber: string,
): LeaseWellRecord[] {
  const wells: LeaseWellRecord[] = [];
  const seen = new Set<string>();

  // Strategy 1: extract all leaseDetailAction links — each represents one well
  // Pattern: href="...leaseDetailAction.do?...apiNo=CCCCCCCCCC..."
  // or href="...wellboreQueryAction.do?...apiNoPrefixArg=CCC&apiNoSuffixArg=WWWWW..."
  {
    const apiLinkRe = /href="[^"]*leaseDetailAction\.do[^"]*apiNo=(\d{8,14})[^"]*/gi;
    let m: RegExpExecArray | null;
    while ((m = apiLinkRe.exec(html)) !== null) {
      const normalized = normApi(m[1]);
      if (!normalized) continue;
      if (seen.has(normalized.api10)) continue;
      seen.add(normalized.api10);
      wells.push({
        api10: normalized.api10,
        api8: normalized.api8,
        well_number: null,
        district_code: districtCode,
        lease_number: leaseNumber,
        operator_name: null,
        county: null,
        well_type: null,
        status: null,
      });
    }
  }

  // Strategy 2: parse table rows for structured data (operator, well type, county, status)
  // Use header row detection to resolve column positions dynamically instead of
  // relying on hardcoded offsets — robust if TRRC reorders columns.
  {
    // TRRC wellbore table headers (confirmed June 2026):
    // [API No] [Well Type] [District] [Operator] [Lease Name] [Lease No] [County] [Well No] [Status]
    // Normalised: api_no, well_type, district, operator, lease_name, lease_no, county, well_no, status
    const colMap = detectTrrcColumns(html);
    // Index of "api_no" in the header row (used to compute relative offsets)
    const headerApiIdx = colMap?.["api_no"] ?? 0;

    // Default offsets relative to the API cell (used when header detection fails)
    const OFFSETS = {
      well_type: 1,
      operator:  3,
      county:    6,
      well_no:   7,
      status:    8,
    } as const;

    const rowRe    = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRe   = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const apiInCellRe = /(\d{2,3}-\d{5}|\d{8,10})/;

    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const rowHtml = rowMatch[1];
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      cellRe.lastIndex = 0;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        cells.push(
          cellMatch[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/\s+/g, " ")
            .trim(),
        );
      }
      if (cells.length < 3) continue;

      let apiCell = -1;
      let rawApi  = "";
      for (let i = 0; i < cells.length; i++) {
        const m2 = cells[i].match(apiInCellRe);
        if (m2) { apiCell = i; rawApi = m2[1]; break; }
      }
      if (apiCell === -1) continue;

      const normalized = normApi(rawApi);
      if (!normalized) continue;
      if (seen.has(normalized.api10)) continue;
      seen.add(normalized.api10);

      // Resolve each column: header-map position preferred, fallback to fixed offset
      const resolve = (colName: keyof typeof OFFSETS): string | null => {
        if (colMap) {
          const hIdx = colMap[colName === "well_no" ? "well_no" : colName];
          if (hIdx !== undefined) {
            return cells[apiCell + (hIdx - headerApiIdx)] ?? null;
          }
        }
        return cells[apiCell + OFFSETS[colName]] ?? null;
      };

      const wellType = resolve("well_type");
      const operator = resolve("operator");
      const county   = resolve("county");
      const wellNo   = resolve("well_no");
      const status   = resolve("status");

      wells.push({
        api10: normalized.api10,
        api8:  normalized.api8,
        well_number:   wellNo    && wellNo.length    < 20  ? wellNo    : null,
        district_code: districtCode,
        lease_number:  leaseNumber,
        operator_name: operator  && operator.length  < 80  ? operator  : null,
        county:        county    && county.length    < 60  ? county    : null,
        well_type:     wellType  && wellType.length  < 10  ? wellType  : null,
        status:        status    && status.length    < 30  ? status    : null,
      });
    }
  }

  return wells;
}

// ── TRRC EWA queries ──────────────────────────────────────────────────────────

/**
 * Establish a TRRC EWA session (JSESSIONID).
 * Returns null if the session cannot be established.
 */
async function initEwaSession(): Promise<string | null> {
  try {
    const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
      method: "GET",
      headers: {
        "Accept":     "text/html,application/xhtml+xml,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
      },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
    return m ? `JSESSIONID=${m[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * Query TRRC wellbore query by lease number + district code.
 * Returns the HTML response (or null on failure).
 */
async function queryWellboreByLease(
  distCode: string,
  leaseNo: string,
  sessionCookie: string | null,
): Promise<string | null> {
  const body = new URLSearchParams({
    "searchArgs.districtCodeArg": distCode,
    "searchArgs.leaseNumberArg":  leaseNo,
    "searchArgs.wellTypeArg":     "",    // all well types
    "methodToCall":               "search",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent":   "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
    "Accept":       "text/html,application/xhtml+xml,*/*;q=0.8",
  };
  if (sessionCookie) headers["Cookie"] = sessionCookie;

  try {
    const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Follow the [Next] pagination link if present in the HTML.
 * TRRC shows 10–25 wells per page for large leases.
 */
function extractNextPagePath(html: string): string | null {
  const m = html.match(/href="(\/EWA\/[^"]*pager\.[^"]*pager\.offset=\d+[^"]*)"\s*>\s*\[Next/i);
  return m ? m[1] : null;
}

async function fetchNextPage(
  path: string,
  sessionCookie: string | null,
): Promise<string | null> {
  const url = `https://webapps2.rrc.texas.gov${path}`;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
  };
  if (sessionCookie) headers["Cookie"] = sessionCookie;
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the complete well inventory for a lease from TRRC.
 *
 * Queries `wellboreQueryAction.do` with distCode + leaseNo, follows pagination,
 * and returns ALL wells found.
 *
 * For lease 60509 / District 8A, this must return ≥ 52 wells.
 * If fewer are returned, the report must note that the inventory is incomplete.
 */
export async function fetchLeaseWellInventory(
  districtCode: string,
  leaseNumber: string,
): Promise<LeaseWellInventoryResult> {
  const timestamp = new Date().toISOString();
  const normalizedDist = districtCode.toUpperCase().trim();

  const buildResult = (
    wells: LeaseWellRecord[],
    failed: boolean,
  ): LeaseWellInventoryResult => {
    const wellCount = wells.length;
    const warning = wellCount > 1
      ? `RRC production is reported at the lease level for Lease ${leaseNumber} (District ${normalizedDist}). This lease has ${wellCount} well${wellCount !== 1 ? "s" : ""}. Production figures represent aggregate lease output, not any individual well. Single-well production cannot be asserted without per-well allocation evidence (metered run tickets or pooling agreements with well-level breakdowns).`
      : wellCount === 1
        ? `RRC production is reported at the lease level for Lease ${leaseNumber} (District ${normalizedDist}). Only 1 well was returned by the inventory query — verify this is not a query truncation. Single-well production claims require per-well allocation evidence.`
        : `RRC production is reported at the lease level for Lease ${leaseNumber} (District ${normalizedDist}). Well inventory query ${failed ? "failed" : "returned no wells"}. Well count unknown. Do not assert single-well production.`;

    return {
      district_code: normalizedDist,
      lease_number: leaseNumber,
      well_count: wellCount,
      wells,
      query_failed: failed,
      can_claim_single_well_production: false,
      lease_level_warning: warning,
      query_timestamp: timestamp,
    };
  };

  // Two-request strategy — mirrors the production fetch approach:
  //   Request 1: POST to execute query → page 1 + session established
  //   Request 2: GET with pager.pageSize=500&offset=0 → ALL wells at once
  // This avoids the multi-page pagination loop that was slow on Vercel.
  const allWells: LeaseWellRecord[] = [];
  const seenApis = new Set<string>();

  const addWells = (newWells: LeaseWellRecord[]) => {
    for (const w of newWells) {
      if (!seenApis.has(w.api10)) {
        seenApis.add(w.api10);
        allWells.push(w);
      }
    }
  };

  try {
    // Request 1: POST (no session needed — TRRC bootstraps from POST)
    const session = await initEwaSession();
    const html = await queryWellboreByLease(normalizedDist, leaseNumber, session);

    if (!html || html.trim().length < 100) {
      return buildResult([], true);
    }

    addWells(parseWellboreHtml(html, normalizedDist, leaseNumber));

    // Request 2: if there is a next-page link, use pageSize=500 to get all wells at once
    const nextPath = extractNextPagePath(html);
    if (nextPath) {
      const bigPath = nextPath
        .replace(/pager\.pageSize=\d+/, "pager.pageSize=500")
        .replace(/pager\.offset=\d+/,   "pager.offset=0");
      const bigHtml = await fetchNextPage(bigPath, session);
      if (bigHtml) addWells(parseWellboreHtml(bigHtml, normalizedDist, leaseNumber));
    }

    return buildResult(allWells, false);
  } catch {
    return buildResult(allWells, true);
  }
}
