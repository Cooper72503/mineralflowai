import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { renderFinderReport } from "@/lib/mineral-finder/report";
import type { FinderResult } from "@/lib/mineral-finder/types";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
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
  const r = await db
    .from("mineral_finder_jobs")
    .select("status,result_json")
    .eq("id", params.runId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (r.error)
    return NextResponse.json(
      { error: "Research unavailable" },
      { status: 503 },
    );
  if (!r.data)
    return NextResponse.json({ error: "Research not found" }, { status: 404 });
  if (r.data.status !== "complete" || !r.data.result_json)
    return NextResponse.json(
      { error: "Research has not completed" },
      { status: 409 },
    );
  const result = r.data.result_json as FinderResult;
  const api = request.nextUrl.searchParams.get("api") ?? undefined;
  if (api && !result.prospects.some((p) => p.api === api))
    return NextResponse.json(
      { error: "Prospect not found in this run" },
      { status: 404 },
    );
  try {
    const buffer = await renderFinderReport(result, api);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="MineralFinder-${result.criteria.county}${api ? `-${api}` : ""}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    console.error("[finder report]", e);
    return NextResponse.json(
      { error: "Prospect report could not be generated" },
      { status: 503 },
    );
  }
}
