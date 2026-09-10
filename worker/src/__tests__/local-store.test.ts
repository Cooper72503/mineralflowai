import {describe,it,expect,vi} from "vitest";
import {createLocalStore} from "../local-store.js";
describe("standalone worker persistence",()=>{
 it("preserves cancellation through conditional updates",async()=>{
  const {db,snapshot}=createLocalStore({id:"r",status:"cancelled"});
  await db.from("trrc_due_diligence_runs").update({status:"complete"}).eq("id","r").neq("status","cancelled");
  expect(snapshot.trrc_due_diligence_runs[0].status).toBe("cancelled");
  const wrong=await db.from("trrc_due_diligence_runs").select("*").eq("id","other").single();
  expect(wrong.error).toBeTruthy();
 });
 it("upserts on the full composite key and checkpoints detached snapshots",async()=>{
  const checkpoints:unknown[]=[];
  const {db,snapshot}=createLocalStore({id:"r"},async state=>{checkpoints.push(state);});
  const row={run_id:"r",source_id:"gis",status:"failed_transient"};
  await db.from("trrc_source_attempts").upsert(row,{onConflict:"run_id,source_id"});
  await db.from("trrc_source_attempts").upsert({...row,status:"success"},{onConflict:"run_id,source_id"});
  await db.from("trrc_source_attempts").upsert({...row,run_id:"other"},{onConflict:"run_id,source_id"});
  expect(snapshot.trrc_source_attempts).toHaveLength(2);
  expect(checkpoints[0]).toMatchObject({trrc_source_attempts:[{status:"failed_transient"}]});
  const result=await db.from("trrc_source_attempts").select("*").eq("run_id","r");
  result.data![0].status="changed";
  expect(snapshot.trrc_source_attempts[0].status).toBe("success");
 });
 it("surfaces checkpoint failures instead of confirming persistence",async()=>{
  const checkpoint=vi.fn().mockRejectedValue(Error("Disk full"));
  const {db}=createLocalStore({id:"r"},checkpoint);
  await expect(db.from("trrc_source_attempts").upsert({source_id:"x"})).rejects.toThrow("Disk full");
 });
 it("rejects unsupported tables, including inherited object names",()=>{
  const {db}=createLocalStore({id:"r"});
  expect(()=>db.from("unknown")).toThrow("Unsupported local-store table");
  expect(()=>db.from("toString")).toThrow("Unsupported local-store table");
 });
});
