import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("document_notes")
    .select("id, note, created_at")
    .eq("document_id", params.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: "Failed to load notes." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, notes: data ?? [] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const note = body.note;
  if (typeof note !== "string" || !note.trim()) {
    return NextResponse.json({ ok: false, error: "Note text is required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("document_notes")
    .insert({ document_id: params.id, user_id: user.id, note: note.trim() })
    .select("id, note, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: "Failed to save note." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, note: data });
}
