/** Prove the economics/flip math runs on the real Buttercup series once a
 *  non-placeholder price deck is present — the only remaining gate. Uses a
 *  user_input deck so no credential is involved. */
import { createClient } from "@supabase/supabase-js";
import { computeProductionAnalytics } from "../lib/trrc/report-builder";
import { reportedProductionSeries } from "../lib/trrc/production-series";
import { computeEconomics } from "../lib/trrc/economics";
import { computeFlipAnalysis } from "../lib/trrc/flip";
import type { PriceDeck } from "../lib/trrc/eia-pricing";

const USER_ID = "f015f547-5b7a-4b78-ac29-6572aa9b3d54";
const RUN_ID = process.argv[2] ?? "c0a6fc7e-7473-4530-8b39-982205ece57f";

const deck: PriceDeck = {
  source: "user_input", asOf: "2026-09-22", wtiSpotUsdBbl: 70, henryHubUsdMcf: 3.0,
  scenarios: {
    stress: { oilUsdBbl: 52.5, gasUsdMcf: 2.25 },
    base:   { oilUsdBbl: 70,   gasUsdMcf: 3.0 },
    strip:  { oilUsdBbl: 70,   gasUsdMcf: 3.0 },
    upside: { oilUsdBbl: 87.5, gasUsdMcf: 3.75 },
  },
} as PriceDeck;

async function main() {
  const db = createClient(process.env["NEXT_PUBLIC_SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!);
  const { data, error } = await db.from("trrc_production_monthly").select("*").eq("run_id", RUN_ID);
  if (error) throw new Error(error.message);
  void USER_ID;
  const analytics = computeProductionAnalytics((data ?? []) as never);
  const reported = reportedProductionSeries(analytics.months as never);
  const econ = computeEconomics(reported.oil, reported.gas, deck, null, "MIDLAND", analytics.months.map(m => m.water_bbl), null);
  const flip = computeFlipAnalysis(
    { monthlyOilBbl: reported.oil, monthlyGasMcf: reported.gas, fieldName: null, county: "MIDLAND", monthlyWaterBbl: analytics.months.map(m => m.water_bbl) },
    deck, null,
  );
  console.log(JSON.stringify({
    months: analytics.months.length,
    oilPoints: reported.oil.length,
    lastReported: reported.oilLastReportedMonth,
    trailingUnreported: reported.trailingUnreportedOilMonths,
    declineWindowNote: econ.declineWindowNote,
    econ: {
      sufficientData: econ.sufficientData, unavailableReason: econ.unavailableReason,
      scenarios: (econ.scenarios ?? []).map(s => ({ scenario: s.scenario, pv10: Math.round(s.pv10), pv15: Math.round(s.pv15), netCf: Math.round(s.netCashFlow) })),
    },
    flip: {
      sufficientData: flip.sufficientData, unavailableReason: flip.unavailableReason, entryBasis: flip.entryBasis,
      holdMonths: flip.assumptions?.holdMonths,
      scenarios: (flip.scenarios ?? []).map(s => ({ scenario: s.scenario, entry: Math.round(s.entryUsd), exit: Math.round(s.exitProceedsUsd), profit: Math.round(s.profitUsd), moic: s.moic, irr: s.irrAnnualPct })),
      levers: (flip.leverSensitivity ?? []).map(l => ({ lever: l.lever, deltaPv10: Math.round(l.deltaPv10Usd) })),
    },
  }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
