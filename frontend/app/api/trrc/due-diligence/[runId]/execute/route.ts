/**
 * POST /api/trrc/due-diligence/[runId]/execute
 *
 * Workhorse route: runs the full TRRC retrieval pipeline for an existing run.
 * Called separately from the initial POST so that initial POST returns fast.
 *
 * Flow:
 *   1. Auth + ownership check
 *   2. Load run, verify status is "retrieving" or "pending"
 *   3. Build ResolvedSearchContext from run + entities
 *   4. runRetrievalOrchestrator  → source_attempts, production, coverage
 *   5. runFindingEngine          → findings
 *   6. computeAcquisitionScorecard → scorecard
 *   7. Persist findings, missing items, production rows
 *   8. Update run: status="complete", scorecard_json, coverage_json
 *   9. Build manifest → upload to Supabase Storage
 *  10. Return { ok: true, data: { status: "complete", run_id } }
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { runRetrievalOrchestrator } from "@/lib/trrc/retrieval-orchestrator";
import { runFindingEngine } from "@/lib/trrc/finding-engine";
import { computeAcquisitionScorecard } from "@/lib/trrc/scoring-engine";
import { buildManifest } from "@/lib/trrc/manifest-builder";
import type {
  ResolvedSearchContext,
  TrrcDueDiligenceRun,
  ResolvedEntity,
  NormalizedApi,
  SourceSearchResult,
} from "@/lib/trrc/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/** Build ResolvedSearchContext from DB run + entity rows. */
function buildSearchContext(
  run: Record<string, unknown>,
  entities: ResolvedEntity[],
  defaultProductionMonths = 36,
): ResolvedSearchContext {
  // Collect API numbers from wellbore entities
  const api_numbers: NormalizedApi[] = entities
    .filter((e) => e.entity_type === "wellbore" && typeof e.canonical_identifier === "string")
    .map((e) => buildNormalizedApi(e.canonical_identifier))
    .filter((a) => a.api10.length === 10);

  // If run has a resolved_primary_api, ensure it is included
  const primaryApi = typeof run["resolved_primary_api"] === "string" ? run["resolved_primary_api"] : null;
  if (primaryApi && !api_numbers.find((a) => a.api10 === primaryApi)) {
    api_numbers.unshift(buildNormalizedApi(primaryApi));
  }

  // Derive district from entities or run
  const district =
    (typeof run["resolved_district"] === "string" ? run["resolved_district"] : null) ??
    (() => {
      const wellboreAttrs = entities.find((e) => e.entity_type === "wellbore")?.attributes;
      return typeof wellboreAttrs?.["district"] === "string" ? wellboreAttrs["district"] : null;
    })();

  // Operator name from operator entities
  const operatorEntity = entities.find((e) => e.entity_type === "operator");
  const operator_name =
    typeof operatorEntity?.attributes["normalized_name"] === "string"
      ? operatorEntity.attributes["normalized_name"]
      : null;

  // Lease number
  const leaseEntity = entities.find((e) => e.entity_type === "lease");
  const lease_number =
    (typeof run["resolved_lease_number"] === "string" ? run["resolved_lease_number"] : null) ??
    (typeof leaseEntity?.attributes["lease_number"] === "string" ? leaseEntity.attributes["lease_number"] : null);

  // Gas ID
  const gas_id =
    (typeof run["resolved_gas_id"] === "string" ? run["resolved_gas_id"] : null) ??
    (() => {
      const gwEntity = entities.find((e) => e.entity_type === "wellbore" && typeof e.attributes["gas_well_id"] === "string");
      return gwEntity ? (gwEntity.attributes["gas_well_id"] as string) : null;
    })();

  return {
    run_id: run["id"] as string,
    input_type: run["selected_input_type"] as ResolvedSearchContext["input_type"],
    raw_input: run["original_input"] as string,
    normalized_input: run["normalized_input"] as string,
    api_numbers,
    district,
    lease_number,
    gas_id,
    operator_name,
    operator_number:
      typeof run["resolved_operator_number"] === "string" ? run["resolved_operator_number"] : null,
    county: null,
    lease_name: null,
    legal_description: null,
    search_historical: false,
    include_offset_wells: false,
    production_months: defaultProductionMonths,
  };
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
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

  // 2. Load run + verify ownership and status
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

  const runStatus = runRaw["status"] as string;
  if (runStatus !== "retrieving" && runStatus !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  // 3. Load entities
  const { data: entityRows } = await supabase
    .from("trrc_resolved_entities")
    .select("*")
    .eq("run_id", runId)
    .order("confidence", { ascending: false });

  const entities: ResolvedEntity[] = (entityRows ?? []).map((e) => ({
    id: e["id"] as string,
    entity_type: e["entity_type"] as ResolvedEntity["entity_type"],
    canonical_identifier: e["canonical_identifier"] as string,
    display_name: e["display_name"] as string,
    attributes: (e["attributes"] ?? {}) as Record<string, unknown>,
    confidence: e["confidence"] as number,
    resolution_method: e["resolution_method"] as string,
    is_user_selected: e["is_user_selected"] as boolean,
  }));

  // 4. Build search context
  const ctx = buildSearchContext(runRaw, entities);

  // 5. Run retrieval orchestrator
  const orchestratorResult = await runRetrievalOrchestrator(runId, ctx, supabase);

  // Build a source_data map for the finding engine from findings_raw
  const source_data: Record<string, SourceSearchResult> = {};
  for (const raw of orchestratorResult.findings_raw) {
    const sid = typeof raw["source_id"] === "string" ? raw["source_id"] : "";
    if (sid) {
      source_data[sid] = {
        source_id: sid,
        status: "success",
        records: [],
        manual_action_url: null,
        error: null,
        result_count: 0,
        data: raw as Record<string, unknown>,
      };
    }
  }

  // Mark run as analyzing
  await supabase
    .from("trrc_due_diligence_runs")
    .update({ status: "analyzing", progress_percent: 90, updated_at: new Date().toISOString() })
    .eq("id", runId);

  // 6. Run finding engine
  const findings = await runFindingEngine(runId, ctx, orchestratorResult, source_data);

  // 7. Compute scorecard
  const scorecard = computeAcquisitionScorecard(
    runId,
    ctx,
    findings,
    orchestratorResult.coverage,
    orchestratorResult,
  );

  // 8. Persist findings
  if (findings.length > 0) {
    const findingRows = findings.map((f) => ({
      run_id: runId,
      finding_id: f.id,
      category: f.category,
      severity: f.severity,
      finding_type: f.finding_type,
      title: f.title,
      description: f.description,
      evidence: f.evidence,
      source_record_ids: f.source_record_ids,
      analytical_method: f.analytical_method,
      confidence: f.confidence,
      recommended_action: f.recommended_action,
      is_directly_reported: f.is_directly_reported,
    }));

    const { error: findingsInsertError } = await supabase
      .from("trrc_due_diligence_findings")
      .insert(findingRows);

    if (findingsInsertError) {
      console.error("[execute] findings insert error:", findingsInsertError);
    }
  }

  // 9. Persist production rows
  if (orchestratorResult.production.length > 0) {
    const prodRows = orchestratorResult.production.map((p) => ({
      run_id: runId,
      entity_type: p.entity_type,
      api_number: p.api_number,
      district: p.district,
      lease_number: p.lease_number,
      gas_id: p.gas_id,
      operator_number: p.operator_number,
      production_month: p.production_month,
      oil_bbl: p.oil_bbl,
      casinghead_gas_mcf: p.casinghead_gas_mcf,
      gas_mcf: p.gas_mcf,
      condensate_bbl: p.condensate_bbl,
      water_bbl: p.water_bbl,
    }));

    const { error: prodInsertError } = await supabase
      .from("trrc_production_monthly")
      .insert(prodRows);

    if (prodInsertError) {
      console.error("[execute] production insert error:", prodInsertError);
    }
  }

  // Mark run as generating
  await supabase
    .from("trrc_due_diligence_runs")
    .update({ status: "generating", progress_percent: 95, updated_at: new Date().toISOString() })
    .eq("id", runId);

  // 10. Build manifest
  const runForManifest: TrrcDueDiligenceRun = {
    id: runId,
    user_id: user.id,
    original_input: runRaw["original_input"] as string,
    detected_input_type: runRaw["detected_input_type"] as TrrcDueDiligenceRun["detected_input_type"],
    selected_input_type: runRaw["selected_input_type"] as TrrcDueDiligenceRun["selected_input_type"],
    normalized_input: runRaw["normalized_input"] as string,
    status: "complete",
    started_at: runRaw["started_at"] as string,
    completed_at: new Date().toISOString(),
    progress_percent: 100,
    result_summary: null,
    error_summary: orchestratorResult.error,
    resolved_primary_api: ctx.api_numbers[0]?.api10 ?? null,
    resolved_district: ctx.district,
    resolved_lease_number: ctx.lease_number,
    resolved_gas_id: ctx.gas_id,
    resolved_operator_number: ctx.operator_number,
    report_storage_path: null,
    archive_storage_path: null,
    manifest_storage_path: null,
    created_at: runRaw["created_at"] as string,
    updated_at: new Date().toISOString(),
    entities,
  };

  const manifest = buildManifest(
    runForManifest,
    ctx,
    orchestratorResult,
    findings,
    scorecard,
    process.env["npm_package_version"] ?? "1.0.0",
  );

  // 11. Upload manifest to Supabase Storage (use service role to bypass RLS on storage)
  let manifest_storage_path: string | null = null;
  const adminClient = createServiceRoleClient();

  if (adminClient) {
    const storagePath = `trrc-due-diligence/${user.id}/${runId}/manifest.json`;
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));

    const { error: uploadError } = await adminClient.storage
      .from("trrc-due-diligence")
      .upload(storagePath, manifestBytes, {
        contentType: "application/json",
        upsert: true,
      });

    if (uploadError) {
      console.error("[execute] manifest upload error:", uploadError);
    } else {
      manifest_storage_path = storagePath;
    }
  }

  // 12. Update run to complete
  const { error: updateError } = await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status: "complete",
      progress_percent: 100,
      completed_at: new Date().toISOString(),
      scorecard_json: scorecard as unknown as Record<string, unknown>,
      coverage_json: orchestratorResult.coverage as unknown as Record<string, unknown>[],
      manifest_storage_path,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (updateError) {
    console.error("[execute] run update error:", updateError);
    return NextResponse.json(
      { ok: false, error: "Pipeline completed but failed to update run status." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: { status: "complete", run_id: runId },
  });
}
