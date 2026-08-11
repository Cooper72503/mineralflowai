/**
 * GET /api/trrc/due-diligence/[runId]
 *
 * Returns the current state of a TRRC DD run including status, progress,
 * resolved entities, findings, scorecard, and coverage.
 * Only the owning user can access their runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type { FindingSeverity, TrrcDDProductionRow, SourceCoverageStatus, TrrcDueDiligenceRun, TrrcGeologyDashboardSummary } from "@/lib/trrc/types";
import { deriveCoverageFromAttempts, type LiteSourceAttempt } from "@/lib/trrc/coverage";
import { computeProductionAnalytics, generateFlags } from "@/lib/trrc/report-builder";
import { buildAcquisitionScorecard } from "@/lib/trrc/scorecard-builder";

// Postgres text ordering on `severity` sorts alphabetically (critical, high,
// info, low, medium) which misplaces "info" ahead of "low"/"medium" and puts
// "medium" last. Rank explicitly so the most severe findings lead.
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // 2. Load run (RLS enforces user_id match)
  const { data: run, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !run) {
    return NextResponse.json(
      { ok: false, error: "Run not found or access denied." },
      { status: 404 },
    );
  }

  // 3. Load joined data in parallel
  const [entitiesResult, attemptsResult, findingsResult, productionResult, geologyAssessmentResult, geologyFindingsResult, geologyOffsetsResult] =
    await Promise.all([
      supabase
        .from("trrc_resolved_entities")
        .select("*")
        .eq("run_id", runId)
        .order("confidence", { ascending: false }),
      supabase
        .from("trrc_source_attempts")
        .select("*")
        .eq("run_id", runId)
        .order("attempted_at", { ascending: true }),
      supabase
        .from("trrc_due_diligence_findings")
        .select("*")
        .eq("run_id", runId),
      supabase
        .from("trrc_production_monthly")
        .select("*")
        .eq("run_id", runId)
        .order("production_month", { ascending: false })
        .limit(120),
      // Geological Due Diligence (migration 023) — written once, the first
      // time /report is generated for this run (see report-builder.ts's
      // persistGeologyTo). Absent until then; the dashboard shows an honest
      // "generate the report to compute this" state rather than a live
      // re-run on every 3s poll (same cost reasoning as offset analytics).
      supabase
        .from("geology_assessments")
        .select("*")
        .eq("run_id", runId)
        .maybeSingle(),
      supabase
        .from("geology_findings")
        .select("*")
        .eq("run_id", runId)
        .order("display_order", { ascending: true }),
      supabase
        .from("geology_offsets")
        .select("distance_miles, classified_status")
        .eq("run_id", runId),
    ]);

  const findings = (findingsResult.data ?? []).slice().sort(
    (a, b) => SEVERITY_RANK[a.severity as FindingSeverity] - SEVERITY_RANK[b.severity as FindingSeverity],
  );

  // trrc_due_diligence_findings and coverage_json/scorecard_json are never
  // actually written by the worker — confirmed live: every completed run
  // has an empty findings table and null/empty JSON columns. The PDF/CSV
  // exports already work around this by deriving these live from
  // source_attempts (export/route.ts); this route never did, so the live
  // dashboard had nothing to show for coverage/scorecard/findings even
  // though the underlying data (source_attempts) was right there. Mirror
  // the same derivation here so the dashboard and the exports agree.
  const attempts = (attemptsResult.data ?? []) as unknown as LiteSourceAttempt[];
  const production = (productionResult.data ?? []) as unknown as TrrcDDProductionRow[];
  const storedCoverage = (run.coverage_json as SourceCoverageStatus[] | null) ?? [];
  const coverage = storedCoverage.length > 0 ? storedCoverage : deriveCoverageFromAttempts(attempts);

  let scorecard = run.scorecard_json ?? null;
  let flags: { critical: string[]; important: string[] } = { critical: [], important: [] };
  if (!scorecard) {
    const analytics = computeProductionAnalytics(production);
    flags = generateFlags(attempts, analytics, run as unknown as TrrcDueDiligenceRun);
    // Offset-well/lateral-path context requires live TRRC GIS calls — too
    // expensive to run on a route polled every 3s, so those two inputs use
    // conservative defaults here. The downloadable PDF/XLSX still compute
    // the richer version with real GIS context.
    scorecard = buildAcquisitionScorecard({
      attempts, production, coverage,
      criticalFlags: flags.critical,
      importantFlags: flags.important,
      monthsOfHistory: analytics.months.length,
      recentAvgOil: analytics.recent12AvgOil,
      yoyDeclineOilPct: analytics.yoyDeclineOil,
      zeroProductionMonths: analytics.zeroMonths,
      worTrend: analytics.worTrend,
      offsetWellCount: 0,
      hasLateralPath: false,
      resolvedLeaseNumber: run.resolved_lease_number,
      resolvedDistrict: run.resolved_district,
    });
  }

  // Assemble the geology dashboard summary from migration 023's tables —
  // null (not an empty object) when no assessment has been persisted yet,
  // so the UI can render its own honest "not generated yet" state instead
  // of a misleadingly-populated-looking empty result.
  const geologyRow = geologyAssessmentResult.data as Record<string, unknown> | null;
  let geology: TrrcGeologyDashboardSummary | null = null;
  if (geologyRow) {
    const geologyOffsetRows = (geologyOffsetsResult.data ?? []) as Array<{ distance_miles: number; classified_status: string }>;
    const offsetWellCount3mi = geologyOffsetRows.filter(w => w.distance_miles <= 3).length;
    const producingWellCount3mi = geologyOffsetRows.filter(w => w.distance_miles <= 3 && (w.classified_status === "PRODUCING" || w.classified_status === "RECENTLY_ACTIVE")).length;
    geology = {
      classification: geologyRow["classification"] as TrrcGeologyDashboardSummary["classification"],
      confidence: geologyRow["confidence"] as TrrcGeologyDashboardSummary["confidence"],
      diligenceImplication: String(geologyRow["diligence_implication"] ?? ""),
      subjectFormation: (geologyRow["subject_formation"] as string | null) ?? null,
      subjectTvdFt: (geologyRow["subject_tvd_ft"] as number | null) ?? null,
      subjectTvdssFt: (geologyRow["subject_tvdss_ft"] as number | null) ?? null,
      tvdssMethodology: (geologyRow["tvdss_methodology"] as string | null) ?? null,
      offsetWellCount3mi,
      producingWellCount3mi,
      findings: (geologyFindingsResult.data ?? []).map(f => ({
        category: f["category"], classification: f["classification"], title: f["title"], description: f["description"],
        evidenceIds: f["evidence_ids"] ?? [],
      })) as TrrcGeologyDashboardSummary["findings"],
      generatedAt: String(geologyRow["generated_at"] ?? ""),
    };
  }

  return NextResponse.json(
    {
      ok: true,
      data: {
        ...run,
        entities: entitiesResult.data ?? [],
        source_attempts: attemptsResult.data ?? [],
        findings,
        missing_items: [],
        production,
        scorecard,
        coverage,
        flags,
        geology,
      },
    },
    // The frontend polls this route every 3s while a run is in progress —
    // without an explicit no-store directive, a browser (or any proxy/CDN
    // in front of production) can legitimately serve a stale cached body
    // for this exact URL instead of re-fetching, since `force-dynamic` only
    // controls server-side re-execution, not what the client is allowed to
    // cache. Confirmed live: the poll returned an identical stale "running"
    // body long after the run had actually completed in the database.
    { headers: { "Cache-Control": "no-store" } },
  );
}
