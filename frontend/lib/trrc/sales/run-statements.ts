/**
 * Purchaser run statements: the oil a purchaser bought from a lease each
 * month, as printed on the statement the seller supplies.
 *
 * Read from the statement's own text: each property block's header (sales
 * month, property, state lease number, county) and its "TOTALS FOR PROPERTY"
 * line, checked against the sum of the block's ticket barrels. A statement
 * repeats a property at each interest level (Energy Transfer prints Level 1
 * and Level 2 pages with the same tickets), so a month is counted once.
 *
 * Live case (2026-10-15): Energy Transfer Crude Marketing statements for
 * ODC SAN ANDRES UNIT (state lease 060509), Apr–Jul 2026, the months the
 * operator filed no production report with TRRC.
 */
import { ALL_COUNTY_NAMES } from "../permit-tracker/county-codes";

export interface RunStatementRow {
  purchaser: string | null;
  propertyNos: string[];
  propertyName: string;
  /** The state lease number as printed ("060509"). */
  stateLease: string | null;
  /** The RRC lease number it names, without leading zeros ("60509"). */
  leaseNumber: string | null;
  county: string | null;
  /** YYYY-MM */
  salesMonth: string;
  netBbl: number;
  grossUsd: number;
  taxesUsd: number;
  netUsd: number;
  avgPriceUsdBbl: number | null;
  /** 1-based pages the block was read from. */
  pages: number[];
  /** Sum of the block's ticket barrels, when tickets were legible. */
  ticketBbl: number | null;
}

export interface ParsedRunStatements {
  rows: RunStatementRow[];
  purchasers: string[];
  pagesWithoutText: number;
  warnings: string[];
}

const money = (s: string) => Number(s.replace(/,/g, ""));
const COUNTIES = [...ALL_COUNTY_NAMES].sort((a, b) => b.length - a.length);

/** The header field before `at` in `text`, or null. */
function lastMatch(text: string, re: RegExp, at: number): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let found: RegExpExecArray | null = null, m: RegExpExecArray | null;
  while ((m = g.exec(text)) && m.index < at) found = m;
  return found;
}

function countyAfter(text: string, at: number): string | null {
  const m = lastMatch(text, /COUNTY:\s*/, at);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 40).toUpperCase();
  return COUNTIES.find(c => rest.startsWith(c) && !/[A-Z]/.test(rest.charAt(c.length))) ?? null;
}

export function parseRunStatements(pages: string[]): ParsedRunStatements {
  const rows: RunStatementRow[] = [];
  const purchasers = new Set<string>();
  const warnings: string[] = [];
  let pagesWithoutText = 0;
  pages.forEach((raw, i) => {
    const text = raw.replace(/ /g, " ").replace(/\s+/g, " ").trim();
    if (text.replace(/[^A-Za-z0-9]/g, "").length < 40) { pagesWithoutText++; return; }
    const purchaser = /REVISED\(Y\/N\):\s*[YN]\s+(.+?)\s+PAGE:/.exec(text)?.[1]?.trim() ?? null;
    if (purchaser) purchasers.add(purchaser);
    const totals = /TOTALS FOR PROPERTY\s+(-?[\d,]+\.\d+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})/g;
    let t: RegExpExecArray | null, blockStart = 0;
    while ((t = totals.exec(text))) {
      const at = t.index;
      const block = text.slice(blockStart, at);
      blockStart = at + t[0].length;
      const month = lastMatch(text, /SALES DATE:\s*(\d{2})\/(\d{4})/, at);
      const name = lastMatch(text, /PROPERTY NAME:\s*(.+?)\s+(?:STATE:|OPERATOR NO:|COUNTY:)/, at);
      if (!month || !name) { warnings.push(`Page ${i + 1}: a property total without a sales month or property name was skipped.`); continue; }
      const stateLease = lastMatch(text, /STATE LEASE:\s*(\d{3,8})/, at)?.[1] ?? null;
      const propertyNo = lastMatch(text, /PROPERTY NO:\s*([\w-]+)/, at)?.[1] ?? null;
      // Tickets: date, ticket number, type, optional adjustment code, tank/meter, net barrels.
      const tickets = [...block.matchAll(/\b\d{2}\/\d{2}\/\d{4}\s+\d{5,}\s+[A-Z]\s+(?:[A-Z0-9]{2}\s+)?\d+\s+(-?[\d,]+\.\d{2})\s/g)];
      const ticketBbl = tickets.length ? Math.round(tickets.reduce((s, x) => s + money(x[1]), 0) * 100) / 100 : null;
      const netBbl = money(t[1]), grossUsd = money(t[2]);
      if (ticketBbl !== null && Math.abs(ticketBbl - netBbl) > 0.05)
        warnings.push(`Page ${i + 1}: ${name[1].trim()} ${month[2]}-${month[1]}: tickets sum to ${ticketBbl} bbl but the property total is ${netBbl} bbl; the printed total is used.`);
      rows.push({
        purchaser, propertyNos: propertyNo ? [propertyNo] : [], propertyName: name[1].trim(),
        stateLease, leaseNumber: stateLease ? String(Number(stateLease)) : null, county: countyAfter(text, at),
        salesMonth: `${month[2]}-${month[1]}`, netBbl, grossUsd, taxesUsd: money(t[3]), netUsd: money(t[4]),
        avgPriceUsdBbl: netBbl > 0 ? Math.round((grossUsd / netBbl) * 100) / 100 : null, pages: [i + 1], ticketBbl,
      });
    }
  });
  // One row per lease and sales month: interest-level repeats carry the same tickets.
  const byKey = new Map<string, RunStatementRow>();
  for (const r of rows) {
    const key = `${r.leaseNumber ?? r.propertyName}|${r.salesMonth}`;
    const prior = byKey.get(key);
    if (!prior) { byKey.set(key, { ...r }); continue; }
    if (Math.abs(prior.netBbl - r.netBbl) > 0.005 || Math.abs(prior.grossUsd - r.grossUsd) > 0.005) {
      warnings.push(`${r.propertyName} ${r.salesMonth}: two statements disagree (${prior.netBbl} vs ${r.netBbl} bbl); the larger volume is kept and both are listed.`);
      if (r.netBbl > prior.netBbl) Object.assign(prior, { netBbl: r.netBbl, grossUsd: r.grossUsd, taxesUsd: r.taxesUsd, netUsd: r.netUsd, avgPriceUsdBbl: r.avgPriceUsdBbl, ticketBbl: r.ticketBbl });
    }
    prior.pages = [...new Set([...prior.pages, ...r.pages])];
    prior.propertyNos = [...new Set([...prior.propertyNos, ...r.propertyNos])];
  }
  const merged = [...byKey.values()].sort((a, b) => (a.leaseNumber ?? a.propertyName).localeCompare(b.leaseNumber ?? b.propertyName) || a.salesMonth.localeCompare(b.salesMonth));
  return { rows: merged, purchasers: [...purchasers], pagesWithoutText, warnings };
}
