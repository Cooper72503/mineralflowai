/**
 * POST /api/trrc/title-chain/[jobId]/analyze — run the deterministic
 * chain analysis and persist a new version (or return the existing one
 * when nothing changed). Before running, instrument tracts that were not
 * linked at ingestion (e.g. county-index rows written by the worker) are
 * matched against the now-confirmed tracts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { runTitleChainAnalysis } from "@/lib/trrc/title/analysis";
import { linkUnmatchedClaims } from "@/lib/trrc/title/link-claims";
import { buildTitleChainReport } from "@/lib/trrc/title/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;

  const { data: job } = await supabase.from("title_research_jobs").select("id, status").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });
  if (["pending", "resolving_wells", "searching_records", "ingesting", "cancelled"].includes(job.status as string)) {
    return NextResponse.json({ ok: false, error: `Analysis cannot run while the job is "${job.status}".` }, { status: 409 });
  }

  const priorStatus = job.status as string;
  await supabase.from("title_research_jobs").update({ status: "analyzing", stage_detail: "Reconstructing ownership" }).eq("id", jobId);
  await linkUnmatchedClaims(supabase, jobId);
  const result = await runTitleChainAnalysis(supabase, user.id, jobId);
  if (!result.ok) {
    await supabase.from("title_research_jobs").update({ status: priorStatus, stage_detail: `Analysis failed: ${result.error}` }).eq("id", jobId);
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, data: { reused: result.reused, report: buildTitleChainReport(result.analysis) } });
}
