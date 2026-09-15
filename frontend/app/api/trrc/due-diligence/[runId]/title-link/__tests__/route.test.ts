import {it,expect,vi} from "vitest";
import {NextRequest} from "next/server";
import {POST} from "../route";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
vi.mock("@/lib/supabase/from-route-request",()=>({createSupabaseFromRouteRequest:vi.fn()}));
const runId="00000000-0000-4000-8000-000000000001", jobId="00000000-0000-4000-8000-000000000011";
async function call(options:{authenticated?:boolean;linkError?:boolean;jobStatus?:string}={}){
 const writes:unknown[]=[];const filters:unknown[]=[];
 vi.mocked(createSupabaseFromRouteRequest).mockResolvedValue({auth:{getUser:async()=>({data:{user:options.authenticated===false?null:{id:"owner"}},error:null})},from:(table:string)=>{
 const q:any={select:()=>q,eq:(...args:unknown[])=>{filters.push([table,...args]);return q;},update:(v:unknown)=>{writes.push(v);return q;},maybeSingle:async()=>table==="title_research_jobs"?{data:{id:jobId,status:options.jobStatus??"pending"},error:null}:{data:options.linkError?null:{id:runId,title_research_job_id:jobId},error:options.linkError?{message:"API mismatch"}:null}};return q;
 }} as never);
 const response=await POST(new NextRequest("http://localhost/api/title-link",{method:"POST",body:JSON.stringify({jobId}),headers:{"Content-Type":"application/json"}}),{params:Promise.resolve({runId})});
 return {response,writes,filters};
}
it("requires an authenticated account",async()=>{const r=await call({authenticated:false});expect(r.response.status).toBe(401);expect(r.writes).toEqual([]);});
it("does not bind a cancelled research scope",async()=>{const r=await call({jobStatus:"cancelled"});expect(r.response.status).toBe(404);expect(r.writes).toEqual([]);});
it("reports a database-rejected API link without claiming success",async()=>{expect((await call({linkError:true})).response.status).toBe(409);});
it("persists an explicit selection under the run owner",async()=>{const r=await call();expect(r.response.status).toBe(200);expect(r.writes).toEqual([{title_research_job_id:jobId}]);expect(r.filters).toContainEqual(["trrc_due_diligence_runs","user_id","owner"]);});
