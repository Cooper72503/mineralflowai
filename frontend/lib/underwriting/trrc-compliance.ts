/**
 * TRRC compliance & violations lookup.
 *
 * Source: TRRC ICE (Inspection and Compliance Enforcement) portal — Violations tab
 *   https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml
 *
 * Protocol: JSF/PrimeFaces AJAX (3 steps)
 *   1. GET the ICE page → JSESSIONID cookie + javax.faces.ViewState token
 *   2. POST tabChange to activate the Violations tab (index 1, dynamic/lazy-loaded)
 *      → updated ViewState that knows tab 2 is active
 *   3. POST violations search with API number in NNN-NNNNN InputMask format
 *      → <partial-response> XML containing the violResults HTML panel
 *
 * Returns empty arrays on failure — callers always label missing data appropriately.
 *
 * NOTE: Data prior to August 1, 2015 is not available via this search engine.
 *       The full historical dataset is downloadable from:
 *       https://www.rrc.texas.gov/resource-center/inspections-and-violations/
 */

import { extractIceIds, IceIds, ICE_ID_DEFAULTS } from "./trrc-utils";

const PDA_ICE_URL = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip HTML tags and decode common entities */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize a raw API input to the 10-digit form (42 + county3 + well5) */
function normalizeApi10(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 8) return `42${digits}`;
  if (digits.length >= 14 && digits.startsWith("42")) return digits.slice(0, 10);
  return digits.slice(0, 10).padEnd(10, "0");
}

/**
 * Convert 10-digit API to the ICE InputMask format: NNN-NNNNN
 * (county-3 digits + dash + well-5 digits, stripping the "42" state prefix)
 *
 * PrimeFaces InputMask on qvapino uses mask "999\-99999"
 */
function toApiMask(api10: string): string {
  const digits = api10.replace(/\D/g, "");
  // Strip leading "42" if present and pad to 8
  const api8 = digits.startsWith("42") && digits.length === 10
    ? digits.slice(2)
    : digits.slice(0, 8).padEnd(8, "0");
  return `${api8.slice(0, 3)}-${api8.slice(3, 8)}`;
}

/** Extract javax.faces.ViewState value from HTML or XML */
function extractViewState(text: string): string | null {
  const m = text.match(
    /name=["']javax\.faces\.ViewState["'][^>]*value=["']([^"']+)["']/i
  ) ?? text.match(
    /value=["']([^"']+)["'][^>]*name=["']javax\.faces\.ViewState["']/i
  );
  // Also check update blocks in partial-response XML
  const xmlM = text.match(
    /<update[^>]*id=["'][^"']*ViewState[^"']*["'][^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i
  );
  return m ? m[1] : xmlM ? xmlM[1].trim() : null;
}

/** Extract Set-Cookie JSESSIONID from response headers */
function extractSessionId(headers: Headers): string | null {
  const raw =
    (typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? ((headers as unknown as { getSetCookie: () => string[] }).getSetCookie() ?? []).join("; ")
      : headers.get("set-cookie") ?? "");
  const m = raw.match(/JSESSIONID=([^;,\s]+)/i);
  return m ? m[1] : null;
}

/**
 * Extract the CDATA content of a named <update> block from a JSF
 * <partial-response> XML string.
 */
function extractPartialUpdate(xml: string, targetId: string): string | null {
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<update[^>]*id=["']${escaped}["'][^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</update>`,
    "i"
  );
  const m = xml.match(re);
  if (!m) return null;
  let content = m[1];
  content = content.replace(/\]\]>?\s*$/, "").replace(/^<!\[CDATA\[/, "");
  return content.trim() || null;
}

// ─── Result parser ────────────────────────────────────────────────────────────

/**
 * Violation table column order (confirmed from live ICE portal, June 2026):
 *  0  Violation Discovery Date
 *  1  Oil & Gas District
 *  2  Operator Name
 *  3  Operator No
 *  4  Lease No
 *  5  Lease/Facility Name
 *  6  API No
 *  7  County
 *  8  Well No
 *  9  Drilling Permit No
 * 10  Field Name
 * 11  Violated Rule
 * 12  Violated Rule Description
 * 13  Major Violation Indicator
 * 14  Compliant on Reinspection
 * 15  Last Enforcement Action
 * 16  Last Enforcement Action Date
 */
const VIOL_COL_DATE         = 0;
const VIOL_COL_OPERATOR     = 2;
const VIOL_COL_LEASE_NO     = 4;
const VIOL_COL_LEASE_NAME   = 5;
const VIOL_COL_API          = 6;
const VIOL_COL_RULE         = 11;
const VIOL_COL_RULE_DESC    = 12;
const VIOL_COL_MAJOR        = 13;
const VIOL_COL_COMPLIANT    = 14;
const VIOL_COL_ENF_ACTION   = 15;
const VIOL_COL_ENF_DATE     = 16;

function parseViolResultsHtml(html: string): TrrcViolation[] {
  if (!html || html.trim().length < 50) return [];
  if (/your search returned no results/i.test(html)) return [];
  if (/showing 0.0 out of 0/i.test(html)) return [];

  const violations: TrrcViolation[] = [];

  // PrimeFaces DataTable data rows have data-ri="N" attribute
  const rowRe = /<tr[^>]*data-ri="\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    if (cells.length < 4) continue;

    const date        = cells[VIOL_COL_DATE]        || null;
    const operator    = cells[VIOL_COL_OPERATOR]     || null;
    const leaseNo     = cells[VIOL_COL_LEASE_NO]     || null;
    const leaseName   = cells[VIOL_COL_LEASE_NAME]   || null;
    const apiNo       = cells[VIOL_COL_API]          || null;
    const rule        = cells[VIOL_COL_RULE]         || null;
    const ruleDesc    = cells[VIOL_COL_RULE_DESC]    || null;
    const isMajor     = cells[VIOL_COL_MAJOR]        || null;
    const compliant   = cells.length > VIOL_COL_COMPLIANT   ? cells[VIOL_COL_COMPLIANT]   : null;
    const enfAction   = cells.length > VIOL_COL_ENF_ACTION  ? cells[VIOL_COL_ENF_ACTION]  : null;
    const enfDate     = cells.length > VIOL_COL_ENF_DATE    ? cells[VIOL_COL_ENF_DATE]    : null;

    // Determine status from compliance and enforcement columns
    let status: "open" | "closed" | "unknown" = "unknown";
    const compliantLower = (compliant ?? "").toLowerCase();
    const enfLower       = (enfAction  ?? "").toLowerCase();
    if (
      compliantLower === "y" ||
      compliantLower.includes("yes") ||
      compliantLower.includes("compliant") ||
      enfLower.includes("resolved") ||
      enfLower.includes("closed") ||
      enfLower.includes("no further")
    ) {
      status = "closed";
    } else if (
      compliantLower === "n" ||
      compliantLower.includes("no") ||
      enfLower.includes("notice") ||
      enfLower.includes("order") ||
      enfLower.includes("penalty") ||
      enfLower.includes("open")
    ) {
      status = "open";
    }

    // Build description combining rule description, major indicator, enforcement
    const descParts: string[] = [];
    if (ruleDesc) descParts.push(ruleDesc);
    if (isMajor && /^y$/i.test(isMajor.trim())) descParts.push("MAJOR VIOLATION");
    if (enfAction && enfAction !== "N/A" && enfAction !== "") {
      const enfStr = enfDate ? `${enfAction} (${enfDate})` : enfAction;
      descParts.push(`Enforcement: ${enfStr}`);
    }
    const description = descParts.join(" | ") || rule || "See TRRC ICE records";

    // Build violation_id from operator + lease + date (no canonical ID in this table)
    const idParts: string[] = [];
    if (apiNo)   idParts.push(apiNo.replace(/\D/g, ""));
    if (date)    idParts.push(date.replace(/\//g, ""));
    if (rule)    idParts.push(rule.replace(/\s+/g, "").slice(0, 10));
    const violation_id = idParts.length > 0 ? idParts.join("-") : null;

    // Context note: operator + lease
    const contextParts: string[] = [];
    if (operator)  contextParts.push(operator);
    if (leaseName) contextParts.push(`Lease: ${leaseName}`);
    const context = contextParts.join(" | ") || null;
    void context; // used below via api_or_lease

    violations.push({
      violation_id,
      date,
      type:        rule || "Violation",
      description,
      status,
      penalty_usd: null, // ICE violations table doesn't surface penalty amounts directly
      api_or_lease: apiNo || leaseNo,
    });
  }

  return violations;
}

// ─── ICE session helpers ──────────────────────────────────────────────────────

interface IceSession {
  jsessionId: string;
  viewState: string;
  /** Live JSF component IDs extracted from the page; safe to use for all POSTs. */
  ids: IceIds;
}

/**
 * Step 1: GET ICE page, extract JSESSIONID, ViewState, and live JSF component IDs.
 * Component IDs (j_idt39, j_idt181, etc.) are auto-generated by PrimeFaces and
 * change on every TRRC server redeploy — always extract fresh from the GET response.
 */
async function initIceSession(): Promise<IceSession | null> {
  try {
    const res = await fetch(PDA_ICE_URL, {
      method: "GET",
      headers: {
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cache-Control":   "no-cache",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const jsessionId = extractSessionId(res.headers);
    const viewState  = extractViewState(html);
    if (!jsessionId || !viewState) return null;
    const ids = extractIceIds(html);
    return { jsessionId, viewState, ids };
  } catch {
    return null;
  }
}

/**
 * Step 2: POST tabChange to activate the Violations tab (index 1).
 * The violations tab is dynamically loaded (PrimeFaces dynamic:true),
 * so it must be activated before a violations search will be processed.
 * Uses the live tabViewId from session.ids to avoid hardcoded component IDs.
 * Returns the updated ViewState from the partial-response.
 */
async function activateViolationsTab(session: IceSession): Promise<string | null> {
  try {
    const { tabViewId } = session.ids;
    const body = new URLSearchParams();
    body.append("javax.faces.partial.ajax",    "true");
    body.append("javax.faces.source",          `IceQueryForm:${tabViewId}`);
    body.append("javax.faces.partial.execute", `IceQueryForm:${tabViewId}`);
    body.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}`);
    body.append("javax.faces.behavior.event",  "tabChange");
    body.append("javax.faces.partial.event",   "tabChange");
    body.append(`IceQueryForm:${tabViewId}_activeIndex`, "1");
    body.append("IceQueryForm", "IceQueryForm");
    body.append("javax.faces.ViewState", session.viewState);

    const res = await fetch(PDA_ICE_URL, {
      method: "POST",
      headers: {
        "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept":           "application/xml, text/xml, */*; q=0.01",
        "Faces-Request":    "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Origin":           "https://webapps2.rrc.texas.gov",
        "Referer":          PDA_ICE_URL,
        "Cookie":           `JSESSIONID=${session.jsessionId}`,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const xml = await res.text();
    return extractViewState(xml);
  } catch {
    return null;
  }
}

// ─── Core ICE violations fetch ────────────────────────────────────────────────

/**
 * Fetch TRRC violations for one API number from ICE Tab 2.
 * Uses 3-step JSF AJAX protocol.
 * Returns null on transport failure (allows caller to distinguish
 * "searched, none found" from "couldn't reach TRRC").
 */
async function fetchViolationsIce(
  api10: string,
  opts: {
    leaseNo?: string | null;
    operatorNo?: string | null;
  } = {},
): Promise<TrrcViolation[] | null> {
  try {
    // Step 1: establish session
    const session = await initIceSession();
    if (!session) return null;

    // Step 2: activate violations tab (lazy-loaded, must exist before search)
    const viewState2 = await activateViolationsTab(session);
    if (!viewState2) return null;

    // Step 3: search violations by API number using live component IDs
    const apiMask = toApiMask(api10); // NNN-NNNNN format required by InputMask
    const { tabViewId, violBtnId } = session.ids;

    const body = new URLSearchParams();
    body.append("javax.faces.partial.ajax",    "true");
    body.append("javax.faces.source",          `IceQueryForm:${tabViewId}:${violBtnId}`);
    body.append("javax.faces.partial.execute", "IceQueryForm");
    body.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}:violResults`);
    body.append(`IceQueryForm:${tabViewId}:${violBtnId}`, `IceQueryForm:${tabViewId}:${violBtnId}`);
    body.append("IceQueryForm", "IceQueryForm");
    // Search by API number (primary identifier)
    body.append(`IceQueryForm:${tabViewId}:qvapino`, apiMask);
    // Optional additional filters (empty strings = no filter)
    body.append(`IceQueryForm:${tabViewId}:qvopnm`, "");
    body.append(`IceQueryForm:${tabViewId}:qvopno`, opts.operatorNo ?? "");
    body.append(`IceQueryForm:${tabViewId}:qvcnty_input`,  "");
    body.append(`IceQueryForm:${tabViewId}:qvcnty_focus`,  "");
    body.append(`IceQueryForm:${tabViewId}:qvdis_input`,   "");
    body.append(`IceQueryForm:${tabViewId}:qvdis_focus`,   "");
    body.append(`IceQueryForm:${tabViewId}:qvlsnm`, "");
    body.append(`IceQueryForm:${tabViewId}:qvlsno`, opts.leaseNo?.slice(0, 6) ?? "");
    body.append(`IceQueryForm:${tabViewId}:qvdpno`, "");
    body.append(`IceQueryForm:${tabViewId}:qvindtf_input`, "");
    body.append(`IceQueryForm:${tabViewId}:qvindtt_input`, "");
    body.append(`IceQueryForm:${tabViewId}:qviRle_focus`,  "");
    body.append(`IceQueryForm:${tabViewId}:qviRle_input`,  "");
    body.append(`IceQueryForm:${tabViewId}_activeIndex`,   "1");
    body.append("javax.faces.ViewState", viewState2);

    const res = await fetch(PDA_ICE_URL, {
      method: "POST",
      headers: {
        "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept":           "application/xml, text/xml, */*; q=0.01",
        "Faces-Request":    "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Origin":           "https://webapps2.rrc.texas.gov",
        "Referer":          PDA_ICE_URL,
        "Cookie":           `JSESSIONID=${session.jsessionId}`,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;

    const xml = await res.text();

    // Check for JSF validation error
    const msgs = extractPartialUpdate(xml, "IceQueryForm:messages") ?? "";
    if (/minimum of one search parameter/i.test(msgs)) {
      // Shouldn't happen with a valid API, but treat as query failure
      return null;
    }

    const resultsHtml = extractPartialUpdate(xml, `IceQueryForm:${session.ids.tabViewId}:violResults`);
    if (!resultsHtml) return null;

    return parseViolResultsHtml(resultsHtml);
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up TRRC violations for a specific API number via ICE Tab 2.
 *
 * Returns [] when no violations are found (well is clean).
 * Returns [] on transport failure — callers should check diligence tier
 * separately to distinguish "no violations" from "query failed".
 *
 * Note: only covers violations from August 1, 2015 onward.
 */
export async function fetchTrrcViolations(
  api10Raw: string,
  _distCode?: string | null,   // unused (kept for API compat with callers)
  leaseNo?: string | null,
  operatorNo?: string | null,
): Promise<TrrcViolation[]> {
  const api10 = normalizeApi10(api10Raw);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchViolationsIce(api10, { leaseNo, operatorNo });
    if (result !== null) return result;
    if (attempt < 2) await new Promise<void>(r => setTimeout(r, 1_500 * Math.pow(2, attempt)));
  }
  return [];
}

/**
 * Look up ALL violations for a lease (by lease number) via ICE Tab 2.
 *
 * Leaves the API field EMPTY — querying by API AND lease simultaneously
 * returns 0 results when the API doesn't match a violation record.
 * This single call replaces 52 per-API calls and returns every violation
 * filed against the lease regardless of which API it's linked to.
 *
 * Note: only covers violations from August 1, 2015 onward.
 * The district violation file (VIOLATIONS_DIST*.txt) covers full history.
 */
async function _violationsByLease(leaseNo: string): Promise<TrrcViolation[] | null> {
  const session = await initIceSession();
  if (!session) return null;

  const viewState2 = await activateViolationsTab(session);
  if (!viewState2) return null;

  const { tabViewId, violBtnId } = session.ids;
  const body = new URLSearchParams();
  body.append("javax.faces.partial.ajax",    "true");
  body.append("javax.faces.source",          `IceQueryForm:${tabViewId}:${violBtnId}`);
  body.append("javax.faces.partial.execute", "IceQueryForm");
  body.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}:violResults`);
  body.append(`IceQueryForm:${tabViewId}:${violBtnId}`, `IceQueryForm:${tabViewId}:${violBtnId}`);
  body.append("IceQueryForm", "IceQueryForm");
  body.append(`IceQueryForm:${tabViewId}:qvapino`,       "");  // intentionally empty — lease-only search
  body.append(`IceQueryForm:${tabViewId}:qvopnm`,        "");
  body.append(`IceQueryForm:${tabViewId}:qvopno`,        "");
  body.append(`IceQueryForm:${tabViewId}:qvcnty_input`,  "");
  body.append(`IceQueryForm:${tabViewId}:qvcnty_focus`,  "");
  body.append(`IceQueryForm:${tabViewId}:qvdis_input`,   "");
  body.append(`IceQueryForm:${tabViewId}:qvdis_focus`,   "");
  body.append(`IceQueryForm:${tabViewId}:qvlsnm`,        "");
  body.append(`IceQueryForm:${tabViewId}:qvlsno`,        leaseNo.slice(0, 6));
  body.append(`IceQueryForm:${tabViewId}:qvdpno`,        "");
  body.append(`IceQueryForm:${tabViewId}:qvindtf_input`, "");
  body.append(`IceQueryForm:${tabViewId}:qvindtt_input`, "");
  body.append(`IceQueryForm:${tabViewId}:qviRle_focus`,  "");
  body.append(`IceQueryForm:${tabViewId}:qviRle_input`,  "");
  body.append(`IceQueryForm:${tabViewId}_activeIndex`,   "1");
  body.append("javax.faces.ViewState", viewState2);

  try {
    const res = await fetch(PDA_ICE_URL, {
      method: "POST",
      headers: {
        "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept":           "application/xml, text/xml, */*; q=0.01",
        "Faces-Request":    "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Origin":           "https://webapps2.rrc.texas.gov",
        "Referer":          PDA_ICE_URL,
        "Cookie":           `JSESSIONID=${session.jsessionId}`,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const xml = await res.text();
    const resultsHtml = extractPartialUpdate(xml, `IceQueryForm:${tabViewId}:violResults`);
    if (!resultsHtml) return [];
    return parseViolResultsHtml(resultsHtml);
  } catch {
    return null;
  }
}

export async function fetchTrrcViolationsByLease(
  leaseNo: string,
): Promise<TrrcViolation[]> {
  // Retry up to 2× on session / transport failure (null return = transient)
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await _violationsByLease(leaseNo);
    if (result !== null) return result;
    if (attempt < 2) await new Promise<void>(r => setTimeout(r, 1_500 * Math.pow(2, attempt)));
  }
  return [];
}

/**
 * Look up violations by operator number (no specific API).
 * Used when only an operator number is known.
 * Queries ICE Tab 2 with the operator number field.
 */
async function _violationsByOperator(operatorNo: string): Promise<TrrcViolation[] | null> {
  const session = await initIceSession();
  if (!session) return null;

  const viewState2 = await activateViolationsTab(session);
  if (!viewState2) return null;

  const { tabViewId, violBtnId } = session.ids;
  const body = new URLSearchParams();
  body.append("javax.faces.partial.ajax",    "true");
  body.append("javax.faces.source",          `IceQueryForm:${tabViewId}:${violBtnId}`);
  body.append("javax.faces.partial.execute", "IceQueryForm");
  body.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}:violResults`);
  body.append(`IceQueryForm:${tabViewId}:${violBtnId}`, `IceQueryForm:${tabViewId}:${violBtnId}`);
  body.append("IceQueryForm", "IceQueryForm");
  body.append(`IceQueryForm:${tabViewId}:qvapino`,  "");
  body.append(`IceQueryForm:${tabViewId}:qvopnm`,   "");
  body.append(`IceQueryForm:${tabViewId}:qvopno`,   operatorNo.slice(0, 6));
  body.append(`IceQueryForm:${tabViewId}:qvcnty_input`,  "");
  body.append(`IceQueryForm:${tabViewId}:qvcnty_focus`,  "");
  body.append(`IceQueryForm:${tabViewId}:qvdis_input`,   "");
  body.append(`IceQueryForm:${tabViewId}:qvdis_focus`,   "");
  body.append(`IceQueryForm:${tabViewId}:qvlsnm`, "");
  body.append(`IceQueryForm:${tabViewId}:qvlsno`, "");
  body.append(`IceQueryForm:${tabViewId}:qvdpno`, "");
  body.append(`IceQueryForm:${tabViewId}:qvindtf_input`, "");
  body.append(`IceQueryForm:${tabViewId}:qvindtt_input`, "");
  body.append(`IceQueryForm:${tabViewId}:qviRle_focus`,  "");
  body.append(`IceQueryForm:${tabViewId}:qviRle_input`,  "");
  body.append(`IceQueryForm:${tabViewId}_activeIndex`,   "1");
  body.append("javax.faces.ViewState", viewState2);

  try {
    const res = await fetch(PDA_ICE_URL, {
      method: "POST",
      headers: {
        "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept":           "application/xml, text/xml, */*; q=0.01",
        "Faces-Request":    "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Origin":           "https://webapps2.rrc.texas.gov",
        "Referer":          PDA_ICE_URL,
        "Cookie":           `JSESSIONID=${session.jsessionId}`,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const xml = await res.text();
    const resultsHtml = extractPartialUpdate(xml, `IceQueryForm:${tabViewId}:violResults`);
    if (!resultsHtml) return [];
    return parseViolResultsHtml(resultsHtml);
  } catch {
    return null;
  }
}

/**
 * Look up violations by operator number (no specific API).
 * Used when only an operator number is known.
 * Queries ICE Tab 2 with the operator number field.
 */
export async function fetchTrrcViolationsByOperator(
  operatorNo: string,
  _county?: string,            // unused (county filter not needed when op# is known)
): Promise<TrrcViolation[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await _violationsByOperator(operatorNo);
    if (result !== null) return result;
    if (attempt < 2) await new Promise<void>(r => setTimeout(r, 1_500 * Math.pow(2, attempt)));
  }
  return [];
}
