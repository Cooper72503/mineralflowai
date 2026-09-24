/**
 * Everything after county retrieval, in one call: read every retrieved
 * courthouse image (OCR + instrument extraction), let each read copy take its
 * index row's place, share tracts across wells on one TRRC lease, link claims
 * to confirmed tracts, and publish the chain analysis.
 *
 * Until now these stages ran only when someone pressed "Process documents"
 * and then "Analyze" in the title-chain page, so an API submitted through
 * the app stopped at retrieved-but-unread images and every downstream
 * ownership field read "Unavailable". The worker bundles this module
 * (worker/scripts/build-report-engine.mjs) and runs it as soon as retrieval
 * finishes. The authenticated routes remain for manual re-runs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestPendingDocuments } from "./ingest";
import { supersedeIndexedCopies } from "./supersede-index";
import { propagateLeaseAssociations } from "./lease-associations";
import { linkUnmatchedClaims } from "./link-claims";
import { runTitleChainAnalysis } from "./analysis";

const MAX_INGEST_PASSES = 30;

export interface ProcessTitleJobResult {
  documentsRead: number;
  instrumentsCreated: number;
  extractionErrors: number;
  analysisId: string | null;
  classification: string | null;
  error: string | null;
}

export async function processTitleJob(supabase: SupabaseClient, jobId: string, userId: string): Promise<ProcessTitleJobResult> {
  const out: ProcessTitleJobResult = { documentsRead: 0, instrumentsCreated: 0, extractionErrors: 0, analysisId: null, classification: null, error: null };
  const setJob = (patch: Record<string, unknown>) =>
    supabase.from("title_research_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId).neq("status", "cancelled");

  try {
    await setJob({ status: "ingesting", stage_detail: "Reading retrieved courthouse documents" });
    for (let pass = 0; pass < MAX_INGEST_PASSES; pass++) {
      const r = await ingestPendingDocuments(supabase, userId, jobId, { limit: 3 });
      out.documentsRead += r.processed; out.instrumentsCreated += r.instrumentsCreated; out.extractionErrors += r.errors.length;
      await setJob({ stage_detail: `Reading retrieved courthouse documents (${out.documentsRead} read)` });
      if (r.remaining === 0 || r.processed === 0) break;
    }
    await setJob({ status: "analyzing", stage_detail: "Reconstructing the chain of title" });
    await supersedeIndexedCopies(supabase, jobId);
    await propagateLeaseAssociations(supabase, jobId, userId);
    await linkUnmatchedClaims(supabase, jobId);
    const analysis = await runTitleChainAnalysis(supabase, userId, jobId);
    if (!analysis.ok) {
      out.error = analysis.error;
      await setJob({ status: "awaiting_documents", stage_detail: `Analysis failed: ${analysis.error}` });
      return out;
    }
    out.analysisId = analysis.analysis.analysisId;
    out.classification = analysis.analysis.status;
    return out;
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
    await setJob({ status: "awaiting_documents", stage_detail: "Automatic document processing failed; stored evidence is preserved — retry from the job page" });
    return out;
  }
}
