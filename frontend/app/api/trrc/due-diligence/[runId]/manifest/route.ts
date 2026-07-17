// @ts-nocheck
/**
 * GET /api/trrc/due-diligence/[runId]/manifest
 *
 * Download the JSON retrieval manifest for a completed run.
 * If manifest_storage_path is set, downloads from Supabase Storage via signed URL.
 * Otherwise builds the manifest on-the-fly from DB data.
 *
 * Returns application/json with Content-Disposition: attachment.
 * Storage paths are never exposed directly — signed URLs are used.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { buildManifest } from "@/lib/trrc/manifest-builder";
import type {
  TrrcDueDiligenceRun,
  ResolvedEntity,
  AcquisitionScorecard,
  TrrcFinding,
  NormalizedApi,
  ResolvedSearchContext,
} from "@/lib/trrc/types";
import type { OrchestratorResult } from "@/lib/trrc/retrieval-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Build a NormalizedApi from a 10-digit api10 string. */
function buildNormalizedApi(api10: string): NormalizedApi {
  const state_code = api10.slice(0, 2);
  const county_code = api10.slice(2, 5);
  const well_code = api10.slice(5, 10);
  return {
    raw: api10,
    api10,
    api14: `${api10}0000`,
    formatted: `${state_code}-${county_code}-${well_code}-00-00`,
    state_code,
    county_code,
    well_code,
    is_texas: state_code === "42",
  };
}

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

  const storagePath = runRaw["manifest_storage_path"] as string | null;
  const filename = `manifest_${runId}.json`;

  // 3a. If storage path exists, download via signed URL
  if (storagePath) {
    const adminClient = createServiceRoleClient();
    if (adminClient) {
      const { data: signedData, error: signedError } = await adminClient.storage
        .from("trrc-due-diligence")
        .createSignedUrl(storagePath, 60); // 60-second signed URL

      if (!signedError && signedData?.signedUrl) {
        const fileResponse = await fetch(signedData.signedUrl);
        if (fileResponse.ok) {
          const jsonText = await fileResponse.text();
          return new Response(jsonText, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": `attachment; filename="${filename}"`,
            },
          });
        }
      }
      console.warn("[manifest] signed URL fetch failed, falling back to on-the-fly build");
    }
  }

  // 3b. Build manifest on-the-fly from DB data
  const [entitiesResult, attemptsResult, findingsResult, productionResult] = await Promise.all([
    supabase
      .from("trrc_resolved_entities")
      .select("*")
      .eq("run_id", runId),
    supabase
      .from("trrc_source_attempts")
      .select("*")
      .eq("run_id", runId),
    supabase
      .from("trrc_due_diligence_findings")
      .select("*")
      .eq("run_id", runId),
    supabase
      .from("trrc_production_monthly")
      .select("*")
      .eq("run_id", runId),
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
    progress_percent: (runRaw["progress_percent"] as number) ?? 0,
    result_summary: (runRaw["result_summary"] as string | null) ?? null,
    error_summary: (runRaw["error_summary"] as string | null) ?? null,
    resolved_primary_api: (runRaw["resolved_primary_api"] as string | null) ?? null,
    resolved_district: (runRaw["resolved_district"] as string | null) ?? null,
    resolved_lease_number: (runRaw["resolved_lease_number"] as string | null) ?? null,
    resolved_gas_id: (runRaw["resolved_gas_id"] as string | null) ?? null,
    resolved_operator_number: (runRaw["resolved_operator_number"] as string | null) ?? null,
    report_storage_path: (runRaw["report_storage_path"] as string | null) ?? null,
    archive_storage_path: (runRaw["archive_storage_path"] as string | null) ?? null,
    manifest_storage_path: storagePath,
    created_at: runRaw["created_at"] as string,
    updated_at: runRaw["updated_at"] as string,
    entities,
  };

  const primaryApi = run.resolved_primary_api;
  const api_numbers: NormalizedApi[] = primaryApi ? [buildNormalizedApi(primaryApi)] : [];

  const ctx: ResolvedSearchContext = {
    run_id: runId,
    input_type: run.selected_input_type,
    raw_input: run.original_input,
    normalized_input: run.normalized_input,
    api_numbers,
    district: run.resolved_district,
    lease_number: run.resolved_lease_number,
    gas_id: run.resolved_gas_id,
    operator_name: null,
    operator_number: run.resolved_operator_number,
    county: null,
    lease_name: null,
    legal_description: null,
    search_historical: false,
    include_offset_wells: false,
    production_months: 36,
  };

  const orchestratorResult: OrchestratorResult = {
    run_id: runId,
    source_attempts: (attemptsResult.data ?? []).map((a) => ({
      source_id: a["source_id"] as string,
      source_name: a["source_name"] as string,
      request_parameters: (a["request_parameters"] ?? {}) as Record<string, string>,
      request_url: (a["request_url"] as string | null) ?? null,
      started_at: a["started_at"] as string,
      completed_at: (a["completed_at"] as string | null) ?? null,
      status: a["status"] as import("@/lib/trrc/types").SourceAttemptStatus,
      result_count: (a["result_count"] as number) ?? 0,
      http_status: (a["http_status"] as number | null) ?? null,
      retry_count: (a["retry_count"] as number) ?? 0,
      error_code: (a["error_code"] as string | null) ?? null,
      error_message: (a["error_message"] as string | null) ?? null,
      manual_action_url: (a["manual_action_url"] as string | null) ?? null,
      parser_version: (a["parser_version"] as string) ?? "1.0.0",
    })),
    production: (productionResult.data ?? []).map((p) => ({
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
    })),
    findings_raw: [],
    coverage: (runRaw["coverage_json"] as import("@/lib/trrc/types").SourceCoverageStatus[]) ?? [],
    total_records_found: 0,
    manual_required_count: 0,
    error: null,
  };

  const scorecard = (runRaw["scorecard_json"] as AcquisitionScorecard | null) ?? {
    dimensions: {} as AcquisitionScorecard["dimensions"],
    opportunity_score: 0,
    risk_score: 0,
    overall_confidence: 0,
    recommendation: "BLOCKED" as const,
    gating_conditions: [],
    missing_critical_evidence: [],
    reasons_for: [],
    reasons_against: [],
  };

  const manifest = buildManifest(
    run,
    ctx,
    orchestratorResult,
    findings,
    scorecard,
    process.env["npm_package_version"] ?? "1.0.0",
  );

  const json = JSON.stringify(manifest, null, 2);

  return new Response(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
