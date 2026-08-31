/**
 * POST /api/trrc/permit-tracker/search
 *
 * Live search of the TRRC's public W-1 (drilling permit) search for New
 * Drill filings in one or more Texas counties over a date range. On-demand,
 * no persistence — every call hits webapps.rrc.state.tx.us directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { searchNewDrillPermits } from "@/lib/trrc/permit-tracker/fetch-permits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchBody {
  counties: string[];
  since: string; // ISO date
  until: string; // ISO date
}

export async function POST(request: NextRequest) {
  // 1. Auth
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  // 2. Parse + validate body
  let body: SearchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.counties) || body.counties.length === 0) {
    return NextResponse.json({ ok: false, error: "Select at least one county." }, { status: 400 });
  }
  if (body.counties.length > 20) {
    return NextResponse.json({ ok: false, error: "Select 20 counties or fewer per search." }, { status: 400 });
  }

  const since = new Date(body.since);
  const until = new Date(body.until);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    return NextResponse.json({ ok: false, error: "Invalid date range." }, { status: 400 });
  }

  // 3. Fetch — all outbound requests inside this call are hard-coded to
  // webapps.rrc.state.tx.us (see lib/trrc/permit-tracker/session.ts); no
  // user-controlled URL ever reaches fetch().
  try {
    const result = await searchNewDrillPermits({ counties: body.counties, since, until });
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Permit search failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
