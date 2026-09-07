/**
 * POST /api/trrc/title-chain/[jobId]/documents — upload an instrument
 * (PDF / image / text file, multipart "file") or paste record text (JSON
 * { pastedText, label?, documentCategory?, wellId? }). Stored by content
 * hash: the same bytes twice are one document. This is the working upload
 * path used whenever automated county access is unavailable.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { storeUserDocument } from "@/lib/trrc/title/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 40 * 1024 * 1024;
const CATEGORIES = new Set(["w1_application", "location_plat", "completion_report", "lease", "unit_agreement", "deed", "other", "unknown"]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;

  const { data: job } = await supabase.from("title_research_jobs").select("id, status").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });
  if (["cancelled"].includes(job.status as string)) return NextResponse.json({ ok: false, error: "Job is cancelled." }, { status: 409 });

  const contentType = request.headers.get("content-type") ?? "";
  let stored: Awaited<ReturnType<typeof storeUserDocument>>;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: `File too large (${(file.size / 1_048_576).toFixed(1)}MB; ${MAX_BYTES / 1_048_576}MB maximum).` }, { status: 400 });
    const category = String(form.get("documentCategory") ?? "unknown");
    const wellId = form.get("wellId");
    stored = await storeUserDocument(supabase, user.id, jobId, {
      bytes: Buffer.from(await file.arrayBuffer()), pastedText: null, fileName: file.name, mimeType: file.type || null,
      documentCategory: CATEGORIES.has(category) ? category : "unknown", wellId: typeof wellId === "string" && wellId ? wellId : null, label: null,
    });
  } else {
    let body: { pastedText?: unknown; label?: unknown; documentCategory?: unknown; wellId?: unknown };
    try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Send multipart/form-data with a file, or JSON with pastedText." }, { status: 400 }); }
    const text = typeof body.pastedText === "string" ? body.pastedText.trim() : "";
    if (!text) return NextResponse.json({ ok: false, error: "pastedText is required." }, { status: 400 });
    if (text.length > 2_000_000) return NextResponse.json({ ok: false, error: "Pasted text is too long." }, { status: 400 });
    const category = typeof body.documentCategory === "string" ? body.documentCategory : "unknown";
    stored = await storeUserDocument(supabase, user.id, jobId, {
      bytes: null, pastedText: text, fileName: null, mimeType: "text/plain", documentCategory: CATEGORIES.has(category) ? category : "unknown",
      wellId: typeof body.wellId === "string" && body.wellId ? body.wellId : null, label: typeof body.label === "string" ? body.label.slice(0, 120) : null,
    });
  }

  if (!stored.ok) return NextResponse.json({ ok: false, error: stored.error }, { status: 400 });
  if (["awaiting_documents", "complete", "awaiting_tract_confirmation"].includes(job.status as string)) {
    await supabase.from("title_research_jobs").update({ stage_detail: "Documents added — process documents, then run the analysis" }).eq("id", jobId);
  }
  return NextResponse.json({ ok: true, data: { documentId: stored.documentId, duplicate: stored.duplicate } });
}
