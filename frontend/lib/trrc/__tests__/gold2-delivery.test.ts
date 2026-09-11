import {expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {generateGold2ForRun} from "../gold2/generate";
import {assembleGold2Draft,validateGold2Draft} from "../gold2/assemble";
import {GOLD2_FIELDS} from "../gold2/contract";
import {reviewedPositionFixture} from "./fixtures/reviewed-position";
function database(status="failed",resolved:string|null=null){
 const calls:{table:string;column:string;value:unknown}[]=[];
 const db={from:(table:string)=>{
  const response=table==="trrc_due_diligence_runs"?{data:{id:"run",original_input:"4216502733",resolved_primary_api:resolved,status},error:null}:{data:[],error:null};
  const q:any={}; for(const m of ['select','order'])q[m]=()=>q;
  q.eq=(column:string,value:unknown)=>{calls.push({table,column,value});return q};
  q.maybeSingle=()=>Promise.resolve(response);q.then=(f:unknown)=>Promise.resolve(response).then(f as any);return q;
 }} as unknown as SupabaseClient;
 return {db,calls};
}
it("delivers JSON from a failed API run, with explicit source and ownership gaps",async()=>{
 const {db,calls}=database();const r=await generateGold2ForRun(db,"run","owner","json");
 expect(r.ok).toBe(true);if(!r.ok)return;
 const report=JSON.parse(r.bytes.toString());expect(Object.keys(report.fields)).toHaveLength(GOLD2_FIELDS.length);
 expect(report.fields['ownership.nri']).toMatchObject({value:null,reasonCode:'position_not_supplied'});
 expect(report.fields['title.instruments'].reasonCode).toBe('reviewed_documents_insufficient');
 expect(report.fields['decision.posture'].value).toBe('INSUFFICIENT_DATA');
 expect(calls).toContainEqual({table:'trrc_due_diligence_runs',column:'user_id',value:'owner'});
 expect(calls).toContainEqual({table:'title_job_wells',column:'user_id',value:'owner'});
});
it("withholds a report if resolved identity differs from the requested API",async()=>{const {db}=database('complete','4216500004');const r=await generateGold2ForRun(db,'run','owner','json');expect(r).toMatchObject({ok:false,status:422});});
it("does not attach caller-supplied title or overwrite API/evidence",async()=>{const {db}=database();expect(await generateGold2ForRun(db,'run','owner','json',{api:'4216500004',title:{}})).toMatchObject({ok:false,status:422});});
it("does not turn active or cancelled retrieval into a completed report",async()=>{for(const status of ['retrieving','cancelled']){const {db}=database(status);expect(await generateGold2ForRun(db,'run','owner','json')).toMatchObject({ok:false,status:409});}});
it("connects title exceptions to independent rules without inventing a measured exposure",()=>{
 const {title,position}=reviewedPositionFixture();
 title.findings.push({findingId:'unreleased',type:'ENCUMBRANCE_NO_RELEASE',severity:'high',title:'Release not located',explanation:'Retained title analysis records an unreleased encumbrance.',affectedTractId:position.tractId,affectedTractLabel:null,affectedInterestType:'mineral',instrumentIds:['deed'],citations:[{documentId:'doc-deed',instrumentId:'deed',page:1,excerpt:null,sourceUrl:null,label:'Synthetic citation'}],nextAction:'Obtain and review the release.'});
 const r=assembleGold2Draft({api:'4216502733',runId:'run',asOf:'2026-09-10T12:00:00Z',attempts:[],title,position,partner:null,economics:null,reconciliationPolicy:null});
 expect(r.rulesInput.exceptions).toContainEqual({id:'unreleased',closingBlocker:true,resolved:false,measuredImpact:null,decisionMaterial:false});
 expect(r.fields['decision.next_actions'].value).toContain('Obtain and review the release.');
 expect(r.fields['economics.measured_exposure']).toMatchObject({value:null,reasonCode:'reviewed_documents_insufficient'});
 expect(validateGold2Draft(r)).toEqual([]);
});
it("labels remaining implementation gaps distinctly from absent partner observations",()=>{
 const r=assembleGold2Draft({api:'4216502733',runId:'run',asOf:'2026-09-10T12:00:00Z',attempts:[],title:null,position:null,partner:null,economics:null,reconciliationPolicy:null});
 expect(r.fields['geology.formation_tops'].reasonCode).toBe('partner_feed_unavailable');
 expect(r.fields['geology.tvd'].reasonCode).toBe('partner_feed_unavailable');
 expect(r.fields['economics.base_value'].reasonCode).toBe('buyer_criterion_not_supplied');
});
it("does not publish an uncited title finding as a material exception",()=>{
 const {title}=reviewedPositionFixture();title.findings.push({findingId:'uncited',type:'OVER_CONVEYANCE',severity:'critical',title:'Unsupported assertion',explanation:'No retained evidence.',affectedTractId:null,affectedTractLabel:null,affectedInterestType:null,instrumentIds:[],citations:[],nextAction:'Review evidence.'});
 const r=assembleGold2Draft({api:'4216502733',runId:'run',asOf:'2026-09-10T12:00:00Z',attempts:[],title,position:null,partner:null,economics:null,reconciliationPolicy:null});
 expect(r.titleContext.uncitedFindings.some(x=>x.id==='uncited')).toBe(true);
 expect(r.rulesInput.exceptions.some(x=>x.id==='uncited')).toBe(false);
 expect(r.fields['title.exceptions'].value).toBeNull();
 expect(r.rulesInput.titleEvidenceSufficient).toBe(false);
});
it("treats cited fraction and tract mismatches as independent review blockers",()=>{
 const {title,position}=reviewedPositionFixture();
 for(const type of ['FRACTION_INCONSISTENCY','TRACT_INTEREST_MISMATCH'] as const)title.findings.push({findingId:type,type,severity:'critical',title:'Synthetic mismatch',explanation:'Test evidence mismatch.',affectedTractId:position.tractId,affectedTractLabel:null,affectedInterestType:'mineral',instrumentIds:['deed'],citations:[{documentId:'doc-deed',instrumentId:'deed',page:1,excerpt:null,sourceUrl:null,label:'Test'}],nextAction:'Review mismatch.'});
 const r=assembleGold2Draft({api:'4216502733',runId:'run',asOf:'2026-09-10T12:00:00Z',attempts:[],title,position,partner:null,economics:null,reconciliationPolicy:null});
 for(const id of ['FRACTION_INCONSISTENCY','TRACT_INTEREST_MISMATCH'])expect(r.rulesInput.exceptions.find(x=>x.id===id)).toMatchObject({closingBlocker:true,decisionMaterial:true,measuredImpact:null});
});
