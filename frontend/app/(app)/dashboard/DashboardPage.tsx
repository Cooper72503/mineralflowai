"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/with-timeout";
import {
  dealScoreDisplayValue,
  EM_DASH,
  gradeBadgeStyleForDeal,
  gradeLetterFromDealScore,
  recommendationFromDealScore,
} from "@/lib/deals/dashboard-normalize";
import {
  fetchProcessedDeals,
  sortProcessedDealsByScore,
  triggerRescoreZeroDealScores,
  type ProcessedDealRow,
} from "@/lib/deals/processed-deals-query";
import { DealScoreHotBadge } from "@/app/components/DealScoreHotBadge";

const SESSION_CHECK_TIMEOUT_MS = 10_000;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

function recBadge(rec: string | null | undefined): { label: string; bg: string; color: string; border: string } {
  switch (rec) {
    case "PURSUE": return { label: "Pursue",  bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" };
    case "PASS":   return { label: "Pass",    bg: "#fef2f2", color: "#991b1b", border: "#fecaca" };
    default:       return { label: "Review",  bg: "#fffbeb", color: "#92400e", border: "#fde68a" };
  }
}

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isWelcome = searchParams.get("welcome") === "1";
  const supabase = useMemo(() => createClient(), []);

  const [rows, setRows] = useState<ProcessedDealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [recFilter, setRecFilter] = useState<"all" | "PURSUE" | "REVIEW" | "PASS">("all");
  const [displayName, setDisplayName] = useState("");
  const rescoreOnceRef = useRef(false);

  const loadDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { rows: next, error: loadErr } = await fetchProcessedDeals(supabase);
      if (loadErr) { setError(loadErr); setRows([]); return; }
      setRows(next);
      if (
        next.some((r) => (r.dealScore?.score ?? -1) === 0 && !r.dealScore?.incomplete_data) &&
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
        if (sessionError || !data.session) { setLoading(false); router.replace("/login"); return; }

        // Get display name
        const { data: userData } = await supabase.auth.getUser();
        if (!cancelled && userData.user) {
          const name =
            (userData.user.user_metadata?.full_name as string | undefined) ??
            (userData.user.user_metadata?.name as string | undefined) ??
            userData.user.email?.split("@")[0] ?? "";
          setDisplayName(name);
        }

        await loadDeals();
      } catch {
        if (cancelled) return;
        setLoading(false);
        router.replace("/login");
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, router, loadDeals]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (recFilter !== "all") {
        const rec = recommendationFromDealScore(r.dealScore);
        if (rec !== recFilter) return false;
      }
      if (!q) return true;
      const name = (r.file_name ?? "").toLowerCase();
      const owner = r.owner !== EM_DASH ? r.owner.toLowerCase() : "";
      const county = (r.county ?? "").toLowerCase();
      return name.includes(q) || owner.includes(q) || county.includes(q);
    });
  }, [rows, search, recFilter]);

  const stats = useMemo(() => {
    let pursue = 0, review = 0, pass = 0;
    rows.forEach((r) => {
      const rec = recommendationFromDealScore(r.dealScore);
      if (rec === "PURSUE") pursue++;
      else if (rec === "PASS") pass++;
      else review++;
    });
    return { total: rows.length, pursue, review, pass };
  }, [rows]);

  const displayRows = useMemo(() => sortProcessedDealsByScore(filtered), [filtered]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 1rem" }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ paddingTop: "2rem", paddingBottom: "1.5rem", borderBottom: "1px solid #f3f4f6", marginBottom: "1.75rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800, color: "#0f172a", margin: "0 0 0.25rem" }}>
          {greeting}{displayName ? `, ${displayName.split(" ")[0]}` : ""}.
        </h1>
        <p style={{ fontSize: "0.9rem", color: "#6b7280", margin: "0 0 1.25rem" }}>
          {isWelcome
            ? "Your account is active. Start screening deals or upload a document."
            : "Your deal pipeline — best opportunities ranked first."}
        </p>

        {/* Quick actions */}
        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap" }}>
          <Link
            href="/screen"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.55rem 1.1rem",
              background: "#2563eb",
              color: "#fff",
              borderRadius: 8,
              fontSize: "0.88rem",
              fontWeight: 700,
              textDecoration: "none",
              letterSpacing: "0.01em",
            }}
          >
            ⚡ Quick Screen
          </Link>
          <Link
            href="/upload"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.55rem 1rem",
              background: "#fff",
              color: "#374151",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              fontSize: "0.88rem",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ↑ Upload Document
          </Link>
          <Link
            href="/pipeline"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.55rem 1rem",
              background: "#fff",
              color: "#374151",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              fontSize: "0.88rem",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ◈ Pipeline
          </Link>
        </div>
      </div>

      {/* ── Stats ───────────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.85rem", marginBottom: "1.75rem" }}>
        {[
          { label: "Total deals",    value: stats.total,   color: "#0f172a", bg: "#f8fafc", border: "#e2e8f0" },
          { label: "Pursue",         value: stats.pursue,  color: "#15803d", bg: "#f0fdf4", border: "#bbf7d0" },
          { label: "Review",         value: stats.review,  color: "#92400e", bg: "#fffbeb", border: "#fde68a" },
          { label: "Pass",           value: stats.pass,    color: "#991b1b", bg: "#fef2f2", border: "#fecaca" },
        ].map(({ label, value, color, bg, border }) => (
          <div key={label} style={{
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 10,
            padding: "0.9rem 1rem",
          }}>
            <div style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.3rem" }}>{label}</div>
            <div style={{ fontSize: "1.65rem", fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── Deal Table ──────────────────────────────────────────────────── */}
      <div style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
      }}>
        {loading && (
          <div style={{ padding: "2.5rem", textAlign: "center", color: "#6b7280", fontSize: "0.9rem" }}>
            Loading deals…
          </div>
        )}
        {error && (
          <div style={{ padding: "1.5rem", color: "#b91c1c", fontSize: "0.88rem" }}>{error}</div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div style={{ padding: "3rem 2rem", textAlign: "center" }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>📋</div>
            <h2 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0f172a", marginBottom: "0.5rem" }}>
              No deals yet
            </h2>
            <p style={{ fontSize: "0.88rem", color: "#6b7280", marginBottom: "1.25rem", maxWidth: 360, margin: "0 auto 1.25rem" }}>
              Run a Quick Screen on a legal description, or upload a lease to get your first deal scored.
            </p>
            <div style={{ display: "flex", gap: "0.65rem", justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/screen" style={{ padding: "0.6rem 1.25rem", background: "#2563eb", color: "#fff", borderRadius: 8, fontSize: "0.88rem", fontWeight: 700, textDecoration: "none" }}>
                ⚡ Quick Screen
              </Link>
              <Link href="/upload" style={{ padding: "0.6rem 1.25rem", background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: 8, fontSize: "0.88rem", fontWeight: 600, textDecoration: "none" }}>
                Upload Document
              </Link>
            </div>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            {/* Table toolbar */}
            <div style={{
              padding: "0.85rem 1.25rem",
              borderBottom: "1px solid #f3f4f6",
              display: "flex",
              gap: "0.65rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}>
              <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "#0f172a", marginRight: "0.25rem" }}>
                All deals
              </span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <input
                  type="search"
                  placeholder="Search by name, owner, or county…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.4rem 0.75rem",
                    border: "1px solid #e5e7eb",
                    borderRadius: 7,
                    fontSize: "0.85rem",
                    background: "#f9fafb",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <select
                value={recFilter}
                onChange={(e) => setRecFilter(e.target.value as typeof recFilter)}
                style={{
                  padding: "0.4rem 0.65rem",
                  border: "1px solid #e5e7eb",
                  borderRadius: 7,
                  fontSize: "0.85rem",
                  background: "#f9fafb",
                  color: "#374151",
                  cursor: "pointer",
                }}
              >
                <option value="all">All recommendations</option>
                <option value="PURSUE">Pursue only</option>
                <option value="REVIEW">Review only</option>
                <option value="PASS">Pass only</option>
              </select>
              {(search || recFilter !== "all") && (
                <button
                  onClick={() => { setSearch(""); setRecFilter("all"); }}
                  style={{ fontSize: "0.8rem", color: "#6b7280", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
                >
                  Clear
                </button>
              )}
            </div>

            {displayRows.length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", color: "#6b7280", fontSize: "0.88rem" }}>
                No deals match your filters.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.855rem" }}>
                  <thead>
                    <tr style={{ background: "#f9fafb", borderBottom: "1px solid #f3f4f6" }}>
                      {["Score", "Recommendation", "Owner / Location", "Acres", "Document type", "Completed", ""].map((h) => (
                        <th key={h} style={{
                          padding: "0.6rem 1rem",
                          textAlign: "left",
                          fontSize: "0.72rem",
                          fontWeight: 600,
                          color: "#6b7280",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          whiteSpace: "nowrap",
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r, idx) => {
                      const letter = gradeLetterFromDealScore(r.dealScore);
                      const rec = recommendationFromDealScore(r.dealScore);
                      const rb = recBadge(rec);
                      const reasons = r.dealScore?.reasons?.slice(0, 1) ?? [];
                      const location = [r.county, r.state].filter(Boolean).join(", ");

                      return (
                        <tr
                          key={r.id}
                          onClick={() => router.push(`/documents/${r.id}`)}
                          style={{
                            cursor: "pointer",
                            borderBottom: idx < displayRows.length - 1 ? "1px solid #f9fafb" : "none",
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                        >
                          {/* Score */}
                          <td style={{ padding: "0.75rem 1rem", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                              <span style={{
                                ...gradeBadgeStyleForDeal(letter, r.dealScore?.type),
                                fontWeight: 700,
                                minWidth: "1.6rem",
                                textAlign: "center",
                                borderRadius: 5,
                                padding: "0.15rem 0.35rem",
                                fontSize: "0.8rem",
                              }}>
                                {letter ?? EM_DASH}
                              </span>
                              <span style={{ fontWeight: 700, color: "#111", fontSize: "0.95rem" }}>
                                {dealScoreDisplayValue(r.dealScore)}
                              </span>
                              <DealScoreHotBadge
                                score={r.dealScore?.incomplete_data ? undefined : r.dealScore?.score}
                              />
                            </div>
                          </td>

                          {/* Recommendation */}
                          <td style={{ padding: "0.75rem 1rem" }}>
                            <span style={{
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              padding: "0.2rem 0.55rem",
                              borderRadius: 20,
                              background: rb.bg,
                              color: rb.color,
                              border: `1px solid ${rb.border}`,
                            }}>
                              {rb.label}
                            </span>
                          </td>

                          {/* Owner / Location */}
                          <td style={{ padding: "0.75rem 1rem", maxWidth: 240 }}>
                            <div style={{ fontWeight: 500, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.owner !== EM_DASH ? r.owner : (r.file_name ?? EM_DASH)}
                            </div>
                            {location && (
                              <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.1rem" }}>
                                {location}
                              </div>
                            )}
                            {reasons.length > 0 && (
                              <div style={{ fontSize: "0.72rem", color: "#9ca3af", marginTop: "0.1rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {reasons[0]}
                              </div>
                            )}
                          </td>

                          {/* Acres */}
                          <td style={{ padding: "0.75rem 1rem", color: "#374151", whiteSpace: "nowrap" }}>
                            {r.acres}
                          </td>

                          {/* Document type */}
                          <td style={{ padding: "0.75rem 1rem", color: "#6b7280", maxWidth: 140 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
                              {r.docType}
                            </span>
                          </td>

                          {/* Completed */}
                          <td style={{ padding: "0.75rem 1rem", color: "#9ca3af", whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                            {formatDate(r.completed_at ?? r.processed_at)}
                          </td>

                          {/* Action */}
                          <td style={{ padding: "0.75rem 1rem" }} onClick={(e) => e.stopPropagation()}>
                            <Link
                              href={`/documents/${r.id}`}
                              style={{
                                fontSize: "0.8rem",
                                fontWeight: 600,
                                color: "#2563eb",
                                textDecoration: "none",
                                whiteSpace: "nowrap",
                              }}
                            >
                              View →
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

      <p style={{ fontSize: "0.72rem", color: "#d1d5db", textAlign: "center", marginTop: "1.5rem", paddingBottom: "2rem" }}>
        Mineral Flow AI — screening-grade analysis only. Not investment advice.
      </p>
    </div>
  );
}
