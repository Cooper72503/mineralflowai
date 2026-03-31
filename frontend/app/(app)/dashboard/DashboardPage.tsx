"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/with-timeout";

const SESSION_CHECK_TIMEOUT_MS = 10_000;
import {
  dealScoreDisplayValue,
  dealScoreKindLabel,
  EM_DASH,
  getGradeFromScore,
  gradeBadgeStyleForDeal,
  gradeLetterFromDealScore,
} from "@/lib/deals/dashboard-normalize";
import {
  fetchProcessedDeals,
  sortProcessedDealsByScore,
  triggerRescoreZeroDealScores,
  type ProcessedDealRow,
} from "@/lib/deals/processed-deals-query";
import { DealScoreHotBadge } from "@/app/components/DealScoreHotBadge";

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

export default function DashboardPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<ProcessedDealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [gradeFilter, setGradeFilter] = useState<"all" | "A" | "B" | "C">("all");
  /** Empty = no minimum; otherwise show deals with score >= this value (inclusive). */
  const [minScoreInput, setMinScoreInput] = useState("");
  const rescoreOnceRef = useRef(false);

  const loadDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { rows: next, error: loadErr } = await fetchProcessedDeals(supabase);
      if (loadErr) {
        setError(loadErr);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deals.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data, error: sessionError } = await withTimeout(
          supabase.auth.getSession(),
          SESSION_CHECK_TIMEOUT_MS,
          "Session check timed out"
        );
        if (cancelled) return;
        if (sessionError || !data.session) {
          setLoading(false);
          router.replace("/login");
          return;
        }
        await loadDeals();
      } catch {
        if (cancelled) return;
        setLoading(false);
        router.replace("/login");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, router, loadDeals]);

  const minScoreThreshold = useMemo(() => {
    const t = minScoreInput.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }, [minScoreInput]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (gradeFilter !== "all") {
        const letter = gradeLetterFromDealScore(r.dealScore);
        if (letter !== gradeFilter) return false;
      }
      if (minScoreThreshold !== null) {
        const s = r.dealScore?.score;
        if (s === undefined || s < minScoreThreshold) return false;
      }
      if (!q) return true;
      const name = (r.file_name ?? "").toLowerCase();
      const owner = r.owner !== EM_DASH ? r.owner.toLowerCase() : "";
      const county = (r.county ?? "").toLowerCase();
      return name.includes(q) || owner.includes(q) || county.includes(q);
    });
  }, [rows, search, gradeFilter, minScoreThreshold]);

  const summary = useMemo(() => {
    let a = 0;
    let b = 0;
    let c = 0;
    filtered.forEach((r) => {
      const letter = gradeLetterFromDealScore(r.dealScore);
      if (letter === "A") a += 1;
      else if (letter === "B") b += 1;
      else if (letter === "C") c += 1;
    });
    return { total: filtered.length, a, b, c };
  }, [filtered]);

  const displayRows = useMemo(() => sortProcessedDealsByScore(filtered), [filtered]);

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Deals dashboard</h1>
        <p>Completed documents ranked by deal score — best opportunities first</p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div className="card">
          <p style={{ fontSize: "0.85rem", color: "#666" }}>Total deals</p>
          <p style={{ fontSize: "1.75rem", fontWeight: 600, marginTop: "0.25rem" }}>{summary.total}</p>
        </div>
        <div className="card">
          <p style={{ fontSize: "0.85rem", color: "#666" }}>A deals</p>
          <p style={{ fontSize: "1.75rem", fontWeight: 600, marginTop: "0.25rem", color: "#166534" }}>{summary.a}</p>
        </div>
        <div className="card">
          <p style={{ fontSize: "0.85rem", color: "#666" }}>B deals</p>
          <p style={{ fontSize: "1.75rem", fontWeight: 600, marginTop: "0.25rem", color: "#854d0e" }}>{summary.b}</p>
        </div>
        <div className="card">
          <p style={{ fontSize: "0.85rem", color: "#666" }}>C deals</p>
          <p style={{ fontSize: "1.75rem", fontWeight: 600, marginTop: "0.25rem", color: "#b91c1c" }}>{summary.c}</p>
        </div>
      </div>

      <div className="card">
        {loading && <p style={{ color: "#666", fontSize: "0.9rem" }}>Loading…</p>}
        {error && <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{error}</p>}

        {!loading && !error && rows.length === 0 && (
          <div style={{ textAlign: "center", padding: "2rem 1rem" }}>
            <p style={{ color: "#555", fontSize: "0.95rem", marginBottom: "1rem" }}>
              No completed deals yet. Upload a document and run processing to see ranked opportunities here.
            </p>
            <Link href="/documents" className="btn btnPrimary" style={{ textDecoration: "none" }}>
              Go to documents
            </Link>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "1rem" }}>Ranked deals</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: "1rem", alignItems: "center" }}>
              <input
                type="search"
                placeholder="Search file name, owner, or county"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6, minWidth: 220, flex: "1 1 200px" }}
                aria-label="Search deals"
              />
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
              <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.9rem", color: "#444" }}>
                <span style={{ whiteSpace: "nowrap" }}>Score ≥</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  placeholder="e.g. 70"
                  value={minScoreInput}
                  onChange={(e) => setMinScoreInput(e.target.value)}
                  style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6, width: "5.5rem" }}
                  aria-label="Minimum deal score"
                />
              </label>
            </div>

            {displayRows.length === 0 ? (
              <p style={{ color: "#666", fontSize: "0.9rem" }}>
                No deals match your filters.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setGradeFilter("all");
                    setMinScoreInput("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#2563eb",
                    cursor: "pointer",
                    font: "inherit",
                    textDecoration: "underline",
                    padding: 0,
                  }}
                >
                  Clear filters
                </button>
              </p>
            ) : (
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>Grade</th>
                      <th>Score</th>
                      <th>Owner</th>
                      <th>County</th>
                      <th>State</th>
                      <th>Acres</th>
                      <th>Financials</th>
                      <th>Lease status</th>
                      <th>Document type</th>
                      <th>Completed</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r) => {
                      const letter = gradeLetterFromDealScore(r.dealScore);
                      const reasons = r.dealScore?.reasons?.slice(0, 2) ?? [];
                      const completedLabel = formatDate(r.completed_at ?? r.processed_at);
                      return (
                        <tr
                          key={r.id}
                          onClick={() => router.push(`/documents/${r.id}`)}
                          style={{ cursor: "pointer" }}
                          title="View document"
                        >
                          <td>
                            <span
                              className="badge"
                              style={{
                                ...gradeBadgeStyleForDeal(letter, r.dealScore?.type),
                                fontWeight: 600,
                                minWidth: "1.75rem",
                                textAlign: "center",
                              }}
                            >
                              {letter ?? EM_DASH}
                            </span>
                          </td>
                          <td>
                            <span
                              style={{
                                fontSize: "1.15rem",
                                fontWeight: 700,
                                color: "#111",
                                display: "inline-flex",
                                flexWrap: "wrap",
                                alignItems: "baseline",
                                gap: "0.15rem",
                              }}
                            >
                              {dealScoreDisplayValue(r.dealScore)}
                              <DealScoreHotBadge
                                score={r.dealScore?.incomplete_data ? undefined : r.dealScore?.score}
                              />
                              <span style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 500 }}>
                                {dealScoreKindLabel(r.dealScore?.type)}
                              </span>
                            </span>
                          </td>
                          <td>
                            <div style={{ maxWidth: 220 }}>
                              <div>{r.owner}</div>
                              {reasons.length > 0 && (
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "#888",
                                    marginTop: "0.25rem",
                                    lineHeight: 1.35,
                                  }}
                                >
                                  {reasons.join(" · ")}
                                </div>
                              )}
                            </div>
                          </td>
                          <td>{r.county?.trim() ? r.county : EM_DASH}</td>
                          <td>{r.state?.trim() ? r.state : EM_DASH}</td>
                          <td>{r.acres}</td>
                          <td title="Document-based financial snapshot (preliminary)">{r.financialsLabel}</td>
                          <td>{r.leaseStatus}</td>
                          <td style={{ maxWidth: 160 }}>{r.docType}</td>
                          <td>{completedLabel}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <Link
                              href={`/documents/${r.id}`}
                              className="btn btnSecondary"
                              style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem", textDecoration: "none" }}
                            >
                              View
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
