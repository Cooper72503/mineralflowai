/** Resolve already-researched title evidence by exact API and authenticated owner. */
import type {SupabaseClient} from "@supabase/supabase-js";
import type {TitleChainAnalysis} from "../title/chain-types";
import {normalizeApiNumber} from "../normalization";
export async function loadTitleForApi(db:SupabaseClient,input:string,userId:string){
 const api=normalizeApiNumber(input)?.api10;if(!api)throw Error("Invalid title linkage API");
 const unavailable=(reason:string,status:"not_found"|"ambiguous"|"query_failed")=>({title:null,status,reason});
 const wells=await db.from("title_job_wells").select("job_id").eq("user_id",userId).eq("api10",api);
 if(wells.error)return unavailable("Matching title research could not be loaded; the lookup failed.","query_failed");
 const ids=[...new Set((wells.data??[]).map(w=>String(w.job_id)))];
 if(!ids.length)return unavailable("No title research job for this API is present in this account.","not_found");
 const jobs=await db.from("title_research_jobs").select("id, latest_analysis_id").eq("user_id",userId).in("id",ids);
 if(jobs.error)return unavailable("Published title analysis references could not be loaded.","query_failed");
 const published=(jobs.data??[]).filter(j=>j.latest_analysis_id);
 if(!published.length)return unavailable("Matching title jobs have no published analysis yet.","not_found");
 if(published.length!==1)return unavailable("Multiple title research scopes match this API; a specific analysis/position must be selected.","ambiguous");
 const selected=published[0];
 const result=await db.from("title_analyses").select("analysis_json").eq("id",selected.latest_analysis_id).eq("job_id",selected.id).eq("user_id",userId).maybeSingle();
 if(result.error)return unavailable("Selected published title analysis could not be loaded.","query_failed");
 const title=result.data?.analysis_json as TitleChainAnalysis|undefined;
 if(!title||title.analysisId!==selected.latest_analysis_id||title.jobId!==selected.id||!Array.isArray(title.wells)||!title.wells.some(w=>normalizeApiNumber(w.api14??w.formatted??w.originalInput)?.api10===api))return unavailable("Published title payload does not verify the selected job and subject API.","query_failed");
 return {title,status:"linked" as const,reason:null};
}
