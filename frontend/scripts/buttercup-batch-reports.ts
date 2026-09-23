/**
 * Regenerate the Buttercup package reports through the real
 * generatePdfReportForRun() path and dump what each one actually produced,
 * so title / forecast / economics can be verified from the rendered report
 * rather than from the database the report reads.
 *
 * Working script — not part of the app build.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { generatePdfReportForRun } from "../lib/trrc/generate-report";
import { loadTitleForReport } from "../lib/trrc/title/report-input";

const OUT_DIR = process.env["OUT_DIR"] ?? "/tmp/buttercup_reports";
const USER_ID = "f015f547-5b7a-4b78-ac29-6572aa9b3d54";
const BATCH_AT = "2026-09-22 19:58:47.652411+00";

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const supabase = createClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  );

  const { data: runs, error } = await supabase
    .from("trrc_due_diligence_runs")
    .select("id, normalized_input, original_input, title_research_job_id, title_setup_warning, purchase_price")
    .eq("user_id", USER_ID)
    .eq("created_at", BATCH_AT)
    .order("normalized_input");
  if (error) throw new Error(`run lookup failed: ${error.message}`);

  const summary: Record<string, unknown>[] = [];
  for (const r of runs ?? []) {
    const input = String(r.normalized_input);
    process.stderr.write(`[buttercup] ${input} ...\n`);
    try {
      const result = await generatePdfReportForRun(supabase, String(r.id), USER_ID);
      if (!result.ok) {
        summary.push({ input, id: r.id, error: result.error });
        process.stderr.write(`[buttercup] ${input} FAILED: ${result.error}\n`);
        continue;
      }
      const path = `${OUT_DIR}/${result.filename}`;
      writeFileSync(path, result.pdfBuffer);

      // Same loader the PDF's title pages use, so what's reported here is
      // exactly what the section rendered.
      const title = await loadTitleForReport(
        supabase, USER_ID,
        (r.title_research_job_id as string | null) ?? null,
        null,
        (r.title_setup_warning as string | null) ?? null,
      );

      const run = result.run;
      const oil = (run.production ?? []).filter(p => p.oil_bbl !== null);
      summary.push({
        input, id: r.id, pdf: path, pdf_bytes: result.pdfBuffer.length,
        title: {
          status: title.status, headline: title.headline,
          jobId: title.jobId, analysis: title.analysis,
          totalIndexRows: title.totalIndexRows,
          verifiedInstrumentCount: title.verifiedInstrumentCount,
          documents: title.documents.length,
          tracts: title.tracts.length,
          countySearches: title.countyCoverage.length,
          countyHits: title.countyCoverage.reduce((a, c) => a + c.resultCount, 0),
          openReviewItems: title.openReviewItems.length,
          ownership: title.ownership, ownershipReason: title.ownershipReason,
        },
        resolved: {
          api: run.resolved_primary_api, district: run.resolved_district,
          lease: run.resolved_lease_number, purchase_price: run.purchase_price,
        },
        production: {
          months_with_oil: oil.length,
          first: oil.map(p => p.production_month).sort()[0] ?? null,
          last: oil.map(p => p.production_month).sort().slice(-1)[0] ?? null,
        },
        scorecard: run.scorecard ? {
          recommendation: run.scorecard.recommendation,
          opportunity_score: run.scorecard.opportunity_score,
          risk_score: run.scorecard.risk_score,
          overall_confidence: run.scorecard.overall_confidence,
        } : null,
      });
      process.stderr.write(`[buttercup] ${input} OK (${result.pdfBuffer.length} bytes)\n`);
    } catch (e) {
      summary.push({ input, id: r.id, error: String(e) });
      process.stderr.write(`[buttercup] ${input} EXCEPTION: ${String(e)}\n`);
    }
  }
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
  process.stderr.write(`[buttercup] DONE — ${summary.length} processed\n`);
}
main().catch(e => { console.error(e); process.exit(1); });
