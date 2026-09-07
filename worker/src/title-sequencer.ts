/**
 * Title-chain research sequencer — the worker-side, network-bound half of
 * the API-number -> title-chain workflow. Polled from index.ts exactly like
 * the due-diligence sequencer, against title_research_jobs (migration 028).
 *
 * Stages (each idempotent; a retry resumes rather than restarts):
 *   1. resolving_wells   — per API: TRRC wellbore query, GIS location +
 *                          survey polygon, W-1 permit query, completion
 *                          records, CODA imaged documents. Available
 *                          W-1 / plat / completion images are downloaded,
 *                          hashed, stored, and recorded as title_documents.
 *   2. searching_records — county-clerk index searches through the
 *                          existing county-records providers (54 counties
 *                          automated; every other county gets an honest
 *                          provider_unavailable entry). Queries: lease
 *                          name, operator, survey/abstract text, then one
 *                          bounded round of follow-up searches on grantor
 *                          names discovered in the index results. Every
 *                          query is logged in title_search_log; index hits
 *                          become index-level (unverified) instruments.
 *   3. -> awaiting_tract_confirmation: the frontend proposes candidate
 *      tracts from this data and the user confirms before any chain is
 *      asserted.
 *
 * Nothing here interprets conveyance language — an index entry is stored
 * with instrument_content_verified=false and stays that way until an image
 * is reviewed by the frontend ingestion path.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as ewa from "./tools/ewa.js";
import * as browser from "./tools/browser.js";
import * as countyRecords from "./tools/county-records.js";

export const TITLE_DOCUMENTS_BUCKET = "title-documents";
export const MAX_CODA_DOCS_PER_WELL = 8;
export const MAX_COUNTY_QUERIES_PER_JOB = 12;
export const MAX_FOLLOWUP_QUERIES = 6;
export const MAX_DOC_BYTES = 30 * 1024 * 1024;

interface JobWellRow {
  id: string;
  api10: string | null;
  api14: string | null;
  county_name: string | null;
  resolution_status: string;
  operator_name: string | null;
  lease_name: string | null;
  survey_name: string | null;
  abstract_number: string | null;
}

export interface TitleJobDeps {
  searchWellbore: typeof ewa.searchWellbore;
  getGisLocation: typeof ewa.getGisLocation;
  getDrillingPermits: typeof ewa.getDrillingPermits;
  getCompletionRecords: typeof ewa.getCompletionRecords;
  getCodaDocuments: typeof browser.getCodaDocuments;
  getCountyRecords: typeof countyRecords.getCountyRecords;
  findProvider: typeof countyRecords.findProvider;
  fetchBytes: (url: string) => Promise<{ ok: boolean; bytes: Buffer; contentType: string | null; error?: string }>;
  now: () => string;
}

export const defaultDeps: TitleJobDeps = {
  searchWellbore: ewa.searchWellbore,
  getGisLocation: ewa.getGisLocation,
  getDrillingPermits: ewa.getDrillingPermits,
  getCompletionRecords: ewa.getCompletionRecords,
  getCodaDocuments: browser.getCodaDocuments,
  getCountyRecords: countyRecords.getCountyRecords,
  findProvider: countyRecords.findProvider,
  fetchBytes: async (url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000), headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" } });
      if (!res.ok) return { ok: false, bytes: Buffer.alloc(0), contentType: res.headers.get("content-type"), error: `HTTP ${res.status}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      return { ok: true, bytes, contentType: res.headers.get("content-type") };
    } catch (e) {
      return { ok: false, bytes: Buffer.alloc(0), contentType: null, error: String(e) };
    }
  },
  now: () => new Date().toISOString(),
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pick(obj: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function setJob(supabase: SupabaseClient, jobId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("title_research_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId);
  if (error) console.error(`[title ${jobId.slice(0, 8)}] job update failed:`, error.message);
}

async function logSearch(supabase: SupabaseClient, jobId: string, userId: string, entry: {
  provider: string; county: string | null; queryType: string; queryValue: string; status: string; resultCount: number; error?: string | null; sourceUrl?: string | null; depth?: number;
}): Promise<boolean> {
  // unique(job, provider, query_type, query_value): a repeated query is a no-op, which is also how the bounded loop dedupes.
  const { error } = await supabase.from("title_search_log").upsert({
    job_id: jobId, user_id: userId, provider: entry.provider, county: entry.county, query_type: entry.queryType, query_value: entry.queryValue,
    status: entry.status, result_count: entry.resultCount, error_message: entry.error ?? null, source_url: entry.sourceUrl ?? null, depth: entry.depth ?? 0, searched_at: new Date().toISOString(),
  }, { onConflict: "job_id,provider,query_type,query_value", ignoreDuplicates: false });
  if (error) console.error(`[title ${jobId.slice(0, 8)}] search log failed:`, error.message);
  return !error;
}

async function alreadySearched(supabase: SupabaseClient, jobId: string, provider: string, queryType: string, queryValue: string): Promise<boolean> {
  const { data } = await supabase.from("title_search_log").select("id").eq("job_id", jobId).eq("provider", provider).eq("query_type", queryType).eq("query_value", queryValue).limit(1);
  return !!data && data.length > 0;
}

async function addReviewItem(supabase: SupabaseClient, jobId: string, userId: string, kind: string, title: string, detail: string | null, payload: Record<string, unknown>): Promise<void> {
  const { data } = await supabase.from("title_review_items").select("id").eq("job_id", jobId).eq("kind", kind).eq("title", title).limit(1);
  if (data && data.length > 0) return;
  await supabase.from("title_review_items").insert({ job_id: jobId, user_id: userId, kind, title, detail, payload_json: payload });
}

async function appendLimitation(supabase: SupabaseClient, jobId: string, limitation: string): Promise<void> {
  const { data } = await supabase.from("title_research_jobs").select("limitations_json").eq("id", jobId).maybeSingle();
  const current = ((data?.limitations_json as string[] | null) ?? []);
  if (current.includes(limitation)) return;
  await supabase.from("title_research_jobs").update({ limitations_json: [...current, limitation] }).eq("id", jobId);
}

function categoryForCodaType(docType: string): string {
  const t = docType.toLowerCase();
  if (/w-?1|permit/.test(t)) return "w1_application";
  if (/plat/.test(t)) return "location_plat";
  if (/w-?2|g-?1|completion/.test(t)) return "completion_report";
  if (/lease|p-?12|pooling|unit/.test(t)) return "lease";
  return "other";
}

// ─── Stage 1: wells ──────────────────────────────────────────────────────────

export async function resolveWell(supabase: SupabaseClient, deps: TitleJobDeps, jobId: string, userId: string, well: JobWellRow): Promise<void> {
  if (!well.api10) return;
  const api = well.api10;
  const sourceUrls: Array<{ source: string; url: string | null; retrievedAt: string; status: string }> = [];
  const patch: Record<string, unknown> = {};
  let found = false;

  // Wellbore identity.
  const wb = await deps.searchWellbore(api).catch(e => ({ found: false, wells: [], lease_number: null, district: null, operator: null, operator_number: null, county: null, message: String(e), error: String(e) }));
  const wbUrl = `${ewa.PDA_BASE}/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${api.slice(2, 5)}&searchArgs.apiNoSuffixArg=${api.slice(5, 10)}`;
  sourceUrls.push({ source: "trrc_ewa", url: wbUrl, retrievedAt: deps.now(), status: wb.error ? "failed" : wb.found ? "success" : "empty" });
  await logSearch(supabase, jobId, userId, { provider: "trrc_ewa", county: well.county_name, queryType: "api", queryValue: api, status: wb.error ? "failed" : wb.found ? "success" : "empty", resultCount: wb.wells.length, error: wb.error ?? null, sourceUrl: wbUrl });
  if (wb.found) {
    found = true;
    const first = wb.wells[0] as Record<string, unknown> | undefined;
    patch.well_name = pick(first, ["lease_name", "well_name"]);
    patch.well_number = pick(first, ["well_no", "well_number"]);
    patch.operator_name = wb.operator ?? pick(first, ["operator_name", "operator"]);
    patch.operator_number = wb.operator_number ?? pick(first, ["operator_no", "operator_number"]);
    patch.district = wb.district ?? pick(first, ["district", "dist_code"]);
    patch.lease_number = wb.lease_number ?? pick(first, ["lease_no", "oil_lease_no"]);
    patch.lease_name = pick(first, ["lease_name"]);
    patch.field_name = pick(first, ["field_name"]);
    if (wb.county && !well.county_name) patch.county_name = wb.county;
  }

  // GIS location + survey polygon.
  const gis = await deps.getGisLocation(api).catch(e => ({ found: false, latitude: null, longitude: null, well_type: null, survey: null, alert_areas: [], message: String(e), error: String(e) }));
  const gisUrl = `https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer/1/query?where=API%3D%27${api.slice(2, 10)}%27`;
  sourceUrls.push({ source: "trrc_gis", url: gisUrl, retrievedAt: deps.now(), status: gis.error ? "failed" : gis.found ? "success" : "empty" });
  await logSearch(supabase, jobId, userId, { provider: "trrc_gis", county: well.county_name, queryType: "api", queryValue: api, status: gis.error ? "failed" : gis.found ? "success" : "empty", resultCount: gis.found ? 1 : 0, error: gis.error ?? null, sourceUrl: gisUrl });
  if (gis.found) {
    found = true;
    patch.latitude = gis.latitude;
    patch.longitude = gis.longitude;
    patch.well_path_json = gis.well_type ? { wellType: gis.well_type, surfacePoint: { latitude: gis.latitude, longitude: gis.longitude }, lateral: null } : null;
    if (gis.survey) {
      patch.survey_name = gis.survey.survey_name || null;
      patch.abstract_number = gis.survey.abstract_number ? `A-${gis.survey.abstract_number.replace(/^A-?/i, "")}` : null;
      patch.block_number = gis.survey.block_number || null;
      patch.section_name = gis.survey.section_name || null;
    }
  }

  // Permits.
  const permits = await deps.getDrillingPermits(api).catch(e => ({ found: false, permits: [], message: String(e), error: String(e) }));
  const permitUrl = `${ewa.PDA_BASE}/drillingPermitsQueryAction.do?searchArgs.apiNoHndlr.inputValue=${api.slice(2, 10)}`;
  sourceUrls.push({ source: "trrc_permits", url: permitUrl, retrievedAt: deps.now(), status: permits.error ? "failed" : permits.found ? "success" : "empty" });
  await logSearch(supabase, jobId, userId, { provider: "trrc_ewa", county: well.county_name, queryType: "api", queryValue: `${api}:permits`, status: permits.error ? "failed" : permits.found ? "success" : "empty", resultCount: permits.permits.length, error: permits.error ?? null, sourceUrl: permitUrl });
  if (permits.found) { found = true; patch.permit_refs_json = permits.permits; }

  // Completions.
  const completions = await deps.getCompletionRecords(api).catch(e => ({ found: false, records: [], message: String(e), error: String(e) }));
  sourceUrls.push({ source: "trrc_completions", url: null, retrievedAt: deps.now(), status: completions.error ? "failed" : completions.found ? "success" : "empty" });
  await logSearch(supabase, jobId, userId, { provider: "trrc_ewa", county: well.county_name, queryType: "api", queryValue: `${api}:completions`, status: completions.error ? "failed" : completions.found ? "success" : "empty", resultCount: completions.records.length, error: completions.error ?? null });
  if (completions.found) { found = true; patch.completion_refs_json = completions.records; }

  // CODA imaged documents -> stored originals.
  const coda = await deps.getCodaDocuments(api).catch(e => ({ found: false, documents: [], document_types_present: [], coda_search_url: "", message: String(e), error: String(e) }));
  sourceUrls.push({ source: "trrc_coda", url: coda.coda_search_url || null, retrievedAt: deps.now(), status: coda.error ? "failed" : coda.found ? "success" : "empty" });
  await logSearch(supabase, jobId, userId, { provider: "trrc_coda", county: well.county_name, queryType: "api", queryValue: api, status: coda.error ? "failed" : coda.found ? "success" : "empty", resultCount: coda.documents.length, error: coda.error ?? null, sourceUrl: coda.coda_search_url || null });
  if (coda.found) {
    found = true;
    const relevant = coda.documents.filter(d => d.direct_url && /w-?1|permit|plat|w-?2|g-?1|completion|lease|p-?12|pooling|unit/i.test(d.document_type)).slice(0, MAX_CODA_DOCS_PER_WELL);
    for (const d of relevant) {
      await storeRemoteDocument(supabase, deps, jobId, userId, well.id, {
        url: d.direct_url, source: "trrc_coda", sourceIdentifier: d.document_id || `${d.document_type} ${d.document_date}`, category: categoryForCodaType(d.document_type), fileName: `${api}-${(d.document_type || "doc").replace(/[^a-z0-9]+/gi, "_")}-${d.document_id || d.document_date || "x"}.pdf`,
      });
    }
  }

  patch.source_urls_json = sourceUrls;
  patch.retrieved_at = deps.now();
  patch.resolution_status = found ? "resolved" : (wb.error && gis.error) ? "error" : "not_found";
  patch.resolution_error = found ? null : (wb.error ?? gis.error ?? "Well not found in TRRC wellbore, GIS, permit, or completion records");
  await supabase.from("title_job_wells").update(patch).eq("id", well.id);
}

async function storeRemoteDocument(supabase: SupabaseClient, deps: TitleJobDeps, jobId: string, userId: string, wellId: string | null, doc: { url: string; source: string; sourceIdentifier: string; category: string; fileName: string }): Promise<void> {
  const fetched = await deps.fetchBytes(doc.url);
  if (!fetched.ok || fetched.bytes.length === 0) {
    await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "failed", resultCount: 0, error: fetched.error ?? "empty response", sourceUrl: doc.url });
    return;
  }
  if (fetched.bytes.length > MAX_DOC_BYTES) {
    await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "failed", resultCount: 0, error: `document exceeds ${MAX_DOC_BYTES} bytes`, sourceUrl: doc.url });
    return;
  }
  const isPdf = fetched.bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  const contentType = isPdf ? "application/pdf" : (fetched.contentType ?? "application/octet-stream").split(";")[0];
  if (!isPdf && /text\/html/.test(contentType)) {
    // A viewer page, not the image — keep the link in the log, don't store HTML as a document.
    await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "empty", resultCount: 0, error: "link resolved to an HTML viewer page, not a document image", sourceUrl: doc.url });
    return;
  }
  const hash = sha256(fetched.bytes);
  const { data: existing } = await supabase.from("title_documents").select("id").eq("job_id", jobId).eq("content_hash", hash).maybeSingle();
  if (existing) return; // same bytes already stored for this job (e.g. two wells sharing a unit plat)

  const ext = isPdf ? "pdf" : contentType.includes("tiff") ? "tif" : contentType.includes("png") ? "png" : contentType.includes("jpeg") ? "jpg" : "bin";
  const storagePath = `${userId}/${jobId}/${hash}.${ext}`;
  const { error: upErr } = await supabase.storage.from(TITLE_DOCUMENTS_BUCKET).upload(storagePath, fetched.bytes, { contentType, upsert: true });
  if (upErr) {
    await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "failed", resultCount: 0, error: `storage upload failed: ${upErr.message}`, sourceUrl: doc.url });
    return;
  }
  await supabase.from("title_documents").insert({
    job_id: jobId, user_id: userId, well_id: wellId, source: doc.source, source_identifier: doc.sourceIdentifier, source_url: doc.url, retrieved_at: deps.now(),
    document_category: doc.category, file_name: doc.fileName.replace(/\.pdf$/, `.${ext}`), mime_type: contentType, byte_size: fetched.bytes.length, storage_path: storagePath,
    content_hash: hash, ocr_status: "pending", extraction_status: "pending",
  });
  await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "success", resultCount: 1, sourceUrl: doc.url });
}

// ─── Stage 2: county index ───────────────────────────────────────────────────

type IndexEntry = countyRecords.CountyRecordEntry;

function normalizeDocType(docType: string): string {
  const t = docType.toLowerCase();
  if (/mineral deed/.test(t)) return "mineral_deed";
  if (/royalty/.test(t)) return "royalty_deed";
  if (/deed of trust/.test(t)) return "deed_of_trust";
  if (/release/.test(t)) return "release";
  if (/assign/.test(t)) return "assignment";
  if (/lease/.test(t)) return "lease";
  if (/heirship/.test(t)) return "affidavit_of_heirship";
  if (/probate|will|letters/.test(t)) return "probate";
  if (/lien|judgment/.test(t)) return "lien";
  if (/deed/.test(t)) return "deed";
  return "other";
}

function effectForType(type: string): string {
  switch (type) {
    case "lease": return "lease_grant";
    case "assignment": return "assignment";
    case "release": return "release";
    case "deed_of_trust": case "lien": return "encumbrance";
    case "probate": case "affidavit_of_heirship": return "succession";
    case "other": return "other";
    default: return "conveyance";
  }
}

function splitIndexNames(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (/\bet ux\b|\bet vir\b|\bet al\b/i.test(s)) return [s.replace(/\bet (ux|vir|al)\b/gi, "").trim()];
  return s.split(/\s*(?:&|;|\band\b)\s*/i).map(x => x.trim()).filter(x => x.length >= 3);
}

export async function storeIndexEntries(supabase: SupabaseClient, jobId: string, county: string, sourceUrl: string, entries: IndexEntry[]): Promise<{ inserted: number; grantorNames: string[] }> {
  let inserted = 0;
  const grantorNames = new Set<string>();
  for (const r of entries) {
    const dedupe = createHash("sha1").update(["index", county, r.doc_number, r.recorded_date, r.grantor, r.grantee, r.doc_type].join("|")).digest("hex");
    const { data: existing } = await supabase.from("title_instruments").select("id").eq("job_id", jobId).eq("dedupe_key", dedupe).limit(1);
    if (existing && existing.length > 0) continue;
    const type = normalizeDocType(r.doc_type ?? "");
    const { data: inst, error } = await supabase.from("title_instruments").insert({
      job_id: jobId, run_id: null, instrument_type: type, instrument_date: null, recorded_date: r.recorded_date || null,
      doc_number: r.doc_number || null, instrument_number: r.doc_number || null, book_volume_page: r.book_volume_page || null, county,
      source: "county_record_index", source_url_or_doc_id: sourceUrl, evidence_level: "county_index_metadata", instrument_content_verified: false,
      extraction_json: { index: r }, dedupe_key: dedupe,
    }).select("id").single();
    if (error || !inst) continue;
    inserted++;
    const parties = [
      ...splitIndexNames(r.grantor ?? "").map(n => ({ job_id: jobId, run_id: null, instrument_id: inst.id, party_name: n, party_name_verbatim: r.grantor, role: "grantor", capacity: "unknown" })),
      ...splitIndexNames(r.grantee ?? "").map(n => ({ job_id: jobId, run_id: null, instrument_id: inst.id, party_name: n, party_name_verbatim: r.grantee, role: "grantee", capacity: "unknown" })),
    ];
    if (parties.length > 0) await supabase.from("title_instrument_parties").insert(parties);
    for (const n of splitIndexNames(r.grantor ?? "")) grantorNames.add(n);
    const { data: tract } = await supabase.from("title_instrument_tracts").insert({
      job_id: jobId, run_id: null, instrument_id: inst.id, county, legal_description: r.legal_description || null, legal_description_verbatim: r.legal_description || null, interest_type: "unknown",
    }).select("id").single();
    if (tract) {
      await supabase.from("title_claims").insert({ job_id: jobId, run_id: null, instrument_id: inst.id, instrument_tract_id: tract.id, canonical_asset_id: null, effect: effectForType(type), interest_type: "unknown", notes: "County index entry — not interpreted" });
    }
  }
  return { inserted, grantorNames: Array.from(grantorNames) };
}

export async function searchCountyRecordsForJob(supabase: SupabaseClient, deps: TitleJobDeps, jobId: string, userId: string, wells: JobWellRow[]): Promise<void> {
  let queries = 0;
  const followups: Array<{ county: string; name: string }> = [];
  const unavailable = new Set<string>();

  for (const well of wells) {
    if (well.resolution_status !== "resolved" || !well.county_name) continue;
    const county = well.county_name;
    const provider = deps.findProvider(county);
    if (!provider) {
      if (!unavailable.has(county)) {
        unavailable.add(county);
        await logSearch(supabase, jobId, userId, { provider: "none", county, queryType: "party_name", queryValue: well.lease_name ?? well.operator_name ?? "(none)", status: "provider_unavailable", resultCount: 0, error: `No automated county-records provider for ${county} County`, sourceUrl: `https://www.texasfile.com/search/texas/${county.toLowerCase().replace(/\s+/g, "-")}-county/county-clerk-records/` });
        await appendLimitation(supabase, jobId, `No automated county-records provider for ${county} County; county instruments must be uploaded or pasted.`);
        await addReviewItem(supabase, jobId, userId, "provider_unavailable", `County records for ${county} County must be supplied manually`, "No supported provider covers this county. Search the clerk's records (TexasFile link in the coverage log) and upload the instruments to this job.", { county });
      }
      continue;
    }
    const providerId = `county:${provider.provider.id}`;
    const candidates: Array<{ type: string; value: string }> = [];
    if (well.lease_name) candidates.push({ type: "lease_name", value: well.lease_name });
    if (well.survey_name) candidates.push({ type: "legal_description", value: well.abstract_number ? `${well.survey_name} ${well.abstract_number}` : well.survey_name });
    if (well.operator_name) candidates.push({ type: "operator", value: well.operator_name });

    for (const q of candidates) {
      if (queries >= MAX_COUNTY_QUERIES_PER_JOB) {
        await logSearch(supabase, jobId, userId, { provider: providerId, county, queryType: q.type, queryValue: q.value, status: "skipped_bounded", resultCount: 0, error: `Query budget of ${MAX_COUNTY_QUERIES_PER_JOB} reached` });
        continue;
      }
      if (await alreadySearched(supabase, jobId, providerId, q.type, q.value)) continue;
      queries++;
      const r = await deps.getCountyRecords(county, q.value).catch(e => ({ found: false, status: "automated" as const, county, provider: provider.provider.id, records: [] as IndexEntry[], total_count: 0, search_url: "", message: String(e), error: String(e) }));
      const status = r.error ? "failed" : r.status === "manual_required" ? "provider_unavailable" : r.records.length > 0 ? "success" : "empty";
      await logSearch(supabase, jobId, userId, { provider: providerId, county, queryType: q.type, queryValue: q.value, status, resultCount: r.records.length, error: r.error ?? null, sourceUrl: r.search_url });
      if (r.records.length > 0) {
        const stored = await storeIndexEntries(supabase, jobId, county, r.search_url, r.records);
        for (const n of stored.grantorNames) followups.push({ county, name: n });
      }
    }
  }

  // One bounded round of predecessor follow-up on grantor names discovered in the index.
  let follow = 0;
  for (const f of followups) {
    if (follow >= MAX_FOLLOWUP_QUERIES || queries >= MAX_COUNTY_QUERIES_PER_JOB) {
      await logSearch(supabase, jobId, userId, { provider: "county:followup", county: f.county, queryType: "party_name", queryValue: f.name, status: "skipped_bounded", resultCount: 0, error: "Follow-up budget reached", depth: 1 });
      continue;
    }
    const provider = deps.findProvider(f.county);
    if (!provider) continue;
    const providerId = `county:${provider.provider.id}`;
    if (await alreadySearched(supabase, jobId, providerId, "party_name", f.name)) continue;
    follow++; queries++;
    const r = await deps.getCountyRecords(f.county, f.name).catch(e => ({ found: false, status: "automated" as const, county: f.county, provider: provider.provider.id, records: [] as IndexEntry[], total_count: 0, search_url: "", message: String(e), error: String(e) }));
    const status = r.error ? "failed" : r.records.length > 0 ? "success" : "empty";
    await logSearch(supabase, jobId, userId, { provider: providerId, county: f.county, queryType: "party_name", queryValue: f.name, status, resultCount: r.records.length, error: r.error ?? null, sourceUrl: r.search_url, depth: 1 });
    if (r.records.length > 0) await storeIndexEntries(supabase, jobId, f.county, r.search_url, r.records);
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function runTitleResearchJob(jobId: string, supabase: SupabaseClient, deps: TitleJobDeps = defaultDeps): Promise<void> {
  const { data: job } = await supabase.from("title_research_jobs").select("id, user_id, status, attempt_count").eq("id", jobId).single();
  if (!job) return;
  const userId = job.user_id as string;

  const isCancelled = async () => {
    const { data } = await supabase.from("title_research_jobs").select("status").eq("id", jobId).single();
    return data?.status === "cancelled";
  };

  await setJob(supabase, jobId, { status: "resolving_wells", stage_detail: "Resolving wells with TRRC", progress_percent: 5, attempt_count: (job.attempt_count as number) + 1, started_at: new Date().toISOString() });

  const { data: wellRows } = await supabase.from("title_job_wells").select("id, api10, api14, county_name, resolution_status, operator_name, lease_name, survey_name, abstract_number").eq("job_id", jobId);
  const wells = ((wellRows ?? []) as JobWellRow[]).filter(w => !!w.api10);
  const pendingWells = wells.filter(w => w.resolution_status === "unresolved" || w.resolution_status === "error");

  for (let i = 0; i < pendingWells.length; i++) {
    if (await isCancelled()) return;
    const w = pendingWells[i];
    await setJob(supabase, jobId, { stage_detail: `Resolving ${w.api14 ?? w.api10} (${i + 1}/${pendingWells.length})`, progress_percent: 5 + Math.round((i / Math.max(1, pendingWells.length)) * 50) });
    try {
      await resolveWell(supabase, deps, jobId, userId, w);
    } catch (e) {
      await supabase.from("title_job_wells").update({ resolution_status: "error", resolution_error: String(e).slice(0, 300) }).eq("id", w.id);
    }
  }

  if (await isCancelled()) return;
  await setJob(supabase, jobId, { status: "searching_records", stage_detail: "Searching county records", progress_percent: 60 });
  const { data: refreshed } = await supabase.from("title_job_wells").select("id, api10, api14, county_name, resolution_status, operator_name, lease_name, survey_name, abstract_number").eq("job_id", jobId);
  await searchCountyRecordsForJob(supabase, deps, jobId, userId, (refreshed ?? []) as JobWellRow[]);

  if (await isCancelled()) return;
  const resolvedCount = ((refreshed ?? []) as JobWellRow[]).filter(w => w.resolution_status === "resolved").length;
  await setJob(supabase, jobId, {
    status: "awaiting_tract_confirmation",
    stage_detail: resolvedCount > 0 ? "Review candidate tracts and confirm the subject tract(s)" : "No well could be resolved — supply a legal description or documents to continue",
    progress_percent: 100,
  });
}
