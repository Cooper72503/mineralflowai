import {z} from "zod";
import {validateDecisionRecord,type DecisionRecord,type Citation} from "../decision-record";
import {normalizePartnerInput,Month,type PartnerReference} from "./partner-input";
export const ReconciliationPolicy=z.object({from:Month,through:Month,thresholdPercent:z.number().finite().nonnegative(),policyId:z.string().min(1)}).strict();
export type ReconciliationPolicyInput=z.infer<typeof ReconciliationPolicy>;
export interface PhaseReconciliation {
 status:"matched"|"contradiction"|"insufficient_data";
 vendorTotal:number|null;regulatorTotal:number|null;variancePercent:number|null;
 reason:string;partnerCitations:PartnerReference[];regulatorCitations:Citation[];
}
export function reconcilePartnerProduction(record:DecisionRecord,input:unknown,policyInput:ReconciliationPolicyInput){
 const errors=validateDecisionRecord(record);if(errors.length)throw Error(errors.join("; "));
 const partner=normalizePartnerInput(input),policy=ReconciliationPolicy.parse(policyInput);
 if(policy.from>policy.through)throw Error("Reconciliation reporting period is reversed");
 const periods:string[]=[];let cursor=policy.from;
 while(cursor<=policy.through){
  periods.push(cursor);if(periods.length>600)throw Error("Reconciliation period exceeds 600 months");
  const y=Number(cursor.slice(0,4)),m=Number(cursor.slice(5));cursor=m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,"0")}`;
 }
 const lease=record.fields["identity.lease"].value,district=record.fields["identity.district"].value,api=record.fields["identity.api10"].value;
 const scope=partner.leases.filter(s=>s.lease===lease&&s.district===district&&s.from<=policy.from&&s.through>=policy.through);
 const raw=record.fields["production.lease_monthly"];
 const failure=(reason:string):PhaseReconciliation=>({status:"insufficient_data",vendorTotal:null,regulatorTotal:null,variancePercent:null,reason,partnerCitations:scope.map(s=>s.citation),regulatorCitations:raw.citations});
 function compare(phase:"oil"|"gas"):PhaseReconciliation{
  if(typeof api!=="string"||typeof lease!=="string"||typeof district!=="string")return failure("A uniquely evidenced subject API, lease and district are required.");
  if(scope.length!==1||scope[0].completeness!=="complete"||!scope[0].apis.includes(api))return failure("One complete, cited lease membership covering the entire period and including the subject is required; subject-only totals cannot be compared with lease totals.");
  if(raw.status!=="observed"||!Array.isArray(raw.value))return failure("Verified regulator lease production is unavailable.");
  const members=scope[0].apis,rows=partner.months.filter(r=>r.lease===lease&&r.district===district&&periods.includes(r.month));
  if(rows.some(r=>!members.includes(r.api)))return {...failure("Partner production includes a well absent from cited lease membership."),status:"contradiction",partnerCitations:[scope[0].citation,...rows.map(r=>r.citation)]};
  let vendorTotal=0,regulatorTotal=0;const citations:PartnerReference[]=[scope[0].citation];
  for(const month of periods){
   for(const member of members){
    const row=rows.find(r=>r.api===member&&r.month===month),v=phase==="oil"?row?.oilBbl:row?.gasMcf;
    if(v===null||v===undefined)return failure(`Missing ${phase} observation for ${member}, ${month}; no zero or allocation is assumed.`);
    vendorTotal+=v;citations.push(row!.citation);
   }
   const regulator=(raw.value as Record<string,unknown>[]).filter(r=>typeof r.production_month==="string"&&r.production_month.slice(0,7)===month);
   if(regulator.length!==1)return failure(`Missing or duplicate regulator reporting month: ${month}.`);
   const r=regulator[0],values=(phase==="oil"?[r.oil_bbl]:[r.gas_mcf,r.casinghead_gas_mcf]).filter(v=>v!==null&&v!==undefined);
   if(!values.length||values.some(v=>typeof v!=="number"||!Number.isFinite(v)||v<0))return failure(`Missing or invalid regulator ${phase} volume: ${month}.`);
   regulatorTotal+=(values as number[]).reduce((a,b)=>a+b,0);
  }
  if(!Number.isFinite(vendorTotal)||!Number.isFinite(regulatorTotal))throw Error("Reconciliation total overflow");
  const variancePercent=regulatorTotal===0?(vendorTotal===0?0:null):(vendorTotal-regulatorTotal)/regulatorTotal*100;
  if(variancePercent!==null&&!Number.isFinite(variancePercent))throw Error("Reconciliation variance overflow");
  const contradiction=variancePercent===null||Math.abs(variancePercent)>policy.thresholdPercent;
  return {status:contradiction?"contradiction":"matched",vendorTotal,regulatorTotal,variancePercent,reason:variancePercent===null?"Positive partner volume against regulator zero; percentage variance is undefined.":`Identical reporting months and complete cited lease membership; absolute variance ${contradiction?"exceeds":"does not exceed"} the supplied ${policy.thresholdPercent}% threshold.`,partnerCitations:citations,regulatorCitations:raw.citations};
 }
 const oil=compare("oil"),gas=compare("gas");
 return {contract:"mineralflow-production-reconciliation-0.1",mode:partner.bundle.mode,api,lease,district,policy,method:"sum_complete_lease_members_same_months_v1",oil,gas,
 decisionEffect:oil.status==="contradiction"||gas.status==="contradiction"?"REVIEW_SOURCE_CONTRADICTION":oil.status==="insufficient_data"||gas.status==="insufficient_data"?"MISSING_RECONCILIATION_EVIDENCE":"RECONCILIATION_PASSED",acquisitionDecision:"NOT_EVALUATED",
 limitations:["Reconciliation does not establish ownership, acquisition value or closing readiness.","Complete lease membership is a cited provider assertion, not independently established here.","No freshness policy or currentness is inferred from this historical reporting-period comparison."]};
}
