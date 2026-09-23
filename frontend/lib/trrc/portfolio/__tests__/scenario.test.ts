import {it,expect} from "vitest";
import {evaluatePortfolioScenario,assessPortfolioForecastReadiness,type ScenarioStream,PortfolioScenarioSchema} from "../scenario";
import {forecastNetCashFlowSeries} from "../../economics";
import {evaluateFlipCashFlows,DEFAULT_FLIP_ASSUMPTIONS} from "../../flip";
const settings={basis:"conditional_assumptions_not_verified_ownership",prices:{base:{oilUsdBbl:65,gasUsdMcf:3},downside:{oilUsdBbl:50,gasUsdMcf:2},upside:{oilUsdBbl:80,gasUsdMcf:4}},workingInterest:1,netRevenueInterest:0.8,variableLoeUsdPerBoe:0,workoverReserveUsdPerBoe:0,fixedMonthlyCostsUsd:40000,oilSeveranceFraction:0.046,gasSeveranceFraction:0.075,adValoremFraction:0.02,initialCapexUsd:100000,terminalLiabilityUsd:50000,holdMonths:24,exitMultipleOfPv10:1,sellingCostFraction:0.05,requiredAnnualReturn:0.15,maxHistoryAgeMonths:6,productionScope:"oil_only",fixedCostsIncludeWaterHandling:true};
function stream(key:string):ScenarioStream{return {key,months:Array.from({length:12},(_,i)=>({month:new Date(Date.UTC(2025,8+i,1)).toISOString().slice(0,7),volumes:{oil_bbl:{value:3000*Math.exp(-0.02*i)},gas_mcf:{value:null},casinghead_gas_mcf:{value:null}}}))};}
it("runs existing forecast and exit formulas at package level, charging entry/capital/fixed costs once",()=>{
 const streams=[stream("A"),stream("B")];const result=evaluatePortfolioScenario(streams,settings,2500000,"2026-09-16");
 expect(result.status).toBe("calculated_conditional");const base=result.scenarios[0];expect(base.entryExit.entryUsd).toBe(2500000);expect(base.entryExit.capexUsd).toBe(100000);
 const one=forecastNetCashFlowSeries({monthlyOilBbl:streams[0].months.map(m=>m.volumes.oil_bbl.value!),monthlyGasMcf:[],operating:{workingInterest:1,netRevenueInterest:.8,variableLoeUsdPerBoe:0,workoverReserveUsdPerBoe:0,oilSeveranceFraction:.046,gasSeveranceFraction:.075,adValoremFraction:.02}},settings.prices.base);
 expect(base.netCashFlowByMonth[0]).toBeCloseTo(one.netCashFlowByMonth[1]*2-40000,6);
 const exit=evaluateFlipCashFlows(base.netCashFlowByMonth,base.netCashFlowByMonth,"base",2500000,{...DEFAULT_FLIP_ASSUMPTIONS,holdMonths:24,optimizationCapexUsd:100000,transactionCostPct:.05});expect(base.entryExit).toEqual(exit);
 const monthly=(1.15**(1/12))-1;const pv=base.netCashFlowByMonth.slice(0,24).reduce((s,c,i)=>s+c/(1+monthly)**(i+1),0)+base.entryExit.exitProceedsUsd/(1+monthly)**24-100000;expect(base.maximumEntryUsd).toBeCloseTo(pv,6);
});
it("applies NRI to revenue and WI to costs rather than scaling net cash by NRI",()=>{
 const series=stream("A").months.map(m=>m.volumes.oil_bbl.value!);
 const f=forecastNetCashFlowSeries({monthlyOilBbl:series,monthlyGasMcf:[],operating:{workingInterest:.5,netRevenueInterest:.4,variableLoeUsdPerBoe:10,workoverReserveUsdPerBoe:2,oilSeveranceFraction:0,gasSeveranceFraction:0,adValoremFraction:0}},settings.prices.base);
 expect(f.netCashFlowByMonth[0]).toBeCloseTo(f.forecastOilByMonth[0]*(65*.4-12*.5),6);
});
it("withholds the whole scenario if any included lease lacks a restart basis",()=>{
 const b=stream("B");b.months.at(-1)!.volumes.oil_bbl.value=0;
 const r=evaluatePortfolioScenario([stream("A"),b],settings,2500000,"2026-09-16");expect(r.status).toBe("insufficient_data");expect(r.scenarios).toEqual([]);
});
it("retains a gap instead of compressing monthly time",()=>{const s=stream("A");s.months.splice(8,1);expect(evaluatePortfolioScenario([s],settings,2500000,"2026-09-16").status).toBe("insufficient_data");});
it("detects stale history even when the source pads it with trailing null months",()=>{const s=stream("A");for(const m of s.months.slice(4))m.volumes.oil_bbl.value=null;const r=evaluatePortfolioScenario([s],settings,2500000,"2026-09-16");expect(r.reasons.join(" ")).toContain("history age");});
it("requires explicit valid interests and assumptions; never defaults to full ownership",()=>{expect(PortfolioScenarioSchema.safeParse({...settings,netRevenueInterest:1.1}).success).toBe(false);const {workingInterest,...missing}=settings;expect(PortfolioScenarioSchema.safeParse(missing).success).toBe(false);});
it("excludes gas only when explicitly selected and labels forecast volumes as non-certified",()=>{const r=evaluatePortfolioScenario([stream("A")],settings,2500000,"2026-09-16");expect(r.scenarios[0].remainingReportedGasMcf).toBeNull();expect(r.disclosures.join(" ")).toContain("not certified reserves");});

it("reports a zero last oil month and padded unreported months before any prices are supplied",()=>{
 const s=stream("A");s.months[9].volumes.oil_bbl.value=0;s.months[10].volumes.oil_bbl.value=null;s.months[11].volumes.oil_bbl.value=null;
 const [r]=assessPortfolioForecastReadiness([s],"2026-09-17");expect(r.latestReportedOilBbl).toBe(0);expect(r.trailingUnreportedMonths).toBe(2);expect(r.canFitOil).toBe(false);expect(r.reason).toContain("restart rate");
});
it("does not create a selling-fee credit when modeled exit value is negative",()=>{
 const r=evaluateFlipCashFlows([100,-1000],[100,-1000],"base",100,{...DEFAULT_FLIP_ASSUMPTIONS,holdMonths:1,transactionCostPct:.1});
 expect(r.exitRemainingPv10Usd).toBeLessThan(0);expect(r.exitProceedsUsd).toBe(r.exitRemainingPv10Usd);
});

it("can use a six-month complete trailing window without compressing an earlier gap",()=>{
 const s=stream("A");s.months[4].volumes.oil_bbl.value=null;
 const r=evaluatePortfolioScenario([s],settings,2500000,"2026-09-16");expect(r.status).toBe("calculated_conditional");expect(r.scenarios[0].models[0].excludedEarlierMonths).toBe(5);expect(r.scenarios[0].models[0].oilFit?.monthsOfHistory).toBe(7);
});

it("calculates purchase ceiling and exit without inventing an asking price or returns",()=>{
 const noPrice=evaluatePortfolioScenario([stream("A")],settings,null,"2026-09-16");
 const priced=evaluatePortfolioScenario([stream("A")],settings,2500000,"2026-09-16");
 expect(noPrice.status).toBe("calculated_conditional");
 for(let i=0;i<3;i++){
  expect(noPrice.scenarios[i].maximumEntryUsd).toBe(priced.scenarios[i].maximumEntryUsd);
  expect(noPrice.scenarios[i].entryExit.exitProceedsUsd).toBe(priced.scenarios[i].entryExit.exitProceedsUsd);
  expect(noPrice.scenarios[i].askingPriceMeetsReturnCriterion).toBeNull();
  expect(noPrice.scenarios[i].entryExit).toMatchObject({entryUsd:null,profitUsd:null,moic:null,irrAnnualPct:null,payoutMonths:null});
 }
});
