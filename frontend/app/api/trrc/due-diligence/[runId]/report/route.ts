/**
 * GET /api/trrc/due-diligence/[runId]/report
 *
 * Generate and download a PDF due diligence report for a completed run.
 * Loads all run data from the database, calls buildTrrcPdfReport, and
 * streams back the PDF buffer.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type {
  TrrcDueDiligenceRun,
  ResolvedEntity,
  TrrcFinding,
  AcquisitionScorecard,
  SourceCoverageStatus,
  TrrcDDProductionRow,
} from "@/lib/trrc/types";
import type { TrrcManifest } from "@/lib/trrc/manifest-builder";
import { deriveCoverageFromAttempts, type LiteSourceAttempt } from "@/lib/trrc/coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  // 1. Auth
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "runId is required." }, { status: 400 });
  }

  // 2. Load run + verify ownership
  const { data: runRaw, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !runRaw) {
    return NextResponse.json(
      { ok: false, error: "Run not found or access denied." },
      { status: 404 },
    );
  }

  if (runRaw["status"] !== "complete") {
    return NextResponse.json(
      { ok: false, error: "Report is only available for completed runs." },
      { status: 409 },
    );
  }

  // 3. Load related data
  const [entitiesResult, findingsResult, productionResult, attemptsResult] = await Promise.all([
    supabase.from("trrc_resolved_entities").select("*").eq("run_id", runId),
    supabase.from("trrc_due_diligence_findings").select("*").eq("run_id", runId),
    supabase
      .from("trrc_production_monthly")
      .select("*")
      .eq("run_id", runId)
      .order("production_month", { ascending: false })
      .limit(120),
    supabase
      .from("trrc_source_attempts")
      .select("source_id, source_name, status, result_count, result_data_json, attempted_at, error_message")
      .eq("run_id", runId)
      .order("attempted_at", { ascending: true }),
  ]);

  const entities: ResolvedEntity[] = (entitiesResult.data ?? []).map((e) => ({
    id: e["id"] as string,
    entity_type: e["entity_type"] as ResolvedEntity["entity_type"],
    canonical_identifier: e["canonical_identifier"] as string,
    display_name: e["display_name"] as string,
    attributes: (e["attributes"] ?? {}) as Record<string, unknown>,
    confidence: e["confidence"] as number,
    resolution_method: e["resolution_method"] as string,
    is_user_selected: e["is_user_selected"] as boolean,
  }));

  const findings: TrrcFinding[] = (findingsResult.data ?? []).map((f) => ({
    id: f["finding_id"] as string,
    category: f["category"] as TrrcFinding["category"],
    severity: f["severity"] as TrrcFinding["severity"],
    finding_type: f["finding_type"] as string,
    title: f["title"] as string,
    description: f["description"] as string,
    evidence: (f["evidence"] ?? {}) as Record<string, unknown>,
    source_record_ids: (f["source_record_ids"] ?? []) as string[],
    analytical_method: f["analytical_method"] as string,
    confidence: f["confidence"] as number,
    recommended_action: f["recommended_action"] as string,
    is_directly_reported: f["is_directly_reported"] as boolean,
  }));

  const production: TrrcDDProductionRow[] = (productionResult.data ?? []).map((p) => ({
    entity_type: p["entity_type"] as "lease" | "api",
    api_number: (p["api_number"] as string | null) ?? null,
    district: (p["district"] as string) ?? "",
    lease_number: (p["lease_number"] as string | null) ?? null,
    gas_id: (p["gas_id"] as string | null) ?? null,
    operator_number: (p["operator_number"] as string | null) ?? null,
    production_month: p["production_month"] as string,
    oil_bbl: (p["oil_bbl"] as number | null) ?? null,
    casinghead_gas_mcf: (p["casinghead_gas_mcf"] as number | null) ?? null,
    gas_mcf: (p["gas_mcf"] as number | null) ?? null,
    condensate_bbl: (p["condensate_bbl"] as number | null) ?? null,
    water_bbl: (p["water_bbl"] as number | null) ?? null,
  }));

  const run: TrrcDueDiligenceRun = {
    id: runRaw["id"] as string,
    user_id: user.id,
    original_input: runRaw["original_input"] as string,
    detected_input_type: runRaw["detected_input_type"] as TrrcDueDiligenceRun["detected_input_type"],
    selected_input_type: runRaw["selected_input_type"] as TrrcDueDiligenceRun["selected_input_type"],
    normalized_input: runRaw["normalized_input"] as string,
    status: runRaw["status"] as TrrcDueDiligenceRun["status"],
    started_at: runRaw["started_at"] as string,
    completed_at: (runRaw["completed_at"] as string | null) ?? null,
    progress_percent: (runRaw["progress_percent"] as number) ?? 100,
    result_summary: (runRaw["result_summary"] as string | null) ?? null,
    error_summary: (runRaw["error_summary"] as string | null) ?? null,
    resolved_primary_api: (runRaw["resolved_primary_api"] as string | null) ?? null,
    resolved_district: (runRaw["resolved_district"] as string | null) ?? null,
    resolved_lease_number: (runRaw["resolved_lease_number"] as string | null) ?? null,
    resolved_gas_id: (runRaw["resolved_gas_id"] as string | null) ?? null,
    resolved_operator_number: (runRaw["resolved_operator_number"] as string | null) ?? null,
    report_storage_path: (runRaw["report_storage_path"] as string | null) ?? null,
    archive_storage_path: (runRaw["archive_storage_path"] as string | null) ?? null,
    manifest_storage_path: (runRaw["manifest_storage_path"] as string | null) ?? null,
    created_at: runRaw["created_at"] as string,
    updated_at: runRaw["updated_at"] as string,
    entities,
    findings,
    production,
    scorecard: (runRaw["scorecard_json"] as AcquisitionScorecard | null) ?? null,
    coverage: (runRaw["coverage_json"] as SourceCoverageStatus[]) ?? [],
  };

  // 4. Map source_attempts rows into a lightweight shape for the report
  const sourceAttemptRows = (attemptsResult.data ?? []).map((a) => ({
    source_id: a["source_id"] as string,
    source_name: a["source_name"] as string,
    status: a["status"] as string,
    result_count: (a["result_count"] as number) ?? 0,
    error_message: (a["error_message"] as string | null) ?? null,
    attempted_at: a["attempted_at"] as string,
    result_data_json: (a["result_data_json"] ?? null) as Record<string, unknown> | null,
  }));

  // 5. Determine coverage: prefer coverage_json saved by edge function, fall back to deriving it
  const storedCoverage = (runRaw["coverage_json"] as SourceCoverageStatus[] | null) ?? [];
  const coverage: SourceCoverageStatus[] = storedCoverage.length > 0
    ? storedCoverage
    : deriveCoverageFromAttempts(sourceAttemptRows);

  const scorecard: AcquisitionScorecard | null = run.scorecard ?? null;

  // 6. Build a lightweight manifest for the report builder
  const manifest: TrrcManifest = {
    schema_version: "1.0",
    app_version: process.env["npm_package_version"] ?? "1.0.0",
    run_id: run.id,
    user_input: run.original_input,
    normalized_input: run.normalized_input,
    input_type: run.selected_input_type,
    resolution_history: [],
    selected_entities: (run.entities ?? []).filter((e) => e.is_user_selected),
    candidate_entities: (run.entities ?? []).filter((e) => !e.is_user_selected),
    retrieval_started_at: run.started_at,
    retrieval_completed_at: run.completed_at ?? new Date().toISOString(),
    source_registry_version: "1.0.0",
    // Pass real source attempts so methodology page can show correct count
    source_attempts: sourceAttemptRows as unknown as import("@/lib/trrc/types").SourceAttempt[],
    discovered_records: [],
    downloaded_files: [],
    failed_downloads: [],
    manual_retrieval_required: [],
    production_records_count: production.length,
    findings,
    missing_items: run.missing_items ?? [],
    scorecard: scorecard ?? ({} as AcquisitionScorecard),
    coverage,
    report_assumptions: [
      "All production data is lease-level; single-well attribution requires per-well allocation evidence.",
      "canClaimSingleWellProduction is always false for lease-level sources.",
      "TRRC production reporting lags 60–90 days from the production month.",
    ],
    disclaimer:
      "Mineral Flow AI compiles and analyzes publicly available regulatory information for preliminary " +
      "acquisition screening. This report is not a title opinion, reserve report, engineering certification, " +
      "environmental assessment, legal opinion, or substitute for independent due diligence. " +
      "Public records may be incomplete, delayed, amended, incorrectly indexed, or unavailable online.",
    generated_at: new Date().toISOString(),
  };

  // 7. Load and call the PDF report builder
  let buildTrrcPdfReport: (
    run: TrrcDueDiligenceRun,
    manifest: TrrcManifest,
    findings: TrrcFinding[],
    scorecard: AcquisitionScorecard,
    production: TrrcDDProductionRow[],
    coverage: SourceCoverageStatus[],
    sourceAttempts: LiteSourceAttempt[],
  ) => Promise<Buffer>;

  try {
    const mod = await import("@/lib/trrc/report-builder");
    buildTrrcPdfReport = mod.buildTrrcPdfReport;
  } catch {
    return NextResponse.json(
      { ok: false, error: "PDF report builder is not yet implemented." },
      { status: 501 },
    );
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await buildTrrcPdfReport(run, manifest, findings, scorecard ?? {} as AcquisitionScorecard, production, coverage, sourceAttemptRows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[report] PDF generation error:", msg);
    return NextResponse.json(
      { ok: false, error: "Failed to generate PDF report." },
      { status: 500 },
    );
  }

  // 7. Build a safe filename
  const identifier = (run.normalized_input ?? runId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `TRRC_DD_Report_${identifier}_${datePart}.pdf`;

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
