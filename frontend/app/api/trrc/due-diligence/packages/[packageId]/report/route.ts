/**
 * /api/trrc/due-diligence/packages/[packageId]/report
 *
 * GET: the Decision Record PDF under each lease's starting assumptions.
 *   ?format=engine returns the deal model with each lease's starting
 *   assumptions and their basis, for the page's live recalculation;
 *   ?format=json the deal model; ?format=summary the on-screen decision;
 *   ?format=acquisition the earlier acquisition report
 *   (with optional ?oil=USD/bbl&gas=USD/mcf&loe=USD/BOE overrides).
 * POST { assumptions: { [leaseKey]: { field: value } } }: the Decision
 *   Record under the user's assumptions, validated field by field.
 * 409 while retrieval or title research is running.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { loadDeal, summarizeDeal } from "@/lib/trrc/deal/build";
import { renderDealPdf } from "@/lib/trrc/deal/pdf";
import { applyAssumptionEdits, assembleDecision } from "@/lib/trrc/deal/decision-layer";
import { renderDecisionRecordPdf } from "@/lib/trrc/deal/decision-record-pdf";
import type { Deal } from "@/lib/trrc/deal/build";

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
    if (q.get("format") === "engine") {
      const { byLease } = applyAssumptionEdits(load.deal, {});
      const starting = Object.fromEntries(Object.entries(byLease).map(([k, v]) => [k, { assumptions: v.assumptions, basis: v.basis }]));
      return NextResponse.json({ ok: true, deal: load.deal, starting }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (q.get("format") === "acquisition") return pdfResponse(await renderDealPdf(load.deal), load.deal, "Acquisition-Report");
    return decisionRecord(load.deal, {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[deal report]", packageId, e);
    const status = /not found/i.test(message) ? 404 : 503;
    return NextResponse.json({ ok: false, error: status === 404 ? "Package not found." : `The acquisition report could not be built: ${message}` }, { status });
  }
}

const Body = z.object({ assumptions: z.record(z.string(), z.record(z.string(), z.unknown())).default({}) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ packageId: string }> }) {
  const db = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { packageId } = await params;
  if (!z.string().uuid().safeParse(packageId).success) return NextResponse.json({ ok: false, error: "Invalid package ID." }, { status: 400 });
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "Send { assumptions: { [leaseKey]: { field: value } } }." }, { status: 400 });
  try {
    const load = await loadDeal(db, user.id, packageId);
    if (!load.ready) return NextResponse.json({ ok: false, ready: false, error: load.reason, progress: load.progress }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    return decisionRecord(load.deal, body.data.assumptions);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[decision record]", packageId, e);
    const status = /not found/i.test(message) ? 404 : 503;
    return NextResponse.json({ ok: false, error: status === 404 ? "Package not found." : `The Decision Record could not be built: ${message}` }, { status });
  }
}

async function decisionRecord(deal: Deal, edits: Record<string, Record<string, unknown>>) {
  const { errors, byLease } = applyAssumptionEdits(deal, edits);
  if (errors.length) return NextResponse.json({ ok: false, error: errors.join(" "), errors }, { status: 400 });
  const record = assembleDecision(deal, Object.fromEntries(Object.entries(byLease).map(([k, v]) => [k, v.assumptions])));
  const pdf = await renderDecisionRecordPdf({
    deal, record,
    basisByLease: Object.fromEntries(Object.entries(byLease).map(([k, v]) => [k, v.basis])),
    editedByLease: Object.fromEntries(Object.entries(byLease).map(([k, v]) => [k, v.edited])),
  });
  return pdfResponse(pdf, deal, "Decision-Record");
}

function pdfResponse(pdf: Buffer, deal: Deal, kind: string) {
  const name = (deal.leases[0]?.leaseName ?? "Package").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new NextResponse(new Uint8Array(pdf), { status: 200, headers: {
    "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="MineralFlow-${name}-${kind}-${deal.generatedAt.slice(0, 10)}.pdf"`,
  } });
}
