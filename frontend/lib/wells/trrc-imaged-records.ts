/**
 * TRRC Imaged Records Module
 *
 * Queries the TRRC Oil & Gas Completions portal (CMPL) for filed completion
 * packets associated with a specific well API number.  Returns structured
 * record data and viewer links for W-2/G-1 completion reports.
 *
 * Source: https://webapps.rrc.texas.gov/CMPL/
 *   - Data covers completion packets filed online from November 2, 2009 onward.
 *   - Pre-2009 records are only in Neubus imaged records (no real-time API).
 *
 * Secondary viewer (historical imaged docs):
 *   https://rrcsearch3.neubus.com/search-profile?profileId=17&search_fields-api_ft=<api8>
 *   - Neubus is a SPA requiring browser/JavaScript, so we provide the URL
 *     as a direct viewer link rather than attempting server-side scraping.
 *
 * Document types retrieved:
 *   W-2  — Oil Completion Report (CMPL packet type: Oil / W-2)
 *   G-1  — Gas Completion Report (CMPL packet type: Gas / G-1)
 *
 * These are Layer 2 evidence in the three-tier hierarchy:
 *   Layer 1: TRRC structured records (production CSV, wellbore query)
 *   Layer 2: TRRC imaged records (this module)
 *   Layer 3: Seller/operator documents
 *
 * Having Layer 2 records unlocks the Offer Gate — the system can cite
 * a specific TRRC document for formation, depth, and completion data.
 */

const CMPL_BASE = "https://webapps.rrc.texas.gov/CMPL";
const CMPL_HOME = `${CMPL_BASE}/publicHomeAction.do`;
const CMPL_SEARCH = `${CMPL_BASE}/publicSearchAction.do`;

// Neubus search URL pattern — works as a direct browser link (GET)
const neubusUrl = (api8: string) =>
  `https://rrcsearch3.neubus.com/search-profile?profileId=17&search_fields-api_ft=${api8}`;

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcDocType =
  | "W-1"    // Drilling Permit (EWA only; not in CMPL)
  | "W-2"    // Completion Report (Oil)
  | "G-1"    // Completion Report (Gas)
  | "P-4"    // Plugging Record (EWA only; not in CMPL)
  | "W-10"   // Workover Report (EWA only; not in CMPL)
  | "OG-2"   // Well Status Report (EWA only; not in CMPL)
  | "OTHER"; // Any other filed document

export type TrrcImagedRecord = {
  /** 10-digit API number the record is associated with */
  api10: string;
  /** Document type code */
  doc_type: TrrcDocType;
  /** Human-readable label, e.g. "Completion Report (Oil / W-2)" */
  doc_label: string;
  /** Filing / submission date (MM/DD/YYYY as returned by CMPL) */
  filing_date: string | null;
  /** Filing operator name (may include operator number in parens) */
  operator: string | null;
  /**
   * Direct URL to view this document.
   * CMPL records: Neubus search URL for this API (opens in browser).
   */
  viewer_url: string;
  /** TRRC CMPL tracking number (packet ID) */
  doc_id: string | null;
  /** Lease number associated with the packet */
  lease_no: string | null;
  /** Lease name associated with the packet */
  lease_name: string | null;
  /** CMPL packet status (Approved, Pending, etc.) */
  status: string | null;
};

export type TrrcImagedRecordsResult = {
  api10: string;
  /** Whether the query completed (false = technical failure / CMPL unreachable) */
  query_succeeded: boolean;
  records: TrrcImagedRecord[];
  /** True if at least one W-2 or G-1 (completion report) was found */
  has_completion_report: boolean;
  /** True if at least one P-4 (plugging record) was found — always false from CMPL */
  has_plugging_record: boolean;
  /** Most recent completion record URL (Neubus viewer), or null */
  latest_completion_url: string | null;
  /** Most recent plugging record URL — null (plugging not in CMPL) */
  latest_plugging_url: string | null;
  /**
   * Direct Neubus viewer link for all historical imaged records for this API.
   * Always populated when api10 is valid, regardless of CMPL result.
   */
  neubus_viewer_url: string;
  /**
   * Detail extracted from the most recent W-2 `loadPacket` response.
   * Non-null when a W-2/G-1 record was found AND the packet detail could be retrieved.
   * Provides formation name, completion type, wellbore profile, field number, etc.
   * These values upgrade evidence tier from model_estimate → trrc_imaged.
   */
  cmpl_packet_detail: CmplPacketDetail | null;
};

// ─── Doc-type classification ──────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<TrrcDocType, string> = {
  "W-1":   "Drilling Permit",
  "W-2":   "Completion Report (Oil / W-2)",
  "G-1":   "Completion Report (Gas / G-1)",
  "P-4":   "Plugging Record",
  "W-10":  "Workover Report",
  "OG-2":  "Well Status Report",
  "OTHER": "Filed Document",
};

/** Classify CMPL Packet Type → TrrcDocType */
function classifyDocType(packetType: string): TrrcDocType {
  const u = packetType.toUpperCase().replace(/\s+/g, "");
  if (u.includes("OIL") && (u.includes("W-2") || u.includes("W2"))) return "W-2";
  if (u.includes("GAS") && (u.includes("G-1") || u.includes("G1"))) return "G-1";
  if (u.includes("W-2") || u.includes("W2") || u.includes("COMPLETION")) return "W-2";
  if (u.includes("G-1") || u.includes("G1")) return "G-1";
  if (u.includes("W-1") || u.includes("W1") || u.includes("DRILLING") || u.includes("PERMIT")) return "W-1";
  if (u.includes("P-4") || u.includes("P4") || u.includes("PLUG")) return "P-4";
  if (u.includes("W-10") || u.includes("W10") || u.includes("WORKOVER")) return "W-10";
  if (u.includes("OG-2") || u.includes("OG2") || u.includes("STATUS")) return "OG-2";
  return "OTHER";
}

// ─── CMPL packet detail ────────────────────────────────────────────────────────

/**
 * Detail extracted from a CMPL `loadPacket` response.
 * Upgraded from null when we successfully POST to publicSearchAction.do
 * with the packet's tracking number.
 *
 * This upgrades formation/depth/completion-type evidence from model_estimate
 * to trrc_imaged — which can unlock the Offer Gate.
 */
export type CmplPacketDetail = {
  /** TRRC tracking number used to load this packet */
  tracking_no: string;
  /** Producing formation name (TRRC field name) */
  formation: string | null;
  /**
   * TRRC "Type Of Completion":
   *   "New Well" | "Recompletion" | "Additional Completion" | etc.
   */
  completion_type: string | null;
  /** Completion or recompletion date as listed in the packet */
  completion_date: string | null;
  /** VERTICAL | HORIZONTAL | DIRECTIONAL */
  wellbore_profile: string | null;
  /** Producing | Injection | Observation | Service */
  well_type: string | null;
  /** TRRC field number (numeric string, e.g. "66373750") */
  field_no: string | null;
  /** Drilling permit number associated with this completion */
  permit_no: string | null;
};

/**
 * Parse CMPL `loadPacket` HTML for key-value pairs.
 * The page renders a summary table with label → value pairs.
 * We use a simple pattern: label text immediately followed by its value.
 */
function parseCmplPacketDetail(html: string, trackingNo: string): CmplPacketDetail {
  // Strip tags, collapse whitespace so we can use simple regex on text content
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  // Each label is followed by its value in the same flat text.
  // Pattern: "Label Name : Value" — greedy until next known label or end.
  function pick(pattern: RegExp): string | null {
    const m = pattern.exec(text);
    return m ? m[1].trim().replace(/\s+/g, " ") || null : null;
  }

  const formation     = pick(/Field Name\s*[:\-]\s*([^:]{1,80?}?)(?:\s+(?:Type Of Completion|Completion Date|Wellbore Profile|Well Type|Field No|Drilling Permit|$))/i)
                     ?? pick(/Field Name\s*[:\-]\s*([^:\r\n]{1,80})/i);
  const completionType = pick(/Type Of Completion\s*[:\-]\s*([^:]{1,60?}?)(?:\s+(?:Field Name|Completion Date|Wellbore|Well Type|Field No|Drilling|$))/i)
                      ?? pick(/Type Of Completion\s*[:\-]\s*([^:\r\n]{1,60})/i);
  const completionDate = pick(/Completion or Recompletion Date\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)
                      ?? pick(/Completion Date\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const wellboreProfile = pick(/Wellbore Profile\s*[:\-]\s*(VERTICAL|HORIZONTAL|DIRECTIONAL|LATERAL)/i);
  const wellType       = pick(/Well Type\s*[:\-]\s*([^:]{1,50?}?)(?:\s+(?:Field|Drilling|$))/i)
                      ?? pick(/Well Type\s*[:\-]\s*([^:\r\n]{1,50})/i);
  const fieldNo        = pick(/Field No\.\s*[:\-]\s*(\d{5,12})/i);
  const permitNo       = pick(/Drilling Permit No\.\s*[:\-]\s*(\d+)/i);

  return {
    tracking_no:      trackingNo,
    formation:        formation,
    completion_type:  completionType,
    completion_date:  completionDate,
    wellbore_profile: wellboreProfile,
    well_type:        wellType,
    field_no:         fieldNo,
    permit_no:        permitNo,
  };
}

// ─── API normalization ────────────────────────────────────────────────────────

/**
 * Convert a 10-digit Texas API to the 8-digit format used by CMPL:
 * strip the "42" state prefix → county3 + well5.
 * Example: "4216537761" → "16537761"
 */
function toApi8(api10: string): string {
  const digits = api10.replace(/\D/g, "");
  if (digits.startsWith("42") && digits.length >= 10) return digits.slice(2, 10);
  if (digits.length === 8) return digits;
  return digits.slice(0, 8).padStart(8, "0");
}

/** Extract Struts anti-CSRF token from HTML */
function extractStrutsToken(html: string): string | null {
  const m = html.match(
    /name="org\.apache\.struts\.taglib\.html\.TOKEN"\s+value="([^"]+)"/i
  ) ?? html.match(
    /value="([^"]+)"\s+name="org\.apache\.struts\.taglib\.html\.TOKEN"/i
  );
  return m ? m[1] : null;
}

/** Extract JSESSIONID from Set-Cookie header */
function extractSessionId(headers: Headers): string | null {
  const raw =
    (typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? ((headers as unknown as { getSetCookie: () => string[] }).getSetCookie() ?? []).join("; ")
      : headers.get("set-cookie") ?? "");
  const m = raw.match(/JSESSIONID=([^;,\s]+)/i);
  return m ? m[1] : null;
}

// ─── CMPL table parser ────────────────────────────────────────────────────────

/**
 * Column indices in the CMPL results table (confirmed from live portal):
 *  0  Tracking No.           — CMPL packet ID (integer)
 *  1  Status                 — Approved / Pending Operator Update / Submitted / etc.
 *  2  Packet Type            — "Oil / W-2" | "Gas / G-1" | …
 *  3  API No.                — county3-well5 format, e.g. "165-37761"
 *  4  Drilling Permit No.    — DP number
 *  5  Well No.
 *  6  Submit Date            — MM/DD/YYYY
 *  7  Filing Operator        — "OPERATOR NAME (123456)"
 *  8  Lease No.
 *  9  Lease Name
 * 10  Stacked Lateral info   — optional
 * 11  SL Parent Well DP No.  — optional
 */
const CMPL_COL_TRACKING = 0;
const CMPL_COL_STATUS   = 1;
const CMPL_COL_TYPE     = 2;
const CMPL_COL_DATE     = 6;
const CMPL_COL_OPERATOR = 7;
const CMPL_COL_LEASE_NO = 8;
const CMPL_COL_LEASE_NM = 9;

function parseCmplResultsHtml(html: string, api10: string): TrrcImagedRecord[] {
  if (!html) return [];

  // Quick no-results check
  if (/No\s+'Packet'\s+records\s+found/i.test(html) || /Cmpl_1101/i.test(html)) {
    return [];
  }

  const records: TrrcImagedRecord[] = [];
  const api8 = toApi8(api10);

  // Extract data rows — first cell must be a numeric tracking number
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      // Strip HTML and normalize whitespace
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#034;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }

    if (cells.length < 8) continue;

    // First cell must be a pure integer (tracking number)
    const trackingNo = cells[CMPL_COL_TRACKING];
    if (!/^\d+$/.test(trackingNo)) continue;

    const packetType = cells[CMPL_COL_TYPE] ?? "";
    const docType    = classifyDocType(packetType);
    const status     = cells[CMPL_COL_STATUS] || null;
    const filingDate = cells[CMPL_COL_DATE]  || null;
    const operator   = cells[CMPL_COL_OPERATOR] || null;
    const leaseNo    = cells[CMPL_COL_LEASE_NO] || null;
    const leaseName  = cells[CMPL_COL_LEASE_NM] || null;

    // Viewer URL: Neubus search (works as a direct browser link)
    // CMPL packet URL also possible but requires active session:
    //   https://webapps.rrc.texas.gov/CMPL/publicSearchAction.do?packetSummaryId=<id>&formData.methodHndlr.inputValue=loadPacket
    const viewer_url = neubusUrl(api8);

    records.push({
      api10,
      doc_type:    docType,
      doc_label:   DOC_TYPE_LABELS[docType],
      filing_date: filingDate,
      operator,
      viewer_url,
      doc_id:      trackingNo,
      lease_no:    leaseNo,
      lease_name:  leaseName,
      status,
    });
  }

  return records;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch TRRC completion records for a single API number.
 *
 * Queries CMPL (webapps.rrc.texas.gov/CMPL) for filed W-2/G-1 completion
 * packets.  Covers completions filed online from November 2, 2009 onward.
 *
 * Pre-2009 completions are in the Neubus imaged records system — we cannot
 * scrape Neubus server-side (it requires JavaScript).  Instead we always
 * populate `neubus_viewer_url` so the analyst can open historical records
 * in one click.
 *
 * Never throws.  Returns query_succeeded=false on any transport error.
 */
export async function fetchTrrcImagedRecords(
  api10Raw: string,
): Promise<TrrcImagedRecordsResult> {
  const api10 = api10Raw.replace(/\D/g, "").startsWith("42")
    ? api10Raw.replace(/\D/g, "").slice(0, 10).padEnd(10, "0")
    : `42${api10Raw.replace(/\D/g, "").slice(0, 8).padStart(8, "0")}`;

  const api8 = toApi8(api10);

  const EMPTY = (ok: boolean): TrrcImagedRecordsResult => ({
    api10,
    query_succeeded: ok,
    records: [],
    has_completion_report: false,
    has_plugging_record: false,
    latest_completion_url: null,
    latest_plugging_url: null,
    neubus_viewer_url: neubusUrl(api8),
    cmpl_packet_detail: null,
  });

  try {
    // ── Step 1: GET CMPL home to obtain JSESSIONID and Struts anti-CSRF token ─
    const homeRes = await fetch(CMPL_HOME, {
      method: "GET",
      headers: {
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cache-Control":   "no-cache",
      },
      redirect: "follow",
    });

    if (!homeRes.ok) return EMPTY(false);

    const homeHtml = await homeRes.text();
    const jsessionId = extractSessionId(homeRes.headers);
    const strutsToken = extractStrutsToken(homeHtml);

    if (!jsessionId || !strutsToken) return EMPTY(false);

    // ── Step 2: GET the search form to get updated token ───────────────────────
    const searchInitRes = await fetch(
      `${CMPL_SEARCH}?formData.methodHndlr.inputValue=init&formData.headerTabSelected=home&formData.pageForwardHndlr.inputValue=home`,
      {
        method: "GET",
        headers: {
          "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Cookie":          `JSESSIONID=${jsessionId}`,
          "Referer":         CMPL_HOME,
        },
        redirect: "follow",
      }
    );

    let searchToken = strutsToken;
    if (searchInitRes.ok) {
      const searchHtml = await searchInitRes.text();
      searchToken = extractStrutsToken(searchHtml) ?? strutsToken;
    }

    // ── Step 3: POST search by 8-digit API number ──────────────────────────────
    // CMPL requires 8-digit format (county3+well5, no "42" state prefix)
    const searchBody = new URLSearchParams();
    searchBody.append("org.apache.struts.taglib.html.TOKEN", searchToken);
    searchBody.append("formData.methodHndlr.inputValue",       "search");
    searchBody.append("formData.pageForwardHndlr.inputValue",  "search");
    searchBody.append("formData.pageReturnHndlr.inputValue",   "search");
    searchBody.append("searchArgs.apiNoHndlr.inputValue",      api8);    // 8-digit

    const searchRes = await fetch(CMPL_SEARCH, {
      method: "POST",
      headers: {
        "Content-Type":    "application/x-www-form-urlencoded",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie":          `JSESSIONID=${jsessionId}`,
        "Referer":         CMPL_SEARCH,
      },
      body: searchBody.toString(),
    });

    if (!searchRes.ok) return EMPTY(false);

    const resultsHtml = await searchRes.text();
    const records = parseCmplResultsHtml(resultsHtml, api10);

    // Sort most-recent-first by filing date
    records.sort((a, b) => {
      if (!a.filing_date && !b.filing_date) return 0;
      if (!a.filing_date) return 1;
      if (!b.filing_date) return -1;
      // MM/DD/YYYY → sort by YYYY/MM/DD
      const toKey = (d: string) => {
        const [mm, dd, yyyy] = d.split("/");
        return `${yyyy ?? "0000"}/${mm ?? "00"}/${dd ?? "00"}`;
      };
      return toKey(b.filing_date).localeCompare(toKey(a.filing_date));
    });

    const completions = records.filter(r => r.doc_type === "W-2" || r.doc_type === "G-1");
    const pluggings   = records.filter(r => r.doc_type === "P-4");

    // ── Step 4: loadPacket for the most recent W-2/G-1 packet (Gap 1) ─────────
    // POST to publicSearchAction.do with loadPacket + packetSummaryId to
    // retrieve formation name, wellbore profile, completion type, field number.
    // This is the public endpoint — no auth required. Fail silently.
    let cmplPacketDetail: CmplPacketDetail | null = null;
    const mostRecentCompletion = completions[0];
    if (mostRecentCompletion?.doc_id) {
      try {
        const packetBody = new URLSearchParams();
        packetBody.append("org.apache.struts.taglib.html.TOKEN", searchToken);
        packetBody.append("formData.methodHndlr.inputValue",      "loadPacket");
        packetBody.append("packetSummaryId",                       mostRecentCompletion.doc_id);

        const packetRes = await fetch(CMPL_SEARCH, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "User-Agent":   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Cookie":       `JSESSIONID=${jsessionId}`,
            "Referer":      CMPL_SEARCH,
          },
          body: packetBody.toString(),
        });

        if (packetRes.ok) {
          const packetHtml = await packetRes.text();
          // If TRRC redirects to login, the html will contain "/security/login.do"
          if (!packetHtml.includes("/security/login.do") && packetHtml.includes("Field Name")) {
            cmplPacketDetail = parseCmplPacketDetail(packetHtml, mostRecentCompletion.doc_id);
          }
        }
      } catch {
        // loadPacket failed — not critical, main records are still returned
      }
    }

    return {
      api10,
      query_succeeded:       true,
      records,
      has_completion_report: completions.length > 0,
      has_plugging_record:   pluggings.length > 0,
      latest_completion_url: completions[0]?.viewer_url ?? neubusUrl(api8),
      latest_plugging_url:   pluggings[0]?.viewer_url   ?? null,
      neubus_viewer_url:     neubusUrl(api8),
      cmpl_packet_detail:    cmplPacketDetail,
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
  if (apis.length === 0) return [];
  return Promise.all(apis.map(api => fetchTrrcImagedRecords(api)));
}
