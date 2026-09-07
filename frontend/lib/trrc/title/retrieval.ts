/**
 * Raw instrument-candidate retrieval for the Title Resolution engine.
 *
 * IMPORTANT architectural note: county-records.ts (worker/src/tools/
 * county-records.ts) drives real browser automation (Playwright) against
 * county portals — that only runs inside the worker process on the droplet.
 * This module does NOT call that tool directly (frontend/lib runs on
 * Vercel, no Playwright available there); instead it reads the ALREADY-
 * FETCHED result the worker stored in trrc_source_attempts.result_data_json
 * when it ran "fetch_county_records" for this run — the same stored payload
 * archive-builder.ts already reads for the county-records CSV export.
 *
 * A county-clerk INDEX entry proves an indexed record exists — it does not
 * prove the legal effect of the underlying instrument. Every candidate this
 * module produces is stamped evidenceLevel='county_index_metadata',
 * instrumentContentVerified=false, and extractionConfidence=null:
 * interest fractions, reservation language, and exceptions are NOT available
 * from an index search and must never be inferred from it.
 *
 * Martin County has no free automated portal (see county-records.ts's own
 * header comment) — for that county specifically, this path returns no
 * candidates; title data comes entirely through bulk-import.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstrumentType, PartyCapacity, TitleWarning } from "./types";

export type CountyRecordEntry = {
  grantor: string;
  grantee: string;
  doc_type: string;
  recorded_date: string;
  doc_number: string;
  book_volume_page: string;
  legal_description: string;
};

/** One instrument candidate, with its parties and tract already split out — not yet inserted (index.ts owns the insert + party-name splitting into individual rows). */
export interface InstrumentCandidate {
  instrumentType: InstrumentType;
  instrumentDate: string | null;
  recordedDate: string | null;
  docNumber: string | null;
  bookVolumePage: string | null;
  source: "county_clerk_index";
  sourceUrlOrDocId: string | null;

  grantorNames: string[];
  granteeNames: string[];

  county: string | null;
  legalDescription: string | null;
}

export interface RetrievalResult {
  candidates: InstrumentCandidate[];
  warnings: TitleWarning[];
}

const DOC_TYPE_TO_INSTRUMENT_TYPE: Record<string, InstrumentType> = {
  "warranty deed": "deed",
  "deed": "deed",
  "mineral deed": "mineral_deed",
  "oil and gas lease": "lease",
  "lease": "lease",
  "assignment": "assignment",
  "assignment of oil and gas lease": "assignment",
  "reservation": "reservation",
  "affidavit of heirship": "affidavit_of_heirship",
  "release": "release",
  "release of lien": "release",
};

function normalizeInstrumentType(docType: string): InstrumentType {
  return DOC_TYPE_TO_INSTRUMENT_TYPE[docType.trim().toLowerCase()] ?? "other";
}

/**
 * A county-clerk index row typically stores grantor/grantee as a single
 * string that may itself list multiple parties (e.g. "SMITH, JOHN &
 * SMITH, JANE" or "SMITH, JOHN ET UX"). This is a conservative split — real
 * multi-party parsing (distinguishing "ET UX" as a marked spouse capacity
 * vs. a genuinely separate named party) needs the real index format to
 * calibrate against, so this only splits on unambiguous separators and
 * leaves a single unsplit string as one party rather than guessing.
 */
function splitPartyNames(raw: string): { names: string[]; capacity: PartyCapacity } {
  const trimmed = raw.trim();
  if (/\bet ux\b/i.test(trimmed)) {
    return { names: [trimmed.replace(/\bet ux\b/i, "").trim()], capacity: "spouse" };
  }
  const parts = trimmed.split(/\s*&\s*|\s+AND\s+/i).map(p => p.trim()).filter(Boolean);
  return { names: parts.length > 0 ? parts : [trimmed], capacity: "unknown" };
}

/**
 * Reads the county-records source-attempt row already persisted for this
 * run and maps it onto instrument candidates. Index search only — interest
 * fractions and exact instrument language are never guessed here.
 */
export async function retrieveCountyClerkInstruments(supabase: SupabaseClient, runId: string, county: string | null): Promise<RetrievalResult> {
  const warnings: TitleWarning[] = [];

  const { data: attempt, error } = await supabase
    .from("trrc_source_attempts")
    .select("result_data_json, status, search_url")
    .eq("run_id", runId)
    .eq("source_name", "fetch_county_records")
    .maybeSingle();

  if (error) {
    warnings.push({ code: "COUNTY_RECORDS_QUERY_FAILED", message: `Could not read stored county-records result: ${error.message}`, severity: "critical" });
    return { candidates: [], warnings };
  }

  if (!attempt) {
    warnings.push({ code: "COUNTY_RECORDS_NOT_ATTEMPTED", message: "This run never queried county clerk records (fetch_county_records was not called) — title data from the automated path is unavailable; only bulk-imported records will appear", severity: "warning" });
    return { candidates: [], warnings };
  }

  const payload = attempt.result_data_json as { records?: CountyRecordEntry[]; status?: string } | null;
  const records = payload?.records ?? [];
  const sourceUrlOrDocId = (attempt as { search_url?: string | null }).search_url ?? null;

  if (payload?.status === "manual_required" || records.length === 0) {
    warnings.push({
      code: "COUNTY_RECORDS_MANUAL_REQUIRED",
      message: county
        ? `${county} County has no automated county-records connector — this is expected for most Texas counties, not a failure. Title data for this tract must come from a manual county-clerk search or a bulk-imported file.`
        : "No automated county-records data available for this run's county.",
      severity: "info",
    });
    return { candidates: [], warnings };
  }

  const candidates: InstrumentCandidate[] = records.map(r => {
    const grantor = splitPartyNames(r.grantor?.trim() || "UNKNOWN");
    const grantee = splitPartyNames(r.grantee?.trim() || "UNKNOWN");
    return {
      instrumentType: normalizeInstrumentType(r.doc_type ?? ""),
      instrumentDate: null, // the county-clerk index gives recorded date only, not execution date
      recordedDate: r.recorded_date || null,
      docNumber: r.doc_number || null,
      bookVolumePage: r.book_volume_page || null,
      source: "county_clerk_index",
      sourceUrlOrDocId,
      grantorNames: grantor.names,
      granteeNames: grantee.names,
      county,
      legalDescription: r.legal_description || null,
    };
  });

  return { candidates, warnings };
}
