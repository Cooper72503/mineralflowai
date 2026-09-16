import {NextRequest,NextResponse} from "next/server";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
import {z} from "zod";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest,{params}:{params:Promise<{recordId:string}>}){
 const db=await createSupabaseFromRouteRequest(request);
 const {data:{user},error}=await db.auth.getUser();
 if(error||!user)return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
 const {recordId}=await params;
 if(!z.string().uuid().safeParse(recordId).success)return NextResponse.json({ok:false,error:"Invalid portfolio record ID."},{status:400});
 const result=await db.from("trrc_portfolio_records").select("id,record_json").eq("id",recordId).eq("user_id",user.id).maybeSingle();
 if(result.error)return NextResponse.json({ok:false,error:"Portfolio record lookup failed."},{status:503});
 if(!result.data)return NextResponse.json({ok:false,error:"Portfolio record not found or access denied."},{status:404});
 return NextResponse.json({ok:true,data:{id:result.data.id,record:result.data.record_json}},{headers:{"Cache-Control":"private, no-store"}});
}
