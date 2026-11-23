import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } },
) {
  const db = await createSupabaseFromRouteRequest(request);
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user)
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(params.runId))
    return NextResponse.json(
      { error: "Invalid run identifier" },
      { status: 400 },
    );
  const r = await db
    .from("mineral_finder_jobs")
    .select(
      "id,status,stage,created_at,updated_at,request_json,result_json,error_summary",
    )
    .eq("id", params.runId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (r.error)
    return NextResponse.json(
      { error: "Research run unavailable" },
      { status: 503 },
    );
  if (!r.data)
    return NextResponse.json(
      { error: "Research run not found" },
      { status: 404 },
    );
  return NextResponse.json(
    { data: r.data },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
