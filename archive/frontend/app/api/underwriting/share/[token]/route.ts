/**
 * /api/underwriting/share/[token]
 *
 * GET — public read-only access to a shared underwriting report.
 * No auth required. Only returns report_json when share_enabled = true.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("underwriting_reports")
    .select("id, report_id, lease_name, operator_name, county, state, deal_stage, report_json, created_at, share_enabled")
    .eq("share_token", params.token)
    .eq("share_enabled", true)
    .single();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: "Report not found or sharing disabled." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, report: data.report_json, meta: {
    id: data.id,
    lease_name: data.lease_name,
    operator_name: data.operator_name,
    county: data.county,
    state: data.state,
    deal_stage: data.deal_stage,
    created_at: data.created_at,
  }});
}
