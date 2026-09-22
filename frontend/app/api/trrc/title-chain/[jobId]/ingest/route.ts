/**
 * POST /api/trrc/title-chain/[jobId]/ingest — process pending documents
 * (text extraction / OCR, validated instrument extraction, persistence).
 * Bounded per call (default 3 documents) and resumable: the response
 * reports `remaining`, and the UI calls again until it is zero.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { ingestPendingDocuments } from "@/lib/trrc/title/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 280;

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;

  const { data: job, error: jobError } = await supabase.from("title_research_jobs").select("id, status").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (jobError) return NextResponse.json({ ok: false, error: "Title job could not be loaded. Retry the request." }, { status: 503 });
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });
  if (["pending", "resolving_wells", "searching_records", "ingesting", "cancelled"].includes(job.status as string)) {
    return NextResponse.json({ ok: false, error: `Documents cannot be processed while the job is "${job.status}".` }, { status: 409 });
  }

  let limit = 3;
  try { const b = await request.json(); if (typeof b?.limit === "number") limit = b.limit; } catch { /* no body */ }

  const { data: claimed, error: claimError } = await supabase.from("title_research_jobs")
    .update({ status: "ingesting", stage_detail: "Processing documents", updated_at: new Date().toISOString() })
    .eq("id", jobId).eq("user_id", user.id).eq("status", job.status).select("id").maybeSingle();
  if (claimError) return NextResponse.json({ ok: false, error: "Could not start document ingestion." }, { status: 503 });
  if (!claimed) return NextResponse.json({ ok: false, error: "Title job changed; refresh before processing documents." }, { status: 409 });
  try {
    const result = await ingestPendingDocuments(supabase, user.id, jobId, { limit });
    const { error: finishError } = await supabase.from("title_research_jobs").update({
      status: "awaiting_documents",
      stage_detail: result.errors.length > 0 ? `${result.errors.length} document(s) failed extraction; review required` : result.remaining > 0 ? "More documents remain to process" : "Documents processed — run the analysis",
      updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("user_id", user.id).eq("status", "ingesting");
    if (finishError) throw new Error("Could not persist ingestion completion status");
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    console.error("Title ingestion failed", error);
    await supabase.from("title_research_jobs").update({
      status: "awaiting_documents", stage_detail: "Document processing failed — inspect extraction errors before retrying", updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("user_id", user.id).eq("status", "ingesting");
    return NextResponse.json({ ok: false, error: "Document ingestion failed. No successful completion is asserted; inspect the document statuses before retrying." }, { status: 503 });
  }
}
