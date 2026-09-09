/** Render the existing PDF for every captured API with deterministic unavailable
 * responses for uncaptured dependencies. This tests rendering, not GOLD parity. */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import type { LiteSourceAttempt } from "../coverage";
import { deriveCoverageFromAttempts } from "../coverage";
import type { TrrcDueDiligenceRun, TrrcDDProductionRow } from "../types";
vi.mock("../maps-builder",()=>({fetchStaticMapImage:vi.fn(async()=>null)}));
vi.mock("../offset-wells",()=>({fetchOffsetWells:vi.fn(async()=>[])}));
vi.mock("../lateral-path",()=>({fetchLateralPath:vi.fn(async()=>null)}));
vi.mock("../offset-analytics",()=>({runOffsetAnalytics:vi.fn(async()=>{throw Error("No captured offset adapter response");})}));
vi.mock("../geology",()=>({runGeologicalDueDiligence:vi.fn(async()=>null)}));
vi.mock("../eia-pricing",()=>({getPriceDeck:vi.fn(async()=>({source:"static_fallback",asOf:"unavailable",wtiSpotUsdBbl:70,henryHubUsdMcf:3,scenarios:Object.fromEntries(["base","stress","strip","upside"].map(k=>[k,{oilUsdBbl:70,gasUsdMcf:3}]))}))}));
import { buildTrrcPdfReport } from "../report-builder";
const captured=JSON.parse(readFileSync(new URL("../../../../benchmarks/latest-retrieval.json",import.meta.url),"utf8")) as {cases:{case:{id:string;api10:string};attempts:LiteSourceAttempt[]}[]};
describe("captured API benchmark: existing PDF render compatibility",()=>{
 it.each(captured.cases)("$case.id renders with unavailable downstream inputs",{timeout:30000},async c=>{
  const payload=c.attempts.find(a=>a.source_name==="fetch_production")!.result_data_json!;
  const run={id:c.case.id,user_id:"test",original_input:c.case.api10,normalized_input:c.case.api10,status:"complete",selected_input_type:"api_number",detected_input_type:"api_number",resolved_primary_api:null,resolved_lease_number:payload.lease_number??null,resolved_district:payload.district??null,started_at:"2026-09-09T00:00:00Z",completed_at:"2026-09-09T01:00:00Z",purchase_price:null} as TrrcDueDiligenceRun;
  const production=(Array.isArray(payload.rows)?payload.rows:[]).map((r:Record<string,unknown>)=>({...r,production_month:`${r.production_month}-01`,entity_type:"lease",lease_number:payload.lease_number,district:payload.district})) as TrrcDDProductionRow[];
  const pdf=await buildTrrcPdfReport(run,{} as never,[],{} as never,production,deriveCoverageFromAttempts(c.attempts),c.attempts);
  expect(pdf.subarray(0,5).toString()).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(10000);
 });
});
