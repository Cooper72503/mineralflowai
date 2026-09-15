import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureTitleJobForApi } from "../ensure-job";

/**
 * Minimal in-memory Supabase stand-in. Every builder method returns the
 * same thenable chain; `await` resolves it against the recorded state.
 * Statuses are tracked so the claim-safe insert order (creating → wells →
 * pending) is asserted, not assumed.
 */
function makeDb(seed: { wells?: Array<{ job_id: string; api10: string; user_id: string }>; jobs?: Array<{ id: string; status: string; user_id: string; updated_at: string }> } = {}) {
  const wells = [...(seed.wells ?? [])];
  const jobs = [...(seed.jobs ?? [])];
  const log: string[] = [];
  let nextId = 1;

  function chain(table: string, op: string, payload?: unknown) {
    const filters: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    const self = () => c;
    c["eq"] = (k: string, v: unknown) => { filters[k] = v; return c; };
    c["in"] = (k: string, v: unknown[]) => { filters[`${k}__in`] = v; return c; };
    c["order"] = self; c["limit"] = self; c["select"] = self;
    c["single"] = () => c; c["maybeSingle"] = () => c;
    c["then"] = (resolve: (v: unknown) => void) => {
      let out: unknown;
      if (table === "title_job_wells" && op === "select") {
        out = { data: wells.filter(w => w.user_id === filters["user_id"] && w.api10 === filters["api10"]).map(w => ({ job_id: w.job_id })), error: null };
      } else if (table === "title_research_jobs" && op === "select") {
        const ids = filters["id__in"] as string[];
        out = { data: jobs.filter(j => ids.includes(j.id) && j.user_id === filters["user_id"]), error: null };
      } else if (table === "title_research_jobs" && op === "insert") {
        const row = payload as Record<string, unknown>;
        const id = `job-${nextId++}`;
        jobs.push({ id, status: String(row["status"]), user_id: String(row["user_id"]), updated_at: new Date().toISOString() });
        log.push(`insert job ${id} status=${row["status"]}`);
        out = { data: { id }, error: null };
      } else if (table === "title_job_wells" && op === "insert") {
        const row = payload as Record<string, unknown>;
        wells.push({ job_id: String(row["job_id"]), api10: String(row["api10"]), user_id: String(row["user_id"]) });
        log.push(`insert well for ${row["job_id"]} (job status at insert=${jobs.find(j => j.id === row["job_id"])?.status})`);
        out = { data: null, error: null };
      } else if (table === "title_research_jobs" && op === "update") {
        const patch = payload as Record<string, unknown>;
        const j = jobs.find(x => x.id === filters["id"] && (filters["status"] === undefined || x.status === filters["status"]));
        if (j && patch["status"]) { j.status = String(patch["status"]); log.push(`update job ${j.id} status=${j.status}`); }
        out = { data: null, error: null };
      } else {
        out = { data: null, error: { message: `unmocked ${table}.${op}` } };
      }
      resolve(out);
    };
    return c;
  }
  const db = {
    from: (table: string) => ({
      select: () => chain(table, "select"),
      insert: (payload: unknown) => chain(table, "insert", payload),
      update: (payload: unknown) => chain(table, "update", payload),
    }),
  } as unknown as SupabaseClient;
  return { db, wells, jobs, log };
}

const USER = "user-1";

describe("ensureTitleJobForApi", () => {
  it("creates a job for a valid API number using the claim-safe order: creating → well → pending", async () => {
    const { db, log, jobs } = makeDb();
    const r = await ensureTitleJobForApi(db, USER, "42-165-02733");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.api10).toBe("4216502733");
    expect(log).toEqual([
      "insert job job-1 status=creating",
      "insert well for job-1 (job status at insert=creating)",
      "update job job-1 status=pending",
    ]);
    expect(jobs[0].status).toBe("pending");
  });

  it("reuses a live job that already covers this api10 for this user instead of duplicating it", async () => {
    const { db, log } = makeDb({
      wells: [{ job_id: "job-existing", api10: "4216502733", user_id: USER }],
      jobs: [{ id: "job-existing", status: "awaiting_tract_confirmation", user_id: USER, updated_at: "2026-09-14T00:00:00Z" }],
    });
    const r = await ensureTitleJobForApi(db, USER, "4216502733");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.jobId).toBe("job-existing");
    expect(log).toEqual([]);
  });

  it("does NOT reuse a cancelled or failed job — creates a fresh one", async () => {
    const { db } = makeDb({
      wells: [{ job_id: "job-dead", api10: "4216502733", user_id: USER }],
      jobs: [{ id: "job-dead", status: "cancelled", user_id: USER, updated_at: "2026-09-14T00:00:00Z" }],
    });
    const r = await ensureTitleJobForApi(db, USER, "42-165-02733");
    expect(r.created).toBe(true);
    expect(r.jobId).not.toBe("job-dead");
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
    const { db, log } = makeDb();
    const r = await ensureTitleJobForApi(db, USER, "Southwest Royalties Inc");
    expect(r.ok).toBe(false);
    expect(r.created).toBe(false);
    expect(log).toEqual([]);
  });
});
