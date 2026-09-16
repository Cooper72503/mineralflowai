import {NextRequest,NextResponse} from "next/server";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
import {PortfolioRequest} from "@/lib/trrc/portfolio/record";
import {loadPortfolioRecord} from "@/lib/trrc/portfolio/load";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function POST(request:NextRequest){
 const db=await createSupabaseFromRouteRequest(request);
 const {data:{user},error}=await db.auth.getUser();
 if(error||!user)return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
 const parsed=PortfolioRequest.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return NextResponse.json({ok:false,error:"Provide 1–100 portfolio members with input and runId (or null), and valid optional asking price and claimed well count."},{status:400});
 try{
  const record=await loadPortfolioRecord(db,user.id,parsed.data);
  const saved=await db.from("trrc_portfolio_records").insert({user_id:user.id,input_json:parsed.data,record_json:record}).select("id").single();
  if(saved.error||!saved.data)return NextResponse.json({ok:false,error:"Portfolio record could not be saved. Verify migration 034 and retry."},{status:503});
  return NextResponse.json({ok:true,data:{id:saved.data.id,record}},{headers:{"Cache-Control":"private, no-store"}});
 }catch(err){
  console.error("[portfolio-record]",err);
  return NextResponse.json({ok:false,error:"Portfolio evidence could not be validated or accessed. No incomplete subset was silently substituted; verify the inputs and retry."},{status:422});
 }
}
