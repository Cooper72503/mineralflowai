/** Shared production engines, bundled for the retrieval worker; no PDF/UI dependency. */
import type {SupabaseClient} from "@supabase/supabase-js";
import {loadPortfolioInputs} from "./load";
import {buildPortfolioRecord} from "./record";
import {assembleGold2Draft,validateGold2Draft} from "../gold2/assemble";
import {loadTitleForApi} from "../gold2/title-link";
import {loadReviewedPosition} from "../gold2/position-link";
import {normalizeApiNumber} from "../normalization";
export async function assemblePackage(db:SupabaseClient,userId:string,raw:unknown){
 const {input,runs}=await loadPortfolioInputs(db,userId,raw);
 if(runs.some(r=>!["complete","failed","cancelled"].includes(r.status)))throw Error("Package retrieval is not terminal");
 const versions=runs.map(r=>({kind:"run",id:r.id,updated_at:r.updated_at,status:r.status}));
 const titleIds=[...new Set(runs.flatMap(r=>r.title_research_job_id?[r.title_research_job_id]:[]))];
 if(titleIds.length){
  const titles=await db.from("title_research_jobs").select("id,status,updated_at").eq("user_id",userId).in("id",titleIds);
  if(titles.error||titles.data?.length!==titleIds.length)throw Error("Package title scopes could not be loaded");
  if(titles.data.some(t=>["pending","resolving_wells","searching_records","ingesting","analyzing"].includes(t.status)))throw Error("Title workers are still active");
  versions.push(...titles.data.map(t=>({kind:"title",id:t.id,updated_at:t.updated_at,status:t.status})));
 }
 const asOf=new Date().toISOString();
 const record=buildPortfolioRecord(input,runs,asOf);
 const goldRecords=[];
 for(const run of runs){
  const api=normalizeApiNumber(run.original_input)?.api10;
  if(!api)throw Error("Queued API identity is invalid");
  if(run.resolved_primary_api&&normalizeApiNumber(run.resolved_primary_api)?.api10!==api)throw Error("Resolved API conflicts with package input");
  const title=await loadTitleForApi(db,api,userId,run.title_research_job_id);
  if(title.status==="query_failed")throw Error("Title evidence query failed; retry package generation");
  const selectedPosition=await loadReviewedPosition(db,userId,api,title.title);
  const draft=assembleGold2Draft({api,runId:run.id,asOf,attempts:run.attempts,title:title.title,titleLookup:{status:title.status,reason:title.reason},position:selectedPosition.position,positionLookupReason:selectedPosition.reason,partner:null,reconciliationPolicy:null,economics:null});
  if(validateGold2Draft(draft).length)throw Error("GOLD draft failed validation");
  goldRecords.push({runId:run.id,retrievalStatus:run.status,positionSelectionReason:selectedPosition.reason,draft});
 }
 return {input,record,goldRecords,versions};
}
