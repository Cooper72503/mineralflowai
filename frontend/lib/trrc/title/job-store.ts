/**
 * Row <-> domain mappers and loaders for migration 028's tables. Every
 * query goes through the caller's Supabase client (user JWT, RLS-scoped)
 * unless a route explicitly uses the service role for a documented reason.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandidateTract, JobStatus, JobWell, WellTractAssociation, InterestScope, Citation } from "./chain-types";
import type { MatchStatus } from "./types";

export interface JobRow {
  id: string;
  user_id: string;
  status: JobStatus;
  stage_detail: string | null;
  progress_percent: number;
  error_summary: string | null;
  attempt_count: number;
  input_text: string;
  interest_scope: InterestScope[];
  research_start_date: string | null;
  as_of_date: string | null;
  state_code: string;
  coverage_json: unknown[];
  limitations_json: string[];
  latest_analysis_id: string | null;
  schema_version: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  job_id: string;
  user_id: string;
  well_id: string | null;
  source: string;
  source_identifier: string | null;
  source_url: string | null;
  retrieved_at: string;
  document_category: string;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_path: string | null;
  content_hash: string;
  page_count: number | null;
  has_text_layer: boolean | null;
  ocr_status: string;
  extracted_text: string | null;
  extraction_status: string;
  extraction_error: string | null;
  created_at: string;
}

export interface ReviewItemRow {
  id: string;
  job_id: string;
  kind: string;
  title: string;
  detail: string | null;
  payload_json: Record<string, unknown>;
  status: string;
  resolution_json: Record<string, unknown> | null;
  created_at: string;
}

export interface SearchLogRow {
  id: string;
  provider: string;
  county: string | null;
  query_type: string;
  query_value: string;
  date_from: string | null;
  date_to: string | null;
  status: string;
  result_count: number;
  error_message: string | null;
  source_url: string | null;
  depth: number;
  searched_at: string;
}

export function mapWellRow(r: Record<string, unknown>): JobWell {
  return {
    id: String(r.id),
    originalInput: String(r.original_input ?? ""),
    api10: (r.api10 as string | null) ?? null,
    api14: (r.api14 as string | null) ?? null,
    sidetrackSuffix: (r.sidetrack_suffix as string | null) ?? null,
    completionSuffix: (r.completion_suffix as string | null) ?? null,
    countyCode: (r.county_code as string | null) ?? null,
    countyName: (r.county_name as string | null) ?? null,
    validationError: (r.validation_error as string | null) ?? null,
    resolutionStatus: (r.resolution_status as JobWell["resolutionStatus"]) ?? "unresolved",
    resolutionError: (r.resolution_error as string | null) ?? null,
    wellName: (r.well_name as string | null) ?? null,
    wellNumber: (r.well_number as string | null) ?? null,
    operatorName: (r.operator_name as string | null) ?? null,
    operatorNumber: (r.operator_number as string | null) ?? null,
    district: (r.district as string | null) ?? null,
    leaseNumber: (r.lease_number as string | null) ?? null,
    leaseName: (r.lease_name as string | null) ?? null,
    fieldName: (r.field_name as string | null) ?? null,
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    wellPath: (r.well_path_json as Record<string, unknown> | null) ?? null,
    surveyName: (r.survey_name as string | null) ?? null,
    abstractNumber: (r.abstract_number as string | null) ?? null,
    blockNumber: (r.block_number as string | null) ?? null,
    sectionName: (r.section_name as string | null) ?? null,
    permitRefs: (r.permit_refs_json as Array<Record<string, unknown>>) ?? [],
    completionRefs: (r.completion_refs_json as Array<Record<string, unknown>>) ?? [],
    sourceUrls: (r.source_urls_json as JobWell["sourceUrls"]) ?? [],
    retrievedAt: (r.retrieved_at as string | null) ?? null,
  };
}

export function mapTractRow(r: Record<string, unknown>): CandidateTract {
  return {
    id: String(r.id),
    tractLabel: String(r.tract_label ?? r.legal_description ?? "Unidentified tract"),
    county: (r.county as string | null) ?? null,
    abstractNumber: (r.abstract_number as string | null) ?? null,
    surveyName: (r.survey_name as string | null) ?? null,
    blockNumber: (r.block_number as string | null) ?? null,
    sectionName: (r.section_name as string | null) ?? null,
    legalDescription: (r.legal_description as string | null) ?? null,
    grossAcres: r.gross_acres === null || r.gross_acres === undefined ? null : Number(r.gross_acres),
    confidence: Number(r.confidence ?? 0),
    resolutionMethod: String(r.resolution_method ?? ""),
    resolutionTrace: (r.resolution_trace as string[]) ?? [],
    needsUserSelection: Boolean(r.needs_user_selection),
    matchStatus: (r.match_status as MatchStatus) ?? "proposed",
  };
}

export function tractToRow(t: CandidateTract, jobId: string): Record<string, unknown> {
  return {
    id: t.id, job_id: jobId, run_id: null, tract_label: t.tractLabel, county: t.county, abstract_number: t.abstractNumber, survey_name: t.surveyName,
    block_number: t.blockNumber, section_name: t.sectionName, legal_description: t.legalDescription, gross_acres: t.grossAcres,
    confidence: t.confidence, resolution_method: t.resolutionMethod, resolution_trace: t.resolutionTrace,
    needs_user_selection: t.needsUserSelection, match_status: t.matchStatus,
  };
}

export function mapAssociationRow(r: Record<string, unknown>): WellTractAssociation {
  return {
    id: String(r.id),
    wellId: String(r.well_id),
    canonicalTractId: String(r.canonical_tract_id),
    associationType: r.association_type as WellTractAssociation["associationType"],
    confidence: Number(r.confidence ?? 0),
    evidence: (r.evidence_json as Citation[]) ?? [],
    reviewStatus: (r.review_status as WellTractAssociation["reviewStatus"]) ?? "proposed",
  };
}

export interface JobBundle {
  job: JobRow;
  wells: JobWell[];
  tracts: CandidateTract[];
  associations: WellTractAssociation[];
  documents: DocumentRow[];
  reviewItems: ReviewItemRow[];
  searchLog: SearchLogRow[];
  latestAnalysis: { id: string; version: number; status_classification: string; analysis_json: unknown; created_at: string } | null;
}

export async function loadJobBundle(supabase: SupabaseClient, jobId: string, userId: string): Promise<JobBundle | null> {
  const { data: job, error } = await supabase.from("title_research_jobs").select("*").eq("id", jobId).eq("user_id", userId).maybeSingle();
  if (error || !job) return null;

  const [wells, tracts, associations, documents, reviewItems, searchLog, analyses] = await Promise.all([
    supabase.from("title_job_wells").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("title_canonical_tracts").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("title_well_tract_associations").select("*").eq("job_id", jobId),
    supabase.from("title_documents").select("id, job_id, user_id, well_id, source, source_identifier, source_url, retrieved_at, document_category, file_name, mime_type, byte_size, storage_path, content_hash, page_count, has_text_layer, ocr_status, extraction_status, extraction_error, created_at").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("title_review_items").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("title_search_log").select("*").eq("job_id", jobId).order("searched_at", { ascending: true }),
    supabase.from("title_analyses").select("id, version, status_classification, analysis_json, created_at").eq("job_id", jobId).order("version", { ascending: false }).limit(1),
  ]);

  return {
    job: job as JobRow,
    wells: ((wells.data ?? []) as Record<string, unknown>[]).map(mapWellRow),
    tracts: ((tracts.data ?? []) as Record<string, unknown>[]).map(mapTractRow),
    associations: ((associations.data ?? []) as Record<string, unknown>[]).map(mapAssociationRow),
    documents: (documents.data ?? []) as unknown as DocumentRow[],
    reviewItems: (reviewItems.data ?? []) as unknown as ReviewItemRow[],
    searchLog: (searchLog.data ?? []) as unknown as SearchLogRow[],
    latestAnalysis: (analyses.data?.[0] as JobBundle["latestAnalysis"]) ?? null,
  };
}

export async function addReviewItem(supabase: SupabaseClient, jobId: string, userId: string, item: { kind: string; title: string; detail?: string | null; payload?: Record<string, unknown> }): Promise<void> {
  // Idempotent on (job, kind, title): re-running ingestion or analysis never duplicates a queue entry.
  const { data: existing } = await supabase.from("title_review_items").select("id").eq("job_id", jobId).eq("kind", item.kind).eq("title", item.title).limit(1);
  if (existing && existing.length > 0) return;
  await supabase.from("title_review_items").insert({ job_id: jobId, user_id: userId, kind: item.kind, title: item.title, detail: item.detail ?? null, payload_json: item.payload ?? {} });
}

export async function appendLimitation(supabase: SupabaseClient, jobId: string, limitation: string): Promise<void> {
  const { data } = await supabase.from("title_research_jobs").select("limitations_json").eq("id", jobId).maybeSingle();
  const current = ((data?.limitations_json as string[] | null) ?? []);
  if (current.includes(limitation)) return;
  await supabase.from("title_research_jobs").update({ limitations_json: [...current, limitation] }).eq("id", jobId);
}

export function formattedApi(w: JobWell): string | null {
  if (!w.api10) return null;
  return `${w.api10.slice(0, 2)}-${w.api10.slice(2, 5)}-${w.api10.slice(5, 10)}-${w.sidetrackSuffix ?? "00"}-${w.completionSuffix ?? "00"}`;
}
