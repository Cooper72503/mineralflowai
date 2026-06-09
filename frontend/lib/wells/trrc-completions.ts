/**
 * TRRC Completions (W-2) data client.
 *
 * Two-step protocol:
 *
 *   Step 1 — EWA Drilling Permits Query (webapps2.rrc.texas.gov)
 *     POST /EWA/drillingPermitsQueryAction.do  ?apiNoHndlr.inputValue=<API8>
 *     Returns: district, lease name/number, well number, operator, county,
 *              approved date, permit number, wellbore profile, total depth.
 *     Extracts the "Completion" dropdown link → rrcActionMan token for Step 2.
 *
 *   Step 2 — CMPL Completions Query (webapps.rrc.texas.gov)
 *     GET /CMPL/ewaSearchAction.do?methodToCall=searchByApiNo&apiNo=<API8>
 *                                 &relatedLink=Y&rrcActionMan=<TOKEN>
 *     Returns: W-2 packet list — tracking no, status, packet type, submit date,
 *              operator, lease.
 *
 * Step 2 is only possible when Step 1 finds a drilling permit record.  For older
 * wells without online W-1 records, completion data is returned as packet_found=false
 * — callers flag these as "check RRC imaged records or seller files."
 *
 * Source: https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do
 *         https://webapps.rrc.texas.gov/CMPL/ewaSearchAction.do
 *
 * Returns null on failure — callers always label missing data appropriately.
 */

const EWA_BASE  = "https://webapps2.rrc.texas.gov/EWA";
const CMPL_BASE = "https://webapps.rrc.texas.gov/CMPL";
// No timeout — run until TRRC responds.

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrrcCompletionRecord = {
  /** 10-digit API number searched */
  api: string;
  /** Whether any completion packet was found in the online query */
  packet_found: boolean;
  /** W-1 spud date — not available in EWA query results; null unless parsed from document */
  spud_date: string | null;
  /** W-2 completion / submission date — "MM/DD/YYYY" from CMPL submit date */
  completion_date: string | null;
  /** Producing interval description — requires W-2 document detail; null from query */
  completion_interval: string | null;
  /** Producing formation name — requires W-2 document detail; null from query */
  formation: string | null;
  /** Total depth in feet — from EWA drilling permit permit record */
  total_depth_ft: number | null;
  /** Lift type if visible — not available in EWA/CMPL query results */
  lift_type: string | null;
  /** Operator of record at completion */
  operator: string | null;
  /** Wellbore profile — Horizontal / Vertical / Directional */
  wellbore_profile: string | null;
  /** Permit status — APPROVED / SUBMITTED / CLOSED etc. */
  permit_status: string | null;
  /** Approved date for the W-1 drilling permit */
  permit_approved_date: string | null;
  /** Drilling permit number (W-1 status number) */
  permit_number: string | null;
  /** Lease name from EWA */
  lease_name: string | null;
  /** Source reference for audit trail */
  source_url: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip HTML tags and decode common entities */
function stripHtml(s: string): string {
  return s
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<select[^>]*>[\s\S]*?<\/select>/gi, "")
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

/** Normalize a raw API input to the 10-digit form */
function normalizeApi10(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 8)  return `42${digits}`;
  if (digits.length >= 14 && digits.startsWith("42")) return digits.slice(0, 10);
  return digits.slice(0, 10).padEnd(10, "0");
}

/** Normalize to the 8-digit form (county3+well5) used by EWA queries */
function toApi8(api10: string): string {
  const digits = api10.replace(/\D/g, "");
  if (digits.startsWith("42") && digits.length === 10) return digits.slice(2);
  if (digits.length === 8) return digits;
  return digits.slice(0, 8);
}

/** Extract a number from a string like "10521" or "10,521" */
function extractNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return isNaN(n) ? null : n;
}

// ── EWA Drilling Permits parser ───────────────────────────────────────────────

type EwaPermitRecord = {
  api8: string;
  district: string | null;
  lease_name: string | null;
  well_number: string | null;
  operator: string | null;
  county: string | null;
  permit_approved_date: string | null;
  permit_number: string | null;
  wellbore_profile: string | null;
  total_depth_ft: number | null;
  permit_status: string | null;
  cmpl_url: string | null;   // Full CMPL URL with rrcActionMan token
};

/**
 * Parse the EWA drilling permits results page.
 *
 * Result row columns (in order, verified against live TRRC data):
 *   0  API No (8-digit)
 *   1  District
 *   2  Lease name (lease number)  — "NAME (leaseNo)"
 *   3  Well Number
 *   4  Permitted Operator (number) — "NAME(operatorNo)"
 *   5  County
 *   6  Status dates "Submitted: MM/DD/YYYY Approved: MM/DD/YYYY"
 *   7  Permit Number (Status Number)
 *   8  Wellbore Profile (Horizontal / Vertical / Directional)
 *   9  Filing Purpose (New Drill / Rework / etc.)
 *   10 Amend flag (N / Y)
 *   11 Total Depth (feet)
 *   12 Status (APPROVED / SUBMITTED / etc.)
 *      [13] Stacked Lateral Parent — may be absent/empty for non-SL wells
 */
function parseEwaPermitResults(html: string): EwaPermitRecord[] {
  const records: EwaPermitRecord[] = [];

  // ── Find data section (after "Page Size:" indicator) ──────────────────────
  const sectionStart = html.indexOf("Page Size:");
  if (sectionStart < 0) return [];
  const section = html.slice(sectionStart);

  // Extract all non-empty td text in the results section, cleaning scripts/selects
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const cells: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tdRe.exec(section)) !== null) {
    const clean = stripHtml(m[1]);
    cells.push(clean);
  }

  // Each data record spans 12 cells (API, District, Lease, WellNo, Operator,
  // County, StatusDate, PermitNo, Profile, FilingPurpose, TotalDepth, Status)
  // plus a skip cell (the dropdown td that becomes empty after stripping)
  // We detect the start of a new record by finding cells that look like 8-digit APIs
  const api8Re = /^\d{8}$/;

  let i = 0;
  while (i < cells.length) {
    if (!api8Re.test(cells[i])) { i++; continue; }

    const api8       = cells[i];
    const district   = cells[i + 1]?.trim() || null;
    // Lease: "LEASE NAME (leaseNo)" or "LEASE NAME"
    const leaseRaw   = cells[i + 2] ?? "";
    const leaseMatch = leaseRaw.match(/^(.*?)\s*\((\d+)\)\s*$/);
    const lease_name = leaseMatch ? leaseMatch[1].trim() : leaseRaw.trim() || null;

    const wellNo     = cells[i + 3]?.trim() || null;

    // Operator: "NAME (operatorNo)" → extract name only
    const opRaw      = cells[i + 4] ?? "";
    const opMatch    = opRaw.match(/^(.*?)\s*\(\d+\)\s*$/);
    const operator   = opMatch ? opMatch[1].trim() : opRaw.trim() || null;

    const county     = cells[i + 5]?.trim() || null;

    // Status date: "Submitted: MM/DD/YYYY Approved: MM/DD/YYYY"
    const statusDateRaw = cells[i + 6] ?? "";
    const approvedM  = statusDateRaw.match(/Approved:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const permit_approved_date = approvedM ? approvedM[1] : null;

    const permit_number  = cells[i + 7]?.trim() || null;
    const wellbore_profile = cells[i + 8]?.trim() || null;
    // i+9 = filing purpose (skip)
    // i+10 = amend flag (skip)
    const depthRaw   = cells[i + 11] ?? "";
    const total_depth_ft = depthRaw ? extractNumber(depthRaw) : null;
    const permit_status  = cells[i + 12]?.trim() || null;

    // Extract CMPL URL from the raw HTML around this API.
    // The rrcActionMan token is embedded in the dropdown option JSON value:
    //   value="{&quot;url&quot;: &quot;https://...CMPL/...&rrcActionMan=TOKEN&quot;...}"
    // The token is URL-safe base64 so we capture [A-Za-z0-9+/=_-]+ specifically.
    let cmpl_url: string | null = null;
    const apiIdx = html.indexOf(`apiNo=${api8}&`);
    if (apiIdx >= 0) {
      const region = html.slice(apiIdx, apiIdx + 3000);
      const tokenM = region.match(/rrcActionMan=([A-Za-z0-9+/=_-]+)/);
      if (tokenM) {
        cmpl_url = `${CMPL_BASE}/ewaSearchAction.do?methodToCall=searchByApiNo&apiNo=${api8}&relatedLink=Y&rrcActionMan=${tokenM[1]}`;
      }
    }

    records.push({
      api8,
      district,
      lease_name,
      well_number: wellNo,
      operator,
      county,
      permit_approved_date,
      permit_number,
      wellbore_profile,
      total_depth_ft,
      permit_status,
      cmpl_url,
    });

    i += 13; // 13 cells per record (0-12); advance past this record
  }

  return records;
}

// ── CMPL results parser ───────────────────────────────────────────────────────

type CmplPacket = {
  tracking_no: string | null;
  status: string | null;
  packet_type: string | null;
  submit_date: string | null;
  operator: string | null;
  lease_name: string | null;
};

/**
 * Parse the CMPL completions query results HTML.
 *
 * Result row columns:
 *   0  Tracking No.
 *   1  Status
 *   2  Packet Type
 *   3  API No.
 *   4  Drilling Permit No.
 *   5  Well No.
 *   6  Submit Date
 *   7  Operator No.
 *   8  Operator Name
 *   9  Lease No.
 *   10 Lease Name
 */
function parseCmplResults(html: string): CmplPacket[] {
  const packets: CmplPacket[] = [];
  if (!html || html.includes("General Exception")) return [];

  const trs = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
  for (const tr of trs) {
    const tdMatches: string[] = [];
    const tdRe2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdM: RegExpExecArray | null;
    while ((tdM = tdRe2.exec(tr)) !== null) { tdMatches.push(stripHtml(tdM[1])); }
    const tds = tdMatches;
    if (tds.length < 6) continue;

    // Expect tracking_no to look like a number
    const tracking_no = /^\d+$/.test(tds[0]) ? tds[0] : null;
    if (!tracking_no) continue;

    const submit_date = tds[6]?.match(/\d{1,2}\/\d{1,2}\/\d{4}/)?.[0] ?? null;

    packets.push({
      tracking_no,
      status:      tds[1] || null,
      packet_type: tds[2] || null,
      submit_date,
      operator:    tds[8] || null,
      lease_name:  tds[10] || null,
    });
  }

  return packets;
}

// ── Main fetch function ───────────────────────────────────────────────────────

/**
 * Fetch completion (W-2) data for a single API number.
 *
 * Step 1: Query EWA Drilling Permits for W-1 permit record (total depth,
 *         operator, lease, wellbore profile, permit dates).
 * Step 2: If a permit record exists and has a Completion link, query the CMPL
 *         system to confirm W-2 packet presence and get completion date.
 *
 * Returns a TrrcCompletionRecord with packet_found=false when no online W-2
 * data is available (common for conventional wells whose completion records
 * are only in RRC imaged / paper archives).
 *
 * Never throws.
 */
export async function fetchTrrcCompletionByApi(
  api10Raw: string,
): Promise<TrrcCompletionRecord> {
  const api10     = normalizeApi10(api10Raw);
  const api8      = toApi8(api10);
  const sourceUrl = `${EWA_BASE}/drillingPermitsQueryAction.do`;

  const notFound: TrrcCompletionRecord = {
    api:                  api10,
    packet_found:         false,
    spud_date:            null,
    completion_date:      null,
    completion_interval:  null,
    formation:            null,
    total_depth_ft:       null,
    lift_type:            null,
    operator:             null,
    wellbore_profile:     null,
    permit_status:        null,
    permit_approved_date: null,
    permit_number:        null,
    lease_name:           null,
    source_url:           sourceUrl,
  };

  try {
    // ── Step 1: EWA Drilling Permits query ────────────────────────────────
    const ewaRes = await fetch(`${EWA_BASE}/drillingPermitsQueryAction.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":        "text/html,application/xhtml+xml",
        "User-Agent":    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: new URLSearchParams({
        "methodToCall":                         "search",
        "searchArgs.apiNoHndlr.inputValue":     api8,
        "pager.offset":                         "0",
        "pager.pageSize":                       "10",
      }).toString(),
    });

    if (!ewaRes.ok) { return notFound; }

    const ewaHtml = await ewaRes.text();
    const permits = parseEwaPermitResults(ewaHtml);

    // Find the permit that matches our API
    const permit = permits.find(p => p.api8 === api8) ?? permits[0] ?? null;

    if (!permit) {
      return notFound;
    }

    // Build a base record from EWA permit data
    const baseRecord: TrrcCompletionRecord = {
      ...notFound,
      packet_found:         false, // will update if CMPL confirms W-2
      total_depth_ft:       permit.total_depth_ft,
      operator:             permit.operator,
      wellbore_profile:     permit.wellbore_profile,
      permit_status:        permit.permit_status,
      permit_approved_date: permit.permit_approved_date,
      permit_number:        permit.permit_number,
      lease_name:           permit.lease_name,
    };

    // ── Step 2: CMPL query (only if EWA gave us a CMPL URL) ───────────────
    if (!permit.cmpl_url) {
      return baseRecord;
    }

    const cmplRes = await fetch(permit.cmpl_url, {
      method: "GET",
      headers: {
        "Accept":    "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer":   `${EWA_BASE}/drillingPermitsQueryAction.do`,
      },
    });

    if (!cmplRes.ok) return baseRecord;

    const cmplHtml = await cmplRes.text();
    const packets  = parseCmplResults(cmplHtml);

    if (packets.length === 0) return baseRecord;

    // Use the most recent (last submitted) packet
    const latest = packets.reduce((best, p) => {
      if (!best.submit_date) return p;
      if (!p.submit_date) return best;
      return p.submit_date > best.submit_date ? p : best;
    });

    return {
      ...baseRecord,
      packet_found:    true,
      completion_date: latest.submit_date,
      operator:        latest.operator ?? baseRecord.operator,
      lease_name:      latest.lease_name ?? baseRecord.lease_name,
      source_url:      `${CMPL_BASE}/ewaSearchAction.do`,
    };
  } catch {
    return notFound;
  }
}

/**
 * Fetch completions for multiple APIs.
 * Runs in parallel, bounded to first 5 APIs.
 */
export async function fetchTrrcCompletionsForApis(
  apis: string[],
): Promise<TrrcCompletionRecord[]> {
  if (apis.length === 0) return [];

  const results = await Promise.allSettled(
    apis.slice(0, 5).map(api => fetchTrrcCompletionByApi(api))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TrrcCompletionRecord> => r.status === "fulfilled")
    .map(r => r.value);
}
