/**
 * TRRC ICE (Inspection and Compliance Enforcement) lookup.
 *
 * Queries the TRRC PDA ICE portal for field inspection records associated
 * with a specific API number.  Returns inspection dates, compliance results,
 * operator, lease, and any defect / violation details visible in the public
 * record.
 *
 * Source: https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml
 *
 * Protocol: JSF/PrimeFaces AJAX
 *   1. GET the page to obtain a PDA JSESSIONID cookie and the
 *      javax.faces.ViewState token embedded in the form.
 *   2. POST a partial-AJAX request with the API number and ViewState.
 *   3. Parse the XML <partial-response> CDATA for the results table.
 *
 * Returns [] on failure — callers always label missing data appropriately.
 */

import { extractIceIds, withTrrcRetry } from "../underwriting/trrc-utils";

const PDA_ICE_URL = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrrcInspectionResult = "compliant" | "non_compliant" | "unknown";

export type TrrcInspectionRecord = {
  /** 10-digit API number that was searched */
  api: string;
  /** Inspection date — MM/DD/YYYY */
  inspection_date: string | null;
  /** e.g. "Oil & Gas Inspection", "Pollution", "Hydraulic Fracturing" */
  inspection_type: string | null;
  /** Compliance result from the inspection */
  result: TrrcInspectionResult;
  /** Short description of defects / violations noted, if visible */
  defect_summary: string | null;
  /** Any additional notes from the record */
  notes: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Normalize a raw API input to the 10-digit form */
function normalizeApi10(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 8) return `42${digits}`;
  if (digits.length >= 14 && digits.startsWith("42")) return digits.slice(0, 10);
  return digits.slice(0, 10).padEnd(10, "0");
}

/** Normalize to the 8-digit form (county3+well5) used by the ICE query field */
function toApi8(api10: string): string {
  const digits = api10.replace(/\D/g, "");
  if (digits.startsWith("42") && digits.length === 10) return digits.slice(2);
  if (digits.length === 8) return digits;
  return digits.slice(0, 8);
}

/** Extract javax.faces.ViewState value from HTML */
function extractViewState(html: string): string | null {
  // Hidden input: <input type="hidden" name="javax.faces.ViewState" value="...">
  const m = html.match(
    /name=["']javax\.faces\.ViewState["'][^>]*value=["']([^"']+)["']/i
  ) ?? html.match(
    /value=["']([^"']+)["'][^>]*name=["']javax\.faces\.ViewState["']/i
  );
  return m ? m[1] : null;
}

/** Extract Set-Cookie header value for JSESSIONID */
function extractSessionId(headers: Headers): string | null {
  // Headers.getSetCookie() is Node 18+; fall back to get()
  const raw =
    (typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? ((headers as unknown as { getSetCookie: () => string[] }).getSetCookie() ?? []).join("; ")
      : headers.get("set-cookie") ?? "");
  const m = raw.match(/JSESSIONID=([^;,\s]+)/i);
  return m ? m[1] : null;
}

// ── XML <partial-response> parser ─────────────────────────────────────────────

/**
 * Extract the CDATA content of a named update block from a JSF
 * <partial-response> XML string.
 *
 * <partial-response>
 *   <changes>
 *     <update id="IceQueryForm:j_idt39:inspResults"><![CDATA[...HTML...]]></update>
 *     <update id="j_id1:javax.faces.ViewState:0"><![CDATA[newViewState]]></update>
 *   </changes>
 * </partial-response>
 */
function extractPartialUpdate(xml: string, targetId: string): string | null {
  // Find the <update id="...targetId..."> block
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<update[^>]*id=["']${escaped}["'][^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</update>`,
    "i"
  );
  const m = xml.match(re);
  if (!m) return null;
  // Strip outer CDATA markers if present
  let content = m[1];
  // Some servers emit: value then ]]></update> — strip any trailing ]]>
  content = content.replace(/\]\]>?\s*$/, "").replace(/^<!\[CDATA\[/, "");
  return content.trim() || null;
}

// ── Table parser ──────────────────────────────────────────────────────────────

/**
 * Expected column order in the ICE results table (based on live inspection):
 *   0  Inspection Date
 *   1  Oil & Gas District
 *   2  Operator Name
 *   3  Operator No
 *   4  District Performing Inspection
 *   5  Complaint No
 *   6  Compliance          ← "C" = compliant, "NC" = non-compliant
 *   7  Drilling Permit No
 *   8  Lease No
 *   9  Lease/Facility Name
 *   10 Field Name
 *   11 API No
 *   12 County
 *   13 Well No
 */
const COMPLIANCE_COL   = 6;
const INSP_DATE_COL    = 0;
const OPERATOR_COL     = 2;
const COMPLAINT_COL    = 5;
const LEASE_NAME_COL   = 9;
const FIELD_NAME_COL   = 10;
const EXPECTED_COLS    = 14;

function parseIceResultsHtml(html: string, api10: string): TrrcInspectionRecord[] {
  if (!html || html.trim().length < 50) return [];

  // Quick "no results" check
  if (/no records found|0 inspections|no inspection records/i.test(html)) return [];

  const records: TrrcInspectionRecord[] = [];

  // Extract all <tr> elements (skip the header row)
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  let headerSkipped = false;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Skip header rows (contain <th> elements)
    if (/<th[^>]*>/i.test(rowHtml)) {
      headerSkipped = true;
      continue;
    }

    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    // Need at least a date column
    if (cells.length < 2) continue;

    // First cell should be a date; skip non-data rows
    const firstCell = cells[0] ?? "";
    const dateMatch = firstCell.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    if (!dateMatch) continue;

    const inspection_date = dateMatch[1];

    // Compliance — column 6 when full row is present, else scan all cells
    let result: TrrcInspectionResult = "unknown";
    const complianceCell = cells.length > COMPLIANCE_COL
      ? cells[COMPLIANCE_COL]
      : "";
    const rowText = rowHtml.toLowerCase();

    if (
      /\bnc\b/.test(complianceCell) ||
      /non.?compliant/i.test(complianceCell) ||
      /non.?compliant/i.test(rowText) ||
      /\bnc\b/.test(rowText) ||
      rowText.includes("violation") ||
      rowText.includes("deficient")
    ) {
      result = "non_compliant";
    } else if (
      /^\s*c\s*$/i.test(complianceCell) ||
      /\bcompliant\b/i.test(complianceCell) ||
      /\bcompliant\b/i.test(rowText) ||
      rowText.includes("no violations") ||
      rowText.includes("satisfactory")
    ) {
      result = "compliant";
    }

    // Operator name
    const operatorName = cells.length > OPERATOR_COL
      ? cells[OPERATOR_COL]
      : null;

    // Complaint number (non-zero means a complaint was filed)
    const complaintNo = cells.length > COMPLAINT_COL
      ? cells[COMPLAINT_COL].trim()
      : "";
    const hasComplaint = complaintNo.length > 0 && complaintNo !== "0" && complaintNo !== "N/A";

    // Lease / field name as context
    const leaseName = cells.length > LEASE_NAME_COL ? cells[LEASE_NAME_COL] : "";
    const fieldName = cells.length > FIELD_NAME_COL  ? cells[FIELD_NAME_COL]  : "";

    // Build defect_summary from complaint + any violation text in row
    const defectParts: string[] = [];
    if (hasComplaint) defectParts.push(`Complaint No: ${complaintNo}`);
    if (result === "non_compliant") {
      // Try to find specific defect text in any remaining cell
      const defectCell = cells.slice(COMPLIANCE_COL + 1).find(c =>
        c.length > 5 && !/^\d+$/.test(c)
      );
      if (defectCell) defectParts.push(defectCell.slice(0, 200));
    }
    const defect_summary = defectParts.length > 0 ? defectParts.join(" | ") : null;

    // Notes: lease + field context
    const noteParts: string[] = [];
    if (leaseName) noteParts.push(`Lease: ${leaseName}`);
    if (fieldName) noteParts.push(`Field: ${fieldName}`);
    if (operatorName) noteParts.push(`Operator: ${operatorName}`);

    records.push({
      api:            api10,
      inspection_date,
      inspection_type: "Oil & Gas Inspection",
      result,
      defect_summary,
      notes: noteParts.length > 0 ? noteParts.join(", ") : null,
    });
  }

  // Fallback: if table parsing failed entirely, scan for dates + compliance keywords
  if (records.length === 0 && headerSkipped === false) {
    const dateGlobal = /(\d{1,2}\/\d{1,2}\/\d{4})/g;
    let dm: RegExpExecArray | null;
    while ((dm = dateGlobal.exec(html)) !== null) {
      const ctx = html.slice(
        Math.max(0, dm.index - 300),
        Math.min(html.length, dm.index + 300)
      ).toLowerCase();

      let result: TrrcInspectionResult = "unknown";
      if (/\bnc\b|non.?compliant|violation|deficient/.test(ctx)) {
        result = "non_compliant";
      } else if (/\bcompliant\b|no violation|satisfactory/.test(ctx)) {
        result = "compliant";
      } else {
        continue; // Skip dates with no compliance signal at all
      }

      records.push({
        api:             api10,
        inspection_date: dm[1],
        inspection_type: null,
        result,
        defect_summary:  null,
        notes:           null,
      });
    }
  }

  return records;
}

// ── Main fetch function ───────────────────────────────────────────────────────

/**
 * Internal: performs the 2-step ICE inspection query.  Throws on transient
 * network failures so withTrrcRetry can retry; returns [] for "no data" cases.
 */
async function _fetchTrrcInspectionsByApi(
  api10: string,
  _signal: AbortSignal,
): Promise<TrrcInspectionRecord[]> {
  const api8 = toApi8(api10);

  // ── Step 1: GET the ICE page to establish a PDA session ──────────────────
  // fetch() throws TypeError on network failure → withTrrcRetry retries
  const getRes = await fetch(`${PDA_ICE_URL}?action=init`, {
    method:  "GET",
    headers: {
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Cache-Control":   "no-cache",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });

  if (!getRes.ok) return [];

  const pageHtml = await getRes.text();
  const viewState = extractViewState(pageHtml);
  if (!viewState) return [];

  // Extract live JSF component IDs — these change on every TRRC server redeploy.
  // Falls back to last-known-good defaults (j_idt39 / j_idt95) on parse failure.
  const { tabViewId, inspBtnId } = extractIceIds(pageHtml);

  const jsessionId = extractSessionId(getRes.headers);
  const cookieHeader = jsessionId ? `JSESSIONID=${jsessionId}` : "";

  // ── Step 2: POST JSF partial-AJAX search using live component IDs ────────
  const formData = new URLSearchParams();
  formData.append("javax.faces.partial.ajax",    "true");
  formData.append("javax.faces.source",          `IceQueryForm:${tabViewId}:${inspBtnId}`);
  formData.append("javax.faces.partial.execute", "IceQueryForm");
  formData.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}:inspResults`);
  formData.append(`IceQueryForm:${tabViewId}:${inspBtnId}`, `IceQueryForm:${tabViewId}:${inspBtnId}`);
  formData.append("IceQueryForm",                "IceQueryForm");
  formData.append(`IceQueryForm:${tabViewId}:qapino`, api8);
  formData.append("javax.faces.ViewState",       viewState);

  const postHeaders: Record<string, string> = {
    "Content-Type":      "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept":            "application/xml, text/xml, */*; q=0.01",
    "Faces-Request":     "partial/ajax",
    "X-Requested-With":  "XMLHttpRequest",
    "Accept-Language":   "en-US,en;q=0.9",
    "User-Agent":        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin":            "https://webapps2.rrc.texas.gov",
    "Referer":           `${PDA_ICE_URL}?action=init`,
  };
  if (cookieHeader) postHeaders["Cookie"] = cookieHeader;

  const postRes = await fetch(PDA_ICE_URL, {
    method:  "POST",
    headers: postHeaders,
    body:    formData.toString(),
    signal:  AbortSignal.timeout(12_000),
  });

  if (!postRes.ok) return [];

  const xmlBody = await postRes.text();

  // ── Step 3: Extract results HTML from <partial-response> XML ─────────────
  const resultsHtml = extractPartialUpdate(
    xmlBody,
    `IceQueryForm:${tabViewId}:inspResults`
  );
  if (!resultsHtml) return [];

  return parseIceResultsHtml(resultsHtml, api10);
}

/**
 * Fetch ICE inspection records for a specific API number from the TRRC PDA
 * portal.  Uses JSF/PrimeFaces AJAX protocol:
 *   GET  → obtain JSESSIONID + javax.faces.ViewState + live component IDs
 *   POST → AJAX search with API number using extracted IDs
 *
 * Component IDs (tabViewId, inspBtnId) are extracted dynamically from the live
 * page HTML so they remain correct after any TRRC server redeploy.
 *
 * Retries up to 2× on transient network failures with exponential backoff.
 * Returns [] when the well has no public inspection records or on any error.
 * Never throws.
 */
export async function fetchTrrcInspectionsByApi(
  api10Raw: string,
): Promise<TrrcInspectionRecord[]> {
  const api10 = normalizeApi10(api10Raw);
  return withTrrcRetry(
    signal => _fetchTrrcInspectionsByApi(api10, signal),
    [],
    // Tightened from 60s → 30s: GET(10s) + POST(12s) + margin = ~25s max per well.
    // Retries only on transient network errors, not on TRRC returning empty results.
    { timeout: 30_000, retries: 1, backoffMs: 1_500 },
  );
}

/**
 * Fetch all ICE inspection records for a lease by lease number.
 *
 * The ICE inspection tab supports `qlsno` (lease number) as a search field —
 * same pattern as `qvlsno` on the violations tab. One call returns every
 * inspection record for the entire lease regardless of which API it's tied to.
 * This replaces the per-API fan-out (up to 52 calls → 1 call).
 *
 * Returns null on transport failure (caller falls back to per-API).
 */
async function _fetchTrrcInspectionsByLease(
  leaseNo: string,
  _signal: AbortSignal,
): Promise<TrrcInspectionRecord[] | null> {
  const getRes = await fetch(`${PDA_ICE_URL}?action=init`, {
    method: "GET",
    headers: {
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Cache-Control":   "no-cache",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });

  if (!getRes.ok) return null;

  const pageHtml = await getRes.text();
  const viewState = extractViewState(pageHtml);
  if (!viewState) return null;

  const { tabViewId, inspBtnId } = extractIceIds(pageHtml);
  const jsessionId = extractSessionId(getRes.headers);
  const cookieHeader = jsessionId ? `JSESSIONID=${jsessionId}` : "";

  const formData = new URLSearchParams();
  formData.append("javax.faces.partial.ajax",    "true");
  formData.append("javax.faces.source",          `IceQueryForm:${tabViewId}:${inspBtnId}`);
  formData.append("javax.faces.partial.execute", "IceQueryForm");
  formData.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}:inspResults`);
  formData.append(`IceQueryForm:${tabViewId}:${inspBtnId}`, `IceQueryForm:${tabViewId}:${inspBtnId}`);
  formData.append("IceQueryForm",                "IceQueryForm");
  formData.append(`IceQueryForm:${tabViewId}:qapino`, "");       // intentionally empty — lease-only
  formData.append(`IceQueryForm:${tabViewId}:qlsno`,  leaseNo.slice(0, 6));
  formData.append("javax.faces.ViewState",       viewState);

  const postHeaders: Record<string, string> = {
    "Content-Type":      "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept":            "application/xml, text/xml, */*; q=0.01",
    "Faces-Request":     "partial/ajax",
    "X-Requested-With":  "XMLHttpRequest",
    "Accept-Language":   "en-US,en;q=0.9",
    "User-Agent":        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin":            "https://webapps2.rrc.texas.gov",
    "Referer":           `${PDA_ICE_URL}?action=init`,
  };
  if (cookieHeader) postHeaders["Cookie"] = cookieHeader;

  const postRes = await fetch(PDA_ICE_URL, {
    method:  "POST",
    headers: postHeaders,
    body:    formData.toString(),
    signal:  AbortSignal.timeout(12_000),
  });

  if (!postRes.ok) return null;

  const xmlBody = await postRes.text();
  const resultsHtml = extractPartialUpdate(xmlBody, `IceQueryForm:${tabViewId}:inspResults`);
  if (!resultsHtml) return null;

  // Parse results — use the leaseNo as the api placeholder since records span multiple wells
  return parseIceResultsHtml(resultsHtml, leaseNo);
}

export async function fetchTrrcInspectionsByLease(
  leaseNo: string,
): Promise<TrrcInspectionRecord[] | null> {
  return withTrrcRetry(
    signal => _fetchTrrcInspectionsByLease(leaseNo, signal),
    null,
    { timeout: 30_000, retries: 1, backoffMs: 1_500 },
  );
}

/**
 * Fetch inspection records for multiple APIs.
 *
 * Strategy:
 *   1. If leaseNo is provided, try a single lease-level ICE query first
 *      (1 call covers all wells on the lease — matches what violations does).
 *   2. Fall back to per-API queries capped at 8 APIs with 4 concurrent.
 *
 * Per-API cap prevents the old 52-well × 35s = 30-minute scenario.
 * Deduplicates results and sorts most-recent-first.
 */
export async function fetchTrrcInspectionsForApis(
  apis: string[],
  leaseNo?: string | null,
): Promise<TrrcInspectionRecord[]> {
  if (apis.length === 0) return [];

  // Strategy 1: lease-level query (single call, covers all wells)
  if (leaseNo) {
    try {
      const leaseResults = await fetchTrrcInspectionsByLease(leaseNo);
      // null = transport failure; [] = genuinely no records (stop here — don't re-query per API)
      if (leaseResults !== null) return sortInspections(leaseResults);
    } catch { /* fall through to per-API */ }
  }

  // Strategy 2: per-API fallback — uncapped, runs to completion.
  // Only fires when lease-level query fails (wrong field name, portal change, etc.).
  const CONCURRENCY = 4;
  const queue = [...apis];
  const settled: PromiseSettledResult<TrrcInspectionRecord[]>[] = [];

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(api => fetchTrrcInspectionsByApi(api))
    );
    settled.push(...batchResults);
  }

  const all: TrrcInspectionRecord[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  return sortInspections(all);
}

function sortInspections(records: TrrcInspectionRecord[]): TrrcInspectionRecord[] {
  return [...records].sort((a, b) => {
    if (!a.inspection_date && !b.inspection_date) return 0;
    if (!a.inspection_date) return 1;
    if (!b.inspection_date) return -1;
    const toSortKey = (d: string) => {
      const [mm, dd, yyyy] = d.split("/");
      return `${yyyy}/${mm}/${dd}`;
    };
    return toSortKey(b.inspection_date).localeCompare(toSortKey(a.inspection_date));
  });
}
