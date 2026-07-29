/**
 * POST /api/trrc/due-diligence/[runId]/execute
 *
 * Validates the run and re-confirms status "pending" so the DigitalOcean
 * worker's own background poller (which independently claims any pending
 * run every few seconds regardless of this call) picks it up sooner than
 * waiting for its next poll cycle. Not the thing that actually starts the
 * agent loop — that's entirely the worker's job.
 *
 * Since the worker polls unconditionally, this call can lose the race to
 * the worker's own poller claiming the row first (real, observed on the
 * local dev environment sharing the same Supabase project as the
 * production worker) — a 409 here means "already started elsewhere," not
 * a failure, and the frontend treats it that way.
 *
 * The frontend polls /api/trrc/due-diligence/[runId] for status updates as
 * the worker runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Status guard ──────────────────────────────────────────────────────────────

const TERMINAL_OR_RUNNING = [
  "complete",
  "failed",
  "cancelled",
  "analyzing",
  "generating",
  "retrieving",
  "awaiting_selection",
];

// ─── POST ──────────────────────────────────────────────────────────────────────

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
    .select("id, status")
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

  if (TERMINAL_OR_RUNNING.includes(runStatus)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  if (runStatus !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  // 3. Mark as pending — the DigitalOcean worker polls for pending runs and claims them
  await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status:           "pending",
      progress_percent: 2,
      updated_at:       new Date().toISOString(),
    })
    .eq("id", runId);

  return NextResponse.json({ ok: true, status: "pending" });
}
