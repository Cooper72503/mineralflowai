import {it,expect} from "vitest";
import {assembleGold2Draft,validateGold2Draft} from "../gold2/assemble";
import {buildPortfolioRecord,type RetainedRun} from "../portfolio/record";
import {buildPackageDecision} from "../gold2/package-decision";
import type {LiteSourceAttempt} from "../coverage";
const asOf="2026-09-22T00:00:00Z";
const scenario={basis:"conditional_assumptions_not_verified_ownership",prices:{base:{oilUsdBbl:65,gasUsdMcf:3},downside:{oilUsdBbl:50,gasUsdMcf:2},upside:{oilUsdBbl:80,gasUsdMcf:4}},workingInterest:1,netRevenueInterest:.8,variableLoeUsdPerBoe:5,workoverReserveUsdPerBoe:1,fixedMonthlyCostsUsd:1000,oilSeveranceFraction:.046,gasSeveranceFraction:.075,adValoremFraction:.02,initialCapexUsd:10000,terminalLiabilityUsd:20000,holdMonths:24,exitMultipleOfPv10:1,sellingCostFraction:.05,requiredAnnualReturn:.15,maxHistoryAgeMonths:6,productionScope:"oil_only",fixedCostsIncludeWaterHandling:true};
function run(n:number):RetainedRun{
 const api=`42165${String(n).padStart(5,"0")}`;
 const attempt=(source:string,data:unknown):LiteSourceAttempt=>({source_id:source,source_name:source,status:"success",attempted_at:"2026-09-21T00:00:00Z",result_count:1,error_message:null,result_data_json:data as Record<string,unknown>});
 return {id:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,original_input:api,status:"complete",attempts:[attempt("search_by_api",{found:true,wells:[{api_no:api,lease_no:"10001",district:"8A",on_schedule:"Y"}]}),attempt("fetch_production",{found:true,lease_number:"10001",district:"8A",query_url:"https://webapps2.rrc.texas.gov/EWA/productionQueryAction.do",lease_type_attempts:[{lease_type:"O",status:"found"}],rows:Array.from({length:12},(_,i)=>({production_month:new Date(Date.UTC(2025,8+i,1)).toISOString().slice(0,10),oil_bbl:3000*Math.exp(-.02*i),gas_mcf:null,casinghead_gas_mcf:20,condensate_bbl:null,water_bbl:null}))})]};
}
function draft(r:RetainedRun,settings?:unknown){return assembleGold2Draft({api:r.original_input,runId:r.id,asOf,attempts:r.attempts,title:null,position:null,partner:null,reconciliationPolicy:null,economics:null,internalLeaseSettings:settings});}
it("delivers own lease forecast, cashflow and exit in GOLD without a partner feed",()=>{
 const d=draft(run(1),{scenario,askingPriceUsd:100000});
 expect(d.internalLease.record?.conditionalEconomics?.status).toBe("calculated_conditional");
 expect(d.internalLease.record?.conditionalEconomics?.scenarios[0].maximumEntryUsd).toBeGreaterThan(0);
 expect(d.fields["economics.lease_scenarios"].origin?.pointer).toBe("/internalLease/record/conditionalEconomics");
 expect(d.partner).toBeNull();expect(d.fields["ownership.nri"].value).toBeNull();
 expect(d.decision.posture).toBe("INSUFFICIENT_DATA");expect(validateGold2Draft(d)).toEqual([]);
});
it("fits lease history without invented financial or ownership assumptions",()=>{
 const d=draft(run(1));expect(d.internalLease.record?.forecastReadiness[0].canFitOil).toBe(true);expect(d.internalLease.oilForecasts[0].months[0].month).toBe("2026-10");expect(d.internalLease.oilForecasts[0].remainingOilBbl).toBeGreaterThan(0);
 expect(d.fields["economics.lease_scenarios"].value).toBeNull();expect(d.fields["production.subject_monthly"].value).toBeNull();
});
it("counts shared production and economics once in a single package decision",()=>{
 const runs=[run(1),run(2)];const record=buildPortfolioRecord({members:runs.map(r=>({input:r.original_input,runId:r.id})),claimedWellCount:2,askingPriceUsd:100000,scenario:scenario as never},runs,asOf);
 const result=buildPackageDecision(record,runs.map(r=>({runId:r.id,draft:draft(r)})));
 expect(result.production.leaseStreams).toHaveLength(1);expect(result.title).toHaveLength(2);
 expect(result.economics).toEqual(draft(runs[0],{scenario,askingPriceUsd:100000}).internalLease.record?.conditionalEconomics);
});
it("refuses incomplete membership and modified scenario outputs",()=>{
 const r=run(1),record=buildPortfolioRecord({members:[{input:r.original_input,runId:r.id}],claimedWellCount:1,askingPriceUsd:null},[r],asOf);
 expect(()=>buildPackageDecision(record,[])).toThrow("membership");
 const d=draft(r);d.fields["decision.posture"].value="BUY";
 expect(()=>buildPackageDecision(record,[{runId:r.id,draft:d}])).toThrow("regeneration");
});
it("withholds forecasting for a zero latest oil month rather than inventing a restart",()=>{
 const r=run(1);(r.attempts[1].result_data_json!.rows as {oil_bbl:number}[]).at(-1)!.oil_bbl=0;
 expect(draft(r,{scenario,askingPriceUsd:100000}).internalLease.record?.conditionalEconomics?.status).toBe("insufficient_data");
});

it("renders the integrated lease scenario and linked title sections in one PDF",async()=>{
 const {renderGold2Pdf}=await import("../gold2/pdf");
 const bytes=await renderGold2Pdf(draft(run(1),{scenario,askingPriceUsd:100000}));
 expect(bytes.subarray(0,5).toString()).toBe("%PDF-");expect(bytes.length).toBeGreaterThan(10000);
},30000);
