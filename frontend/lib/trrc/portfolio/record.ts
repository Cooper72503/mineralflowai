/** Portfolio evidence reconciliation. Gross lease production is never seller net production. */
import {z} from "zod";
import {buildDecisionRecord,validateDecisionRecord,type DecisionRecord} from "../decision-record";
import {normalizeApiNumber} from "../normalization";
import type {LiteSourceAttempt} from "../coverage";
export const PortfolioRequest=z.object({
 members:z.array(z.object({input:z.string().trim().min(1).max(500),runId:z.string().uuid().nullable()}).strict()).min(1).max(100),
 askingPriceUsd:z.number().finite().positive().nullable().default(null),
 claimedWellCount:z.number().int().positive().max(10000).nullable().default(null),
}).strict();
export type PortfolioInput=z.infer<typeof PortfolioRequest>;
export interface RetainedRun {id:string;original_input:string;status:string;resolved_primary_api?:string|null;attempts:LiteSourceAttempt[]}
export const PHASES=["oil_bbl","gas_mcf","casinghead_gas_mcf","condensate_bbl","water_bbl"] as const;
type Phase=typeof PHASES[number];
type Ref={runId:string;evidenceId:string;pointer:string};
type Volume={status:"calculated"|"insufficient_data";value:number|null;reason:string|null;citations:Ref[]};
type Observation={month:string;values:Record<Phase,number|null>;citations:Ref[]};
const unavailable=(reason:string,reasonCode="required_input_missing")=>({status:"insufficient_data" as const,value:null,reason,reasonCode});
const identifier=(v:unknown)=>typeof v==="string"&&/^\d+[A-Za-z]?$/.test(v.trim())?v.trim().toUpperCase().replace(/^0+(?=\d)/,""):null;

export function buildPortfolioRecord(raw:PortfolioInput,runs:RetainedRun[],asOf=new Date().toISOString()){
 const input=PortfolioRequest.parse(raw);
 if(!Number.isFinite(Date.parse(asOf)))throw Error("Invalid report timestamp");
 const wanted=new Set(input.members.flatMap(m=>m.runId?[m.runId]:[]));
 if(runs.length!==wanted.size||new Set(runs.map(r=>r.id)).size!==runs.length||runs.some(r=>!wanted.has(r.id)))throw Error("Retained run set does not match the requested portfolio");
 const records:Record<string,DecisionRecord>={};
 const blockers:string[]=[];
 const groups=new Map<string,{key:string;district:string;leaseNumber:string;leaseType:string;apis:Set<string>;observations:Observation[]}>();
 const parsedRuns=new Map<string,{groupKey:string|null;reason:string|null}>();
 for(const run of runs){
  const api=normalizeApiNumber(run.original_input)?.api10;
  let reason:string|null=null,groupKey:string|null=null;
  if(!api)reason="Run input is not a valid Texas API.";
  else if(!["complete","failed"].includes(run.status))reason=`Run is ${run.status}; retrieval is not terminal.`;
  else if(run.resolved_primary_api&&normalizeApiNumber(run.resolved_primary_api)?.api10!==api)reason="Resolved API conflicts with the requested API.";
  else if(run.attempts.some(a=>!Number.isFinite(Date.parse(a.attempted_at))||Date.parse(a.attempted_at)>Date.parse(asOf)))reason="Evidence has an invalid or future retrieval timestamp.";
  if(!reason){
   const record=buildDecisionRecord({id:run.id,original_input:run.original_input,resolved_primary_api:run.resolved_primary_api},run.attempts,asOf);
   records[run.id]=record;
   const errors=validateDecisionRecord(record);
   const lease=identifier(record.fields["identity.lease"].value),district=identifier(record.fields["identity.district"].value);
   const prod=record.evidence.find(e=>e.source==="fetch_production");
   const history=prod?.data.lease_type_attempts;
   const foundTypes=Array.isArray(history)?history.filter((a):a is {lease_type:string;status:string}=>!!a&&typeof a==="object"&&(a as {status?:string}).status==="found").map(a=>a.lease_type):[];
   const leaseType=foundTypes.length===1&&["O","G"].includes(foundTypes[0])?foundTypes[0]:null;
   if(errors.length)reason=`Retained evidence validation failed: ${errors.join("; ")}`;
   else if(!lease||!district||record.fields["identity.api10"].value!==api)reason="No uniquely evidenced API-to-lease association.";
   else if(!prod||record.fields["production.lease_monthly"].status!=="observed")reason=record.fields["production.lease_monthly"].reason??"Lease production is unavailable.";
   else if(!leaseType)reason="Successful oil/gas lease query type is not retained; the production stream cannot be uniquely identified.";
   else if(identifier(prod.data.lease_number)!==lease||identifier(prod.data.district)!==district)reason="Production stream differs from the evidenced lease association.";
   else {
    const rows=record.fields["production.lease_monthly"].value;
    if(!Array.isArray(rows)||!rows.length)reason="No retained production months.";
    else {
     const observations:Observation[]=[];
     for(let i=0;i<rows.length;i++){
      const row=rows[i] as Record<string,unknown>|null;
      if(!row||typeof row!=="object"||typeof row.production_month!=="string"||!/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/.test(row.production_month)||row.production_month.slice(0,7)>=asOf.slice(0,7)||PHASES.some(p=>row[p]!==null&&row[p]!==undefined&&(typeof row[p]!=="number"||!Number.isFinite(row[p])||(row[p] as number)<0))){reason="Production contains invalid volumes, dates, or a current/future incomplete month.";break;}
      observations.push({month:row.production_month.slice(0,7),values:Object.fromEntries(PHASES.map(p=>[p,row[p]??null])) as Record<Phase,number|null>,citations:[{runId:run.id,evidenceId:prod.id,pointer:`/rows/${i}`}]});
     }
     if(!reason){
      groupKey=`TX:${district}:${leaseType}:${lease}`;
      const group=groups.get(groupKey)??{key:groupKey,district,leaseNumber:lease,leaseType,apis:new Set<string>(),observations:[]};
      group.apis.add(api!);group.observations.push(...observations);groups.set(groupKey,group);
     }
    }
   }
  }
  parsedRuns.set(run.id,{groupKey,reason});
 }
 const members=input.members.map((member,index)=>{
  const api=normalizeApiNumber(member.input)?.api10??null;
  const run=runs.find(r=>r.id===member.runId);
  if(run&&api!==normalizeApiNumber(run.original_input)?.api10)throw Error("Portfolio input does not match its retained run API");
  const parsed=run?parsedRuns.get(run.id)!:null;
  const reason=!api?"Invalid Texas API; no correction inferred.":!run?"No due-diligence run was created for this entry.":parsed!.reason;
  if(reason)blockers.push(`Entry ${index+1}: ${reason}`);
  if(run?.status==="failed")blockers.push(`Entry ${index+1}: retrieval run failed; available source evidence is partial.`);
  return {input:member.input,api,runId:member.runId,runStatus:run?.status??"not_created",productionGroup:parsed?.groupKey??null,status:reason?"insufficient_data":"reconciled",reason};
 });
 // A base API associated with different streams across retained runs needs scope review.
 // It may be a reassignment or multiple completions; neither permits summing blindly.
 for(const api of new Set(members.flatMap(m=>m.api?[m.api]:[]))){
  const associations=new Set(members.filter(m=>m.api===api&&m.productionGroup).map(m=>m.productionGroup));
  if(associations.size>1){
   const reason=`API ${api} maps to multiple retained production streams; reconcile completion/lease scope before aggregation.`;
   blockers.push(reason);
   for(const m of members.filter(m=>m.api===api)){m.status="insufficient_data";m.reason=reason;}
  }
 }
 const distinctApis=new Set(members.flatMap(m=>m.api?[m.api]:[]));
 const duplicateApiEntries=members.filter((m,i)=>m.api&&members.findIndex(n=>n.api===m.api)<i).map(m=>m.input);
 if(input.claimedWellCount!==null&&input.claimedWellCount!==distinctApis.size)blockers.push(`Claimed ${input.claimedWellCount} wells differs from ${distinctApis.size} distinct valid submitted APIs; inventory review required.`);
 const leaseStreams=[...groups.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(g=>{
  const months=[...new Set(g.observations.map(o=>o.month))].sort().map(month=>{
   const observations=g.observations.filter(o=>o.month===month);
   const volumes=Object.fromEntries(PHASES.map(phase=>{
    const nonNull=observations.filter(o=>o.values[phase]!==null);
    const values=new Set(nonNull.map(o=>o.values[phase]!));
    const conflict=values.size>1;
    if(conflict)blockers.push(`Conflicting ${phase} observations for ${g.key} in ${month}; volume withheld.`);
    const volume:Volume={status:values.size===1?"calculated":"insufficient_data",value:values.size===1?[...values][0]:null,reason:conflict?"Conflicting retained observations; no snapshot chosen silently.":values.size===0?"Phase volume not reported.":null,citations:nonNull.flatMap(o=>o.citations.map(c=>({...c,pointer:`${c.pointer}/${phase}`})))};
    return [phase,volume];
   })) as Record<Phase,Volume>;
   return {month,volumes};
  });
  return {key:g.key,district:g.district,leaseNumber:g.leaseNumber,leaseType:g.leaseType,apis:[...g.apis].sort(),months};
 });
 const inventoryComplete=members.every(m=>m.productionGroup!==null&&m.status==="reconciled")&&input.claimedWellCount!==null&&input.claimedWellCount===distinctApis.size;
 const months=[...new Set(leaseStreams.flatMap(g=>g.months.map(m=>m.month)))].sort();
 const grossMonthly=months.map(month=>({month,volumes:Object.fromEntries(PHASES.map(phase=>{
  const cells=leaseStreams.map(g=>g.months.find(m=>m.month===month)?.volumes[phase]);
  const complete=inventoryComplete&&cells.length>0&&cells.every(c=>c?.value!==null&&c?.value!==undefined);
  const sum=cells.reduce((n,c)=>n+(c?.value??0),0);
  if(!Number.isFinite(sum))throw Error("Portfolio volume overflow");
  return [phase,{status:complete?"calculated":"insufficient_data",value:complete?sum:null,reason:complete?null:"A stream/month/phase or confirmation of the offered inventory count is missing or conflicting.",citations:cells.flatMap(c=>c?.citations??[])} satisfies Volume];
 })) as Record<Phase,Volume>}));
 if(input.claimedWellCount===null)blockers.push("Offered well count has not been supplied; package inventory completeness is unverified.");
 blockers.push("Portfolio title/ownership and operated-asset valuation handoffs are not connected in this evidence record; it cannot produce a buy recommendation yet.","Reviewed seller WI/NRI, title, lease participation and sale scope are required before gross lease production can be treated as acquired production.","Operating costs, injection history, capital/plugging obligations, supported forecasts and buyer return criteria are required for an operated-asset acquisition decision.");
 return {
  schemaVersion:"mineralflow-portfolio-evidence-1.0.0",generatedAt:asOf,input,
  inventory:{submittedEntries:members.length,distinctValidApis:distinctApis.size,claimedWellCount:input.claimedWellCount,duplicateApiEntries,members},
  production:{basis:"gross_regulatory_lease_streams_not_acquired_interest",method:"unique_texas_district_lease_type_lease_month_phase_v1",leaseStreams,grossMonthly},
  economics:{askingPriceUsd:input.askingPriceUsd===null?unavailable("No asking price supplied."):{status:"provided_assumption",value:input.askingPriceUsd,origin:"/input/askingPriceUsd"},maximumBuyPriceUsd:unavailable("Operated-asset cash-flow handoff is not connected to this portfolio record. Reviewed acquired interests, costs, forecasts and buyer return criteria are required; royalty values are not substituted.","portfolio_engine_not_connected"),remainingRecoverableVolumes:unavailable("Package forecast handoff is not connected; historical production is not reserves.","portfolio_engine_not_connected"),exitValueUsd:unavailable("Portfolio exit valuation handoff is not connected. Holding period, remaining cash flows, exit valuation basis and selling costs are required.","portfolio_engine_not_connected")},
  decision:{posture:"INSUFFICIENT_DATA",goldValidated:false,blockers:[...new Set(blockers)]},
  retainedRunRecords:records,
  disclosures:["Identical lease-month observations across wells or repeated runs count once. Conflicting phase values are withheld.","Null or absent phase volumes are not zero. Streams with different oil/gas lease types are distinct.","Totals cover the identified regulatory streams, not proven ownership of all their production. No well-level allocation is inferred.","Source hashes cover retained parsed responses, not independently archived original source pages.","This portfolio evidence record is not a completed acquisition GOLD Decision Record."]
 };
}
export type PortfolioRecord=ReturnType<typeof buildPortfolioRecord>;
