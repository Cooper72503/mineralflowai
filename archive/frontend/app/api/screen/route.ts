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
import { fetchBestTrrcProduction, fetchTrrcProductionByLease, normalizeApiNumber } from "@/lib/wells/trrc-production";
import { lookupTrrcLeasesByApis } from "@/lib/wells/trrc-api";
import { lookupWellsByLegalDescription } from "@/lib/wells/trrc-abstract-lookup";
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
    // Priority order for Texas properties:
    //   1. Explicit API numbers (user-provided) — most precise
    //   2. Abstract/survey lookup via OTLS polygon + statewide wells spatial query
    //   3. County-wide well sampling (fallback, non-Texas or when no explicit/abstract route)
    //
    // IMPORTANT BUDGET NOTE: Vercel maxDuration = 55 s. For Texas:
    //   - County well lookup (lookupTrrcWells) can take 25–40 s (PDQ query + enrichment)
    //   - Abstract lookup typically takes 3–12 s
    //   - Tract production fetch (8 wells parallel) takes ~8–20 s
    //   - generateDealBrief (OpenAI) takes ~3–5 s
    //
    // Running county lookup + tract production + brief would exceed 55 s.
    // So for Texas, we skip county-level sampling when abstract lookup is attempted.
    // If abstract fails, we return unavailable for well data rather than timing out.
    // Users can always supply explicit API numbers for exact lookup.

    // Match both "Texas" (full name) and "TX" (abbreviation)
    const isTexas = !!state && /^texas$|^tx$/i.test(state.trim());
    const attemptAbstract = !explicitApis.length && isTexas;

    const [geocodeResult, abstractApis, wellLookupResult] = await Promise.all([
      geocodeProperty({
        township: legalParsed.plss_township,
        range:    legalParsed.plss_range,
        section:  legalParsed.section,
        state,
      }).catch(() => null).then(result => result ?? geocodeFromCountyCentroid(county, state)),

      // Abstract/survey lookup (Texas only) — runs concurrently with geocode
      attemptAbstract
        ? lookupWellsByLegalDescription({
            county,
            state,
            abstract_number: legalParsed.abstract_number,
            survey_name:     legalParsed.survey_name,
            block:           legalParsed.block,
            section:         legalParsed.section,
          }).then(r => r ? r.api_numbers : null).catch(() => null)
        : Promise.resolve(null),

      // Well lookup strategy:
      //   • Explicit APIs → fetch TRRC production directly
      //   • Texas (abstract path) → skip county sampling; replaced by tract production below
      //   • All other states → county-level sampling
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
        : attemptAbstract
          // Skip county-level sampling for Texas abstract path — too slow (25–40 s).
          // Tract-specific production (fetched below) replaces county data entirely.
          ? Promise.resolve<WellLookupResult>({
              source: "unavailable" as const,
              wells: [],
              query_description: county ? `${county} County, TX (abstract lookup active)` : "Texas",
              note: "County-level well sampling skipped; using tract-specific TRRC data.",
            })
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

    // ── Tract-specific production aggregation (Texas abstract lookup path) ──────
    // When the abstract/survey lookup identified specific wells on this property,
    // we fetch TRRC production for each one, deduplicate by TRRC lease number
    // (multiple wellbores can share one lease), and sum total gross monthly
    // production across ALL distinct leases.
    //
    // This replaces the broken well_equivalents × median_BOPD estimation with
    // actual verified lease production numbers from the TRRC.
    //
    // We limit to the first 8 API numbers to stay within the route time budget
    // (each TRRC lookup = 2 HTTP round-trips ≈ 3-5 s each → 8 × parallel ≤ 25 s).

    let tractMonthlyBbl: number | null = null;
    let tractLeaseCount: number | null = null;
    let resolvedWellLookupResult = wellLookupResult;

    if (!explicitApis.length && abstractApis && abstractApis.length > 0 && county) {
      try {
        // ── STEP 1: Resolve abstract API numbers → (distCode, leaseNo) ────────
        // CRITICAL: Do NOT use getLeaseFromApiNumber / fetchBestTrrcProduction here.
        // Those functions query TRRC with apiNoPrefixArg (county code), which TRRC
        // may treat as a county-level filter — returning the first lease in the
        // whole county rather than the specific well.
        //
        // Instead: use the proven county wellbore HTML path.  The county PDQ query
        // embeds `apiNo=XXXXXXXX&distCode=XX&leaseNo=XXXXXX` in every result row,
        // so we get the correct distCode+leaseNo for each specific API number.
        const leaseDeadline = new Promise<"timeout">(r => setTimeout(() => r("timeout"), 18_000));
        const leaseRace = await Promise.race([
          lookupTrrcLeasesByApis(county, abstractApis),
          leaseDeadline,
        ]);
        const leaseByApi = leaseRace === "timeout"
          ? new Map<string, { distCode: string; leaseNo: string; operator: string }>()
          : leaseRace;

        // ── STEP 2: Fetch production for each distinct (distCode, leaseNo) ────
        const leaseEntries = Array.from(leaseByApi.entries()); // [api, {distCode, leaseNo, op}]
        const seenLeases   = new Set<string>();
        const uniqueLeases = leaseEntries.filter(([, { distCode, leaseNo }]) => {
          const key = `${distCode}:${leaseNo}`;
          if (seenLeases.has(key)) return false;
          seenLeases.add(key);
          return true;
        });

        const leaseMap = new Map<string, {
          api: string;
          lease_number: string;
          district_code: string;
          latest_monthly_bbl: number;
          latest_production_month: string | null;
          cum_oil_bbl: number;
          operator: string;
        }>();

        if (uniqueLeases.length > 0) {
          const prodDeadline = new Promise<"timeout">(r => setTimeout(() => r("timeout"), 15_000));
          const prodRace = await Promise.race([
            Promise.allSettled(
              uniqueLeases.slice(0, 10).map(([api, { distCode, leaseNo, operator }]) =>
                fetchTrrcProductionByLease(distCode, leaseNo, 6).then(result => ({
                  api, distCode, leaseNo, operator, result,
                }))
              )
            ),
            prodDeadline,
          ]);
          const prodResults = prodRace === "timeout" ? [] : prodRace;

          for (const settled of prodResults) {
            if (settled.status !== "fulfilled") continue;
            const { api, distCode, leaseNo, operator, result } = settled.value;
            if (!result || result.rows.length === 0) continue;

            const leaseKey = `${distCode}:${leaseNo}`;
            if (leaseMap.has(leaseKey)) continue;

            // Average last 3 months with production to smooth spikes
            const recentRows = result.rows.slice(-3).filter(r => r.oil_bbl > 0);
            if (recentRows.length === 0) continue;
            const avgMonthlyBbl = recentRows.reduce((s, r) => s + r.oil_bbl, 0) / recentRows.length;

            const latestRow = result.rows[result.rows.length - 1];
            leaseMap.set(leaseKey, {
              api,
              lease_number:  leaseNo,
              district_code: distCode,
              latest_monthly_bbl: avgMonthlyBbl,
              latest_production_month: latestRow
                ? `${latestRow.year}-${String(latestRow.month).padStart(2, "0")}`
                : null,
              cum_oil_bbl: result.rows.reduce((s, r) => s + r.oil_bbl, 0),
              operator,
            });
          }
        }

        if (leaseMap.size > 0) {
          tractMonthlyBbl = Array.from(leaseMap.values()).reduce((s, l) => s + l.latest_monthly_bbl, 0);
          tractLeaseCount = leaseMap.size;

          const tractWells = Array.from(leaseMap.values()).map(l => ({
            api:       l.api,
            well_name: `Lease ${l.lease_number} (District ${l.district_code})`,
            operator:  l.operator || null,
            county,
            state:     "Texas",
            status:    "PRODUCING",
            formation: null as string | null,
            spud_date: null as string | null,
            latest_monthly_oil_bbl:   Math.round(l.latest_monthly_bbl),
            latest_monthly_gas_mcf:   null as number | null,
            latest_monthly_water_bbl: null as number | null,
            latest_production_month:  l.latest_production_month,
            cum_oil_bbl: l.cum_oil_bbl,
            lat: null as number | null,
            lng: null as number | null,
          }));

          resolvedWellLookupResult = {
            source: "trrc" as const,
            wells: tractWells,
            query_description: [
              `${leaseMap.size} lease${leaseMap.size !== 1 ? "s" : ""} on tract`,
              legalParsed.survey_name ? `(${legalParsed.survey_name}` : "(survey",
              legalParsed.block ? `Blk ${legalParsed.block}` : null,
              legalParsed.section ? `Sec ${legalParsed.section}` : null,
              county ? `${county})` : ")",
            ].filter(Boolean).join(" "),
            note: [
              `Tract-specific production from legal description via Texas land survey records.`,
              `${leaseMap.size} distinct TRRC lease${leaseMap.size !== 1 ? "s" : ""} on this tract`,
              `with total verified production of ${Math.round(tractMonthlyBbl)} BBL/mo.`,
            ].join(" "),
          };
        }
      } catch {
        // silently fall back — tractMonthlyBbl stays null, basis = "insufficient"
      }
    }

    const nearbyWellIntelligence = buildNearbyWellIntelligence({
      geocode: geocodeResult,
      wellLookupResult: resolvedWellLookupResult,
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
    //
    //    When tract_monthly_bbl is set (verified TRRC lease production), it takes
    //    highest priority and completely bypasses the well_equivalents × BOPD estimation.
    const mineralEconomics = computeMineralEconomics({
      state,
      royalty_rate: royaltyDecimal,
      nearby_bopd: nearbyWellIntelligence.median_bopd ?? nearbyWellIntelligence.avg_bopd,
      acreage,
      tract_monthly_bbl: tractMonthlyBbl,
      tract_lease_count: tractLeaseCount,
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
        // When abstract lookup succeeded, note that these are tract-specific wells
        const hasTractProduction = tractMonthlyBbl != null && tractMonthlyBbl > 0;
        if (hasTractProduction) {
          valuation.confidence_reasoning.present_signals.push(
            `Verified tract production: ${Math.round(tractMonthlyBbl!)} BBL/mo gross` +
            (tractLeaseCount ? ` from ${tractLeaseCount} TRRC lease${tractLeaseCount > 1 ? "s" : ""}` : "") +
            ` (identified from legal description via Texas land survey records)`
          );
        } else {
          valuation.confidence_reasoning.present_signals.push(
            `${nearbyWellIntelligence.total_count} well${nearbyWellIntelligence.total_count !== 1 ? "s" : ""} found` +
            (nearbyWellIntelligence.geocode_source !== "none"
              ? ` within ${nearbyWellIntelligence.radius_miles} miles`
              : " in county") +
            (nearbyWellIntelligence.median_bopd != null
              ? ` (median ${nearbyWellIntelligence.median_bopd} BOPD)`
              : "")
          );
        }
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

    // generateDealBrief has a 12-second OpenAI timeout internally.
    // The outer 14-second race is belt-and-suspenders in case the SDK timeout
    // doesn't fire cleanly — we always return a minimal fallback rather than hang.
    const dealBrief = await Promise.race([
      generateDealBrief({
        county, state, acreage,
        royalty_rate: body.royalty_rate ?? null,
        producing_status: producingStatus,
        valuation,
        production_snapshot: productionSnapshot,
        location_context: locationContext,
      }),
      new Promise<import("@/lib/intelligence/deal-brief").DealBrief>(resolve =>
        setTimeout(() => resolve({
          narrative: `${county ?? "Unknown location"}, ${state ?? ""} — ${valuation.deal_type} mineral interest. ${valuation.summary ?? ""}`.trim(),
          primary_risk: valuation.risks?.[0] ?? "Insufficient data to identify primary risk.",
          recommendation: valuation.recommendation,
          lease_term_grades: [],
          negotiation_flags: [],
          confidence: "low" as const,
        }), 14_000)
      ),
    ]);

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
      // ── Data provenance — lets you verify what the pipeline actually used ──
      _data_sources: {
        abstract_lookup_attempted: attemptAbstract,
        abstract_apis_found:       abstractApis?.length ?? 0,
        tract_leases_with_production: tractLeaseCount ?? 0,
        tract_monthly_bbl_gross:   tractMonthlyBbl != null ? Math.round(tractMonthlyBbl) : null,
        economics_basis:           mineralEconomics.basis,
        oil_price_used:            mineralEconomics.state_economics.oil_price_per_bbl,
        state_economics_applied:   mineralEconomics.state_economics.state,
        parsed_abstract:           legalParsed.abstract_number,
        parsed_survey:             legalParsed.survey_name,
        parsed_block:              legalParsed.block,
        parsed_section:            legalParsed.section,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
