/**
 * /api/underwriting/reports
 *
 * GET  — list all saved underwriting reports for the authenticated user
 * POST — save a new underwriting report
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import type { DDReport } from "@/lib/underwriting/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── GET: list saved reports ──────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("underwriting_reports")
    .select(`
      id, report_id, lease_name, operator_name, county, state, api_numbers,
      rrc_lease_number, recommendation, current_rate_bbl, twelve_month_avg_bbl,
      npv10_usd, offer_range_low, offer_range_high, offer_range_mid, risk_score,
      data_completeness_score, overall_confidence, scan_mode, deal_stage,
      share_token, share_enabled, notes, created_at, updated_at
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[underwriting/reports GET]", error);
    return NextResponse.json({ ok: false, error: "Failed to fetch reports." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reports: data });
}

// ─── POST: save a report ──────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { report?: DDReport };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const report = body.report;
  if (!report?.report_id) {
    return NextResponse.json({ ok: false, error: "report is required." }, { status: 400 });
  }

  const ex = report.executive_summary;
  const sub = report.subject;

  const { data, error } = await supabase
    .from("underwriting_reports")
    .upsert({
      user_id:                 user.id,
      report_id:               report.report_id,
      lease_name:              sub.lease_name ?? null,
      operator_name:           sub.operator_name ?? null,
      county:                  sub.county ?? null,
      state:                   sub.state ?? null,
      api_numbers:             sub.api_numbers,
      rrc_lease_number:        sub.rrc_lease_number ?? null,
      recommendation:          ex.recommendation.value ?? null,
      current_rate_bbl:        ex.current_gross_rate_bbl.value ?? null,
      twelve_month_avg_bbl:    ex.twelve_month_avg_bbl.value ?? null,
      npv10_usd:               ex.npv10_usd.value ?? null,
      offer_range_low:         ex.offer_range_low.value ?? null,
      offer_range_high:        ex.offer_range_high.value ?? null,
      offer_range_mid:         report.acquisition_economics?.offer_range_mid?.value ?? null,
      risk_score:              ex.overall_risk_score.value ?? null,
      data_completeness_score: ex.data_completeness_score,
      overall_confidence:      report.overall_confidence,
      scan_mode:               report.scan_mode,
      report_json:             report as unknown as Record<string, unknown>,
    }, {
      onConflict: "user_id,report_id",
    })
    .select("id, share_token")
    .single();

  if (error) {
    console.error("[underwriting/reports POST]", error);
    return NextResponse.json({ ok: false, error: "Failed to save report." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id, share_token: data.share_token });
}
