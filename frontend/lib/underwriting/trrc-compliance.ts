/**
 * TRRC compliance & violations lookup.
 *
 * Queries the TRRC EWA violation search for open/closed violations
 * associated with a specific operator or API number.
 *
 * TRRC Violation Query: https://webapps2.rrc.texas.gov/EWA/violationsQueryAction.do
 *
 * Returns empty arrays on failure — callers always label missing data appropriately.
 */

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";
// No timeout — run until TRRC responds.

export type TrrcViolation = {
  violation_id: string | null;
  date: string | null;
  type: string;
  description: string;
  status: "open" | "closed" | "unknown";
  penalty_usd: number | null;
  api_or_lease: string | null;
};

/**
 * Look up TRRC violations for a specific API number (10-digit, no dashes).
 * Returns [] on timeout or error — never throws.
 */
export async function fetchTrrcViolations(
  api10: string,
): Promise<TrrcViolation[]> {
  try {
    const params = new URLSearchParams({
      "searchArgs.apiNumberArg": api10,
      "searchArgs.violationTypeArg": "",
      "searchArgs.violationStatusArg": "",
      "pager.offset": "0",
      "pager.pageSize": "50",
    });

    const res = await fetch(`${EWA_BASE}/violationQueryAction.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0",
      },
      body: params.toString(),
    });

    if (!res.ok) return [];
    const html = await res.text();

    return parseViolationsHtml(html);
  } catch {
    return [];
  }
}

/**
 * Look up TRRC violations by operator name (fuzzy).
 * Only use when no API number is available.
 */
export async function fetchTrrcViolationsByOperator(
  operatorName: string,
  county: string,
): Promise<TrrcViolation[]> {
  try {
    const params = new URLSearchParams({
      "searchArgs.operatorNameArg": operatorName,
      "searchArgs.countyNameArg": county,
      "searchArgs.violationTypeArg": "",
      "searchArgs.violationStatusArg": "",
      "pager.offset": "0",
      "pager.pageSize": "50",
    });

    const res = await fetch(`${EWA_BASE}/violationQueryAction.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0",
      },
      body: params.toString(),
    });

    if (!res.ok) return [];
    const html = await res.text();

    return parseViolationsHtml(html);
  } catch {
    return [];
  }
}

// ─── HTML parser ──────────────────────────────────────────────────────────────

function parseViolationsHtml(html: string): TrrcViolation[] {
  const violations: TrrcViolation[] = [];

  // TRRC violation rows contain: violationId, date, type, description, status
  // The HTML table rows typically look like: <tr><td>V-XXXXX</td><td>MM/DD/YYYY</td>...
  // Match rows with a violation ID pattern
  const rowPattern = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const tagPattern = /<[^>]+>/g;

  const strip = (s: string) => s.replace(tagPattern, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();

  const rows = html.match(rowPattern) ?? [];
  for (const row of rows) {
    const cells: string[] = [];
    let m: RegExpExecArray | null;
    cellPattern.lastIndex = 0;
    while ((m = cellPattern.exec(row)) !== null) {
      cells.push(strip(m[1]));
    }

    if (cells.length < 4) continue;

    // Heuristic: first cell looks like violation ID (V-XXXXX or numeric)
    const id = cells[0];
    if (!/^[VWv\d]/.test(id)) continue;

    // Try to detect status from row or cell content
    const rowLower = row.toLowerCase();
    let status: "open" | "closed" | "unknown" = "unknown";
    if (rowLower.includes("closed") || rowLower.includes("resolved")) status = "closed";
    else if (rowLower.includes("open") || rowLower.includes("active") || rowLower.includes("pending")) status = "open";

    // Try to parse penalty
    let penalty: number | null = null;
    for (const cell of cells) {
      const penaltyMatch = cell.match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (penaltyMatch) {
        penalty = parseFloat(penaltyMatch[1].replace(/,/g, ""));
        break;
      }
    }

    violations.push({
      violation_id: id || null,
      date: cells[1] || null,
      type: cells[2] || "Unknown",
      description: cells[3] || "See TRRC records",
      status,
      penalty_usd: penalty,
      api_or_lease: null,
    });
  }

  return violations;
}
