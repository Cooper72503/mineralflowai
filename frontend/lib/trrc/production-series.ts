import type { TrrcDDProductionRow } from "./types";

/** Arps consumes equally spaced months. Missing observations cannot be zeros. */
export function productionSeries(rows: TrrcDDProductionRow[]) {
  const sorted = [...rows].sort((a, b) => a.production_month.localeCompare(b.production_month));
  const months = sorted.map(r => r.production_month.slice(0, 7));
  const contiguous = months.every((m, i) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && (i === 0 ||
    Date.parse(m + "-01") === Date.UTC(Number(months[i - 1].slice(0, 4)), Number(months[i - 1].slice(5, 7)), 1)));
  const complete = (values: (number | null)[]) => contiguous && values.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0) ? values as number[] : [];
  const gas = sorted.map(r => {
    const values = [r.gas_mcf, r.casinghead_gas_mcf].filter((v): v is number => typeof v === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  });
  return { oil: complete(sorted.map(r => r.oil_bbl)), gas: complete(gas), contiguous };
}


/**
 * Per-phase series over the REPORTED window only: leading and trailing months
 * with no reported volume for that phase are trimmed before the strict
 * productionSeries() contiguity/completeness check runs. TRRC posts lease
 * production with a 2–3 month lag, so a fresh run always ends in null rows;
 * productionSeries() correctly refuses to treat those as zero, but discarding
 * the whole series for it meant Section 5 and the interactive economics were
 * "insufficient data" on every current well (live-observed 2026-09-21 on
 * 42-329-42230: 46 reported months, 3 trailing nulls, no fit). Interior
 * gaps stay fatal exactly as before. This is the same trimming the GOLD
 * production contract (gold/assemble.ts) already applies; the two must not
 * drift.
 */
export function reportedProductionSeries(rows: TrrcDDProductionRow[]) {
  const sorted = [...rows].sort((a, b) => a.production_month.localeCompare(b.production_month));
  const window = (phase: "oil" | "gas") => {
    const reported = (r: TrrcDDProductionRow) => phase === "oil"
      ? typeof r.oil_bbl === "number"
      : typeof r.gas_mcf === "number" || typeof r.casinghead_gas_mcf === "number";
    let trimmed = sorted;
    let leading = 0, trailing = 0;
    while (trimmed.length && !reported(trimmed[0])) { trimmed = trimmed.slice(1); leading++; }
    while (trimmed.length && !reported(trimmed[trimmed.length - 1])) { trimmed = trimmed.slice(0, -1); trailing++; }
    return {
      series: productionSeries(trimmed)[phase],
      lastReportedMonth: trimmed.length ? trimmed[trimmed.length - 1].production_month.slice(0, 7) : null,
      leadingUnreportedMonths: leading,
      trailingUnreportedMonths: trailing,
    };
  };
  const oil = window("oil"), gas = window("gas");
  return {
    oil: oil.series, gas: gas.series,
    oilLastReportedMonth: oil.lastReportedMonth, gasLastReportedMonth: gas.lastReportedMonth,
    trailingUnreportedOilMonths: oil.trailingUnreportedMonths, trailingUnreportedGasMonths: gas.trailingUnreportedMonths,
  };
}

import { latestSourceAttempts, type LiteSourceAttempt } from "./coverage";
/** Read models must not resurrect stale rows after a failed refresh. */
export function currentProduction(rows: TrrcDDProductionRow[], attempts: LiteSourceAttempt[]): TrrcDDProductionRow[] {
  const attempt = latestSourceAttempts(attempts).find(a => a.source_name === "fetch_production");
  const data = attempt?.result_data_json;
  if (attempt?.status !== "success" || !data || data.error || data.data_gap || data.found !== true || !Array.isArray(data.rows)) return [];
  const volumes = ["oil_bbl", "gas_mcf", "casinghead_gas_mcf", "condensate_bbl", "water_bbl"] as const;
  return rows.filter(row => row.entity_type === "lease" && row.lease_number === data.lease_number && row.district === data.district &&
    (data.rows as Record<string, unknown>[]).some(raw => typeof raw.production_month === "string" && raw.production_month.slice(0,7) === row.production_month.slice(0,7) &&
      volumes.every(key => (raw[key] ?? null) === (row[key] ?? null))));
}
