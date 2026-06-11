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

// ── District violation file URL registry ──────────────────────────────────────
//
// TRRC publishes district-specific violation download files via file-transfer
// links (MFT system). These GUIDs are stable but the registry should be
// periodically refreshed from:
//   https://www.rrc.texas.gov/resource-center/inspections-and-violations/
//
// Confirmed as of June 2026 (cross-referenced from Manus implementation spec):
const DISTRICT_VIOLATION_URLS: Record<string, string> = {
  // District 8A — Permian Basin (Gaines, Yoakum, Terry, Lynn, Garza, Dawson, Borden, Scurry)
  "8A": "https://mft.rrc.texas.gov/link/c7c28dc9-b218-4f0a-8278-bf15d009def1",
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
 * Auto-detect whether a text file is pipe-delimited, comma-delimited,
 * or tab-delimited based on the first non-empty line.
 */
function detectDelimiter(firstLine: string): string {
  const pipes  = (firstLine.match(/\|/g) ?? []).length;
  const commas = (firstLine.match(/,/g)  ?? []).length;
  const tabs   = (firstLine.match(/\t/g) ?? []).length;
  if (pipes > commas && pipes > tabs) return "|";
  if (tabs  > commas)                 return "\t";
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
function parseDistrictFile(raw: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = raw.replace(/\r/g, "").split("\n");
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 2) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(nonEmpty[0]);
  const headers   = splitLine(nonEmpty[0], delimiter)
    .map(h => h.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_"));

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const cells = splitLine(nonEmpty[i], delimiter);
    if (cells.every(c => !c)) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ""; });
    rows.push(obj);
  }
  return { headers, rows };
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
  const date        = col(row, ["violation_discovery_date", "discovery_date", "viol_date", "date"]);
  const operator    = col(row, ["operator_name", "oper_name", "operator"]);
  const leaseNo     = col(row, ["lease_no", "lease_number", "lsno"]);
  const leaseName   = col(row, ["lease_facility_name", "lease_name", "lsnm"]);
  const apiNo       = col(row, ["api_no", "api_number", "api"]);
  const rule        = col(row, ["violated_rule", "viol_rule", "rule"]);
  const ruleDesc    = col(row, ["violated_rule_description", "rule_description", "viol_rule_desc", "description"]);
  const isMajor     = col(row, ["major_violation_indicator", "major_viol", "major"]);
  const compliant   = col(row, ["compliant_on_reinspection", "compliant_reinsp", "compliant"]);
  const enfAction   = col(row, ["last_enforcement_action", "enforcement_action", "enf_action"]);
  const enfDate     = col(row, ["last_enforcement_action_date", "enforcement_date", "enf_date"]);

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

// ── URL discovery ─────────────────────────────────────────────────────────────

/**
 * Try to scrape the TRRC resource center page to find the download URL
 * for a specific district.  The page has links like:
 *   "District 8A Violations" → https://mft.rrc.texas.gov/link/...
 *
 * This is a best-effort scrape — if it fails, fall back to the hardcoded registry.
 */
async function scrapeDistrictUrl(districtCode: string): Promise<string | null> {
  try {
    const res = await fetch(TRRC_VIOLATIONS_RESOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Look for href containing mft.rrc.texas.gov near district label
    // e.g. "District 8A" ... href="https://mft.rrc.texas.gov/link/..."
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
 * Resolve the download URL for a given district code.
 * Priority: hardcoded registry → live scrape of TRRC resource page.
 */
async function resolveDistrictUrl(districtCode: string): Promise<string | null> {
  // Normalize district code (e.g. "8a" → "8A")
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

  // ── 1. Resolve URL ────────────────────────────────────────────────────────
  let sourceUrl: string | null = null;
  try {
    sourceUrl = await resolveDistrictUrl(normalizedDist);
  } catch { /* fall through */ }

  if (!sourceUrl) {
    return {
      status: "no_url_for_district",
      district: normalizedDist,
      source_url: null,
      raw_sha256: null,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `No district violation file URL found for District ${normalizedDist}. Compliance status UNVERIFIED — do not claim clean compliance.`,
      query_timestamp: timestamp,
    };
  }

  // ── 2. Download file ──────────────────────────────────────────────────────
  let rawText: string;
  try {
    const res = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)",
        "Accept": "text/plain,text/csv,application/octet-stream,*/*",
      },
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      return {
        status: "download_failed",
        district: normalizedDist,
        source_url: sourceUrl,
        raw_sha256: null,
        total_rows_in_file: 0,
        matching_violations: [],
        match_count: 0,
        confirmed_clean: false,
        evidence_note: `District ${normalizedDist} violation file returned HTTP ${res.status}. Download failed — compliance UNVERIFIED. Do not claim clean compliance based on a failed download.`,
        query_timestamp: timestamp,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    rawText = await res.text();

    // If we got back HTML (error page), treat as download failure
    if (
      contentType.includes("text/html") ||
      rawText.trimStart().startsWith("<!") ||
      rawText.trimStart().startsWith("<html")
    ) {
      return {
        status: "download_failed",
        district: normalizedDist,
        source_url: sourceUrl,
        raw_sha256: null,
        total_rows_in_file: 0,
        matching_violations: [],
        match_count: 0,
        confirmed_clean: false,
        evidence_note: `District ${normalizedDist} violation file URL returned HTML (error page or redirect). Compliance UNVERIFIED.`,
        query_timestamp: timestamp,
      };
    }
  } catch {
    return {
      status: "download_failed",
      district: normalizedDist,
      source_url: sourceUrl,
      raw_sha256: null,
      total_rows_in_file: 0,
      matching_violations: [],
      match_count: 0,
      confirmed_clean: false,
      evidence_note: `District ${normalizedDist} violation file download failed (network error). Compliance UNVERIFIED — do not claim clean compliance.`,
      query_timestamp: timestamp,
    };
  }

  // ── 3. Hash the raw artifact ──────────────────────────────────────────────
  const rawSha256 = crypto.createHash("sha256").update(rawText, "utf8").digest("hex");

  // ── 4. Parse the file ────────────────────────────────────────────────────
  let parsed: { headers: string[]; rows: Record<string, string>[] };
  try {
    parsed = parseDistrictFile(rawText);
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

  const totalRows = parsed.rows.length;
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

  // ── 5. Filter rows to subject asset ──────────────────────────────────────
  // Match criteria (any of):
  //   a) Exact lease number match
  //   b) API number digits match any provided API (or its county prefix)
  //   c) Operator name fuzzy match (only when no lease number)
  const leaseNoTrim     = leaseNo?.replace(/\s/g, "") ?? null;
  const apiDigitSets    = apiNumbers.map(a => apiDigits(a)).filter(a => a.length >= 8);
  const opNormalized    = operatorName ? normalizeOp(operatorName) : null;

  const matching: TrrcViolation[] = [];

  for (const row of parsed.rows) {
    const rowLeaseNo  = col(row, ["lease_no", "lease_number", "lsno"]).replace(/\s/g, "");
    const rowApiNo    = apiDigits(col(row, ["api_no", "api_number", "api"]));
    const rowOpName   = normalizeOp(col(row, ["operator_name", "oper_name", "operator"]));

    let isMatch = false;

    // a) Exact lease number
    if (leaseNoTrim && rowLeaseNo && rowLeaseNo === leaseNoTrim) {
      isMatch = true;
    }

    // b) API number match — compare full 10-digit or at least 8-digit prefix
    if (!isMatch && rowApiNo.length >= 8) {
      for (const apiD of apiDigitSets) {
        if (rowApiNo === apiD || rowApiNo.startsWith(apiD.slice(0, 8))) {
          isMatch = true;
          break;
        }
      }
    }

    // c) Operator fuzzy match (only when lease number not provided, to avoid over-matching)
    if (!isMatch && !leaseNoTrim && opNormalized && rowOpName.length >= 4) {
      if (rowOpName.includes(opNormalized) || opNormalized.includes(rowOpName)) {
        isMatch = true;
      }
    }

    if (isMatch) matching.push(rowToViolation(row));
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
