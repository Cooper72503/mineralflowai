import {it,expect,vi,beforeEach} from "vitest";
import {NextRequest} from "next/server";
import {POST} from "../route";
import {GET} from "../[recordId]/route";
import {createSupabaseFromRouteRequest} from "@/lib/supabase/from-route-request";
import {loadPortfolioRecord} from "@/lib/trrc/portfolio/load";
vi.mock("@/lib/supabase/from-route-request",()=>({createSupabaseFromRouteRequest:vi.fn()}));
vi.mock("@/lib/trrc/portfolio/load",()=>({loadPortfolioRecord:vi.fn()}));
const recordId="00000000-0000-4000-8000-000000000001";
const body={members:[{input:"4216502733",runId:recordId}],askingPriceUsd:null,claimedWellCount:1};
beforeEach(()=>vi.resetAllMocks());
function setup(auth=true,saveFail=false,missing=false){
 const filters:unknown[]=[];const inserts:unknown[]=[];
 const q:any={select:()=>q,eq:(...args:unknown[])=>{filters.push(args);return q;},single:async()=>({data:saveFail?null:{id:recordId},error:saveFail?{message:"migration missing"}:null}),maybeSingle:async()=>({data:missing?null:{id:recordId,record_json:{schemaVersion:"test"}},error:null}),insert:(v:unknown)=>{inserts.push(v);return q;}};
 vi.mocked(createSupabaseFromRouteRequest).mockResolvedValue({auth:{getUser:async()=>({data:{user:auth?{id:"owner"}:null},error:null})},from:()=>q} as never);
 vi.mocked(loadPortfolioRecord).mockResolvedValue({schemaVersion:"test"} as never);return {filters,inserts};
}
const request=(value:unknown=body)=>new NextRequest("http://localhost/api/portfolio-record",{method:"POST",body:JSON.stringify(value)});
it("requires auth before loading any portfolio evidence",async()=>{setup(false);expect((await POST(request())).status).toBe(401);expect(loadPortfolioRecord).not.toHaveBeenCalled();});
it("rejects malformed members without silently filtering them",async()=>{setup();expect((await POST(request({...body,members:[{input:"x",runId:"bad"}]}))).status).toBe(400);expect(loadPortfolioRecord).not.toHaveBeenCalled();});
it("persists a successful snapshot under the authenticated owner",async()=>{const d=setup();const r=await POST(request());expect(r.status).toBe(200);expect(d.inserts).toEqual([{user_id:"owner",input_json:body,record_json:{schemaVersion:"test"}}]);});
it("does not claim a saved record if migration/persistence fails",async()=>{setup(true,true);expect((await POST(request())).status).toBe(503);});
it("does not serve a partial substitute when evidence access fails",async()=>{const d=setup();vi.mocked(loadPortfolioRecord).mockRejectedValue(Error("inaccessible run"));expect((await POST(request())).status).toBe(422);expect(d.inserts).toEqual([]);});
it("scopes saved-record reads to the authenticated account",async()=>{const d=setup();const r=await GET(request(),{params:Promise.resolve({recordId})});expect(r.status).toBe(200);expect(d.filters).toContainEqual(["user_id","owner"]);});
it("returns no record when ownership filtering hides it",async()=>{setup(true,false,true);expect((await GET(request(),{params:Promise.resolve({recordId})})).status).toBe(404);});
