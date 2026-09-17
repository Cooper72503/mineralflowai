import {it,expect,vi} from "vitest";
import {createDueDiligenceBatch} from "../create-batch";
import {createDueDiligenceRun} from "../create-run";
vi.mock("../create-run",()=>({createDueDiligenceRun:vi.fn()}));
it("isolates rejected and thrown intake failures, preserves order and bounds concurrency",async()=>{
 let active=0,max=0;
 vi.mocked(createDueDiligenceRun).mockImplementation(async(_db,_user,{input})=>{
  active++;max=Math.max(max,active);
  await new Promise(resolve=>setTimeout(resolve,input==="first"?15:1));active--;
  if(input==="throws")throw Error("transport failed");
  if(input==="invalid")return {ok:false,error:"Invalid Texas API number.",original_input:input};
  return {ok:true,id:input!,original_input:input!,status:"pending",needs_user_selection:false,normalized_input:input!,input_type:"api_number",entities:[]};
 });
 const inputs=["first","throws","invalid","fourth","fifth","sixth"];
 const results=await createDueDiligenceBatch({} as never,"owner",inputs);
 expect(results.map(r=>r.original_input)).toEqual(inputs);
 expect(results.map(r=>r.ok)).toEqual([true,false,false,true,true,true]);
 expect(max).toBe(3);expect(results[1]).toMatchObject({error:expect.stringContaining("Check run history")});
});
