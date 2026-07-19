// @ts-nocheck
/**
 * Shared helpers for EWA (Electronic Well Administration) source adapters.
 */

const PROXY_URL = process.env['TRRC_EWA_PROXY_URL'] ?? '/api/trrc/ewa-proxy';
const PROXY_SECRET = process.env['TRRC_EWA_PROXY_SECRET'] ?? '';

export const EWA_BASE = 'https://webapps2.rrc.texas.gov/EWA';

export async function fetchViaProxy(url: string, body: string): Promise<string> {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PROXY_SECRET}`,
    },
    body: JSON.stringify({ url, method: 'POST', body }),
  });
  if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
  const json = await res.json() as { html?: string; error?: string };
  if (json.error) throw new Error(json.error);
  if (!json.html) throw new Error('No HTML from proxy');
  return json.html;
}

export function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function extractTableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rowMatches) {
    const cells: string[] = [];
    const cellMatches = row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
    for (const cell of cellMatches) {
      cells.push(cell[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const NOISE = [/function\s*\(/, /doSearch/, /Please\s+Correct/i, /Search\s+Criteria/i, /Oil\s+&\s+Gas\s+Data/i];

export function isNoise(row: string[]): boolean {
  const s = row.join(' ');
  return row.every(c => !c.trim() || c === '&nbsp;') || NOISE.some(p => p.test(s));
}

export function isHeader(row: string[], minCols = 3): boolean {
  if (row.length < minCols) return false;
  return row.filter(c => c.length > 0 && c.length <= 50 && /API|District|Lease|Operator|Field|County|Well|Aging|Inactive|Orphan|Severance|Potential|Allowable|UIC/i.test(c)).length >= 2;
}

/**
 * Parse EWA table response into an array of row objects keyed by normalized header names.
 * Returns null if no data table found.
 */
export function parseEwaTable(html: string): { header: string[]; rows: Record<string, string>[] } | null {
  const allRows = extractTableRows(html).filter(r => !isNoise(r));
  const hIdx = allRows.findIndex(r => isHeader(r, 3));
  if (hIdx < 0) return null;

  const header = allRows[hIdx];
  const dataRows = allRows.slice(hIdx + 1).filter(r => r.length >= 3 && !isNoise(r));
  if (dataRows.length === 0) return null;

  const rows = dataRows.map(row => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '')] = row[i] ?? '';
    });
    return obj;
  });

  return { header, rows };
}
