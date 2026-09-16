import {it,expect} from "vitest";
import {loadPortfolioRecord} from "../load";
import type {LiteSourceAttempt} from "../../coverage";
const id="00000000-0000-4000-8000-000000000001";
const input={members:[{input:"4216502733",runId:id}],claimedWellCount:1,askingPriceUsd:null};
function database(options:{missing?:boolean;pageError?:boolean;changed?:boolean}={}){
 const pages:number[]=[];const filters:unknown[]=[];let runReads=0;
 const db={from:(table:string)=>{
  const q:any={select:()=>q,eq:(...args:unknown[])=>{filters.push([table,...args]);return q;},order:()=>q,maybeSingle:async()=>{
   runReads++;return {data:options.missing?null:{id,original_input:"4216502733",status:options.changed&&runReads>1?"running":"complete",updated_at:"2026-01-01"},error:null};
  },range:async(start:number)=>{
   pages.push(start);if(options.pageError)return {data:null,error:{message:"read failed"}};
   const attempts:LiteSourceAttempt[]=Array.from({length:start===0?500:1},(_,i)=>({source_id:`s${start+i}`,source_name:`unsupported_${start+i}`,status:"not_applicable",result_count:0,error_message:"Synthetic pagination fixture",attempted_at:"2026-01-01T00:00:00Z",result_data_json:null}));return {data:attempts,error:null};
  }};return q;
 }};
 return {db,pages,filters};
}
it("pages retained evidence beyond one response and scopes run reads to the account",async()=>{
 const d=database();const r=await loadPortfolioRecord(d.db as never,"owner",input);
 expect(d.pages).toEqual([0,500]);expect(r.retainedRunRecords[id].evidence).toHaveLength(501);expect(d.filters).toContainEqual(["trrc_due_diligence_runs","user_id","owner"]);
});
it("does not silently omit inaccessible runs",async()=>{const d=database({missing:true});await expect(loadPortfolioRecord(d.db as never,"owner",input)).rejects.toThrow("unavailable to this account");});
it("withholds the record when evidence reading fails",async()=>{const d=database({pageError:true});await expect(loadPortfolioRecord(d.db as never,"owner",input)).rejects.toThrow("could not be loaded");});
it("withholds a report when a retry changes a run during evidence reads",async()=>{const d=database({changed:true});await expect(loadPortfolioRecord(d.db as never,"owner",input)).rejects.toThrow("changed during");});
