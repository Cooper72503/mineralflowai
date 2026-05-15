/**
 * TRRC Monthly Production Fetcher
 *
 * Two-step process against the Texas Railroad Commission's public PDQ web app:
 *   1. Wellbore query  →  district code + lease number
 *   2. Specific-lease CSV export  →  actual monthly oil production (BBL)
 *
 * Both requests are HTML/CSV scrapes of TRRC's public EWA system.
 * Run server-side only (no CORS issues from Next.js API routes).
 *
 * Reference: https://webapps2.rrc.texas.gov/EWA/ewaPdqMain.do
 */

const BASE = "https://webapps2.rrc.texas.gov/EWA";

// ── types ──────────────────────────────────────────────────────────────────────

export type TrrcMonthlyRow = {
  year:    number;
  month:   number;  // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
};

export type TrrcProductionResult = {
  api_number:    string;
  district_code: string;
  lease_number:  string;
  rows:          TrrcMonthlyRow[];
  /** Total months returned */
  months_count:  number;
  source: "trrc_actual";
};

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalise a TRRC API number to a clean 10-digit string (42 + county(3) + well(5)).
 * Accepts dashed ("42-151-12345-00-00") or plain ("4215112345") formats.
 */
export function normalizeApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic")) return null;
  const digits = raw.replace(/[-\s]/g, "").replace(/^0+/, "");
  // Must start with 42 and be at least 10 digits
  if (!digits.startsWith("42") || digits.length < 10) return null;
  return digits.slice(0, 10);
}

/** Parse "MM/YYYY" or "YYYY-MM" → { year, month } */
function parseMonthStr(s: string): { year: number; month: number } | null {
  const slash = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (slash) return { month: parseInt(slash[1], 10), year: parseInt(slash[2], 10) };
  const iso   = s.match(/^(\d{4})-(\d{1,2})$/);
  if (iso)   return { year:  parseInt(iso[1], 10),   month: parseInt(iso[2], 10) };
  return null;
}

/** Strip commas from numeric strings and parse float. */
function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, "").trim()) || 0;
}

// ── step 1: wellbore query → district + lease ──────────────────────────────────

async function getLeaseFromApiNumber(
  apiNumber: string,
  signal?: AbortSignal,
): Promise<{ distCode: string; leaseNo: string } | null> {
  const normalized = normalizeApiNumber(apiNumber);
  if (!normalized) return null;

  const body = new URLSearchParams({
    "searchArgs.apiNoPrefixArg": normalized,
    "searchArgs.apiNoSuffixArg": "",
    "methodToCall":              "search",
  });

  const res = await fetch(`${BASE}/wellboreQueryAction.do`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
    signal,
  });

  if (!res.ok) return null;
  const html = await res.text();

  // Look for leaseDetailAction.do link containing distCode and leaseNo
  // Example: leaseDetailAction.do?...distCode=08&leaseNo=12345&...
  const match = html.match(/leaseDetailAction\.do[^"']*distCode=([A-Z0-9]+)[^"']*leaseNo=(\d+)/i)
             ?? html.match(/leaseDetailAction\.do[^"']*leaseNo=(\d+)[^"']*distCode=([A-Z0-9]+)/i);

  if (!match) return null;

  // Handle either capture group order
  const hasDistFirst = html.match(/leaseDetailAction\.do[^"']*distCode=([A-Z0-9]+)[^"']*leaseNo=(\d+)/i);
  if (hasDistFirst) {
    return { distCode: hasDistFirst[1], leaseNo: hasDistFirst[2] };
  }
  // Reverse order
  return { distCode: match[2], leaseNo: match[1] };
}

// ── step 2: specific-lease CSV → monthly rows ──────────────────────────────────

async function getLeaseProductionCsv(
  distCode: string,
  leaseNo:  string,
  monthsBack = 36,
  signal?: AbortSignal,
): Promise<TrrcMonthlyRow[]> {
  const now       = new Date();
  const endYear   = now.getFullYear();
  const endMonth  = now.getMonth() + 1;
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const startYear  = startDate.getFullYear();
  const startMonth = startDate.getMonth() + 1;

  const body = new URLSearchParams({
    "methodToCall":                  "generateSpecificLeaseCSVReport",
    "searchArgs.leaseNumberArg":     leaseNo,
    "searchArgs.districtCodeArg":    distCode,
    "searchArgs.oilOrGasArg":        "O",
    "searchArgs.startMonthArg":      String(startMonth).padStart(2, "0"),
    "searchArgs.startYearArg":       String(startYear),
    "searchArgs.endMonthArg":        String(endMonth).padStart(2, "0"),
    "searchArgs.endYearArg":         String(endYear),
    "searchType":                    "specificLease",
  });

  const res = await fetch(`${BASE}/specificLeaseQueryAction.do`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
    signal,
  });

  if (!res.ok) return [];

  const csv = await res.text();
  return parseTrrcCsv(csv);
}

/**
 * Parse the TRRC production CSV export.
 * Format: ~10 header rows, then data rows, last row is totals.
 * Oil columns: Month, Oil Production (BBL), ..., Gas Production (MCF), ...
 */
function parseTrrcCsv(csv: string): TrrcMonthlyRow[] {
  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows: TrrcMonthlyRow[] = [];

  let dataStarted = false;
  for (const line of lines) {
    const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));

    // Data rows have a month in col 0 — skip header lines
    if (!dataStarted) {
      // Month column looks like "01/2023" or "2023-01"
      if (!parseMonthStr(cols[0])) continue;
      dataStarted = true;
    }

    const datePart = parseMonthStr(cols[0]);
    if (!datePart) continue; // totals row or blank

    const oil = parseNum(cols[1] ?? "0");
    const gas = cols[3] != null ? parseNum(cols[3]) : null;

    // Skip zero-production rows that are clearly placeholders
    if (oil === 0 && (gas == null || gas === 0)) continue;

    rows.push({
      year:    datePart.year,
      month:   datePart.month,
      oil_bbl: oil,
      gas_mcf: gas && gas > 0 ? gas : null,
    });
  }

  return rows;
}

// ── public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch the last `monthsBack` months of actual TRRC production for an API number.
 * Returns null if the API number is invalid, synthetic, or TRRC is unreachable.
 */
export async function fetchTrrcProductionHistory(
  apiNumber: string,
  monthsBack = 36,
): Promise<TrrcProductionResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const lease = await getLeaseFromApiNumber(apiNumber, controller.signal);
    if (!lease) return null;

    const rows = await getLeaseProductionCsv(
      lease.distCode,
      lease.leaseNo,
      monthsBack,
      controller.signal,
    );

    if (rows.length === 0) return null;

    return {
      api_number:    apiNumber,
      district_code: lease.distCode,
      lease_number:  lease.leaseNo,
      rows:          rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month),
      months_count:  rows.length,
      source:        "trrc_actual",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try each API number in order, return the first one that yields production data.
 * Useful when we have a list of nearby wells and want the best available data.
 */
export async function fetchBestTrrcProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<TrrcProductionResult | null> {
  for (const api of apiNumbers) {
    if (!normalizeApiNumber(api)) continue;
    const result = await fetchTrrcProductionHistory(api, monthsBack);
    if (result) return result;
  }
  return null;
}
