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
import { lookupParcel } from "@/lib/parcels";
import { generateDealBrief } from "@/lib/intelligence/deal-brief";

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

    // Parcel lookup — if a parcel ID was parsed and we know the state, fetch acreage + owner
    let parcelData = null;
    if (legalParsed.parcel_id) {
      parcelData = await lookupParcel({
        parcel_id: legalParsed.parcel_id,
        state: state,
        county,
      });
      // Auto-fill acreage from parcel if not already provided
      if (acreage == null && parcelData?.acreage != null) {
        acreage = parcelData.acreage;
      }
      // Auto-fill county from parcel if not already resolved
    }

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

    const producingStatus = body.producing ?? "unknown";

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
      producingStatusOverride: producingStatus,
    });

    // Surface the producing override in confidence reasoning for transparency
    if (producingStatus === "yes") {
      if (valuation.confidence_reasoning) {
        if (!valuation.confidence_reasoning.present_signals) valuation.confidence_reasoning.present_signals = [];
        valuation.confidence_reasoning.present_signals.unshift("User confirmed: currently producing");
      }
    } else if (producingStatus === "no") {
      if (!valuation.risks) valuation.risks = [];
      const alreadyTagged = valuation.risks.some((r: string) => /not currently producing/i.test(r));
      if (!alreadyTagged) {
        valuation.risks.unshift("User confirmed: not currently producing — estimate reflects development potential, not current income.");
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

    const dealBrief = await generateDealBrief({
      county,
      state,
      acreage,
      royalty_rate: body.royalty_rate ?? null,
      producing_status: producingStatus,
      valuation,
      production_snapshot: productionSnapshot,
      location_context: locationContext,
    });

    return NextResponse.json({
      ok: true,
      county,
      state,
      acreage,
      royalty_rate: body.royalty_rate ?? null,
      legal_description_parsed: legalParsed,
      location_context: locationContext,
      valuation,
      production_snapshot: productionSnapshot,
      producing_status: producingStatus,
      parcel_data: parcelData ?? undefined,
      deal_brief: dealBrief,
      _debug: {
        producing_received: producingStatus,
        deal_type_resolved: valuation.deal_type,
        activity_level: valuation.activity_level,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
