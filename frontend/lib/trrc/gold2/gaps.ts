/** Explicit dependency failures. Unimplemented mappings never become data-source failures. */
import type {Gold2Input,DraftField} from "./assemble";
import type {DecisionRecord} from "../decision-record";
import type {UnavailableReason} from "./contract";
const regulatory:Record<string,string>={operator_standing:"search_by_operator",compliance:"fetch_compliance_violations",severance:"fetch_severance_records",orphan:"fetch_orphan_well",plugging:"fetch_plugging_records",injection:"fetch_injection_records",imaged_documents:"fetch_coda_records",permits:"fetch_drilling_permits"};
export function explainFieldGaps(fields:Record<string,DraftField>,input:Gold2Input,record:DecisionRecord){
 const dependency=(key:string,reasonCode:UnavailableReason|"engine_not_connected",reason:string)=>{
  if(fields[key].value===null)Object.assign(fields[key],{reasonCode,reason});
 };
 for(const [key,field] of Object.entries(fields)){
  if(field.value!==null)continue;
  const [domain,name]=key.split('.');
  if(domain==="ownership"||["identity.evaluated_position","identity.tract","identity.interest_scope"].includes(key)){
   dependency(key,input.position===null?"position_not_supplied":"reviewed_documents_insufficient",input.position===null?"No reviewed owner/tract position was supplied. API identity alone does not specify a seller or revenue interest.":"The selected position is not supported by sufficient reviewed title evidence.");continue;
  }
  if(domain==="title"){
   if(input.title===null)dependency(key,input.titleLookup?.status==="query_failed"?"source_query_failed":"reviewed_documents_insufficient",input.titleLookup?.reason??"No reviewed title analysis was supplied for this API.");
   else if(name==="scenarios")dependency(key,"reviewed_documents_insufficient","No supported reviewed ownership scenario was supplied; narrative fractions are not used to invent an alternative position.");
   else dependency(key,"reviewed_documents_insufficient",field.reason??"Title evidence is insufficient.");
   continue;
  }
  if(domain==="economics"){
   if(["evidence_adjusted_value","risk_adjusted_value","measured_exposure"].includes(name))dependency(key,"reviewed_documents_insufficient","A supported reviewed joint alternative and computable baseline value are required; overlapping scenarios and unknown liabilities are not summed or assumed zero.");
   // A lease screening scenario may be present while position economics are
   // not: say which is missing, rather than denying that any assumptions
   // were supplied directly beneath the ceilings they produced.
   else if(input.economics===null&&(input as {internalLeaseSettings?:unknown}).internalLeaseSettings!=null)dependency(key,"position_not_supplied","Position values need a reviewed ownership position (the interest being bought) and a position-level assumption set. The lease screen in this section is an 8/8ths operated scenario under stated assumptions, not the offered interest.");
   else if(input.economics===null)dependency(key,"buyer_criterion_not_supplied","No explicit economic assumption set was supplied; prices, deductions, taxes and buyer criteria are not inferred.");
   else if(["risk_haircut","differentials"].includes(name))dependency(key,"engine_not_connected","Explicit differential/risk-haircut assumptions are not yet mapped by the report economics contract.");
   else if(input.position===null)dependency(key,"position_not_supplied","A reviewed ownership position is required to calculate position economics.");
   else if(input.partner===null)dependency(key,"partner_feed_unavailable","No cited subject forecast was supplied for valuation.");
   else dependency(key,"buyer_criterion_not_supplied",field.reason?.includes("handoff")?"Required economic criteria or forecast coverage are unavailable.":field.reason??"Required economic criteria are unavailable.");
   continue;
  }
  if(domain==="forecast"||domain==="production"&&!['lease_monthly'].includes(name)){
   dependency(key,input.partner===null?"partner_feed_unavailable":!input.reconciliationPolicy&&['variance_threshold','reporting_period','variance_pct','vendor_lease_sum','regulator_lease_total','membership_scope'].includes(name)?"buyer_criterion_not_supplied":"not_reported_by_source",input.partner===null?"No cited subject-well production/forecast or complete lease-membership feed was supplied. Lease totals are not allocated to this well.":"The supplied subject feed, selected forecast or reconciliation period lacks the observations/criteria required for this field.");continue;
  }
  const source=domain==="regulatory"?regulatory[name]:domain==="identity"||name==="formation"||name==="reported_api_depth"?"search_by_api":domain==="production"?"fetch_production":["latitude","longitude","map_symbol","survey"].includes(name)?"fetch_gis_plat":null;
  if(source){
   const evidence=record.evidence.find(e=>e.source===source);
   const failed=evidence&&(evidence.status!=="success"||evidence.error||evidence.data.error||evidence.data.data_gap===true||evidence.data.endpoint_available===false);
   dependency(key,failed?"source_query_failed":!evidence?"source_not_queried":evidence.data.found===false?"source_returned_no_record":"not_reported_by_source",failed?`Retained ${source} retrieval failed or was incomplete; inspect its source inventory and error.`:!evidence?`No ${source} response was retained for this API.`:`The retained ${source} response does not establish a unique supported value for ${key}.`);continue;
  }
  if(domain==="geology"){
   dependency(key,input.partner===null?"partner_feed_unavailable":"not_reported_by_source",input.partner===null?"No cited subject-well measurement feed was supplied. Nearby-well values and API depth are not substituted.":"No consistent cited measurement with the required units and references was supplied for this property.");continue;
  }
  dependency(key,"engine_not_connected",`No completed engine mapping exists for ${key}.`);
 }
 return fields;
}
