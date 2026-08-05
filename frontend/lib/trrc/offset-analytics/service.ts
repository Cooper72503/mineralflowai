/**
 * Master orchestration — wires every phase together in sequence and
 * assembles the versioned output payload (types.ts's OffsetAnalyticsPayload).
 * This file does the SEQUENCING; the actual logic for each step lives in
 * its own phase module, imported here, not reimplemented.
 *
 * Enrichment (resolving each candidate well's lease/field name and
 * production history) is capped at the nearest MAX_CANDIDATES_TO_ENRICH
 * wells before running any live queries — each enrichment is a real
 * multi-request TRRC round trip (Phase 10), and running that against
 * every well a radius search can return (sometimes dozens) isn't
 * practical. Wells beyond the cap are still counted in the search summary
 * (never silently dropped from the reported totals), just not
 * individually enriched/scored.
 */

import { randomUUID } from "crypto";
import { parseLegalDescription } from "./legal-description";
import { OffsetAnalyticsGeocoder, CachedGeocoder } from "./geocoding";
import { validateGeometry } from "./geometry";
import { ArcGisWellSearchProvider, type DistanceMode, type WellSearchProvider } from "./well-search";
import { classifyWellStatus, filterCandidates, DEFAULT_CANDIDATE_FILTER_OPTIONS, type EnrichableCandidate } from "./candidate-filtering";
import { normalizeFormation, matchFormations } from "./formation-normalization";
import { scoreAnalog } from "./analog-scoring";
import { selectTopAnalogs, DEFAULT_ANALOG_SELECTION_OPTIONS, type ScoredCandidate } from "./analog-selection";
import { resolveWellboreToLease, fetchAnalogProduction, detectProductionAnomalies } from "./production-loader";
import { fitAnalogDecline, DEFAULT_QC_THRESHOLDS } from "./analog-decline-fitting";
import { aggregateParameters, buildNormalizedTypeCurve } from "./composite-profile";
import { buildSingleWellProxyCase, buildConfiguredDevelopmentCase, type DevelopmentAssumptions } from "./tract-scaling";
import { resolveOwnership, type OwnershipInputs } from "./ownership-economics";
import { computeProxyValuation } from "./proxy-valuation";
import { computeConfidence, ownershipConfidenceScore } from "./confidence";
import type { LegalDescriptionGeocoder, OffsetAnalyticsPayload, ProvenanceEntry, WarningEntry } from "./types";
import type { PriceDeck } from "../eia-pricing";
import { wrapUnexpectedError } from "./errors";
import { DEFAULT_CONFIG } from "./constants";
import { logEvent, NoopLogger, type Logger } from "./observability";

const MAX_CANDIDATES_TO_ENRICH = DEFAULT_CONFIG.maxCandidatesToEnrich;

/**
 * Injectable dependencies (Phase 19's dependency-injection requirement) —
 * defaults to the real, live providers. Tests supply mocks/fakes here
 * instead of monkey-patching globalThis.fetch, and a future PostGIS-backed
 * WellSearchProvider (see well-search.ts's own notes) can be swapped in
 * without touching this file's orchestration logic.
 */
export interface OffsetAnalyticsDependencies {
  geocoder: LegalDescriptionGeocoder;
  wellSearchProvider: WellSearchProvider;
  logger: Logger;
}

// Module-level singleton so the geocode cache persists across multiple
// runOffsetAnalytics calls within the same process (not across restarts —
// see geocoding.ts's CachedGeocoder doc comment).
const defaultGeocoder = new CachedGeocoder(new OffsetAnalyticsGeocoder());
const defaultDependencies: OffsetAnalyticsDependencies = {
  geocoder: defaultGeocoder,
  wellSearchProvider: new ArcGisWellSearchProvider(),
  logger: new NoopLogger(), // callers that want real logs inject a ConsoleLogger (or their own Logger) explicitly — silent by default so importing this module never produces surprise console output
};

export interface RunOffsetAnalyticsInput {
  legalDescriptionText: string;
  grossAcres?: number | null;
  netMineralAcres?: number | null;
  ownershipType?: OwnershipInputs["ownershipType"];
  mineralFraction?: number | null;
  leaseRoyaltyFraction?: number | null;
  netRevenueInterest?: number | null;
  workingInterest?: number | null;
  radiusMiles?: number;
  distanceMode?: DistanceMode;
  subjectFieldName?: string | null;
  subjectLateralLengthFt?: number | null;
  subjectCompletionYear?: number | null;
  subjectTvdFt?: number | null;
  developmentAssumptions?: DevelopmentAssumptions | null;
  /**
   * 2-letter USPS state code for the subject tract. Required to resolve a
   * PLSS (township/range/section) legal description — the PLSS parser
   * itself can't reliably extract state from free text (see
   * legal-description.ts), and without it every PLSS description would
   * otherwise fall through geocodePlssLegalDescription's `!desc.state`
   * branch as unmappable regardless of how well-formed the description is.
   * Not required for Texas land-grid descriptions (the far more common
   * case for this engine's actual TRRC subject wells).
   */
  subjectState?: string | null;
  priceDeck: PriceDeck;
}

/**
 * Public entry point. Wraps runOffsetAnalyticsInternal so a genuinely
 * unexpected failure (a provider throwing outside its own .catch, a real
 * bug) never reaches the caller as a raw error — it's converted to a
 * classified OffsetAnalyticsCalculationError (errors.ts, Phase 18) with a
 * safe message and the analysis ID that was already generated, so a
 * failure can still be correlated in logs even though nothing was
 * returned. EXPECTED outcomes (no analogs, unmappable, etc.) never reach
 * this catch — they're normal returns with a descriptive validationStatus.
 */
export async function runOffsetAnalytics(input: RunOffsetAnalyticsInput, dependencies: OffsetAnalyticsDependencies = defaultDependencies): Promise<OffsetAnalyticsPayload> {
  const analysisId = randomUUID();
  try {
    return await runOffsetAnalyticsInternal(input, analysisId, dependencies);
  } catch (err) {
    const wrapped = wrapUnexpectedError(err, analysisId);
    logEvent(dependencies.logger, analysisId, "analysis_failed", { failureCode: wrapped.code, technicalContext: wrapped.technicalContext });
    throw wrapped;
  }
}

async function runOffsetAnalyticsInternal(input: RunOffsetAnalyticsInput, analysisId: string, dependencies: OffsetAnalyticsDependencies): Promise<OffsetAnalyticsPayload> {
  const provenance: ProvenanceEntry[] = [];
  const warnings: WarningEntry[] = [];
  const now = () => new Date().toISOString();
  const startedAt = Date.now();
  const { logger } = dependencies;

  logEvent(logger, analysisId, "analysis_start", { legalDescriptionTextLength: input.legalDescriptionText.length });

  // ── Step 1-2: parse + geocode ──────────────────────────────────────────
  let legalDescription = parseLegalDescription(input.legalDescriptionText);
  if (legalDescription.jurisdiction === "PLSS" && input.subjectState) {
    legalDescription = { ...legalDescription, state: input.subjectState };
  }
  provenance.push({ step: "parse_legal_description", source: "legal-description.ts", sourceUrlOrQueryId: null, retrievedAt: now(), detail: `jurisdiction=${legalDescription.jurisdiction}` });
  logEvent(logger, analysisId, "legal_description_parsed", { jurisdiction: legalDescription.jurisdiction });

  const geocode = await dependencies.geocoder.geocode(legalDescription);
  provenance.push({ step: "geocode", source: geocode.sourceProvider, sourceUrlOrQueryId: geocode.sourceUrlOrQueryId, retrievedAt: geocode.retrievedAt, detail: `matchMethod=${geocode.matchMethod}` });
  warnings.push(...geocode.warnings);
  logEvent(logger, analysisId, "geocode_complete", { provider: geocode.sourceProvider, matchMethod: geocode.matchMethod, confidence: geocode.confidence });

  // ── Step 3: geometry validation + authoritative centroid ──────────────
  const geomValidation = validateGeometry(geocode.geometry);
  warnings.push(...geomValidation.warnings);
  const centroid = geomValidation.centroid ?? (geocode.centroidLatitude !== null && geocode.centroidLongitude !== null ? { lat: geocode.centroidLatitude, lng: geocode.centroidLongitude } : null);
  logEvent(logger, analysisId, "geometry_validated", { valid: geomValidation.valid, hasCentroid: centroid !== null });

  const emptyConfidence = computeConfidence({ legalDescription: legalDescription.jurisdiction === "UNPARSED" ? 0 : legalDescription.extractionConfidence, geometry: 0, wellLocation: 0, geologicalMatch: 0, productionData: 0, declineFit: 0, ownership: 0, economics: 0 });

  if (!centroid || !geomValidation.valid) {
    warnings.push({ code: "NO_VALID_CENTROID_UNMAPPABLE", message: "A failed geocode is not a valid centroid — no offset well search can be performed without one", severity: "critical" });
    logEvent(logger, analysisId, "analysis_failed", { failureCode: "NO_VALID_CENTROID_UNMAPPABLE", durationMs: Date.now() - startedAt });
    return {
      schemaVersion: "1.0.0", analysisId,
      subjectAsset: { legalDescription, grossAcres: input.grossAcres ?? null, netMineralAcres: input.netMineralAcres ?? null, ownershipType: input.ownershipType ?? "UNKNOWN" },
      geocode, search: { radiusMiles: input.radiusMiles ?? 5, distanceMode: input.distanceMode ?? "CENTROID_TO_WELL", candidatesFound: 0, qualifiedAnalogs: 0, removedForStatus: 0, removedForInsufficientHistory: 0, removedForFormationMismatch: 0, removedForDuplicate: 0 },
      analogWells: [], compositeProfile: null,
      developmentCase: { caseType: "SINGLE_WELL_PROXY", wellCount: 0, probabilityOfDevelopment: 0 },
      economics: null, confidence: emptyConfidence, provenance, warnings, validationStatus: "INVALID",
      durationMs: Date.now() - startedAt,
    };
  }

  // ── Step 5: true-radius well search ────────────────────────────────────
  const radiusMiles = input.radiusMiles ?? 5;
  const distanceMode = input.distanceMode ?? "CENTROID_TO_WELL";
  const wellSearch = await dependencies.wellSearchProvider.search(centroid, geocode.geometry, radiusMiles, distanceMode);
  warnings.push(...wellSearch.warnings);
  provenance.push({ step: "well_search", source: "TRRC GIS Well Locations", sourceUrlOrQueryId: wellSearch.sourceUrlOrQueryId, retrievedAt: now(), detail: `${wellSearch.candidates.length} candidates within ${wellSearch.radiusMiles}mi (${wellSearch.distanceMode})` });
  logEvent(logger, analysisId, "spatial_candidates_found", { count: wellSearch.candidates.length, radiusMiles: wellSearch.radiusMiles, distanceMode: wellSearch.distanceMode });

  // ── Step 6-7: status-only pre-filter (cheap, before any per-well enrichment) ──
  const subjectFormation = normalizeFormation(input.subjectFieldName ?? "");
  const preEnriched: EnrichableCandidate[] = wellSearch.candidates.map(c => ({
    ...c, status: classifyWellStatus(c.gisStatusSymbol), monthsOfProductionHistory: null, formationKnown: null, commodity: "UNKNOWN",
  }));
  const statusFilterResult = filterCandidates(preEnriched, DEFAULT_CANDIDATE_FILTER_OPTIONS);

  // ── Step 8-9: enrich the nearest N accepted candidates with real lease/production/formation data ──
  const toEnrich = statusFilterResult.results.filter(r => r.accepted).slice(0, MAX_CANDIDATES_TO_ENRICH);
  if (statusFilterResult.results.filter(r => r.accepted).length > MAX_CANDIDATES_TO_ENRICH) {
    warnings.push({ code: "CANDIDATE_ENRICHMENT_CAPPED", message: `${statusFilterResult.results.filter(r => r.accepted).length} status-qualified candidates found; only the nearest ${MAX_CANDIDATES_TO_ENRICH} were enriched with production/formation data (each enrichment is a live multi-request TRRC lookup)`, severity: "info" });
  }

  interface Enriched { candidate: EnrichableCandidate; fieldName: string | null; rows: import("./production-loader").AnalogProductionRow[] }
  const enriched: Enriched[] = [];
  for (const r of toEnrich) {
    const lease = await resolveWellboreToLease(r.candidate.api).catch(() => null);
    if (!lease) { warnings.push({ code: "ANALOG_WELLBORE_RESOLUTION_FAILED", message: `Could not resolve API ${r.candidate.api} to a lease`, severity: "warning" }); continue; }
    const production = await fetchAnalogProduction(lease.leaseNumber, lease.district).catch(() => null);
    if (!production || !production.found) continue;
    warnings.push(...detectProductionAnomalies(production.rows));
    const formationMatch = matchFormations(subjectFormation, normalizeFormation(lease.fieldName ?? ""));
    enriched.push({
      candidate: { ...r.candidate, monthsOfProductionHistory: production.rows.filter(row => row.oilBbl !== null || row.gasMcf !== null).length, formationKnown: formationMatch.accepted, commodity: production.rows.some(row => row.oilBbl !== null) ? "OIL" : "GAS" },
      fieldName: lease.fieldName, rows: production.rows,
    });
  }
  provenance.push({ step: "analog_enrichment", source: "TRRC EWA (wellbore + production)", sourceUrlOrQueryId: null, retrievedAt: now(), detail: `${enriched.length} of ${toEnrich.length} candidates successfully enriched` });

  // ── Step 10: full filter pass, now with real history/formation data ──
  const fullFilterResult = filterCandidates(enriched.map(e => e.candidate), DEFAULT_CANDIDATE_FILTER_OPTIONS);
  const finalCounts = {
    removedForStatus: statusFilterResult.counts.removedForStatus,
    removedForDuplicate: statusFilterResult.counts.removedForDuplicate + fullFilterResult.counts.removedForDuplicate,
    removedForInsufficientHistory: fullFilterResult.counts.removedForInsufficientHistory,
    removedForFormationMismatch: fullFilterResult.counts.removedForFormationMismatch,
  };

  // ── Step 11-12: score + select top analogs ──────────────────────────────
  const scored: ScoredCandidate[] = fullFilterResult.results.filter(r => r.accepted).map(r => {
    const e = enriched.find(x => x.candidate.api === r.candidate.api)!;
    const formationMatch = matchFormations(subjectFormation, normalizeFormation(e.fieldName ?? ""));
    const score = scoreAnalog({
      formationMatch, distanceMiles: r.candidate.distanceMiles, searchRadiusMiles: radiusMiles,
      subjectLateralLengthFt: input.subjectLateralLengthFt ?? null, candidateLateralLengthFt: null,
      subjectCompletionYear: input.subjectCompletionYear ?? null, candidateCompletionYear: null,
      subjectTvdFt: input.subjectTvdFt ?? null, candidateTvdFt: null,
    });
    return { api: r.candidate.api, latitude: r.candidate.latitude, longitude: r.candidate.longitude, score };
  });
  const selection = selectTopAnalogs(scored, DEFAULT_ANALOG_SELECTION_OPTIONS);
  warnings.push({ code: "ANALOG_SELECTION_STATUS", message: selection.explanation, severity: selection.status === "SUFFICIENT_ANALOG_SET" ? "info" : "warning" });
  logEvent(logger, analysisId, "analog_qualification_complete", { status: selection.status, qualifiedCount: selection.selected.length, rejectedForLowScore: selection.rejectedForLowScore, rejectedForPadOverconcentration: selection.rejectedForPadOverconcentration });

  // ── Step 13: independent per-well decline fits ──────────────────────────
  const selectedEnriched = selection.selected.map(s => enriched.find(e => e.candidate.api === s.api)!).filter(Boolean);
  const fits = selectedEnriched.map(e => fitAnalogDecline(e.candidate.api, e.rows, DEFAULT_QC_THRESHOLDS));
  const qcPassedFits = fits.filter(f => f.qcPassed);
  logEvent(logger, analysisId, "decline_fit_complete", { totalFits: fits.length, qcPassed: qcPassedFits.length, qcRejected: fits.length - qcPassedFits.length });

  // ── Step 14: composite profile ───────────────────────────────────────────
  const paramAggregate = aggregateParameters(fits);
  const typeCurve = buildNormalizedTypeCurve(
    selectedEnriched.map(e => ({ api: e.candidate.api, oilSeries: [...e.rows].sort((a, b) => a.productionMonth.localeCompare(b.productionMonth)).map(r => r.oilBbl ?? 0).filter((_, i, arr) => arr.slice(0, i + 1).some(v => v > 0)), lateralLengthFt: null })),
    input.subjectLateralLengthFt ?? null,
  );
  warnings.push(...typeCurve.warnings);
  logEvent(logger, analysisId, "aggregation_complete", { method: "NORMALIZED_TYPE_CURVE_P50", analogCount: paramAggregate?.analogCount ?? 0, lateralNormalizationApplied: typeCurve.lateralNormalizationApplied });

  // ── Step 15: development case ────────────────────────────────────────────
  const developmentCase = input.developmentAssumptions ? buildConfiguredDevelopmentCase(input.developmentAssumptions) : buildSingleWellProxyCase({ grossTractAcres: input.grossAcres ?? undefined, netMineralAcres: input.netMineralAcres ?? undefined });
  warnings.push(...developmentCase.warnings);

  // ── Step 16: ownership ────────────────────────────────────────────────────
  const ownership = resolveOwnership({
    ownershipType: input.ownershipType ?? "UNKNOWN",
    netMineralAcres: input.netMineralAcres ?? null, grossTractAcres: input.grossAcres ?? null,
    mineralFraction: input.mineralFraction ?? null, leaseRoyaltyFraction: input.leaseRoyaltyFraction ?? null,
    netRevenueInterest: input.netRevenueInterest ?? null, workingInterest: input.workingInterest ?? null,
  });
  warnings.push(...ownership.warnings);

  // ── Step 17: proxy valuation ─────────────────────────────────────────────
  const valuation = computeProxyValuation(typeCurve.months, developmentCase, ownership, input.priceDeck);
  warnings.push(...valuation.warnings);

  // ── Step 16 (confidence, computed last since it needs everything above) ──
  const geologicalMatchAvg = selectedEnriched.length > 0
    ? selectedEnriched.reduce((s, e) => s + (matchFormations(subjectFormation, normalizeFormation(e.fieldName ?? "")).accepted ? 1 : 0), 0) / selectedEnriched.length
    : 0;
  const declineFitMedianR2 = qcPassedFits.length > 0 ? qcPassedFits.reduce((s, f) => s + (f.oilFit?.rSquared ?? 0), 0) / qcPassedFits.length : 0;
  const confidence = computeConfidence({
    legalDescription: legalDescription.jurisdiction === "UNPARSED" ? 0 : legalDescription.extractionConfidence,
    geometry: geocode.confidence,
    wellLocation: wellSearch.candidates.length > 0 ? 1.0 : 0,
    geologicalMatch: geologicalMatchAvg,
    productionData: selectedEnriched.length > 0 ? qcPassedFits.length / selectedEnriched.length : 0,
    declineFit: declineFitMedianR2,
    ownership: ownershipConfidenceScore(ownership.resultType),
    economics: typeCurve.months.length > 0 ? Math.min(1, qcPassedFits.length / Math.max(1, DEFAULT_ANALOG_SELECTION_OPTIONS.minAnalogCount)) : 0,
  });

  const validationStatus: OffsetAnalyticsPayload["validationStatus"] =
    selection.status === "NO_VALID_ANALOGS" ? "INVALID" :
    selection.status !== "SUFFICIENT_ANALOG_SET" || confidence.overall === "LOW" || confidence.overall === "INSUFFICIENT_DATA" ? "PARTIAL" : "VALID";

  const durationMs = Date.now() - startedAt;
  logEvent(logger, analysisId, "economics_complete", { valuationType: typeCurve.months.length > 0 ? ownership.resultType : null, unriskedPv10: valuation.unriskedPv10 });
  logEvent(logger, analysisId, "analysis_complete", { validationStatus, warningCount: warnings.length, criticalWarningCount: warnings.filter(w => w.severity === "critical").length, durationMs });

  return {
    schemaVersion: "1.0.0", analysisId,
    subjectAsset: { legalDescription, grossAcres: input.grossAcres ?? null, netMineralAcres: input.netMineralAcres ?? null, ownershipType: input.ownershipType ?? "UNKNOWN" },
    geocode,
    search: {
      radiusMiles, distanceMode: wellSearch.distanceMode,
      candidatesFound: wellSearch.candidates.length, qualifiedAnalogs: selection.selected.length,
      ...finalCounts,
    },
    analogWells: selection.selected.map(s => {
      const fit = fits.find(f => f.api === s.api);
      const e = selectedEnriched.find(x => x.candidate.api === s.api);
      return {
        api: s.api, operator: null, distanceMiles: e?.candidate.distanceMiles ?? 0,
        canonicalFormation: normalizeFormation(e?.fieldName ?? "").canonicalFormation,
        landingZone: null,
        analogScore: s.score.totalScore,
        declineFit: fit?.oilFit ? { qiOilBblPerMonth: fit.oilFit.qi, diNominalMonthly: fit.oilFit.di, bFactor: fit.oilFit.b, rSquared: fit.oilFit.rSquared } : null,
      };
    }),
    compositeProfile: paramAggregate ? {
      method: "NORMALIZED_TYPE_CURVE_P50", analogCount: paramAggregate.analogCount,
      oil: { qiBblPerMonth: paramAggregate.qiMedian, diNominalMonthly: paramAggregate.diMedian, bFactor: paramAggregate.bMedian, technicalEurBbl: qcPassedFits.reduce((s, f) => s + (f.oilEur?.eur ?? 0), 0) / Math.max(1, qcPassedFits.length) },
    } : null,
    developmentCase: { caseType: developmentCase.caseType, wellCount: developmentCase.wellCount, probabilityOfDevelopment: developmentCase.probabilityOfDevelopment },
    economics: typeCurve.months.length > 0 ? {
      valuationType: ownership.resultType === "ROYALTY_OWNER_PV10" ? "ROYALTY_OWNER_PROXY_PV10" : ownership.resultType === "WORKING_INTEREST_OWNER_PV10" ? "WORKING_INTEREST_OWNER_PROXY_PV10" : "GROSS_TRACT_PROXY_PV10",
      unriskedPv10: valuation.unriskedPv10, riskedPv10: valuation.riskedPv10, currency: "USD", annualDiscountRate: 0.10,
    } : null,
    confidence, provenance, warnings, validationStatus, durationMs,
  };
}
