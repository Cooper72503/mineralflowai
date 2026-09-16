import type {SupabaseClient} from "@supabase/supabase-js";
import {PortfolioRequest,buildPortfolioRecord,type RetainedRun} from "./record";
import type {LiteSourceAttempt} from "../coverage";

/** Read retained inputs only; no network fetches or valuation defaults during reporting. */
export async function loadPortfolioRecord(db:SupabaseClient,userId:string,raw:unknown){
 const input=PortfolioRequest.parse(raw);
 const ids=[...new Set(input.members.flatMap(m=>m.runId?[m.runId]:[]))];
 const runs:RetainedRun[]=[];
 // Bounded reads avoid response limits and a 49-well burst of concurrent queries.
 for(let start=0;start<ids.length;start+=4){
  const batch=await Promise.all(ids.slice(start,start+4).map(async id=>{
   const {data:run,error}=await db.from("trrc_due_diligence_runs").select("id,original_input,status,resolved_primary_api,updated_at").eq("id",id).eq("user_id",userId).maybeSingle();
   if(error)throw Error("Portfolio run lookup failed; report withheld.");
   if(!run)throw Error("A requested run is unavailable to this account; report withheld.");
   const attempts:LiteSourceAttempt[]=[];
   if(["complete","failed"].includes(run.status)){
    for(let offset=0;;offset+=500){
     if(offset>=10000)throw Error("Evidence read limit exceeded; no truncated report delivered.");
     const result=await db.from("trrc_source_attempts").select("source_id,source_name,status,result_count,error_message,attempted_at,result_data_json").eq("run_id",id).order("source_id",{ascending:true}).range(offset,offset+499);
     if(result.error||!result.data)throw Error("Retained portfolio evidence could not be loaded.");
     attempts.push(...result.data as LiteSourceAttempt[]);
     if(result.data.length<500)break;
    }
    // A retry may restart a completed run while evidence is being paged.
    const after=await db.from("trrc_due_diligence_runs").select("status,updated_at").eq("id",id).eq("user_id",userId).maybeSingle();
    if(after.error||!after.data||after.data.status!==run.status||after.data.updated_at!==run.updated_at)throw Error("A portfolio run changed during evidence loading; retry reporting.");
   }
   return {...run,attempts} as RetainedRun;
  }));
  runs.push(...batch);
 }
 return buildPortfolioRecord(input,runs);
}
