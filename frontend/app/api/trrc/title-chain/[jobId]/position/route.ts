import {NextRequest,NextResponse} from "next/server";
import {z} from "zod";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
import {ReviewedPositionSchema,linkReviewedMineralPosition} from "@/lib/trrc/decision-layer/ownership";
import {normalizeApiNumber} from "@/lib/trrc/normalization";
import {loadTitleForApi} from "@/lib/trrc/gold2/title-link";
export const dynamic="force-dynamic";
export async function POST(request:NextRequest,{params}:{params:Promise<{jobId:string}>}){
 const db=await createSupabaseFromRouteRequest(request);
 const {data:{user},error}=await db.auth.getUser();
 if(error||!user)return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
 const {jobId}=await params;
 if(!z.string().uuid().safeParse(jobId).success)return NextResponse.json({ok:false,error:"Invalid title job ID."},{status:400});
 const raw=await request.json().catch(()=>null);
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return NextResponse.json({ok:false,error:"A reviewed position object is required."},{status:400});
 const api=normalizeApiNumber(raw.api)?.api10;
 const parsed=ReviewedPositionSchema.safeParse({...raw,api,reviewedBy:user.id,reviewedAt:new Date().toISOString()});
 if(!parsed.success||!api)return NextResponse.json({ok:false,error:"Position must include the selected holding, tract and cited exact acreage/royalty/participation quantities."},{status:400});
 const title=await loadTitleForApi(db,api,user.id,jobId);
 if(title.status==="query_failed")return NextResponse.json({ok:false,error:title.reason},{status:503});
 if(!title.title)return NextResponse.json({ok:false,error:title.reason},{status:409});
 try{
  const result=linkReviewedMineralPosition(api,title.title,parsed.data);
  if(result.status!=="calculated")return NextResponse.json({ok:false,error:result.reason},{status:422});
  const saved=await db.rpc("save_reviewed_mineral_position",{p_job:jobId,p_api:api,p_analysis:title.title.analysisId,p_position:parsed.data});
  if(saved.error||!saved.data)return NextResponse.json({ok:false,error:"Position was not saved. Reload the title analysis and retry."},{status:409});
  return NextResponse.json({ok:true,data:{id:saved.data,nri:result.nri,method:result.method,limitations:result.limitations}},{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){console.error("[reviewed position]",error);return NextResponse.json({ok:false,error:"Position failed evidence/scope validation; no ownership was inferred."},{status:422});}
}
