import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepStaleTitleJobs, TITLE_STALE_AFTER_MS } from "../title-recovery.js";

type Row = { id: string; status: string; updated_at: string };

/** Honors the filters the sweep relies on: in(status), lt(updated_at) on read,
 *  and eq(id/status/updated_at) on the conditional write. */
function makeSupabase(rows: Row[]) {
  const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const from = () => {
    let mode: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};
    const eqs: Record<string, unknown> = {};
    let statuses: string[] | null = null;
    let before: string | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      in: (_k: string, v: string[]) => { statuses = v; return q; },
      lt: (_k: string, v: string) => { before = v; return q; },
      eq: (k: string, v: unknown) => { eqs[k] = v; return q; },
      update: (p: Record<string, unknown>) => { mode = "update"; patch = p; return q; },
      then: (resolve: (x: unknown) => unknown) => {
        if (mode === "select") {
          const data = rows.filter(r => (!statuses || statuses.includes(r.status)) && (!before || r.updated_at < before)).map(r => ({ ...r }));
          return Promise.resolve(resolve({ data, error: null }));
        }
        const target = rows.find(r => r.id === eqs["id"] && r.status === eqs["status"] && r.updated_at === eqs["updated_at"]);
        if (target) { writes.push({ id: target.id, patch }); Object.assign(target, patch); }
        return Promise.resolve(resolve({ data: target ? [{ id: target.id }] : [], error: null }));
      },
    };
    return q;
  };
  return { supabase: { from } as unknown as SupabaseClient, writes };
}

const NOW = Date.parse("2026-09-24T00:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("sweepStaleTitleJobs", () => {
  it("fails the job that sat in analyzing since 2026-09-21 and blocked linkage", async () => {
    // The live case: dd4c0167 stuck in "analyzing" for ~2.5 days.
    const { supabase, writes } = makeSupabase([{ id: "dd4c0167", status: "analyzing", updated_at: "2026-09-21T19:34:47Z" }]);
    expect(await sweepStaleTitleJobs(supabase, new Set(), () => NOW)).toBe(1);
    expect(writes[0].patch).toMatchObject({ status: "failed" });
    expect(String(writes[0].patch["error_summary"])).toContain("analyzing");
  });

  it("marks failed rather than re-queuing, so a duplicate scope cannot become live again", async () => {
    const { supabase, writes } = makeSupabase([{ id: "a", status: "searching_records", updated_at: ago(TITLE_STALE_AFTER_MS * 3) }]);
    await sweepStaleTitleJobs(supabase, new Set(), () => NOW);
    expect(writes[0].patch["status"]).toBe("failed");
    expect(writes[0].patch["status"]).not.toBe("pending");
  });

  it("leaves recent in-flight jobs alone", async () => {
    const { supabase, writes } = makeSupabase([{ id: "a", status: "searching_records", updated_at: ago(5 * 60 * 1000) }]);
    expect(await sweepStaleTitleJobs(supabase, new Set(), () => NOW)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("never touches a job this worker is actively running, however old its timestamp", async () => {
    // A long county search does not move updated_at; the in-process set is authoritative.
    const { supabase, writes } = makeSupabase([{ id: "running", status: "searching_records", updated_at: ago(TITLE_STALE_AFTER_MS * 2) }]);
    expect(await sweepStaleTitleJobs(supabase, new Set(["running"]), () => NOW)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("ignores review-paused, complete, failed and cancelled jobs", async () => {
    const old = ago(TITLE_STALE_AFTER_MS * 10);
    const { supabase, writes } = makeSupabase(["awaiting_tract_confirmation", "awaiting_documents", "complete", "failed", "cancelled"].map(status => ({ id: status, status, updated_at: old })));
    expect(await sweepStaleTitleJobs(supabase, new Set(), () => NOW)).toBe(0);
    expect(writes).toEqual([]);
  });

  it("does not overwrite a job that moved between the scan and the write", async () => {
    const rows: Row[] = [{ id: "a", status: "analyzing", updated_at: ago(TITLE_STALE_AFTER_MS * 2) }];
    const { supabase, writes } = makeSupabase(rows);
    const original = supabase.from;
    let calls = 0;
    (supabase as unknown as { from: unknown }).from = vi.fn((...args: unknown[]) => {
      // After the scan returns, the job advances before the conditional write lands.
      if (++calls === 2) rows[0].updated_at = new Date(NOW).toISOString();
      return (original as (...a: unknown[]) => unknown)(...args);
    });
    expect(await sweepStaleTitleJobs(supabase, new Set(), () => NOW)).toBe(0);
    expect(writes).toEqual([]);
  });
});
