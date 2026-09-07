/**
 * runTitleChainAnalysis — loads a research job's persisted rows, runs the
 * deterministic ownership graph + cross-cutting findings, applies the
 * status aggregation rule, and persists a new versioned TitleChainAnalysis
 * (title_analyses) plus its findings (title_findings). The returned object
 * is the single source every report surface renders from.
 *
 * Idempotent: an input fingerprint (instrument/claim ids + review states +
 * scope) is stored with each version; re-running on unchanged inputs
 * returns the existing latest version instead of writing another.
 */

import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Fraction } from "./fraction";
import { buildOwnershipGraph, type GraphClaim, type GraphInstrument, type GraphParty } from "./ownership-graph";
import { buildCrossCuttingFindings, aggregateStatus, sortFindings } from "./chain-findings";
import { loadJobBundle, formattedApi } from "./job-store";
import {
  TITLE_CHAIN_SCHEMA_VERSION, STATUS_DISPLAY, STATUS_AGGREGATION_RULE, TITLE_CHAIN_REPORT_STATEMENT,
  type ChronologyRow, type TitleChainAnalysis, type WellSummary, type PartyRef, type ChainEvent, type CandidateTract,
} from "./chain-types";
import type { ExtractedReference } from "./instrument-schema";

export type AnalysisResult =
  | { ok: true; analysis: TitleChainAnalysis; reused: boolean }
  | { ok: false; error: string; status: number };

function renderParties(list: PartyRef[]): string {
  return list.map(p => p.displayName).join(", ") || "—";
}

export function chronologyFromBranches(events: Array<{ event: ChainEvent; tractLabel: string; interestType: ChronologyRow["interestType"] }>): ChronologyRow[] {
  const rows = events.map(({ event: e, tractLabel, interestType }) => ({
    rowId: e.eventId,
    instrumentId: e.instrumentId,
    documentId: e.documentId,
    sortDate: e.sortDate,
    dateBasis: e.dateBasis,
    executionDate: e.executionDate,
    effectiveDate: e.effectiveDate,
    recordedDate: e.recordedDate,
    instrumentType: e.instrumentType,
    parties: `${renderParties(e.from)} → ${renderParties(e.to)}`,
    fromParties: e.from,
    toParties: e.to,
    recordingReference: e.recordingReference,
    tractLabel,
    interestType,
    effect: e.effect,
    fraction: e.fractionVerbatim ?? (e.statedFraction ? Fraction.fromJson(e.statedFraction)?.toString() ?? null : null),
    contentVerified: e.contentVerified,
    notes: e.notes.join("; "),
    citations: e.citations,
  }));
  const key = (d: string | null) => (d ? Date.parse(d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d) : Number.POSITIVE_INFINITY);
  return rows.sort((a, b) => (key(a.sortDate) - key(b.sortDate)) || a.tractLabel.localeCompare(b.tractLabel));
}

export async function runTitleChainAnalysis(supabase: SupabaseClient, userId: string, jobId: string): Promise<AnalysisResult> {
  const bundle = await loadJobBundle(supabase, jobId, userId);
  if (!bundle) return { ok: false, error: "Job not found or access denied.", status: 404 };
  const { job, wells, tracts, associations, documents, reviewItems, searchLog } = bundle;

  const [instRes, partyRes, tractRes, claimRes] = await Promise.all([
    supabase.from("title_instruments").select("*").eq("job_id", jobId),
    supabase.from("title_instrument_parties").select("*").eq("job_id", jobId),
    supabase.from("title_instrument_tracts").select("*").eq("job_id", jobId),
    supabase.from("title_claims").select("*").eq("job_id", jobId),
  ]);
  const instRows = (instRes.data ?? []) as Record<string, unknown>[];
  const partyRows = (partyRes.data ?? []) as Record<string, unknown>[];
  const tractRows = (tractRes.data ?? []) as Record<string, unknown>[];
  const claimRows = (claimRes.data ?? []) as Record<string, unknown>[];
  const docsById = new Map(documents.map(d => [d.id, d]));

  const instruments: GraphInstrument[] = instRows.map(r => ({
    id: String(r.id),
    documentId: (r.document_id as string | null) ?? null,
    instrumentType: (r.instrument_type as GraphInstrument["instrumentType"]) ?? "other",
    executionDate: (r.execution_date as string | null) ?? (r.instrument_date as string | null) ?? null,
    effectiveDate: (r.effective_date as string | null) ?? null,
    recordedDate: (r.recorded_date as string | null) ?? null,
    instrumentNumber: (r.instrument_number as string | null) ?? (r.doc_number as string | null) ?? null,
    bookVolumePage: (r.book_volume_page as string | null) ?? null,
    county: (r.county as string | null) ?? null,
    contentVerified: Boolean(r.instrument_content_verified),
    references: ((r.referenced_instruments_json as ExtractedReference[]) ?? []),
    signatureObservations: ((r.signature_observations_json as GraphInstrument["signatureObservations"]) ?? []),
    sourceUrl: (r.source_url_or_doc_id as string | null) ?? docsById.get(String(r.document_id))?.source_url ?? null,
    sourcePage: (r.source_page as number | null) ?? null,
  }));

  const parties: GraphParty[] = partyRows.map(r => ({
    id: String(r.id), instrumentId: String(r.instrument_id), name: String(r.party_name), role: (r.role as GraphParty["role"]) ?? "other",
    capacity: (r.capacity as GraphParty["capacity"]) ?? "unknown", capacityDetail: (r.capacity_detail as string | null) ?? null,
    canonicalPartyId: (r.canonical_party_id as string | null) ?? null, page: (r.source_page as number | null) ?? null, excerpt: (r.source_excerpt as string | null) ?? null,
  }));

  const tractsById = new Map(tractRows.map(r => [String(r.id), r]));
  const claims: GraphClaim[] = claimRows.map(r => {
    const t = tractsById.get(String(r.instrument_tract_id)) ?? {};
    const num = (r.fraction_numerator ?? t.fraction_numerator) as number | string | null | undefined;
    const den = (r.fraction_denominator ?? t.fraction_denominator) as number | string | null | undefined;
    let fraction: Fraction | null = null;
    if (num !== null && num !== undefined && den !== null && den !== undefined && Number(den) !== 0) fraction = new Fraction(BigInt(Number(num)), BigInt(Number(den)));
    return {
      id: String(r.id), instrumentId: String(r.instrument_id), instrumentTractId: String(r.instrument_tract_id), canonicalTractId: (r.canonical_asset_id as string | null) ?? null,
      effect: (r.effect as GraphClaim["effect"]) ?? "conveyance", interestType: ((r.interest_type ?? t.interest_type) as GraphClaim["interestType"]) ?? "unknown",
      fraction, fractionBasis: ((r.fraction_basis ?? t.fraction_basis) as GraphClaim["fractionBasis"]) ?? "unknown", fractionVerbatim: (t.fraction_verbatim as string | null) ?? null,
      reservationText: (t.reservation_text as string | null) ?? null, exceptionsText: (t.exceptions_text as string | null) ?? null,
      legalDescription: (t.legal_description as string | null) ?? null, page: (t.source_page as number | null) ?? null, excerpt: (t.source_excerpt as string | null) ?? null,
      reviewStatus: (r.human_review_status as GraphClaim["reviewStatus"]) ?? "unreviewed",
    };
  });

  // Fingerprint for idempotency.
  const fingerprint = createHash("sha256").update(JSON.stringify({
    scope: job.interest_scope, start: job.research_start_date, asOf: job.as_of_date,
    instruments: instruments.map(i => i.id).sort(), claims: claims.map(c => `${c.id}:${c.canonicalTractId}:${c.reviewStatus}`).sort(),
    parties: parties.map(p => `${p.id}:${p.canonicalPartyId}`).sort(), tracts: tracts.map(t => `${t.id}:${t.matchStatus}`).sort(),
    associations: associations.map(a => `${a.id}:${a.reviewStatus}`).sort(), docs: documents.map(d => `${d.id}:${d.extraction_status}`).sort(),
    schema: TITLE_CHAIN_SCHEMA_VERSION,
  })).digest("hex");
  const { data: latest } = await supabase.from("title_analyses").select("id, version, input_fingerprint, analysis_json").eq("job_id", jobId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (latest && latest.input_fingerprint === fingerprint) {
    return { ok: true, analysis: latest.analysis_json as TitleChainAnalysis, reused: true };
  }

  const confirmedTracts: CandidateTract[] = tracts.filter(t => t.matchStatus === "confirmed");
  const graph = buildOwnershipGraph({ tracts: confirmedTracts, instruments, parties, claims, interestScope: job.interest_scope });

  const providerUnavailable = Array.from(new Set(searchLog.filter(s => s.status === "provider_unavailable").map(s => s.county).filter((c): c is string => !!c)));
  const ocrFailed = documents.filter(d => d.ocr_status === "failed").map(d => d.id);
  const limitations: string[] = [...(job.limitations_json ?? [])];
  if (confirmedTracts.length === 0) limitations.push("No tract has been confirmed; ownership branches cannot be built until a candidate tract is confirmed or a legal description is supplied.");
  const unlinkedClaims = claims.filter(c => !c.canonicalTractId).length;
  if (unlinkedClaims > 0) limitations.push(`${unlinkedClaims} instrument tract(s) are not linked to a confirmed tract and are excluded from the branches (see review queue).`);
  const proposedOnly = tracts.filter(t => t.matchStatus === "proposed").length;
  if (proposedOnly > 0) limitations.push(`${proposedOnly} candidate tract(s) remain unconfirmed and are excluded from the branches.`);
  for (const c of providerUnavailable) limitations.push(`No automated county-records provider for ${c} County; only TRRC documents and uploads were reviewed.`);
  if (job.research_start_date) limitations.push(`Research start date ${job.research_start_date} was requested; instruments before that date were not sought. The earliest holder shown is the earliest evidenced holder in reviewed records, not an established root of title.`);

  const cross = buildCrossCuttingFindings({ tracts: confirmedTracts, instruments, parties, claims, limitations, providerUnavailableCounties: providerUnavailable, ocrFailedDocumentIds: ocrFailed });
  const findings = sortFindings([...graph.findings, ...cross]);

  const verifiedOnConfirmed = new Set(claims.filter(c => c.canonicalTractId && confirmedTracts.some(t => t.id === c.canonicalTractId) && instruments.find(i => i.id === c.instrumentId)?.contentVerified).map(c => c.instrumentId)).size;
  const status = aggregateStatus({ findings, confirmedTractCount: confirmedTracts.length, verifiedInstrumentsOnConfirmedTracts: verifiedOnConfirmed });

  const chronology = chronologyFromBranches(graph.branches.flatMap(b => b.events.map(event => ({ event, tractLabel: b.tractLabel, interestType: b.interestType }))));

  const tractLabel = (id: string) => tracts.find(t => t.id === id)?.tractLabel ?? id;
  const wellSummaries: WellSummary[] = wells.map(w => ({
    wellId: w.id, originalInput: w.originalInput, api14: w.api14, formatted: formattedApi(w), wellName: w.wellName, operatorName: w.operatorName, countyName: w.countyName,
    resolutionStatus: w.resolutionStatus, validationError: w.validationError, resolutionError: w.resolutionError,
    associations: associations.filter(a => a.wellId === w.id).map(a => ({ tractId: a.canonicalTractId, tractLabel: tractLabel(a.canonicalTractId), associationType: a.associationType, confidence: a.confidence, reviewStatus: a.reviewStatus })),
  }));

  const instrumentsByDoc = new Map<string, string[]>();
  for (const i of instruments) if (i.documentId) instrumentsByDoc.set(i.documentId, [...(instrumentsByDoc.get(i.documentId) ?? []), i.id]);

  const version = (latest?.version ?? 0) + 1;
  const analysisId = randomUUID();
  const analysis: TitleChainAnalysis = {
    schemaVersion: TITLE_CHAIN_SCHEMA_VERSION,
    analysisId, jobId, version,
    generatedAt: new Date().toISOString(),
    interestScope: job.interest_scope,
    researchStartDate: job.research_start_date,
    asOfDate: job.as_of_date,
    status, statusDisplay: STATUS_DISPLAY[status], statusRule: STATUS_AGGREGATION_RULE,
    wells: wellSummaries,
    tracts,
    branches: graph.branches,
    chronology,
    findings,
    sourceInventory: documents.map(d => ({
      documentId: d.id, source: d.source, sourceIdentifier: d.source_identifier, sourceUrl: d.source_url, fileName: d.file_name, documentCategory: d.document_category,
      contentHash: d.content_hash, retrievedAt: d.retrieved_at, pageCount: d.page_count, hasTextLayer: d.has_text_layer, ocrStatus: d.ocr_status, extractionStatus: d.extraction_status,
      instrumentIds: instrumentsByDoc.get(d.id) ?? [],
    })),
    searchCoverage: searchLog.map(s => ({ provider: s.provider, county: s.county, queryType: s.query_type, queryValue: s.query_value, dateFrom: s.date_from, dateTo: s.date_to, status: s.status, resultCount: s.result_count, errorMessage: s.error_message, sourceUrl: s.source_url, searchedAt: s.searched_at })),
    limitations,
    reviewQueueOpenCount: reviewItems.filter(r => r.status === "open").length,
    statement: TITLE_CHAIN_REPORT_STATEMENT,
  };

  const { error: insErr } = await supabase.from("title_analyses").insert({
    id: analysisId, job_id: jobId, user_id: userId, version, schema_version: TITLE_CHAIN_SCHEMA_VERSION, status_classification: status, analysis_json: analysis, input_fingerprint: fingerprint,
  });
  if (insErr) return { ok: false, error: `Could not persist analysis: ${insErr.message}`, status: 500 };

  if (findings.length > 0) {
    await supabase.from("title_findings").insert(findings.map((f, i) => ({
      job_id: jobId, run_id: null, analysis_id: analysisId, category: f.type === "SUCCESSION_EVIDENCE" ? "supporting" : ["OVER_CONVEYANCE", "CONFLICTING_CONVEYANCE", "FRACTION_INCONSISTENCY"].includes(f.type) ? "contradicting" : "gap",
      classification: "inferred", finding_type: f.type, title: f.title, description: f.explanation, severity: f.severity, affected_tract_id: f.affectedTractId,
      affected_interest_type: f.affectedInterestType, citations_json: f.citations, next_action: f.nextAction, display_order: i,
    })));
  }

  // 027's title_assessments is unique on run_id (null for jobs), so replace the job's row explicitly rather than upserting.
  await supabase.from("title_assessments").delete().eq("job_id", jobId);
  await supabase.from("title_assessments").insert({
    job_id: jobId, run_id: null, classification: status, confidence: verifiedOnConfirmed >= 5 ? "MODERATE" : verifiedOnConfirmed > 0 ? "LOW" : "INSUFFICIENT_DATA",
    confidence_dimensions: { verifiedInstruments: verifiedOnConfirmed, confirmedTracts: confirmedTracts.length, openReviewItems: analysis.reviewQueueOpenCount },
    diligence_implication: STATUS_DISPLAY[status], instrument_count: instruments.length, distinct_party_count: new Set(parties.map(p => p.canonicalPartyId ?? p.id)).size,
    earliest_instrument_date: chronology[0]?.sortDate ?? null, latest_instrument_date: chronology[chronology.length - 1]?.sortDate ?? null,
    unresolved_finding_count: findings.filter(f => f.severity !== "info").length, generated_at: analysis.generatedAt,
  });

  await supabase.from("title_research_jobs").update({ latest_analysis_id: analysisId, status: "complete", progress_percent: 100, completed_at: new Date().toISOString(), stage_detail: `Analysis v${version}` }).eq("id", jobId);

  return { ok: true, analysis, reused: false };
}
