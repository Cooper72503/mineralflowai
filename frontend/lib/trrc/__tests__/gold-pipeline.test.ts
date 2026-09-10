import {assembleGoldRecord,validateGoldRecord} from "../gold/assemble";
import type {LiteSourceAttempt} from "../coverage";
import {readFileSync} from "node:fs";
import {describe,it,expect,vi,beforeEach} from "vitest";
import {createLocalStore} from "../../../../worker/src/local-store";
vi.mock("../../../../worker/src/tools/ewa.js",()=>Object.fromEntries(["searchWellbore","searchLeaseWells","getWellStatus","getProduction","getGathererPurchaser","getCompletionRecords","getPluggingRecords","getOrphanWell","getSeveranceRecords","getInjectionRecords","getDrillingPermits","getOilProration","getGisLocation"].map(n=>[n,vi.fn()])));
vi.mock("../../../../worker/src/tools/browser.js",()=>Object.fromEntries(["searchOperator","getInactiveWellStatus","getComplianceViolations","getCodaDocuments"].map(n=>[n,vi.fn()])));
vi.mock("../../../../worker/src/tools/county-records.js",()=>({getCountyRecords:vi.fn()}));
import * as ewa from "../../../../worker/src/tools/ewa.js";
import * as browser from "../../../../worker/src/tools/browser.js";
import * as county from "../../../../worker/src/tools/county-records.js";
import {runLandmanSequencer} from "../../../../worker/src/sequencer";
const captured=JSON.parse(readFileSync(new URL("../../../../benchmarks/latest-retrieval.json",import.meta.url),"utf8")) as {cases:{case:{id:string;api10:string};attempts:{source_name:string;result_data_json:unknown}[]}[]};
describe("standalone worker → retained evidence → GOLD engines",()=>{
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
  await runLandmanSequencer("r",c.case.api10,db);
  expect(run.status).toBe("complete");
  const gold=assembleGoldRecord({...run,id:"r",original_input:c.case.api10},attempts as unknown as LiteSourceAttempt[]);
  expect(validateGoldRecord(gold)).toEqual([]);
  expect(gold.sections).toHaveLength(18);
  expect(gold.coverage.some(source=>source.status==="retrieval_failed"||source.status==="manual_required"||source.status==="not_checked")).toBe(true);
  expect(gold.record.fields["production.lease_monthly"].status==="observed").toBe(production.length>0);
  expect(gold.record.fields["economics.base_value"].value).toBeNull();
  expect(ewa.getGisLocation).toHaveBeenCalledWith(c.case.api10);
  expect(attempts.find(a=>a.source_name==="fetch_gis_plat")?.status).toBe((data("fetch_gis_plat") as {error?:string}).error ? "failed_transient" : "success");
  expect(attempts.some(a=>a.source_name==="fetch_production")).toBe(true);
  for(const p of production){expect(p.production_month).toMatch(/^\d{4}-\d{2}-01$/);expect(p.entity_type).toBe("lease");}
  const wb=data("search_by_api") as {found:boolean};
  expect(run.resolved_primary_api).toBe(wb.found?c.case.api10:null);
 });
});
