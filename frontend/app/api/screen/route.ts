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
import { fetchBestTrrcProduction, normalizeApiNumber } from "@/lib/wells/trrc-production";
import type { WellLookupResult } from "@/lib/wells";
import { runDeclineCurveAnalysis } from "@/lib/decline/decline-curve";
import { computeMineralEconomics } from "@/lib/economics/mineral-economics";
import { computePaLiability } from "@/lib/risk/pa-liability";
import { identifyRiskFlags } from "@/lib/risk/risk-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Well lookup now includes parallel TRRC production fetches — allow up to 55 s
export const maxDuration = 55;

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
      /** Specific TRRC API number(s) for this property — overrides county well sampling */
      api_numbers?: string | string[];
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

    // Parse any explicit API numbers provided by the caller
    const rawApiInput = body.api_numbers;
    const explicitApis: string[] = (
      Array.isArray(rawApiInput)
        ? rawApiInput
        : typeof rawApiInput === "string"
          ? rawApiInput.split(/[\s,;]+/)
          : []
    )
      .map(a => normalizeApiNumber(a.trim()))
      .filter((a): a is string => a !== null);

    // ── Geocode + nearby well lookup (run in parallel with valuation pipeline) ──
    // When explicit API numbers are provided, fetch their production directly and
    // build a synthetic WellLookupResult so the rest of the pipeline is unchanged.
    const [geocodeResult, wellLookupResult] = await Promise.all([
      geocodeProperty({
        township: legalParsed.plss_township,
        range:    legalParsed.plss_range,
        section:  legalParsed.section,
        state,
      }).catch(() => null).then(result => result ?? geocodeFromCountyCentroid(county, state)),

      explicitApis.length > 0
        ? fetchBestTrrcProduction(explicitApis, 36).then((prod): WellLookupResult => {
            if (!prod) {
              return {
                source: "unavailable" as const,
                wells: [],
                query_description: `API ${explicitApis.join(", ")}`,
                note: "No production data found for the provided API number(s).",
              };
            }
            // Build a minimal WellSummary from the production result so the
            // downstream pipeline (nearby-wells, decline, economics) can use it.
            const latestRow = prod.rows[prod.rows.length - 1];
            return {
              source: "trrc" as const,
              wells: [{
                api:       prod.api_number,
                well_name: `Lease ${prod.lease_number ?? "unknown"} (District ${prod.district_code ?? "?"})`,
                operator:  null,
                county,
                state:     "Texas",
                status:    "PRODUCING",
                formation: null,
                spud_date: null,
                latest_monthly_oil_bbl:   latestRow?.oil_bbl ?? null,
                latest_monthly_gas_mcf:   latestRow?.gas_mcf ?? null,
                latest_monthly_water_bbl: null,
                latest_production_month:  latestRow
                  ? `${latestRow.year}-${String(latestRow.month).padStart(2, "0")}`
                  : null,
                cum_oil_bbl: prod.rows.reduce((s, r) => s + r.oil_bbl, 0),
                lat: null,
                lng: null,
              }],
              query_description: `API ${prod.api_number} (lease ${prod.lease_number})`,
              note: `Specific well data from TRRC: API ${prod.api_number}, lease ${prod.lease_number}, district ${prod.district_code}. ${prod.months_count} months of actual production.`,
            };
          }).catch((): WellLookupResult => ({
            source: "unavailable" as const,
            wells: [],
            query_description: `API ${explicitApis.join(", ")}`,
            note: "TRRC lookup failed for provided API numbers.",
          }))
        : (county && state)
          ? lookupWellsByLocation({ county, state }).catch((): WellLookupResult => ({
              source: "unavailable" as const,
              wells: [],
              query_description: `${county}, ${state}`,
              note: "Well lookup failed.",
            }))
          : Promise.resolve<WellLookupResult>({
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

    const royaltyDecimal = normalizeRoyaltyToDecimal(body.royalty_rate ?? null);

    // ── Run analysis engines BEFORE valuation ─────────────────────────────────
    // These are pure functions that only need well + user inputs — no valuation dep.
    // Their outputs feed directly into the holistic value estimate below.

    // 1. Decline curve — fits Arps exponential model to nearby well BOPD data
    const declineAnalysis = runDeclineCurveAnalysis(nearbyWellIntelligence.wells);

    // 2. Mineral economics — actual net royalty income after severance + ad valorem
    //    Run WITHOUT point_estimate here; implied_cap_rate will be patched below.
    const mineralEconomics = computeMineralEconomics({
      state,
      royalty_rate: royaltyDecimal,
      nearby_bopd: nearbyWellIntelligence.median_bopd ?? nearbyWellIntelligence.avg_bopd,
      acreage,
      point_estimate: null,
    });

    // 3. P&A liability — depth-based plugging cost exposure
    const paLiability = computePaLiability({
      wells: nearbyWellIntelligence.wells,
      state,
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
      nearbyWells:       nearbyWellIntelligence,
      declineAnalysis,
      mineralEconomics,
      paLiability,
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

    // Patch implied_cap_rate now that we have the final point_estimate
    if (mineralEconomics.annual_net_royalty != null && valuation.point_estimate != null && valuation.point_estimate > 0) {
      mineralEconomics.implied_cap_rate = Math.round(
        (mineralEconomics.annual_net_royalty / valuation.point_estimate) * 1000
      ) / 10;
    }

    // Build production snapshot anchored to real BOPD
    const productionSnapshot = buildProductionSnapshot({
      dealType: producingStatus === "no" ? "undeveloped" : valuation.deal_type,
      activityLevel: valuation.activity_level,
      acreage,
      royalty_rate: royaltyDecimal,
      county,
      state,
      nearbyWells: nearbyWellIntelligence,
    });

    // Risk flags — run after valuation (needs activity_level from valuation output)
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
