/**
 * POST /api/trrc/due-diligence/[runId]/execute
 *
 * Thin trigger route — validates the run, marks it as "retrieving", then
 * fires-and-forgets a call to the Supabase Edge Function trrc-dd-execute
 * which runs the Fable-5 agent loop without any Vercel timeout constraint.
 *
 * Returns HTTP 202 immediately. The frontend polls /api/trrc/due-diligence/[runId]
 * for status updates as the Edge Function runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Status guard ──────────────────────────────────────────────────────────────

const TERMINAL_OR_RUNNING = [
  "complete",
  "failed",
  "cancelled",
  "analyzing",
  "generating",
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
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  if (runStatus !== "retrieving" && runStatus !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  // 3. Mark run as retrieving with initial progress
  await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status: "retrieving",
      progress_percent: 5,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  // 4. Fire-and-forget: invoke Edge Function (no await)
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Don't await — fire and forget so we return immediately
  supabaseAdmin.functions
    .invoke("trrc-dd-execute", { body: { run_id: runId } })
    .catch((err: unknown) =>
      console.error("[execute] edge function invoke error:", err),
    );

  return NextResponse.json({ ok: true, status: "retrieving" });
}
