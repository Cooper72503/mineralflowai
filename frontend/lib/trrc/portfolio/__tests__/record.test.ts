import {it,expect} from "vitest";
import {buildPortfolioRecord,type RetainedRun,type PortfolioInput} from "../record";
import type {LiteSourceAttempt} from "../../coverage";
const asOf="2026-09-16T00:00:00Z";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
export function fixture(n:number,lease="10001",district="8A",type="O",oil:number|null=100):RetainedRun{
 const api=`42165${String(n).padStart(5,"0")}`;
 const attempt=(source:string,data:Record<string,unknown>):LiteSourceAttempt=>({source_id:source,source_name:source,status:"success",attempted_at:"2026-09-15T00:00:00Z",result_count:1,error_message:null,result_data_json:{query_url:"https://webapps2.rrc.texas.gov/EWA/productionQueryAction.do",...data}});
 return {id:id(n),original_input:api,status:"complete",resolved_primary_api:api,attempts:[
  attempt("search_by_api",{found:true,wells:[{api_no:api,lease_no:lease,district,on_schedule:"Y"}]}),
  attempt("fetch_production",{found:true,lease_number:lease,district,lease_type_attempts:[{lease_type:type,status:"found"}],rows:[{production_month:"2026-08-01",oil_bbl:oil,gas_mcf:null,casinghead_gas_mcf:20,condensate_bbl:null,water_bbl:null}]})
 ]};
}
function input(runs:RetainedRun[],overrides:Partial<PortfolioInput>={}):PortfolioInput{return {members:runs.map(r=>({input:r.original_input,runId:r.id})),claimedWellCount:new Set(runs.map(r=>r.original_input)).size,askingPriceUsd:2500000,...overrides};}
const oil=(r:ReturnType<typeof buildPortfolioRecord>)=>r.production.grossMonthly[0]?.volumes.oil_bbl.value;
it("counts 49 synthetic well entries sharing two leases as two production streams, never 49 streams",()=>{
 const runs=Array.from({length:49},(_,i)=>fixture(i+1,i<47?"10001":"10002","8A","O",i<47?100:50));
 const r=buildPortfolioRecord(input(runs),runs,asOf);
 expect(r.inventory.submittedEntries).toBe(49);expect(r.production.leaseStreams).toHaveLength(2);expect(oil(r)).toBe(150);
 expect(r.production.grossMonthly[0].volumes.oil_bbl.citations).toHaveLength(49);
 expect(r.decision.goldValidated).toBe(false);expect(r.economics.maximumBuyPriceUsd.value).toBeNull();expect(r.economics.exitValueUsd.value).toBeNull();
});
it("keeps identically numbered leases in different districts and oil/gas namespaces separate",()=>{
 const runs=[fixture(1),fixture(2,"10001","7C"),fixture(3,"10001","8A","G")];const r=buildPortfolioRecord(input(runs),runs,asOf);
 expect(r.production.leaseStreams).toHaveLength(3);expect(oil(r)).toBe(300);
});
it("withholds conflicting same-stream observations rather than adding or choosing the newest",()=>{
 const runs=[fixture(1),fixture(2,"10001","8A","O",101)];const r=buildPortfolioRecord(input(runs),runs,asOf);
 expect(oil(r)).toBeNull();expect(r.decision.blockers.join(" ")).toContain("Conflicting oil_bbl");
});
it("does not turn absent phases into zero",()=>{
 const runs=[fixture(1)];const r=buildPortfolioRecord(input(runs),runs,asOf);
 expect(r.production.grossMonthly[0].volumes.water_bbl.value).toBeNull();expect(r.production.grossMonthly[0].volumes.gas_mcf.value).toBeNull();
});
it("preserves failed intake entries and withholds incomplete totals",()=>{
 const runs=[fixture(1)];const i=input(runs);i.members.push({input:"42-165-502084",runId:null});
 const r=buildPortfolioRecord(i,runs,asOf);expect(r.inventory.members).toHaveLength(2);expect(r.inventory.members[1].reason).toContain("Invalid");expect(oil(r)).toBeNull();
});
it("exposes a claimed 52 versus listed 49 discrepancy",()=>{
 const runs=Array.from({length:49},(_,i)=>fixture(i+1));const r=buildPortfolioRecord(input(runs,{claimedWellCount:52}),runs,asOf);
 expect(r.decision.blockers.join(" ")).toContain("Claimed 52 wells differs from 49");expect(oil(r)).toBeNull();
});
it("fails closed when a requested run is missing or attached to the wrong input",()=>{
 const run=fixture(1);expect(()=>buildPortfolioRecord(input([run]),[],asOf)).toThrow("run set");
 const i=input([run]);i.members[0].input="4216500002";expect(()=>buildPortfolioRecord(i,[run],asOf)).toThrow("does not match");
});
it("does not resurrect old production after a failed latest retrieval",()=>{
 const run=fixture(1);run.attempts.push({...run.attempts[1],source_id:"retry",attempted_at:"2026-09-15T01:00:00Z",status:"failed_transient",error_message:"HTTP 500",result_data_json:{error:"HTTP 500"}});
 const r=buildPortfolioRecord(input([run]),[run],asOf);expect(r.production.leaseStreams).toHaveLength(0);expect(r.inventory.members[0].reason).toBeTruthy();
});
it("rejects incomplete current months, invalid volumes and unretained lease query type",()=>{
 for(const mutation of [(data:any)=>{data.rows[0].production_month="2026-09-01";},(data:any)=>{data.rows[0].oil_bbl=-1;},(data:any)=>{delete data.lease_type_attempts;}]){
  const run=fixture(1);mutation(run.attempts[1].result_data_json);const r=buildPortfolioRecord(input([run]),[run],asOf);expect(r.production.leaseStreams).toHaveLength(0);expect(r.inventory.members[0].reason).toBeTruthy();
 }
});
it("deduplicates repeat submissions without treating repeated entries as additional wells",()=>{
 const run=fixture(1),i=input([run]);i.members.push({...i.members[0]});const r=buildPortfolioRecord(i,[run],asOf);expect(oil(r)).toBe(100);expect(r.inventory.duplicateApiEntries).toHaveLength(1);
});
it("withholds a month that is missing from one of the streams",()=>{
 const runs=[fixture(1),fixture(2,"10002")];(runs[1].attempts[1].result_data_json!.rows as any[])[0].production_month="2026-07-01";
 const r=buildPortfolioRecord(input(runs),runs,asOf);expect(r.production.grossMonthly.every(m=>m.volumes.oil_bbl.value===null)).toBe(true);
});

it("does not sum a single API's conflicting lease assignments across different runs",()=>{
 const a=fixture(1),b=fixture(2,"10002");b.original_input=a.original_input;b.resolved_primary_api=a.original_input;(b.attempts[0].result_data_json!.wells as any[])[0].api_no=a.original_input;
 const r=buildPortfolioRecord(input([a,b]),[a,b],asOf);expect(oil(r)).toBeNull();expect(r.decision.blockers.join(" ")).toContain("multiple retained production streams");
});
it("every aggregate volume citation resolves to its retained, hashed source row",()=>{
 const runs=[fixture(1),fixture(2,"10002")];const r=buildPortfolioRecord(input(runs),runs,asOf);
 for(const cell of Object.values(r.production.grossMonthly[0].volumes))for(const c of cell.citations){
  const evidence=r.retainedRunRecords[c.runId].evidence.find(e=>e.id===c.evidenceId)!;
  expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);expect(evidence.sourceUrl).toMatch(/^https:/);
  const value=c.pointer.slice(1).split("/").reduce((v:any,key)=>v[key],evidence.data);expect(typeof value).toBe("number");
 }
});
