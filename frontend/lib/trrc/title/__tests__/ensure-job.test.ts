import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureTitleJobForApi, findUniqueLiveTitleJob } from "../ensure-job";

/**
 * In-memory Supabase stand-in: reads answer from seeded rows; creation is
 * expected to go ONLY through the atomic RPC (migration 032). Direct
 * inserts to the job/well tables are recorded as violations so a
 * regression to separate inserts fails loudly.
 */
function makeDb(seed: { wells?: Array<{ job_id: string; api10: string; user_id: string }>; jobs?: Array<{ id: string; status: string; user_id: string; updated_at: string }> } = {}, rpcBehaviour: "ok" | "error" = "ok") {
  const wells = [...(seed.wells ?? [])];
  const jobs = [...(seed.jobs ?? [])];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const violations: string[] = [];

  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    c["eq"] = (k: string, v: unknown) => { filters[k] = v; return c; };
    c["in"] = (k: string, v: unknown[]) => { filters[`${k}__in`] = v; return c; };
    c["order"] = () => c;
    c["then"] = (resolve: (v: unknown) => void) => {
      if (table === "title_job_wells") resolve({ data: wells.filter(w => w.user_id === filters["user_id"] && w.api10 === filters["api10"]).map(w => ({ job_id: w.job_id })), error: null });
      else if (table === "title_research_jobs") { const ids = filters["id__in"] as string[]; resolve({ data: jobs.filter(j => ids.includes(j.id) && j.user_id === filters["user_id"]), error: null }); }
      else resolve({ data: null, error: { message: `unmocked select ${table}` } });
    };
    return c;
  }
  const db = {
    from: (table: string) => ({
      select: () => selectChain(table),
      insert: () => { violations.push(`direct insert into ${table}`); return { select: () => ({ single: async () => ({ data: null, error: { message: "direct insert not allowed" } }) }), then: (r: (v: unknown) => void) => r({ data: null, error: { message: "direct insert not allowed" } }) }; },
      update: () => ({ eq: () => ({ eq: () => ({ then: (r: (v: unknown) => void) => r({ data: null, error: null }) }), then: (r: (v: unknown) => void) => r({ data: null, error: null }) }) }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcBehaviour === "error") return { data: null, error: { message: "function create_title_research_job does not exist" } };
      const id = `job-rpc-${rpcCalls.length}`;
      jobs.push({ id, status: "pending", user_id: "user-1", updated_at: new Date().toISOString() });
      return { data: { id, status: "pending" }, error: null };
    },
  } as unknown as SupabaseClient;
  return { db, rpcCalls, violations };
}

const USER = "user-1";

describe("ensureTitleJobForApi (atomic RPC path)", () => {
  it("creates a job for a valid API number through create_title_research_job with one well row", async () => {
    const { db, rpcCalls, violations } = makeDb();
    const r = await ensureTitleJobForApi(db, USER, "42-165-02733");
    expect(r).toMatchObject({ ok: true, created: true, api10: "4216502733", jobId: "job-rpc-1" });
    expect(violations).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("create_title_research_job");
    const wellsArg = rpcCalls[0].args["p_wells"] as Array<Record<string, unknown>>;
    expect(wellsArg).toHaveLength(1);
    expect(wellsArg[0]).toMatchObject({ api10: "4216502733", county_code: "165", state_code: "42", validation_error: null });
    const jobArg = rpcCalls[0].args["p_job"] as Record<string, unknown>;
    expect(jobArg["interest_scope"]).toEqual(["minerals"]);
  });

  it("reuses a live job that already covers this api10 for this user — no RPC call", async () => {
    const { db, rpcCalls } = makeDb({
      wells: [{ job_id: "job-existing", api10: "4216502733", user_id: USER }],
      jobs: [{ id: "job-existing", status: "awaiting_tract_confirmation", user_id: USER, updated_at: "2026-09-14T00:00:00Z" }],
    });
    const r = await ensureTitleJobForApi(db, USER, "4216502733");
    expect(r).toMatchObject({ ok: true, created: false, jobId: "job-existing" });
    expect(rpcCalls).toEqual([]);
  });

  it("does NOT reuse a cancelled or failed job — creates a fresh one", async () => {
    const { db, rpcCalls } = makeDb({
      wells: [{ job_id: "job-dead", api10: "4216502733", user_id: USER }],
      jobs: [{ id: "job-dead", status: "cancelled", user_id: USER, updated_at: "2026-09-14T00:00:00Z" }],
    });
    const r = await ensureTitleJobForApi(db, USER, "42-165-02733");
    expect(r.created).toBe(true);
    expect(rpcCalls).toHaveLength(1);
  });

  it("ignores another user's job for the same api10 (tenant isolation)", async () => {
    const { db } = makeDb({
      wells: [{ job_id: "job-other", api10: "4216502733", user_id: "user-2" }],
      jobs: [{ id: "job-other", status: "pending", user_id: "user-2", updated_at: "2026-09-14T00:00:00Z" }],
    });
    const r = await ensureTitleJobForApi(db, USER, "42-165-02733");
    expect(r.created).toBe(true);
  });

  it("refuses a non-API input without touching the database", async () => {
    const { db, rpcCalls, violations } = makeDb();
    const r = await ensureTitleJobForApi(db, USER, "Southwest Royalties Inc");
    expect(r).toMatchObject({ ok: false, created: false });
    expect(rpcCalls).toEqual([]);
    expect(violations).toEqual([]);
  });

  it("reports an RPC failure honestly and never falls back to separate inserts", async () => {
    const { db, violations } = makeDb({}, "error");
    const r = await ensureTitleJobForApi(db, USER, "42-165-02733");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("atomically");
    expect(violations).toEqual([]);
  });
});
it("does not pick a scope by recency when multiple live scopes exist",async()=>{
 const {db,rpcCalls}=makeDb({wells:[{job_id:"a",api10:"4216502733",user_id:USER},{job_id:"b",api10:"4216502733",user_id:USER}],jobs:[{id:"a",status:"pending",user_id:USER,updated_at:"2026-09-15"},{id:"b",status:"complete",user_id:USER,updated_at:"2026-09-14"}]});
 const result=await ensureTitleJobForApi(db,USER,"4216502733");
 expect(result).toMatchObject({ok:false,jobId:null});expect(result.reason).toContain("Multiple live");expect(rpcCalls).toEqual([]);
});

// The Buttercup failure: one scope stuck in-flight, one complete. Once the
// worker's stale sweep marks the stuck one failed, the lookup must resolve
// the survivor without creating anything, so unlinked runs heal themselves.
it("resolves the surviving scope once a stuck duplicate is marked failed",async()=>{
 const wells=[{job_id:"31f9fe66",api10:"4232946776",user_id:USER},{job_id:"dd4c0167",api10:"4232946776",user_id:USER}];
 const stuck=makeDb({wells,jobs:[{id:"31f9fe66",status:"awaiting_tract_confirmation",user_id:USER,updated_at:"2026-09-23"},{id:"dd4c0167",status:"analyzing",user_id:USER,updated_at:"2026-09-21"}]});
 expect(await findUniqueLiveTitleJob(stuck.db,USER,"4232946776")).toMatchObject({jobId:null});
 const swept=makeDb({wells,jobs:[{id:"31f9fe66",status:"awaiting_tract_confirmation",user_id:USER,updated_at:"2026-09-23"},{id:"dd4c0167",status:"failed",user_id:USER,updated_at:"2026-09-24"}]});
 expect(await findUniqueLiveTitleJob(swept.db,USER,"4232946776")).toEqual({jobId:"31f9fe66",reason:null});
 expect(swept.rpcCalls).toEqual([]);expect(swept.violations).toEqual([]);
});
it("reports no scope, not an error, when the API has never been researched",async()=>{
 const {db}=makeDb({});
 expect(await findUniqueLiveTitleJob(db,USER,"4232946776")).toEqual({jobId:null,reason:null});
});
