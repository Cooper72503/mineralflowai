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
import { geocodeProperty } from "@/lib/location/property-geocode";
import { geocodeFromCountyCentroid } from "@/lib/location/county-geocode";
import { lookupWellsByLocation } from "@/lib/wells";
import { buildNearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import { runDeclineCurveAnalysis } from "@/lib/decline/decline-curve";
import { computeMineralEconomics } from "@/lib/economics/mineral-economics";
import { computePaLiability } from "@/lib/risk/pa-liability";
import { identifyRiskFlags } from "@/lib/risk/risk-flags";

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

    // Resolve county + state: prefer explicit inputs, fall back to inference
    const inferred = inferCountyAndStateFromTexts(legalDescription);
    const county = (body.county ?? "").trim() || inferred.county || null;
    const state = (body.state ?? "").trim() || inferred.state || inferStateFromCounty(county) || null;

    // Resolve acreage
    let acreage: number | null = null;
    if (body.acreage != null) {
      const n = typeof body.acreage === "number" ? body.acreage : parseFloat(String(body.acreage).replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) acreage = n;
    }
    if (acreage == null) {
      acreage = extractAcreageFromTexts(legalDescription);
    }

    const legalParsed = parseLegalDescription(legalDescription);

    // Parcel lookup (Ohio — fetches acreage + owner when parcel ID is parsed)
    let parcelData = null;
    if (legalParsed.parcel_id) {
      parcelData = await lookupParcel({
        parcel_id: legalParsed.parcel_id,
        state: state,
        county,
      });
      if (acreage == null && parcelData?.acreage != null) {
        acreage = parcelData.acreage;
      }
    }

    // ── Geocode + nearby well lookup (run in parallel with valuation pipeline) ──
    const [geocodeResult, wellLookupResult] = await Promise.all([
      geocodeProperty({
        township: legalParsed.plss_township,
        range:    legalParsed.plss_range,
        section:  legalParsed.section,
        state,
      }).catch(() => null).then(result => result ?? geocodeFromCountyCentroid(county, state)),
      (county && state)
        ? lookupWellsByLocation({ county, state }).catch(() => ({
            source: "unavailable" as const,
            wells: [],
            query_description: `${county}, ${state}`,
            note: "Well lookup failed.",
          }))
        : Promise.resolve({
            source: "unavailable" as const,
            wells: [],
            query_description: "Unknown location",
            note: "County and state required for well lookup.",
          }),
    ]);

    const nearbyWellIntelligence = buildNearbyWellIntelligence({
      geocode: geocodeResult,
      wellLookupResult,
      radiusMiles: 3,
    });

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
      nearbyWells: nearbyWellIntelligence,
    });

    // Lift nearby-well signals into valuation confidence reasoning
    if (nearbyWellIntelligence.total_count > 0) {
      if (valuation.confidence_reasoning) {
        if (!valuation.confidence_reasoning.present_signals) valuation.confidence_reasoning.present_signals = [];
        valuation.confidence_reasoning.present_signals.push(
          `${nearbyWellIntelligence.total_count} nearby well${nearbyWellIntelligence.total_count !== 1 ? "s" : ""} found` +
          (nearbyWellIntelligence.geocode_source !== "none"
            ? ` within ${nearbyWellIntelligence.radius_miles} miles`
            : " in county") +
          (nearbyWellIntelligence.median_bopd != null
            ? ` (median ${nearbyWellIntelligence.median_bopd} BOPD)`
            : "")
        );
      }
    } else if (nearbyWellIntelligence.data_source && nearbyWellIntelligence.total_count === 0) {
      if (valuation.confidence_reasoning) {
        if (!valuation.confidence_reasoning.missing_signals) valuation.confidence_reasoning.missing_signals = [];
        valuation.confidence_reasoning.missing_signals.push("No nearby wells found in county database");
      }
    }

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

    // Build production snapshot — pass nearby well data so it can anchor estimates
    // to real production rather than only static basin benchmarks.
    const productionSnapshot = buildProductionSnapshot({
      dealType: producingStatus === "no" ? "undeveloped" : valuation.deal_type,
      activityLevel: valuation.activity_level,
      acreage,
      royalty_rate: royaltyDecimal,
      county,
      state,
      nearbyWells: nearbyWellIntelligence,
    });

    // ── New underwriting engines ───────────────────────────────────────────────
    // Decline curve analysis from nearby well BOPD data
    const declineAnalysis = runDeclineCurveAnalysis(nearbyWellIntelligence.wells);

    // Mineral economics: net royalty income after severance + ad valorem
    const mineralEconomics = computeMineralEconomics({
      state,
      royalty_rate: royaltyDecimal,
      nearby_bopd: nearbyWellIntelligence.median_bopd ?? nearbyWellIntelligence.avg_bopd,
      acreage,
      point_estimate: valuation.point_estimate,
    });

    // P&A liability assessment from well statuses
    const paLiability = computePaLiability({
      wells: nearbyWellIntelligence.wells,
      state,
    });

    // Risk flags — aggregates all signal sources
    const riskFlags = identifyRiskFlags({
      nearby: nearbyWellIntelligence,
      decline: declineAnalysis,
      pa: paLiability,
      input: {
        county,
        state,
        legal_description: body.legal_description,
        legal_description_parsed: legalParsed,
        acreage,
        royalty_rate: royaltyDecimal,
      },
      activity: valuation.activity_level,
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
      nearby_well_intelligence: nearbyWellIntelligence,
      decline_analysis: declineAnalysis,
      mineral_economics: mineralEconomics,
      pa_liability: paLiability,
      risk_flags: riskFlags,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
