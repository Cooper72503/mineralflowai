/**
 * Colorado Oil and Gas Conservation Commission (COGCC / ECMC) Monthly Production Fetcher
 *
 * Uses the Colorado ECMC (Electronic Compliance and Monitoring Center) public
 * production query endpoint.  No API key required.
 *
 * Data source: https://ecmc.state.co.us/cogis/ProductionDetails.asp
 * CO API numbers: 05 + 3-digit county + 5-digit well (10 digits total)
 *
 * Run server-side only.
 */

export type CogccMonthlyRow = {
  year:    number;
  month:   number;   // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
  water_bbl: number | null;
};

export type CogccProductionResult = {
  api_number:   string;
  rows:         CogccMonthlyRow[];
  months_count: number;
  source: "cogcc_actual";
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize a Colorado API number to 10 digits (05 + county(3) + well(5)).
 */
export function normalizeCoApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic") || raw === "unknown") return null;
  const digits = raw.replace(/[-\s]/g, "");
  if (!digits.startsWith("05") || digits.length < 10) return null;
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
    values.push(m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").trim());
  }
  return values;
}

/**
 * Parse COGCC ECMC production HTML.
 * ECMC table format: Prod Date (YYYY-MM) | Oil (BBL) | Gas (MCF) | Water (BBL)
 */
function parseCogccTable(html: string, monthsBack: number): CogccMonthlyRow[] {
  const rows: CogccMonthlyRow[] = [];
  const now    = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  const trParts = html.split(/<\/?tr[^>]*>/i);
  for (const part of trParts) {
    if (!/<td/i.test(part)) continue;
    const cells = extractTdValues(part);
    if (cells.length < 2) continue;

    const dateStr = cells[0].trim();
    let year: number | null = null;
    let month: number | null = null;

    // Try YYYY-MM
    const iso = dateStr.match(/^(\d{4})-(\d{1,2})$/);
    if (iso) { year = parseInt(iso[1]); month = parseInt(iso[2]); }

    // Try MM/YYYY
    if (!year) {
      const slash = dateStr.match(/^(\d{1,2})\/(\d{4})$/);
      if (slash) { month = parseInt(slash[1]); year = parseInt(slash[2]); }
    }

    // Try Mon YYYY (e.g. "Jan 2024")
    if (!year) {
      const mon = dateStr.match(/^([A-Za-z]{3})\s+(\d{4})$/);
      if (mon) {
        const MONTHS: Record<string, number> = {
          jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
          jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
        };
        month = MONTHS[mon[1].toLowerCase()];
        year  = parseInt(mon[2]);
      }
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

// ── Main fetcher ──────────────────────────────────────────────────────────────

/**
 * Fetch monthly production from Colorado COGCC ECMC for a single API number.
 *
 * ECMC production detail URL accepts a well_id derived from the 10-digit API.
 * CO uses the format: county(3) + sequence(5) + suffix(2) as the ECMC well_id.
 */
export async function fetchCogccProductionHistory(
  apiNumber: string,
  monthsBack = 36,
): Promise<CogccProductionResult | null> {
  const normalized = normalizeCoApiNumber(apiNumber);
  if (!normalized) return null;

  try {
    // ECMC production details — wellId is the 8-digit county+well portion (API without state code)
    const wellId = normalized.slice(2); // strip "05" state prefix → 8 digits

    const res = await fetch(
      `https://ecmc.state.co.us/cogis/ProductionDetails.asp?api_no=${encodeURIComponent(normalized)}&well_id=${encodeURIComponent(wellId)}&ogfldfmt=1`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MineralFlow/1.0)",
          "Accept":     "text/html,application/xhtml+xml",
          "Referer":    "https://ecmc.state.co.us/cogis/",
        },
      },
    );

    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 200) return null;

    // Find production data table
    const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) return null;

    const rows = parseCogccTable(tableMatch[0], monthsBack);
    if (rows.length === 0) return null;

    rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    return {
      api_number:   normalized,
      rows,
      months_count: rows.length,
      source:       "cogcc_actual",
    };
  } catch {
    return null;
  }
}

export async function fetchBestCogccProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<CogccProductionResult | null> {
  for (const api of apiNumbers) {
    const result = await fetchCogccProductionHistory(api, monthsBack);
    if (result && result.rows.length > 0) return result;
  }
  return null;
}
