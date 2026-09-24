/** Connect existing forecast/cash-flow/exit engines; never infer ownership or reserves. */
import {z} from "zod";
import {fitArpsDeclineWindowed} from "../decline-curve";
import {forecastNetCashFlowSeries,monthlyDiscountRate} from "../economics";
import {evaluateFlipCashFlows,evaluateUnpricedCashFlows,DEFAULT_FLIP_ASSUMPTIONS} from "../flip";
const nonnegative=z.number().finite().nonnegative(),fraction=nonnegative.max(1);
const price=z.object({oilUsdBbl:nonnegative,gasUsdMcf:nonnegative}).strict();
export const PortfolioScenarioSchema=z.object({
 basis:z.literal("conditional_assumptions_not_verified_ownership"),
 prices:z.object({base:price,downside:price,upside:price}).strict(),
 workingInterest:fraction,netRevenueInterest:fraction,
 variableLoeUsdPerBoe:nonnegative,workoverReserveUsdPerBoe:nonnegative,
 fixedMonthlyCostsUsd:nonnegative, // total acquired-interest package costs; not per-well
 oilSeveranceFraction:fraction,gasSeveranceFraction:fraction,adValoremFraction:fraction,
 initialCapexUsd:nonnegative,terminalLiabilityUsd:nonnegative,
 holdMonths:z.number().int().min(1).max(600),exitMultipleOfPv10:nonnegative.max(10),sellingCostFraction:fraction,
 requiredAnnualReturn:z.number().finite().min(0).max(5),maxHistoryAgeMonths:z.number().int().min(1).max(24),
 productionScope:z.enum(["oil_only","oil_and_reported_gas"]),
 fixedCostsIncludeWaterHandling:z.literal(true),
}).strict().refine(a=>a.netRevenueInterest<=a.workingInterest,{message:"NRI cannot exceed WI in this operated-interest scenario"});
type Cell={value:number|null};
export interface ScenarioStream {key:string;months:{month:string;volumes:{oil_bbl:Cell;gas_mcf:Cell;casinghead_gas_mcf:Cell}}[]}
const monthIndex=(month:string)=>Number(month.slice(0,4))*12+Number(month.slice(5,7))-1;
function forecastWindow(stream:ScenarioStream,includeGas:boolean){
 const hasGas=(m:ScenarioStream["months"][number])=>m.volumes.gas_mcf.value!==null||m.volumes.casinghead_gas_mcf.value!==null;
 const complete=(m:ScenarioStream["months"][number])=>m.volumes.oil_bbl.value!==null&&(!includeGas||hasGas(m));
 const last=stream.months.map(m=>m.volumes.oil_bbl.value!==null||(includeGas&&hasGas(m))).lastIndexOf(true);
 if(last<0)return {months:[],trailingUnreportedMonths:stream.months.length,excludedEarlierMonths:0};
 let start=last;
 while(start>0&&complete(stream.months[start])&&complete(stream.months[start-1])&&monthIndex(stream.months[start].month)-monthIndex(stream.months[start-1].month)===1)start--;
 return {months:stream.months.slice(start,last+1),trailingUnreportedMonths:stream.months.length-last-1,excludedEarlierMonths:start};
}
export function evaluatePortfolioScenario(streams:ScenarioStream[],raw:unknown,askingPriceUsd:number|null,asOf:string){
 if(!Number.isFinite(Date.parse(asOf))||askingPriceUsd!==null&&(!Number.isFinite(askingPriceUsd)||askingPriceUsd<=0))throw Error("Invalid valuation date or asking price");
 const settings=PortfolioScenarioSchema.parse(raw), reasons:string[]=[];
 const prepared=streams.map(stream=>{
  const {months,trailingUnreportedMonths,excludedEarlierMonths}=forecastWindow(stream,settings.productionScope==="oil_and_reported_gas");
  const oil=months.map(m=>m.volumes.oil_bbl.value);
  const gas=months.map(m=>{
   const a=m.volumes.gas_mcf.value,b=m.volumes.casinghead_gas_mcf.value;
   // One reported gas category is used without declaring the other category zero.
   return a===null?b:b===null?a:a+b;
  });
  const age=months.length?monthIndex(asOf.slice(0,7))-monthIndex(months.at(-1)!.month):Infinity;
  const contiguous=months.every((m,i)=>i===0||monthIndex(m.month)-monthIndex(months[i-1].month)===1);
  if(!contiguous||months.length<6||oil.some(v=>v===null)||settings.productionScope==="oil_and_reported_gas"&&gas.some(v=>v===null))reasons.push(`${stream.key}: at least six contiguous complete phase observations are required.`);
  if(age<1||age>settings.maxHistoryAgeMonths)reasons.push(`${stream.key}: production through ${months.at(-1)?.month??"unknown"} falls outside the explicitly accepted history age.`);
  return {key:stream.key,age,trailingUnreportedMonths,excludedEarlierMonths,through:months.at(-1)?.month??null,input:{monthlyOilBbl:oil as number[],monthlyGasMcf:settings.productionScope==="oil_only"?[]:gas as number[],operating:{workingInterest:settings.workingInterest,netRevenueInterest:settings.netRevenueInterest,variableLoeUsdPerBoe:settings.variableLoeUsdPerBoe,workoverReserveUsdPerBoe:settings.workoverReserveUsdPerBoe,oilSeveranceFraction:settings.oilSeveranceFraction,gasSeveranceFraction:settings.gasSeveranceFraction,adValoremFraction:settings.adValoremFraction}}};
 });
 if(!streams.length)reasons.push("No reconciled lease streams available.");
 const calculated=[];
 if(!reasons.length)for(const [name,prices] of Object.entries(settings.prices)){
  const forecasts=prepared.map(p=>({p,model:forecastNetCashFlowSeries(p.input,prices)}));
  for(const {p,model} of forecasts){
   if(!model.sufficientData||p.input.monthlyOilBbl.some(v=>v>0)&&!model.oilFit||p.input.monthlyGasMcf.some(v=>v>0)&&!model.gasFit)reasons.push(`${p.key}: an included producing phase cannot establish a valid decline forecast.`);
  }
  if(reasons.length)break;
  const shifted=forecasts.map(({p,model})=>({key:p.key,through:p.through,oilFit:model.oilFit,gasFit:model.gasFit,bridgedMonths:p.age,trailingUnreportedMonths:p.trailingUnreportedMonths,excludedEarlierMonths:p.excludedEarlierMonths,cf:model.netCashFlowByMonth.slice(p.age),oil:model.forecastOilByMonth.slice(p.age),gas:model.forecastGasByMonth.slice(p.age)}));
  const horizon=Math.max(0,...shifted.map(f=>f.cf.length));
  if(!horizon){reasons.push("No forecast production remains at the valuation month.");break;}
  const cf=Array.from({length:horizon},(_,i)=>shifted.reduce((sum,f)=>sum+(f.cf[i]??0),0)-settings.fixedMonthlyCostsUsd);
  cf[horizon-1]-=settings.terminalLiabilityUsd;
  const flipSettings={...DEFAULT_FLIP_ASSUMPTIONS,holdMonths:settings.holdMonths,exitMultipleOfPv10:settings.exitMultipleOfPv10,transactionCostPct:settings.sellingCostFraction,optimizationCapexUsd:settings.initialCapexUsd};
  const scenarioName=name==="downside"?"stress":name as "base"|"upside";
  const flip=askingPriceUsd===null?evaluateUnpricedCashFlows(cf,cf,scenarioName,flipSettings):evaluateFlipCashFlows(cf,cf,scenarioName,askingPriceUsd,flipSettings);
  const discount=monthlyDiscountRate(settings.requiredAnnualReturn);
  const hold=Array.from({length:settings.holdMonths},(_,i)=>cf[i]??0);hold[hold.length-1]+=flip.exitProceedsUsd;
  const maximumEntryUsd=hold.reduce((pv,v,i)=>pv+v/Math.pow(1+discount,i+1),0)-settings.initialCapexUsd;
  const remainingGrossOilBbl=shifted.reduce((sum,f)=>sum+f.oil.reduce((a,b)=>a+b,0),0);
  const remainingReportedGasMcf=settings.productionScope==="oil_only"?null:shifted.reduce((sum,f)=>sum+f.gas.reduce((a,b)=>a+b,0),0);
  const result={name,prices,maximumEntryUsd,askingPriceMeetsReturnCriterion:askingPriceUsd===null?null:askingPriceUsd<=maximumEntryUsd,entryPriceReason:askingPriceUsd===null?"No asking price supplied; price comparison, profit, IRR, MOIC and payout are unavailable.":null,remainingGrossOilBbl,remainingReportedGasMcf,netCashFlowByMonth:cf,entryExit:flip,models:shifted.map(({cf,oil,gas,...metadata})=>({...metadata,forecastMonths:oil.map((oilBbl,i)=>({month:new Date(Date.UTC(Number(asOf.slice(0,4)),Number(asOf.slice(5,7))+i,1)).toISOString().slice(0,7),oilBbl,gasMcf:settings.productionScope==="oil_only"?null:gas[i]??null}))}))};
  if([maximumEntryUsd,remainingGrossOilBbl,...cf,...Object.values(flip).filter((v):v is number=>typeof v==="number")].some(v=>!Number.isFinite(v)))throw Error("Nonfinite package economics");
  calculated.push(result);
 }
 return {status:reasons.length?"insufficient_data":"calculated_conditional",settings,reasons,scenarios:reasons.length?[]:calculated,
  inputProvenance:{production:"/production/leaseStreams",assumptions:"/input/scenario",askingPrice:"/input/askingPriceUsd"},
  valuationMonth:asOf.slice(0,7),method:"existing_arps_and_cashflow_engines_sum_unique_streams_then_shared_flip_v1",
  disclosures:["Purchase ceiling and modeled exit do not require an asking price. Entry-dependent returns are withheld when no price is supplied.","Conditional scenario inputs are buyer/model assumptions, not verified title or seller ownership. Uniform WI/NRI is applied across these selected streams only for this scenario.","Prices are explicitly provided realized prices, not a live strip. Oil-only scope excludes gas revenue and gas volumes intentionally.","Existing Arps screening forecast and terminal thresholds are reused. Waterflood intervention or incremental recovery is not predicted; forecast volumes are not certified reserves.","Forecast fitting uses the contiguous complete suffix ending at the last reported month. Earlier disconnected history is retained but excluded from the fit, with excluded month counts disclosed.","Forecasts bridge from each last reported month to the end of the valuation month; historical/unreported bridge cash is excluded from purchase returns.","Fixed costs include water handling and are charged once per package month. Terminal liability is charged at forecast end. Initial capital is charged once at entry.","Exit is remaining model PV-10 at the hold date times the stated multiple less selling cost; it is not an observed market sale price.","Maximum entry discounts hold cash and net exit proceeds at the stated buyer return, less initial capital. Meeting this numeric criterion is not title clearance or a buy recommendation.","IRR uses the existing positive-return solver and is withheld for multiple cash-flow sign changes; null does not imply zero return. No rate-uplift or development upside has been assumed."]};
}

/** Descriptive readiness runs even before a buyer supplies financial assumptions. */
export function assessPortfolioForecastReadiness(streams:ScenarioStream[],asOf:string){
 return streams.map(stream=>{
  const {months:reported,trailingUnreportedMonths,excludedEarlierMonths}=forecastWindow(stream,false);
  const latest=reported.at(-1);
  const values=reported.map(m=>m.volumes.oil_bbl.value);
  const contiguous=reported.every((m,i)=>i===0||monthIndex(m.month)-monthIndex(reported[i-1].month)===1);
  const complete=contiguous&&values.every(v=>v!==null);
  // Same step-change windowing the diligence report and the cash-flow engine
  // use (decline-curve.ts): lease volumes that jump when new wells report are
  // a change in the well count, not a decline. Buttercup's lease rose 4.5x in
  // 2024; the plain fit over the whole history returned no forecast here while
  // the diligence report fit the same lease at R-squared 0.99.
  const windowed=complete?fitArpsDeclineWindowed(values as number[]):null;
  const fit=windowed?.fit??null;
  const reason=!latest?"No reported oil volumes available.":latest.volumes.oil_bbl.value===0?"Last reported oil volume is zero; the existing producing-well decline engine cannot infer a restart rate.":!complete?"Historical oil observations have gaps; calendar time cannot be compressed.":!fit?"Existing decline engine cannot establish a supported producing forecast from these observations.":null;
  return {streamKey:stream.key,latestReportedOilMonth:latest?.month??null,latestReportedOilBbl:latest?.volumes.oil_bbl.value??null,reportingLagMonths:latest?monthIndex(asOf.slice(0,7))-monthIndex(latest.month):null,trailingUnreportedMonths,excludedEarlierMonths:excludedEarlierMonths+(fit?windowed!.monthsExcluded:0),declineWindowNote:fit?windowed!.reason:null,canFitOil:fit!==null,oilFit:fit,reason,productionPointer:"/production/leaseStreams"};
 });
}
