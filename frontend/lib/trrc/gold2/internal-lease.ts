/** MineralFlow's own RRC lease screening; never a partner or well allocation. */
import {forecastToTerminalRate} from "../decline-curve";
import {z} from "zod";
import {buildPortfolioRecord,type RetainedRun} from "../portfolio/record";
import {PortfolioScenarioSchema} from "../portfolio/scenario";
export const InternalLeaseSettings=z.object({askingPriceUsd:z.number().finite().positive().nullable(),scenario:PortfolioScenarioSchema}).strict();
export function buildInternalLeaseAnalysis(run:RetainedRun,asOf:string,raw?:unknown){
 const settings=raw==null?null:InternalLeaseSettings.parse(raw);
 // Persisted runs use UUIDs. Legacy/imported records without one remain readable.
 if(!z.string().uuid().safeParse(run.id).success)return {status:"insufficient_data" as const,reason:"A retained run UUID is required to trace lease screening evidence.",record:null,oilForecasts:[]};
 const record=buildPortfolioRecord({members:[{input:run.original_input,runId:run.id}],claimedWellCount:1,askingPriceUsd:settings?.askingPriceUsd??null,...(settings?{scenario:settings.scenario}:{})},[run],asOf);
 const maxAge=settings?.scenario.maxHistoryAgeMonths??6;
 const oilForecasts=record.forecastReadiness.map(r=>{
  const reason=r.reason??(r.reportingLagMonths===null||r.reportingLagMonths<1||r.reportingLagMonths>maxAge?"Reporting lag exceeds the accepted screening window.":null);
  const points=!reason&&r.oilFit?forecastToTerminalRate(r.oilFit).slice(r.reportingLagMonths!):[];
  const months=points.map((p,i)=>({month:new Date(Date.UTC(Number(asOf.slice(0,4)),Number(asOf.slice(5,7))+i,1)).toISOString().slice(0,7),oilBbl:p.rate}));
  return {streamKey:r.streamKey,status:months.length?"calculated":"insufficient_data",reason:reason??(months.length?null:"No modeled oil remains beyond the valuation month."),months,remainingOilBbl:months.length?months.reduce((s,p)=>s+p.oilBbl,0):null,
   maxHistoryAgeMonths:maxAge,method:"existing_arps_gross_lease_oil_screening_v1",evidencePointer:"/internalLease/record/production/leaseStreams",
   disclosure:"Gross lease oil screening, not certified reserves or subject-well allocation. Existing model uses 150 bbl/month terminal rate, 480-month cap and terminal exponential decline of 8%/year. A six-month reporting-age limit is used unless explicitly supplied; intervening modeled months through the valuation month are excluded."};
 });
 return {status:"evaluated" as const,reason:null,record,oilForecasts};
}
