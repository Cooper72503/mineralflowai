/**
 * POST /api/trrc/due-diligence/[runId]/retry
 *
 * Retry failed source attempts for an existing run.
 * Optionally targets specific source_ids; if none provided, all failed sources
 * are cleared. After this route returns, the client calls /execute again.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Parse optional body
  let body: { source_ids?: string[] } = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // 2. Verify ownership
  const { data: run, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("id, status, user_id")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !run) {
    return NextResponse.json(
      { ok: false, error: "Run not found or access denied." },
      { status: 404 },
    );
  }

  // Can only retry runs that are failed or complete (with partial failures)
  const retryableStatuses = ["failed", "complete", "retrieving", "analyzing"];
  if (!retryableStatuses.includes(run["status"] as string)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Run status "${run["status"]}" is not retryable. Expected one of: ${retryableStatuses.join(", ")}.`,
      },
      { status: 409 },
    );
  }

  // 3. Delete failed source attempts (to allow re-run)
  const failedStatuses = ["failed_transient", "failed_permanent"];

  let deleteQuery = supabase
    .from("trrc_source_attempts")
    .delete()
    .eq("run_id", runId)
    .in("status", failedStatuses);

  if (body.source_ids && body.source_ids.length > 0) {
    deleteQuery = supabase
      .from("trrc_source_attempts")
      .delete()
      .eq("run_id", runId)
      .in("status", failedStatuses)
      .in("source_id", body.source_ids);
  }

  const { error: deleteError } = await deleteQuery;

  if (deleteError) {
    console.error("[retry] source attempts delete error:", deleteError);
    return NextResponse.json(
      { ok: false, error: "Failed to clear failed source attempts." },
      { status: 500 },
    );
  }

  // 4. Reset run status to "retrieving"
  const { error: updateError } = await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status: "retrieving",
      progress_percent: 0,
      error_summary: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (updateError) {
    console.error("[retry] run update error:", updateError);
    return NextResponse.json(
      { ok: false, error: "Failed to reset run status for retry." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: { run_id: runId },
  });
}
