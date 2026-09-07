/**
 * Document ingestion: text extraction -> validated instrument extraction
 * (deterministic always; Claude when configured, cached by content hash)
 * -> persistence into 027's normalized tables (title_instruments,
 * title_instrument_parties, title_instrument_tracts, title_claims) with
 * canonical tract/party matching and review-queue entries for anything
 * ambiguous.
 *
 * Resumable and idempotent: each document carries extraction_status; an
 * instrument is keyed by dedupe_key so the same instrument arriving from
 * two documents (or the same document uploaded twice) is stored once and
 * the duplicate is surfaced as a review note. Bounded: a call processes at
 * most `limit` documents so a route stays inside its execution budget and
 * the UI simply calls again while `remaining > 0`.
 */

import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractDocumentText, sha256Hex } from "./document-text";
import { parseInstrumentText } from "./instrument-parser";
import { extractWithClaude, claudeExtractionAvailable } from "./claude-extractor";
import { validateExtractedDocument, type ExtractedDocument, type ExtractedInstrument, type ExtractedTract } from "./instrument-schema";
import { EXTRACTION_SCHEMA_VERSION, type CandidateTract } from "./chain-types";
import { proposeTracts, tractKey, tractLabelFor } from "./tract-candidates";
import { mapTractRow, tractToRow, addReviewItem, appendLimitation, mapWellRow, type DocumentRow } from "./job-store";
import { matchParties } from "./asset-matching";
import { findIdentityCandidates } from "./chain-findings";
import type { TitleInstrumentParty } from "./types";

export const TITLE_DOCUMENTS_BUCKET = "title-documents";

export interface IngestResult {
  processed: number;
  remaining: number;
  instrumentsCreated: number;
  duplicatesSkipped: number;
  errors: Array<{ documentId: string; error: string }>;
  modelUsed: boolean;
}

export function instrumentDedupeKey(inst: ExtractedInstrument): string {
  const parties = inst.parties.map(p => `${p.role}:${p.name.toLowerCase().replace(/\s+/g, " ").trim()}`).sort().join(";");
  const raw = [
    inst.instrumentType,
    inst.instrumentNumber ?? "",
    inst.bookVolumePage ?? "",
    inst.recordingDate.iso ?? "",
    inst.executionDate.iso ?? "",
    parties,
  ].join("|");
  return createHash("sha1").update(raw).digest("hex");
}

async function loadCachedExtraction(supabase: SupabaseClient, userId: string, contentHash: string, extractor: "deterministic" | "claude"): Promise<ExtractedDocument | null> {
  const { data } = await supabase.from("title_document_extractions").select("extraction_json")
    .eq("user_id", userId).eq("content_hash", contentHash).eq("schema_version", EXTRACTION_SCHEMA_VERSION).eq("extractor", extractor).maybeSingle();
  if (!data) return null;
  const v = validateExtractedDocument(data.extraction_json);
  return v.ok ? v.data : null;
}

async function cacheExtraction(supabase: SupabaseClient, userId: string, contentHash: string, extractor: "deterministic" | "claude", model: string | null, doc: ExtractedDocument): Promise<void> {
  await supabase.from("title_document_extractions").upsert({
    user_id: userId, content_hash: contentHash, schema_version: EXTRACTION_SCHEMA_VERSION, extractor, model, extraction_json: doc,
  }, { onConflict: "user_id,content_hash,schema_version,extractor" });
}

/** Deterministic first; Claude layered on when available. Returns the document to persist plus which extractor produced it. */
async function extractInstruments(supabase: SupabaseClient, userId: string, jobId: string, doc: DocumentRow, text: string): Promise<{ document: ExtractedDocument; extractor: "deterministic" | "claude"; modelUsed: boolean }> {
  let deterministic = await loadCachedExtraction(supabase, userId, doc.content_hash, "deterministic");
  if (!deterministic) {
    deterministic = parseInstrumentText(text);
    await cacheExtraction(supabase, userId, doc.content_hash, "deterministic", null, deterministic);
  }

  if (!claudeExtractionAvailable()) {
    await appendLimitation(supabase, jobId, "Model-assisted extraction was not available (no ANTHROPIC_API_KEY); instruments were parsed by deterministic pattern matching only and should be reviewed against the images.");
    return { document: deterministic, extractor: "deterministic", modelUsed: false };
  }

  const cachedClaude = await loadCachedExtraction(supabase, userId, doc.content_hash, "claude");
  if (cachedClaude) return { document: mergeExtractions(cachedClaude, deterministic), extractor: "claude", modelUsed: false };

  const result = await extractWithClaude(text, { fileName: doc.file_name, documentCategory: doc.document_category });
  if (result.ok && result.document) {
    await cacheExtraction(supabase, userId, doc.content_hash, "claude", result.model, result.document);
    return { document: mergeExtractions(result.document, deterministic), extractor: "claude", modelUsed: true };
  }
  await appendLimitation(supabase, jobId, `Model-assisted extraction failed for "${doc.file_name ?? doc.id}": ${result.error ?? "unknown error"}. Deterministic parse used instead.`);
  return { document: deterministic, extractor: "deterministic", modelUsed: result.available };
}

/** The model result is primary; deterministic alternatives and notes are carried along so nothing the parser flagged is lost. */
function mergeExtractions(primary: ExtractedDocument, secondary: ExtractedDocument): ExtractedDocument {
  const merged: ExtractedDocument = { ...primary, notes: [...primary.notes, ...secondary.notes.map(n => `[deterministic] ${n}`)] };
  if (merged.instruments.length === 0 && secondary.instruments.length > 0) merged.instruments = secondary.instruments;
  else if (merged.instruments.length > 0 && secondary.instruments[0]) {
    const detAlts = secondary.instruments[0].alternatives.filter(a => !merged.instruments[0].alternatives.some(b => b.field === a.field));
    merged.instruments[0] = { ...merged.instruments[0], alternatives: [...merged.instruments[0].alternatives, ...detAlts] };
  }
  if (merged.legalDescriptions.length === 0) merged.legalDescriptions = secondary.legalDescriptions;
  return merged;
}

async function readDocumentBytes(supabase: SupabaseClient, doc: DocumentRow): Promise<Buffer | null> {
  if (!doc.storage_path) return null;
  const { data, error } = await supabase.storage.from(TITLE_DOCUMENTS_BUCKET).download(doc.storage_path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

function tractFieldsFromExtracted(t: ExtractedTract) {
  return { county: t.county, abstractNumber: t.abstractNumber, surveyName: t.surveyName, blockNumber: t.blockNumber, sectionName: t.sectionName, legalDescription: t.legalDescriptionVerbatim, grossAcres: t.grossAcres };
}

/** Matches an extracted tract to the job's canonical tracts; proposes a new one when the description carries enough signal. */
function matchCanonicalTract(t: ExtractedTract, tracts: CandidateTract[]): { tractId: string | null; created: CandidateTract | null; reason: string } {
  const fields = tractFieldsFromExtracted(t);
  const key = tractKey(fields);
  if (!key) return { tractId: null, created: null, reason: "Instrument tract has no usable legal-description components" };
  for (const c of tracts) {
    if (tractKey(c) === key) return { tractId: c.id, created: null, reason: `Matched ${c.tractLabel} on ${key.startsWith("legal:") ? "legal description text" : "county/abstract/survey/block/section"}` };
  }
  // Looser: same county + same abstract number, or same survey + block + section.
  for (const c of tracts) {
    const sameCounty = !fields.county || !c.county || fields.county.toLowerCase() === c.county.toLowerCase();
    const sameAbs = fields.abstractNumber && c.abstractNumber && fields.abstractNumber.replace(/\D/g, "") === c.abstractNumber.replace(/\D/g, "");
    if (sameCounty && sameAbs) return { tractId: c.id, created: null, reason: `Matched ${c.tractLabel} on county + abstract number` };
  }
  const created: CandidateTract = {
    id: randomUUID(), tractLabel: tractLabelFor(fields), county: fields.county, abstractNumber: fields.abstractNumber, surveyName: fields.surveyName,
    blockNumber: fields.blockNumber, sectionName: fields.sectionName, legalDescription: fields.legalDescription, grossAcres: fields.grossAcres,
    confidence: 0.4, resolutionMethod: "instrument_legal_description", resolutionTrace: ["Proposed from an instrument's legal description; not yet linked to a well"],
    needsUserSelection: true, matchStatus: "proposed",
  };
  return { tractId: created.id, created, reason: "No existing tract matched; proposed a new candidate for review" };
}

export async function ingestPendingDocuments(supabase: SupabaseClient, userId: string, jobId: string, opts: { limit?: number } = {}): Promise<IngestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
  const result: IngestResult = { processed: 0, remaining: 0, instrumentsCreated: 0, duplicatesSkipped: 0, errors: [], modelUsed: false };

  const { data: pending } = await supabase.from("title_documents").select("*").eq("job_id", jobId).eq("user_id", userId).eq("extraction_status", "pending").order("created_at", { ascending: true }).limit(limit + 1);
  const docs = ((pending ?? []) as DocumentRow[]);
  const batch = docs.slice(0, limit);
  result.remaining = Math.max(0, docs.length - batch.length);

  if (batch.length === 0) return result;

  const [{ data: tractRows }, { data: wellRows }] = await Promise.all([
    supabase.from("title_canonical_tracts").select("*").eq("job_id", jobId),
    supabase.from("title_job_wells").select("*").eq("job_id", jobId),
  ]);
  const tracts = ((tractRows ?? []) as Record<string, unknown>[]).map(mapTractRow);
  const wells = ((wellRows ?? []) as Record<string, unknown>[]).map(mapWellRow);

  for (const doc of batch) {
    try {
      // 1. Text.
      let text = doc.extracted_text ?? "";
      if (!text.trim()) {
        const bytes = await readDocumentBytes(supabase, doc);
        if (!bytes) throw new Error("Stored document bytes could not be read");
        const extracted = await extractDocumentText(bytes, doc.mime_type, doc.file_name);
        await supabase.from("title_documents").update({
          extracted_text: extracted.text || null, page_count: extracted.pageCount, has_text_layer: extracted.hasTextLayer, ocr_status: extracted.ocrStatus,
        }).eq("id", doc.id);
        if (extracted.ocrStatus === "failed" || !extracted.text.trim()) {
          await supabase.from("title_documents").update({ extraction_status: "failed", extraction_error: extracted.error ?? "No text could be extracted" }).eq("id", doc.id);
          await addReviewItem(supabase, jobId, userId, { kind: "ocr_failed", title: `Could not read "${doc.file_name ?? doc.id}"`, detail: extracted.error, payload: { documentId: doc.id } });
          result.errors.push({ documentId: doc.id, error: extracted.error ?? "No text" });
          result.processed++;
          continue;
        }
        text = extracted.text;
      }

      // 2. Extraction (cached by hash).
      const { document: extractedDoc, extractor, modelUsed } = await extractInstruments(supabase, userId, jobId, doc, text);
      if (modelUsed) result.modelUsed = true;

      // 3. Non-instrument legal descriptions -> tract candidates + well associations.
      if (extractedDoc.legalDescriptions.length > 0) {
        const proposal = proposeTracts({
          wells,
          documentLegals: extractedDoc.legalDescriptions.map(t => ({ wellId: doc.well_id, documentId: doc.id, sourceUrl: doc.source_url, tract: t, category: extractedDoc.documentKind })),
          existingTracts: tracts,
        });
        for (const t of proposal.tracts) {
          if (!tracts.some(x => x.id === t.id)) { tracts.push(t); await supabase.from("title_canonical_tracts").insert(tractToRow(t, jobId)); }
          else await supabase.from("title_canonical_tracts").update({ resolution_trace: t.resolutionTrace, confidence: t.confidence, gross_acres: t.grossAcres }).eq("id", t.id);
        }
        for (const a of proposal.associations) {
          await supabase.from("title_well_tract_associations").upsert({
            job_id: jobId, user_id: userId, well_id: a.wellId, canonical_tract_id: a.canonicalTractId, association_type: a.associationType,
            confidence: a.confidence, evidence_json: a.evidence, review_status: "proposed",
          }, { onConflict: "well_id,canonical_tract_id,association_type", ignoreDuplicates: true });
        }
      }

      // 4. Instruments.
      for (const inst of extractedDoc.instruments) {
        const dedupeKey = instrumentDedupeKey(inst);
        const { data: existing } = await supabase.from("title_instruments").select("id, document_id").eq("job_id", jobId).eq("dedupe_key", dedupeKey).limit(1);
        if (existing && existing.length > 0) {
          result.duplicatesSkipped++;
          if (existing[0].document_id !== doc.id) {
            await addReviewItem(supabase, jobId, userId, { kind: "extraction_ambiguity", title: `Duplicate instrument in "${doc.file_name ?? doc.id}"`, detail: "This document contains an instrument already ingested from another document (same type, recording reference, dates, and parties). It was not stored twice.", payload: { documentId: doc.id, existingInstrumentId: existing[0].id } });
          }
          continue;
        }

        const { data: instRow, error: instErr } = await supabase.from("title_instruments").insert({
          job_id: jobId, run_id: null, document_id: doc.id,
          instrument_type: inst.instrumentType, instrument_date: inst.executionDate.iso, execution_date: inst.executionDate.iso, effective_date: inst.effectiveDate.iso, recorded_date: inst.recordingDate.iso,
          doc_number: inst.instrumentNumber, instrument_number: inst.instrumentNumber, book_volume_page: inst.bookVolumePage, county: inst.county,
          source: doc.source, source_url_or_doc_id: doc.source_url ?? doc.source_identifier, source_doc_id: doc.id,
          source_page: inst.verbatimExcerpts[0]?.page ?? 1, source_exact_language: inst.verbatimExcerpts[0]?.text ?? null,
          extraction_confidence: inst.confidence, evidence_level: "instrument_verified", instrument_content_verified: true,
          referenced_instruments_json: inst.references, signature_observations_json: inst.signatureObservations, acknowledgment_observations_json: inst.acknowledgmentObservations,
          extraction_json: { ...inst, extractor }, dedupe_key: dedupeKey,
        }).select("id").single();
        if (instErr || !instRow) throw new Error(`Instrument insert failed: ${instErr?.message}`);
        const instrumentId = instRow.id as string;
        result.instrumentsCreated++;

        if (inst.parties.length > 0) {
          await supabase.from("title_instrument_parties").insert(inst.parties.map(p => ({
            job_id: jobId, run_id: null, instrument_id: instrumentId, party_name: p.name, party_name_verbatim: p.nameVerbatim, role: p.role, capacity: p.capacity,
            capacity_detail: p.capacityDetail, source_page: p.page, source_excerpt: p.excerpt,
          })));
        }

        for (const t of inst.tracts) {
          const match = matchCanonicalTract(t, tracts);
          if (match.created) {
            tracts.push(match.created);
            await supabase.from("title_canonical_tracts").insert(tractToRow(match.created, jobId));
            await addReviewItem(supabase, jobId, userId, { kind: "tract_match", title: `Instrument describes a tract not yet linked to a well: ${match.created.tractLabel}`, detail: `From "${doc.file_name ?? doc.id}". Confirm whether this is one of the subject tracts, or reject it.`, payload: { canonicalTractId: match.created.id, documentId: doc.id, instrumentId } });
          } else if (!match.tractId) {
            await addReviewItem(supabase, jobId, userId, { kind: "tract_match", title: `Instrument tract could not be matched (${inst.instrumentType.replace(/_/g, " ")} in "${doc.file_name ?? doc.id}")`, detail: match.reason, payload: { documentId: doc.id, instrumentId } });
          }
          const { data: tractRow, error: tractErr } = await supabase.from("title_instrument_tracts").insert({
            job_id: jobId, run_id: null, instrument_id: instrumentId, county: t.county, legal_description: t.legalDescriptionVerbatim, legal_description_verbatim: t.legalDescriptionVerbatim,
            abstract_number: t.abstractNumber, survey_name: t.surveyName, block_number: t.blockNumber, section_name: t.sectionName, gross_acres: t.grossAcres,
            interest_type: t.interestType, fraction_numerator: t.fraction?.numerator ?? null, fraction_denominator: t.fraction?.denominator ?? null,
            fraction_basis: t.fraction?.basis ?? null, fraction_verbatim: t.fraction?.verbatim ?? null,
            interest_conveyed_fraction: t.fraction?.numerator != null && t.fraction?.denominator ? t.fraction.numerator / t.fraction.denominator : null,
            reservation_text: t.reservationText, exceptions_text: t.exceptionsText, depth_or_formation_limit: t.depthOrFormationLimit,
            source_page: t.page, source_excerpt: t.excerpt, canonical_tract_id: match.tractId,
          }).select("id").single();
          if (tractErr || !tractRow) throw new Error(`Instrument tract insert failed: ${tractErr?.message}`);
          await supabase.from("title_claims").insert({
            job_id: jobId, run_id: null, instrument_id: instrumentId, instrument_tract_id: tractRow.id, canonical_asset_id: match.tractId,
            effect: t.effect, interest_type: t.interestType, fraction_numerator: t.fraction?.numerator ?? null, fraction_denominator: t.fraction?.denominator ?? null,
            fraction_basis: t.fraction?.basis ?? null, notes: match.reason,
          });
        }

        for (const alt of inst.alternatives) {
          await addReviewItem(supabase, jobId, userId, { kind: "extraction_ambiguity", title: `Ambiguous ${alt.field.replace(/_/g, " ")} in ${inst.instrumentType.replace(/_/g, " ")} (${inst.instrumentNumber ?? inst.bookVolumePage ?? doc.file_name ?? doc.id})`, detail: `${alt.reason} Readings: ${alt.interpretations.join(" | ")}`, payload: { instrumentId, documentId: doc.id, field: alt.field, interpretations: alt.interpretations } });
        }
      }

      await supabase.from("title_documents").update({ extraction_status: "done", extraction_error: null }).eq("id", doc.id);
      result.processed++;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 400);
      await supabase.from("title_documents").update({ extraction_status: "failed", extraction_error: msg }).eq("id", doc.id);
      result.errors.push({ documentId: doc.id, error: msg });
      result.processed++;
    }
  }

  await canonicalizeParties(supabase, userId, jobId);
  return result;
}

/** Exact normalized-name grouping -> canonical parties; similar-but-different names -> review items only. */
export async function canonicalizeParties(supabase: SupabaseClient, userId: string, jobId: string): Promise<void> {
  const { data: partyRows } = await supabase.from("title_instrument_parties").select("id, instrument_id, party_name, role, capacity, canonical_party_id, capacity_detail, source_page, source_excerpt").eq("job_id", jobId);
  const parties = ((partyRows ?? []) as Record<string, unknown>[]);
  if (parties.length === 0) return;

  const { data: existingCanon } = await supabase.from("title_canonical_parties").select("id, normalized_name").eq("job_id", jobId);
  const canonByNorm = new Map<string, string>(((existingCanon ?? []) as Array<{ id: string; normalized_name: string }>).map(c => [c.normalized_name, c.id]));

  const asInstrumentParties: TitleInstrumentParty[] = parties.map(p => ({
    id: String(p.id), instrumentId: String(p.instrument_id), partyName: String(p.party_name), role: (p.role as TitleInstrumentParty["role"]), capacity: (p.capacity as TitleInstrumentParty["capacity"]), canonicalPartyId: (p.canonical_party_id as string | null) ?? null,
  }));
  const matched = matchParties(asInstrumentParties);

  for (const cp of matched.parties) {
    let id = canonByNorm.get(cp.normalizedName);
    if (!id) {
      const { data } = await supabase.from("title_canonical_parties").insert({
        id: cp.id, job_id: jobId, run_id: null, display_name: cp.displayName, normalized_name: cp.normalizedName, confidence: cp.confidence,
        resolution_method: cp.resolutionMethod, resolution_trace: cp.resolutionTrace, needs_user_selection: false, match_status: "proposed",
      }).select("id").single();
      id = (data?.id as string | undefined) ?? cp.id;
      canonByNorm.set(cp.normalizedName, id);
    }
    const memberIds = Object.entries(matched.partyIdByInstrumentPartyId).filter(([, cid]) => cid === cp.id).map(([pid]) => pid);
    for (const pid of memberIds) {
      const row = parties.find(p => String(p.id) === pid);
      if (row && row.canonical_party_id !== id) await supabase.from("title_instrument_parties").update({ canonical_party_id: id }).eq("id", pid);
    }
  }

  const candidates = findIdentityCandidates(parties.map(p => ({
    id: String(p.id), instrumentId: String(p.instrument_id), name: String(p.party_name), role: p.role as never, capacity: p.capacity as never,
    capacityDetail: (p.capacity_detail as string | null) ?? null, canonicalPartyId: (p.canonical_party_id as string | null) ?? null, page: (p.source_page as number | null) ?? null, excerpt: (p.source_excerpt as string | null) ?? null,
  })));
  for (const c of candidates) {
    await addReviewItem(supabase, jobId, userId, {
      kind: "identity_match", title: `Same person? "${c.a.name}" and "${c.b.name}"`, detail: `${c.reason}. Treated as different parties until confirmed.`,
      payload: { partyIdA: c.a.id, partyIdB: c.b.id, nameA: c.a.name, nameB: c.b.name },
    });
  }
}

/** Stores a user-supplied document (file bytes or pasted text) idempotently by content hash. */
export async function storeUserDocument(supabase: SupabaseClient, userId: string, jobId: string, input: {
  bytes: Buffer | null; pastedText: string | null; fileName: string | null; mimeType: string | null; documentCategory: string; wellId: string | null; label: string | null;
}): Promise<{ ok: true; documentId: string; duplicate: boolean } | { ok: false; error: string }> {
  const content = input.bytes ?? Buffer.from(input.pastedText ?? "", "utf8");
  if (content.length === 0) return { ok: false, error: "Empty document." };
  const hash = sha256Hex(content);

  const { data: existing } = await supabase.from("title_documents").select("id").eq("job_id", jobId).eq("content_hash", hash).maybeSingle();
  if (existing) return { ok: true, documentId: existing.id as string, duplicate: true };

  let storagePath: string | null = null;
  if (input.bytes) {
    const ext = (input.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] ?? (input.mimeType === "application/pdf" ? "pdf" : "bin")).toLowerCase();
    storagePath = `${userId}/${jobId}/${hash}.${ext}`;
    const { error: upErr } = await supabase.storage.from(TITLE_DOCUMENTS_BUCKET).upload(storagePath, input.bytes, { contentType: input.mimeType ?? "application/octet-stream", upsert: true });
    if (upErr) return { ok: false, error: `Storage upload failed: ${upErr.message}` };
  }

  const { data, error } = await supabase.from("title_documents").insert({
    job_id: jobId, user_id: userId, well_id: input.wellId, source: input.bytes ? "user_upload" : "pasted_text", source_identifier: input.label ?? input.fileName,
    source_url: null, document_category: input.documentCategory, file_name: input.fileName ?? (input.label ? `${input.label}.txt` : "pasted.txt"), mime_type: input.mimeType ?? "text/plain",
    byte_size: content.length, storage_path: storagePath, content_hash: hash, extracted_text: input.bytes ? null : input.pastedText, has_text_layer: input.bytes ? null : true,
    ocr_status: input.bytes ? "pending" : "not_needed", extraction_status: "pending",
  }).select("id").single();
  if (error || !data) return { ok: false, error: `Document insert failed: ${error?.message}` };
  return { ok: true, documentId: data.id as string, duplicate: false };
}
