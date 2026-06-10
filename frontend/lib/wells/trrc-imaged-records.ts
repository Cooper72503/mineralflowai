/**
 * TRRC Imaged Records Module
 *
 * Queries the TRRC EWA document search for filed paper records associated with
 * a specific well API number.  Returns direct viewer links for each document
 * found so the analyst can open them in one click.
 *
 * Document types retrieved:
 *   W-1  — Drilling Permit (confirms permitted depth, formation, operator)
 *   W-2  — Completion Report (formation, perforations, casing, lift type)
 *   G-1  — Gas Well Initial Potential / Allowable
 *   P-4  — Plugging Record (confirms P&A status for liability assessment)
 *   W-10 — Workover Report
 *   OG-2 — Oil & Gas Well Status Report
 *
 * These are Layer 2 evidence in the three-tier hierarchy:
 *   Layer 1: TRRC structured records (production CSV, wellbore query)
 *   Layer 2: TRRC imaged records (this module)
 *   Layer 3: Seller/operator documents
 *
 * Having Layer 2 links unlocks the Offer Gate — the system can cite a specific
 * TRRC document for formation, depth, and completion data rather than relying
 * on seller-provided documents alone.
 *
 * Reference: https://webapps2.rrc.texas.gov/EWA/rrcdocsQueryAction.do
 */

import * as cheerio from "cheerio";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcDocType =
  | "W-1"    // Drilling Permit
  | "W-2"    // Completion Report
  | "G-1"    // Gas Well Initial Potential
  | "P-4"    // Plugging Record
  | "W-10"   // Workover Report
  | "OG-2"   // Well Status Report
  | "OTHER"; // Any other filed document

export type TrrcImagedRecord = {
  /** Document type code */
  doc_type: TrrcDocType;
  /** Human-readable label */
  doc_label: string;
  /** Filing date (YYYY-MM-DD or MM/DD/YYYY as returned by TRRC) */
  filing_date: string | null;
  /** Operator name at time of filing */
  operator: string | null;
  /** Direct URL to the TRRC PDF viewer for this document */
  viewer_url: string;
  /** TRRC internal document ID */
  doc_id: string | null;
};

export type TrrcImagedRecordsResult = {
  api10: string;
  /** Whether the query completed (false = technical failure) */
  query_succeeded: boolean;
  records: TrrcImagedRecord[];
  /** True if at least one W-2 (completion report) was found */
  has_completion_report: boolean;
  /** True if at least one P-4 (plugging record) was found */
  has_plugging_record: boolean;
  /** Most recent W-2 url, if any */
  latest_completion_url: string | null;
  /** Most recent P-4 url, if any */
  latest_plugging_url: string | null;
};

// ─── Doc-type classification ──────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<TrrcDocType, string> = {
  "W-1":   "Drilling Permit",
  "W-2":   "Completion Report",
  "G-1":   "Gas Well Initial Potential",
  "P-4":   "Plugging Record",
  "W-10":  "Workover Report",
  "OG-2":  "Well Status Report",
  "OTHER": "Filed Document",
};

function classifyDocType(raw: string): TrrcDocType {
  const u = raw.toUpperCase().replace(/\s+/g, "");
  if (u.includes("W-1") || u.includes("W1") || u.includes("DRILLING") || u.includes("PERMIT")) return "W-1";
  if (u.includes("W-2") || u.includes("W2") || u.includes("COMPLETION")) return "W-2";
  if (u.includes("G-1") || u.includes("G1") || u.includes("GASWELL") || u.includes("INITIAL")) return "G-1";
  if (u.includes("P-4") || u.includes("P4") || u.includes("PLUG")) return "P-4";
  if (u.includes("W-10") || u.includes("W10") || u.includes("WORKOVER")) return "W-10";
  if (u.includes("OG-2") || u.includes("OG2") || u.includes("STATUS")) return "OG-2";
  return "OTHER";
}

// ─── HTML parser ──────────────────────────────────────────────────────────────

function parseDocsHtml(html: string, api10: string): TrrcImagedRecord[] {
  const $ = cheerio.load(html);
  const records: TrrcImagedRecord[] = [];

  // TRRC document search results are in a table.  Each row has:
  //   [Doc Type] [Filing Date] [Operator] [View link]
  // The view link contains docId and docType params.

  $("table tr").each((_i, tr) => {
    const cells: string[] = [];
    $(tr).find("td").each((_j, td) => {
      cells.push($(td).text().replace(/\s+/g, " ").trim());
    });

    if (cells.length < 2) return;

    // Look for a PDF/viewer link in this row
    let viewerUrl = "";
    let docId: string | null = null;

    $(tr).find("a").each((_k, a) => {
      const href = $(a).attr("href") ?? "";
      if (
        href.includes("pdfViewer") ||
        href.includes("docViewer") ||
        href.includes("viewDoc") ||
        href.includes("docId=") ||
        href.includes(".pdf")
      ) {
        // Resolve relative URLs
        viewerUrl = href.startsWith("http") ? href : `${EWA_BASE}${href.startsWith("/") ? "" : "/"}${href}`;
        const m = href.match(/docId=([^&]+)/i);
        if (m) docId = m[1];
      }
    });

    if (!viewerUrl) return; // Not a document row

    // Identify doc type — check first cell and link text
    const linkText = $(tr).find("a").first().text().trim();
    const rawType = cells[0] || linkText || "";
    const docType = classifyDocType(rawType);

    // Dates often appear in cell 1 or 2
    const date = cells.find(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(c)) ?? null;

    // Operator typically occupies the largest non-date cell
    const operator = cells.find(c =>
      c.length > 3 &&
      !/^\d/.test(c) &&
      !c.includes("/") &&
      c !== rawType
    ) ?? null;

    records.push({
      doc_type:    docType,
      doc_label:   DOC_TYPE_LABELS[docType],
      filing_date: date,
      operator:    operator,
      viewer_url:  viewerUrl,
      doc_id:      docId,
    });
  });

  return records;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all TRRC imaged records (filed documents) for a well.
 *
 * Queries `rrcdocsQueryAction.do` with the 10-digit API split into county+well
 * components — the same decomposition used by the TRRC wellbore query.
 *
 * Never throws.  Returns query_succeeded=false on any error.
 */
export async function fetchTrrcImagedRecords(
  api10: string,
): Promise<TrrcImagedRecordsResult> {
  const EMPTY = (ok: boolean): TrrcImagedRecordsResult => ({
    api10,
    query_succeeded: ok,
    records: [],
    has_completion_report: false,
    has_plugging_record: false,
    latest_completion_url: null,
    latest_plugging_url: null,
  });

  // Validate and split the 10-digit API
  const digits = api10.replace(/[-\s]/g, "");
  if (digits.length < 10 || !digits.startsWith("42")) return EMPTY(false);

  const countyCode = digits.slice(2, 5);   // 3-digit county
  const wellNo     = digits.slice(5, 10);  // 5-digit well number

  try {
    const body = new URLSearchParams({
      "searchArgs.apiNoPrefixArg": countyCode,
      "searchArgs.apiNoSuffixArg": wellNo,
      "searchArgs.docTypeArg":     "",       // all document types
      "methodToCall":              "search",
    });

    const res = await fetch(`${EWA_BASE}/rrcdocsQueryAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
        "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      body: body.toString(),
    });

    if (!res.ok) return EMPTY(false);

    const html = await res.text();
    const records = parseDocsHtml(html, api10);

    // Sort by date descending (most recent first), then by doc type priority
    const TYPE_PRIORITY: Record<TrrcDocType, number> = {
      "W-2": 0, "W-1": 1, "G-1": 2, "P-4": 3, "W-10": 4, "OG-2": 5, "OTHER": 6,
    };
    records.sort((a, b) => {
      const dp = (TYPE_PRIORITY[a.doc_type] ?? 6) - (TYPE_PRIORITY[b.doc_type] ?? 6);
      if (dp !== 0) return dp;
      if (a.filing_date && b.filing_date) return b.filing_date.localeCompare(a.filing_date);
      return 0;
    });

    const w2s = records.filter(r => r.doc_type === "W-2");
    const p4s = records.filter(r => r.doc_type === "P-4");

    return {
      api10,
      query_succeeded: true,
      records,
      has_completion_report: w2s.length > 0,
      has_plugging_record:   p4s.length > 0,
      latest_completion_url: w2s[0]?.viewer_url ?? null,
      latest_plugging_url:   p4s[0]?.viewer_url ?? null,
    };
  } catch {
    return EMPTY(false);
  }
}

/**
 * Fetch imaged records for multiple APIs in parallel.
 * Used when a diligence run covers several wells.
 */
export async function fetchTrrcImagedRecordsMulti(
  apis: string[],
): Promise<TrrcImagedRecordsResult[]> {
  return Promise.all(apis.map(api => fetchTrrcImagedRecords(api)));
}
