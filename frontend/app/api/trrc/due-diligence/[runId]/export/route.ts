// @ts-nocheck
/**
 * GET /api/trrc/due-diligence/[runId]/export?type=production|coverage|evidence|timeline|xlsx
 *
 * Standalone table downloads — for a user who wants one table (or a
 * combined workbook) in a spreadsheet, not the full ZIP evidence package.
 * Reuses the exact same builders the ZIP archive uses (lib/trrc/
 * archive-builder.ts), so the numbers are always identical to what's in
 * the archive — no separate code path to drift out of sync.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type { TrrcDueDiligenceRun, SourceCoverageStatus, TrrcDDProductionRow } from "@/lib/trrc/types";
import type { LiteSourceAttempt } from "@/lib/trrc/coverage";
import { deriveCoverageFromAttempts } from "@/lib/trrc/coverage";
import { buildProductionCsv, buildCoverageCsv, buildEvidenceIndexCsv, buildTimelineCsv, buildOffsetWellsCsv, buildLateralPathCsv } from "@/lib/trrc/archive-builder";
import { buildEvidenceIndex } from "@/lib/trrc/evidence-index";
import { buildTimeline } from "@/lib/trrc/timeline-builder";
import { fetchOffsetWells } from "@/lib/trrc/offset-wells";
import { fetchLateralPath } from "@/lib/trrc/lateral-path";
import { buildXlsxWorkbook, type XlsxSheet } from "@/lib/trrc/xlsx-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPORT_TYPES = ["production", "coverage", "evidence", "timeline", "offset", "lateral", "xlsx"] as const;
type ExportType = (typeof EXPORT_TYPES)[number];

async function loadProduction(supabase, runId: string): Promise<TrrcDDProductionRow[]> {
  const { data } = await supabase
    .from("trrc_production_monthly")
    .select("*")
    .eq("run_id", runId)
    .order("production_month", { ascending: true })
    .limit(240);

  return (data ?? []).map((p) => ({
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
}

async function loadAttempts(supabase, runId: string): Promise<LiteSourceAttempt[]> {
  const { data } = await supabase
    .from("trrc_source_attempts")
    .select("source_id, source_name, status, result_count, result_data_json, attempted_at, error_message")
    .eq("run_id", runId)
    .order("attempted_at", { ascending: true });

  return (data ?? []).map((a) => ({
    source_id: a["source_id"] as string,
    source_name: a["source_name"] as string,
    status: a["status"] as string,
    result_count: (a["result_count"] as number) ?? 0,
    error_message: (a["error_message"] as string | null) ?? null,
    attempted_at: a["attempted_at"] as string,
    result_data_json: (a["result_data_json"] ?? null) as Record<string, unknown> | null,
  }));
}

function toRun(runRaw: Record<string, unknown>, userId: string): TrrcDueDiligenceRun {
  return {
    id: runRaw["id"] as string,
    user_id: userId,
    original_input: runRaw["original_input"] as string,
    normalized_input: runRaw["normalized_input"] as string,
    resolved_primary_api: (runRaw["resolved_primary_api"] as string | null) ?? null,
    resolved_district: (runRaw["resolved_district"] as string | null) ?? null,
    resolved_lease_number: (runRaw["resolved_lease_number"] as string | null) ?? null,
    resolved_operator_number: (runRaw["resolved_operator_number"] as string | null) ?? null,
  } as TrrcDueDiligenceRun;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "runId is required." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") as ExportType | null;
  if (!type || !EXPORT_TYPES.includes(type)) {
    return NextResponse.json(
      { ok: false, error: `type must be one of: ${EXPORT_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const { data: runRaw, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !runRaw) {
    return NextResponse.json({ ok: false, error: "Run not found or access denied." }, { status: 404 });
  }

  if (runRaw["status"] !== "complete") {
    return NextResponse.json({ ok: false, error: "Export is only available for completed runs." }, { status: 409 });
  }

  const normalizedInput = (runRaw["normalized_input"] as string | null) ?? runId;
  const identifier = normalizedInput.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const run = toRun(runRaw, user.id);

  if (type === "xlsx") {
    const [production, attempts] = await Promise.all([
      loadProduction(supabase, runId),
      loadAttempts(supabase, runId),
    ]);
    const storedCoverage = (runRaw["coverage_json"] as SourceCoverageStatus[] | null) ?? [];
    const coverage = storedCoverage.length > 0 ? storedCoverage : deriveCoverageFromAttempts(attempts);

    const gisAttempt = attempts.find(a => a.source_name === "fetch_gis_plat");
    const gisLat = typeof gisAttempt?.result_data_json?.["latitude"] === "number" ? gisAttempt.result_data_json["latitude"] as number : null;
    const gisLng = typeof gisAttempt?.result_data_json?.["longitude"] === "number" ? gisAttempt.result_data_json["longitude"] as number : null;
    const offsetWells = gisLat !== null && gisLng !== null
      ? await fetchOffsetWells(gisLat, gisLng, run.resolved_primary_api)
      : [];
    const lateralPath = gisLat !== null && gisLng !== null && run.resolved_primary_api
      ? await fetchLateralPath(run.resolved_primary_api, gisLat, gisLng)
      : null;

    const sheets: XlsxSheet[] = [
      {
        name: "Identity",
        columns: [{ header: "Field", width: 26 }, { header: "Value", width: 34 }],
        rows: [
          ["Original Input", run.original_input],
          ["Normalized Input", run.normalized_input],
          ["API Number", run.resolved_primary_api],
          ["District", run.resolved_district],
          ["Lease Number", run.resolved_lease_number],
          ["Operator Number", run.resolved_operator_number],
          ["Run ID", run.id],
          ["Generated At (UTC)", new Date().toISOString()],
        ],
      },
      {
        name: "Production",
        columns: [
          { header: "Month", width: 12 }, { header: "Oil (BBL)", width: 12 },
          { header: "Gas (MCF)", width: 12 }, { header: "Casinghead (MCF)", width: 14 },
          { header: "Condensate (BBL)", width: 14 }, { header: "Water (BBL)", width: 12 },
        ],
        rows: production.map(p => [p.production_month, p.oil_bbl, p.gas_mcf, p.casinghead_gas_mcf, p.condensate_bbl, p.water_bbl]),
      },
      {
        name: "Coverage",
        columns: [
          { header: "Category", width: 20 }, { header: "Label", width: 34 }, { header: "Status", width: 16 },
          { header: "Records Found", width: 12 }, { header: "Sources Checked", width: 24 }, { header: "Notes", width: 40 },
        ],
        rows: coverage.map(c => [c.category, c.label, c.status, c.records_found, c.sources_checked.join("; "), c.notes ?? ""]),
      },
      {
        name: "Evidence Index",
        columns: [
          { header: "Source", width: 32 }, { header: "Portal", width: 30 }, { header: "Portal URL", width: 40 },
          { header: "Query Criteria", width: 24 }, { header: "Status", width: 16 },
          { header: "Records", width: 10 }, { header: "Retrieved At (UTC)", width: 24 },
        ],
        rows: buildEvidenceIndex(attempts, run).map(e => [e.label, e.portal, e.portal_url, e.query_criteria, e.status, e.record_count, e.retrieved_at ?? ""]),
      },
      {
        name: "Timeline",
        columns: [{ header: "Date", width: 14 }, { header: "Category", width: 14 }, { header: "Event", width: 44 }],
        rows: buildTimeline(attempts, production).map(e => [e.date, e.category, e.label]),
      },
      {
        name: "Offset Wells",
        columns: [
          { header: "API", width: 14 }, { header: "Well No.", width: 12 }, { header: "Status", width: 20 },
          { header: "Distance (mi)", width: 14 }, { header: "Bearing", width: 10 },
          { header: "Latitude", width: 12 }, { header: "Longitude", width: 12 },
        ],
        rows: offsetWells.map(w => [w.api, w.well_number, w.status, Number(w.distance_miles.toFixed(3)), w.bearing, w.latitude, w.longitude]),
      },
      {
        name: "Lateral Path",
        columns: [{ header: "Field", width: 26 }, { header: "Value", width: 30 }],
        rows: lateralPath ? [
          ["Surface Latitude", lateralPath.surface_latitude],
          ["Surface Longitude", lateralPath.surface_longitude],
          ["Drainhole Latitude", lateralPath.drainhole_latitude],
          ["Drainhole Longitude", lateralPath.drainhole_longitude],
          ["Straight-Line Length (ft)", Number(lateralPath.straight_line_length_ft.toFixed(1))],
          ["Bearing from Surface", lateralPath.bearing],
        ] : [["Not applicable", "No horizontal drainhole on record (vertical well or not found)"]],
      },
    ];

    const xlsx = await buildXlsxWorkbook(sheets);
    return new NextResponse(xlsx, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="MineralFlowAI_${identifier}_${datePart}.xlsx"`,
      },
    });
  }

  let csv: string;
  let filename: string;

  if (type === "production") {
    const production = await loadProduction(supabase, runId);
    csv = buildProductionCsv(production);
    filename = `Production_${identifier}_${datePart}.csv`;
  } else if (type === "coverage") {
    const attempts = await loadAttempts(supabase, runId);
    const storedCoverage = (runRaw["coverage_json"] as SourceCoverageStatus[] | null) ?? [];
    const coverage = storedCoverage.length > 0 ? storedCoverage : deriveCoverageFromAttempts(attempts);
    csv = buildCoverageCsv(coverage);
    filename = `Source_Coverage_${identifier}_${datePart}.csv`;
  } else if (type === "timeline") {
    const [production, attempts] = await Promise.all([loadProduction(supabase, runId), loadAttempts(supabase, runId)]);
    csv = buildTimelineCsv(attempts, production);
    filename = `Timeline_${identifier}_${datePart}.csv`;
  } else if (type === "offset") {
    const attempts = await loadAttempts(supabase, runId);
    const gisAttempt = attempts.find(a => a.source_name === "fetch_gis_plat");
    const gisLat = typeof gisAttempt?.result_data_json?.["latitude"] === "number" ? gisAttempt.result_data_json["latitude"] as number : null;
    const gisLng = typeof gisAttempt?.result_data_json?.["longitude"] === "number" ? gisAttempt.result_data_json["longitude"] as number : null;
    const offsetWells = gisLat !== null && gisLng !== null ? await fetchOffsetWells(gisLat, gisLng, run.resolved_primary_api) : [];
    csv = buildOffsetWellsCsv(offsetWells);
    filename = `Offset_Wells_${identifier}_${datePart}.csv`;
  } else if (type === "lateral") {
    const attempts = await loadAttempts(supabase, runId);
    const gisAttempt = attempts.find(a => a.source_name === "fetch_gis_plat");
    const gisLat = typeof gisAttempt?.result_data_json?.["latitude"] === "number" ? gisAttempt.result_data_json["latitude"] as number : null;
    const gisLng = typeof gisAttempt?.result_data_json?.["longitude"] === "number" ? gisAttempt.result_data_json["longitude"] as number : null;
    const lateralPath = gisLat !== null && gisLng !== null && run.resolved_primary_api
      ? await fetchLateralPath(run.resolved_primary_api, gisLat, gisLng)
      : null;
    if (!lateralPath) {
      return NextResponse.json({ ok: false, error: "No horizontal drainhole on record for this well (vertical well, or not found in TRRC GIS data)." }, { status: 404 });
    }
    csv = buildLateralPathCsv(lateralPath);
    filename = `Lateral_Path_${identifier}_${datePart}.csv`;
  } else {
    const attempts = await loadAttempts(supabase, runId);
    csv = buildEvidenceIndexCsv(run, attempts);
    filename = `Evidence_Index_${identifier}_${datePart}.csv`;
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
