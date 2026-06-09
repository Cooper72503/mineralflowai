/**
 * WV DEP Monthly Production Fetcher
 *
 * Single-step HTML scrape of the WV DEP Office of Oil and Gas public well report:
 *   https://apps.dep.wv.gov/oog/wellsearch/wellApi.cfm?api=XXXXXXXXXX
 *
 * The page returns HTML tables ("Well Lifetime Gas Production" and
 * "Well Lifetime Oil Production") with yearly rows: operator | year | Jan…Dec | Total
 *
 * Run server-side only (no CORS issues from Next.js API routes).
 */

const BASE = "https://apps.dep.wv.gov/oog/wellsearch";

// ── types ──────────────────────────────────────────────────────────────────────

export type WvdepMonthlyRow = {
  year:    number;
  month:   number;  // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
};

export type WvdepProductionResult = {
  api_number:   string;
  rows:         WvdepMonthlyRow[];
  months_count: number;
  source: "wvdep_actual";
};

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalise a WV API number to a clean 10-digit string (47 + county(3) + well(5)).
 * Accepts dashed ("47-006-10181-0000") or plain ("4706101819") formats.
 */
export function normalizeWvApiNumber(raw: string): string | null {
  if (!raw || raw.startsWith("synthetic") || raw === "unknown") return null;
  const digits = raw.replace(/[-\s]/g, "");
  if (!digits.startsWith("47") || digits.length < 10) return null;
  return digits.slice(0, 10);
}

/** Strip commas/whitespace and parse a number. */
function parseNum(s: string): number {
  return parseFloat(s.replace(/[,\s]/g, "").trim()) || 0;
}

/** Extract all text content from <td>…</td> cells in an HTML fragment. */
function extractTdValues(rowHtml: string): string[] {
  const values: string[] = [];
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = tdRegex.exec(rowHtml)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, "")           // strip inner tags
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .trim();
    values.push(text);
  }
  return values;
}

/**
 * Parse a "yearly" production table (Operator | Year | Jan…Dec | Total).
 * Returns a map of "YYYY-MM" → production value.
 */
function parseYearlyTable(tableHtml: string, monthsBack: number): Record<string, number> {
  const result: Record<string, number> = {};
  const now    = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - monthsBack);

  // Split on <tr> boundaries
  const trParts = tableHtml.split(/<\/?tr[^>]*>/i);

  for (const part of trParts) {
    // Only process rows that have <td> cells (skip <th> header rows)
    if (!/<td/i.test(part)) continue;

    const tds = extractTdValues(part);
    // Need at least: operator(0) + year(1) + 12 months(2–13) = 14 cols
    if (tds.length < 14) continue;

    const year = parseInt(tds[1], 10);
    if (isNaN(year) || year < 1950 || year > 2100) continue;

    // Columns 2–13 are Jan–Dec
    for (let i = 0; i < 12; i++) {
      const month     = i + 1;
      const monthDate = new Date(year, i, 1);
      if (monthDate < cutoff) continue;

      const val = parseNum(tds[2 + i]);
      if (val > 0) {
        const key = `${year}-${String(month).padStart(2, "0")}`;
        result[key] = val;
      }
    }
  }

  return result;
}

/**
 * Find the first <table>…</table> that appears after a heading containing `heading`.
 * Case-insensitive.
 */
function findTableAfterHeading(html: string, heading: string): string | null {
  const lowerHtml    = html.toLowerCase();
  const lowerHeading = heading.toLowerCase();
  const idx          = lowerHtml.indexOf(lowerHeading);
  if (idx === -1) return null;

  const after     = html.slice(idx);
  const tableMatch = after.match(/<table[\s\S]*?<\/table>/i);
  return tableMatch ? tableMatch[0] : null;
}

// ── public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch the last `monthsBack` months of actual WV DEP production for an API number.
 * Returns null if the API number is invalid, synthetic, or the service is unreachable.
 */
export async function fetchWvdepProductionHistory(
  apiNumber: string,
  monthsBack = 36,
): Promise<WvdepProductionResult | null> {
  const normalized = normalizeWvApiNumber(apiNumber);
  if (!normalized) return null;

  try {
    const res = await fetch(`${BASE}/wellApi.cfm?api=${normalized}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MineralFlow/1.0)" },
    });

    if (!res.ok) return null;
    const html = await res.text();

    // Locate the gas and oil production tables by heading text
    const gasTable = findTableAfterHeading(html, "Well Lifetime Gas Production");
    const oilTable = findTableAfterHeading(html, "Well Lifetime Oil Production");

    if (!gasTable && !oilTable) return null;

    const gasData = gasTable ? parseYearlyTable(gasTable, monthsBack) : {};
    const oilData = oilTable ? parseYearlyTable(oilTable, monthsBack) : {};

    // Merge: any month with non-zero gas OR oil gets a row
    const allKeysArr = Array.from(new Set([...Object.keys(gasData), ...Object.keys(oilData)]));
    const rows: WvdepMonthlyRow[] = [];

    for (const key of allKeysArr) {
      const [yearStr, monthStr] = key.split("-");
      const oil = oilData[key] ?? 0;
      const gas = gasData[key] ?? 0;

      rows.push({
        year:    parseInt(yearStr, 10),
        month:   parseInt(monthStr, 10),
        oil_bbl: oil,
        gas_mcf: gas > 0 ? gas : null,
      });
    }

    if (rows.length === 0) return null;

    rows.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

    return {
      api_number:   normalized,
      rows,
      months_count: rows.length,
      source:       "wvdep_actual",
    };
  } catch {
    return null;
  }
}

/**
 * Try each API number in order, return the first one that yields production data.
 */
export async function fetchBestWvdepProduction(
  apiNumbers: string[],
  monthsBack = 36,
): Promise<WvdepProductionResult | null> {
  for (const api of apiNumbers) {
    if (!normalizeWvApiNumber(api)) continue;
    const result = await fetchWvdepProductionHistory(api, monthsBack);
    if (result) return result;
  }
  return null;
}
