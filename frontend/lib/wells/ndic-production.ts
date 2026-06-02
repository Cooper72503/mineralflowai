/**
 * North Dakota Industrial Commission (NDIC) Monthly Production Fetcher
 *
 * Uses the NDIC Oil and Gas Division public production query.
 * No API key required.
 *
 * Data source: https://www.dmr.nd.gov/oilgas/bakkenwells.asp (well lookup)
 *              https://www.dmr.nd.gov/oilgas/productionstats.asp (production)
 *
 * North Dakota API numbers: 33 + 3-digit county + 5-digit well (10 digits)
 * NDIC also uses a "File Number" (shorter integer) as their primary well ID.
 *
 * Run server-side only.
 */

export type NdicMonthlyRow = {
  year:    number;
  month:   number;   // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
  water_bbl: number | null;
};

export type NdicProductionResult = {
  api_number:   string;
  file_number:  string | null;
  rows:         NdicMonthlyRow[];
  months_count: number;
  source: "ndic_actual";
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalize a North Dakota API number to 10 digits (33 + county(3) + well(5)).
 */
export function normalizeNdApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic") || raw === "unknown") return null;
  const digits = raw.replace(/[-\s]/g, "");
  if (!digits.startsWith("33") || digits.length < 10) return null;
  return digits.slice(0, 10);
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/[,\s$]/g, "").trim()) || 0;
}

function extractTdValues(rowHtml: string): string[] {
  const values: string[] = [];
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = tdRegex.exec(rowHtml)) !== null) {
    values.push(m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim());
  }
  return values;
}

/**
 * Parse NDIC production table.
 * Format: Month/Year | Oil (BBL) | Gas (MCF) | Water (BBL)
 * e.g.  2024-01 | 12,450 | 8,200 | 4,100
 */
function parseNdicTable(html: string, monthsBack: number): NdicMonthlyRow[] {
  const rows: NdicMonthlyRow[] = [];
  const now    = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  const trParts = html.split(/<\/?tr[^>]*>/i);
  for (const part of trParts) {
    if (!/<td/i.test(part)) continue;
    const cells = extractTdValues(part);
    if (cells.length < 2) continue;

    // First cell may be "Jan-2024" or "2024-01" or "01/2024"
    const dateCell = cells[0].trim();
    let year: number | null = null;
    let month: number | null = null;

    // Try YYYY-MM
    const iso = dateCell.match(/^(\d{4})-(\d{2})$/);
    if (iso) { year = parseInt(iso[1]); month = parseInt(iso[2]); }

    // Try Mon-YYYY (e.g. Jan-2024)
    if (!year) {
      const mon = dateCell.match(/^([A-Za-z]{3})-?(\d{4})$/);
      if (mon) {
        const MONTHS: Record<string, number> = {
          jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
          jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
        };
        month = MONTHS[mon[1].toLowerCase()];
        year  = parseInt(mon[2]);
      }
    }

    // Try MM/YYYY
    if (!year) {
      const slash = dateCell.match(/^(\d{1,2})\/(\d{4})$/);
      if (slash) { month = parseInt(slash[1]); year = parseInt(slash[2]); }
    }

    if (!year || !month || isNaN(year) || isNaN(month)) continue;
    if (year < 1990 || year > now.getFullYear() + 1) continue;
    if (new Date(year, month - 1) < cutoff) continue;

    const oil   = parseNum(cells[1] ?? "0");
    const gas   = cells.length > 2 ? parseNum(cells[2] ?? "0") : null;
    const water = cells.length > 3 ? parseNum(cells[3] ?? "0") : null;

    rows.push({
      year,
      month,
      oil_bbl:  oil,
      gas_mcf:  gas   != null && gas   > 0 ? gas   : null,
      water_bbl: water != null && water > 0 ? water : null,
    });
  }

  return rows;
}

// ── Step 1: resolve API → NDIC file number ────────────────────────────────────

async function resolveNdicFileNumber(apiNumber: string): Promise<string | null> {
  const normalized = normalizeNdApiNumber(apiNumber);
  if (!normalized) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(
      `https://www.dmr.nd.gov/oilgas/bakkenwells.asp?f_geoid=&f_wellname=&f_wellnum=&f_api=${encodeURIComponent(normalized)}&f_basin=&f_county=&submitbtn=Submit`,
      {
        signal:  controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MineralFlow/1.0)" },
      },
    );
    clearTimeout(timer);

    if (!res.ok) return null;
    const html = await res.text();

    // Extract the file number from the results — it's typically in a link like
    // /oilgas/productionstats.asp?FILENUM=12345
    const match = html.match(/FILENUM=(\d+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ── Step 2: fetch production by file number ───────────────────────────────────

async function fetchNdicProductionByFileNum(
  fileNum: string,
  apiNumber: string,
  monthsBack: number,
): Promise<NdicProductionResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(
      `https://www.dmr.nd.gov/oilgas/productionstats.asp?FILENUM=${encodeURIComponent(fileNum)}`,
      {
        signal:  controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MineralFlow/1.0)" },
      },
    );
    clearTimeout(timer);

    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 200) return null;

    // Find the main production table
    const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) return null;

    const rows = parseNdicTable(tableMatch[0], monthsBack);
    if (rows.length === 0) return null;

    rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    return {
      api_number:  apiNumber,
      file_number: fileNum,
      rows,
      months_count: rows.length,
      source: "ndic_actual",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function fetchNdicProductionHistory(
  apiNumber: string,
  monthsBack = 36,
): Promise<NdicProductionResult | null> {
  const normalized = normalizeNdApiNumber(apiNumber);
  if (!normalized) return null;

  // Resolve API → file number (NDIC's internal well ID)
  const fileNum = await resolveNdicFileNumber(normalized);
  if (!fileNum) return null;

  return fetchNdicProductionByFileNum(fileNum, normalized, monthsBack);
}

export async function fetchBestNdicProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<NdicProductionResult | null> {
  for (const api of apiNumbers) {
    const result = await fetchNdicProductionHistory(api, monthsBack);
    if (result && result.rows.length > 0) return result;
  }
  return null;
}
