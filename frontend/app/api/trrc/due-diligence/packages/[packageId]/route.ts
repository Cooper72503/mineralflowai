import {NextRequest,NextResponse} from "next/server";
import {z} from "zod";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest,{params}:{params:Promise<{packageId:string}>}){
 const db=await createSupabaseFromRouteRequest(request);
 const {data:{user},error}=await db.auth.getUser();
 if(error||!user)return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
 const {packageId}=await params;
 if(!z.string().uuid().safeParse(packageId).success)return NextResponse.json({ok:false,error:"Invalid package ID."},{status:400});
 const result=await db.from("trrc_packages").select("id,members_json,status,record_id,error_summary,created_at,updated_at").eq("id",packageId).eq("user_id",user.id).maybeSingle();
 if(result.error)return NextResponse.json({ok:false,error:"Package lookup failed."},{status:503});
 if(!result.data)return NextResponse.json({ok:false,error:"Package not found."},{status:404});
 if(request.nextUrl.searchParams.get("format")==="gold2-json"){
  if(result.data.status!=="evidence_ready")return NextResponse.json({ok:false,error:"Package evidence is not ready."},{status:409});
  const saved=await db.from("trrc_packages").select("gold_records_json").eq("id",packageId).eq("user_id",user.id).single();
  if(saved.error||!saved.data)return NextResponse.json({ok:false,error:"Saved GOLD records could not be loaded."},{status:503});
  return NextResponse.json({packageId,recordId:result.data.record_id,acceptance:"Drafts with explicit evidence gaps; structural validity is not acquisition approval.",records:saved.data.gold_records_json},{headers:{"Cache-Control":"private, no-store","Content-Disposition":`attachment; filename="MineralFlow-${packageId}-GOLD-drafts.json"`}});
 }
 const ids=(result.data.members_json as {runId:string|null}[]).flatMap(m=>m.runId?[m.runId]:[]);
 const runs=ids.length?await db.from("trrc_due_diligence_runs").select("id,status,progress_percent,error_summary,title_setup_warning").eq("user_id",user.id).in("id",ids):{data:[],error:null};
 if(runs.error||runs.data?.length!==new Set(ids).size)return NextResponse.json({ok:false,error:"Package membership could not be fully loaded."},{status:503});
 return NextResponse.json({ok:true,data:{...result.data,runs:runs.data}},{headers:{"Cache-Control":"private, no-store"}});
}
export async function POST(request:NextRequest,{params}:{params:Promise<{packageId:string}>}){
 const db=await createSupabaseFromRouteRequest(request);
 const {data:{user},error}=await db.auth.getUser();
 if(error||!user)return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
 const {packageId}=await params;
 if(!z.string().uuid().safeParse(packageId).success)return NextResponse.json({ok:false,error:"Invalid package ID."},{status:400});
 const result=await db.rpc("retry_api_package",{p_id:packageId});
 if(result.error)return NextResponse.json({ok:false,error:"Retry could not be queued."},{status:503});
 if(!result.data)return NextResponse.json({ok:false,error:"No failed package available to retry."},{status:409});
 return NextResponse.json({ok:true},{status:202});
}
