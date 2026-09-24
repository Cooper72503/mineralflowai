/**
 * After county retrieval, read the retrieved courthouse images and publish
 * the chain of title — automatically. The implementation lives in the
 * frontend (lib/trrc/title/process-job.ts) and is bundled into
 * dist/title-engine.mjs by scripts/build-report-engine.mjs, so the app and
 * the worker run the same extraction and analysis code.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProcessTitleJobResult {
  documentsRead: number; instrumentsCreated: number; extractionErrors: number;
  analysisId: string | null; classification: string | null; error: string | null;
}
type Engine = (supabase: SupabaseClient, jobId: string, userId: string) => Promise<ProcessTitleJobResult>;

const engineUrl = new URL("../dist/title-engine.mjs", import.meta.url).href;
const defaultEngine: Engine = async (...args) => (await import(engineUrl)).processTitleJob(...args);

/** Run processing only when retrieval finished normally; never on a cancelled or failed job. */
export async function processRetrievedTitleJob(supabase: SupabaseClient, jobId: string, engine: Engine = defaultEngine): Promise<ProcessTitleJobResult | null> {
  const { data: job, error } = await supabase.from("title_research_jobs").select("user_id, status").eq("id", jobId).maybeSingle();
  if (error) throw new Error(`Title job reload failed: ${error.message}`);
  if (!job || !["awaiting_tract_confirmation", "awaiting_documents"].includes(String(job.status))) return null;
  return engine(supabase, jobId, String(job.user_id));
}
