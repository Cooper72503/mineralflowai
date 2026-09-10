import {normalizePartnerInput} from "../decision-layer/partner-input";
import {resolveFormationDepthContext} from "../geology/formations";
import {normalizeApiNumber} from "../normalization";
export function mapWellMeasurements(input:unknown,apiInput:string,asOf:string){
 const api=normalizeApiNumber(apiInput)?.api10;if(!api||!Number.isFinite(Date.parse(asOf)))throw Error("Invalid measurement mapping identity/as-of");
 const partner=normalizePartnerInput(input),rows=partner.measurements.filter(r=>r.api===api&&Date.parse(r.measuredAt)<=Date.parse(asOf));
 const fields:Record<string,{value:unknown;unit:string;citations:{sourceId:string;pointer:string}[];method:string}>= {};
 const conflicts:{property:string;reason:string;citations:{sourceId:string;pointer:string}[]}[]=[];
 const selected=new Map<string,typeof rows[number]>();
 for(const property of new Set(rows.map(r=>r.property))){
  const candidates=rows.filter(r=>r.property===property);
  const values=new Set(candidates.map(r=>JSON.stringify([r.normalizedValue,r.normalizedUnit,r.referencePoint,r.verticalDatum])));
  if(values.size!==1){conflicts.push({property,reason:"Cited measurements disagree; no revision authority or preferred source was supplied.",citations:candidates.map(r=>r.citation)});continue;}
  const r=candidates[0];selected.set(property,r);
  fields[`geology.${property}`]={value:r.normalizedValue,unit:r.normalizedUnit,citations:candidates.map(r=>r.citation),method:"cited_subject_measurement_unit_normalization_v1"};
 }
 const tvd=selected.get("tvd"),elevation=selected.get("reference_elevation");
 if(tvd&&elevation){
  if(tvd.referencePoint!==elevation.referencePoint||tvd.verticalDatum!==elevation.verticalDatum){conflicts.push({property:"tvdss",reason:"TVD and elevation references do not match; subtraction would mix datums.",citations:[tvd.citation,elevation.citation]});}
  else{
   const context=resolveFormationDepthContext({subjectFieldName:null,permittedFormationRaw:null,subjectTvdFt:tvd.normalizedValue as number,subjectTvdSource:tvd.citation.sourceId,referenceElevationFt:elevation.normalizedValue as number,referenceElevationSource:elevation.citation.sourceId});
   if(context.subjectTvdssFt!==null&&Number.isFinite(context.subjectTvdssFt))fields["geology.tvdss"]={value:context.subjectTvdssFt,unit:"ft_below_MSL",citations:[tvd.citation,elevation.citation],method:"existing_tvd_minus_matching_reference_elevation_v1"};
  }
 }
 return {fields,conflicts,disclosure:"Measurements are reported by the cited provider for the subject well. Conflicting sources are withheld; missing properties remain unavailable. API depth is not substituted for TVD."};
}
