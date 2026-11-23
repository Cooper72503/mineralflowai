import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { reservoirById } from "@/lib/geology/reservoirs";
import { buildReservoirStudy } from "@/lib/geology/reservoir-study";
import { renderReservoirStudyPdf } from "@/lib/mineral-finder/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const db = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const r = reservoirById(params.id);
  if (!r) return NextResponse.json({ error: "No reservoir study is registered under this name." }, { status: 404 });
  const pdf = await renderReservoirStudyPdf(buildReservoirStudy(r));
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="MineralFlow-volumetric-study-${r.id}.pdf"`, "Cache-Control": "private, no-store" } });
}
