/**
 * POST /api/trrc/due-diligence/[runId]/resolve
 *
 * User selects a specific entity candidate from the list returned during
 * awaiting_selection. Marks the entity as is_user_selected and advances
 * the run status to "retrieving" so the client can call /execute next.
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

  // Parse body
  let body: { entity_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.entity_id) {
    return NextResponse.json({ ok: false, error: "entity_id is required." }, { status: 400 });
  }

  // 2. Verify run ownership and status
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

  if (run["status"] !== "awaiting_selection") {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${run["status"]}" — entity selection only applies to "awaiting_selection" runs.`,
      },
      { status: 409 },
    );
  }

  // 3. Verify the entity belongs to this run
  const { data: entity, error: entityError } = await supabase
    .from("trrc_resolved_entities")
    .select("id, run_id")
    .eq("id", body.entity_id)
    .eq("run_id", runId)
    .single();

  if (entityError || !entity) {
    return NextResponse.json(
      { ok: false, error: "Entity not found or does not belong to this run." },
      { status: 404 },
    );
  }

  // 4. Mark entity as user-selected
  const { error: entityUpdateError } = await supabase
    .from("trrc_resolved_entities")
    .update({ is_user_selected: true })
    .eq("id", body.entity_id)
    .eq("run_id", runId);

  if (entityUpdateError) {
    console.error("[resolve] entity update error:", entityUpdateError);
    return NextResponse.json(
      { ok: false, error: "Failed to mark entity as selected." },
      { status: 500 },
    );
  }

  // 5. Reset run status to "pending" so the caller can POST to /execute next.
  //    (execute only accepts "pending"; setting "retrieving" here would deadlock.)
  const { error: runUpdateError } = await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status: "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (runUpdateError) {
    console.error("[resolve] run update error:", runUpdateError);
    return NextResponse.json(
      { ok: false, error: "Entity selected but failed to update run status." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: { run_id: runId, status: "pending" },
  });
}
