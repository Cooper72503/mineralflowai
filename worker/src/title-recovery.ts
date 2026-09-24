import type { SupabaseClient } from "@supabase/supabase-js";

// A title job interrupted mid-stage (worker restart, Vercel function killed
// during ingestion/analysis) previously stayed in that stage forever. Live
// case: job dd4c0167 sat in "analyzing" from 2026-09-21, still counted as a
// live scope, and made every later run on the same 12 APIs fail title
// linkage with "Multiple live title research scopes". recoverStaleRuns()
// already handled this for due-diligence runs; title jobs had no equivalent.
//
// Stale jobs are marked failed, not re-queued: re-queuing an orphaned
// duplicate scope would make it live again and recreate the ambiguity.
// "failed" is excluded from live scopes, keeps every stored row, and stays
// resumable through the retry route.
export const TITLE_IN_FLIGHT_STAGES = ["resolving_wells", "searching_records", "ingesting", "analyzing"];
export const TITLE_STALE_AFTER_MS = 60 * 60 * 1000;

export async function sweepStaleTitleJobs(supabase: SupabaseClient, active: ReadonlySet<string>, now: () => number = Date.now): Promise<number> {
  const cutoff = new Date(now() - TITLE_STALE_AFTER_MS).toISOString();
  let marked = 0;
  const { data: stale, error } = await supabase
    .from("title_research_jobs")
    .select("id, status, updated_at")
    .in("status", TITLE_IN_FLIGHT_STAGES)
    .lt("updated_at", cutoff);
  if (error) {
    if (!/relation .* does not exist/i.test(error.message)) console.error("[worker] stale title job scan failed:", error.message);
    return 0;
  }
  for (const job of stale ?? []) {
    const id = String(job["id"]);
    if (active.has(id)) continue;
    const stage = String(job["status"]);
    // Conditioned on the same status and updated_at, so a job that moved
    // between the scan and this write is left alone.
    const { data: updated, error: markError } = await supabase.from("title_research_jobs").update({
      status: "failed",
      error_summary: `Interrupted during ${stage.replace(/_/g, " ")}; no progress since ${String(job["updated_at"])}.`,
      stage_detail: "Interrupted — resume retrieval to continue; stored evidence is preserved",
      updated_at: new Date(now()).toISOString(),
    }).eq("id", id).eq("status", stage).eq("updated_at", job["updated_at"]).select("id");
    if (markError) console.error(`[worker] could not mark stale title job ${id}:`, markError.message);
    else if (updated?.length) { marked++; console.log(`[worker] marked title job ${id} failed after stalling in "${stage}" since ${String(job["updated_at"])}`); }
  }
  return marked;
}
