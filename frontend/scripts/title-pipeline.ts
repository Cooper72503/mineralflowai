/**
 * Runs the title pipeline's post-retrieval stages — document ingestion
 * (OCR + instrument extraction) and chain analysis — through the same
 * library functions the authenticated routes call. Working script for
 * driving a job to a published analysis; not part of the app build.
 *
 *   tsx --env-file=.env.local scripts/title-pipeline.ts <jobId> [ingest|analyze|all]
 */
import { createClient } from "@supabase/supabase-js";
import { ingestPendingDocuments } from "../lib/trrc/title/ingest";
import { runTitleChainAnalysis } from "../lib/trrc/title/analysis";
import { linkUnmatchedClaims } from "../lib/trrc/title/link-claims";
import { supersedeIndexedCopies } from "../lib/trrc/title/supersede-index";
import { propagateLeaseAssociations } from "../lib/trrc/title/lease-associations";

const [jobId, stage = "all"] = process.argv.slice(2);
if (!jobId) throw new Error("jobId required");

async function main() {
  const db = createClient(process.env["NEXT_PUBLIC_SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!);
  const { data: job, error } = await db.from("title_research_jobs").select("id, user_id, status").eq("id", jobId).single();
  if (error || !job) throw new Error(`job lookup failed: ${error?.message}`);
  const userId = String(job.user_id);

  if (stage === "ingest" || stage === "all") {
    for (let pass = 1; pass <= 10; pass++) {
      const r = await ingestPendingDocuments(db, userId, jobId, { limit: 3 });
      console.log(`[ingest pass ${pass}]`, JSON.stringify({ processed: r.processed, instrumentsCreated: r.instrumentsCreated, duplicatesSkipped: r.duplicatesSkipped, remaining: r.remaining, errors: r.errors }));
      if (r.remaining === 0 || r.processed === 0) break;
    }
    await db.from("title_research_jobs").update({ status: "awaiting_documents", stage_detail: "Documents processed — run the analysis", updated_at: new Date().toISOString() }).eq("id", jobId).neq("status", "cancelled");
  }
  if (stage === "analyze" || stage === "all") {
    console.log("[supersede]", await supersedeIndexedCopies(db, jobId));
    console.log("[lease associations]", await propagateLeaseAssociations(db, jobId, userId));
    console.log("[link]", await linkUnmatchedClaims(db, jobId));
    const r = await runTitleChainAnalysis(db, userId, jobId);
    console.log("[analyze]", JSON.stringify(r.ok ? { ok: true, reused: r.reused, analysisId: r.analysis.analysisId, classification: (r.analysis as unknown as Record<string, unknown>)["status"] ?? (r.analysis as unknown as Record<string, unknown>)["classification"] } : r));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
