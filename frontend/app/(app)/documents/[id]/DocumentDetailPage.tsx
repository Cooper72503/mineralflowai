"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import type { DealScoreResult } from "@/lib/document-processing/deal-score";
import { getGradeFromScore } from "@/lib/document-processing/deal-score";
import { DealScoreHotBadge } from "@/app/components/DealScoreHotBadge";
import {
  coerceDealScoreResult,
  dealGradeFullLabelFromScore,
  dealScoreDisplayValue,
  dealScoreFromExtractionColumns,
  dealScoreFromStructuredBlobOnly,
  mergeStructuredFields,
} from "@/lib/deals/dashboard-normalize";

function logDocumentDetailDealScores(ext: ExtractionRow, scoreDisplayed: number | null, label: string) {
  const fromData = dealScoreFromStructuredBlobOnly(ext.structured_data)?.score ?? null;
  const fromJson = dealScoreFromStructuredBlobOnly(ext.structured_json)?.score ?? null;
  const fromMerge = dealScoreFromExtractionColumns(ext.structured_data, ext.structured_json)?.score ?? null;
  console.log(`[document-detail] ${label}`, {
    "SCORE FROM STRUCTURED_DATA": fromData,
    "SCORE FROM STRUCTURED_JSON": fromJson,
    "SCORE FROM MERGE": fromMerge,
    "SCORE DISPLAYED": scoreDisplayed,
  });
}

const EXTRACTION_SELECT =
  "id, document_id, extracted_text, lessor, lessee, county, state, legal_description, effective_date, recording_date, royalty_rate, term_length, confidence_score, created_at, structured_data, structured_json";

type DocumentRow = {
  id: string;
  file_name: string | null;
  county: string | null;
  state: string | null;
  document_type: string | null;
  file_size: number | null;
  status: string | null;
  storage_path: string | null;
  created_at: string;
  processed_at: string | null;
  error_message: string | null;
};

type ExtractionRow = {
  id: string;
  document_id: string;
  extracted_text: string | null;
  lessor: string | null;
  lessee: string | null;
  county: string | null;
  state: string | null;
  legal_description: string | null;
  effective_date: string | null;
  recording_date: string | null;
  royalty_rate: string | null;
  term_length: string | null;
  confidence_score: number | null;
  created_at: string;
  structured_data?: unknown;
  structured_json?: unknown;
};

/** Merges legacy + primary JSON (same as dashboard) and applies API `deal_score` for immediate UI. */
function attachDealScoreFromApi(row: ExtractionRow, dealScore: unknown): ExtractionRow {
  const coerced = coerceDealScoreResult(dealScore);
  if (!coerced) return row;
  const merged = mergeStructuredFields(row.structured_data, row.structured_json);
  return { ...row, structured_data: { ...merged, deal_score: coerced } };
}

function dealScoreCardSurface(letter: ReturnType<typeof getGradeFromScore>): {
  background: string;
  borderColor: string;
} {
  switch (letter) {
    case "A":
      return { background: "#dcfce7", borderColor: "#86efac" };
    case "B":
      return { background: "#fef9c3", borderColor: "#fde047" };
    case "C":
      return { background: "#fee2e2", borderColor: "#fecaca" };
    case "D":
      return { background: "#f3f4f6", borderColor: "#e5e7eb" };
  }
}

function DealScoreCard({ dealScore }: { dealScore: DealScoreResult }) {
  const letter = getGradeFromScore(dealScore.score);
  const surface = dealScoreCardSurface(letter);
  const gradeLabel = dealGradeFullLabelFromScore(dealScore.score);
  return (
    <div
      className="card"
      style={{
        maxWidth: 560,
        marginBottom: "1rem",
        background: surface.background,
        borderColor: surface.borderColor,
      }}
    >
      <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>Deal score</h2>
      <dl style={{ display: "flex", flexDirection: "column", gap: "0.65rem", marginBottom: "0.75rem" }}>
        <div>
          <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Grade</dt>
          <dd style={{ fontSize: "0.95rem", margin: 0 }}>{gradeLabel}</dd>
        </div>
        <div>
          <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Score</dt>
          <dd
            style={{
              fontSize: "0.95rem",
              margin: 0,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              gap: "0.15rem",
            }}
          >
            {dealScoreDisplayValue(dealScore)}
            <DealScoreHotBadge
              score={dealScore.incomplete_data ? undefined : dealScore.score}
            />
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Reasons</dt>
          <dd style={{ margin: 0 }}>
            {dealScore.reasons.length > 0 ? (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  fontSize: "0.9rem",
                  lineHeight: 1.5,
                  color: "#333",
                }}
              >
                {dealScore.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            ) : (
              <span style={{ color: "#666", fontSize: "0.9rem" }}>—</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadgeClass(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "completed" || s === "processed") return "badge badgeActive";
  if (s === "processing" || s === "queued") return "badge badgeNew";
  if (s === "failed") return "badge badgeFailed";
  return "badge badgePending";
}

export default function DocumentDetailPage() {
  const params = useParams();
  const id = typeof params?.id === "string" ? params.id : "";
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [extraction, setExtraction] = useState<ExtractionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dealScoreOverride, setDealScoreOverride] = useState<DealScoreResult | null>(null);
  const dealScoreOverrideRef = useRef<DealScoreResult | null>(null);
  const syncRequestedRef = useRef(false);
  const [syncDebugBusy, setSyncDebugBusy] = useState(false);

  useEffect(() => {
    dealScoreOverrideRef.current = dealScoreOverride;
  }, [dealScoreOverride]);

  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    setDealScoreOverride(null);
    syncRequestedRef.current = false;
  }, [id]);

  const displayDealScore = useMemo(() => {
    if (dealScoreOverride) return dealScoreOverride;
    if (!extraction) return null;
    return dealScoreFromExtractionColumns(extraction.structured_data, extraction.structured_json);
  }, [extraction, dealScoreOverride]);

  useEffect(() => {
    if (!displayDealScore) return;
    console.log("SCORE LOADED", displayDealScore.score);
    console.log("GRADE LOADED", displayDealScore.grade);
    console.log("GRADE FROM SCORE", getGradeFromScore(displayDealScore.score));
    console.log("[score-debug] score =", displayDealScore.score);
    console.log("[score-debug] grade =", getGradeFromScore(displayDealScore.score));
  }, [displayDealScore]);

  useEffect(() => {
    if (!extraction) return;
    logDocumentDetailDealScores(
      extraction,
      displayDealScore?.score ?? null,
      "on load"
    );
  }, [extraction, displayDealScore]);

  useEffect(() => {
    if (!id) {
      setError("Invalid document ID.");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchDocument() {
      setLoading(true);
      setError(null);
      try {
        const { data, error: fetchError } = await supabase
          .from("documents")
          .select("id, file_name, county, state, document_type, file_size, status, storage_path, created_at, processed_at, error_message")
          .eq("id", id)
          .maybeSingle();

        if (cancelled) return;

        if (fetchError) {
          setError(
            fetchError.code === "PGRST301"
              ? "You don't have permission to view this document."
              : fetchError.message || "Failed to load document."
          );
          setDoc(null);
          setExtraction(null);
          return;
        }

        if (!data) {
          setError("Document not found or you don't have access.");
          setDoc(null);
          setExtraction(null);
          return;
        }

        setDoc(data as DocumentRow);

        const { data: extData } = await supabase
          .from("document_extractions")
          .select(EXTRACTION_SELECT)
          .eq("document_id", id)
          .maybeSingle();
        if (!cancelled) {
          const ext = (extData as ExtractionRow) ?? null;
          setExtraction(ext);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load document.");
          setDoc(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDocument();
    return () => {
      cancelled = true;
    };
  }, [id, supabase]);

  useEffect(() => {
    if (processing) {
      syncRequestedRef.current = false;
    }
  }, [processing]);

  useEffect(() => {
    if (processing) return;
    if (!id || !doc || doc.status !== "completed" || !extraction?.id) return;
    if (syncRequestedRef.current) return;
    syncRequestedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const res = await fetch(`/api/documents/${id}/sync-deal-score`, {
          method: "POST",
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          updated?: boolean;
        };
        if (cancelled || !res.ok || body.ok !== true) {
          if (!cancelled) syncRequestedRef.current = false;
          return;
        }

        const { data: extData } = await supabase
          .from("document_extractions")
          .select(EXTRACTION_SELECT)
          .eq("document_id", id)
          .maybeSingle();
        if (cancelled || !extData) return;
        const extRow = extData as ExtractionRow;
        setExtraction(extRow);
      } catch {
        syncRequestedRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, doc?.status, extraction?.id, processing, supabase]);

  async function handleOpenDownload() {
    setActionError(null);
    const file_path = doc?.storage_path ?? null;
    if (!file_path) {
      setActionError("No file available for this document.");
      return;
    }
    console.log("[Documents] createSignedUrl using file_path from documents table:", file_path);
    try {
      const { data, error } = await supabase.storage
        .from("documents")
        .createSignedUrl(file_path, 60);
      if (error) {
        const isNotFound =
          (error.message ?? "").toLowerCase().includes("not found") ||
          (error.message ?? "").toLowerCase().includes("object not found");
        setActionError(
          isNotFound
            ? "This file is no longer available. It may have been moved or deleted."
            : error.message || "Failed to get download link."
        );
        return;
      }
      if (data?.signedUrl) {
        window.open(data.signedUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Download failed.");
    }
  }

  async function handleDebugResyncDealScore() {
    if (!id) return;
    setSyncDebugBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(`/api/documents/${id}/sync-deal-score`, {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      await res.json().catch(() => ({}));
      const { data: extData } = await supabase
        .from("document_extractions")
        .select(EXTRACTION_SELECT)
        .eq("document_id", id)
        .maybeSingle();
      if (extData) {
        const extRow = extData as ExtractionRow;
        setExtraction(extRow);
        const mergedScore =
          dealScoreFromExtractionColumns(extRow.structured_data, extRow.structured_json)?.score ?? null;
        logDocumentDetailDealScores(
          extRow,
          dealScoreOverrideRef.current?.score ?? mergedScore,
          "after debug re-sync"
        );
      }
    } finally {
      setSyncDebugBusy(false);
    }
  }

  async function handleProcessDocument() {
    setActionError(null);
    setActionSuccess(null);
    if (!id) return;
    setProcessing(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(`/api/documents/${id}/process`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const body = await res.json().catch(() => ({}));
      const apiOk = res.ok && body?.ok === true;
      if (!apiOk) {
        const step = body?.step_failed || body?.step ? ` (step: ${body.step_failed ?? body.step})` : "";
        setActionError(body.error_message || body.error || `Request failed (${res.status}).${step}`);

        // Best-effort refresh so `failed` status + any raw-text fallback extraction
        // are visible immediately (instead of requiring a full page reload).
        try {
          const { data: refreshedDoc, error: refreshedDocErr } = await supabase
            .from("documents")
            .select("id, file_name, county, state, document_type, file_size, status, storage_path, created_at, processed_at, error_message")
            .eq("id", id)
            .maybeSingle();

          if (!refreshedDocErr && refreshedDoc != null) {
            setDoc(refreshedDoc as DocumentRow);
          }

          const { data: refreshedExtraction, error: refreshedExtractionErr } = await supabase
            .from("document_extractions")
            .select(EXTRACTION_SELECT)
            .eq("document_id", id)
            .maybeSingle();

          if (!refreshedExtractionErr && refreshedExtraction != null) {
            setExtraction(refreshedExtraction as ExtractionRow);
          }
        } catch {
          // Ignore refresh errors; we still show the actionError from the API response.
        }
        return;
      }

      const coercedScore = coerceDealScoreResult(body?.deal_score);
      if (coercedScore) {
        setDealScoreOverride(coercedScore);
      }

      // Prefer the structured extraction returned by the API.
      if (body?.extraction) {
        const row = attachDealScoreFromApi(body.extraction as ExtractionRow, body.deal_score);
        setExtraction(row);
      } else {
        // Fallback: reload from DB (in case the API response didn't include extraction).
        const { data, error: fetchError } = await supabase
          .from("documents")
          .select("id, file_name, county, state, document_type, file_size, status, storage_path, created_at, processed_at, error_message")
          .eq("id", id)
          .maybeSingle();
        if (!fetchError && data) setDoc(data as DocumentRow);

        const { data: extData } = await supabase
          .from("document_extractions")
          .select(EXTRACTION_SELECT)
          .eq("document_id", id)
          .maybeSingle();
        const ext = (extData as ExtractionRow) ?? null;
        setExtraction(ext != null ? attachDealScoreFromApi(ext, body.deal_score) : null);
      }

      if (body?.document) {
        setDoc((prev) =>
          prev
            ? ({
                ...prev,
                status: body.document.status ?? prev.status,
                processed_at: body.document.processed_at ?? body.document.completed_at ?? prev.processed_at,
              } as DocumentRow)
            : prev
        );
      }

      setActionSuccess("Document extraction completed.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start processing.");
    } finally {
      // Always refresh after an attempt so we don't leave the UI in a stale queued/processing state.
      try {
        const { data: refreshedDoc, error: refreshedDocErr } = await supabase
          .from("documents")
          .select("id, file_name, county, state, document_type, file_size, status, storage_path, created_at, processed_at, error_message")
          .eq("id", id)
          .maybeSingle();

        if (!refreshedDocErr && refreshedDoc != null) {
          setDoc(refreshedDoc as DocumentRow);
        }

        const { data: refreshedExtraction, error: refreshedExtractionErr } = await supabase
          .from("document_extractions")
          .select(EXTRACTION_SELECT)
          .eq("document_id", id)
          .maybeSingle();

        if (!refreshedExtractionErr && refreshedExtraction != null) {
          setExtraction(refreshedExtraction as ExtractionRow);
        }
      } catch {
        // ignore refresh issues
      }
      setProcessing(false);
    }
  }

  if (loading) {
    return (
      <div className="container">
        <div style={{ marginBottom: "1.5rem" }}>
          <Link
            href="/documents"
            style={{
              fontSize: "0.9rem",
              marginBottom: "0.5rem",
              display: "inline-block",
            }}
          >
            ← Back to documents
          </Link>
        </div>
        <div className="card">
          <p style={{ color: "#666", fontSize: "0.9rem" }}>Loading…</p>
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="container">
        <div style={{ marginBottom: "1.5rem" }}>
          <Link
            href="/documents"
            style={{
              fontSize: "0.9rem",
              marginBottom: "0.5rem",
              display: "inline-block",
            }}
          >
            ← Back to documents
          </Link>
        </div>
        <div className="card">
          <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>
            {error ?? "Document not found or you don't have access."}
          </p>
        </div>
      </div>
    );
  }

  const meta = [
    { label: "File name", value: doc.file_name ?? "—" },
    { label: "County", value: doc.county ?? "—" },
    { label: "State", value: doc.state ?? "—" },
    { label: "Document type", value: doc.document_type ?? "—" },
    {
      label: "Status",
      value: (
        <span className={statusBadgeClass(doc.status)}>
          {doc.status ?? "—"}
        </span>
      ),
    },
    { label: "Created at", value: formatDate(doc.created_at) },
    { label: "Completed at", value: doc.processed_at ? formatDate(doc.processed_at) : "—" },
    { label: "File size", value: formatFileSize(doc.file_size) },
  ];
  if (doc.error_message) {
    meta.push({ label: "Error", value: doc.error_message });
  }

  return (
    <div className="container">
      <div style={{ marginBottom: "1.5rem" }}>
        <Link
          href="/documents"
          style={{
            fontSize: "0.9rem",
            marginBottom: "0.5rem",
            display: "inline-block",
          }}
        >
          ← Back to documents
        </Link>
      </div>

      <div className="pageHeader">
        <h1>Document details</h1>
        <p>{doc.file_name ?? "Document"}</p>
      </div>

      {(doc.status === "processing" || doc.status === "queued" || processing) && (
        <div
          className="card"
          style={{
            marginBottom: "1rem",
            background: "#e0e7ff",
            borderColor: "#a5b4fc",
          }}
        >
          <p style={{ color: "#3730a3", fontSize: "0.9rem", fontWeight: 500 }}>
            Processing document… Extraction may take a moment. This page will not auto-refresh; you can run &quot;Process Document&quot; again to check for results.
          </p>
        </div>
      )}

      {doc.status === "failed" && doc.error_message && (
        <div
          className="card"
          style={{
            marginBottom: "1rem",
            background: "#fee2e2",
            borderColor: "#fecaca",
          }}
        >
          <p style={{ color: "#b91c1c", fontSize: "0.9rem", fontWeight: 500 }}>
            Processing failed: {doc.error_message}
          </p>
        </div>
      )}

      <div className="card" style={{ maxWidth: 560, marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Metadata
        </h2>
        <dl style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {meta.map(({ label, value }) => (
            <div key={label}>
              <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>
                {label}
              </dt>
              <dd style={{ fontSize: "0.95rem" }}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {displayDealScore ? <DealScoreCard dealScore={displayDealScore} /> : null}

      <div className="card" style={{ maxWidth: 560, marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Extracted data
        </h2>
        {extraction ? (
          (() => {
            const hasAny =
              extraction.extracted_text != null && extraction.extracted_text !== "" ||
              extraction.lessor != null && extraction.lessor !== "" ||
              extraction.lessee != null && extraction.lessee !== "" ||
              extraction.county != null && extraction.county !== "" ||
              extraction.state != null && extraction.state !== "" ||
              extraction.legal_description != null && extraction.legal_description !== "" ||
              extraction.effective_date != null && extraction.effective_date !== "" ||
              extraction.recording_date != null && extraction.recording_date !== "" ||
              extraction.royalty_rate != null && extraction.royalty_rate !== "" ||
              extraction.term_length != null && extraction.term_length !== "" ||
              extraction.confidence_score != null;
            if (!hasAny) {
              return (
                <p style={{ color: "#666", fontSize: "0.9rem" }}>
                  No extracted data yet. Run &quot;Process Document&quot; to run extraction; a real OCR/AI parser can fill these fields.
                </p>
              );
            }
            const extMeta = [
              { label: "Lessor", value: extraction.lessor ?? "—" },
              { label: "Lessee", value: extraction.lessee ?? "—" },
              { label: "County", value: extraction.county ?? "—" },
              { label: "State", value: extraction.state ?? "—" },
              { label: "Legal description", value: extraction.legal_description ?? "—" },
              { label: "Effective date", value: extraction.effective_date ?? "—" },
              { label: "Recording date", value: extraction.recording_date ?? "—" },
              { label: "Royalty rate", value: extraction.royalty_rate ?? "—" },
              { label: "Term length", value: extraction.term_length ?? "—" },
              { label: "Confidence score", value: extraction.confidence_score != null ? String(extraction.confidence_score) : "—" },
            ];
            return (
              <>
                {extraction.extracted_text != null && extraction.extracted_text !== "" && (
                  <div style={{ marginBottom: "0.75rem" }}>
                    <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Extracted text</dt>
                    <dd style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", padding: "0.5rem", background: "#f9f9f9", borderRadius: 6 }}>{extraction.extracted_text}</dd>
                  </div>
                )}
                <dl style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {extMeta.map(({ label, value }) => (
                    <div key={label}>
                      <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>{label}</dt>
                      <dd style={{ fontSize: "0.95rem" }}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            );
          })()
        ) : (
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            No extracted data yet. Process this document to create an extraction record; fields will be filled when an OCR/AI parser is connected.
          </p>
        )}
      </div>

      {actionError && (
        <p style={{ color: "#b91c1c", fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          {actionError}
        </p>
      )}

      {actionSuccess && (
        <p style={{ color: "#15803d", fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          {actionSuccess}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
        <button
          type="button"
          className="btn btnPrimary"
          onClick={handleOpenDownload}
          disabled={!doc.storage_path}
        >
          Open / Download file
        </button>
        <button
          type="button"
          className="btn btnSecondary"
          onClick={handleProcessDocument}
          disabled={processing || doc.status === "processing" || doc.status === "queued"}
        >
          {processing || doc.status === "processing" || doc.status === "queued" ? "Processing…" : "Process Document"}
        </button>
        {doc.status === "completed" && extraction?.id ? (
          <button
            type="button"
            className="btn btnSecondary"
            onClick={handleDebugResyncDealScore}
            disabled={syncDebugBusy}
          >
            {syncDebugBusy ? "Re-syncing…" : "Re-sync deal score (debug)"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
