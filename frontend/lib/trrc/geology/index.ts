/**
 * runGeologicalDueDiligence — the single orchestration entry point for the
 * Geological Due Diligence Engine. Sequences context -> offsets ->
 * production enrichment -> comparable grouping -> development activity ->
 * formation context -> assessment -> persistence, exactly matching this
 * engine's build plan.
 *
 * Every step is wrapped so a missing/failed source degrades only that
 * section — this function itself never throws for an EXPECTED gap (no
 * offsets found, no production data, formation unknown); it always
 * returns a structured result, falling back to INSUFFICIENT_DATA rather
 * than raising when evidence is too thin. It only throws for a genuinely
 * unexpected failure (e.g. the subject well's location can't be resolved
 * at all), same as offset-analytics/service.ts's own error-wrapping
 * convention.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveGeologySubjectContext, type ResolvedRunIdentity } from "./context";
import { findOffsetWells } from "./offsets";
import { enrichOffsetProduction, buildComparableGroups, computeProductionDistribution } from "./production";
import { analyzeDevelopmentActivity } from "./activity";
import { resolveFormationDepthContext } from "./formations";
import { runGeologicalAssessment } from "./assessment";
import type { GeologicalAssessmentResult } from "./types";

export interface RunGeologicalDueDiligenceInput {
  run: ResolvedRunIdentity;
  extras?: {
    county?: string | null;
    wellName?: string | null;
    targetFormation?: string | null;       // from permit records, when known
    producingFormation?: string | null;    // subject well's own field name, when known
    wellStatus?: string | null;
    subjectTvdFt?: number | null;
    subjectTvdSource?: string | null;
    referenceElevationFt?: number | null;
    referenceElevationSource?: string | null;
  };
}

export async function runGeologicalDueDiligence(input: RunGeologicalDueDiligenceInput): Promise<GeologicalAssessmentResult> {
  const { run, extras } = input;

  // ── Step 1-2: subject context ────────────────────────────────────────────
  const context = await resolveGeologySubjectContext(run, extras);
  const subjectLocationResolved = context.latitude !== null && context.longitude !== null;

  if (!subjectLocationResolved) {
    // Not a thrown error — this is an expected, honestly-reported outcome:
    // the engine ran, found it could not locate the subject well, and
    // reports INSUFFICIENT_DATA rather than guessing a center point.
    const emptyOffsets = { wells: [], countByRadius: { 1: 0, 3: 0, 5: 0 } as Record<1 | 3 | 5, number>, horizontalCountByRadius: { 1: 0, 3: 0, 5: 0 } as Record<1 | 3 | 5, number>, warnings: context.warnings, sourceUrlOrQueryId: context.sourceUrlOrQueryId ?? "", retrievedAt: context.retrievedAt };
    const emptyActivity = analyzeDevelopmentActivity([]);
    const formationContext = resolveFormationDepthContext({
      subjectFieldName: extras?.producingFormation ?? null, permittedFormationRaw: extras?.targetFormation ?? null,
      subjectTvdFt: extras?.subjectTvdFt ?? null, subjectTvdSource: extras?.subjectTvdSource ?? null,
      referenceElevationFt: extras?.referenceElevationFt ?? null, referenceElevationSource: extras?.referenceElevationSource ?? null,
    });
    return runGeologicalAssessment({
      offsets: emptyOffsets, comparableGroups: [], productionStats: [], activity: emptyActivity,
      formationContext, subjectLocationResolved: false,
    });
  }

  // ── Step 3-4: offset wells (1/3/5mi rings) ───────────────────────────────
  const offsets = await findOffsetWells({ lat: context.latitude as number, lng: context.longitude as number }, context.apiNumber);

  // ── Step 5-6: production enrichment + comparable grouping ───────────────
  const enriched = await enrichOffsetProduction(offsets.wells, extras?.producingFormation ?? null);
  offsets.warnings.push(...enriched.warnings);
  const comparableGroups = buildComparableGroups(enriched.wells);
  const productionStats = computeProductionDistribution(enriched.wells, comparableGroups);

  // ── Step 7: development activity ─────────────────────────────────────────
  const activity = analyzeDevelopmentActivity(enriched.wells);

  // ── Step 8: formation/depth context ──────────────────────────────────────
  const formationContext = resolveFormationDepthContext({
    subjectFieldName: extras?.producingFormation ?? null,
    permittedFormationRaw: extras?.targetFormation ?? null,
    subjectTvdFt: extras?.subjectTvdFt ?? null,
    subjectTvdSource: extras?.subjectTvdSource ?? null,
    referenceElevationFt: extras?.referenceElevationFt ?? null,
    referenceElevationSource: extras?.referenceElevationSource ?? null,
  });

  // ── Step 9-16: assessment (classification, confidence, findings, interpretation) ──
  return runGeologicalAssessment({
    offsets, comparableGroups, productionStats, activity, formationContext,
    subjectLocationResolved: true,
  });
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persists a completed assessment to migration 023's tables. Separate from
 * the orchestration function above so a caller (or a test) can run the
 * analysis without a database round trip, and so a persistence failure
 * never destroys an already-computed in-memory result — the caller gets
 * the result back regardless of whether the write succeeded, with any
 * write error attached as a warning rather than swallowed.
 */
export async function persistGeologicalAssessment(
  supabase: SupabaseClient,
  runId: string,
  result: GeologicalAssessmentResult,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error: assessmentError } = await supabase.from("geology_assessments").upsert({
      run_id: runId,
      classification: result.classification,
      confidence: result.confidence,
      confidence_dimensions: result.confidenceDimensions,
      diligence_implication: result.diligenceImplication,
      subject_formation: result.formationDepthContext.subjectFormation,
      producing_formation: result.formationDepthContext.producingFormation,
      permitted_formation: result.formationDepthContext.permittedFormation,
      subject_tvd_ft: result.formationDepthContext.subjectTvdFt,
      subject_tvdss_ft: result.formationDepthContext.subjectTvdssFt,
      tvdss_elevation_source: result.formationDepthContext.tvdssElevationSource,
      tvdss_methodology: result.formationDepthContext.tvdssMethodology,
      target_formation_data_gap: !result.formationDepthContext.formationTopsAvailable,
      generated_at: result.generatedAt,
    }, { onConflict: "run_id" });
    if (assessmentError) return { ok: false, error: assessmentError.message };

    if (result.offsetSummary.wells.length > 0) {
      const { error: offsetsError } = await supabase.from("geology_offsets").insert(
        result.offsetSummary.wells.map(w => ({
          run_id: runId, api_number: w.apiNumber, well_number: w.wellNumber,
          latitude: w.latitude, longitude: w.longitude, distance_miles: w.distanceMiles, bearing: w.bearing,
          radius_band_miles: w.radiusBandMiles, gis_status_symbol: w.gisStatusSymbol, classified_status: w.classifiedStatus,
          canonical_formation: w.canonicalFormation, formation_match: w.formationMatch,
          lateral_length_ft: w.lateralLengthFt, completion_year: w.completionYear, first_production_date: w.firstProductionMonth,
          six_month_oil_bbl: w.sixMonthOilBbl, twelve_month_oil_bbl: w.twelveMonthOilBbl,
          cumulative_oil_bbl: w.cumulativeOilBbl, cumulative_gas_mcf: w.cumulativeGasMcf, cumulative_water_bbl: w.cumulativeWaterBbl,
          months_of_history: w.monthsOfHistory, comparable_group_id: w.comparableGroupId, operator_name: w.operatorName,
          source_url_or_query_id: result.offsetSummary.sourceUrlOrQueryId, retrieved_at: result.offsetSummary.retrievedAt,
        })),
      );
      if (offsetsError) return { ok: false, error: offsetsError.message };
    }

    if (result.developmentActivity.permits.length > 0) {
      const { error: permitsError } = await supabase.from("geology_permits").insert(
        result.developmentActivity.permits.map(p => ({
          run_id: runId, api_number: p.apiNumber, permit_number: p.permitNumber,
          distance_miles: p.distanceMiles, radius_band_miles: p.radiusBandMiles,
          filed_date: p.filedDate, months_since_filed: p.monthsSinceFiled, recency_bucket: p.recencyBucket,
          target_formation: p.targetFormation, operator_name: p.operatorName, well_status_at_query: p.wellStatusAtQuery,
          source_url_or_query_id: p.sourceUrlOrQueryId, retrieved_at: p.retrievedAt,
        })),
      );
      if (permitsError) return { ok: false, error: permitsError.message };
    }

    const findings = [
      ...result.supportingFactors, ...result.contradictingFactors, ...result.risks, ...result.dataGaps,
    ];
    if (findings.length > 0) {
      const { error: findingsError } = await supabase.from("geology_findings").insert(
        findings.map((f, i) => ({
          run_id: runId, category: f.category, classification: f.classification,
          title: f.title, description: f.description, evidence_ids: f.evidenceIds, display_order: i,
        })),
      );
      if (findingsError) return { ok: false, error: findingsError.message };
    }

    if (result.evidence.length > 0) {
      const { error: evidenceError } = await supabase.from("geology_evidence").insert(
        result.evidence.map(e => ({
          id: e.id, run_id: runId, field_name: e.fieldName, classification: e.classification,
          source: e.source, source_url_or_doc_id: e.sourceUrlOrDocId, retrieved_at: e.retrievedAt,
          raw_value: e.rawValue, normalized_value: e.normalizedValue, confidence: e.confidence,
          transformation_method: e.transformationMethod,
        })),
      );
      if (evidenceError) return { ok: false, error: evidenceError.message };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
