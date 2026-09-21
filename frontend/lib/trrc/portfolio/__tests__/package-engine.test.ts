import {it,expect,vi,beforeEach} from "vitest";
import {assemblePackage} from "../package-engine";
import {loadPortfolioInputs} from "../load";
import {loadTitleForApi} from "../../gold2/title-link";
import {validateGold2Draft} from "../../gold2/assemble";
vi.mock("../load",()=>({loadPortfolioInputs:vi.fn()}));
vi.mock("../../gold2/title-link",()=>({loadTitleForApi:vi.fn()}));
const runId="00000000-0000-4000-8000-000000000001";
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(loadPortfolioInputs).mockResolvedValue({input:{members:[{input:"4216502733",runId}],askingPriceUsd:null,claimedWellCount:null},runs:[{id:runId,original_input:"4216502733",status:"complete",updated_at:"2026-09-01T00:00:00Z",attempts:[]}]});
 vi.mocked(loadTitleForApi).mockResolvedValue({title:null,status:"not_found",reason:"No reviewed title"});
});
it("uses real GOLD and portfolio engines with explicit evidence gaps",async()=>{
 const output=await assemblePackage({} as never,"owner",{});
 expect(output.goldRecords).toHaveLength(1);
 expect(validateGold2Draft(output.goldRecords[0].draft)).toEqual([]);
 expect(output.goldRecords[0].draft.fields['decision.posture'].value).toBe('INSUFFICIENT_DATA');
 expect(output.versions).toEqual([{kind:"run",id:runId,status:"complete",updated_at:"2026-09-01T00:00:00Z"}]);
 expect(output.record.inventory.submittedEntries).toBe(1);
});
it("does not publish transient title query failure as missing title evidence",async()=>{
 vi.mocked(loadTitleForApi).mockResolvedValue({title:null,status:"query_failed",reason:"Database unavailable"});
 await expect(assemblePackage({} as never,"owner",{})).rejects.toThrow("Title evidence query failed");
});
it("rejects an identity conflict before GOLD assembly",async()=>{
 const value=await vi.mocked(loadPortfolioInputs)({} as never,"owner",{});
 value.runs[0].resolved_primary_api="4216500004";
 await expect(assemblePackage({} as never,"owner",{})).rejects.toThrow("Resolved API conflicts");
});
it("preserves invalid submitted members without invented GOLD records",async()=>{
 vi.mocked(loadPortfolioInputs).mockResolvedValue({input:{members:[{input:"invalid",runId:null}],askingPriceUsd:null,claimedWellCount:null},runs:[]});
 const output=await assemblePackage({} as never,"owner",{});
 expect(output.record.inventory.submittedEntries).toBe(1);expect(output.goldRecords).toEqual([]);
 expect(output.record.decision.blockers.length).toBeGreaterThan(0);
});
it("automatically carries a selected reviewed mineral position into a worker GOLD draft",async()=>{
 const {reviewedPositionFixture}=await import("../../__tests__/fixtures/reviewed-position");
 const {title,position}=reviewedPositionFixture();
 const value=await vi.mocked(loadPortfolioInputs)({} as never,"owner",{});
 value.runs[0].title_research_job_id=title.jobId;
 vi.mocked(loadTitleForApi).mockResolvedValue({title,status:"linked",reason:null});
 const db={from:(table:string)=>{
  const job={id:title.jobId,status:"complete",updated_at:"2026-09-10T00:00:00Z",latest_analysis_id:title.analysisId,reviewed_position_ids:{4216502733:"selected"}};
  const data=table==="title_research_jobs"?job:{analysis_id:title.analysisId,position_json:position};
  const q:any={select:()=>q,eq:()=>q,in:()=>q,maybeSingle:async()=>({data,error:null}),then:(f:any)=>Promise.resolve({data:[data],error:null}).then(f)};return q;
 }};
 const output=await assemblePackage(db as never,"owner",{});
 expect(output.goldRecords[0].draft.fields['ownership.nri'].value).toEqual({n:"3",d:"256"});
 expect(output.goldRecords[0].draft.fields['identity.interest_scope'].value).toBe('mineral_royalty');
 expect(output.versions).toContainEqual({kind:"title",id:title.jobId,status:"complete",updated_at:"2026-09-10T00:00:00Z"});
});
