/**
 * TRRC ICE (Inspection and Compliance Enforcement) lookup.
 *
 * Queries the TRRC PDA ICE portal for field inspection records.
 * The inspection tab only supports per-API searches (qlsno is a display
 * column filter, not a search parameter — confirmed by live testing).
 *
 * Performance strategy: establish ONE session (one GET), then fan out all
 * API POSTs concurrently at concurrency 8 on the shared session.
 * 52 wells: 1×12s GET + ceil(52/8)×12s POSTs = 12 + 84 = 96s total.
 *
 * Source: https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml
 */

import { extractIceIds } from "../underwriting/trrc-utils";

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

type IceSession = {
  viewState:    string;
  tabViewId:    string;
  inspBtnId:    string;
  cookieHeader: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function normalizeApi10(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 8) return `42${digits}`;
  if (digits.length >= 14 && digits.startsWith("42")) return digits.slice(0, 10);
  return digits.slice(0, 10).padEnd(10, "0");
}

function toApi8(api10: string): string {
  const digits = api10.replace(/\D/g, "");
  if (digits.startsWith("42") && digits.length === 10) return digits.slice(2);
  if (digits.length === 8) return digits;
  return digits.slice(0, 8);
}

function extractViewState(html: string): string | null {
  const m = html.match(
    /name=["']javax\.faces\.ViewState["'][^>]*value=["']([^"']+)["']/i
  ) ?? html.match(
    /value=["']([^"']+)["'][^>]*name=["']javax\.faces\.ViewState["']/i
  );
  return m ? m[1] : null;
}

function extractSessionId(headers: Headers): string | null {
  const raw =
    (typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? ((headers as unknown as { getSetCookie: () => string[] }).getSetCookie() ?? []).join("; ")
      : headers.get("set-cookie") ?? "");
  const m = raw.match(/JSESSIONID=([^;,\s]+)/i);
  return m ? m[1] : null;
}

// ── XML parser ────────────────────────────────────────────────────────────────

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

// ── Table parser ──────────────────────────────────────────────────────────────

const COMPLIANCE_COL  = 6;
const OPERATOR_COL    = 2;
const COMPLAINT_COL   = 5;
const LEASE_NAME_COL  = 9;
const FIELD_NAME_COL  = 10;

function parseIceResultsHtml(html: string, api10: string): TrrcInspectionRecord[] {
  if (!html || html.trim().length < 50) return [];
  if (/no records found|0 inspections|no inspection records|Your search returned no results/i.test(html)) return [];

  const records: TrrcInspectionRecord[] = [];
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  let headerSkipped = false;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (/<th[^>]*>/i.test(rowHtml)) { headerSkipped = true; continue; }

    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    if (cells.length < 2) continue;
    const dateMatch = (cells[0] ?? "").match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    if (!dateMatch) continue;

    const inspection_date = dateMatch[1];
    let result: TrrcInspectionResult = "unknown";
    const complianceCell = cells.length > COMPLIANCE_COL ? cells[COMPLIANCE_COL] : "";
    const rowText = rowHtml.toLowerCase();

    if (
      /\bnc\b/.test(complianceCell) || /non.?compliant/i.test(complianceCell) ||
      /non.?compliant/i.test(rowText) || /\bnc\b/.test(rowText) ||
      rowText.includes("violation") || rowText.includes("deficient")
    ) {
      result = "non_compliant";
    } else if (
      /^\s*c\s*$/i.test(complianceCell) || /\bcompliant\b/i.test(complianceCell) ||
      /\bcompliant\b/i.test(rowText) || rowText.includes("no violations") ||
      rowText.includes("satisfactory")
    ) {
      result = "compliant";
    }

    const operatorName = cells.length > OPERATOR_COL ? cells[OPERATOR_COL] : null;
    const complaintNo  = cells.length > COMPLAINT_COL ? cells[COMPLAINT_COL].trim() : "";
    const hasComplaint = complaintNo.length > 0 && complaintNo !== "0" && complaintNo !== "N/A";
    const leaseName    = cells.length > LEASE_NAME_COL ? cells[LEASE_NAME_COL] : "";
    const fieldName    = cells.length > FIELD_NAME_COL  ? cells[FIELD_NAME_COL]  : "";

    const defectParts: string[] = [];
    if (hasComplaint) defectParts.push(`Complaint No: ${complaintNo}`);
    if (result === "non_compliant") {
      const defectCell = cells.slice(COMPLIANCE_COL + 1).find(c => c.length > 5 && !/^\d+$/.test(c));
      if (defectCell) defectParts.push(defectCell.slice(0, 200));
    }

    const noteParts: string[] = [];
    if (leaseName)    noteParts.push(`Lease: ${leaseName}`);
    if (fieldName)    noteParts.push(`Field: ${fieldName}`);
    if (operatorName) noteParts.push(`Operator: ${operatorName}`);

    records.push({
      api: api10,
      inspection_date,
      inspection_type: "Oil & Gas Inspection",
      result,
      defect_summary: defectParts.length > 0 ? defectParts.join(" | ") : null,
      notes: noteParts.length > 0 ? noteParts.join(", ") : null,
    });
  }

  if (records.length === 0 && !headerSkipped) {
    const dateGlobal = /(\d{1,2}\/\d{1,2}\/\d{4})/g;
    let dm: RegExpExecArray | null;
    while ((dm = dateGlobal.exec(html)) !== null) {
      const ctx = html.slice(Math.max(0, dm.index - 300), Math.min(html.length, dm.index + 300)).toLowerCase();
      let result: TrrcInspectionResult = "unknown";
      if (/\bnc\b|non.?compliant|violation|deficient/.test(ctx)) result = "non_compliant";
      else if (/\bcompliant\b|no violation|satisfactory/.test(ctx)) result = "compliant";
      else continue;
      records.push({ api: api10, inspection_date: dm[1], inspection_type: null, result, defect_summary: null, notes: null });
    }
  }

  return records;
}

function sortInspections(records: TrrcInspectionRecord[]): TrrcInspectionRecord[] {
  return [...records].sort((a, b) => {
    if (!a.inspection_date && !b.inspection_date) return 0;
    if (!a.inspection_date) return 1;
    if (!b.inspection_date) return -1;
    const toKey = (d: string) => { const [mm, dd, yyyy] = d.split("/"); return `${yyyy}/${mm}/${dd}`; };
    return toKey(b.inspection_date).localeCompare(toKey(a.inspection_date));
  });
}

// ── Session + POST ────────────────────────────────────────────────────────────

/**
 * Establish one ICE session (single GET).  All subsequent API queries reuse
 * this session, eliminating the N×GET overhead that caused the timeout.
 */
async function initInspectionSession(): Promise<IceSession | null> {
  try {
    const res = await fetch(`${PDA_ICE_URL}?action=init`, {
      method:  "GET",
      headers: {
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cache-Control":   "no-cache",
      },
      redirect: "follow",
      signal:   AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const html      = await res.text();
    const viewState = extractViewState(html);
    if (!viewState) return null;
    const { tabViewId, inspBtnId } = extractIceIds(html);
    const jsessionId = extractSessionId(res.headers);
    return { viewState, tabViewId, inspBtnId, cookieHeader: jsessionId ? `JSESSIONID=${jsessionId}` : "" };
  } catch {
    return null;
  }
}

/**
 * POST a single API query using a pre-established session.
 * Returns [] on any failure — never throws.
 */
async function postInspectionByApi(api10: string, session: IceSession): Promise<TrrcInspectionRecord[]> {
  const { viewState, tabViewId, inspBtnId, cookieHeader } = session;
  const api8 = toApi8(api10);

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

  try {
    const res = await fetch(PDA_ICE_URL, {
      method:  "POST",
      headers: postHeaders,
      body:    formData.toString(),
      signal:  AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const xml         = await res.text();
    const resultsHtml = extractPartialUpdate(xml, `IceQueryForm:${tabViewId}:inspResults`);
    if (!resultsHtml) return [];
    return parseIceResultsHtml(resultsHtml, api10);
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Single-well lookup (used by non-streaming route). */
export async function fetchTrrcInspectionsByApi(api10Raw: string): Promise<TrrcInspectionRecord[]> {
  const session = await initInspectionSession();
  if (!session) return [];
  return postInspectionByApi(normalizeApi10(api10Raw), session);
}

/**
 * Fetch inspection records for all APIs on a lease.
 *
 * One GET establishes a shared session; all API POSTs run on that session
 * at concurrency 8.  For 52 wells: 12s + 7×12s = 96s total (vs. 286s before).
 *
 * The _leaseNo parameter is accepted but unused — the ICE inspection tab has
 * no lease-level search field (qlsno is a display filter, not a search input,
 * confirmed by live testing returning 0 results for known leases).
 */
export async function fetchTrrcInspectionsForApis(
  apis: string[],
  _leaseNo?: string | null,
): Promise<TrrcInspectionRecord[]> {
  if (apis.length === 0) return [];

  const session = await initInspectionSession();
  if (!session) return [];

  const CONCURRENCY = 8;
  const queue   = apis.map(normalizeApi10);
  const all: TrrcInspectionRecord[] = [];

  while (queue.length > 0) {
    const batch   = queue.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(batch.map(api => postInspectionByApi(api, session)));
    for (const r of results) {
      if (r.status === "fulfilled") all.push(...r.value);
    }
  }

  return sortInspections(all);
}
