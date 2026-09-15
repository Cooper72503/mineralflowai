import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { generatePdfReportForRun } from "../lib/trrc/generate-report";

const listFile = process.argv[2] ?? "/tmp/gaines_run_ids.txt";
const runs: { id: string; input: string }[] = readFileSync(listFile, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((pair) => {
    const [id, input] = pair.split("|");
    return { id, input };
  });

const OUT_DIR = "/tmp/gaines_reports";
mkdirSync(OUT_DIR, { recursive: true });

const USER_ID = "f015f547-5b7a-4b78-ac29-6572aa9b3d54";

async function main() {
  const supabase = createClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  );

  const summary: Record<string, unknown>[] = [];

  for (const { id, input } of runs) {
    process.stderr.write(`[gaines-batch] ${input} (${id}) ...\n`);
    try {
      const result = await generatePdfReportForRun(supabase, id, USER_ID);
      if (!result.ok) {
        summary.push({ input, id, error: result.error });
        process.stderr.write(`[gaines-batch] ${input} FAILED: ${result.error}\n`);
        continue;
      }
      const path = `${OUT_DIR}/${input.replace(/\//g, "_")}.pdf`;
      writeFileSync(path, result.pdfBuffer);

      const run = result.run;
      const latestProd = (run.production ?? [])
        .filter((p) => p.oil_bbl !== null)
        .sort((a, b) => (a.production_month < b.production_month ? 1 : -1))[0];

      summary.push({
        input,
        id,
        resolved_primary_api: run.resolved_primary_api,
        resolved_district: run.resolved_district,
        resolved_lease_number: run.resolved_lease_number,
        pdf_path: path,
        scorecard: run.scorecard
          ? {
              recommendation: run.scorecard.recommendation,
              opportunity_score: run.scorecard.opportunity_score,
              risk_score: run.scorecard.risk_score,
              overall_confidence: run.scorecard.overall_confidence,
            }
          : null,
        findings_count: (run.findings ?? []).length,
        findings: (run.findings ?? []).map((f) => ({
          category: f.category,
          severity: f.severity,
          title: f.title,
        })),
        latest_production_month: latestProd?.production_month ?? null,
        latest_oil_bbl: latestProd?.oil_bbl ?? null,
        production_months_count: (run.production ?? []).filter((p) => p.oil_bbl !== null).length,
        coverage: (run.coverage ?? []).map((c) => ({ label: c.label, status: c.status })),
      });
      process.stderr.write(`[gaines-batch] ${input} OK\n`);
    } catch (e) {
      summary.push({ input, id, error: String(e) });
      process.stderr.write(`[gaines-batch] ${input} EXCEPTION: ${String(e)}\n`);
    }
  }

  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
  process.stderr.write(`[gaines-batch] DONE — ${summary.length} processed\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
