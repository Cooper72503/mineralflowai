import { tractQueries, indexMatchesTract, type SearchTract } from "./title-tract-search.js";
import { persistSurfaceTractCandidates } from "./title-tract-handoff.js";
import { checkedQuery, PipelinePersistenceError } from "./persistence.js";
import { canonicalApi10 } from "./identity.js";
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

import { getCountyDocument } from "./tools/county-documents.js";

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
  getCountyDocument?: typeof getCountyDocument;
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
  getCountyDocument,
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
  const { error } = await checkedQuery(supabase.from("title_research_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId).neq("status", "cancelled"), "title_research_jobs");
  if (error) console.error(`[title ${jobId.slice(0, 8)}] job update failed:`, error.message);
}

async function logSearch(supabase: SupabaseClient, jobId: string, userId: string, entry: {
  provider: string; county: string | null; queryType: string; queryValue: string; status: string; resultCount: number; error?: string | null; sourceUrl?: string | null; depth?: number;
}): Promise<boolean> {
  // unique(job, provider, query_type, query_value): a repeated query is a no-op, which is also how the bounded loop dedupes.
  const { error } = await checkedQuery(supabase.from("title_search_log").upsert({
    job_id: jobId, user_id: userId, provider: entry.provider, county: entry.county, query_type: entry.queryType, query_value: entry.queryValue,
    status: entry.status, result_count: entry.resultCount, error_message: entry.error ?? null, source_url: entry.sourceUrl ?? null, depth: entry.depth ?? 0, searched_at: new Date().toISOString(),
  }, { onConflict: "job_id,provider,query_type,query_value", ignoreDuplicates: false }), "title_search_log");
  if (error) console.error(`[title ${jobId.slice(0, 8)}] search log failed:`, error.message);
  return !error;
}

async function alreadySearched(supabase: SupabaseClient, jobId: string, provider: string, queryType: string, queryValue: string): Promise<boolean> {
  const { data } = await checkedQuery(supabase.from("title_search_log").select("id").eq("job_id", jobId).eq("provider", provider).eq("query_type", queryType).eq("query_value", queryValue).in("status", ["success", "empty"]).limit(1), "title_search_log");
  return !!data && data.length > 0;
}

async function addReviewItem(supabase: SupabaseClient, jobId: string, userId: string, kind: string, title: string, detail: string | null, payload: Record<string, unknown>): Promise<void> {
  const { data } = await checkedQuery(supabase.from("title_review_items").select("id").eq("job_id", jobId).eq("kind", kind).eq("title", title).limit(1), "title_review_items");
  if (data && data.length > 0) return;
  await checkedQuery(supabase.from("title_review_items").insert({ job_id: jobId, user_id: userId, kind, title, detail, payload_json: payload }), "title_review_items");
}

async function appendLimitation(supabase: SupabaseClient, jobId: string, limitation: string): Promise<void> {
  const { data } = await checkedQuery(supabase.from("title_research_jobs").select("limitations_json").eq("id", jobId).maybeSingle(), "title_research_jobs");
  const current = ((data?.limitations_json as string[] | null) ?? []);
  if (current.includes(limitation)) return;
  await checkedQuery(supabase.from("title_research_jobs").update({ limitations_json: [...current, limitation] }).eq("id", jobId), "title_research_jobs");
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
  const matchingWells = wb.wells.filter(w => canonicalApi10(w.api_no) === canonicalApi10(api));
  const currentWells = matchingWells.filter(w => String(w.on_schedule ?? "").trim().toUpperCase() === "Y");
  const matchedWell = currentWells.length === 1 ? currentWells[0]
    : currentWells.length === 0 && matchingWells.length === 1 ? matchingWells[0] : undefined;
  if (matchingWells.length > 1 && !matchedWell) {
    Object.assign(patch, { well_name: null, well_number: null, lease_name: null,
      lease_number: null, district: null, operator_name: null, operator_number: null, field_name: null });
    await addReviewItem(supabase, jobId, userId, "well_identity_ambiguous", `Multiple wellbore associations require review: ${api}`,
      "No unique current row exists for the API. Lease, operator and well-number fields are withheld.", { api, records: matchingWells });
  }
  if (wb.found && matchedWell) {
    found = true;
    const first = matchedWell as Record<string, unknown>;
    patch.well_name = pick(first, ["lease_name", "well_name"]);
    patch.well_number = pick(first, ["well_no", "well_number"]);
    patch.operator_name = pick(first, ["operator_name", "operator"]) ?? (matchingWells.length === 1 ? wb.operator : null);
    patch.operator_number = pick(first, ["operator_no", "operator_number"]) ?? (matchingWells.length === 1 ? wb.operator_number : null);
    patch.district = pick(first, ["district", "dist_code"]) ?? (matchingWells.length === 1 ? wb.district : null);
    patch.lease_number = pick(first, ["lease_no", "oil_lease_no"]) ?? (matchingWells.length === 1 ? wb.lease_number : null);
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
  await checkedQuery(supabase.from("title_job_wells").update(patch).eq("id", well.id), "title_job_wells");
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
  const { data: existing } = await checkedQuery(supabase.from("title_documents").select("id").eq("job_id", jobId).eq("content_hash", hash).maybeSingle(), "title_documents");
  if (existing) return; // same bytes already stored for this job (e.g. two wells sharing a unit plat)

  const ext = isPdf ? "pdf" : contentType.includes("tiff") ? "tif" : contentType.includes("png") ? "png" : contentType.includes("jpeg") ? "jpg" : "bin";
  const storagePath = `${userId}/${jobId}/${hash}.${ext}`;
  const { error: upErr } = await checkedQuery(supabase.storage.from(TITLE_DOCUMENTS_BUCKET).upload(storagePath, fetched.bytes, { contentType, upsert: true }), "title storage");
  if (upErr) {
    await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "failed", resultCount: 0, error: `storage upload failed: ${upErr.message}`, sourceUrl: doc.url });
    return;
  }
  await checkedQuery(supabase.from("title_documents").insert({
    job_id: jobId, user_id: userId, well_id: wellId, source: doc.source, source_identifier: doc.sourceIdentifier, source_url: doc.url, retrieved_at: deps.now(),
    document_category: doc.category, file_name: doc.fileName.replace(/\.pdf$/, `.${ext}`), mime_type: contentType, byte_size: fetched.bytes.length, storage_path: storagePath,
    content_hash: hash, ocr_status: "pending", extraction_status: "pending",
  }), "title_documents");
  await logSearch(supabase, jobId, userId, { provider: doc.source, county: null, queryType: "document", queryValue: doc.url, status: "success", resultCount: 1, sourceUrl: doc.url });
}

// ─── Stage 2: county index ───────────────────────────────────────────────────

type IndexEntry = countyRecords.CountyRecordEntry;

function normalizeDocType(docType: string): string {
  const t = docType.toLowerCase();
  if (/mineral deed/.test(t)) return "mineral_deed";
  if (/royalty/.test(t)) return "royalty_deed";
  if (/deed of trust/.test(t)) return "deed_of_trust";
  // Clerks abbreviate: Midland indexes a lease release as "REL OIL&GAS LS".
  // Mirrored by frontend/lib/trrc/title/clerk-types.ts; change both together.
  if (/release|\brel\b/.test(t)) return "release";
  if (/assign/.test(t)) return "assignment";
  if (/lease|\bo\s*&\s*g\s+ls\b|\bls\b/.test(t)) return "lease";
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

// A trailing entity designator. "&"/"and" inside such a name is part of the
// name, not a list: TEXAS & PACIFIC RAILWAY COMPANY is the sovereign-grant
// root of title for every T&P survey section, and splitting it cut the chain
// at its origin. The same split produced "P PIPE" (from T&P PIPE AND SUPPLY
// INC) and "BOB" (from BOB & TONI MIDKIFF LTD), both of which were then
// spent as predecessor searches.
const ENTITY_SUFFIX = /\b(?:INC|INCORPORATED|LLC|L\.?L\.?C|LTD|LIMITED|LP|L\.?P|LLP|CO|COMPANY|CORP|CORPORATION|ASN|ASSN|ASSOCIATION|BANK|TRUST|PARTNERSHIP|PARTNERS?|FACTORY|ESTATE|FOUNDATION|FUND|UNIT)\.?$/i;

export function splitIndexNames(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (/\bet ux\b|\bet vir\b|\bet al\b/i.test(s)) return [s.replace(/\bet (ux|vir|al)\b/gi, "").trim()];
  const names: string[] = [];
  // ";" always separates parties; "&"/"and" only sometimes does.
  for (const part of s.split(/\s*;\s*/)) {
    const pieces = part.split(/\s*(?:&|\band\b)\s*/i).map(x => x.trim());
    const joinsOneEntity = ENTITY_SUFFIX.test(part) && pieces.slice(0, -1).every(p => !ENTITY_SUFFIX.test(p));
    // "K & S LAND CO INC", "T&P ..." — a one- or two-letter side is an initial, not a party.
    const initials = pieces.some(p => p.replace(/[^A-Za-z]/g, "").length <= 2);
    if (pieces.length === 1 || joinsOneEntity || initials) names.push(part.trim());
    else names.push(...pieces);
  }
  return names.filter(x => x.length >= 3);
}

/**
 * Recompute type and parties for index rows stored under an older mapping
 * or splitter, from the clerk's verbatim doc type and grantor/grantee kept in
 * extraction_json.index.
 * Rows whose parties already match are untouched; read-document instruments
 * are never touched. Runs at the start of county search, so resuming a job
 * repairs it.
 */
async function pagedRows(page: (from: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, label: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await checkedQuery(page(from), label);
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function repairIndexParties(supabase: SupabaseClient, jobId: string): Promise<number> {
  // Paged: PostgREST returns 1,000 rows per request and truncates silently.
  // An unpaged read here made rows past the cap look partyless, so their
  // correct parties were deleted and rewritten.
  const rows = await pagedRows(page => supabase.from("title_instruments").select("id, instrument_type, extraction_json").eq("job_id", jobId).is("document_id", null).order("id").range(page, page + 999), "title_instruments");
  const stored = await pagedRows(page => supabase.from("title_instrument_parties").select("instrument_id, party_name, role").eq("job_id", jobId).order("id").range(page, page + 999), "title_instrument_parties");
  const have = new Map<string, string[]>();
  for (const p of stored as Array<{ instrument_id: string; party_name: string; role: string }>) {
    have.set(p.instrument_id, [...(have.get(p.instrument_id) ?? []), `${p.role}:${p.party_name}`]);
  }
  let repaired = 0;
  for (const r of rows as Array<{ id: string; instrument_type: string; extraction_json: { index?: { grantor?: string; grantee?: string; doc_type?: string } } | null }>) {
    const index = r.extraction_json?.index;
    if (!index) continue;
    // Re-type rows stored under an older clerk-type mapping ("REL OIL&GAS LS" was "other").
    const type = normalizeDocType(index.doc_type ?? "");
    if (type !== r.instrument_type) {
      await checkedQuery(supabase.from("title_instruments").update({ instrument_type: type }).eq("id", r.id), "title_instruments");
      await checkedQuery(supabase.from("title_claims").update({ effect: effectForType(type) }).eq("instrument_id", r.id).eq("human_review_status", "unreviewed"), "title_claims");
      repaired++;
    }
    const want = [
      ...splitIndexNames(index.grantor ?? "").map(n => ({ party_name: n, party_name_verbatim: index.grantor ?? null, role: "grantor" })),
      ...splitIndexNames(index.grantee ?? "").map(n => ({ party_name: n, party_name_verbatim: index.grantee ?? null, role: "grantee" })),
    ];
    const current = (have.get(r.id) ?? []).sort().join("|");
    if (want.map(p => `${p.role}:${p.party_name}`).sort().join("|") === current) continue;
    await checkedQuery(supabase.from("title_instrument_parties").delete().eq("instrument_id", r.id), "title_instrument_parties");
    if (want.length) await checkedQuery(supabase.from("title_instrument_parties").insert(want.map(p => ({ job_id: jobId, run_id: null, instrument_id: r.id, capacity: "unknown", ...p }))), "title_instrument_parties");
    repaired++;
  }
  return repaired;
}

export async function storeIndexEntries(supabase: SupabaseClient, jobId: string, county: string, sourceUrl: string, entries: IndexEntry[]): Promise<{ inserted: number; grantorNames: string[] }> {
  let inserted = 0;
  const grantorNames = new Set<string>();
  for (const r of entries) {
    const dedupe = createHash("sha1").update(["index", county, r.doc_number, r.recorded_date, r.grantor, r.grantee, r.doc_type].join("|")).digest("hex");
    const { data: existing } = await checkedQuery(supabase.from("title_instruments").select("id").eq("job_id", jobId).eq("dedupe_key", dedupe).limit(1), "title_instruments");
    if (existing && existing.length > 0) continue;
    const type = normalizeDocType(r.doc_type ?? "");
    const { data: inst, error } = await checkedQuery(supabase.from("title_instruments").insert({
      job_id: jobId, run_id: null, instrument_type: type, instrument_date: null, recorded_date: r.recorded_date || null,
      doc_number: r.doc_number || null, instrument_number: r.doc_number || null, book_volume_page: r.book_volume_page || null, county,
      source: "county_record_index", source_url_or_doc_id: sourceUrl, evidence_level: "county_index_metadata", instrument_content_verified: false,
      extraction_json: { index: r }, dedupe_key: dedupe,
    }).select("id").single(), "title_instruments");
    if (error || !inst) continue;
    inserted++;
    const parties = [
      ...splitIndexNames(r.grantor ?? "").map(n => ({ job_id: jobId, run_id: null, instrument_id: inst.id, party_name: n, party_name_verbatim: r.grantor, role: "grantor", capacity: "unknown" })),
      ...splitIndexNames(r.grantee ?? "").map(n => ({ job_id: jobId, run_id: null, instrument_id: inst.id, party_name: n, party_name_verbatim: r.grantee, role: "grantee", capacity: "unknown" })),
    ];
    if (parties.length > 0) await checkedQuery(supabase.from("title_instrument_parties").insert(parties), "title_instrument_parties");
    for (const n of splitIndexNames(r.grantor ?? "")) grantorNames.add(n);
    const { data: tract } = await checkedQuery(supabase.from("title_instrument_tracts").insert({
      job_id: jobId, run_id: null, instrument_id: inst.id, county, legal_description: r.legal_description || null, legal_description_verbatim: r.legal_description || null, interest_type: "unknown",
    }).select("id").single(), "title_instrument_tracts");
    if (tract) {
      await checkedQuery(supabase.from("title_claims").insert({ job_id: jobId, run_id: null, instrument_id: inst.id, instrument_tract_id: tract.id, canonical_asset_id: null, effect: effectForType(type), interest_type: "unknown", notes: "County index entry — not interpreted" }), "title_claims");
    }
  }
  return { inserted, grantorNames: Array.from(grantorNames) };
}

export const MAX_COUNTY_DOCUMENTS_PER_JOB = 40;

/**
 * Reading priority for a county index row, lower first; null = not read.
 *
 * Before this, images were fetched in search-result order and capped at
 * eight, so on the Buttercup tract all eight went to releases and pipeline
 * agreements while the 1975 special warranty deed and 2023 mineral deed —
 * the only instruments there that move mineral ownership — were never read.
 * Every row stays in the reported chain; this only decides which images
 * are worth reading to establish ownership.
 */
export function ownershipReadPriority(entry: { doc_type?: string | null; grantor?: string | null; grantee?: string | null }): number | null {
  const type = (entry.doc_type ?? "").toUpperCase();
  const parties = `${entry.grantor ?? ""} ${entry.grantee ?? ""}`.toUpperCase();
  // Surface and midstream instruments do not move mineral title.
  if (/EASEMENT|RIGHT OF WAY|\bROW\b|SURFACE/.test(type)) return null;
  if (/PIPELINE|MIDSTREAM|GATHERING|TELEPHONE|ELECTRIC|COOPERATIVE/.test(parties) && !/UNIT\b/.test(parties)) return null;
  if (/MINERAL DEED|ROYALTY|WARRANTY DEED|QUITCLAIM|\bDEED\b(?! OF TRUST)|CONVEYANCE|CORRECTION/.test(type)) return 0;
  if (/HEIRSHIP|PROBATE|\bWILL\b|LETTERS|ESTATE|JUDGMENT/.test(type)) return 0;
  if (/\bUNIT\b|POOL|RATIF|DESIGNATION/.test(type) || /\bUNIT\b/.test(parties)) return 1;
  // Releases before leases: "RELEASE" contains "LEASE". A lease release still
  // names the lessor of record, so it outranks liens.
  if (/RELEASE|\bREL\b/.test(type)) return /LIEN|TRUST|MORTGAGE/.test(type) ? 4 : 3;
  if (/LEASE|\bLS\b|MEMORANDUM|ASSIGN|AMENDMENT/.test(type)) return 2;
  if (/DEED OF TRUST|LIEN/.test(type)) return 4;
  return 5;
}

/**
 * Read the courthouse images for the recordings on the job's confirmed
 * tracts, ownership conveyances first. Built from every stored index row,
 * not just this pass's results, so a resumed job whose searches are already
 * logged still reads what it has not read.
 */
export async function retrieveOwnershipDocuments(supabase: SupabaseClient, deps: TitleJobDeps, jobId: string, userId: string, wells: JobWellRow[] = []): Promise<number> {
  if (!deps.getCountyDocument) return 0;
  const { data: tractRows } = await checkedQuery(supabase.from("title_canonical_tracts").select("id, county, section_name, block_number, match_status").eq("job_id", jobId).eq("match_status", "confirmed"), "title search tracts");
  const confirmed = (tractRows ?? []) as SearchTract[];
  // A recording indexed by the unit's own name (a unit designation or
  // ratification) belongs to the unit's title even without a section call.
  // Exact normalized match only: a discovery rule, never tract proof.
  const normalize = (v: string | null | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const unitNames = new Set(wells.filter(w => w.lease_name).map(w => `${(w.county_name ?? "").toUpperCase()}|${normalize(w.lease_name)}`));
  if (!confirmed.length && !unitNames.size) return 0;
  const rows = await pagedRows(page => supabase.from("title_instruments").select("id, county, extraction_json").eq("job_id", jobId).is("document_id", null).order("id").range(page, page + 999), "title_instruments");
  const { data: saved } = await checkedQuery(supabase.from("title_documents").select("source_url").eq("job_id", jobId).eq("source", "county_public_preview"), "title_documents");
  const have = new Set(((saved ?? []) as Array<{ source_url: string | null }>).map(d => d.source_url));

  type Candidate = { entry: IndexEntry; county: string; priority: number };
  const byUrl = new Map<string, Candidate>();
  let unreadable = 0, notOwnership = 0;
  for (const r of rows) {
    const entry = (r.extraction_json as { index?: IndexEntry } | null)?.index;
    const county = String(r.county ?? "");
    if (!entry) continue;
    const onTract = confirmed.some(t => t.county?.toUpperCase() === county.toUpperCase() && indexMatchesTract(entry.legal_description, t));
    if (!onTract && !unitNames.has(`${county.toUpperCase()}|${normalize(entry.legal_description)}`)) continue;
    const priority = ownershipReadPriority(entry);
    if (priority === null) { notOwnership++; continue; }
    if (!entry.document_url) { unreadable++; continue; }
    if (have.has(entry.document_url) || byUrl.has(entry.document_url)) continue;
    byUrl.set(entry.document_url, { entry, county, priority });
  }
  const queue = [...byUrl.values()].sort((a, b) => a.priority - b.priority || String(a.entry.recorded_date).localeCompare(String(b.entry.recorded_date)));
  const budget = Math.max(0, MAX_COUNTY_DOCUMENTS_PER_JOB - have.size);
  let fetched = 0;
  for (const { entry, county } of queue.slice(0, budget)) {
    const document = await deps.getCountyDocument(entry.document_url!).catch(e => ({ ok: false as const, error: String(e) }));
    if (!document.ok) {
      await logSearch(supabase, jobId, userId, { provider: "county_public_preview", county, queryType: "document", queryValue: entry.document_url!, status: "failed", resultCount: 0, error: document.error, sourceUrl: entry.document_url! });
      await addReviewItem(supabase, jobId, userId, "document_retrieval", `County document ${entry.doc_number} could not be retrieved`, document.error, { county, sourceUrl: entry.document_url });
      continue;
    }
    await logSearch(supabase, jobId, userId, { provider: "county_public_preview", county, queryType: "document", queryValue: entry.document_url!, status: "success", resultCount: 1, error: null, sourceUrl: entry.document_url! });
    await storeRemoteDocument(supabase, { ...deps, fetchBytes: async () => ({ ok: true, bytes: document.bytes, contentType: "application/pdf" }) }, jobId, userId, null, {
      url: entry.document_url!, source: "county_public_preview", sourceIdentifier: `${county}:${entry.doc_number}:public-preview:${document.pageCount}-pages`, category: "other", fileName: `${entry.doc_number.replace(/[^a-z0-9-]/gi, "_")}-public-preview.pdf`,
    });
    fetched++;
  }
  if (fetched) await appendLimitation(supabase, jobId, "County public preview images were retrieved automatically. They are not certified copies.");
  if (queue.length > budget) await addReviewItem(supabase, jobId, userId, "document_retrieval", "County document retrieval limit reached", `${queue.length - budget} further ownership-relevant recordings on the lease were not read within the ${MAX_COUNTY_DOCUMENTS_PER_JOB}-document limit.`, { remaining: queue.length - budget });
  if (unreadable) await addReviewItem(supabase, jobId, userId, "document_retrieval", `${unreadable} recording(s) on the tract expose no retrieval link`, "They remain in the chain as index entries; their images must be obtained from the clerk.", { count: unreadable });
  if (notOwnership) await appendLimitation(supabase, jobId, `${notOwnership} surface, easement or midstream recording(s) on the tract are reported from the county index and were not read; they do not move mineral title.`);
  return fetched;
}

/**
 * Confirm a proposed tract when the county itself ties it to the well's
 * lease: a recording indexed against that tract's section, block and
 * township names the lease or unit. Live case: the GIS surface survey put a
 * CMC BUTTERCUP 25-37 UNIT well in Sec 37 Blk 39 T4S, and Midland indexed an
 * instrument to the CMC BUTTERCUP UNIT against that same section. Two
 * independent public records agreeing is the confirmation; it is recorded as
 * evidence, never as a person's review. Rejected tracts are never touched.
 */
export async function corroborateCandidateTracts(supabase: SupabaseClient, jobId: string, userId: string, wells: JobWellRow[]): Promise<number> {
  const { data: proposed } = await checkedQuery(supabase.from("title_canonical_tracts").select("id, county, section_name, block_number, match_status, tract_label").eq("job_id", jobId).eq("match_status", "proposed"), "title candidate tracts");
  if (!proposed?.length) return 0;
  const rows = await pagedRows(page => supabase.from("title_instruments").select("county, extraction_json").eq("job_id", jobId).is("document_id", null).order("id").range(page, page + 999), "title_instruments");
  const tokensFor = (lease: string) => lease.toUpperCase().replace(/[^A-Z0-9\s]/g, " ").split(/\s+/).filter(t => /^[A-Z]{5,}$/.test(t) && !/^(UNIT|LEASE|COUNTY|STATE|TEXAS)$/.test(t));
  let confirmed = 0;
  for (const tract of proposed as Array<SearchTract & { tract_label: string }>) {
    const probe = { ...tract, match_status: "confirmed" };
    for (const well of wells.filter(w => w.lease_name && w.county_name?.toUpperCase() === tract.county?.toUpperCase())) {
      const tokens = tokensFor(well.lease_name!);
      if (!tokens.length) continue;
      const witness = rows.map(r => ({ county: String(r.county ?? ""), index: (r.extraction_json as { index?: IndexEntry } | null)?.index }))
        .find(r => r.index && r.county.toUpperCase() === (tract.county ?? "").toUpperCase() && indexMatchesTract(r.index.legal_description, probe)
          && tokens.every(t => `${r.index!.grantor ?? ""} ${r.index!.grantee ?? ""} ${r.index!.legal_description ?? ""}`.toUpperCase().includes(t)));
      if (!witness?.index) continue;
      const evidence = { documentId: null, instrumentId: null, page: null, sourceUrl: null, label: "County index corroborates the lease tract",
        excerpt: `${witness.county} County instrument ${witness.index.doc_number} (${witness.index.doc_type}, ${witness.index.grantor} to ${witness.index.grantee}) is indexed against ${witness.index.legal_description} and names ${well.lease_name}.` };
      const { data: done } = await checkedQuery(supabase.from("title_canonical_tracts").update({ match_status: "confirmed", needs_user_selection: false }).eq("id", tract.id).eq("match_status", "proposed").select("id"), "title tract corroboration");
      await checkedQuery(supabase.from("title_well_tract_associations").update({ review_status: "confirmed" }).eq("job_id", jobId).eq("canonical_tract_id", tract.id).eq("well_id", well.id).eq("review_status", "proposed"), "title association corroboration");
      await addReviewItem(supabase, jobId, userId, "tract_corroborated", `Tract confirmed from public records: ${tract.tract_label}`, evidence.excerpt, { tractId: tract.id, evidence });
      if (done?.length) confirmed++;
      break;
    }
  }
  return confirmed;
}

export async function searchCountyRecordsForJob(supabase: SupabaseClient, deps: TitleJobDeps, jobId: string, userId: string, wells: JobWellRow[]): Promise<void> {
  await repairIndexParties(supabase, jobId);
  // Searching is discovery, so proposed tracts are searched as well as
  // confirmed ones; reading images and linking use confirmed tracts only.
  const { data: tractRows } = await checkedQuery(supabase.from("title_canonical_tracts").select("id, county, section_name, block_number, match_status").eq("job_id", jobId).neq("match_status", "rejected"), "title search tracts");
  const tracts = ((tractRows ?? []) as SearchTract[]).map(t => ({ ...t, match_status: "confirmed" }));
  const tractCountiesPlanned = new Set<string>();
  const tractHits = new Set<string>();
  let queries = 0;
  const attempted = new Set<string>();
  // Lease-name queries that came back empty, keyed the same way as `attempted`.
  // The survey-only fallback below is driven off this rather than off the
  // zero-result branch alone: with wells sharing one lease, only the FIRST
  // well reaches that branch, and a later well is the one that may carry the
  // survey/abstract. Keying it here lets that well still contribute its
  // fallback instead of being silently skipped as a duplicate.
  const leaseNameEmpty = new Set<string>();
  const searchedCounties = new Set<string>();
  let bounded = false;
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
    if (!tractCountiesPlanned.has(county.toUpperCase())) {
      tractCountiesPlanned.add(county.toUpperCase());
      for (const tract of tracts.filter(t => t.county?.toUpperCase() === county.toUpperCase())) {
        const precise = tractQueries(tract);
        for (const value of precise) candidates.push({ type: "tract_description", value });
        if (!precise.length) await addReviewItem(supabase, jobId, userId, "search_incomplete", `Tract ${tract.id} lacks a supported section/block/township search identity`, "Inspect the confirmed legal description or plat. No township is inferred from an abstract identifier.", { tractId: tract.id });
      }
    }
    if (well.lease_name) candidates.push({ type: "lease_name", value: well.lease_name });
    if (well.survey_name) candidates.push({ type: "legal_description", value: well.abstract_number ? `${well.survey_name} ${well.abstract_number}` : well.survey_name });
    if (well.operator_name) {
      candidates.push({ type: "operator", value: well.operator_name });
      // Clerk indices often collapse TRRC's spaced initials (U. S. A. -> USA).
      // Plan this independently of the raw query so cached empty results on a
      // resumed job cannot suppress the newly introduced discovery query.
      const normalized = well.operator_name
        .replace(/\b(?:[a-z]\.\s*){2,}/gi, initials => initials.replace(/[.\s]/g, "") + " ")
        .replace(/[^a-z0-9\s]/gi, " ").replace(/\s+/g, " ").trim();
      if (normalized.toUpperCase() !== well.operator_name.toUpperCase().trim()) {
        candidates.push({ type: "operator_variant", value: normalized });
      }
    }

    for (const q of candidates) {
      const key = `${county.toUpperCase()}|${q.value.toUpperCase().replace(/\s+/g, " ").trim()}`;
      if (attempted.has(key)) {
        if (q.type === "lease_name" && leaseNameEmpty.has(key) && well.survey_name && well.abstract_number) {
          candidates.push({ type: "legal_description", value: well.survey_name });
        }
        continue;
      }
      attempted.add(key);
      if (queries >= MAX_COUNTY_QUERIES_PER_JOB) {
        bounded = true;
        await logSearch(supabase, jobId, userId, { provider: providerId, county, queryType: q.type, queryValue: q.value, status: "skipped_bounded", resultCount: 0, error: `Query budget of ${MAX_COUNTY_QUERIES_PER_JOB} reached` });
        continue;
      }
      if (!q.type.startsWith("lease_name") && await alreadySearched(supabase, jobId, providerId, q.type, q.value)) continue;
      queries++;
      searchedCounties.add(county);
      const r = await deps.getCountyRecords(county, q.value).catch(e => ({ found: false, status: "automated" as const, county, provider: provider.provider.id, records: [] as IndexEntry[], total_count: 0, search_url: "", message: String(e), error: String(e) }));
      const status = r.error ? "failed" : r.status === "manual_required" ? "provider_unavailable" : r.records.length > 0 ? "success" : "empty";
      // A manual-required result keeps its reason (e.g. the county's CAPTCHA) in the log.
      await logSearch(supabase, jobId, userId, { provider: providerId, county, queryType: q.type, queryValue: q.value, status, resultCount: r.records.length, error: r.error ?? (r.status === "manual_required" ? r.message : null), sourceUrl: r.search_url });
      if (status === "failed" || status === "provider_unavailable") {
        await addReviewItem(supabase, jobId, userId, "search_incomplete", `County search incomplete: ${county} / ${q.value}`, r.error ?? r.message, { county, query: q.value, status });
      }
      if (r.total_count > r.records.length || ("coverage_incomplete" in r && r.coverage_incomplete)) {
        await addReviewItem(supabase, jobId, userId, "search_incomplete", `County results truncated: ${county} / ${q.value}`, `Returned ${r.records.length} rows; reported count ${r.total_count}. Pagination coverage is incomplete or unverified.`, { county, query: q.value });
      }
      // Variants broaden discovery only. Never rewrite the source legal description.
      if (q.type === "lease_name" && r.records.length === 0) {
        leaseNameEmpty.add(key);
        const plain = q.value.replace(/[^a-z0-9\s]/gi, " ").replace(/\s+/g, " ").trim();
        const distinctive = plain.split(" ").filter(t => /^[a-z]+$/i.test(t) && t.length >= 5 && !/^(UNIT|LEASE|COUNTY)$/i.test(t)).join(" ");
        if (plain) candidates.push({ type: "lease_name_variant", value: plain });
        if (distinctive && distinctive !== plain) candidates.push({ type: "lease_name_variant", value: distinctive });
        if (well.survey_name && well.abstract_number) candidates.push({ type: "legal_description", value: well.survey_name });
      }
      if (r.records.length > 0) {
        await storeIndexEntries(supabase, jobId, county, r.search_url, r.records);
        const relevant = r.records.filter(entry => tracts.some(t => t.county?.toUpperCase() === county.toUpperCase() && indexMatchesTract(entry.legal_description, t)));
        if (relevant.length) tractHits.add(county.toUpperCase());
        // A broad query or a unit-name/address hit alone cannot seed predecessors.
        // Use relevant records even on resume, when the index row already exists.
        for (const entry of relevant) for (const name of splitIndexNames(entry.grantor)) followups.push({ county, name });
        // Documents are not fetched here, in result order: see retrieveOwnershipDocuments().

      }
    }
  }

  // One bounded round of predecessor follow-up on grantor names discovered in the index.
  let follow = 0;
  for (const f of followups) {
    if (follow >= MAX_FOLLOWUP_QUERIES || queries >= MAX_COUNTY_QUERIES_PER_JOB) {
      bounded = true;
      await logSearch(supabase, jobId, userId, { provider: "county:followup", county: f.county, queryType: "party_name", queryValue: f.name, status: "skipped_bounded", resultCount: 0, error: "Follow-up budget reached", depth: 1 });
      continue;
    }
    const provider = deps.findProvider(f.county);
    if (!provider) continue;
    const providerId = `county:${provider.provider.id}`;
    if (await alreadySearched(supabase, jobId, providerId, "party_name", f.name)) continue;
    follow++; queries++;
    const r = await deps.getCountyRecords(f.county, f.name).catch(e => ({ found: false, status: "automated" as const, county: f.county, provider: provider.provider.id, records: [] as IndexEntry[], total_count: 0, search_url: "", message: String(e), error: String(e) }));
    const status = r.error ? "failed" : r.status === "manual_required" ? "provider_unavailable" : r.records.length > 0 ? "success" : "empty";
    await logSearch(supabase, jobId, userId, { provider: providerId, county: f.county, queryType: "party_name", queryValue: f.name, status, resultCount: r.records.length, error: r.error ?? (r.status === "manual_required" ? r.message : null), sourceUrl: r.search_url, depth: 1 });
    if (r.records.length > 0) await storeIndexEntries(supabase, jobId, f.county, r.search_url, r.records);
  }
  await corroborateCandidateTracts(supabase, jobId, userId, wells);
  if (deps.getCountyDocument) await retrieveOwnershipDocuments(supabase, deps, jobId, userId, wells);
  if (bounded) {
    await addReviewItem(supabase, jobId, userId, "search_incomplete", "County search budget reached", "Some planned searches were not executed. See skipped_bounded entries; this job does not establish exhaustive county coverage.", { queryLimit: MAX_COUNTY_QUERIES_PER_JOB });
  }
  for (const county of searchedCounties) {
    if (!tractHits.has(county.toUpperCase()) && tracts.some(t => t.county?.toUpperCase() === county.toUpperCase() && tractQueries(t).length)) {
      await addReviewItem(supabase, jobId, userId, "search_incomplete", `No tract-matching index records retrieved in this pass for ${county}`, "Broad index hits do not establish a title chain. Review precise tract queries, pagination limits and underlying unit/lease instruments; prior stored evidence is not invalidated by this search result.", { county });
    }
    const { data } = await checkedQuery(supabase.from("title_instruments").select("id").eq("job_id", jobId).eq("county", county).limit(1), "title_instruments");
    if (!data?.length) {
      await addReviewItem(supabase, jobId, userId, "search_incomplete", `No county instruments retrieved for ${county}`, "Automated searches have not established title. Review query coverage, obtain the unit legal description from permits/plats, and search the relevant tract and predecessor parties. Empty results do not prove that no records exist.", { county });
    }
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function runTitleResearchJob(jobId: string, supabase: SupabaseClient, deps: TitleJobDeps = defaultDeps): Promise<void> {
  const { data: job } = await checkedQuery(supabase.from("title_research_jobs").select("id, user_id, status, attempt_count").eq("id", jobId).single(), "title_research_jobs");
  if (!job) return;
  // Do not restart cancelled, completed, or human-review jobs on a stale poll.
  if (!["pending", "resolving_wells", "searching_records"].includes(String(job.status))) return;
  const userId = job.user_id as string;

  const isCancelled = async () => {
    const { data } = await checkedQuery(supabase.from("title_research_jobs").select("status").eq("id", jobId).single(), "title_research_jobs");
    return data?.status === "cancelled";
  };

  await setJob(supabase, jobId, { status: "resolving_wells", stage_detail: "Resolving wells with TRRC", progress_percent: 5, attempt_count: (job.attempt_count as number) + 1, started_at: new Date().toISOString() });

  const { data: wellRows } = await checkedQuery(supabase.from("title_job_wells").select("id, api10, api14, county_name, resolution_status, operator_name, lease_name, survey_name, abstract_number").eq("job_id", jobId), "title_job_wells");
  const wells = ((wellRows ?? []) as JobWellRow[]).filter(w => !!w.api10);
  if (wells.length === 0) {
    await setJob(supabase, jobId, { status: "failed", error_summary: "Title job has no valid persisted API inputs. Recreate the job after atomic job creation is deployed.", stage_detail: "Missing well inputs; research did not run" });
    return;
  }
  const pendingWells = wells.filter(w => w.resolution_status === "unresolved" || w.resolution_status === "error");

  for (let i = 0; i < pendingWells.length; i++) {
    if (await isCancelled()) return;
    const w = pendingWells[i];
    await setJob(supabase, jobId, { stage_detail: `Resolving ${w.api14 ?? w.api10} (${i + 1}/${pendingWells.length})`, progress_percent: 5 + Math.round((i / Math.max(1, pendingWells.length)) * 50) });
    try {
      await resolveWell(supabase, deps, jobId, userId, w);
    } catch (e) {
      if (e instanceof PipelinePersistenceError) throw e;
      await checkedQuery(supabase.from("title_job_wells").update({ resolution_status: "error", resolution_error: String(e).slice(0, 300) }).eq("id", w.id), "title_job_wells");
    }
  }

  if (await isCancelled()) return;
  await setJob(supabase, jobId, { status: "searching_records", stage_detail: "Searching county records", progress_percent: 60 });
  const { data: refreshed } = await checkedQuery(supabase.from("title_job_wells").select("*").eq("job_id", jobId), "title_job_wells");
  const candidateCount = await persistSurfaceTractCandidates(supabase, jobId, userId, (refreshed ?? []) as Record<string, unknown>[]);
  await searchCountyRecordsForJob(supabase, deps, jobId, userId, (refreshed ?? []) as JobWellRow[]);

  if (await isCancelled()) return;
  const resolvedCount = ((refreshed ?? []) as JobWellRow[]).filter(w => w.resolution_status === "resolved").length;
  await setJob(supabase, jobId, {
    status: "awaiting_tract_confirmation",
    stage_detail: candidateCount > 0 ? "Review proposed surface surveys and confirm the subject tract(s) using supporting documents" : resolvedCount > 0 ? "Well resolved, but no supported tract candidate is available — supply a legal description or documents" : "No well could be resolved — supply a legal description or documents to continue",
    progress_percent: 100,
  });
}
