"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  dealScoreDisplayValue,
  getGradeFromScore,
  gradeLetterFromDealScore,
} from "@/lib/deals/dashboard-normalize";
import { buildLeadDealSummary } from "@/lib/deals/lead-deal-summary";
import {
  EM_DASH,
  fetchProcessedDeals,
  sortProcessedDealsByScore,
  triggerRescoreZeroDealScores,
  type ProcessedDealRow,
} from "@/lib/deals/processed-deals-query";
import { DealScoreHotBadge } from "@/app/components/DealScoreHotBadge";

function gradeBadgeStyle(letter: "A" | "B" | "C" | "D" | null): CSSProperties {
  if (letter === "A") {
    return { background: "#dcfce7", color: "#166534", border: "1px solid #86efac" };
  }
  if (letter === "B") {
    return { background: "#fef9c3", color: "#854d0e", border: "1px solid #fde047" };
  }
  if (letter === "C") {
    return { background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca" };
  }
  if (letter === "D") {
    return { background: "#f3f4f6", color: "#4b5563", border: "1px solid #e5e7eb" };
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

type MinScoreFilter = 0 | 50 | 70 | 85;

function ProcessedDealListItem({ r }: { r: ProcessedDealRow }) {
  const letter = gradeLetterFromDealScore(r.dealScore);
  const reasons = r.dealScore?.reasons ?? [];
  const completedLabel = formatDate(r.completed_at ?? r.processed_at);
  return (
    <li
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "1rem 1.15rem",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", flexWrap: "wrap" }}>
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
          <div>
            <div
              style={{
                fontSize: "1.35rem",
                fontWeight: 700,
                color: "#111",
                lineHeight: 1.2,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                gap: "0.25rem",
              }}
            >
              {dealScoreDisplayValue(r.dealScore)}
              <DealScoreHotBadge
                score={r.dealScore?.incomplete_data ? undefined : r.dealScore?.score}
              />
              <span style={{ fontSize: "0.85rem", fontWeight: 500, color: "#6b7280" }}>deal score</span>
            </div>
            <p
              style={{
                margin: "0.35rem 0 0",
                fontSize: "0.92rem",
                fontWeight: 700,
                color: "#111",
                lineHeight: 1.38,
                maxWidth: "44rem",
              }}
            >
              {buildLeadDealSummary(r)}
            </p>
            <div style={{ fontSize: "0.88rem", color: "#555", marginTop: "0.25rem" }}>
              {r.owner}
              {(r.county?.trim() || r.state?.trim()) && (
                <span style={{ color: "#888" }}>
                  {" "}
                  · {[r.county?.trim(), r.state?.trim()].filter(Boolean).join(", ")}
                </span>
              )}
            </div>
          </div>
        </div>
        <Link
          href={`/leads/${r.id}`}
          className="btn btnPrimary"
          style={{ textDecoration: "none", fontSize: "0.88rem", padding: "0.45rem 0.85rem" }}
        >
          View lead
        </Link>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.65rem 1rem",
          marginTop: "0.85rem",
          fontSize: "0.82rem",
          color: "#555",
        }}
      >
        <div>
          <span style={{ color: "#888" }}>Acres</span> {r.acres}
        </div>
        <div>
          <span style={{ color: "#888" }}>Lease</span> {r.leaseStatus}
        </div>
        <div>
          <span style={{ color: "#888" }}>Type</span> {r.docType}
        </div>
        <div>
          <span style={{ color: "#888" }}>Completed</span> {completedLabel}
        </div>
        {r.file_name?.trim() && (
          <div style={{ gridColumn: "1 / -1" }}>
            <span style={{ color: "#888" }}>File</span> {r.file_name}
          </div>
        )}
      </div>

      {reasons.length > 0 && (
        <p
          style={{
            margin: "0.75rem 0 0",
            fontSize: "0.82rem",
            color: "#666",
            lineHeight: 1.45,
          }}
        >
          {reasons.join(" · ")}
        </p>
      )}
    </li>
  );
}

const leadFeedListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

export default function LeadsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<ProcessedDealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gradeFilter, setGradeFilter] = useState<"all" | "A" | "B" | "C">("all");
  const [minScoreFilter, setMinScoreFilter] = useState<MinScoreFilter>(0);
  const rescoreOnceRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { rows: next, error: err } = await fetchProcessedDeals(supabase);
      if (err) {
        setError(err);
        setRows([]);
        return;
      }
      setRows(next);
      for (const r of next) {
        if (!r.dealScore) continue;
        console.log("SCORE LOADED", r.id, r.dealScore.score);
        console.log("GRADE LOADED", r.id, r.dealScore.grade);
        console.log("GRADE FROM SCORE", r.id, getGradeFromScore(r.dealScore.score));
        console.log("[score-debug] score =", r.dealScore.score);
        console.log("[score-debug] grade =", getGradeFromScore(r.dealScore.score));
      }
      if (
        next.some(
          (r) => (r.dealScore?.score ?? -1) === 0 && !r.dealScore?.incomplete_data
        ) &&
        !rescoreOnceRef.current
      ) {
        rescoreOnceRef.current = true;
        const { ok, updated } = await triggerRescoreZeroDealScores(supabase);
        if (ok && updated > 0) {
          const { rows: refreshed, error: refreshErr } = await fetchProcessedDeals(supabase);
          if (!refreshErr) setRows(refreshed);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leads.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (gradeFilter !== "all") {
        const letter = gradeLetterFromDealScore(r.dealScore);
        if (letter !== gradeFilter) return false;
      }
      if (minScoreFilter > 0) {
        const s = r.dealScore?.score;
        if (s === undefined || s < minScoreFilter) return false;
      }
      return true;
    });
  }, [rows, gradeFilter, minScoreFilter]);

  const topOpportunitiesThisWeek = useMemo(() => {
    const qualifying = rows.filter(
      (r) =>
        r.dealScore != null &&
        !r.dealScore.incomplete_data &&
        r.dealScore.score >= 60
    );
    return sortProcessedDealsByScore(qualifying).slice(0, 5);
  }, [rows]);

  const displayRows = useMemo(() => {
    const topIds = new Set(topOpportunitiesThisWeek.map((r) => r.id));
    return sortProcessedDealsByScore(filteredRows).filter((r) => !topIds.has(r.id));
  }, [filteredRows, topOpportunitiesThisWeek]);

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Leads</h1>
        <p>Every processed deal in the workspace, highest score first</p>
      </div>

      <div className="card">
        {loading && <p style={{ color: "#666", fontSize: "0.9rem" }}>Loading…</p>}
        {error && <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{error}</p>}

        {!loading && !error && rows.length === 0 && (
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            No processed deals yet. Completed documents appear here automatically, sorted by deal score.
          </p>
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            {topOpportunitiesThisWeek.length > 0 && (
              <div style={{ marginBottom: "1.5rem" }}>
                <h2
                  style={{
                    fontSize: "1rem",
                    fontWeight: 600,
                    color: "#111",
                    margin: "0 0 0.75rem",
                  }}
                >
                  Top Opportunities This Week
                </h2>
                <ul style={leadFeedListStyle}>
                  {topOpportunitiesThisWeek.map((r) => (
                    <ProcessedDealListItem key={r.id} r={r} />
                  ))}
                </ul>
              </div>
            )}

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                marginBottom: "1rem",
                alignItems: "center",
              }}
            >
              <select
                value={gradeFilter}
                onChange={(e) => setGradeFilter(e.target.value as "all" | "A" | "B" | "C")}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
                aria-label="Filter by grade"
              >
                <option value="all">All grades</option>
                <option value="A">A only</option>
                <option value="B">B only</option>
                <option value="C">C only</option>
              </select>
              <select
                value={String(minScoreFilter)}
                onChange={(e) => setMinScoreFilter(Number(e.target.value) as MinScoreFilter)}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
                aria-label="Minimum deal score"
              >
                <option value="0">Any score</option>
                <option value="50">50+</option>
                <option value="70">70+</option>
                <option value="85">85+</option>
              </select>
            </div>

            {displayRows.length === 0 ? (
              <p style={{ color: "#666", fontSize: "0.9rem" }}>No leads match the current filters.</p>
            ) : (
              <ul style={leadFeedListStyle}>
                {displayRows.map((r) => (
                  <ProcessedDealListItem key={r.id} r={r} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
