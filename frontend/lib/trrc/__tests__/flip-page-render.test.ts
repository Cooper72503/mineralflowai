import { it, expect } from "vitest";
import React from "react";
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { writeFileSync } from "fs";
import { FlipAnalysisPage } from "../report-builder";
import { computeFlipAnalysis, DEFAULT_FLIP_ASSUMPTIONS } from "../flip";
import type { PriceDeck } from "../eia-pricing";

function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  return out;
}
const deck: PriceDeck = { source: "user_input", asOf: "2026-09-16", wtiSpotUsdBbl: 70, henryHubUsdMcf: 3, scenarios: { stress: { oilUsdBbl: 56, gasUsdMcf: 3 }, base: { oilUsdBbl: 70, gasUsdMcf: 3 }, strip: { oilUsdBbl: 68, gasUsdMcf: 3 }, upside: { oilUsdBbl: 84, gasUsdMcf: 3 } } };

it("renders the Buy·Optimize·Sell page (populated + unavailable) to PDF without throwing", async () => {
  const oil = generateCurve(3000, 0.08, 0.9, 36).map(Math.round);
  const populated = computeFlipAnalysis({ monthlyOilBbl: oil, monthlyGasMcf: oil.map(() => 0), fieldName: "SPRABERRY (TREND AREA)", county: "MIDLAND" }, deck, 1_200_000,
    { ...DEFAULT_FLIP_ASSUMPTIONS, holdMonths: 24, exitMultipleOfPv10: 0.9, optimizationCapexUsd: 150_000, transactionCostPct: 0.03, levers: { rateUpliftPct: 10, declineReductionPct: 5, loeReductionPct: 10, oilDifferentialImprovementUsdBbl: 1 } });
  const unavailable = computeFlipAnalysis({ monthlyOilBbl: oil, monthlyGasMcf: oil.map(() => 0) }, { ...deck, source: "static_fallback" }, null);
  const run = { id: "render-test", original_input: "42-329-42230", purchase_price: 1_200_000 } as never;
  const id = { apiNumber: "4232942230" } as never;
  const doc = React.createElement(Document, {},
    React.createElement(FlipAnalysisPage, { run, id, flip: populated, generatedAt: new Date().toISOString() }),
    React.createElement(FlipAnalysisPage, { run, id, flip: unavailable, generatedAt: new Date().toISOString() }),
  );
  const buf = await renderToBuffer(doc);
  expect(buf.length).toBeGreaterThan(5000);
  if (process.env.FLIP_PAGE_OUT) writeFileSync(process.env.FLIP_PAGE_OUT, buf);
});
