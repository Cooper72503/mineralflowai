/**
 * Oklahoma Corporation Commission (OCC) Monthly Production Fetcher
 *
 * Uses the OCC COGIS (Corporation Commission Oil and Gas Information System)
 * public production query endpoint. No API key required.
 *
 * Data source: https://www.occeweb.com/og/ogproduction.asp
 * API numbers: 35 + 3-digit county FIPS + 5-digit well number (10 digits total)
 *
 * Run server-side only (no CORS issues from Next.js API routes).
 */

export type OccMonthlyRow = {
  year:    number;
  month:   number;   // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
};

export type OccProductionResult = {
  api_number:   string;
  rows:         OccMonthlyRow[];
  months_count: number;
  source: "occ_actual";
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize an Oklahoma API number to 10 digits (35 + county(3) + well(5)).
 * Accepts hyphenated "35-001-12345-0000" or plain "3500112345" formats.
 */
export function normalizeOkApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic") || raw === "unknown") return null;
  const digits = raw.replace(/[-\s]/g, "");
  if (!digits.startsWith("35") || digits.length < 10) return null;
  return digits.slice(0, 10);
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/[,\s$]/g, "").trim()) || 0;
}

/**
 * Extract text from all <td> cells in an HTML fragment.
 */
function extractTdValues(rowHtml: string): string[] {
  const values: string[] = [];
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = tdRegex.exec(rowHtml)) !== null) {
    values.push(m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").trim());
  }
  return values;
}

/**
 * Parse OCC production HTML table.
 *
 * OCC table format (typical): Year | Jan | Feb | Mar | Apr | May | Jun |
 *                                   Jul | Aug | Sep | Oct | Nov | Dec | Total
 */
function parseOccProductionTable(html: string, commodity: "oil" | "gas", monthsBack: number): Record<string, number> {
  const result: Record<string, number> = {};
  const now    = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  const trParts = html.split(/<\/?tr[^>]*>/i);
  for (const part of trParts) {
    if (!/<td/i.test(part)) continue;
    const cells = extractTdValues(part);
    if (cells.length < 13) continue;

    const yearStr = cells[0].replace(/\D/g, "");
    const year = parseInt(yearStr, 10);
    if (isNaN(year) || year < 1990 || year > now.getFullYear() + 1) continue;

    // Cells 1–12 are Jan–Dec
    for (let mo = 1; mo <= 12; mo++) {
      const dateKey = `${year}-${String(mo).padStart(2, "0")}`;
      if (new Date(year, mo - 1) < cutoff) continue;
      const val = parseNum(cells[mo] ?? "0");
      if (val > 0) result[dateKey] = val;
    }
  }
  return result;
}

// ── Main fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch monthly oil and gas production from OCC COGIS for a single API number.
 * Returns up to `monthsBack` months of history.
 */
export async function fetchOccProductionHistory(
  apiNumber: string,
  monthsBack = 36,
): Promise<OccProductionResult | null> {
  const normalized = normalizeOkApiNumber(apiNumber);
  if (!normalized) return null;

  // OCC uses a 10-digit API (without leading state code in their form, but
  // including it in the URL query works too). Their production page accepts
  // a "api_no" parameter.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    // OCC COGIS production query — POST form with API number
    const formData = new URLSearchParams({
      api_no:    normalized,
      type:      "PRODUCTION",
      submitbtn: "Submit",
    });

    const res = await fetch("https://www.occeweb.com/og/ogproduction.asp", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   "Mozilla/5.0 (compatible; MineralFlow/1.0)",
        "Referer":      "https://www.occeweb.com/og/ogproduction.asp",
      },
      body:   formData.toString(),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const html = await res.text();

    if (!html || html.length < 200) return null;

    // Find the oil and gas production table sections
    const oilMatch  = html.match(/oil.*?production[\s\S]*?<table[\s\S]*?<\/table>/i);
    const gasMatch  = html.match(/gas.*?production[\s\S]*?<table[\s\S]*?<\/table>/i);

    const oilData = oilMatch ? parseOccProductionTable(oilMatch[0], "oil",  monthsBack) : {};
    const gasData = gasMatch ? parseOccProductionTable(gasMatch[0], "gas",  monthsBack) : {};

    // Merge periods
    const allKeys = Array.from(new Set([...Object.keys(oilData), ...Object.keys(gasData)]));
    const rows: OccMonthlyRow[] = [];

    for (const key of allKeys) {
      const [yearStr, moStr] = key.split("-");
      rows.push({
        year:    parseInt(yearStr, 10),
        month:   parseInt(moStr,   10),
        oil_bbl: oilData[key] ?? 0,
        gas_mcf: gasData[key] ?? null,
      });
    }

    if (rows.length === 0) return null;
    rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    return { api_number: normalized, rows, months_count: rows.length, source: "occ_actual" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try each API number in order, return the first one that yields production.
 */
export async function fetchBestOccProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<OccProductionResult | null> {
  for (const api of apiNumbers) {
    const result = await fetchOccProductionHistory(api, monthsBack);
    if (result && result.rows.length > 0) return result;
  }
  return null;
}
