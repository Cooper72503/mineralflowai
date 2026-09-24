/**
 * Title evidence for the due-diligence PDF.
 *
 * The title workflow already persists everything a buyer needs to see —
 * county search coverage, index leads, retrieved instrument images, tract
 * candidates, review items, a published analysis and a reviewed mineral
 * position. Until now none of it reached the report customers actually
 * download; it lived only in the title-chain UI and the GOLD record.
 *
 * Nothing here interprets a conveyance. Index rows are county INDEX entries
 * (grantor/grantee/type/date as the clerk indexed them) and are carried as
 * unverified leads unless their instrument image has been read and
 * extracted. Ownership appears only when a reviewed position exists against
 * the current analysis version; it is never inferred from an operator name,
 * a lease name, or the presence of a deed.
 *
 * Every load failure is returned as a status, never thrown, so a title
 * outage degrades the section rather than failing the whole report.
 */
import { selectAll } from "./select-all";
import { SUPERSEDED_EVIDENCE_LEVEL } from "./supersede-index";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadJobBundle } from "./job-store";
import { loadReviewedPosition } from "../gold2/position-link";
import type { TitleChainAnalysis } from "./chain-types";

export interface TitleIndexLead {
  instrumentType: string;
  instrumentNumber: string | null;
  recordedDate: string | null;
  grantor: string | null;
  grantee: string | null;
  legalDescription: string | null;
  contentVerified: boolean;
}

export interface TitleReportInput {
  status: "no_job" | "in_progress" | "awaiting_review" | "analyzed" | "unavailable";
  headline: string;
  jobId: string | null;
  stageDetail: string | null;
  /** Retrieved instruments, subject-matched first, capped for the page. */
  subjectLeads: TitleIndexLead[];
  /** How many of subjectLeads matched the subject lease name (they lead the list). */
  subjectMatchedCount: number;
  /** Total index rows retrieved, including operator/party hits on other property. */
  totalIndexRows: number;
  verifiedInstrumentCount: number;
  documents: { fileName: string; pages: number | null; ocrStatus: string; extractionStatus: string; sourceUrl: string | null }[];
  tracts: { label: string; confidence: number | null; matchStatus: string; associationType: string | null }[];
  openReviewItems: { title: string; detail: string | null }[];
  /**
   * County-clerk record searches only — the searches that can actually
   * produce a chain of title. The same log also holds the TRRC lookups that
   * resolved each API to a well; those are well resolution, not title, and
   * printing all of them buries the three searches a buyer needs to see, so
   * they are summarized in wellResolutionQueries instead.
   */
  countyCoverage: { provider: string; county: string | null; queryType: string; queryValue: string; status: string; resultCount: number }[];
  wellResolutionQueries: { total: number; succeeded: number; providers: string[] };
  analysis: { classification: string; version: number; findings: number } | null;
  ownership: { described: string; nri: string | null } | null;
  ownershipReason: string;
}

const MAX_LEADS = 24;

const ACTIVE_STAGES = ["pending", "resolving_wells", "searching_records", "ingesting", "analyzing"];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Normalized comparison of a county legal-description string to the subject lease/unit name. */
function matchesSubject(legal: string | null, leaseName: string | null): boolean {
  if (!legal || !leaseName) return false;
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const a = norm(legal), b = norm(leaseName);
  return a.includes(b) || b.includes(a);
}

export async function loadTitleForReport(
  supabase: SupabaseClient,
  userId: string,
  jobId: string | null,
  leaseName: string | null,
  /** Written by create-run.ts when title linkage could not be established. */
  setupWarning?: string | null,
): Promise<TitleReportInput> {
  const empty = (status: TitleReportInput["status"], headline: string, ownershipReason: string): TitleReportInput => ({
    status, headline, jobId, stageDetail: null, subjectLeads: [], subjectMatchedCount: 0, totalIndexRows: 0, verifiedInstrumentCount: 0,
    documents: [], tracts: [], openReviewItems: [], countyCoverage: [],
    wellResolutionQueries: { total: 0, succeeded: 0, providers: [] }, analysis: null, ownership: null, ownershipReason,
  });

  if (!jobId) {
    return empty("no_job",
      setupWarning
        ? `No title research scope is linked to this run — ${setupWarning}`
        : "No title research has been run for this well.",
      "Ownership is not established: no title research scope is linked to this run.");
  }

  let bundle: Awaited<ReturnType<typeof loadJobBundle>>;
  try {
    bundle = await loadJobBundle(supabase, jobId, userId);
  } catch {
    return empty("unavailable", "Title evidence could not be loaded for this report.", "Ownership is not established: the title record could not be read.");
  }
  if (!bundle) {
    return empty("unavailable", "The linked title research scope is not available under this account.", "Ownership is not established: the linked title scope is unavailable.");
  }

  // Parties and tracts are read from the normalized 027 tables rather than
  // extraction_json, because the two writers use different payload shapes:
  // the county-index sequencer stores {index: {...}} while document ingestion
  // stores the extracted instrument object. Both populate
  // title_instrument_parties / title_instrument_tracts identically, so
  // reading those is the only way one code path sees every instrument.
  const [instrumentsResult, partiesResult, tractsResult] = await Promise.all([
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instruments")
      .select("id, instrument_type, instrument_number, doc_number, recorded_date, instrument_content_verified, evidence_level")
      .eq("job_id", jobId).order("id").range(a, b)),
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instrument_parties").select("instrument_id, party_name, role").eq("job_id", jobId).order("id").range(a, b)),
    selectAll<Record<string, unknown>>((a, b) => supabase.from("title_instrument_tracts").select("instrument_id, legal_description").eq("job_id", jobId).order("id").range(a, b)),
  ]);

  const partyRows = partiesResult.error ? [] : (partiesResult.data ?? []);
  const tractRows = tractsResult.error ? [] : (tractsResult.data ?? []);
  const namesFor = (instrumentId: string, role: string) =>
    partyRows
      .filter(p => String(p["instrument_id"]) === instrumentId && String(p["role"]) === role)
      .map(p => str(p["party_name"]))
      .filter((n): n is string => n !== null);

  // A superseded index row is represented by its read copy; listing both
  // would show the same recording twice.
  const rows = (instrumentsResult.error ? [] : (instrumentsResult.data ?? [])).filter(r => r["evidence_level"] !== SUPERSEDED_EVIDENCE_LEVEL);
  const leads: TitleIndexLead[] = rows.map(r => {
    const id = String(r["id"]);
    const grantors = namesFor(id, "grantor");
    const grantees = namesFor(id, "grantee");
    const legals = tractRows
      .filter(t => String(t["instrument_id"]) === id)
      .map(t => str(t["legal_description"]))
      .filter((l): l is string => l !== null);
    return {
      instrumentType: str(r["instrument_type"]) ?? "other",
      instrumentNumber: str(r["instrument_number"]) ?? str(r["doc_number"]),
      recordedDate: str(r["recorded_date"]),
      grantor: grantors.length ? grantors.join("; ") : null,
      grantee: grantees.length ? grantees.join("; ") : null,
      legalDescription: legals.length ? legals.join(" | ") : null,
      contentVerified: r["instrument_content_verified"] === true,
    };
  });

  // Subject-matched leads lead the list. The rest are still shown (capped),
  // because a county index search returns everything recorded against the
  // operator and the parties, and a buyer reviewing title needs to see what
  // was actually retrieved rather than only what a string comparison of a
  // lease name against a clerk's legal description happened to catch.
  const byDate = (a: TitleIndexLead, b: TitleIndexLead) => (a.recordedDate ?? "").localeCompare(b.recordedDate ?? "");
  const matched = leads.filter(l => matchesSubject(l.legalDescription, leaseName)).sort(byDate);
  const unmatched = leads.filter(l => !matchesSubject(l.legalDescription, leaseName)).sort(byDate);
  const subjectLeads = [...matched, ...unmatched.slice(0, Math.max(0, MAX_LEADS - matched.length))];

  const analysisJson = bundle.latestAnalysis?.analysis_json as TitleChainAnalysis | undefined;
  let ownership: TitleReportInput["ownership"] = null;
  let ownershipReason = "Ownership is not established: no reviewed mineral position has been selected against the current title analysis.";
  if (analysisJson) {
    try {
      const loaded = await loadReviewedPosition(supabase, userId, analysisJson.wells?.[0]?.api14 ?? "", analysisJson);
      if (loaded.position) {
        const p = loaded.position as Record<string, unknown>;
        ownership = { described: str(p["describedAs"]) ?? "Reviewed mineral position", nri: str(p["nri"]) };
        ownershipReason = "Ownership below reflects an explicitly reviewed mineral position selected against this title analysis version.";
      } else if (loaded.reason) {
        ownershipReason = `Ownership is not established: ${loaded.reason}`;
      }
    } catch {
      ownershipReason = "Ownership is not established: the reviewed position could not be loaded.";
    }
  }

  const jobStatus = String(bundle.job.status);
  const status: TitleReportInput["status"] = bundle.latestAnalysis ? "analyzed"
    : ACTIVE_STAGES.includes(jobStatus) ? "in_progress"
    : "awaiting_review";
  const headline = bundle.latestAnalysis
    ? `Title analysis published (version ${bundle.latestAnalysis.version}).`
    : ACTIVE_STAGES.includes(jobStatus)
      ? "Title research is still running; no analysis has been published."
      : "Title research reached a review step; no analysis has been published.";

  return {
    status, headline, jobId,
    stageDetail: str((bundle.job as unknown as Record<string, unknown>)["stage_detail"]) ?? null,
    subjectLeads,
    subjectMatchedCount: matched.length,
    totalIndexRows: leads.length,
    verifiedInstrumentCount: leads.filter(l => l.contentVerified).length,
    documents: bundle.documents.map(d => ({
      fileName: str(d.file_name) ?? d.id,
      pages: typeof d.page_count === "number" ? d.page_count : null,
      ocrStatus: String(d.ocr_status),
      extractionStatus: String(d.extraction_status),
      sourceUrl: str(d.source_url),
    })),
    tracts: bundle.tracts.map(t => ({
      label: t.tractLabel || [t.surveyName, t.abstractNumber, t.blockNumber, t.sectionName, t.county].filter(Boolean).join(", "),
      confidence: typeof t.confidence === "number" ? t.confidence : null,
      matchStatus: String(t.matchStatus),
      associationType: bundle.associations.find(a => a.canonicalTractId === t.id)?.associationType ?? null,
    })),
    openReviewItems: bundle.reviewItems.filter(r => r.status === "open").map(r => ({ title: r.title, detail: str(r.detail) })),
    countyCoverage: bundle.searchLog.filter(l => String(l.provider).startsWith("county:")).map(l => ({
      provider: String(l.provider).replace(/^county:/, ""), county: l.county, queryType: l.query_type, queryValue: l.query_value,
      status: l.status, resultCount: typeof l.result_count === "number" ? l.result_count : 0,
    })),
    wellResolutionQueries: (() => {
      const rows = bundle.searchLog.filter(l => !String(l.provider).startsWith("county:"));
      return {
        total: rows.length,
        succeeded: rows.filter(l => String(l.status) === "success").length,
        providers: [...new Set(rows.map(l => String(l.provider)))].sort(),
      };
    })(),
    analysis: bundle.latestAnalysis ? {
      classification: String(bundle.latestAnalysis.status_classification),
      version: bundle.latestAnalysis.version,
      findings: Array.isArray((analysisJson as unknown as Record<string, unknown>)?.["findings"]) ? ((analysisJson as unknown as Record<string, unknown>)["findings"] as unknown[]).length : 0,
    } : null,
    ownership,
    ownershipReason,
  };
}
