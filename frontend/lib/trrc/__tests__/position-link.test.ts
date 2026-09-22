import {it,expect} from "vitest";
import {loadReviewedPosition} from "../gold2/position-link";
import {assembleGold2Draft} from "../gold2/assemble";
import {reviewedPositionFixture} from "./fixtures/reviewed-position";
function database(mode="selected"){
 const {title,position}=reviewedPositionFixture();const calls:unknown[]=[];
 const db={from:(table:string)=>{
  const data=table==="title_research_jobs"?{latest_analysis_id:mode==="changed"?"new-analysis":title.analysisId,reviewed_position_ids:mode==="absent"?{}:{4216502733:"selection"}}:{analysis_id:mode==="stale"?"old":title.analysisId,position_json:mode==="corrupt"?{...position,holdingId:"unresolved"}:position};
  const q:any={select:()=>q,eq:(...args:unknown[])=>{calls.push([table,...args]);return q;},maybeSingle:async()=>({data,error:mode==="query_failed"?{message:"offline"}:null})};return q;
 }};return {db,title,calls};
}
it("loads only selected owner/job/API position and feeds exact NRI into existing GOLD",async()=>{
 const {db,title,calls}=database();const p=await loadReviewedPosition(db as never,"owner","4216502733",title);
 const report=assembleGold2Draft({api:"4216502733",runId:"run",asOf:"2026-09-21T00:00:00Z",attempts:[],title,position:p.position,partner:null,reconciliationPolicy:null,economics:null});
 expect(report.ownership.status).toBe("calculated");expect(report.fields['ownership.nri'].value).toEqual({n:"3",d:"256"});
 expect(calls).toContainEqual(["trrc_mineral_position_reviews","user_id","owner"]);
 expect(calls).toContainEqual(["trrc_mineral_position_reviews","job_id",title.jobId]);
});
it.each(["absent","stale","corrupt"])("withholds missing/stale/unsupported selection: %s",async mode=>{
 const {db,title}=database(mode);const p=await loadReviewedPosition(db as never,"owner","4216502733",title);expect(p.position).toBeNull();expect(p.reason).toBeTruthy();
});
it("does not silently convert query failure to absent ownership",async()=>{
 const {db,title}=database("query_failed");await expect(loadReviewedPosition(db as never,"owner","4216502733",title)).rejects.toThrow("could not be loaded");
});

it("distinguishes a concurrent title version change from invalid valuation inputs",async()=>{
 const {db,title}=database("changed");
 await expect(loadReviewedPosition(db as never,"owner","4216502733",title)).rejects.toMatchObject({status:409});
});
it("classifies position database outages as retryable service failures",async()=>{
 const {db,title}=database("query_failed");
 await expect(loadReviewedPosition(db as never,"owner","4216502733",title)).rejects.toMatchObject({status:503});
});
