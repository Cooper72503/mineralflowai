/**
 * GET /api/trrc/well-map/well?api=42-165-02084
 *
 * What the well map shows for a clicked well: its lease, operator and field
 * from TRRC's wellbore query, and the lease's monthly production from 1993
 * on. Both are TRRC web queries the browser cannot make itself (session
 * cookies, no cross-origin access), so they run here, live, per click.
 *
 * Oil is reported to TRRC by lease, not by well: the history is the lease's,
 * and the response says so. A gas well is its own gas lease.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { resolveWellboreToLease, fetchAnalogProduction } from "@/lib/trrc/offset-analytics/production-loader";
import { api8From } from "@/lib/trrc/well-map/gis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const db = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

  const api8 = api8From(request.nextUrl.searchParams.get("api") ?? "");
  if (!api8) return NextResponse.json({ ok: false, error: "Give a Texas API number, e.g. 42-165-02084." }, { status: 400 });

  try {
    const lease = await resolveWellboreToLease(api8);
    if (!lease) return NextResponse.json({ ok: true, data: { api8, lease: null, production: null, note: "TRRC's wellbore query has no lease for this API. It may be a permitted location that was never drilled, or a well TRRC's online query does not carry." } }, { headers: { "Cache-Control": "private, max-age=600" } });
    const production = await fetchAnalogProduction(lease.leaseNumber, lease.district, undefined, { startYear: 1993 });
    return NextResponse.json({ ok: true, data: {
      api8, lease,
      production: {
        found: production.found,
        leaseType: production.rows.some(r => r.gasMcf !== null || r.condensateBbl !== null) ? "gas" : "oil",
        rows: production.rows,
        warnings: production.warnings.filter(w => w.severity !== "info").map(w => w.message),
      },
      note: "Production is TRRC's monthly report for the lease. Oil leases report all of their wells together; a gas well is reported on its own.",
    } }, { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    console.error("[well-map]", api8, e);
    return NextResponse.json({ ok: false, error: "TRRC did not respond in time. Click the well again in a moment." }, { status: 502 });
  }
}
