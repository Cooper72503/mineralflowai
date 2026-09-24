/**
 * GET /api/trrc/due-diligence/packages/[packageId]/report
 *
 * The acquisition report for one package: every submitted API grouped by
 * lease, owners of record, chain of title, values, offers and a verdict.
 * No inputs are required. Optional overrides: ?oil=USD/bbl&gas=USD/mcf&loe=USD/BOE.
 * ?format=json returns the deal model; ?format=summary the on-screen decision. 409 while retrieval or title research is running.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { loadDeal, summarizeDeal } from "@/lib/trrc/deal/build";
import { renderDealPdf } from "@/lib/trrc/deal/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const positive = (v: string | null) => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : undefined;
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ packageId: string }> }) {
  const db = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { packageId } = await params;
  if (!z.string().uuid().safeParse(packageId).success) return NextResponse.json({ ok: false, error: "Invalid package ID." }, { status: 400 });

  const q = request.nextUrl.searchParams;
  const overrides = { oilUsdBbl: positive(q.get("oil")), gasUsdMcf: positive(q.get("gas")), loeUsdPerBoe: positive(q.get("loe")) };
  if (Object.values(overrides).some(v => v === undefined)) return NextResponse.json({ ok: false, error: "Overrides must be positive numbers." }, { status: 400 });

  try {
    const load = await loadDeal(db, user.id, packageId, overrides as { oilUsdBbl: number | null; gasUsdMcf: number | null; loeUsdPerBoe: number | null });
    if (!load.ready) return NextResponse.json({ ok: false, ready: false, error: load.reason, progress: load.progress }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    if (q.get("format") === "json") return NextResponse.json({ ok: true, deal: load.deal }, { headers: { "Cache-Control": "private, no-store" } });
    if (q.get("format") === "summary") return NextResponse.json({ ok: true, summary: summarizeDeal(load.deal) }, { headers: { "Cache-Control": "private, no-store" } });
    const pdf = await renderDealPdf(load.deal);
    const name = (load.deal.leases[0]?.leaseName ?? "Package").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return new NextResponse(new Uint8Array(pdf), { status: 200, headers: {
      "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="MineralFlow-${name}-Acquisition-Report-${load.deal.generatedAt.slice(0, 10)}.pdf"`,
    } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[deal report]", packageId, e);
    const status = /not found/i.test(message) ? 404 : 503;
    return NextResponse.json({ ok: false, error: status === 404 ? "Package not found." : `The acquisition report could not be built: ${message}` }, { status });
  }
}
