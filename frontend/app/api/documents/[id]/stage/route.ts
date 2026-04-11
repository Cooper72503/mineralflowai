import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STAGES = new Set([
  "new_lead",
  "screening",
  "pursuing",
  "under_loi",
  "due_diligence",
  "closed_won",
  "closed_lost",
  "passed",
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const documentId = params.id;
  if (!documentId) {
    return NextResponse.json({ ok: false, error: "Document ID required." }, { status: 400 });
  }

  let body: { stage?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const stage = body.stage;
  if (typeof stage !== "string" || !VALID_STAGES.has(stage)) {
    return NextResponse.json(
      { ok: false, error: `Invalid stage. Must be one of: ${[...VALID_STAGES].join(", ")}` },
      { status: 400 }
    );
  }

  const { error: updateError } = await supabase
    .from("documents")
    .update({ deal_stage: stage })
    .eq("id", documentId)
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[stage] update error", updateError);
    return NextResponse.json({ ok: false, error: "Failed to update stage." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stage });
}
