"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import { gradeLetter } from "@/lib/deals/dashboard-normalize";
import { EM_DASH, fetchProcessedDealById, type ProcessedDealRow } from "@/lib/deals/processed-deals-query";
import { DealScoreHotBadge } from "@/app/components/DealScoreHotBadge";

function gradeBadgeStyle(letter: "A" | "B" | "C" | null): CSSProperties {
  if (letter === "A") {
    return { background: "#dcfce7", color: "#166534", border: "1px solid #86efac" };
  }
  if (letter === "B") {
    return { background: "#fef9c3", color: "#854d0e", border: "1px solid #fde047" };
  }
  if (letter === "C") {
    return { background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca" };
  }
  return { background: "#f3f4f6", color: "#6b7280", border: "1px solid #e5e7eb" };
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
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

export default function LeadDetailPage() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : "";
  const supabase = useMemo(() => createClient(), []);
  const [row, setRow] = useState<ProcessedDealRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setRow(null);
      setLoading(false);
      setError("Missing lead id.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { row: next, error: err } = await fetchProcessedDealById(supabase, id);
      if (err) {
        setError(err);
        setRow(null);
        return;
      }
      setRow(next);
      if (!next) {
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load lead.");
      setRow(null);
    } finally {
      setLoading(false);
    }
  }, [supabase, id]);

  useEffect(() => {
    load();
  }, [load]);

  const letter = row ? gradeLetter(row.dealScore?.grade ?? null) : null;

  return (
    <div className="container">
      <div style={{ marginBottom: "1.5rem" }}>
        <Link
          href="/leads"
          style={{
            fontSize: "0.9rem",
            marginBottom: "0.5rem",
            display: "inline-block",
          }}
        >
          ← Back to leads
        </Link>
      </div>

      {loading && (
        <div className="card">
          <p style={{ color: "#666", fontSize: "0.9rem" }}>Loading…</p>
        </div>
      )}

      {!loading && error && (
        <div className="card">
          <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{error}</p>
        </div>
      )}

      {!loading && !error && !row && (
        <div className="pageHeader">
          <h1>Lead not found</h1>
          <p>This id is not a completed deal, or you do not have access.</p>
        </div>
      )}

      {!loading && !error && row && (
        <>
          <div className="pageHeader">
            <h1 style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
              <span
                className="badge"
                style={{
                  ...gradeBadgeStyle(letter),
                  fontWeight: 600,
                  minWidth: "1.75rem",
                  textAlign: "center",
                }}
              >
                {letter ?? "—"}
              </span>
              <span>Lead</span>
            </h1>
            <p style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0.35rem" }}>
              <span>Score</span>
              <span style={{ fontWeight: 600 }}>
                {row.dealScore != null ? row.dealScore.score : EM_DASH}
              </span>
              <DealScoreHotBadge score={row.dealScore?.score} />
              {row.dealScore && <span>· {row.dealScore.grade}</span>}
            </p>
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>Summary</h2>
            <dl style={{ display: "grid", gap: "0.6rem", margin: 0, fontSize: "0.92rem" }}>
              <div>
                <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>Owner</dt>
                <dd style={{ margin: 0 }}>{row.owner}</dd>
              </div>
              <div>
                <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>Location</dt>
                <dd style={{ margin: 0 }}>
                  {[row.county?.trim(), row.state?.trim()].filter(Boolean).join(", ") || EM_DASH}
                </dd>
              </div>
              <div>
                <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>Acres</dt>
                <dd style={{ margin: 0 }}>{row.acres}</dd>
              </div>
              <div>
                <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>Lease status</dt>
                <dd style={{ margin: 0 }}>{row.leaseStatus}</dd>
              </div>
              <div>
                <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>Document type</dt>
                <dd style={{ margin: 0 }}>{row.docType}</dd>
              </div>
              <div>
                <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>Completed</dt>
                <dd style={{ margin: 0 }}>{formatDate(row.completed_at ?? row.processed_at)}</dd>
              </div>
              {row.file_name?.trim() && (
                <div>
                  <dt style={{ fontSize: "0.8rem", color: "#666", marginBottom: "0.15rem" }}>File</dt>
                  <dd style={{ margin: 0 }}>{row.file_name}</dd>
                </div>
              )}
            </dl>
          </div>

          {row.dealScore && row.dealScore.reasons.length > 0 && (
            <div className="card" style={{ marginBottom: "1rem" }}>
              <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>Score rationale</h2>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.9rem", color: "#444", lineHeight: 1.5 }}>
                {row.dealScore.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          <Link href={`/documents/${row.id}`} className="btn btnPrimary" style={{ textDecoration: "none" }}>
            Open full document
          </Link>
        </>
      )}
    </div>
  );
}
