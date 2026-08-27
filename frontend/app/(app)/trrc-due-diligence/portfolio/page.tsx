"use client";

/**
 * TRRC Due Diligence — Portfolio / Bulk Upload
 *
 * Asked for directly in the 2026-08-18 Novi call: "do I load into your
 * software a bunch of APIs? Then does it bring back the volumes of
 * those?" Paste a list of wells, submit them all at once, watch each one
 * complete, jump into any individual report.
 *
 * V1 scope, deliberately: the batch (list of run ids) lives in this page's
 * React state, not a persisted "batch" table — a reload mid-batch loses
 * the grouping (each individual run is still safe and resumable from its
 * own report link, exactly like the single-run page). A real portfolio
 * table that survives a refresh, and an aggregate rollup (summed
 * portfolio value, not just per-well numbers), are real fast-follows —
 * see MineralFlow_Decision_Pipeline build notes — not shipped half-done
 * here the night before a demo.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import { COLORS } from "../page";

type RowStatus = "creating" | "create_failed" | "pending" | "running" | "complete" | "failed" | "cancelled" | "awaiting_selection" | string;

interface BatchRow {
  input: string;
  runId: string | null;
  status: RowStatus;
  progress: number;
  error: string | null;
}

const POLL_MS = 3000;

export default function PortfolioPage() {
  const apiFetch = useApiFetch();
  const [rawText, setRawText] = useState("");
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parseInputs = useCallback((text: string): string[] => {
    return Array.from(new Set(
      text.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0),
    ));
  }, []);

  // "Putting a PDF of 50 API's and receiving overviews of each well" —
  // extracts candidates server-side, then drops them into the SAME
  // editable textarea the manual-paste path uses rather than submitting
  // directly. Extraction from an arbitrary PDF can have false positives
  // (page numbers, dates); showing the result for review before it turns
  // into 50 real runs matches this project's rule against silently
  // trusting an unverified guess.
  const handlePdfUpload = useCallback(async (file: File) => {
    setExtracting(true);
    setExtractNote(null);
    setSubmitError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/trrc/due-diligence/extract-apis", { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) {
        setSubmitError(data.error ?? "Could not extract API numbers from that PDF.");
        return;
      }
      const found: string[] = data.data.apiNumbersFound;
      if (found.length === 0) {
        setExtractNote("No recognizable API numbers found in this PDF — review it below and paste manually if needed.");
        return;
      }
      setRawText(prev => {
        const existing = parseInputs(prev);
        const merged = Array.from(new Set([...existing, ...found]));
        return merged.join("\n");
      });
      setExtractNote(`Found ${found.length} API number${found.length === 1 ? "" : "s"} in "${file.name}" — review the list below before running.`);
    } catch {
      setSubmitError("Lost connection while reading the PDF.");
    } finally {
      setExtracting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [apiFetch, parseInputs]);

  const inputCount = parseInputs(rawText).length;

  const handleSubmit = useCallback(async () => {
    const inputs = parseInputs(rawText);
    if (inputs.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setRows(inputs.map(input => ({ input, runId: null, status: "creating", progress: 0, error: null })));

    try {
      const res = await apiFetch("/api/trrc/due-diligence/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSubmitError(data.error ?? "Failed to submit batch.");
        setRows([]);
        return;
      }
      const results = data.data.results as Array<{ original_input: string; ok: boolean; id?: string; status?: string; needs_user_selection?: boolean; error?: string }>;
      setRows(results.map(r => ({
        input: r.original_input,
        runId: r.ok ? r.id ?? null : null,
        status: r.ok ? (r.needs_user_selection ? "awaiting_selection" : (r.status ?? "pending")) : "create_failed",
        progress: 0,
        error: r.ok ? null : (r.error ?? "Failed to create run"),
      })));
    } catch {
      setSubmitError("Lost connection while submitting the batch.");
      setRows([]);
    } finally {
      setSubmitting(false);
    }
  }, [rawText, apiFetch, parseInputs]);

  // Poll every run in the batch that isn't in a terminal state yet.
  useEffect(() => {
    const hasActive = rows.some(r => r.runId && !["complete", "failed", "cancelled", "create_failed"].includes(r.status));
    if (!hasActive) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    const interval = setInterval(async () => {
      const updates = await Promise.all(
        rows.map(async (row) => {
          if (!row.runId || ["complete", "failed", "cancelled", "create_failed"].includes(row.status)) return row;
          try {
            const res = await apiFetch(`/api/trrc/due-diligence/${row.runId}`);
            const data = await res.json();
            if (!data.ok) return row;
            return {
              ...row,
              status: data.data.status as RowStatus,
              progress: (data.data.progress_percent as number) ?? row.progress,
            };
          } catch {
            return row;
          }
        }),
      );
      setRows(updates);
    }, POLL_MS);

    pollRef.current = interval;
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map(r => `${r.runId}:${r.status}`).join(","), apiFetch]);

  const [bundling, setBundling] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);

  // "Upload a list of APIs... spit out a report for me... one PDF report" —
  // closes the gap between a completed batch and actually having the
  // reports in hand: one click here instead of opening each row and
  // downloading individually.
  const handleDownloadAll = useCallback(async () => {
    const completedIds = rows.filter(r => r.status === "complete" && r.runId).map(r => r.runId as string);
    if (completedIds.length === 0) return;
    setBundling(true);
    setBundleError(null);
    try {
      const res = await apiFetch("/api/trrc/due-diligence/bulk-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds: completedIds }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to build the report bundle." }));
        setBundleError(data.error ?? "Failed to build the report bundle.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `TRRC_DD_Portfolio_Reports_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setBundleError("Lost connection while building the report bundle.");
    } finally {
      setBundling(false);
    }
  }, [rows, apiFetch]);

  const statusColor = (status: RowStatus): string => {
    if (status === "complete") return COLORS.green;
    if (status === "failed" || status === "cancelled" || status === "create_failed") return COLORS.red;
    if (status === "awaiting_selection") return COLORS.yellow;
    return COLORS.accent;
  };

  const statusLabel = (status: RowStatus): string => {
    const labels: Record<string, string> = {
      creating: "Submitting…",
      create_failed: "Failed to Start",
      pending: "Queued",
      running: "Running",
      resolving: "Resolving",
      retrieving: "Retrieving",
      analyzing: "Analyzing",
      generating: "Generating Report",
      awaiting_selection: "Needs Selection",
      complete: "Complete",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    return labels[status] ?? status;
  };

  const completedCount = rows.filter(r => r.status === "complete").length;
  const failedCount = rows.filter(r => r.status === "failed" || r.status === "cancelled" || r.status === "create_failed").length;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, padding: "2rem", fontFamily: "-apple-system, sans-serif" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <Link href="/trrc-due-diligence" style={{ fontSize: "0.8rem", color: COLORS.textMuted, textDecoration: "none" }}>← Single well</Link>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.text, margin: "0.5rem 0 0.3rem 0" }}>Portfolio Due Diligence</h1>
          <p style={{ fontSize: "0.85rem", color: COLORS.textMuted, margin: 0 }}>
            Upload a PDF of well numbers, or paste a list directly — up to 50 at once. Each runs the full diligence pipeline independently.
          </p>
        </div>

        {rows.length === 0 && (
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.9rem" }}>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handlePdfUpload(f); }}
                disabled={extracting}
                style={{ display: "none" }}
                id="portfolio-pdf-upload"
              />
              <label
                htmlFor="portfolio-pdf-upload"
                style={{
                  background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 7,
                  color: extracting ? COLORS.textFaint : COLORS.text, fontSize: "0.82rem", fontWeight: 600,
                  padding: "0.55rem 1rem", cursor: extracting ? "default" : "pointer",
                }}
              >
                {extracting ? "Reading PDF…" : "Upload a PDF of well numbers"}
              </label>
              <span style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>— or paste directly below</span>
            </div>
            {extractNote && (
              <div style={{ marginBottom: "0.75rem", background: COLORS.accentDim, border: `1px solid ${COLORS.accent}`, borderRadius: 7, padding: "0.55rem 0.85rem", color: COLORS.accent, fontSize: "0.78rem" }}>
                {extractNote}
              </div>
            )}
            <textarea
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              placeholder={"42-329-42230\n42-165-02733\n42-165-10760\n..."}
              rows={10}
              style={{
                width: "100%", background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`,
                borderRadius: 7, color: COLORS.text, fontSize: "0.85rem", padding: "0.75rem",
                fontFamily: "monospace", resize: "vertical" as const,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "0.75rem" }}>
              <div style={{ fontSize: "0.75rem", color: COLORS.textFaint }}>
                {inputCount} well{inputCount === 1 ? "" : "s"} detected{inputCount > 50 ? " — 50 maximum per batch" : ""}
              </div>
              <button
                onClick={handleSubmit}
                disabled={submitting || inputCount === 0 || inputCount > 50}
                style={{
                  background: COLORS.accent, color: "#fff", border: "none", borderRadius: 7,
                  padding: "0.6rem 1.4rem", fontSize: "0.85rem", fontWeight: 600,
                  cursor: submitting || inputCount === 0 || inputCount > 50 ? "default" : "pointer",
                  opacity: submitting || inputCount === 0 || inputCount > 50 ? 0.5 : 1,
                }}
              >
                {submitting ? "Submitting…" : `Run ${inputCount || ""} Well${inputCount === 1 ? "" : "s"}`}
              </button>
            </div>
            {submitError && (
              <div style={{ marginTop: "0.75rem", background: COLORS.redDim, border: `1px solid ${COLORS.red}`, borderRadius: 7, padding: "0.6rem 0.9rem", color: COLORS.red, fontSize: "0.8rem" }}>
                {submitError}
              </div>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}>
              <div style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.6rem 1rem", fontSize: "0.8rem", color: COLORS.text }}>
                <b>{completedCount}</b> / {rows.length} complete
              </div>
              {failedCount > 0 && (
                <div style={{ background: COLORS.redDim, border: `1px solid ${COLORS.red}`, borderRadius: 8, padding: "0.6rem 1rem", fontSize: "0.8rem", color: COLORS.red }}>
                  <b>{failedCount}</b> failed
                </div>
              )}
              <button
                onClick={handleDownloadAll}
                disabled={completedCount === 0 || bundling}
                style={{
                  marginLeft: "auto", background: COLORS.accent, color: "#fff", border: "none", borderRadius: 7,
                  fontSize: "0.8rem", fontWeight: 600, padding: "0.55rem 1.1rem",
                  cursor: completedCount === 0 || bundling ? "default" : "pointer",
                  opacity: completedCount === 0 || bundling ? 0.5 : 1,
                }}
              >
                {bundling ? "Building bundle…" : `Download ${completedCount > 0 ? completedCount : ""} Report${completedCount === 1 ? "" : "s"} (ZIP)`}
              </button>
              <button
                onClick={() => { setRows([]); setRawText(""); }}
                style={{ background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 7, color: COLORS.textMuted, fontSize: "0.78rem", padding: "0.5rem 0.9rem", cursor: "pointer" }}
              >
                New Batch
              </button>
            </div>
            {bundleError && (
              <div style={{ marginBottom: "1rem", background: COLORS.redDim, border: `1px solid ${COLORS.red}`, borderRadius: 7, padding: "0.6rem 0.9rem", color: COLORS.red, fontSize: "0.8rem" }}>
                {bundleError}
              </div>
            )}

            <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: "0.82rem" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${COLORS.borderStrong}` }}>
                    {["Well", "Status", "Progress", ""].map(h => (
                      <th key={h} style={{ textAlign: "left" as const, padding: "0.6rem 0.9rem", color: COLORS.textMuted, fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${COLORS.border}` : "none" }}>
                      <td style={{ padding: "0.65rem 0.9rem", color: COLORS.text, fontFamily: "monospace" }}>{row.input}</td>
                      <td style={{ padding: "0.65rem 0.9rem" }}>
                        <span style={{ color: statusColor(row.status), fontWeight: 600 }}>{statusLabel(row.status)}</span>
                        {row.error && <div style={{ color: COLORS.textFaint, fontSize: "0.72rem", marginTop: 2 }}>{row.error}</div>}
                      </td>
                      <td style={{ padding: "0.65rem 0.9rem", color: COLORS.textMuted, width: 90 }}>
                        {row.status === "complete" ? "100%" : row.runId && !["failed", "cancelled", "create_failed"].includes(row.status) ? `${row.progress}%` : "—"}
                      </td>
                      <td style={{ padding: "0.65rem 0.9rem", width: 100 }}>
                        {row.status === "complete" && row.runId && (
                          <Link href={`/trrc-due-diligence?run=${row.runId}`} style={{ color: COLORS.accent, fontSize: "0.78rem", fontWeight: 600, textDecoration: "none" }}>
                            View →
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
