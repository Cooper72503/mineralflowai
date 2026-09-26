import {readFileSync} from "node:fs";
import {describe,it,expect,vi,beforeEach} from "vitest";
import {createLocalStore} from "../local-store.js";
vi.mock("../tools/ewa.js",()=>Object.fromEntries(["searchWellbore","searchLeaseWells","getWellStatus","getProduction","getGathererPurchaser","getCompletionRecords","getPluggingRecords","getOrphanWell","getSeveranceRecords","getInjectionRecords","getDrillingPermits","getOilProration","getGisLocation"].map(n=>[n,vi.fn()])));
vi.mock("../tools/browser.js",()=>Object.fromEntries(["searchOperator","getInactiveWellStatus","getComplianceViolations","getCodaDocuments"].map(n=>[n,vi.fn()])));
vi.mock("../tools/county-records.js",()=>({getCountyRecords:vi.fn()}));
import * as ewa from "../tools/ewa.js";
import * as browser from "../tools/browser.js";
import * as county from "../tools/county-records.js";
import {runLandmanSequencer} from "../sequencer.js";
const captured=JSON.parse(readFileSync(new URL("../../../benchmarks/latest-retrieval.json",import.meta.url),"utf8")) as {cases:{case:{id:string;api10:string};attempts:{source_name:string;result_data_json:unknown}[]}[]};
describe("full worker sequence — replay real core retrieval, disclose unrecorded adapters",()=>{
 beforeEach(()=>{
  vi.resetAllMocks();
  for(const mod of [ewa,browser,county])for(const fn of Object.values(mod))if(vi.isMockFunction(fn))fn.mockResolvedValue({found:false,data_gap:true,message:"Adapter not included in this recorded benchmark",error:"No captured response"});
 });
 it.each(captured.cases)("$case.id persists evidence and finishes without fabricated production",async c=>{
  const data=(source:string)=>c.attempts.find(a=>a.source_name===source)!.result_data_json as never;
  vi.mocked(ewa.searchWellbore).mockResolvedValue(data("search_by_api"));
  vi.mocked(ewa.getGisLocation).mockResolvedValue(data("fetch_gis_plat"));
  vi.mocked(ewa.getProduction).mockResolvedValue(data("fetch_production"));
  vi.mocked(ewa.getDrillingPermits).mockResolvedValue(data("fetch_drilling_permits"));
  const {db,snapshot}=createLocalStore({id:"r",status:"running",resolved_primary_api:c.case.api10,selected_input_type:"api_number"});
  const [run]=snapshot.trrc_due_diligence_runs;
  const attempts=snapshot.trrc_source_attempts;
  const production=snapshot.trrc_production_monthly;
  // A capture whose wellbore lookup itself timed out is an outage, not a
  // result: the run stops for retry rather than completing tied to no lease.
  const wbError=String((data("search_by_api") as {error?:string}).error ?? "");
  if(/timeout|aborted|fetch failed|HTTP 5\d\d/i.test(wbError)&&!(data("search_by_api") as {lease_number?:string|null}).lease_number){
   // The well-status fallback was not captured; during the same outage it times out too.
   vi.mocked(ewa.getWellStatus).mockRejectedValue(new Error("TimeoutError: The operation was aborted due to timeout"));
   await expect(runLandmanSequencer("r",c.case.api10,db)).rejects.toThrow(/identity lookup unavailable/);
   expect(run.status).not.toBe("complete");
   return;
  }
  await runLandmanSequencer("r",c.case.api10,db);
  expect(run.status).toBe("complete");
  expect(ewa.getGisLocation).toHaveBeenCalledWith(c.case.api10);
  expect(attempts.find(a=>a.source_name==="fetch_gis_plat")?.status).toBe((data("fetch_gis_plat") as {error?:string}).error ? "failed_transient" : "success");
  expect(attempts.some(a=>a.source_name==="fetch_production")).toBe(true);
  for(const p of production){expect(p.production_month).toMatch(/^\d{4}-\d{2}-01$/);expect(p.entity_type).toBe("lease");}
  const wb=data("search_by_api") as {found:boolean};
  expect(run.resolved_primary_api).toBe(wb.found?c.case.api10:null);
 });
});
