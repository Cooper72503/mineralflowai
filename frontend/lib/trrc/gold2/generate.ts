/** Auth-scoped report delivery for the existing diligence UI. */
import type {SupabaseClient} from "@supabase/supabase-js";
import {normalizeApiNumber} from "../normalization";
import type {LiteSourceAttempt} from "../coverage";
import {assembleGold2Draft} from "./assemble";
import {loadTitleForApi} from "./title-link";
import {renderGold2Pdf} from "./pdf";
export async function generateGold2ForRun(db:SupabaseClient,runId:string,userId:string,format:"pdf"|"json"){
 const {data:run,error}=await db.from("trrc_due_diligence_runs").select("*").eq("id",runId).eq("user_id",userId).maybeSingle();
 if(error)return {ok:false as const,status:503,error:"Report run could not be loaded. Retry the request."};
 if(!run)return {ok:false as const,status:404,error:"Run not found or access denied."};
 if(!["complete","failed"].includes(run.status))return {ok:false as const,status:409,error:"Retrieval is still running or was cancelled."};
 const api=normalizeApiNumber(run.resolved_primary_api??run.original_input)?.api10;
 if(!api)return {ok:false as const,status:422,error:"This run has no supported Texas API for a GOLD report."};
 const {data:rows,error:attemptError}=await db.from("trrc_source_attempts").select("source_id, source_name, status, result_count, result_data_json, attempted_at, error_message").eq("run_id",runId).order("attempted_at",{ascending:true});
 if(attemptError)return {ok:false as const,status:503,error:"Retained report evidence could not be loaded. Retry the request."};
 const attempts=(rows??[]) as LiteSourceAttempt[];
 try{
  const titleLink=await loadTitleForApi(db,api,userId);
  const report=assembleGold2Draft({api,runId,asOf:new Date().toISOString(),attempts,title:titleLink.title,titleLookup:{status:titleLink.status,reason:titleLink.reason},position:null,partner:null,reconciliationPolicy:null,economics:null});
  const bytes=format==="pdf"?await renderGold2Pdf(report):Buffer.from(JSON.stringify(report,null,2)+"\n");
  return {ok:true as const,bytes,filename:`${api}-gold2.${format}`,contentType:format==="pdf"?"application/pdf":"application/json"};
 }catch{return {ok:false as const,status:422,error:"Retained inputs failed report validation; no report containing unvalidated values was delivered."};}
}
