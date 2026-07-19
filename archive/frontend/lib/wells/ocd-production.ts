/**
 * New Mexico Oil Conservation Division (OCD / EMNRD) Monthly Production Fetcher
 *
 * Uses the NM OCD public IDRPS (Integrated Data Repository and Processing System)
 * production query endpoint.  No API key required.
 *
 * Data source: https://wwwapps.emnrd.nm.gov/ocd/ocdpermitting/Data/Production/
 * NM API numbers: 30 + 3-digit county + 5-digit well (10 digits total)
 *
 * Run server-side only.
 */

export type OcdMonthlyRow = {
  year:    number;
  month:   number;   // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
  water_bbl: number | null;
};

export type OcdProductionResult = {
  api_number:   string;
  rows:         OcdMonthlyRow[];
  months_count: number;
  source: "ocd_actual";
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize a New Mexico API number to 10 digits (30 + county(3) + well(5)).
 */
export function normalizeNmApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic") || raw === "unknown") return null;
  const digits = raw.replace(/[-\s]/g, "");
  if (!digits.startsWith("30") || digits.length < 10) return null;
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
 * Parse OCD production HTML table.
 * NM OCD format: Date (MM/YYYY) | Oil (BBL) | Gas (MCF) | Water (BBL)
 */
function parseOcdTable(html: string, monthsBack: number): OcdMonthlyRow[] {
  const rows: OcdMonthlyRow[] = [];
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

    // Try MM/YYYY
    const slash = dateStr.match(/^(\d{1,2})\/(\d{4})$/);
    if (slash) { month = parseInt(slash[1]); year = parseInt(slash[2]); }

    // Try YYYY-MM
    if (!year) {
      const iso = dateStr.match(/^(\d{4})-(\d{1,2})$/);
      if (iso) { year = parseInt(iso[1]); month = parseInt(iso[2]); }
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
 * Fetch monthly production from NM OCD IDRPS for a single API number.
 *
 * OCD query endpoint uses the 10-digit API number (with state prefix 30).
 * Their production report covers oil, gas, and water volumes.
 */
export async function fetchOcdProductionHistory(
  apiNumber: string,
  monthsBack = 36,
): Promise<OcdProductionResult | null> {
  const normalized = normalizeNmApiNumber(apiNumber);
  if (!normalized) return null;

  try {
    // NM OCD IDRPS production query
    // The API number is submitted without dashes as a 10-digit string.
    const params = new URLSearchParams({
      api_no:    normalized,
      rpt_type:  "PRODUCTION",
      submitbtn: "Submit",
    });

    const res = await fetch(
      `https://wwwapps.emnrd.nm.gov/ocd/ocdpermitting/Data/Production/Production.aspx?${params}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MineralFlow/1.0)",
          "Accept":     "text/html,application/xhtml+xml",
        },
      },
    );

    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 200) return null;

    const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) return null;

    const rows = parseOcdTable(tableMatch[0], monthsBack);
    if (rows.length === 0) return null;

    rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    return {
      api_number:   normalized,
      rows,
      months_count: rows.length,
      source:       "ocd_actual",
    };
  } catch {
    return null;
  }
}

export async function fetchBestOcdProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<OcdProductionResult | null> {
  for (const api of apiNumbers) {
    const result = await fetchOcdProductionHistory(api, monthsBack);
    if (result && result.rows.length > 0) return result;
  }
  return null;
}
