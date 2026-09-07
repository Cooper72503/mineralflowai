/**
 * runTitleResolution — the single orchestration entry point for the Title
 * Resolution / Ownership Graph engine, Phase 1 (revised schema). Sequences:
 * read already-persisted instruments/parties/tracts/claims for this run ->
 * fetch + insert fresh county-clerk-index instruments -> canonical tract +
 * party matching (persisted, not transient) -> chronological timeline +
 * surface-level discontinuity/variance detection -> assessment.
 *
 * Every step degrades to a partial/INSUFFICIENT_DATA result rather than
 * throwing for an EXPECTED gap (no county connector for this county, zero
 * instruments found) — same contract as geology/index.ts. persistTitle-
 * Assessment never throws at all, matching persistGeologicalAssessment.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { retrieveCountyClerkInstruments } from "./retrieval";
import { matchTitleIdentities } from "./asset-matching";
import { buildTitleTimeline } from "./timeline";
import { runTitleAssessment } from "./assessment";
import type {
  TitleAssessmentResult, TitleInstrument, TitleInstrumentParty, TitleInstrumentTract, TitleClaim,
  EnrichedClaim, TitleWarning, CanonicalTract, CanonicalParty,
} from "./types";

export interface RunTitleResolutionInput {
  runId: string;
  supabase: SupabaseClient;
  county: string | null;
}

// ─── Row shapes + mappers ───────────────────────────────────────────────────

interface InstrumentRow {
  id: string; instrument_type: string; instrument_date: string | null; recorded_date: string | null;
  doc_number: string | null; book_volume_page: string | null; source: string; source_url_or_doc_id: string | null;
  source_doc_id: string | null; source_page: number | null; source_exact_language: string | null;
  extraction_confidence: number | null; evidence_level: string; instrument_content_verified: boolean;
  human_review_status: string;
}
function rowToInstrument(r: InstrumentRow): TitleInstrument {
  return {
    id: r.id, instrumentType: r.instrument_type as TitleInstrument["instrumentType"],
    instrumentDate: r.instrument_date, recordedDate: r.recorded_date, docNumber: r.doc_number, bookVolumePage: r.book_volume_page,
    source: r.source as TitleInstrument["source"], sourceUrlOrDocId: r.source_url_or_doc_id, sourceDocId: r.source_doc_id,
    sourcePage: r.source_page, sourceExactLanguage: r.source_exact_language, extractionConfidence: r.extraction_confidence,
    evidenceLevel: r.evidence_level as TitleInstrument["evidenceLevel"], instrumentContentVerified: r.instrument_content_verified,
    humanReviewStatus: r.human_review_status as TitleInstrument["humanReviewStatus"],
  };
}

interface PartyRow { id: string; instrument_id: string; party_name: string; role: string; capacity: string; canonical_party_id: string | null }
function rowToParty(r: PartyRow): TitleInstrumentParty {
  return { id: r.id, instrumentId: r.instrument_id, partyName: r.party_name, role: r.role as TitleInstrumentParty["role"], capacity: r.capacity as TitleInstrumentParty["capacity"], canonicalPartyId: r.canonical_party_id };
}

interface TractRow {
  id: string; instrument_id: string; county: string | null; legal_description: string | null; abstract_number: string | null;
  survey_name: string | null; block_number: string | null; section_name: string | null; gross_acres: number | null;
  interest_type: string | null; interest_conveyed_fraction: number | null; interest_reserved_fraction: number | null;
  royalty_fraction: number | null; depth_or_formation_limit: string | null; canonical_tract_id: string | null;
}
function rowToTract(r: TractRow): TitleInstrumentTract {
  return {
    id: r.id, instrumentId: r.instrument_id, county: r.county, legalDescription: r.legal_description, abstractNumber: r.abstract_number,
    surveyName: r.survey_name, blockNumber: r.block_number, sectionName: r.section_name, grossAcres: r.gross_acres,
    interestType: r.interest_type as TitleInstrumentTract["interestType"], interestConveyedFraction: r.interest_conveyed_fraction,
    interestReservedFraction: r.interest_reserved_fraction, royaltyFraction: r.royalty_fraction, depthOrFormationLimit: r.depth_or_formation_limit,
    canonicalTractId: r.canonical_tract_id,
  };
}

interface ClaimRow { id: string; instrument_id: string; instrument_tract_id: string; canonical_asset_id: string | null; human_review_status: string }
function rowToClaim(r: ClaimRow): TitleClaim {
  return { id: r.id, instrumentId: r.instrument_id, instrumentTractId: r.instrument_tract_id, canonicalAssetId: r.canonical_asset_id, humanReviewStatus: r.human_review_status as TitleClaim["humanReviewStatus"] };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function runTitleResolution(input: RunTitleResolutionInput): Promise<TitleAssessmentResult> {
  const { runId, supabase, county } = input;
  const warnings: TitleWarning[] = [];

  // ── Step 1: read already-persisted instruments/parties/tracts/claims ────
  const [{ data: existingInstruments, error: instErr }, { data: existingParties, error: partyErr }, { data: existingTracts, error: tractErr }, { data: existingClaims, error: claimErr }] = await Promise.all([
    supabase.from("title_instruments").select("*").eq("run_id", runId),
    supabase.from("title_instrument_parties").select("*").eq("run_id", runId),
    supabase.from("title_instrument_tracts").select("*").eq("run_id", runId),
    supabase.from("title_claims").select("*").eq("run_id", runId),
  ]);
  for (const [label, err] of [["instruments", instErr], ["parties", partyErr], ["tracts", tractErr], ["claims", claimErr]] as const) {
    if (err) warnings.push({ code: "TITLE_READ_FAILED", message: `Could not read existing title ${label}: ${err.message}`, severity: "critical" });
  }

  const instrumentDedupeKeys = new Set(
    (existingInstruments as InstrumentRow[] | null ?? []).map(i => [i.instrument_date ?? "", i.doc_number ?? "", i.recorded_date ?? ""].join("|")),
  );

  // ── Step 2: fetch + insert fresh county-clerk-index instruments ─────────
  const retrieval = await retrieveCountyClerkInstruments(supabase, runId, county);
  const freshCandidates = retrieval.candidates.filter(c => !instrumentDedupeKeys.has([c.instrumentDate ?? "", c.docNumber ?? "", c.recordedDate ?? ""].join("|")));

  for (const candidate of freshCandidates) {
    const { data: instrumentRow, error: instrumentInsertError } = await supabase.from("title_instruments").insert({
      run_id: runId, instrument_type: candidate.instrumentType, instrument_date: candidate.instrumentDate, recorded_date: candidate.recordedDate,
      doc_number: candidate.docNumber, book_volume_page: candidate.bookVolumePage, source: candidate.source, source_url_or_doc_id: candidate.sourceUrlOrDocId,
      evidence_level: "county_index_metadata", instrument_content_verified: false,
    }).select("id").single();
    if (instrumentInsertError || !instrumentRow) {
      warnings.push({ code: "INSTRUMENT_INSERT_FAILED", message: `Could not persist a county-clerk instrument: ${instrumentInsertError?.message}`, severity: "critical" });
      continue;
    }

    const partyRows = [
      ...candidate.grantorNames.map(name => ({ run_id: runId, instrument_id: instrumentRow.id, party_name: name, role: "grantor" })),
      ...candidate.granteeNames.map(name => ({ run_id: runId, instrument_id: instrumentRow.id, party_name: name, role: "grantee" })),
    ];
    if (partyRows.length > 0) {
      const { error: partyInsertError } = await supabase.from("title_instrument_parties").insert(partyRows);
      if (partyInsertError) warnings.push({ code: "PARTY_INSERT_FAILED", message: `Could not persist instrument parties: ${partyInsertError.message}`, severity: "critical" });
    }

    const { data: tractRow, error: tractInsertError } = await supabase.from("title_instrument_tracts").insert({
      run_id: runId, instrument_id: instrumentRow.id, county: candidate.county, legal_description: candidate.legalDescription,
    }).select("id").single();
    if (tractInsertError || !tractRow) {
      warnings.push({ code: "TRACT_INSERT_FAILED", message: `Could not persist instrument tract: ${tractInsertError?.message}`, severity: "critical" });
      continue;
    }

    const { error: claimInsertError } = await supabase.from("title_claims").insert({ run_id: runId, instrument_id: instrumentRow.id, instrument_tract_id: tractRow.id });
    if (claimInsertError) warnings.push({ code: "CLAIM_INSERT_FAILED", message: `Could not persist claim: ${claimInsertError.message}`, severity: "critical" });
  }

  // ── Re-read the full set now that fresh candidates are persisted ────────
  const [{ data: allInstrumentRows }, { data: allPartyRows }, { data: allTractRows }, { data: allClaimRows }] = await Promise.all([
    supabase.from("title_instruments").select("*").eq("run_id", runId),
    supabase.from("title_instrument_parties").select("*").eq("run_id", runId),
    supabase.from("title_instrument_tracts").select("*").eq("run_id", runId),
    supabase.from("title_claims").select("*").eq("run_id", runId),
  ]);

  const instruments = (allInstrumentRows as InstrumentRow[] | null ?? []).map(rowToInstrument);
  const instrumentsById = new Map(instruments.map(i => [i.id, i]));
  const parties = (allPartyRows as PartyRow[] | null ?? []).map(rowToParty);
  const tracts = (allTractRows as TractRow[] | null ?? []).map(rowToTract);
  const claims = (allClaimRows as ClaimRow[] | null ?? []).map(rowToClaim);

  // ── Step 3: canonical tract + party matching (persisted proposals) ──────
  const matching = matchTitleIdentities(tracts, parties);
  warnings.push(...matching.warnings);

  if (matching.tracts.length > 0) {
    const { error } = await supabase.from("title_canonical_tracts").insert(matching.tracts.map(t => ({
      id: t.id, run_id: runId, county: t.county, abstract_number: t.abstractNumber, survey_name: t.surveyName,
      block_number: t.blockNumber, section_name: t.sectionName, legal_description: t.legalDescription,
      confidence: t.confidence, resolution_method: t.resolutionMethod, resolution_trace: t.resolutionTrace,
      needs_user_selection: t.needsUserSelection, match_status: t.matchStatus,
    })));
    if (error) warnings.push({ code: "CANONICAL_TRACT_INSERT_FAILED", message: error.message, severity: "critical" });
  }
  if (matching.parties.length > 0) {
    const { error } = await supabase.from("title_canonical_parties").insert(matching.parties.map(p => ({
      id: p.id, run_id: runId, display_name: p.displayName, normalized_name: p.normalizedName,
      confidence: p.confidence, resolution_method: p.resolutionMethod, resolution_trace: p.resolutionTrace,
      needs_user_selection: p.needsUserSelection, match_status: p.matchStatus,
    })));
    if (error) warnings.push({ code: "CANONICAL_PARTY_INSERT_FAILED", message: error.message, severity: "critical" });
  }

  // Best-effort backfill of canonical ids onto the raw rows — never blocks the returned result.
  for (const [instrumentTractId, canonicalTractId] of Object.entries(matching.tractIdByInstrumentTractId)) {
    const t = tracts.find(x => x.id === instrumentTractId);
    if (t) t.canonicalTractId = canonicalTractId;
    await supabase.from("title_instrument_tracts").update({ canonical_tract_id: canonicalTractId }).eq("id", instrumentTractId);
  }
  for (const [instrumentPartyId, canonicalPartyId] of Object.entries(matching.partyIdByInstrumentPartyId)) {
    const p = parties.find(x => x.id === instrumentPartyId);
    if (p) p.canonicalPartyId = canonicalPartyId;
    await supabase.from("title_instrument_parties").update({ canonical_party_id: canonicalPartyId }).eq("id", instrumentPartyId);
  }
  const claimCanonicalUpdates: { claimId: string; canonicalAssetId: string }[] = [];
  for (const claim of claims) {
    const canonicalTractId = matching.tractIdByInstrumentTractId[claim.instrumentTractId];
    if (canonicalTractId) { claim.canonicalAssetId = canonicalTractId; claimCanonicalUpdates.push({ claimId: claim.id, canonicalAssetId: canonicalTractId }); }
  }
  await Promise.all(claimCanonicalUpdates.map(u => supabase.from("title_claims").update({ canonical_asset_id: u.canonicalAssetId }).eq("id", u.claimId)));

  // ── Step 4: build EnrichedClaim[] grouped by canonical tract ─────────────
  const partiesByInstrument = new Map<string, TitleInstrumentParty[]>();
  for (const p of parties) {
    const list = partiesByInstrument.get(p.instrumentId);
    if (list) list.push(p); else partiesByInstrument.set(p.instrumentId, [p]);
  }
  const tractsById = new Map(tracts.map(t => [t.id, t]));

  const enrichedByTract: Record<string, EnrichedClaim[]> = {};
  for (const claim of claims) {
    const instrument = instrumentsById.get(claim.instrumentId);
    const tract = tractsById.get(claim.instrumentTractId);
    if (!instrument || !tract || !tract.canonicalTractId) continue; // unmatched tracts are already surfaced as a warning above
    const instrumentParties = partiesByInstrument.get(instrument.id) ?? [];
    const enriched: EnrichedClaim = {
      claim, instrument, tract,
      grantors: instrumentParties.filter(p => p.role === "grantor"),
      grantees: instrumentParties.filter(p => p.role === "grantee"),
    };
    const list = enrichedByTract[tract.canonicalTractId];
    if (list) list.push(enriched); else enrichedByTract[tract.canonicalTractId] = [enriched];
  }

  // ── Step 5: timeline + surface-level checks ──────────────────────────────
  const timeline = buildTitleTimeline(matching.tracts, enrichedByTract);

  // ── Step 6: assessment ────────────────────────────────────────────────────
  return runTitleAssessment({ tracts: matching.tracts, timeline, enrichedByTract });
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persists a completed assessment to migration 027's assessment/findings/
 * evidence tables. Instruments/parties/tracts/claims/canonical identities
 * are NOT written here — they're already persisted incrementally during
 * runTitleResolution. Never throws — a write failure comes back as
 * {ok:false, error} so an already-computed in-memory result is never lost.
 */
export async function persistTitleAssessment(
  supabase: SupabaseClient,
  runId: string,
  result: TitleAssessmentResult,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error: assessmentError } = await supabase.from("title_assessments").upsert({
      run_id: runId,
      classification: result.classification,
      confidence: result.confidence,
      confidence_dimensions: result.confidenceDimensions,
      diligence_implication: result.diligenceImplication,
      label: result.label,
      instrument_count: result.instrumentCount,
      distinct_party_count: result.distinctPartyCount,
      earliest_instrument_date: result.earliestInstrumentDate,
      latest_instrument_date: result.latestInstrumentDate,
      unresolved_finding_count: result.unresolvedFindingCount,
      generated_at: result.generatedAt,
    }, { onConflict: "run_id" });
    if (assessmentError) return { ok: false, error: assessmentError.message };

    const findings = [...result.supportingFactors, ...result.contradictingFactors, ...result.risks, ...result.dataGaps];
    if (findings.length > 0) {
      const { error: findingsError } = await supabase.from("title_findings").insert(
        findings.map((f, i) => ({
          run_id: runId, category: f.category, classification: f.classification, finding_type: f.findingType,
          title: f.title, description: f.description, evidence_ids: f.evidenceIds, display_order: i,
        })),
      );
      if (findingsError) return { ok: false, error: findingsError.message };
    }

    if (result.evidence.length > 0) {
      const { error: evidenceError } = await supabase.from("title_evidence").insert(
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
