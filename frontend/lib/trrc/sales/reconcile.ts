/**
 * Seller-supplied run statements against TRRC's reported production.
 *
 * A month TRRC has no report for takes the statement's volume, labeled as
 * seller-supplied. A month TRRC did report keeps TRRC's volume; when the
 * statement disagrees beyond the tolerance (sales and production differ by
 * tank inventory, never by much) the month is flagged, not overwritten.
 */
import type { TrrcDDProductionRow } from "../types";
import type { RunStatementRow } from "./run-statements";

export interface SellerMonth {
  month: string;
  oilBbl: number;
  grossUsd: number;
  avgPriceUsdBbl: number | null;
  /** TRRC's reported oil for the month; null when no report was filed. */
  trrcOilBbl: number | null;
  /** filled: TRRC had no report and the statement is used. agrees / differs: TRRC's volume is kept. */
  basis: "filled" | "agrees" | "differs";
  purchaser: string | null;
  sourceIds: string[];
}

/** Sales may lag production by a tank's inventory; beyond this share of the larger volume, the two disagree. */
export const SALES_PRODUCTION_TOLERANCE = 0.15;

export function overlaySellerSales(production: TrrcDDProductionRow[], statements: { row: RunStatementRow; sourceId: string }[]): { production: TrrcDDProductionRow[]; months: SellerMonth[] } {
  // One volume per month: separate uploads of the same statement carry the same row.
  const byMonth = new Map<string, { row: RunStatementRow; sourceIds: string[] }>();
  for (const s of statements) {
    const prior = byMonth.get(s.row.salesMonth);
    if (!prior) byMonth.set(s.row.salesMonth, { row: s.row, sourceIds: [s.sourceId] });
    else { prior.sourceIds = [...new Set([...prior.sourceIds, s.sourceId])]; if (s.row.netBbl > prior.row.netBbl) prior.row = s.row; }
  }
  const rows = production.map(r => ({ ...r }));
  const months: SellerMonth[] = [];
  for (const [month, { row, sourceIds }] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    let target = rows.find(r => r.production_month.slice(0, 7) === month);
    const trrc = typeof target?.oil_bbl === "number" ? target.oil_bbl : null;
    let basis: SellerMonth["basis"];
    if (trrc === null) {
      if (!target) {
        target = { ...(rows[0] ?? {}), production_month: month, oil_bbl: null, gas_mcf: null, casinghead_gas_mcf: null, condensate_bbl: null, water_bbl: null } as TrrcDDProductionRow;
        rows.push(target);
      }
      target.oil_bbl = row.netBbl;
      basis = "filled";
    } else {
      basis = Math.abs(trrc - row.netBbl) <= Math.max(5, SALES_PRODUCTION_TOLERANCE * Math.max(trrc, row.netBbl)) ? "agrees" : "differs";
    }
    months.push({ month, oilBbl: row.netBbl, grossUsd: row.grossUsd, avgPriceUsdBbl: row.avgPriceUsdBbl, trrcOilBbl: trrc, basis, purchaser: row.purchaser, sourceIds });
  }
  rows.sort((a, b) => a.production_month.localeCompare(b.production_month));
  return { production: rows, months };
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (ym: string) => `${MONTH[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const span = (ms: string[]) => ms.length === 1 ? label(ms[0]) : `${label(ms[0])}–${label(ms[ms.length - 1])}`;
const bbl = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const purchaserOf = (ms: SellerMonth[]) => [...new Set(ms.map(m => m.purchaser).filter(Boolean))].join(", ") || "The purchaser";

/** The statement-filled months, as a finding. */
export function filledSentence(months: SellerMonth[]): string | null {
  const filled = months.filter(m => m.basis === "filled");
  if (!filled.length) return null;
  const total = filled.reduce((s, m) => s + m.oilBbl, 0);
  return `${purchaserOf(filled)} run statements show ${bbl(total)} bbl of oil sold ${span(filled.map(m => m.month))} (${filled.length} month${filled.length === 1 ? "" : "s"}, averaging ${bbl(total / filled.length)} bbl), months for which the operator filed no production report with TRRC. The statements are used for those months; the missing reports are a compliance exposure.`;
}

/** Months where the statement and TRRC's report disagree, as a finding. */
export function differsSentence(months: SellerMonth[]): string | null {
  const differs = months.filter(m => m.basis === "differs");
  if (!differs.length) return null;
  return `Run statements disagree with TRRC's reported production: ${differs.map(m => `${label(m.month)} statement ${bbl(m.oilBbl)} bbl, TRRC ${bbl(m.trrcOilBbl ?? 0)} bbl`).join("; ")}. TRRC's volumes are kept; reconcile with the operator and purchaser.`;
}
