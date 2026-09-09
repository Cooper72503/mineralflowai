/**
 * Tests for generateFlags — specifically the zero-production critical flag,
 * which was found live (running the actual app end to end during TRRC's
 * productionQueryAction.do outage) to fire "NO PRODUCTION RECORDS RETURNED" even
 * when the production query had genuinely failed, not returned a confirmed
 * empty result. That's a materially false claim in a due-diligence report —
 * the same retrieval-failure-vs-confirmed-absence distinction already
 * applied elsewhere in this function (well identity, P-4 gatherer/purchaser)
 * was missing here.
 */

import { describe, it, expect } from "vitest";
import { generateFlags, computeProductionAnalytics } from "../report-builder";
import type { LiteSourceAttempt } from "../coverage";
import type { TrrcDueDiligenceRun } from "../types";

const baseRun = {
  resolved_lease_number: "52210",
  resolved_district: "08",
} as unknown as TrrcDueDiligenceRun;

function attempt(overrides: Partial<LiteSourceAttempt>): LiteSourceAttempt {
  return {
    source_id: "x_0",
    source_name: "x",
    status: "success",
    result_count: 0,
    error_message: null,
    attempted_at: "2026-07-29T21:00:00.000Z",
    result_data_json: null,
    ...overrides,
  };
}

describe("generateFlags — zero-production critical flag", () => {
  it("fires NO PRODUCTION RECORDS RETURNED only when the query genuinely succeeded with no rows", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_production", status: "success", result_data_json: { found: false } }),
    ];
    const analytics = computeProductionAnalytics([]);
    const flags = generateFlags(attempts, analytics, baseRun);

    expect(flags.critical.some(f => f.startsWith("NO PRODUCTION RECORDS RETURNED"))).toBe(true);
    expect(flags.critical.some(f => f.startsWith("PRODUCTION HISTORY COULD NOT BE VERIFIED"))).toBe(false);
  });

  it("does NOT claim zero production on a genuine retrieval failure — reports the real gap instead", () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({
        source_name: "fetch_production",
        status: "failed_transient",
        error_message: "Error: EWA productionQueryAction.do returned a TRRC internal Application Error page",
      }),
    ];
    const analytics = computeProductionAnalytics([]);
    const flags = generateFlags(attempts, analytics, baseRun);

    expect(flags.critical.some(f => f.startsWith("NO PRODUCTION RECORDS RETURNED"))).toBe(false);
    const gapFlag = flags.critical.find(f => f.startsWith("PRODUCTION HISTORY COULD NOT BE VERIFIED"));
    expect(gapFlag).toBeDefined();
    expect(gapFlag).toMatch(/NOT evidence of zero production/);
    expect(gapFlag).toMatch(/Application Error/);
  });

  it("stays silent when production was never attempted at all (no lease/district resolved)", () => {
    const unresolvedRun = { resolved_lease_number: null, resolved_district: null } as unknown as TrrcDueDiligenceRun;
    const analytics = computeProductionAnalytics([]);
    const flags = generateFlags([], analytics, unresolvedRun);

    expect(flags.critical.some(f => f.startsWith("NO PRODUCTION RECORDS RETURNED"))).toBe(false);
    expect(flags.critical.some(f => f.startsWith("PRODUCTION HISTORY COULD NOT BE VERIFIED"))).toBe(false);
  });
});

 describe("production missingness regressions", () => {
   const row = (month: string, oil: number | null, gas: number | null, water: number | null) => ({ production_month: month, oil_bbl: oil, gas_mcf: gas, water_bbl: water, casinghead_gas_mcf: null, condensate_bbl: null }) as import("../types").TrrcDDProductionRow;
   it("does not report unknown water as zero WOR or unknown volumes as zero months", () => {
     const a = computeProductionAnalytics([row("2026-01", 100, null, null), row("2026-02", 100, null, null), row("2026-03", 100, null, null), row("2026-04", null, null, null)]);
     expect(a.currentWOR).toBeNull(); expect(a.zeroMonths).toBe(0);
   });
   it("does not call an incomplete 13-month history a YoY decline", () => {
     const rows = Array.from({length:13}, (_,i) => row(new Date(Date.UTC(2025,i,1)).toISOString().slice(0,7), i === 0 ? 200 : 100, null, null));
     expect(computeProductionAnalytics(rows).yoyDeclineOil).toBeNull();
   });
   it("does not call casinghead gas production a zero-production month", () => {
     expect(computeProductionAnalytics([{...row("2026-01",0,null,null),casinghead_gas_mcf:10}]).zeroMonths).toBe(0);
   });
 });
