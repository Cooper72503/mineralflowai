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

  const { data: job } = await supabase.from("title_research_jobs").select("id, status").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });
  if (["pending", "resolving_wells", "searching_records", "cancelled"].includes(job.status as string)) {
    return NextResponse.json({ ok: false, error: `Documents cannot be processed while the job is "${job.status}".` }, { status: 409 });
  }

  let limit = 3;
  try { const b = await request.json(); if (typeof b?.limit === "number") limit = b.limit; } catch { /* no body */ }

  await supabase.from("title_research_jobs").update({ status: "ingesting", stage_detail: "Processing documents" }).eq("id", jobId);
  const result = await ingestPendingDocuments(supabase, user.id, jobId, { limit });
  await supabase.from("title_research_jobs").update({
    status: "awaiting_documents",
    stage_detail: result.remaining > 0 ? `${result.remaining} document(s) still to process` : "Documents processed — run the analysis",
  }).eq("id", jobId);

  return NextResponse.json({ ok: true, data: result });
}
