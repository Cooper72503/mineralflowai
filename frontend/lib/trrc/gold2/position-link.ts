import type {SupabaseClient} from "@supabase/supabase-js";
import type {TitleChainAnalysis} from "../title/chain-types";
import {linkReviewedMineralPosition} from "../decision-layer/ownership";
import {normalizeApiNumber} from "../normalization";
export class PositionLoadError extends Error {
 constructor(message:string, readonly status:409|503){super(message);this.name="PositionLoadError";}
}
/** Load only an explicit selection in the exact title scope; never choose a holder. */
export async function loadReviewedPosition(db:SupabaseClient,userId:string,apiInput:string,title:TitleChainAnalysis|null){
 if(!title)return {position:null,reason:"No published title analysis is available for a reviewed position."};
 const api=normalizeApiNumber(apiInput)?.api10;if(!api)throw Error("Invalid ownership API");
 const job=await db.from("title_research_jobs").select("reviewed_position_ids,latest_analysis_id").eq("id",title.jobId).eq("user_id",userId).maybeSingle();
 if(job.error||!job.data)throw new PositionLoadError("Reviewed position selection could not be loaded",503);
 if(job.data.latest_analysis_id!==title.analysisId)throw new PositionLoadError("Title analysis changed during position loading",409);
 const id=job.data.reviewed_position_ids?.[api];
 if(!id)return {position:null,reason:"No evaluated mineral position has been selected for this API and title scope."};
 const saved=await db.from("trrc_mineral_position_reviews").select("position_json,analysis_id").eq("id",id).eq("user_id",userId).eq("job_id",title.jobId).eq("api10",api).maybeSingle();
 if(saved.error||!saved.data)throw new PositionLoadError("Selected reviewed position could not be loaded",503);
 if(saved.data.analysis_id!==title.analysisId)return {position:null,reason:"Selected mineral position refers to an older title analysis; review and select it against the current analysis."};
 const linked=linkReviewedMineralPosition(api,title,saved.data.position_json);
 if(linked.status!=="calculated")return {position:null,reason:linked.reason};
 return {position:linked.position,reason:null};
}
