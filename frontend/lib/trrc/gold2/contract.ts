/** Executable GOLD 2.0 acceptance requirements, traced to the approved sample. */
import {GOLD2_CALCULATIONS,GOLD2_DISCLOSURES} from "./requirements";
import {normalizeApiNumber} from "../normalization";
import {REQUIRED_DECISION_FIELDS} from "../decision-record";
export const GOLD2_VERSION="2.0.0";
export const GOLD2_FIELDS=[...REQUIRED_DECISION_FIELDS,
 "identity.as_of","economics.underwrite_basis","economics.cashflow_timing","economics.risk_haircut","economics.differentials","economics.assumption_provenance","economics.monthly_cashflows",
 "forecast.next12_gas","forecast.model_version","forecast.generated_at","production.reporting_period","production.membership_scope",
 "geology.reference_elevation","geology.gross_interval","geology.formation_tops","decision.confidence_domains","decision.closing_rule_trace","decision.next_actions","decision.supporting_reasons","decision.risk_reasons","evidence.source_inventory","evidence.search_coverage",
] as const;
export const GOLD2_CHARTS=[
 {id:"value_waterfall",page:2,fields:["economics.base_value","economics.measured_exposure","economics.evidence_adjusted_value"]},
 {id:"commodity_sensitivity",page:3,fields:["economics.sensitivity"]},
 {id:"risk_map",page:4,fields:["title.exceptions"]},
 {id:"ownership_scenarios",page:5,fields:["title.scenarios"]},
 {id:"confidence_domains",page:6,fields:["decision.confidence_domains"]},
 {id:"source_to_decision",page:7,fields:["decision.rule_trace","evidence.source_inventory"]},
 {id:"production_forecast",page:8,fields:["production.subject_monthly","forecast.next12_oil","forecast.next12_gas"]},
 {id:"stratigraphic_column",page:9,fields:["geology.formation_tops","geology.tvd","geology.reference_elevation"]},
 {id:"ownership_graph",page:10,fields:["title.ownership_graph"]},
 {id:"ownership_value_bridge",page:12,fields:["ownership.nri","economics.base_value"]},
 {id:"source_reconciliation",page:17,fields:["production.vendor_lease_sum","production.regulator_lease_total","production.variance_pct"]},
] as const;
export const GOLD2_ENGINE_MAP={
 identity:"normalization.ts + worker identity/association resolution",
 title:"title/analysis.ts + title/ownership-graph.ts",
 ownership:"title/fraction.ts + reviewed evaluated-position linkage",
 production:"worker production + decision-layer/reconcile.ts",
 forecast:"decision-layer/partner-input.ts; decline-curve.ts only for named independent screening",
 geology:"geology/index.ts + partner completion/subsurface mapping",
 economics:"decision-layer/scenario.ts + economics.ts + reviewed position/scenario bridge",
 decision:"gold2/rules.ts",
 evidence:"decision-record.ts + retained partner snapshots + original title documents",
 report:"gold/pdf.ts requires GOLD2 field/chart handoff",
} as const;
export const LEGITIMATE_UNAVAILABLE_REASONS=["source_query_failed","source_returned_no_record","not_reported_by_source","ambiguous_asset_association","reviewed_documents_insufficient","position_not_supplied","buyer_criterion_not_supplied","partner_feed_unavailable"] as const;
export type UnavailableReason=typeof LEGITIMATE_UNAVAILABLE_REASONS[number];
export interface Gold2AcceptanceCandidate {
 schemaVersion:string; rulesetVersion:string;api:string;
 fields:Record<string,{status:"observed"|"calculated"|"unavailable"|"insufficient_data";value:unknown;reason:string|null;reasonCode?:UnavailableReason|"engine_not_connected";validated:boolean}>;
 charts:{id:string;status:"rendered"|"unavailable";inputFields:string[];reason:string|null;validated:boolean}[];
 sections:string[];
 calculations?:{id:string;method:string;status:"recomputed"|"unavailable";reason:string|null}[];
 disclosures?:{id:string;text:string}[];
 audit:{evidenceValid:boolean;calculationsRecomputed:boolean;rulesRecomputed:boolean;renderInspected:boolean;engineHandoffsComplete:boolean};
}
/** Necessary acceptance gates, not a replacement for evidence/calculation/render validators.
 * `audit` checks must come from the benchmark executor, never uploaded user flags. */
export function gold2Acceptance(candidate:Gold2AcceptanceCandidate):string[]{
 const errors:string[]=[];
 if(normalizeApiNumber(candidate.api)?.api10!==candidate.api)errors.push("GOLD2 canonical Texas API required");
 const finite=(v:unknown):boolean=>v!==undefined&&(typeof v==="number"?Number.isFinite(v):Array.isArray(v)?v.every(finite):v!==null&&typeof v==="object"?Object.values(v).every(finite):true);
 if(candidate.schemaVersion!==GOLD2_VERSION||candidate.rulesetVersion!==GOLD2_VERSION)errors.push("GOLD2 version contract not satisfied");
 for(const key of GOLD2_FIELDS){
  const f=candidate.fields[key];if(!f){errors.push(`Missing GOLD2 field: ${key}`);continue;}
  if(!f.validated)errors.push(`Unvalidated field: ${key}`);
  if(f.status==="unavailable"||f.status==="insufficient_data"){
   if(f.value!==null||!f.reason?.trim()||!LEGITIMATE_UNAVAILABLE_REASONS.includes(f.reasonCode as UnavailableReason))errors.push(`Unjustified unavailable field: ${key}`);
  }else if(!["observed","calculated"].includes(f.status)||f.value===null||!finite(f.value))errors.push(`Invalid populated field: ${key}`);
 }
 for(const required of GOLD2_CHARTS){
  const charts=candidate.charts.filter(c=>c.id===required.id);
  if(charts.length!==1){errors.push(`Missing or duplicate GOLD2 chart: ${required.id}`);continue;}
  const c=charts[0];
  if(!c.validated||JSON.stringify(c.inputFields)!==JSON.stringify(required.fields))errors.push(`Unvalidated chart data: ${c.id}`);
  if(c.status==="unavailable"){
   if(!c.reason?.trim()||!required.fields.some(k=>["unavailable","insufficient_data"].includes(candidate.fields[k]?.status)))errors.push(`Unjustified unavailable chart: ${c.id}`);
  }else if(c.status!=="rendered")errors.push(`Invalid chart state: ${c.id}`);
 }
 for(const required of GOLD2_CALCULATIONS){
  const matches=candidate.calculations?.filter(c=>c.id===required.id)??[];
  if(matches.length!==1){errors.push(`Missing or duplicate calculation acceptance: ${required.id}`);continue;}
  const c=matches[0];
  if(c.method!==required.method)errors.push(`Calculation method mismatch: ${c.id}`);
  if(c.status==="unavailable"){
   if(!c.reason?.trim()||!required.outputs.every(k=>["unavailable","insufficient_data"].includes(candidate.fields[k]?.status)))errors.push(`Unjustified unavailable calculation: ${c.id}`);
  }else if(c.status!=="recomputed")errors.push(`Calculation not recomputed: ${c.id}`);
 }
 if(JSON.stringify(candidate.disclosures)!==JSON.stringify(GOLD2_DISCLOSURES))errors.push("GOLD2 required disclosures incomplete or altered");
 const sections=[...Array.from({length:15},(_,i)=>String(i+1).padStart(2,"0")),"A","A1","A2"];
 if(JSON.stringify(candidate.sections)!==JSON.stringify(sections))errors.push("GOLD2 section sequence incomplete");
 for(const [gate,passed] of Object.entries(candidate.audit))if(passed!==true)errors.push(`GOLD2 audit gate failed: ${gate}`);
 for(const gate of ["evidenceValid","calculationsRecomputed","rulesRecomputed","renderInspected","engineHandoffsComplete"] as const)if(!(gate in candidate.audit))errors.push(`Missing audit gate: ${gate}`);
 return errors;
}
