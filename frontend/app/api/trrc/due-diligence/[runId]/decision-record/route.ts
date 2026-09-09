import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { buildDecisionRecord } from "@/lib/trrc/decision-record";
import type { LiteSourceAttempt } from "@/lib/trrc/coverage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, {params}: {params: Promise<{runId:string}>}) {
  const db=await createSupabaseFromRouteRequest(request);
  const {data:{user},error:authError}=await db.auth.getUser();
  if(authError||!user)return NextResponse.json({error:"Not authenticated."},{status:401});
  const {runId}=await params;
  const {data:run,error}=await db.from("trrc_due_diligence_runs").select("*").eq("id",runId).eq("user_id",user.id).single();
  if(error||!run)return NextResponse.json({error:"Run not found or access denied."},{status:404});
  if(run.status!=="complete")return NextResponse.json({error:"Research has not completed."},{status:409});
  const {data:attempts,error:loadError}=await db.from("trrc_source_attempts").select("source_id,source_name,status,result_count,result_data_json,attempted_at,error_message").eq("run_id",runId).order("attempted_at",{ascending:true});
  if(loadError)return NextResponse.json({error:"Evidence could not be loaded; retry the request."},{status:503});
  try {
    const record=buildDecisionRecord(run,attempts as LiteSourceAttempt[]);
    return NextResponse.json(record,{headers:{"Cache-Control":"no-store","Content-Disposition":'attachment; filename="MineralFlow-Decision-Record.json"'}});
  }catch(err){
    console.error(`[Decision Record ${runId}]`,err);
    return NextResponse.json({error:"Decision Record failed evidence validation."},{status:500});
  }
}
