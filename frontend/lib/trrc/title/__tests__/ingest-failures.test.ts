import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestPendingDocuments } from "../ingest";
import { parseInstrumentText } from "../instrument-parser";
import { addReviewItem } from "../job-store";
vi.mock("../instrument-parser", () => ({ parseInstrumentText: vi.fn() }));
vi.mock("../job-store", async importOriginal => ({...await importOriginal<object>(), addReviewItem: vi.fn(), appendLimitation: vi.fn()}));
function db(failTable?: string, document = true) {
 const writes: Array<{table:string; value:Record<string,unknown>}> = [];
 const client = {from: (table:string) => {
  let value: Record<string,unknown>|undefined;
  let single = false;
  const q: Record<string,unknown> = {};
  for(const name of ["select","eq","order","limit","maybeSingle"]) q[name]=()=>q;
  q.single=()=>{single=true;return q;};
  q.insert=(v:Record<string,unknown>)=>{value=v;return q;};
  q.update=(v:Record<string,unknown>)=>{value=v;return q;};
  q.upsert=(v:Record<string,unknown>)=>{value=v;return q;};
  q.then=(resolve:(x:unknown)=>void)=>{
   if(value) writes.push({table,value});
   return Promise.resolve({data: single ? {id:"inserted"} : !value && table === "title_documents" && document ? [{id:"doc",job_id:"job",user_id:"owner",extracted_text:"Unrecognized text from a genuine document without parsed conveyance",content_hash:"hash",file_name:"deed.pdf",ocr_status:"done"}] : [],error:table===failTable?{message:"database unavailable"}:null}).then(resolve);
  };
  return q;
 }} as unknown as SupabaseClient;
 return {client,writes};
}
beforeEach(()=>vi.clearAllMocks());
describe("ingestion failure handling",()=>{
 it("does not verify an instrument when its party write fails",async()=>{
  vi.mocked(parseInstrumentText).mockReturnValue({legalDescriptions:[],instruments:[{
   instrumentType:"mineral_deed",executionDate:{iso:null},effectiveDate:{iso:null},recordingDate:{iso:null},
   parties:[{role:"grantor",name:"A"}],tracts:[],verbatimExcerpts:[],alternatives:[],references:[],
  }]} as never);
  const {client,writes}=db("title_instrument_parties");
  await expect(ingestPendingDocuments(client,"owner","job")).rejects.toThrow("database unavailable");
  expect(writes.some(x=>x.table==="title_instruments" && x.value.instrument_content_verified===false)).toBe(true);
  expect(writes.some(x=>x.value.instrument_content_verified===true)).toBe(false);
  expect(writes.some(x=>x.value.extraction_status==="done")).toBe(false);
 });
 it("does not treat an unavailable queue as no documents",async()=>{
  await expect(ingestPendingDocuments(db("title_documents").client,"owner","job")).rejects.toThrow("database unavailable");
 });
 it("does not interpret missing tract context after a failed read",async()=>{
  await expect(ingestPendingDocuments(db("title_canonical_tracts").client,"owner","job")).rejects.toThrow("database unavailable");
  expect(parseInstrumentText).not.toHaveBeenCalled();
 });
 it("marks an uninterpreted document failed and opens review instead of marking done",async()=>{
  vi.mocked(parseInstrumentText).mockReturnValue({instruments:[],legalDescriptions:[]} as never);
  const {client,writes}=db();const result=await ingestPendingDocuments(client,"owner","job");
  expect(result.errors[0].error).toContain("No instrument or legal description");
  expect(writes.some(x=>x.value.extraction_status==="done")).toBe(false);
  expect(writes.some(x=>x.value.extraction_status==="failed")).toBe(true);
  expect(addReviewItem).toHaveBeenCalled();
 });
});
