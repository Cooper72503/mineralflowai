import type { SupabaseClient } from "@supabase/supabase-js";
import { shortDrillingProximityPhrase, type DealScoreResult } from "@/lib/document-processing/deal-score";
import {
  EM_DASH,
  acreageDisplayFromStructured,
  completedTimestampMs,
  dealScoreFromMerged,
  documentTypeDisplay,
  leaseStatusFromStructured,
  mergeStructuredFields,
  ownerFromStructured,
} from "@/lib/deals/dashboard-normalize";

export type DocumentDealListRow = {
  id: string;
  file_name: string | null;
  county: string | null;
  state: string | null;
  document_type: string | null;
  created_at: string;
  processed_at: string | null;
  completed_at: string | null;
};

export type ExtractionListRow = {
  document_id: string;
  structured_data?: unknown;
  structured_json?: unknown;
  lessor: string | null;
};

export type CompletedDocumentJoin = {
  status: string;
  file_name: string | null;
  document_type: string | null;
  completed_at: string | null;
  processed_at: string | null;
};

/** Row from document_extractions joined to a completed document (Leads query). */
export type ExtractionWithCompletedDoc = {
  id: string;
  document_id: string;
  structured_data?: unknown;
  structured_json?: unknown;
  created_at: string;
  /** Supabase types may use an array for embedded FK rows; runtime is a single object. */
  documents: CompletedDocumentJoin | CompletedDocumentJoin[];
};

export type ProcessedDealRow = {
  id: string;
  file_name: string | null;
  county: string | null;
  state: string | null;
  created_at: string;
  completed_at: string | null;
  processed_at: string | null;
  dealScore: DealScoreResult | null;
  owner: string;
  acres: string;
  leaseStatus: string;
  docType: string;
  /** From structured proximity fields (same signals as deal score); optional one-line summaries use this first. */
  drillingProximityPhrase: string | null;
};

function strFromMerged(merged: Record<string, unknown>, key: string): string | null {
  const v = merged[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function singleJoinedDocument(
  d: ExtractionWithCompletedDoc["documents"]
): CompletedDocumentJoin | null {
  if (Array.isArray(d)) {
    const first = d[0];
    return first && typeof first === "object" ? first : null;
  }
  return d && typeof d === "object" ? d : null;
}

/** Maps extraction + completed document to UI row; location fields come from structured_data. */
export function buildProcessedDealRowFromExtractionJoin(row: ExtractionWithCompletedDoc): ProcessedDealRow {
  const data = row.structured_data || row.structured_json || {};
  const merged = mergeStructuredFields(data);
  const dealScore = dealScoreFromMerged(merged);
  const doc = singleJoinedDocument(row.documents);
  const drillingProximityPhrase = shortDrillingProximityPhrase(merged);
  if (!doc) {
    return {
      id: row.document_id,
      file_name: null,
      county: null,
      state: null,
      created_at: row.created_at,
      completed_at: null,
      processed_at: null,
      dealScore,
      owner: ownerFromStructured(merged, null),
      acres: acreageDisplayFromStructured(merged),
      leaseStatus: leaseStatusFromStructured(merged),
      docType: documentTypeDisplay(merged, null),
      drillingProximityPhrase,
    };
  }
  return {
    id: row.document_id,
    file_name: doc.file_name,
    county: strFromMerged(merged, "county"),
    state: strFromMerged(merged, "state"),
    created_at: row.created_at,
    completed_at: doc.completed_at,
    processed_at: doc.processed_at,
    dealScore,
    owner: ownerFromStructured(merged, null),
    acres: acreageDisplayFromStructured(merged),
    leaseStatus: leaseStatusFromStructured(merged),
    docType: documentTypeDisplay(merged, doc.document_type),
    drillingProximityPhrase,
  };
}

export function buildProcessedDealRow(
  doc: DocumentDealListRow,
  extraction: ExtractionListRow | undefined
): ProcessedDealRow {
  const data =
    extraction != null ? extraction.structured_data || extraction.structured_json || {} : {};
  const merged = extraction != null ? mergeStructuredFields(data) : {};
  const dealScore = dealScoreFromMerged(merged);
  return {
    id: doc.id,
    file_name: doc.file_name,
    county: doc.county,
    state: doc.state,
    created_at: doc.created_at,
    completed_at: doc.completed_at,
    processed_at: doc.processed_at,
    dealScore,
    owner: ownerFromStructured(merged, extraction?.lessor),
    acres: acreageDisplayFromStructured(merged),
    leaseStatus: leaseStatusFromStructured(merged),
    docType: documentTypeDisplay(merged, doc.document_type),
    drillingProximityPhrase: shortDrillingProximityPhrase(merged),
  };
}

export function sortProcessedDealsByScore(rows: ProcessedDealRow[]): ProcessedDealRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.dealScore?.score ?? -1;
    const sb = b.dealScore?.score ?? -1;
    if (sb !== sa) return sb - sa;
    return (
      completedTimestampMs(b.completed_at, b.processed_at) -
      completedTimestampMs(a.completed_at, a.processed_at)
    );
  });
}

export function rlsMessageForDeals(code: string | undefined, fallback: string): string {
  if (code === "PGRST301") {
    return "You don't have permission to view leads. Sign in or check access.";
  }
  return fallback;
}

const EXTRACTION_WITH_DOC_SELECT = `
  id,
  document_id,
  structured_data,
  created_at,
  documents!inner (
    status,
    file_name,
    document_type,
    completed_at,
    processed_at
  )
`;

export async function fetchProcessedDeals(
  supabase: SupabaseClient
): Promise<{ rows: ProcessedDealRow[]; error: string | null }> {
  const { data: extRows, error: extErr } = await supabase
    .from("document_extractions")
    .select(EXTRACTION_WITH_DOC_SELECT)
    .eq("documents.status", "completed")
    .not("structured_data->deal_score", "is", null);

  if (extErr) {
    return {
      rows: [],
      error: rlsMessageForDeals(extErr.code, extErr.message || "Failed to load leads."),
    };
  }

  const list = (extRows as unknown as ExtractionWithCompletedDoc[]) ?? [];
  const built = list
    .map((row) => buildProcessedDealRowFromExtractionJoin(row))
    .filter((r) => r.dealScore != null);

  return { rows: sortProcessedDealsByScore(built), error: null };
}

export async function fetchProcessedDealById(
  supabase: SupabaseClient,
  id: string
): Promise<{ row: ProcessedDealRow | null; error: string | null }> {
  const { data: ext, error: extErr } = await supabase
    .from("document_extractions")
    .select(EXTRACTION_WITH_DOC_SELECT)
    .eq("document_id", id)
    .eq("documents.status", "completed")
    .not("structured_data->deal_score", "is", null)
    .maybeSingle();

  if (extErr) {
    return {
      row: null,
      error: rlsMessageForDeals(extErr.code, extErr.message || "Failed to load lead."),
    };
  }

  if (!ext) {
    return { row: null, error: null };
  }

  const row = buildProcessedDealRowFromExtractionJoin(ext as unknown as ExtractionWithCompletedDoc);
  if (row.dealScore == null) {
    return { row: null, error: null };
  }

  return { row, error: null };
}

export { EM_DASH };
