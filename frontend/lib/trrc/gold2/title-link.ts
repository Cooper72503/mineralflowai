/** Resolve already-researched title evidence by exact API and authenticated owner. */
import type {SupabaseClient} from "@supabase/supabase-js";
import type {TitleChainAnalysis} from "../title/chain-types";
import {normalizeApiNumber} from "../normalization";
export async function loadTitleForApi(db:SupabaseClient,input:string,userId:string,selectedJobId?:string|null){
 const api=normalizeApiNumber(input)?.api10;if(!api)throw Error("Invalid title linkage API");
 const unavailable=(reason:string,status:"not_found"|"ambiguous"|"query_failed"|"in_progress")=>({title:null,status,reason});
 const wells=await db.from("title_job_wells").select("job_id").eq("user_id",userId).eq("api10",api);
 if(wells.error)return unavailable("Matching title research could not be loaded; the lookup failed.","query_failed");
 const matchingIds=[...new Set((wells.data??[]).map(w=>String(w.job_id)))];
 if(selectedJobId&&!matchingIds.includes(selectedJobId))return unavailable("The run's selected title job does not match this account and API; title withheld.","query_failed");
 const ids=selectedJobId?[selectedJobId]:matchingIds;
 if(!ids.length)return unavailable("No title research job for this API is present in this account.","not_found");
 const jobs=await db.from("title_research_jobs").select("id, latest_analysis_id, status").eq("user_id",userId).in("id",ids);
 if(jobs.error)return unavailable("Published title analysis references could not be loaded.","query_failed");
 const eligible=(jobs.data??[]).filter(j=>(!selectedJobId||j.id===selectedJobId)&&!["cancelled","failed"].includes(String(j.status)));
 if(selectedJobId&&!eligible.some(j=>j.id===selectedJobId))return unavailable("The selected title job is unavailable, failed, or cancelled; select an active research scope.","not_found");
 if(eligible.length>1)return unavailable("Multiple title research scopes match this API; a specific analysis/position must be selected.","ambiguous");
 if(!eligible.length)return unavailable("No active title research scope matches this API.","not_found");
 const published=eligible.filter(j=>j.latest_analysis_id);
 if(!published.length){
  // A job exists but nothing is published yet. Say WHERE it is — the stage
  // the worker left it at and every open review item — instead of the
  // same "no analysis" line a job-less API gets. Live-observed 2026-09-14:
  // a Gaines County job stopped at tract confirmation with an open
  // "county records must be supplied manually" item; the report should
  // tell the buyer exactly that, because it is the next action.
  const latest=await db.from("title_research_jobs").select("id, status, stage_detail, updated_at").eq("user_id",userId).in("id",eligible.map(j=>j.id)).order("updated_at",{ascending:false}).limit(1).maybeSingle();
  if(latest.error)return unavailable("Title research progress could not be loaded.","query_failed");
  const job=latest.data;
  if(!job)return unavailable("Matching title jobs have no published analysis yet.","in_progress");
  const items=await db.from("title_review_items").select("title, kind").eq("job_id",job.id).eq("user_id",userId).eq("status","open").limit(5);
  if(items.error)return unavailable("Open title review items could not be loaded; title progress is unverified.","query_failed");
  const open=(items.data??[]).map(i=>String(i.title)).filter(Boolean);
  const stage=String(job.stage_detail??job.status??"in progress");
  const reason=`Title research job ${String(job.id).slice(0,8)} is in progress — ${stage}.`+(open.length?` Open review items: ${open.join("; ")}.`:"")+" No analysis has been published for this API yet.";
  return unavailable(reason,"in_progress");
 }
 if(published.length!==1)return unavailable("Multiple title research scopes match this API; a specific analysis/position must be selected.","ambiguous");
 const selected=published[0];
 const result=await db.from("title_analyses").select("analysis_json").eq("id",selected.latest_analysis_id).eq("job_id",selected.id).eq("user_id",userId).maybeSingle();
 if(result.error)return unavailable("Selected published title analysis could not be loaded.","query_failed");
 const title=result.data?.analysis_json as TitleChainAnalysis|undefined;
 if(!title||title.analysisId!==selected.latest_analysis_id||title.jobId!==selected.id||!Array.isArray(title.wells)||!title.wells.some(w=>normalizeApiNumber(w.api14??w.formatted??w.originalInput)?.api10===api))return unavailable("Published title payload does not verify the selected job and subject API.","query_failed");
 return {title,status:"linked" as const,reason:null};
}
