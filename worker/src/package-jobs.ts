import type {SupabaseClient} from "@supabase/supabase-js";
import {randomUUID} from "node:crypto";
import {checkedQuery} from "./persistence.js";
type Engine=(db:SupabaseClient,userId:string,input:unknown)=>Promise<{input:unknown;record:unknown;goldRecords:unknown;versions:unknown}>;
const engineUrl=new URL("../dist/report-engine.mjs",import.meta.url).href;
const defaultEngine:Engine=async(...args)=>(await import(engineUrl)).assemblePackage(...args);
const activeTitle=["pending","resolving_wells","searching_records","ingesting","analyzing"];
/** Persistent, fenced finalization; restarts reclaim expired work without duplicate snapshots. */
export async function processPackages(db:SupabaseClient,engine:Engine=defaultEngine){
 const now=new Date().toISOString();
 const packages: any[]=[];
 // Page past waiting packages so old work cannot starve newer packages.
 for(let offset=0;;offset+=100){
  const {data:page}=await checkedQuery(db.from("trrc_packages").select("id,user_id,members_json,request_json,status,claim_token,lease_until,attempts")
   .in("status",["queued","generating"]).order("created_at",{ascending:true}).order("id",{ascending:true}).range(offset,offset+99),"Package poll");
  packages.push(...page??[]);if(!page||page.length<100)break;
 }
 for(const pkg of packages){
  try {
  if(pkg.lease_until&&pkg.lease_until>now)continue;
  const members=pkg.members_json as {input:string;runId:string|null}[];
  const ids=[...new Set(members.flatMap(m=>m.runId?[m.runId]:[]))];
  if(ids.length){
   const {data:runs}=await checkedQuery(db.from("trrc_due_diligence_runs").select("id,status,title_research_job_id").eq("user_id",pkg.user_id).in("id",ids),"Package run readiness");
   if(runs?.length!==ids.length)throw Error("Package member runs missing");
   if(runs.some(r=>!["complete","failed","cancelled"].includes(r.status)))continue;
   const titles=[...new Set(runs.flatMap(r=>r.title_research_job_id?[r.title_research_job_id]:[]))];
   if(titles.length){
    const {data:jobs}=await checkedQuery(db.from("title_research_jobs").select("id,status").eq("user_id",pkg.user_id).in("id",titles),"Package title readiness");
    if(jobs?.length!==titles.length)throw Error("Package title jobs missing");
    if(jobs.some(j=>activeTitle.includes(j.status)))continue;
   }
  }
  const token=randomUUID();
  let claim=db.from("trrc_packages").update({status:"generating",claim_token:token,lease_until:new Date(Date.now()+15*60_000).toISOString(),attempts:pkg.attempts+1,updated_at:now}).eq("id",pkg.id).eq("status",pkg.status).eq("attempts",pkg.attempts);
  claim=pkg.claim_token?claim.eq("claim_token",pkg.claim_token):claim.is("claim_token",null);
  const {data:claimed}=await checkedQuery(claim.select("id"),"Package claim");
  if(!claimed?.length)continue;
  try{
   const result=await engine(db,pkg.user_id,{...pkg.request_json.options,members:members.map(m=>({input:m.input,runId:m.runId}))});
   await checkedQuery(db.rpc("finish_api_package",{p_id:pkg.id,p_token:token,p_input:result.input,p_record:result.record,p_gold:result.goldRecords,p_versions:result.versions}),"Package publication");
  }catch(error){
   console.error(`[package ${pkg.id}]`,error);
   await checkedQuery(db.from("trrc_packages").update({status:pkg.attempts>=4?"failed":"queued",claim_token:null,lease_until:new Date(Date.now()+60_000).toISOString(),error_summary:error instanceof Error?error.message:String(error),updated_at:new Date().toISOString()}).eq("id",pkg.id).eq("claim_token",token),"Package retry status");
  }
  } catch(error) {
   console.error(`[package ${pkg.id}] orchestration failed`,error);
   await checkedQuery(db.from("trrc_packages").update({error_summary:"Package orchestration failed; worker will retry. " +(error instanceof Error?error.message:String(error)),updated_at:new Date().toISOString()}).eq("id",pkg.id).eq("status",pkg.status).eq("attempts",pkg.attempts),"Package orchestration error");
  }

 }
}
