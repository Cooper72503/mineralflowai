/**
 * Production data loading for analog wells — resolves each analog's API
 * number to its lease number + district (TRRC production is LEASE-level,
 * not well-level — see index.ts's Phase 0 notes), then fetches monthly
 * production for that lease.
 *
 * This intentionally duplicates the session/table-parsing logic already
 * proven correct in worker/src/tools/ewa.ts's searchWellbore and
 * getProduction (including this session's own fix for the O/G lease-type
 * column-mapping bug). It is NOT a careless copy-paste: the frontend
 * (where this report-generation code runs, inside a Next.js API route)
 * and the worker (a separate Vultr process with no HTTP server — see
 * index.ts) have no synchronous call path between them, so there is no
 * way to invoke the worker's already-correct implementation directly from
 * here. If a real shared-library boundary is ever introduced between the
 * two runtimes, this function should be deleted and worker's should be
 * imported instead — until then, both copies must be kept in sync if
 * TRRC's real page structure changes, exactly like the caveat already on
 * getGisLocation and other GIS fetchers that exist in both places for the
 * same structural reason.
 */

import * as cheerio from "cheerio";
import type { WarningEntry } from "./types";
import { withDefaultTimeout, DEFAULT_CONFIG } from "./constants";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function formBody(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

// Real, previously-invisible bug, confirmed live 2026-08-10: every caller of
// resolveWellboreToLease (offset-analytics/service.ts's analog selection AND
// geology/production.ts's offset-well enrichment) passes the API in the
// 8-digit TRRC "county+well" form — that's what well-search.ts's
// ArcGisWellSearchProvider reads straight off the ArcGIS "API" attribute
// (confirmed live: {"API":"16502733", "GIS_API5":"02733", ...}), and it's
// the only form any real caller in this codebase has ever had for an
// OFFSET well (as opposed to the subject well, which sometimes carries a
// full state-prefixed API from resolved_primary_api). The original
// implementation only accepted ≥10 digits and unconditionally sliced off
// a 2-digit state prefix — for every real 8-digit call this silently
// returned null on the very first line, before a single fetch was ever
// attempted. That's a hard, structural failure, not a network hiccup: it
// looks identical to a clean "no data" result, so it went undetected
// through every unit test in this file (which use directly-fabricated
// LeaseIdentity values, never the real 8-digit-in/parsed-out path) and
// silently zeroed out comparable-well production analysis — one of the
// most concrete, numeric parts of both engines' output — for every run,
// since this function was written.
function splitApi(api: string): { prefix: string; suffix: string } | null {
  const d = api.replace(/\D/g, "");
  if (d.length === 8) return { prefix: d.slice(0, 3), suffix: d.slice(3, 8) };
  if (d.length >= 10) return { prefix: d.slice(2, 5), suffix: d.slice(5, 10) };
  return null;
}

export interface LeaseIdentity {
  leaseNumber: string;
  district: string;
  /** Real column in wellboreQueryAction.do's response table (confirmed live 2026-08-04: "Field Name", e.g. "O D C (DEVONIAN)") — captured here so formation-normalization.ts (Phase 7) has real field-name data for ANALOG wells too, not just the subject well. Null if the row structure didn't match (never fabricated). */
  fieldName: string | null;
  /** Real column 6 (0-based) in the same response table — "Operator Name", confirmed live in the same 10-column layout documented on searchLeaseWells's doc comment (API/District/Lease No./Lease Name/Well No./Field Name/Operator Name/County/On Schedule/API Depth). Added for the Geological Due Diligence Engine's operator-concentration analysis (geology/activity.ts) — additive, existing callers that only read leaseNumber/district/fieldName are unaffected. Null if the row has fewer than 7 cells (older/shorter table layouts). */
  operatorName: string | null;
}

/** Resolves an API number to its lease number + district (+ field name) via wellboreQueryAction.do — ported from worker/src/tools/ewa.ts's searchWellbore. */
export async function resolveWellboreToLease(apiNumber: string, signal?: AbortSignal): Promise<LeaseIdentity | null> {
  const split = splitApi(apiNumber);
  if (!split) return null;
  const effectiveSignal = withDefaultTimeout(signal, DEFAULT_CONFIG.providerTimeoutMs);

  const url = `${EWA_BASE}/wellboreQueryAction.do`;
  const sessionRes = await fetch(url, { headers: BROWSER_HEADERS, signal: effectiveSignal });
  const jSessionMatch = sessionRes.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
  const jSession = jSessionMatch?.[1] ?? null;
  const postUrl = jSession ? `${url};jsessionid=${jSession}` : url;

  const res = await fetch(postUrl, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded", ...(jSession ? { Cookie: `JSESSIONID=${jSession}` } : {}) },
    body: formBody({
      "searchArgs.apiNoPrefixArg": split.prefix,
      "searchArgs.apiNoSuffixArg": split.suffix,
      "searchArgs.scheduleTypeArg": "Both",
      methodToCall: "search",
    }),
    signal: effectiveSignal,
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (/no results found/i.test(html)) return null;

  // The lease-detail link carries clean, unambiguous identifiers in its
  // query string — more reliable than the cell text, which can be wrapped
  // in nested per-cell action-link tables (the same issue this session's
  // wellbore-parsing fix addressed in the worker).
  const $ = cheerio.load(html);
  const link = $("a[href*='leaseDetailAction.do']").first().attr("href") ?? "";
  const leaseMatch = link.match(/[?&]leaseNo=(\d+)/);
  const distMatch = link.match(/[?&]distCode=([\dA-Za-z]+)/);
  if (!leaseMatch || !distMatch) return null;

  // Field Name is a real table cell (column index 5: API/District/Lease
  // No./Lease Name/Well No./Field Name/...), confirmed live 2026-08-04 —
  // find the first data row with enough direct-child <td>s to plausibly be
  // this table, not the header/toolbar rows.
  let fieldName: string | null = null;
  let operatorName: string | null = null;
  $("table").each((_, table) => {
    if (fieldName !== null) return;
    $(table).find("> tbody > tr, > tr").each((__, tr) => {
      if (fieldName !== null) return;
      const cells = $(tr).find("> td").map((___, td) => $(td).text().trim().replace(/\s+/g, " ")).get();
      if (cells.length >= 6 && /^\d{7,8}\b/.test(cells[0])) {
        fieldName = cells[5] || null;
        operatorName = cells.length >= 7 ? (cells[6] || null) : null;
      }
    });
  });

  return { leaseNumber: leaseMatch[1], district: distMatch[1], fieldName, operatorName };
}

export interface AnalogProductionRow {
  productionMonth: string; // "YYYY-MM"
  oilBbl: number | null;
  gasMcf: number | null;
  casingheadGasMcf: number | null;
  condensateBbl: number | null;
}

export interface AnalogProductionResult {
  found: boolean;
  rows: AnalogProductionRow[];
  scope: "LEASE"; // TRRC production is always lease-level — never claim WELL scope without a documented allocation method (see non-negotiable principle #7)
  allocationMethod: "NONE_LEASE_LEVEL_ONLY"; // no per-well allocation is performed or claimed
  leaseNumber: string;
  district: string;
  warnings: WarningEntry[];
}

const MONTH_NUM: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function parseNum(v: string): number | null {
  if (!v || v === "NO RPT" || v === "-") return null;
  const n = parseFloat(v.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

/** Fetches monthly production for a lease via specificLeaseQueryAction.do — ported from worker/src/tools/ewa.ts's getProduction, including this session's O/G lease-type column-mapping fix (see ewa.ts's own doc comment on that bug for the live-verified column layout). */
export async function fetchAnalogProduction(leaseNumber: string, district: string, signal?: AbortSignal): Promise<AnalogProductionResult> {
  const warnings: WarningEntry[] = [];
  const effectiveSignal = withDefaultTimeout(signal, DEFAULT_CONFIG.providerTimeoutMs);

  const tryType = async (lt: "O" | "G"): Promise<AnalogProductionRow[] | null> => {
    const url = `${EWA_BASE}/specificLeaseQueryAction.do`;
    const sessionRes = await fetch(url, { headers: BROWSER_HEADERS, signal: effectiveSignal });
    const jSessionMatch = sessionRes.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
    const jSession = jSessionMatch?.[1] ?? null;
    const postUrl = jSession ? `${url};jsessionid=${jSession}` : url;

    const now = new Date();
    const endYear = String(now.getUTCFullYear());
    const endMonth = String(now.getUTCMonth() + 1).padStart(2, "0");
    const startDate = new Date(Date.UTC(now.getUTCFullYear() - 4, now.getUTCMonth(), 1));

    const res = await fetch(postUrl, {
      method: "POST",
      headers: { ...BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded", ...(jSession ? { Cookie: `JSESSIONID=${jSession}` } : {}) },
      body: formBody({
        viewType: "init", searchType: "specificLease", "searchArgs.searchType": "specificLease",
        "searchArgs.activeTabsFlagwordHndlr.inputValue": "0",
        "searchArgs.orderByHndlr.inputValue": "",
        methodToCall: "search",
        "actionManager.recordCountHndlr.inputValue": "1",
        "actionManager.currentIndexHndlr.inputValue": "0",
        "actionManager.actionRcrd[0].actionDisplayNmHndlr.inputValue": "Search Criteria",
        "actionManager.actionRcrd[0].hostHndlr.inputValue": "webapps2.rrc.texas.gov:443",
        "actionManager.actionRcrd[0].contextPathHndlr.inputValue": "/EWA",
        "actionManager.actionRcrd[0].actionHndlr.inputValue": "/specificLeaseQueryAction.do",
        "actionManager.actionRcrd[0].actionParameterHndlr.inputValue": "methodToCall",
        "actionManager.actionRcrd[0].actionMethodHndlr.inputValue": "unspecified",
        "actionManager.actionRcrd[0].pagerParameterKeyHndlr.inputValue": "",
        "actionManager.actionRcrd[0].actionParametersHndlr.inputValue": "",
        "actionManager.actionRcrd[0].returnIndexHndlr.inputValue": "0",
        "actionManager.actionRcrd[0].argRcrdParameters(searchArgs.paramValue)": `|3=${endYear}|5=${endYear}|10=0`,
        "searchArgs.oilOrGasArg": lt,
        "searchArgs.leaseNumberArg": leaseNumber,
        "searchArgs.districtCodeArg": district,
        "searchArgs.startMonthArg": String(startDate.getUTCMonth() + 1).padStart(2, "0"),
        "searchArgs.startYearArg": String(startDate.getUTCFullYear()),
        "searchArgs.endMonthArg": endMonth,
        "searchArgs.endYearArg": endYear,
        "pager.pageSize": "-1",
      }),
      signal: effectiveSignal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (/no results found/i.test(html)) return [];

    const $ = cheerio.load(html);
    const table = $("table.DataGrid").first();
    if (!table.length) return null;

    const rows: AnalogProductionRow[] = [];
    table.find("tr").each((_, tr) => {
      const cells = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
      if (cells.length < 5) return;
      const dateMatch = cells[0].match(/^([A-Za-z]{3})\s+(\d{4})$/);
      if (!dateMatch) return;
      const monthNum = MONTH_NUM[dateMatch[1]];
      if (!monthNum) return;
      rows.push(lt === "G" ? {
        productionMonth: `${dateMatch[2]}-${monthNum}`, oilBbl: null, gasMcf: parseNum(cells[1]), casingheadGasMcf: null, condensateBbl: parseNum(cells[3]),
      } : {
        productionMonth: `${dateMatch[2]}-${monthNum}`, oilBbl: parseNum(cells[1]), gasMcf: null, casingheadGasMcf: parseNum(cells[3]), condensateBbl: null,
      });
    });
    return rows;
  };

  for (const lt of ["O", "G"] as const) {
    const rows = await tryType(lt).catch(() => null);
    if (rows === null) {
      warnings.push({ code: "PRODUCTION_FETCH_FAILED", message: `Could not parse ${lt}-type production response for lease ${leaseNumber} district ${district}`, severity: "warning" });
      continue;
    }
    if (rows.length > 0) {
      return { found: true, rows, scope: "LEASE", allocationMethod: "NONE_LEASE_LEVEL_ONLY", leaseNumber, district, warnings };
    }
  }

  warnings.push({ code: "NO_PRODUCTION_FOUND", message: `No production history found for lease ${leaseNumber} district ${district} (oil or gas)`, severity: "info" });
  return { found: false, rows: [], scope: "LEASE", allocationMethod: "NONE_LEASE_LEVEL_ONLY", leaseNumber, district, warnings };
}

/** Detects real production anomalies — missing months, negative volumes, duplicated months — without silently "fixing" them. Returns warnings only; the caller decides whether to still use the data. */
export function detectProductionAnomalies(rows: AnalogProductionRow[]): WarningEntry[] {
  const warnings: WarningEntry[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const row of rows) {
    if (seen.has(row.productionMonth)) duplicateCount++;
    seen.add(row.productionMonth);
    if ((row.oilBbl !== null && row.oilBbl < 0) || (row.gasMcf !== null && row.gasMcf < 0)) {
      warnings.push({ code: "NEGATIVE_PRODUCTION_VOLUME", message: `Negative production volume reported for ${row.productionMonth}`, severity: "critical" });
    }
  }
  if (duplicateCount > 0) {
    warnings.push({ code: "DUPLICATE_PRODUCTION_MONTHS", message: `${duplicateCount} duplicated production month(s) in the retrieved history`, severity: "warning" });
  }

  if (rows.length >= 2) {
    const sorted = [...rows].sort((a, b) => a.productionMonth.localeCompare(b.productionMonth));
    const first = new Date(`${sorted[0].productionMonth}-01`);
    const last = new Date(`${sorted[sorted.length - 1].productionMonth}-01`);
    const expectedMonths = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + (last.getUTCMonth() - first.getUTCMonth()) + 1;
    if (expectedMonths > sorted.length) {
      warnings.push({ code: "MISSING_MONTHS_IN_HISTORY", message: `${expectedMonths - sorted.length} month(s) missing from the reported date range (${sorted[0].productionMonth} to ${sorted[sorted.length - 1].productionMonth})`, severity: "warning" });
    }
  }

  return warnings;
}
