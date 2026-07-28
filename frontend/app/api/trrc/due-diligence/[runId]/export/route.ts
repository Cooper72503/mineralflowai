// @ts-nocheck
/**
 * GET /api/trrc/due-diligence/[runId]/export?type=production|coverage|evidence
 *
 * Standalone single-table CSV downloads — for a user who wants one table in
 * a spreadsheet, not the full ZIP evidence package. Reuses the exact same
 * CSV builders the ZIP archive uses (lib/trrc/archive-builder.ts), so the
 * numbers are always identical to what's in the archive — no separate
 * code path to drift out of sync.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type { TrrcDueDiligenceRun, SourceCoverageStatus, TrrcDDProductionRow } from "@/lib/trrc/types";
import { deriveCoverageFromAttempts } from "@/lib/trrc/coverage";
import { buildProductionCsv, buildCoverageCsv, buildEvidenceIndexCsv } from "@/lib/trrc/archive-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPORT_TYPES = ["production", "coverage", "evidence"] as const;
type ExportType = (typeof EXPORT_TYPES)[number];

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

  let csv: string;
  let filename: string;

  if (type === "production") {
    const { data } = await supabase
      .from("trrc_production_monthly")
      .select("*")
      .eq("run_id", runId)
      .order("production_month", { ascending: true })
      .limit(240);

    const production: TrrcDDProductionRow[] = (data ?? []).map((p) => ({
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
    csv = buildProductionCsv(production);
    filename = `Production_${identifier}_${datePart}.csv`;
  } else {
    const { data: attemptsData } = await supabase
      .from("trrc_source_attempts")
      .select("source_id, source_name, status, result_count, result_data_json, attempted_at, error_message")
      .eq("run_id", runId)
      .order("attempted_at", { ascending: true });

    const sourceAttemptRows = (attemptsData ?? []).map((a) => ({
      source_id: a["source_id"] as string,
      source_name: a["source_name"] as string,
      status: a["status"] as string,
      result_count: (a["result_count"] as number) ?? 0,
      error_message: (a["error_message"] as string | null) ?? null,
      attempted_at: a["attempted_at"] as string,
      result_data_json: (a["result_data_json"] ?? null) as Record<string, unknown> | null,
    }));

    if (type === "coverage") {
      const storedCoverage = (runRaw["coverage_json"] as SourceCoverageStatus[] | null) ?? [];
      const coverage = storedCoverage.length > 0 ? storedCoverage : deriveCoverageFromAttempts(sourceAttemptRows);
      csv = buildCoverageCsv(coverage);
      filename = `Source_Coverage_${identifier}_${datePart}.csv`;
    } else {
      const run: TrrcDueDiligenceRun = {
        id: runRaw["id"] as string,
        user_id: user.id,
        original_input: runRaw["original_input"] as string,
        normalized_input: runRaw["normalized_input"] as string,
        resolved_primary_api: (runRaw["resolved_primary_api"] as string | null) ?? null,
        resolved_district: (runRaw["resolved_district"] as string | null) ?? null,
        resolved_lease_number: (runRaw["resolved_lease_number"] as string | null) ?? null,
        resolved_operator_number: (runRaw["resolved_operator_number"] as string | null) ?? null,
      } as TrrcDueDiligenceRun;
      csv = buildEvidenceIndexCsv(run, sourceAttemptRows);
      filename = `Evidence_Index_${identifier}_${datePart}.csv`;
    }
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
