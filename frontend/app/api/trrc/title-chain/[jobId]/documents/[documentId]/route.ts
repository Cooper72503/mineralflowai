/**
 * GET /api/trrc/title-chain/[jobId]/documents/[documentId] — a short-lived
 * signed URL for the original document (or the stored text for pasted
 * records). RLS on title_documents and the bucket's owner-folder policy
 * both scope this to the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { TITLE_DOCUMENTS_BUCKET } from "@/lib/trrc/title/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string; documentId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId, documentId } = await params;

  const { data: doc } = await supabase.from("title_documents").select("id, storage_path, extracted_text, file_name, mime_type, extraction_json:extraction_status").eq("id", documentId).eq("job_id", jobId).eq("user_id", user.id).maybeSingle();
  if (!doc) return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });

  if (!doc.storage_path) {
    return NextResponse.json({ ok: true, data: { kind: "text", fileName: doc.file_name, text: doc.extracted_text ?? "" } });
  }
  const { data: signed, error } = await supabase.storage.from(TITLE_DOCUMENTS_BUCKET).createSignedUrl(doc.storage_path, 600);
  if (error || !signed) return NextResponse.json({ ok: false, error: `Could not sign URL: ${error?.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, data: { kind: "file", fileName: doc.file_name, mimeType: doc.mime_type, url: signed.signedUrl, expiresInSeconds: 600 } });
}
