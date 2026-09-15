import {it,expect,vi,beforeEach} from "vitest";
import {createDueDiligenceRun} from "../create-run";
import {ensureTitleJobForApi} from "../title/ensure-job";
vi.mock("../entity-resolver",()=>({resolveEntities:vi.fn(async()=>({input_type:"api_number",normalized_input:"4216502733",entities:[],needs_user_selection:false}))}));
vi.mock("../title/ensure-job",()=>({ensureTitleJobForApi:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());
function db(failLink=false){
 const updates:unknown[]=[];const filters:unknown[]=[];
 return {updates,filters,from:()=>({insert:()=>({select:()=>({single:async()=>({data:{id:"run",status:"pending"},error:null})})}),update:(patch:unknown)=>{
   updates.push(patch);const q:any={eq:(...args:unknown[])=>{filters.push(args);return q;},select:()=>q,maybeSingle:async()=>({data:failLink?null:{id:"run"},error:failLink?{message:"column missing"}:null})};return q;
 }})};
}
it("persists the auto-created title scope on the authenticated run",async()=>{
 vi.mocked(ensureTitleJobForApi).mockResolvedValue({ok:true,created:true,jobId:"title",api10:"4216502733",reason:null});
 const d=db();const r=await createDueDiligenceRun(d as never,"owner",{input:"4216502733"});
 expect(r).toMatchObject({ok:true,id:"run"});expect(d.updates).toEqual([{title_research_job_id:"title"}]);expect(d.filters).toContainEqual(["user_id","owner"]);
});
it("returns a warning when the run-title link cannot be persisted",async()=>{
 vi.mocked(ensureTitleJobForApi).mockResolvedValue({ok:true,created:true,jobId:"title",api10:"4216502733",reason:null});
 const r=await createDueDiligenceRun(db(true) as never,"owner",{input:"4216502733"});
 expect(r).toMatchObject({ok:true,title_link_warning:expect.stringContaining("could not be persisted")});
});
it("does not bind an ambiguous scope",async()=>{
 vi.mocked(ensureTitleJobForApi).mockResolvedValue({ok:false,created:false,jobId:null,api10:"4216502733",reason:"Multiple live scopes"});
 const d=db();const r=await createDueDiligenceRun(d as never,"owner",{input:"4216502733"});
 expect(r).toMatchObject({ok:true,title_link_warning:"Multiple live scopes"});expect(d.updates).toEqual([]);
});
