/**
 * POST /api/trrc/due-diligence/[runId]/cancel
 *
 * Cancel an in-progress or pending run.
 * Sets status to "cancelled" and records the completed_at timestamp.
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

  // Idempotent — already cancelled or complete is fine
  if (run["status"] === "cancelled") {
    return NextResponse.json({ ok: true });
  }

  if (run["status"] === "complete") {
    return NextResponse.json(
      { ok: false, error: "Run has already completed and cannot be cancelled." },
      { status: 409 },
    );
  }

  // 3. Set status to cancelled
  const { error: updateError } = await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (updateError) {
    console.error("[cancel] run update error:", updateError);
    return NextResponse.json(
      { ok: false, error: "Failed to cancel run." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
