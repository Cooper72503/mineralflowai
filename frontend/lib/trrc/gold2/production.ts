/** Complete calendar periods, subject-well scope, and no forecast extrapolation. */
import {Month,normalizePartnerInput} from "../decision-layer/partner-input";
import {normalizeApiNumber} from "../normalization";
export function shiftMonth(month:string,offset:number):string{
 Month.parse(month);if(!Number.isInteger(offset))throw Error("Invalid month offset");
 const index=Number(month.slice(0,4))*12+Number(month.slice(5))-1+offset;
 const result=`${Math.floor(index/12)}-${String(index%12+1).padStart(2,"0")}`;Month.parse(result);return result;
}
export function subjectProductionMetrics(input:unknown,apiInput:string,asOf:string){
 const api=normalizeApiNumber(apiInput)?.api10;if(!api||!Number.isFinite(Date.parse(asOf)))throw Error("Invalid subject metrics identity/as-of");
 const p=normalizePartnerInput(input),rows=p.months.filter(m=>m.api===api&&m.month<asOf.slice(0,7)).sort((a,b)=>a.month.localeCompare(b.month));
 const end=rows.length?rows[rows.length-1].month:null;
 const total=(phase:"oilBbl"|"gasMcf",through:string|null)=>{
  if(!through)return {value:null,reason:"No completed subject reporting month is available.",citations:[]};
  const selected=Array.from({length:12},(_,i)=>rows.find(r=>r.month===shiftMonth(through,i-11)));
  if(selected.some(r=>!r||r[phase]===null))return {value:null,reason:`Incomplete 12-month ${phase} history ending ${through}; missing months are not zero.`,citations:selected.flatMap(r=>r?[r.citation]:[])};
  const value=selected.reduce((sum,r)=>sum+r![phase]!,0);if(!Number.isFinite(value))throw Error("Subject production total overflow");
  return {value,reason:null,citations:selected.map(r=>r!.citation)};
 };
 const oil=total("oilBbl",end),gas=total("gasMcf",end),priorOil=total("oilBbl",end?shiftMonth(end,-12):null);
 const yoyOilDeclinePct=oil.value!==null&&priorOil.value!==null&&priorOil.value>0?(priorOil.value-oil.value)/priorOil.value*100:null;
 return {method:"calendar_complete_subject_ttm_v1",api,from:end?shiftMonth(end,-11):null,through:end,oil,gas,priorOil,yoyOilDeclinePct,
  yoyReason:yoyOilDeclinePct===null?"Two complete oil reporting years and a positive prior-year total are required.":null,
  disclosure:"TTM ends at the latest completed reported subject month, which may lag the report date. Year-over-year decline here is oil-only; no BOE conversion is assumed."};
}
export function subjectForecastMetrics(input:unknown,selection:{api:string;forecastId:string;scenario:"base"|"downside"|"upside";from:string;asOf:string}){
 const api=normalizeApiNumber(selection.api)?.api10;if(!api||!Number.isFinite(Date.parse(selection.asOf)))throw Error("Invalid forecast identity/as-of");
 Month.parse(selection.from);
 if(selection.from<selection.asOf.slice(0,7))throw Error("Forecast start precedes report as-of month");
 const p=normalizePartnerInput(input),rows=p.forecasts.filter(f=>f.api===api&&f.forecastId===selection.forecastId&&f.scenario===selection.scenario&&f.month>=selection.from).sort((a,b)=>a.month.localeCompare(b.month));
 const versions=new Set(rows.map(r=>`${r.modelVersion}:${r.generatedAt}`));
 const metadataValid=rows.length>0&&versions.size===1&&rows.every(r=>Date.parse(r.generatedAt)<=Date.parse(selection.asOf)&&r.month>=r.generatedAt.slice(0,7));
 const phase=(key:"oilBbl"|"gasMcf",count:number)=>{
  const selected=Array.from({length:count},(_,i)=>rows.find(r=>r.month===shiftMonth(selection.from,i)));
  if(!metadataValid||!count||selected.some(r=>!r||r[key]===null))return {value:null,reason:"Selected forecast has missing months/phase volumes or invalid model metadata.",citations:[]};
  const value=selected.reduce((sum,r)=>sum+r![key]!,0);if(!Number.isFinite(value))throw Error("Forecast volume overflow");
  return {value,reason:null,citations:selected.map(r=>r!.citation)};
 };
 return {method:"sum_cited_calendar_forecast_v1",selection,modelVersion:metadataValid?rows[0].modelVersion:null,generatedAt:metadataValid?rows[0].generatedAt:null,
  next12Oil:phase("oilBbl",12),next12Gas:phase("gasMcf",12),remainingOil:phase("oilBbl",rows.length),remainingGas:phase("gasMcf",rows.length),through:rows.length?rows[rows.length-1].month:null,
  disclosure:"Remaining volumes cover only the supplied contiguous forecast horizon; they are not independently certified reserves or an extrapolated full-life EUR."};
}
