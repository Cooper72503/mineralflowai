/**
 * GET /api/trrc/due-diligence/[runId]
 *
 * Returns the current state of a TRRC DD run including status, progress,
 * resolved entities, findings, scorecard, and coverage.
 * Only the owning user can access their runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

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
        .eq("run_id", runId)
        .order("severity", { ascending: true }),
      supabase
        .from("trrc_production_monthly")
        .select("*")
        .eq("run_id", runId)
        .order("production_month", { ascending: false })
        .limit(120),
    ]);

  return NextResponse.json({
    ok: true,
    data: {
      ...run,
      entities: entitiesResult.data ?? [],
      source_attempts: attemptsResult.data ?? [],
      findings: findingsResult.data ?? [],
      missing_items: [],
      production: productionResult.data ?? [],
      scorecard: run.scorecard_json ?? null,
      coverage: run.coverage_json ?? [],
    },
  });
}
