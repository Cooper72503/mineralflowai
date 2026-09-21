import {it,expect,vi} from "vitest";
import {processPackages} from "../package-jobs.js";
function database({run="complete",title="awaiting_tract_confirmation",status="queued",lease=null as string|null,attempts=0}={}){
 const writes:any[]=[];let claim="";
 const pkg={id:"package",user_id:"owner",members_json:[{input:"4216502733",runId:"run"}],request_json:{options:{askingPriceUsd:2500000}},status,claim_token:status==="generating"?"old":null,lease_until:lease,attempts};
 const db:any={rpc:vi.fn(async()=>({data:"record",error:null})),from:(table:string)=>{
  let patch:any=null;
  const q:any={select:()=>q,order:()=>q,range:()=>q,eq:()=>q,in:()=>q,is:()=>q,update:(p:any)=>{patch=p;writes.push(p);if(p.claim_token)claim=p.claim_token;return q;},then:(ok:any,bad:any)=>Promise.resolve({data:patch?[{id:"package"}]:table==="trrc_packages"?[pkg]:table==="trrc_due_diligence_runs"?[{id:"run",status:run,title_research_job_id:"title"}]:[{id:"title",status:title}],error:null}).then(ok,bad)};return q;
 }};return {db,writes,getClaim:()=>claim};
}
const output={input:{},record:{decision:{posture:"INSUFFICIENT_DATA"}},goldRecords:[],versions:[]};
it("publishes after retrieval stops at a legitimate title review, with original package inputs",async()=>{
 const {db,writes,getClaim}=database();const engine=vi.fn(async()=>output);await processPackages(db,engine);
 expect(engine).toHaveBeenCalledWith(db,"owner",{askingPriceUsd:2500000,members:[{input:"4216502733",runId:"run"}]});
 expect(writes[0]).toMatchObject({status:"generating",attempts:1});expect(db.rpc).toHaveBeenCalledWith("finish_api_package",expect.objectContaining({p_token:getClaim(),p_record:output.record}));
});
it.each([{run:"running"},{title:"searching_records"}])("does not snapshot active workers: %j",async settings=>{
 const {db,writes}=database(settings);const engine=vi.fn();await processPackages(db,engine);expect(engine).not.toHaveBeenCalled();expect(writes).toEqual([]);
});
it("recovers an expired claim after a crash",async()=>{
 const {db,getClaim}=database({status:"generating",lease:"2000-01-01T00:00:00Z"});await processPackages(db,async()=>output);expect(getClaim()).not.toBe("old");expect(db.rpc).toHaveBeenCalledTimes(1);
});
it("does not steal an unexpired claim",async()=>{
 const {db}=database({status:"generating",lease:"2999-01-01T00:00:00Z"});const engine=vi.fn();await processPackages(db,engine);expect(engine).not.toHaveBeenCalled();
});
it.each([0,4])("records failed generation without publication, attempt %i",async attempts=>{
 const {db,writes}=database({attempts});await processPackages(db,async()=>{throw Error("Evidence changed");});
 expect(db.rpc).not.toHaveBeenCalled();expect(writes.at(-1)).toMatchObject({status:attempts===4?"failed":"queued",error_summary:"Evidence changed",claim_token:null});
});
