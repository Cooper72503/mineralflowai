/**
 * GET /api/trrc/due-diligence/[runId]
 *
 * Returns the current state of a TRRC DD run including status, progress,
 * resolved entities, findings, scorecard, and coverage.
 * Only the owning user can access their runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type { FindingSeverity } from "@/lib/trrc/types";

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
  const [entitiesResult, attemptsResult, findingsResult, productionResult] =
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
    ]);

  const findings = (findingsResult.data ?? []).slice().sort(
    (a, b) => SEVERITY_RANK[a.severity as FindingSeverity] - SEVERITY_RANK[b.severity as FindingSeverity],
  );

  return NextResponse.json(
    {
      ok: true,
      data: {
        ...run,
        entities: entitiesResult.data ?? [],
        source_attempts: attemptsResult.data ?? [],
        findings,
        missing_items: [],
        production: productionResult.data ?? [],
        scorecard: run.scorecard_json ?? null,
        coverage: run.coverage_json ?? [],
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
