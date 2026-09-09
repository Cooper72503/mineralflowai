import {it,expect,vi,beforeEach} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {generatePdfReportForRun} from "../generate-report";
vi.mock("../report-builder",()=>({buildTrrcPdfReport:vi.fn(async()=>Buffer.from("%PDF-test"))}));
import {buildTrrcPdfReport} from "../report-builder";
function db(failedTable?:string){
 const data:Record<string,unknown[]>={trrc_resolved_entities:[{id:"e",attributes_json:{api10:"4216502733"}}]};
 return {from(table:string){
  const result={data:data[table]??[],error:table===failedTable?{message:"database down"}:null};
  const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:()=>chain,single:async()=>({data:{id:"r",status:"complete",original_input:"4216502733",normalized_input:"4216502733"},error:null}),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve(result).then(resolve)};
  return chain;
 }} as unknown as SupabaseClient;
}
beforeEach(()=>vi.clearAllMocks());
it.each(["trrc_source_attempts","trrc_production_monthly","trrc_resolved_entities","trrc_due_diligence_findings"])("does not render an apparently empty report on %s read failure",async table=>{
 const result=await generatePdfReportForRun(db(table),"r","u");
 expect(result.ok).toBe(false); if(!result.ok)expect(result.status).toBe(503);
 expect(buildTrrcPdfReport).not.toHaveBeenCalled();
});
it("preserves attributes_json across the database-to-report handoff",async()=>{
 await generatePdfReportForRun(db(),"r","u");
 expect(vi.mocked(buildTrrcPdfReport).mock.calls[0][0].entities?.[0].attributes).toEqual({api10:"4216502733"});
});
