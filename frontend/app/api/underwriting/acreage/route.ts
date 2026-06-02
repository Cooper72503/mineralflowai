/**
 * POST /api/underwriting/acreage
 *
 * Legal-description valuation & offset intelligence endpoint.
 * Accepts a legal description + optional metadata and returns a full
 * AcreageValuationReport.
 *
 * Server-side only — never exposes user data to third-party APIs.
 */

import { NextRequest, NextResponse } from "next/server";
import { runAcreageValuation } from "@/lib/underwriting/offset-intelligence-engine";
import type { AcreageInput } from "@/lib/underwriting/types-acreage";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const maxDuration = 60; // Vercel serverless limit (Pro plan)

export async function POST(req: NextRequest) {
  // Auth check
  const supabase = await createSupabaseFromRouteRequest(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<AcreageInput>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const legal_description = (body.legal_description ?? "").trim();
  if (!legal_description || legal_description.length < 5) {
    return NextResponse.json({ error: "legal_description is required (min 5 characters)" }, { status: 400 });
  }

  const input: AcreageInput = {
    legal_description,
    county:         body.county         ?? null,
    state:          body.state          ?? null,
    acreage:        body.acreage        ?? null,
    nri:            body.nri            ?? null,
    operator_hint:  body.operator_hint  ?? null,
    formation_hint: body.formation_hint ?? null,
    ask_price_usd:  body.ask_price_usd  ?? null,
  };

  try {
    const report = await runAcreageValuation(input);
    return NextResponse.json(report);
  } catch (err) {
    console.error("[acreage-valuation] error:", err);
    return NextResponse.json(
      { error: "Valuation engine error", detail: String(err) },
      { status: 500 },
    );
  }
}
