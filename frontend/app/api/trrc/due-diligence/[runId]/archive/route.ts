// @ts-nocheck
/**
 * GET /api/trrc/due-diligence/[runId]/archive
 *
 * Download a ZIP archive of all retrieved files and the PDF report for a run.
 * If archive_storage_path is set, redirects to a short-lived signed URL.
 * Otherwise builds the archive on-the-fly using lib/trrc/archive-builder.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import type {
  TrrcDueDiligenceRun,
  TrrcFinding,
  AcquisitionScorecard,
  SourceCoverageStatus,
  TrrcDDProductionRow,
} from "@/lib/trrc/types";
import type { TrrcManifest } from "@/lib/trrc/manifest-builder";
import { deriveCoverageFromAttempts } from "@/lib/trrc/coverage";

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
      { ok: false, error: "Archive is only available for completed runs." },
      { status: 409 },
    );
  }

  const archiveStoragePath = (runRaw["archive_storage_path"] as string | null) ?? null;

  // Build a safe filename
  const normalizedInput = (runRaw["normalized_input"] as string | null) ?? runId;
  const identifier = normalizedInput.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `TRRC_DD_${identifier}_${datePart}.zip`;

  // 3a. If archive already exists in storage, redirect via signed URL
  if (archiveStoragePath) {
    const adminClient = createServiceRoleClient();
    if (adminClient) {
      const { data: signedData, error: signedError } = await adminClient.storage
        .from("trrc-due-diligence")
        .createSignedUrl(archiveStoragePath, 300); // 5-minute signed URL

      if (!signedError && signedData?.signedUrl) {
        return NextResponse.redirect(signedData.signedUrl, { status: 302 });
      }
    }
    console.warn("[archive] signed URL creation failed, falling back to on-the-fly build");
  }

  // 3b. Load related data for on-the-fly build
  const [findingsResult, productionResult, attemptsResult] = await Promise.all([
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

  const sourceAttemptRows = (attemptsResult.data ?? []).map((a) => ({
    source_id: a["source_id"] as string,
    source_name: a["source_name"] as string,
    status: a["status"] as string,
    result_count: (a["result_count"] as number) ?? 0,
    error_message: (a["error_message"] as string | null) ?? null,
    attempted_at: a["attempted_at"] as string,
    result_data_json: (a["result_data_json"] ?? null) as Record<string, unknown> | null,
  }));

  // Prefer stored coverage_json if present, but the current worker never
  // writes that column — fall back to deriving it from source attempts
  // (same logic the /report route uses) rather than silently shipping an
  // empty coverage section in the manifest.
  const storedCoverage = (runRaw["coverage_json"] as SourceCoverageStatus[] | null) ?? [];
  const coverage: SourceCoverageStatus[] = storedCoverage.length > 0
    ? storedCoverage
    : deriveCoverageFromAttempts(sourceAttemptRows);
  const scorecard: AcquisitionScorecard | null = (runRaw["scorecard_json"] as AcquisitionScorecard | null) ?? null;

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
    purchase_price: (runRaw["purchase_price"] as number | null) ?? null,
    report_storage_path: (runRaw["report_storage_path"] as string | null) ?? null,
    archive_storage_path: archiveStoragePath,
    manifest_storage_path: (runRaw["manifest_storage_path"] as string | null) ?? null,
    created_at: runRaw["created_at"] as string,
    updated_at: runRaw["updated_at"] as string,
    findings,
    production,
    coverage,
    scorecard,
  };

  // 3c. Build manifest
  const manifest: TrrcManifest = {
    schema_version: "1.0",
    app_version: "1.0.0",
    run_id: run.id,
    user_input: run.original_input,
    normalized_input: run.normalized_input,
    input_type: run.selected_input_type,
    resolution_history: [],
    selected_entities: [],
    candidate_entities: [],
    retrieval_started_at: run.started_at,
    retrieval_completed_at: run.completed_at ?? new Date().toISOString(),
    source_registry_version: "1.0.0",
    source_attempts: [],
    discovered_records: [],
    downloaded_files: [],
    failed_downloads: [],
    manual_retrieval_required: [],
    production_records_count: production.length,
    findings,
    missing_items: [],
    scorecard: scorecard ?? {
      dimensions: {
        record_completeness:    { label: "Record Completeness",    score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        identity_confidence:    { label: "Identity Confidence",    score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        production_quality:     { label: "Production Quality",     score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        production_consistency: { label: "Production Consistency", score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        mechanical_integrity:   { label: "Mechanical Integrity",   score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        plugging_exposure:      { label: "Plugging Exposure",      score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        regulatory_compliance:  { label: "Regulatory Compliance",  score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        operator_profile:       { label: "Operator Profile",       score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        development_activity:   { label: "Development Activity",   score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
        data_confidence:        { label: "Data Confidence",        score: 0, weight: 0.1, rationale: "Not scored.", data_points: [] },
      },
      opportunity_score: 0,
      risk_score: 0,
      overall_confidence: 0,
      recommendation: "REVIEW",
      gating_conditions: [],
      missing_critical_evidence: [],
      reasons_for: [],
      reasons_against: [],
    },
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

  // 3d. Generate PDF
  //
  // The scorecard feature is deliberately unimplemented (scorecard_json is
  // never written by the worker), so `scorecard` here is always null. That
  // previously gated PDF generation entirely — buildTrrcPdfReport's
  // scorecard parameter isn't even read internally — so every archived ZIP
  // shipped a 0-byte PDF. The /report route calls the same function
  // unconditionally with the same `?? {}` fallback; match that here.
  let pdfBuffer: Buffer = Buffer.alloc(0);
  try {
    const reportMod = await import("@/lib/trrc/report-builder");
    pdfBuffer = await reportMod.buildTrrcPdfReport(run, manifest, findings, scorecard ?? ({} as AcquisitionScorecard), production, coverage, sourceAttemptRows);
  } catch (err) {
    console.warn("[archive] PDF generation skipped:", err instanceof Error ? err.message : String(err));
  }

  // 3e. Build ZIP archive
  try {
    const archiveMod = await import("@/lib/trrc/archive-builder");
    const zipBuffer = await archiveMod.buildTrrcZipArchive(
      run,
      manifest,
      pdfBuffer,
      production,
      findings,
      coverage,
      sourceAttemptRows,
    );

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(zipBuffer.length),
      },
    });
  } catch (zipErr) {
    const msg = zipErr instanceof Error ? zipErr.message : String(zipErr);
    console.error("[archive] ZIP build error:", msg);
    return NextResponse.json(
      { ok: false, error: "Failed to build ZIP archive.", detail: msg },
      { status: 500 },
    );
  }
}
