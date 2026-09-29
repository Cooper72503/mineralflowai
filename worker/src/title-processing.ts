/**
 * After county retrieval, read the retrieved courthouse images and publish
 * the chain of title — automatically. The implementation lives in the
 * frontend (lib/trrc/title/process-job.ts) and is bundled into
 * dist/title-engine.mjs by scripts/build-report-engine.mjs, so the app and
 * the worker run the same extraction and analysis code.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchCountyRecordsForJob, defaultDeps, type DocumentBudget } from "./title-sequencer.js";

export interface ProcessTitleJobResult {
  documentsRead: number; instrumentsCreated: number; extractionErrors: number;
  analysisId: string | null; classification: string | null; error: string | null;
}
type Engine = (supabase: SupabaseClient, jobId: string, userId: string, options?: { discoverAfterIngestion: () => Promise<boolean> }) => Promise<ProcessTitleJobResult>;

const engineUrl = new URL("../dist/title-engine.mjs", import.meta.url).href;
const defaultEngine: Engine = async (...args) => (await import(engineUrl)).processTitleJob(...args);

/** Run processing only when retrieval finished normally; never on a cancelled or failed job. */
export async function processRetrievedTitleJob(supabase: SupabaseClient, jobId: string, engine: Engine = defaultEngine, documentBudget?: DocumentBudget): Promise<ProcessTitleJobResult | null> {
  const { data: job, error } = await supabase.from("title_research_jobs").select("user_id, status").eq("id", jobId).maybeSingle();
  if (error) throw new Error(`Title job reload failed: ${error.message}`);
  if (!job || !["ingesting", "awaiting_tract_confirmation", "awaiting_documents"].includes(String(job.status))) return null;
  return engine(supabase, jobId, String(job.user_id), { discoverAfterIngestion: async () => {
    const { data: current, error: currentError } = await supabase.from("title_research_jobs").select("status").eq("id", jobId).maybeSingle();
    if (currentError) throw Error(`Title discovery status failed: ${currentError.message}`);
    if (!current || current.status === "cancelled") throw Error("Title job cancelled or unavailable.");
    const { data: wells, error: wellError } = await supabase.from("title_job_wells").select("*").eq("job_id", jobId);
    if (wellError) throw Error(`Title discovery wells failed: ${wellError.message}`);
    // Discovery shares this run's image budget: new tract descriptions are
    // still searched, but reading stops at the run's limit and the rest is stated.
    await searchCountyRecordsForJob(supabase, defaultDeps, jobId, String(job.user_id), wells ?? [], documentBudget);
    const { data: pending, error: pendingError } = await supabase.from("title_documents").select("id").eq("job_id", jobId).eq("extraction_status", "pending").limit(1);
    if (pendingError) throw Error(`Title discovery documents failed: ${pendingError.message}`);
    return !!pending?.length;
  } });
}
