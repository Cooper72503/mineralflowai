import { buildDecisionRecord, validateDecisionRecord, type DecisionRecord, type Citation } from "../decision-record";
import { deriveCoverageFromAttempts, type LiteSourceAttempt } from "../coverage";
import { fitArpsDecline, forecastToTerminalRate, type DeclineCurveFit } from "../decline-curve";
import { productionSeries } from "../production-series";
import type { TrrcDueDiligenceRun, TrrcDDProductionRow, SourceCoverageStatus } from "../types";
import { GOLD_SECTIONS } from "./sections";

export interface ScreeningStream {
 status:"calculated"|"insufficient_data";
 scope:"lease";
 unit:"bbl"|"mcf";
 reason:string|null;
 citations:Citation[];
 firstMonth:string|null;
 lastMonth:string|null;
 fit:DeclineCurveFit|null;
 next12:number|null;
 forecastRemaining:number|null;
 method:"existing_arps_calendar_v1";
}
export interface GoldRecord {
 format:"mineralflow-gold";
 version:"1.0.0";
 record:DecisionRecord;
 coverage:SourceCoverageStatus[];
 sections:typeof GOLD_SECTIONS;
 screening:{oil:ScreeningStream;gas:ScreeningStream};
 rules:{id:string;outcome:"missing_input"|"available";inputs:string[];explanation:string}[];
 limitations:string[];
}

function screen(record:DecisionRecord,phase:"oil"|"gas"):ScreeningStream {
 const field=record.fields["production.lease_monthly"];
 const result:ScreeningStream={status:"insufficient_data",scope:"lease",unit:phase==="oil"?"bbl":"mcf",reason:"No verified lease production is available.",citations:[],firstMonth:null,lastMonth:null,fit:null,next12:null,forecastRemaining:null,method:"existing_arps_calendar_v1"};
 if(field.status!=="observed"||!Array.isArray(field.value))return result;
 result.citations=field.citations;
 const asOfMonth=record.generated_at.slice(0,7);
 // Current calendar month is not a completed reporting period. Explicitly
 // remove only boundary months without reports; internal gaps remain gaps.
 let rows=(field.value as TrrcDDProductionRow[]).filter(r=>r.production_month.slice(0,7)<asOfMonth).sort((a,b)=>a.production_month.localeCompare(b.production_month));
 const reported=(r:TrrcDDProductionRow)=>phase==="oil"?typeof r.oil_bbl==="number":typeof r.gas_mcf==="number"||typeof r.casinghead_gas_mcf==="number";
 while(rows.length&&!reported(rows[0]))rows=rows.slice(1);
 while(rows.length&&!reported(rows[rows.length-1]))rows=rows.slice(0,-1);
 const series=productionSeries(rows)[phase];
 result.firstMonth=rows[0]?.production_month.slice(0,7)??null;
 result.lastMonth=rows[rows.length-1]?.production_month.slice(0,7)??null;
 if(!rows.length){result.reason="No completed reporting month has a reported volume for this phase.";return result;}
 if(!series.length){result.reason="Missing, invalid or noncontiguous internal reporting months prevent a calendar-consistent decline fit.";return result;}
 if(series[series.length-1]===0){result.reason="The latest reported month has zero production; no restart forecast is established.";return result;}
 if(series.filter(v=>v>0).length<6){result.reason="Fewer than six positive completed monthly observations are available.";return result;}
 const fit=fitArpsDecline(series);
 if(!fit){result.reason="The existing Arps engine could not fit a positive declining curve to the reported history.";return result;}
 const forecast=forecastToTerminalRate(fit,phase==="gas"?500:150);
 const values=forecast.map(p=>p.rate);
 const next12=values.slice(0,12).reduce((a,b)=>a+b,0);
 const remaining=values.reduce((a,b)=>a+b,0);
 if(!Number.isFinite(next12)||!Number.isFinite(remaining))throw Error("Nonfinite lease forecast");
 return {...result,status:"calculated",reason:null,fit,next12,forecastRemaining:remaining};
}

function rulesFor(record:DecisionRecord):GoldRecord["rules"] {
 const gates=[
  {id:"MF-G01",inputs:["identity.api10"],explanation:"Requested well identity must be supported by a matching source record."},
  {id:"MF-G02",inputs:["identity.evaluated_position","title.instruments","ownership.nri"],explanation:"The evaluated position and ownership must be supported before position economics."},
  {id:"MF-G03",inputs:["production.subject_monthly","forecast.next12_oil"],explanation:"Lease totals cannot establish subject-well production or forecast."},
  {id:"MF-G04",inputs:["economics.base_value","economics.minimum_margin"],explanation:"Value and the buyer's criterion are required for a maximum acquisition price."},
 ];
 return gates.map(g=>({...g,outcome:g.inputs.some(k=>["unavailable","insufficient_data"].includes(record.fields[k as keyof typeof record.fields].status))?"missing_input":"available"}));
}

// Coverage is reproducible from the retained payload, including failed and
// partial queries. Do not trust a detached, editable coverage summary.
function coverageFor(record:DecisionRecord):SourceCoverageStatus[] {
 return deriveCoverageFromAttempts(record.evidence.map(e=>{
  const rows=["wells","records","violations","rows","documents","permits"].map(k=>e.data[k]).find(Array.isArray);
  return {source_id:e.id,source_name:e.source,status:e.status,error_message:e.error,
   attempted_at:e.retrievedAt,result_data_json:e.data,result_count:Array.isArray(rows)?rows.length:e.data.found===true?1:0};
 }));
}
const LIMITATIONS = [
 "This implementation follows the GOLD reference's sections. Its MF-G guard rules are explicit implementation rules, not a claim to reproduce undisclosed sample R-01 through R-11 predicates.",
 "Lease screening forecasts reuse the existing Arps engine. They do not allocate production to the subject well or value a mineral position.",
 "Screening excludes the current calendar month and unreported boundary months. Internal missing months prevent fitting; zero observations retain elapsed time. Forecast terminal rates are engine assumptions (150 bbl/month oil, 500 mcf/month gas), not measured economic limits.",
 "A complete report includes explicit unavailable fields. It does not imply complete evidence, marketable title, or acquisition readiness.",
];

export function assembleGoldRecord(run:Pick<TrrcDueDiligenceRun,"id"|"original_input"> & Partial<TrrcDueDiligenceRun>,attempts:LiteSourceAttempt[],now=new Date().toISOString()):GoldRecord {
 const record=buildDecisionRecord(run,attempts,now);

 return {format:"mineralflow-gold",version:"1.0.0",record,coverage:coverageFor(record),sections:structuredClone(GOLD_SECTIONS),
  screening:{oil:screen(record,"oil"),gas:screen(record,"gas")},
  rules:rulesFor(record),limitations:[...LIMITATIONS]};
}

export function validateGoldRecord(gold:GoldRecord):string[]{
 const errors=validateDecisionRecord(gold.record);
 if(errors.length)return errors;
 if(JSON.stringify(gold.rules)!==JSON.stringify(rulesFor(gold.record)))errors.push("Invalid GOLD decision gate derivation");
 if(JSON.stringify(gold.coverage)!==JSON.stringify(coverageFor(gold.record)))errors.push("Invalid GOLD coverage derivation");
 if(JSON.stringify(gold.limitations)!==JSON.stringify(LIMITATIONS))errors.push("GOLD limitations mismatch");
 if(gold.format!=="mineralflow-gold"||gold.version!=="1.0.0")errors.push("Unsupported GOLD format/version");
 if(JSON.stringify(gold.sections)!==JSON.stringify(GOLD_SECTIONS))errors.push("GOLD section contract mismatch");
 for(const phase of ["oil","gas"] as const){
  if(JSON.stringify(gold.screening?.[phase])!==JSON.stringify(screen(gold.record,phase)))errors.push(`Invalid ${phase} lease-screening derivation`);
 }
 return errors;
}
