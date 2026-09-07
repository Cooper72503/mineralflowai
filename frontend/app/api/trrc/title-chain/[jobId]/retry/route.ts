/**
 * POST /api/trrc/title-chain/[jobId]/retry — re-queue a failed retrieval
 * stage for the worker. Bounded: at most MAX_ATTEMPTS attempts per job.
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

  const { data: job } = await supabase.from("title_research_jobs").select("id, status, attempt_count").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });
  if (job.status !== "failed") return NextResponse.json({ ok: false, error: `Only failed jobs can be retried (status is "${job.status}").` }, { status: 409 });
  if ((job.attempt_count as number) >= MAX_ATTEMPTS) return NextResponse.json({ ok: false, error: `Retry limit reached (${MAX_ATTEMPTS} attempts). Add documents manually or contact support.` }, { status: 409 });

  const { error } = await supabase.from("title_research_jobs").update({ status: "pending", error_summary: null, stage_detail: "Re-queued", progress_percent: 0 }).eq("id", jobId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
