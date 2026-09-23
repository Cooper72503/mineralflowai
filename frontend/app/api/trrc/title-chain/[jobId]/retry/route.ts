/**
 * POST /api/trrc/title-chain/[jobId]/retry — re-queue failed or review-paused retrieval
 * stage for the worker. Failed recovery remains bounded; a user may explicitly
 * resume a review-paused job after new evidence or retrieval improvements.
 * Already-resolved wells and already-stored documents are kept (the worker
 * skips them), so a retry resumes rather than restarts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 3;

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;

  const { data: job, error: lookupError } = await supabase.from("title_research_jobs").select("id, status, attempt_count, updated_at").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (lookupError) return NextResponse.json({ ok: false, error: "Could not load title research job." }, { status: 503 });
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });
  if (!["failed", "awaiting_tract_confirmation", "awaiting_documents"].includes(job.status)) return NextResponse.json({ ok: false, error: `Only failed or review-paused retrieval can be resumed (status is "${job.status}").` }, { status: 409 });
  if (job.status === "failed" && (job.attempt_count as number) >= MAX_ATTEMPTS) return NextResponse.json({ ok: false, error: `Retry limit reached (${MAX_ATTEMPTS} attempts). Add documents manually or contact support.` }, { status: 409 });

  const { data: queued, error } = await supabase.from("title_research_jobs").update({ status: "pending", error_summary: null, stage_detail: "Retrieval resumed by user; existing evidence preserved", progress_percent: 0 }).eq("id", jobId).eq("user_id", user.id).eq("status", job.status).eq("updated_at", job.updated_at).select("id").maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!queued) return NextResponse.json({ ok: false, error: "Job changed while resuming. Reload before retrying." }, { status: 409 });
  return NextResponse.json({ ok: true });
}
