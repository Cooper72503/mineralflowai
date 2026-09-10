/** Recover well-specific facts already present in RRC payloads, without selecting arbitrary rows. */
import {normalizeApiNumber} from "../normalization";
import {normalizeFormation} from "../offset-analytics/formation-normalization";
import {validateDecisionRecord,type DecisionRecord,type Citation} from "../decision-record";
export function retainedWellContext(record:DecisionRecord){
 const errors=validateDecisionRecord(record);if(errors.length)throw Error(errors.join("; "));
 const api=normalizeApiNumber(record.input)?.api10;
 const source=record.evidence.find(e=>e.source==="search_by_api"&&e.status==="success"&&!e.data.error&&e.data.found===true);
 const wells=Array.isArray(source?.data.wells)?source.data.wells as Record<string,unknown>[]:[];
 const matches=wells.map((row,index)=>({row,index})).filter(x=>typeof x.row.api_no==="string"&&normalizeApiNumber(x.row.api_no)?.api10===api);
 const active=matches.filter(x=>x.row.on_schedule==="Y"),selected=active.length?active:matches;
 const unique=(key:string):{value:string|null;citations:Citation[];reason:string|null}=>{
  const rows=selected.filter(x=>typeof x.row[key]==="string"&&(x.row[key] as string).trim()!=="");
  const values=new Set(rows.map(x=>(x.row[key] as string).trim()));
  if(values.size!==1||rows.length!==selected.length)return {value:null,citations:[],reason:values.size>1?`Conflicting ${key} values among matching wellbore rows.`:`A unique reported ${key} is unavailable.`};
  return {value:[...values][0],citations:rows.map(x=>({evidenceId:source!.id,pointer:`/wells/${x.index}/${key}`})),reason:null};
 };
 const leaseName=unique("lease_name"),wellNumber=unique("well_no"),fieldName=unique("field_name"),depth=unique("api_depth");
 const normalized=fieldName.value?normalizeFormation(fieldName.value):null;
 const formation=normalized?.source==="FIELD_NAME_MATCH"?{value:normalized.canonicalFormation,rawFieldName:fieldName.value,basis:"RRC_FIELD_NAME_TEXT",method:"existing_formation_alias_normalizer_v1",citations:fieldName.citations,
 disclosure:"Derived from the RRC field name, not a measured formation top or independently confirmed landing zone."}:null;
 const depthValue=depth.value&&/^\d+(?:\.\d+)?$/.test(depth.value)?Number(depth.value):null;
 const reportedDepth=depthValue!==null&&Number.isFinite(depthValue)&&depthValue>0?{value:depthValue,unit:"ft",basis:"RRC_API_DEPTH_REFERENCE_UNSPECIFIED",citations:depth.citations,disclosure:"RRC API depth is retained as reported. It is not relabeled TVD, MD or TVDSS without depth-reference evidence."}:null;
 const designation=leaseName.value&&wellNumber.value?{leaseName:leaseName.value,wellNumber:wellNumber.value,label:`${leaseName.value} #${wellNumber.value}`,basis:"RRC_LEASE_AND_WELL_NUMBER",citations:[...leaseName.citations,...wellNumber.citations]}:null;
 return {api,rowSelection:active.length?"on_schedule_matching_api":"all_matching_api_no_current_row",leaseName,wellNumber,fieldName,formation,reportedDepth,designation};
}
