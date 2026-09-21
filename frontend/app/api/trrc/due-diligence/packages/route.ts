import {NextRequest,NextResponse} from "next/server";
import {z} from "zod";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
import {parseApiInput} from "@/lib/trrc/title/api-input";
import {isTrrcDdEnabled} from "@/lib/trrc/source-registry";
import {PortfolioScenarioSchema} from "@/lib/trrc/portfolio/scenario";
export const dynamic="force-dynamic";
const RequestSchema=z.object({requestKey:z.string().uuid(),inputs:z.array(z.string().trim().min(1).max(500)).min(1).max(50),options:z.object({askingPriceUsd:z.number().finite().positive().nullable().optional(),claimedWellCount:z.number().int().positive().max(10000).nullable().optional(),scenario:PortfolioScenarioSchema.optional()}).strict().default({})}).strict();
export async function POST(request:NextRequest){
 const db=await createSupabaseFromRouteRequest(request);
 const {data:{user},error}=await db.auth.getUser();
 if(error||!user)return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
 if(!isTrrcDdEnabled())return NextResponse.json({ok:false,error:"Due diligence unavailable."},{status:503});
 const parsed=RequestSchema.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return NextResponse.json({ok:false,error:"Provide a request key and 1–50 API entries with valid package options."},{status:400});
 const entries=parsed.data.inputs.map(input=>{const p=parseApiInput(input);return {input,api10:p.ok?p.api10:null,api14:p.api14,countyName:p.countyName,sidetrackSuffix:p.sidetrackSuffix,completionSuffix:p.completionSuffix,error:p.error};});
 const result=await db.rpc("enqueue_api_package",{p_key:parsed.data.requestKey,p_entries:entries,p_options:parsed.data.options});
 if(result.error||!result.data){console.error("[package intake]",result.error);return NextResponse.json({ok:false,error:"Package could not be confirmed. Retry the same submission key; do not create a new submission."},{status:503});}
 return NextResponse.json({ok:true,data:{id:result.data}},{status:202,headers:{"Cache-Control":"private, no-store"}});
}
