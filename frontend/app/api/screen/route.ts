import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { runPreUnderwritingValuation } from "@/lib/valuation";
import { buildLocationContext } from "@/lib/location/location-context";
import { buildFinancialSummary } from "@/lib/financial/financial-summary";
import { drillSnapshotFromDealInput } from "@/lib/scoring/drillDifficultyEngine";
import { calculateDealScore } from "@/lib/document-processing";
import { coerceDealScoreResult } from "@/lib/deals/dashboard-normalize";
import {
  inferCountyAndStateFromTexts,
  extractAcreageFromTexts,
  parseLegalDescription,
} from "@/lib/location/legal-description-parser";
import { buildProductionSnapshot } from "@/lib/production/production-snapshot";
import { normalizeRoyaltyToDecimal } from "@/lib/valuation/normalize";
import { inferStateFromCounty } from "@/lib/valuation/county-basin-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseFromRouteRequest(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      legal_description?: string;
      county?: string;
      state?: string;
      acreage?: number | string;
      royalty_rate?: string;
      document_type?: string;
      producing?: "yes" | "no" | "unknown";
    };

    const legalDescription = (body.legal_description ?? "").trim();
    if (!legalDescription) {
      return NextResponse.json({ ok: false, error: "legal_description is required." }, { status: 400 });
    }

    // Resolve county + state: prefer explicit inputs, fall back to inference from the legal description text
    const inferred = inferCountyAndStateFromTexts(legalDescription);
    const county = (body.county ?? "").trim() || inferred.county || null;
    // If state is still null, try to infer from county name (works when county is unambiguous in basin map)
    const state = (body.state ?? "").trim() || inferred.state || inferStateFromCounty(county) || null;

    // Resolve acreage: prefer explicit input, fall back to text extraction
    let acreage: number | null = null;
    if (body.acreage != null) {
      const n = typeof body.acreage === "number" ? body.acreage : parseFloat(String(body.acreage).replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) acreage = n;
    }
    if (acreage == null) {
      acreage = extractAcreageFromTexts(legalDescription);
    }

    const legalParsed = parseLegalDescription(legalDescription);

    // Build a minimal parsed / dealScoreInput — just enough for the valuation engine
    const parsed: Record<string, unknown> = {
      county,
      state,
      legal_description: legalDescription,
      acreage,
      royalty_rate: body.royalty_rate ?? null,
      document_type: body.document_type ?? "Legal Description",
      legal_description_parsed: legalParsed,
    };

    const dealScoreInput: Record<string, unknown> = {
      county,
      state,
      legal_description: legalDescription,
      acreage,
      royalty_rate: body.royalty_rate ?? null,
      document_type: body.document_type ?? "Legal Description",
    };

    const drillSnapshot = drillSnapshotFromDealInput(dealScoreInput);

    const locationContext = buildLocationContext({
      county,
      state,
      legal_description: legalDescription,
      extracted_text: legalDescription,
      combined_extraction_text: null,
      merged: dealScoreInput,
      development_signals: null,
    });

    const financialSummary = buildFinancialSummary({
      extractedText: legalDescription,
      combinedText: null,
      dealScoreInput,
      royaltyRateStr: body.royalty_rate ?? null,
      county,
    });

    const dealScoreCalculated = calculateDealScore(dealScoreInput);
    const dealScore = coerceDealScoreResult(dealScoreCalculated) ?? dealScoreCalculated;

    const valuation = runPreUnderwritingValuation({
      parsed,
      dealScoreInput,
      dealScore,
      financialSummary,
      locationContext,
      drillSnapshot,
      extractedText: legalDescription,
      raw_text: null,
      combinedExtractionText: null,
    });

    const producingStatus = body.producing ?? "unknown";

    // Apply user-supplied producing override — prevents false "likely producing" outputs
    if (producingStatus === "no") {
      // User says not currently producing — reframe deal type but preserve basin activity level
      // so the production snapshot can show nearby-comparable development potential
      if (valuation.deal_type === "producing") {
        valuation.deal_type = "undeveloped";
      }
      valuation.summary = valuation.summary
        ? `[User confirmed: not currently producing] ${valuation.summary.replace(/likely producing|likely a producing|appears to be producing/gi, "not producing")}`
        : "User confirmed this property is not currently producing.";
      if (!valuation.risks) valuation.risks = [];
      valuation.risks.unshift("User confirmed: not currently producing — production estimate based on nearby basin/county activity.");
      if (valuation.confidence_reasoning?.present_signals) {
        valuation.confidence_reasoning.present_signals = valuation.confidence_reasoning.present_signals
          .filter((s: string) => !/producing|production|revenue|bopd/i.test(s));
      }
    } else if (producingStatus === "yes") {
      // User confirms producing — note it explicitly
      if (valuation.confidence_reasoning) {
        if (!valuation.confidence_reasoning.present_signals) valuation.confidence_reasoning.present_signals = [];
        valuation.confidence_reasoning.present_signals.unshift("User confirmed: currently producing");
      }
    }

    const royaltyDecimal = normalizeRoyaltyToDecimal(body.royalty_rate ?? null);
    // Always build a production snapshot — when user says "no" we force deal_type to "undeveloped"
    // so the snapshot frames results as development potential based on nearby basin activity,
    // not as current production. The actual basin activity_level is preserved so benchmarks are accurate.
    const productionSnapshot = buildProductionSnapshot({
      dealType: producingStatus === "no" ? "undeveloped" : valuation.deal_type,
      activityLevel: valuation.activity_level,
      acreage,
      royalty_rate: royaltyDecimal,
      county,
      state,
    });

    return NextResponse.json({
      ok: true,
      county,
      state,
      acreage,
      legal_description_parsed: legalParsed,
      location_context: locationContext,
      valuation,
      production_snapshot: productionSnapshot,
      producing_status: producingStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
