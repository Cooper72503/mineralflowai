/**
 * TRRC District Violation File Downloader
 *
 * Downloads the official district-level violation export files published by the
 * Texas Railroad Commission at:
 *   https://www.rrc.texas.gov/resource-center/inspections-and-violations/
 *
 * These files are the AUTHORITATIVE source for all historical violations.
 * The ICE web portal only covers violations from August 1, 2015 onward;
 * the district download files contain the FULL historical record.
 *
 * Critical rule (per Manus implementation spec):
 *   If the district file download FAILS, compliance status MUST be returned
 *   as download_failed, NOT as "clean." A failed download is NOT the same as
 *   no violations. The report must reflect this ambiguity.
 *
 * Golden fixture:
 *   Lease 60509 / District 8A → 39 matching violation records
 *   URL: https://mft.rrc.texas.gov/link/c7c28dc9-b218-4f0a-8278-bf15d009def1
 */

import crypto from "crypto";
import type { TrrcViolation } from "./trrc-compliance";
import { withTrrcRetry } from "./trrc-utils";

// ── District violation file URL registry ──────────────────────────────────────
//
// TRRC publishes all district violation files in a SINGLE public MFT share.
// The share contains: VIOLATIONS.txt (statewide, 67 MB) + VIOLATIONS_DIST<XX>.txt
// for every district. Files are updated weekly.
//
// Share URL confirmed working as of June 2026:
//   https://mft.rrc.texas.gov/link/c7c28dc9-b218-4f0a-8278-bf15d009def1
//
// Because all districts live in the same share, every district maps to the same URL.
// The per-district file is selected by filename (VIOLATIONS_DIST8A.txt, etc.).
const MFT_SHARE_URL = "https://mft.rrc.texas.gov/link/c7c28dc9-b218-4f0a-8278-bf15d009def1";

const DISTRICT_VIOLATION_URLS: Record<string, string> = {
  // All Texas RRC Oil & Gas Districts — same share, different filenames
  "01":  MFT_SHARE_URL, "1":   MFT_SHARE_URL,
  "02":  MFT_SHARE_URL, "2":   MFT_SHARE_URL,
  "03":  MFT_SHARE_URL, "3":   MFT_SHARE_URL,
  "04":  MFT_SHARE_URL, "4":   MFT_SHARE_URL,
  "05":  MFT_SHARE_URL, "5":   MFT_SHARE_URL,
  "06":  MFT_SHARE_URL, "6":   MFT_SHARE_URL,
  "7B":  MFT_SHARE_URL,
  "7C":  MFT_SHARE_URL,
  "08":  MFT_SHARE_URL, "8":   MFT_SHARE_URL,
  "8A":  MFT_SHARE_URL,
  "09":  MFT_SHARE_URL, "9":   MFT_SHARE_URL,
  "10":  MFT_SHARE_URL,
};

// Fallback: scrape the TRRC resource page to discover all district file URLs
const TRRC_VIOLATIONS_RESOURCE_URL =
  "https://www.rrc.texas.gov/resource-center/inspections-and-violations/";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DistrictViolationDownloadStatus =
  | "success"          // file downloaded and parsed successfully
  | "download_failed"  // HTTP error or network failure — NOT clean compliance
  | "parse_error"      // file downloaded but could not be parsed
  | "no_url_for_district"; // district not in registry and scrape failed

export type DistrictViolationResult = {
  status: DistrictViolationDownloadStatus;
  district: string;
  source_url: string | null;
  /** SHA-256 hex of the raw download — proves file was retrieved */
  raw_sha256: string | null;
  /** Total rows in the full district file (before filtering) */
  total_rows_in_file: number;
  /** Rows matching the subject lease/API/operator */
  matching_violations: TrrcViolation[];
  /** How many records matched */
  match_count: number;
  /**
   * CRITICAL: true only when the download succeeded AND we positively confirmed
   * zero violations matching the subject asset. False if download failed.
   */
  confirmed_clean: boolean;
  /** Human-readable evidence note for the report */
  evidence_note: string;
  query_timestamp: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip non-digits from an API string for comparison */
function apiDigits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Normalize operator name for fuzzy comparison */
function normalizeOp(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
}

/**
 * Auto-detect delimiter for TRRC violation files.
 *
 * The live VIOLATIONS_DIST*.txt files use '}' (right curly brace) as delimiter.
 * Older or alternative exports may use '|', tab, or comma.
 * We count occurrences of each candidate in the header row and pick the winner.
 */
function detectDelimiter(firstLine: string): string {
  const braces = (firstLine.match(/\}/g) ?? []).length;
  const pipes  = (firstLine.match(/\|/g) ?? []).length;
  const commas = (firstLine.match(/,/g)  ?? []).length;
  const tabs   = (firstLine.match(/\t/g) ?? []).length;
  const max = Math.max(braces, pipes, commas, tabs);
  if (max === 0) return ",";
  if (braces === max) return "}";
  if (pipes  === max) return "|";
  if (tabs   === max) return "\t";
  return ",";
}

/**
 * Split a delimited line respecting double-quoted fields.
 */
function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === delimiter && !inQ) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

/**
 * Parse raw TRRC district violation file text into rows.
 * Handles pipe, comma, or tab delimiters.
 * Returns { headers, rows } where rows is one object per data line.
 */
/**
 * Parse a district violation file and filter to matching rows in a single pass.
 *
 * District files run 3+ MB with tens of thousands of rows, but a subject lease
 * typically matches a handful. Materializing every row into a Record<string,string>
 * array before filtering (the previous approach) held the entire district's parsed
 * rows in memory at once — on top of everything else running concurrently in the
 * pull_inspections step, this was a likely contributor to the function instance
 * being OOM-killed by Vercel mid-run. Filtering inline lets each row object become
 * garbage immediately after the match check instead of all being retained together.
 */
function parseAndFilterDistrictFile(
  raw: string,
  isMatch: (row: Record<string, string>) => boolean,
): { totalRows: number; matching: TrrcViolation[] } {
  const lines = raw.replace(/\r/g, "").split("\n");
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 2) return { totalRows: 0, matching: [] };

  const delimiter = detectDelimiter(nonEmpty[0]);
  const headers   = splitLine(nonEmpty[0], delimiter)
    .map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_"));

  let totalRows = 0;
  const matching: TrrcViolation[] = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const cells = splitLine(nonEmpty[i], delimiter);
    if (cells.every(c => !c)) continue;
    totalRows++;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    if (isMatch(obj)) matching.push(rowToViolation(obj));
  }
  return { totalRows, matching };
}

/**
 * Find column value from a parsed row by trying multiple aliases.
 * TRRC columns vary slightly between file versions — we try the most
 * common aliases and return the first match.
 */
function col(row: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const key = Object.keys(row).find(k => k.includes(alias));
    if (key && row[key] !== undefined) return (row[key] ?? "").trim();
  }
  return "";
}

/**
 * Convert a parsed district file row into a TrrcViolation.
 */
function rowToViolation(row: Record<string, string>): TrrcViolation {
  // Column names in live VIOLATIONS_DIST*.txt (delimited by '}'):
  //   OPERATOR_NAME, P5_OPERATOR_NO, DISTRICT, OIL_LEASE_GAS_WELL_ID,
  //   LEASE_FAC_NAME, API_NO, COUNTY, WELL_NO, DRILLING_PERMIT_NO, FIELD_NAME,
  //   VIOLATED_RULE, VIOLATED_RULE_DESC, MAJOR_VIOL_IND, COMPLIANT_ON_REINSP,
  //   LAST_ENF_ACTION, LAST_ENF_ACTION_DATE, VIOLATION_DISC_DATE
  const date        = col(row, ["violation_disc_date", "violation_discovery_date", "discovery_date", "viol_date", "disc_date", "date"]);
  const operator    = col(row, ["operator_name", "oper_name", "operator"]);
  const leaseNo     = col(row, ["oil_lease_gas_well_id", "lease_no", "lease_number", "lsno", "lease_gas_well_id", "well_id"]);
  const leaseName   = col(row, ["lease_fac_name", "lease_facility_name", "lease_name", "lsnm"]);
  const apiNo       = col(row, ["api_no", "api_number", "api"]);
  const rule        = col(row, ["violated_rule", "viol_rule", "rule"]);
  const ruleDesc    = col(row, ["violated_rule_desc", "violated_rule_description", "rule_description", "viol_rule_desc", "description"]);
  const isMajor     = col(row, ["major_viol_ind", "major_violation_indicator", "major_viol", "major"]);
  const compliant   = col(row, ["compliant_on_reinsp", "compliant_on_reinspection", "compliant_reinsp", "compliant"]);
  const enfAction   = col(row, ["last_enf_action", "last_enforcement_action", "enforcement_action", "enf_action"]);
  const enfDate     = col(row, ["last_enf_action_date", "last_enforcement_action_date", "enforcement_date", "enf_date"]);

  let status: "open" | "closed" | "unknown" = "unknown";
  const cl = compliant.toLowerCase();
  const ea = enfAction.toLowerCase();
  if (cl === "y" || cl.includes("yes") || ea.includes("closed") || ea.includes("resolved")) {
    status = "closed";
  } else if (cl === "n" || cl.includes("no") || ea.includes("notice") || ea.includes("order") || ea.includes("penalty")) {
    status = "open";
  }

  const descParts: string[] = [];
  if (ruleDesc) descParts.push(ruleDesc);
  if (/^y$/i.test(isMajor.trim())) descParts.push("MAJOR VIOLATION");
  if (enfAction && enfAction !== "N/A") {
    descParts.push(enfDate ? `${enfAction} (${enfDate})` : enfAction);
  }
  const description = descParts.join(" | ") || rule || "See district violation file";

  const idParts: string[] = [];
  if (apiNo) idParts.push(apiDigits(apiNo));
  if (date)  idParts.push(date.replace(/\D/g, ""));
  if (rule)  idParts.push(rule.replace(/\s+/g, "").slice(0, 8));
  const violation_id = idParts.length > 0 ? idParts.join("-") : null;

  return {
    violation_id,
    date: date || null,
    type: rule || "Violation",
    description,
    status,
    penalty_usd: null,
    api_or_lease: apiNo || leaseNo || null,
  };
}

// ── MFT GoDrive file download ──────────────────────────────────────────────────
//
// TRRC publishes violation files via the Thru MFT GoDrive system. The share link
// presents a file listing without authentication, but files are served via a
// JavaScript-driven PrimeFaces UI — there is no direct static download URL.
//
// Reverse-engineered download protocol (confirmed working June 2026):
//
//   Step 1 — GET the share link to establish a session:
//     GET https://mft.rrc.texas.gov/link/<guid>
//     → Set-Cookie: JSESSIONID=XXXX
//     → HTML with ViewState token and file table (each row has data-rk="NNNN")
//
//   Step 2 — Click the target file by submitting the fileList form:
//     POST https://mft.rrc.texas.gov/webclient/godrive/PublicGoDrive.xhtml
//     Body: fileList_SUBMIT=1
//           fileTable_selection=<data-rk>
//           fileTable%3A<row>%3A<compId>=fileTable%3A<row>%3A<compId>
//           javax.faces.ViewState=<token>
//     → 302 Location: /link/godrivedownload
//
//   Step 3 — Follow the redirect to stream the file:
//     GET https://mft.rrc.texas.gov/link/godrivedownload
//     Cookie: JSESSIONID=XXXX
//     → 200 Content-Disposition: attachment;filename="VIOLATIONS_DIST8A.txt"
//     → Raw violation data (3+ MB, '}'-delimited)

const MFT_BASE = "https://mft.rrc.texas.gov";
const GODRIVE_ACTION = `${MFT_BASE}/webclient/godrive/PublicGoDrive.xhtml`;
const GODRIVE_DOWNLOAD = `${MFT_BASE}/link/godrivedownload`;

/**
 * Download a specific file from a public MFT GoDrive share link.
 *
 * @param shareUrl  Full share URL, e.g. https://mft.rrc.texas.gov/link/<guid>
 * @param filename  Exact filename to download, e.g. "VIOLATIONS_DIST8A.txt"
 * @returns         Raw file text, or null on any failure
 */
async function downloadFileFromMftShare(
  shareUrl: string,
  filename: string,
): Promise<string | null> {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // ── Step 0: Try a direct REST-style URL first ─────────────────────────────
  // Thru MFT sometimes serves files at a predictable path — this bypasses the
  // full GoDrive UI protocol entirely and is immune to GoDrive UI changes.
  const guidM = shareUrl.match(/link\/([a-f0-9-]{36})/i);
  if (guidM) {
    const directUrl = `${MFT_BASE}/link/${guidM[1]}/${encodeURIComponent(filename)}`;
    try {
      const directRes = await fetch(directUrl, {
        headers: { "User-Agent": UA, "Accept": "text/plain,application/octet-stream,*/*" },
        signal: AbortSignal.timeout(45_000),
      });
      if (directRes.ok) {
        const ct = directRes.headers.get("content-type") ?? "";
        if (!ct.includes("text/html")) return await directRes.text();
      }
    } catch { /* fall through to GoDrive protocol */ }
  }

  // ── Step 1: GET share page, capture session cookie + ViewState ────────────
  let jsessionid: string | null = null;
  let viewState:  string | null = null;
  let fileRowKey: string | null = null;
  let fileCompId: string | null = null;
  let fileRowIdx: string | null = null;

  try {
    const getRes = await fetch(shareUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!getRes.ok) return null;

    // Extract JSESSIONID from Set-Cookie
    const setCookie = getRes.headers.get("set-cookie") ?? "";
    const cookieMatch = setCookie.match(/JSESSIONID=([^;,\s]+)/i);
    if (cookieMatch) jsessionid = cookieMatch[1];

    const html = await getRes.text();

    // Extract ViewState (same value appears in all forms on the page)
    const vsMatch = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    if (vsMatch) viewState = vsMatch[1];

    // Detection strategy 1: primary regex — all attributes on/near the same element
    const filePattern = new RegExp(
      `data-ri="(\\d+)"[^>]*data-rk="(\\d+)"[^<]*(?:<[^>]+>)*[^<]*` +
      `addSubmitParam[^']*'fileList'[^{]*\\{([^}]+)\\}[^>]+>${filename.replace(/[.]/g, "\\.")}`,
      "i",
    );
    const rowMatch = html.match(filePattern);
    if (rowMatch) {
      fileRowIdx = rowMatch[1];
      fileRowKey = rowMatch[2];
      const compMatch = rowMatch[3].match(/'(fileTable:[^']+)'/);
      if (compMatch) fileCompId = compMatch[1];
    }

    // Detection strategy 2: line-by-line scan (handles multiline row HTML)
    if (!fileCompId) {
      const lines = html.split("\n");
      for (const line of lines) {
        if (!line.includes(filename)) continue;
        if (!fileRowKey) { const m = line.match(/data-rk="(\d+)"/); if (m) fileRowKey = m[1]; }
        if (!fileRowIdx) { const m = line.match(/data-ri="(\d+)"/); if (m) fileRowIdx = m[1]; }
        if (!fileCompId) { const m = line.match(/'(fileTable:\d+:[^']+)'/); if (m) fileCompId = m[1]; }
        if (fileCompId) break;
      }
    }

    // Detection strategy 3: wide context window around filename (catches split-line HTML)
    if (!fileCompId || !fileRowKey) {
      const idx = html.indexOf(filename);
      if (idx > 0) {
        const region = html.slice(Math.max(0, idx - 1500), idx + 500);
        if (!fileRowKey) { const m = region.match(/data-rk="(\d+)"/); if (m) fileRowKey = m[1]; }
        if (!fileRowIdx) { const m = region.match(/data-ri="(\d+)"/); if (m) fileRowIdx = m[1]; }
        if (!fileCompId) { const m = region.match(/'(fileTable:\d+:[^']+)'/); if (m) fileCompId = m[1]; }
      }
    }

    // Detection strategy 4: last-resort — any fileTable component on the page
    // If the GoDrive UI changed and we can't find the exact row, try the first
    // fileTable component. It won't match our target row but some MFT deployments
    // use the selection key (fileRowKey) as the authoritative download identifier.
    if (!fileCompId) {
      const anyComp = html.match(/'(fileTable:\d+:[^']+)'/);
      if (anyComp) fileCompId = anyComp[1];
    }
  } catch (err) {
    console.error("[downloadFileFromMftShare step1 GET]", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return null;
  }

  // Need at least a session + ViewState + some way to identify the file.
  // fileCompId alone is sufficient (fileRowKey is best-effort).
  if (!jsessionid || !viewState || !fileCompId) return null;

  // ── Step 2: Submit fileList form to "click" the file ─────────────────────
  // This tells the server which file to prepare for download.
  // Server responds with 302 → /link/godrivedownload
  const cookie = `JSESSIONID=${jsessionid}`;
  const body = new URLSearchParams({
    "fileList_SUBMIT":       "1",
    "javax.faces.ViewState": viewState,
  });
  // fileTable_selection (row key) is best-effort — the component ID is authoritative
  if (fileRowKey) body.append("fileTable_selection", fileRowKey);
  // Component ID param (colons in key name, not URL-encoded)
  body.append(fileCompId, fileCompId);

  try {
    const clickRes = await fetch(GODRIVE_ACTION, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   UA,
        "Cookie":       cookie,
        "Referer":      shareUrl,
        "Accept":       "text/html,*/*",
      },
      body: body.toString(),
      redirect: "manual",   // capture the 302, don't follow it automatically
      signal: AbortSignal.timeout(20_000),
    });

    // Expect 302 to /link/godrivedownload
    if (clickRes.status !== 302) return null;
    const location = clickRes.headers.get("location");
    if (!location || !location.includes("godrivedownload")) return null;
  } catch {
    return null;
  }

  // ── Step 3: Follow redirect to download the file ──────────────────────────
  try {
    const dlRes = await fetch(GODRIVE_DOWNLOAD, {
      headers: {
        "User-Agent": UA,
        "Cookie":     cookie,
        "Referer":    GODRIVE_ACTION,
        "Accept":     "text/plain,application/octet-stream,*/*",
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!dlRes.ok) return null;
    const ct = dlRes.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) return null; // got a login/error page

    return await dlRes.text();
  } catch {
    return null;
  }
}

/**
 * Map a normalized district code to the filename used in the MFT share.
 * TRRC file naming convention: VIOLATIONS_DIST<code>.txt
 * Special cases: single-digit districts are zero-padded (01–10); alpha suffixes preserved.
 */
function districtToFilename(districtCode: string): string {
  const code = districtCode.toUpperCase().trim();
  // Single-digit numeric → zero-pad (e.g. "1" → "01", "8" → "08")
  if (/^\d$/.test(code)) return `VIOLATIONS_DIST0${code}.txt`;
  // District 7B, 7C, 8A etc. → VIOLATIONS_DIST7B.txt etc.
  return `VIOLATIONS_DIST${code}.txt`;
}

/**
 * Try to scrape the TRRC resource center page to discover the share URL for a district.
 * Falls back to the hardcoded registry.
 */
async function scrapeDistrictUrl(districtCode: string): Promise<string | null> {
  try {
    const res = await fetch(TRRC_VIOLATIONS_RESOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const distLabel = districtCode.replace(/\s+/g, "\\s*");
    const re = new RegExp(
      `District\\s*${distLabel}[^<]{0,200}href=["'](https://mft\\.rrc\\.texas\\.gov/link/[^"']+)["']|href=["'](https://mft\\.rrc\\.texas\\.gov/link/[^"']+)["'][^<]{0,200}District\\s*${distLabel}`,
      "i",
    );
    const m = html.match(re);
    return m ? (m[1] ?? m[2] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the MFT share URL for a given district code.
 * Priority: hardcoded registry → live scrape.
 */
async function resolveDistrictShareUrl(districtCode: string): Promise<string | null> {
  const normalized = districtCode.toUpperCase().trim();
  if (DISTRICT_VIOLATION_URLS[normalized]) return DISTRICT_VIOLATION_URLS[normalized];
  return scrapeDistrictUrl(normalized);
}

// ── Core download + filter ────────────────────────────────────────────────────

/**
 * Download and filter the TRRC district violation file for a specific asset.
 *
 * Filters by (any of):
 *   1. Exact lease number match
 *   2. API number prefix match (matches subject API and all sibling wells on the lease)
 *   3. Operator name fuzzy match (optional — only used if leaseNo is not provided)
 *
 * @param districtCode  RRC district code, e.g. "8A", "08", "7C"
 * @param leaseNo       Numeric lease number, e.g. "60509"
 * @param apiNumbers    One or more 10-digit API numbers on the lease
 * @param operatorName  Optional operator name for fallback matching
 */
export async function fetchDistrictViolations(
  districtCode: string,
  leaseNo: string | null,
  apiNumbers: string[],
  operatorName?: string | null,
): Promise<DistrictViolationResult> {
  const timestamp = new Date().toISOString();
  const normalizedDist = districtCode.toUpperCase().trim();

  // ── 1. Resolve the MFT share URL for this district ────────────────────────
  let shareUrl: string | null = null;
  try {
    shareUrl = await resolveDistrictShareUrl(normalizedDist);
  } catch { /* fall through */ }

  if (!shareUrl) {
    return {
      status: "no_url_for_district",
      district: normalizedDist,
      source_url: null,
      raw_sha256: null,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `No district violation file share URL found for District ${normalizedDist}. Compliance status UNVERIFIED.`,
      query_timestamp: timestamp,
    };
  }

  // ── 2. Download the district-specific violation file via MFT GoDrive ──────
  //
  // The MFT share contains files named VIOLATIONS_DIST<code>.txt.
  // We use the 3-step protocol: GET share → POST fileList form → GET download.
  // This is the same flow a browser uses when clicking the file name.
  const targetFilename = districtToFilename(normalizedDist);
  const sourceUrl = shareUrl; // for reporting

  // Single attempt. downloadFileFromMftShare chains up to 4 internal fetches
  // (its own hardcoded timeouts, ~145s worst case) — retrying that 3x pushed
  // this branch alone to ~441s, well past Vercel's 300s maxDuration, causing
  // a silent platform kill with no error event (indistinguishable from a hang).
  let rawText: string | null = null;
  try {
    rawText = await withTrrcRetry(
      (_signal) => downloadFileFromMftShare(shareUrl, targetFilename),
      null,
      { timeout: 120_000, retries: 0 },
    );
  } catch { /* fall through */ }

  if (!rawText) {
    return {
      status: "download_failed",
      district: normalizedDist,
      source_url: sourceUrl,
      raw_sha256: null,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `District ${normalizedDist} violation file (${targetFilename}) download failed. Compliance UNVERIFIED — cannot claim clean compliance.`,
      query_timestamp: timestamp,
    };
  }

  // Guard: reject HTML responses (login page / error page)
  const trimmed = rawText.trimStart();
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<?xml")) {
    return {
      status: "download_failed",
      district: normalizedDist,
      source_url: sourceUrl,
      raw_sha256: null,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `District ${normalizedDist} violation file returned HTML instead of data. Compliance UNVERIFIED.`,
      query_timestamp: timestamp,
    };
  }

  // ── 3. Hash the raw artifact ──────────────────────────────────────────────
  const rawSha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");

  // ── 4. Parse + filter the file in one pass (see parseAndFilterDistrictFile
  //      doc comment for why this avoids materializing every row at once) ───
  // Match criteria (any of):
  //   a) Exact lease number match
  //   b) API number digits match any provided API (or its county prefix)
  //   c) Operator name fuzzy match (only when no lease number)
  const leaseNoTrim     = leaseNo?.replace(/\s/g, "") ?? null;
  const apiDigitSets    = apiNumbers.map(a => apiDigits(a)).filter(a => a.length >= 8);
  const opNormalized    = operatorName ? normalizeOp(operatorName) : null;

  const isRowMatch = (row: Record<string, string>): boolean => {
    const rowLeaseNo  = col(row, ["oil_lease_gas_well_id", "lease_no", "lease_number", "lsno", "lease_gas_well_id", "well_id"]).replace(/\s/g, "");
    const rowApiNo    = apiDigits(col(row, ["api_no", "api_number", "api"]));
    const rowOpName   = normalizeOp(col(row, ["operator_name", "oper_name", "operator"]));

    // a) Exact lease number
    if (leaseNoTrim && rowLeaseNo && rowLeaseNo === leaseNoTrim) return true;

    // b) API number match — compare full 10-digit or at least 8-digit prefix
    if (rowApiNo.length >= 8) {
      for (const apiD of apiDigitSets) {
        if (rowApiNo === apiD || rowApiNo.startsWith(apiD.slice(0, 8))) return true;
      }
    }

    // c) Operator fuzzy match (only when lease number not provided, to avoid over-matching)
    if (!leaseNoTrim && opNormalized && rowOpName.length >= 4) {
      if (rowOpName.includes(opNormalized) || opNormalized.includes(rowOpName)) return true;
    }

    return false;
  };

  let totalRows: number;
  let matching: TrrcViolation[];
  try {
    const result = parseAndFilterDistrictFile(rawText, isRowMatch);
    totalRows = result.totalRows;
    matching  = result.matching;
  } catch {
    return {
      status: "parse_error",
      district: normalizedDist,
      source_url: sourceUrl,
      raw_sha256: rawSha256,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `District ${normalizedDist} violation file could not be parsed. Compliance UNVERIFIED.`,
      query_timestamp: timestamp,
    };
  }

  if (totalRows === 0) {
    return {
      status: "parse_error",
      district: normalizedDist,
      source_url: sourceUrl,
      raw_sha256: rawSha256,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `District ${normalizedDist} violation file parsed but contained 0 data rows. Compliance UNVERIFIED.`,
      query_timestamp: timestamp,
    };
  }

  const matchCount = matching.length;
  const confirmedClean = matchCount === 0; // only clean if we positively found zero matches

  const evidenceNote = confirmedClean
    ? `District ${normalizedDist} violation file confirmed clean for ${leaseNoTrim ? `Lease ${leaseNoTrim}` : "subject asset"}. File contained ${totalRows.toLocaleString()} total records; 0 matched.`
    : `District ${normalizedDist} violation file: ${matchCount} violation record(s) found for ${leaseNoTrim ? `Lease ${leaseNoTrim}` : "subject asset"} out of ${totalRows.toLocaleString()} total records.`;

  return {
    status: "success",
    district: normalizedDist,
    source_url: sourceUrl,
    raw_sha256: rawSha256,
    total_rows_in_file: totalRows,
    matching_violations: matching,
    match_count: matchCount,
    confirmed_clean: confirmedClean,
    evidence_note: evidenceNote,
    query_timestamp: timestamp,
  };
}
