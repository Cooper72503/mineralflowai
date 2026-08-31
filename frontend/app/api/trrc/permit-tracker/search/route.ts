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
  let result;
  try {
    result = await searchNewDrillPermits({ counties: body.counties, since, until });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Permit search failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  // 4. Enrich with operator contact info from TRRC's public P-5 Oil & Gas
  // Directory (operator_directory — see migration 025 for provenance).
  // Looked up here, not scraped live per operator: the live P-5 query is
  // session-based and would multiply request count by every distinct
  // operator in the result set.
  const operatorNumbers = Array.from(
    new Set(result.rows.map((r) => r.operatorNumber).filter((n): n is string => !!n))
  );
  const phonesByOperator = new Map<string, { phone: string | null; emergencyPhone: string | null }>();
  if (operatorNumbers.length > 0) {
    const { data: directoryRows } = await supabase
      .from("operator_directory")
      .select("org_number, phone, emergency_phone")
      .in("org_number", operatorNumbers);
    for (const row of directoryRows ?? []) {
      phonesByOperator.set(row.org_number, { phone: row.phone, emergencyPhone: row.emergency_phone });
    }
  }

  const enrichedRows = result.rows.map((r) => ({
    ...r,
    operatorPhone: r.operatorNumber ? phonesByOperator.get(r.operatorNumber)?.phone ?? null : null,
    operatorEmergencyPhone: r.operatorNumber ? phonesByOperator.get(r.operatorNumber)?.emergencyPhone ?? null : null,
  }));

  return NextResponse.json({ ok: true, data: { ...result, rows: enrichedRows } });
}
