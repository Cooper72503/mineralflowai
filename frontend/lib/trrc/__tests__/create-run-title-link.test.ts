import {it,expect,vi,beforeEach} from "vitest";
import {createDueDiligenceRun} from "../create-run";
import {ensureTitleJobForApi} from "../title/ensure-job";
import {resolveEntities} from "../entity-resolver";
vi.mock("../entity-resolver",()=>({resolveEntities:vi.fn()}));
vi.mock("../title/ensure-job",()=>({ensureTitleJobForApi:vi.fn()}));
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(resolveEntities).mockResolvedValue({input_type:"api_number",normalized_input:"4216502733",entities:[],needs_user_selection:false} as never);
 vi.mocked(ensureTitleJobForApi).mockResolvedValue({ok:true,created:true,jobId:"title",api10:"4216502733",reason:null});
});
function db(fail=false){return {rpc:vi.fn(async()=>({data:fail?null:{id:"run",status:"pending"},error:fail?{message:"transaction failed"}:null})),from:vi.fn(()=>{throw Error("Non-atomic write forbidden");})};}
it("publishes title link and candidate entities in one authenticated RPC",async()=>{
 const entity={id:"candidate",entity_type:"wellbore",canonical_identifier:"4216502733",attributes:{well:"1D"}};
 vi.mocked(resolveEntities).mockResolvedValue({input_type:"api_number",normalized_input:"4216502733",entities:[entity],needs_user_selection:false} as never);
 const d=db();const r=await createDueDiligenceRun(d as never,"owner",{input:"4216502733"});
 expect(r).toMatchObject({ok:true,id:"run"});
 expect(d.rpc).toHaveBeenCalledWith("create_due_diligence_run",expect.objectContaining({p_run:expect.objectContaining({title_research_job_id:"title",status:"pending"}),p_entities:[expect.objectContaining({id:"candidate",attributes_json:{well:"1D"}})]}));
 expect(d.from).not.toHaveBeenCalled();
 expect(vi.mocked(ensureTitleJobForApi).mock.invocationCallOrder[0]).toBeLessThan(d.rpc.mock.invocationCallOrder[0]);
});
it("fails closed when atomic persistence fails; never queues via separate writes",async()=>{
 const d=db(true);const r=await createDueDiligenceRun(d as never,"owner",{input:"4216502733"});
 expect(r).toMatchObject({ok:false,error:"Failed to create due diligence run."});expect(d.from).not.toHaveBeenCalled();
});
it("persists an ambiguous title warning without binding an arbitrary scope",async()=>{
 vi.mocked(ensureTitleJobForApi).mockResolvedValue({ok:false,created:false,jobId:null,api10:"4216502733",reason:"Multiple live scopes"});
 const d=db();const r=await createDueDiligenceRun(d as never,"owner",{input:"4216502733"});
 expect(r).toMatchObject({ok:true,title_link_warning:"Multiple live scopes"});
 expect(d.rpc.mock.calls[0]).toEqual(["create_due_diligence_run",expect.objectContaining({p_run:expect.objectContaining({title_research_job_id:null,title_setup_warning:"Multiple live scopes"})})]);
});
it("records thrown title setup failures while allowing regulatory retrieval",async()=>{
 vi.mocked(ensureTitleJobForApi).mockRejectedValue(Error("fetch failed"));
 const d=db();expect(await createDueDiligenceRun(d as never,"owner",{input:"4216502733"})).toMatchObject({ok:true,title_link_warning:expect.stringContaining("setup failed")});
});
it("keeps ambiguous asset resolution out of the worker queue",async()=>{
 vi.mocked(resolveEntities).mockResolvedValue({input_type:"api_number",normalized_input:"4216502733",entities:[],needs_user_selection:true} as never);
 const d=db();expect(await createDueDiligenceRun(d as never,"owner",{input:"4216502733"})).toMatchObject({ok:true,status:"awaiting_selection"});
 expect(ensureTitleJobForApi).not.toHaveBeenCalled();
 expect(d.rpc.mock.calls[0]).toEqual(["create_due_diligence_run",expect.objectContaining({p_run:expect.objectContaining({status:"awaiting_selection"})})]);
});
it.each([null,{}, {input:42}])("rejects malformed intake before queueing: %j",async body=>{
 const d=db();expect(await createDueDiligenceRun(d as never,"owner",body as never)).toMatchObject({ok:false});expect(d.rpc).not.toHaveBeenCalled();
});
