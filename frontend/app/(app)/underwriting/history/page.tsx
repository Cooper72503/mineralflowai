"use client";
/**
 * /underwriting/history
 *
 * Saved underwriting reports — the deal CRM.
 * List view + deal stage Kanban + one-click re-open in underwriting tool.
 */
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

const COLORS = {
  bg: "#0d0f14", surface: "#13161e", surfaceAlt: "#181b24",
  border: "#232736", borderStrong: "#2e3247",
  text: "#e8eaf0", textMuted: "#8b8fa8", textFaint: "#565a72",
  accent: "#3b82f6", accentDim: "rgba(59,130,246,0.1)",
  green: "#22c55e", greenDim: "rgba(34,197,94,0.08)",
  yellow: "#eab308", yellowDim: "rgba(234,179,8,0.1)",
  red: "#ef4444", redDim: "rgba(239,68,68,0.08)",
};

const STAGES = [
  { id: "underwriting",   label: "Underwriting",    color: COLORS.accent,  emoji: "🔍" },
  { id: "loi_sent",       label: "LOI Sent",         color: COLORS.yellow,  emoji: "📝" },
  { id: "counter",        label: "Counter",          color: "#f97316",      emoji: "🔄" },
  { id: "under_contract", label: "Under Contract",   color: "#a855f7",      emoji: "📋" },
  { id: "closed_won",     label: "Closed — Won",     color: COLORS.green,   emoji: "✅" },
  { id: "passed",         label: "Passed",           color: COLORS.textFaint, emoji: "✗" },
] as const;

type Stage = typeof STAGES[number]["id"];

type SavedReport = {
  id: string;
  report_id: string;
  lease_name: string | null;
  operator_name: string | null;
  county: string | null;
  state: string | null;
  api_numbers: string[];
  recommendation: string | null;
  current_rate_bbl: number | null;
  twelve_month_avg_bbl: number | null;
  npv10_usd: number | null;
  offer_range_low: number | null;
  offer_range_high: number | null;
  offer_range_mid: number | null;
  risk_score: number | null;
  data_completeness_score: number | null;
  overall_confidence: string | null;
  scan_mode: string | null;
  deal_stage: Stage;
  share_token: string;
  share_enabled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const fmt$ = (n: number | null) => n == null ? "—"
  : n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}MM`
  : n >= 1_000 ? `$${Math.round(n / 1_000)}K`
  : `$${Math.round(n)}`;

const fmtN = (n: number | null) => n == null ? "—" : Math.round(n).toLocaleString();

export default function UnderwritingHistoryPage() {
  const [reports, setReports]       = useState<SavedReport[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [view, setView]             = useState<"list" | "kanban">("list");
  const [stageUpdating, setStageUpdating] = useState<string | null>(null);
  const [shareLoading, setShareLoading]   = useState<string | null>(null);
  const [noteEditing, setNoteEditing]     = useState<string | null>(null);
  const [noteDraft, setNoteDraft]         = useState("");
  const [search, setSearch]               = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting]           = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/underwriting/reports")
      .then(r => r.json())
      .then(d => {
        if (d.ok) setReports(d.reports);
        else setError(d.error ?? "Failed to load");
      })
      .catch(() => setError("Network error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateStage = async (id: string, stage: Stage) => {
    setStageUpdating(id);
    try {
      await fetch(`/api/underwriting/reports/${id}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      setReports(prev => prev.map(r => r.id === id ? { ...r, deal_stage: stage } : r));
    } finally { setStageUpdating(null); }
  };

  const toggleShare = async (id: string, current: boolean) => {
    setShareLoading(id);
    try {
      await fetch(`/api/underwriting/reports/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_enabled: !current }),
      });
      setReports(prev => prev.map(r => r.id === id ? { ...r, share_enabled: !current } : r));
    } finally { setShareLoading(null); }
  };

  const saveNote = async (id: string) => {
    await fetch(`/api/underwriting/reports/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: noteDraft }),
    });
    setReports(prev => prev.map(r => r.id === id ? { ...r, notes: noteDraft } : r));
    setNoteEditing(null);
  };

  const deleteReport = async (id: string) => {
    setDeleting(id);
    try {
      await fetch(`/api/underwriting/reports/${id}`, { method: "DELETE" });
      setReports(prev => prev.filter(r => r.id !== id));
      setConfirmDelete(null);
    } finally { setDeleting(null); }
  };

  const filtered = reports.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [r.lease_name, r.operator_name, r.county, r.state, ...(r.api_numbers ?? [])]
      .some(v => v?.toLowerCase().includes(q));
  });

  const copyShareLink = (token: string) => {
    const url = `${window.location.origin}/share/underwriting/${token}`;
    navigator.clipboard.writeText(url).catch(() => {});
  };

  // ─── Rec colors ─────────────────────────────────────────────────────────────
  const recColor = (rec: string | null) =>
    rec === "pursue" ? COLORS.green : rec === "pass" ? COLORS.red : COLORS.yellow;

  // ─── Report card ─────────────────────────────────────────────────────────────
  function ReportCard({ r }: { r: SavedReport }) {
    const stage = STAGES.find(s => s.id === r.deal_stage) ?? STAGES[0];
    const isNoteEdit = noteEditing === r.id;

    return (
      <div style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        overflow: "hidden",
        transition: "border-color 0.15s",
      }}>
        {/* Stage bar */}
        <div style={{ height: 3, background: stage.color }} />

        <div style={{ padding: "1rem 1.25rem" }}>
          {/* Header row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.65rem" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "0.9rem", fontWeight: 700, color: COLORS.text, marginBottom: 2 }}>
                {r.lease_name ?? r.operator_name ?? "Unknown Property"}
              </div>
              <div style={{ fontSize: "0.72rem", color: COLORS.textMuted }}>
                {[r.county ? `${r.county} Co.` : null, r.state].filter(Boolean).join(", ")}
                {r.api_numbers?.length > 0 && <span style={{ color: COLORS.textFaint, marginLeft: 6 }}>API: {r.api_numbers.slice(0, 2).join(", ")}</span>}
              </div>
            </div>
            {r.recommendation && (
              <span style={{
                fontSize: "0.7rem", fontWeight: 800, color: "#fff",
                background: recColor(r.recommendation),
                borderRadius: 5, padding: "0.2rem 0.55rem",
                textTransform: "uppercase",
                flexShrink: 0,
              }}>
                {r.recommendation}
              </span>
            )}
          </div>

          {/* Metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.4rem", marginBottom: "0.75rem" }}>
            {[
              { l: "Rate (BBL/mo)",  v: fmtN(r.current_rate_bbl) },
              { l: "NPV10",          v: fmt$(r.npv10_usd) },
              { l: "Offer Range",    v: r.offer_range_low && r.offer_range_high ? `${fmt$(r.offer_range_low)} – ${fmt$(r.offer_range_high)}` : "—" },
            ].map(({ l, v }) => (
              <div key={l} style={{ background: COLORS.surfaceAlt, borderRadius: 6, padding: "0.35rem 0.6rem" }}>
                <div style={{ fontSize: "0.58rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 1 }}>{l}</div>
                <div style={{ fontSize: "0.78rem", fontWeight: 700, color: COLORS.text }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Stage selector */}
          <div style={{ marginBottom: "0.6rem" }}>
            <div style={{ fontSize: "0.62rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.3rem" }}>Deal Stage</div>
            <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
              {STAGES.map(s => (
                <button
                  key={s.id}
                  onClick={() => updateStage(r.id, s.id)}
                  disabled={stageUpdating === r.id}
                  style={{
                    background: r.deal_stage === s.id ? s.color + "25" : COLORS.surfaceAlt,
                    color: r.deal_stage === s.id ? s.color : COLORS.textFaint,
                    border: `1px solid ${r.deal_stage === s.id ? s.color + "60" : COLORS.border}`,
                    borderRadius: 5, padding: "0.2rem 0.5rem",
                    fontSize: "0.65rem", fontWeight: r.deal_stage === s.id ? 700 : 400,
                    cursor: stageUpdating === r.id ? "default" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.emoji} {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          {isNoteEdit ? (
            <div style={{ marginBottom: "0.6rem" }}>
              <textarea
                autoFocus
                value={noteDraft}
                onChange={e => setNoteDraft(e.target.value)}
                rows={3}
                style={{ width: "100%", background: COLORS.surfaceAlt, border: `1px solid ${COLORS.accent}`, borderRadius: 5, color: COLORS.text, fontSize: "0.76rem", padding: "0.45rem 0.6rem", resize: "none", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.3rem" }}>
                <button onClick={() => saveNote(r.id)} style={{ background: COLORS.accent, color: "#fff", border: "none", borderRadius: 5, padding: "0.3rem 0.7rem", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer" }}>Save</button>
                <button onClick={() => setNoteEditing(null)} style={{ background: COLORS.surfaceAlt, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "0.3rem 0.7rem", fontSize: "0.72rem", cursor: "pointer" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div
              onClick={() => { setNoteEditing(r.id); setNoteDraft(r.notes ?? ""); }}
              style={{ marginBottom: "0.6rem", cursor: "pointer", padding: "0.35rem 0.6rem", background: COLORS.surfaceAlt, borderRadius: 5, minHeight: 32, fontSize: "0.74rem", color: r.notes ? COLORS.textMuted : COLORS.textFaint, fontStyle: r.notes ? "normal" : "italic", border: `1px solid ${COLORS.border}` }}
            >
              {r.notes || "Add notes…"}
            </div>
          )}

          {/* Action row */}
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
            <Link
              href={`/underwriting?load=${r.id}`}
              style={{ flex: 1, minWidth: 100, background: COLORS.accent, color: "#fff", border: "none", borderRadius: 6, padding: "0.4rem 0.7rem", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer", textAlign: "center", textDecoration: "none" }}
            >
              Open Report
            </Link>
            <button
              onClick={() => toggleShare(r.id, r.share_enabled)}
              disabled={shareLoading === r.id}
              title={r.share_enabled ? "Sharing enabled — click to disable" : "Enable sharing"}
              style={{
                background: r.share_enabled ? COLORS.greenDim : COLORS.surfaceAlt,
                color: r.share_enabled ? COLORS.green : COLORS.textFaint,
                border: `1px solid ${r.share_enabled ? COLORS.green + "40" : COLORS.border}`,
                borderRadius: 6, padding: "0.4rem 0.65rem", fontSize: "0.7rem", fontWeight: 600, cursor: "pointer",
              }}
            >
              {shareLoading === r.id ? "…" : r.share_enabled ? "🔗 Shared" : "🔗 Share"}
            </button>
            {r.share_enabled && (
              <button
                onClick={() => copyShareLink(r.share_token)}
                title="Copy share link"
                style={{ background: COLORS.surfaceAlt, color: COLORS.textFaint, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.4rem 0.65rem", fontSize: "0.7rem", cursor: "pointer" }}
              >
                📋 Copy Link
              </button>
            )}
            <button
              onClick={() => setConfirmDelete(r.id)}
              title="Delete report"
              style={{ background: COLORS.surfaceAlt, color: COLORS.textFaint, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.4rem 0.55rem", fontSize: "0.7rem", cursor: "pointer" }}
            >
              🗑️
            </button>
          </div>

          {/* Delete confirm */}
          {confirmDelete === r.id && (
            <div style={{ marginTop: "0.5rem", background: COLORS.redDim, border: `1px solid ${COLORS.red}40`, borderRadius: 6, padding: "0.5rem 0.75rem", display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.72rem" }}>
              <span style={{ color: COLORS.text, flex: 1 }}>Delete this report? This cannot be undone.</span>
              <button onClick={() => deleteReport(r.id)} disabled={deleting === r.id} style={{ background: COLORS.red, color: "#fff", border: "none", borderRadius: 5, padding: "0.25rem 0.6rem", fontSize: "0.7rem", fontWeight: 700, cursor: "pointer" }}>
                {deleting === r.id ? "Deleting…" : "Delete"}
              </button>
              <button onClick={() => setConfirmDelete(null)} style={{ background: COLORS.surfaceAlt, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "0.25rem 0.6rem", fontSize: "0.7rem", cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          )}

          {/* Meta */}
          <div style={{ marginTop: "0.5rem", fontSize: "0.62rem", color: COLORS.textFaint, display: "flex", gap: "0.75rem" }}>
            <span>{new Date(r.created_at).toLocaleDateString()}</span>
            {r.scan_mode && <span>{r.scan_mode === "full" ? "Full Underwriting" : "Quick Scan"}</span>}
            {r.data_completeness_score != null && <span>Data: {r.data_completeness_score}/100</span>}
            {r.overall_confidence && <span>Confidence: {r.overall_confidence.toUpperCase()}</span>}
          </div>
        </div>
      </div>
    );
  }

  // ─── Pipeline totals ─────────────────────────────────────────────────────────
  const totalOfferMid = reports
    .filter(r => ["underwriting", "loi_sent", "counter", "under_contract"].includes(r.deal_stage))
    .reduce((sum, r) => sum + (r.offer_range_mid ?? 0), 0);

  const wonValue = reports
    .filter(r => r.deal_stage === "closed_won")
    .reduce((sum, r) => sum + (r.offer_range_mid ?? 0), 0);

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1300, margin: "0 auto", padding: "2rem 1.5rem" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem", marginBottom: "1.5rem" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.3rem" }}>
              <Link href="/underwriting" style={{ fontSize: "0.72rem", color: COLORS.textFaint, textDecoration: "none" }}>← Underwriting</Link>
            </div>
            <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 800 }}>Deal History</h1>
            <p style={{ margin: "0.3rem 0 0", color: COLORS.textMuted, fontSize: "0.82rem" }}>
              {reports.length} saved report{reports.length !== 1 ? "s" : ""} · Track every deal from underwriting to close
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search lease, operator, county…"
              style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 7, color: COLORS.text, fontSize: "0.8rem", padding: "0.5rem 0.85rem", outline: "none", width: 240 }}
            />
            {(["list", "kanban"] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                background: view === v ? COLORS.accent : COLORS.surface,
                color: view === v ? "#fff" : COLORS.textMuted,
                border: `1px solid ${view === v ? COLORS.accent : COLORS.border}`,
                borderRadius: 7, padding: "0.5rem 0.85rem", fontSize: "0.75rem", fontWeight: view === v ? 700 : 500, cursor: "pointer",
              }}>
                {v === "list" ? "☰ List" : "⊞ Kanban"}
              </button>
            ))}
            <Link href="/underwriting" style={{ background: COLORS.accent, color: "#fff", borderRadius: 7, padding: "0.5rem 0.85rem", fontSize: "0.75rem", fontWeight: 700, textDecoration: "none" }}>
              + New Report
            </Link>
          </div>
        </div>

        {/* Pipeline value summary */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1.5rem" }}>
          {[
            { l: "Total Reports", v: reports.length.toString(), color: COLORS.text },
            { l: "Active Pipeline", v: reports.filter(r => !["closed_won","passed"].includes(r.deal_stage)).length.toString(), color: COLORS.accent },
            { l: "Pipeline Value (mid)", v: totalOfferMid > 0 ? (totalOfferMid >= 1_000_000 ? `$${(totalOfferMid/1_000_000).toFixed(2)}MM` : `$${Math.round(totalOfferMid/1_000)}K`) : "—", color: COLORS.yellow },
            { l: "Closed Won Value", v: wonValue > 0 ? (wonValue >= 1_000_000 ? `$${(wonValue/1_000_000).toFixed(2)}MM` : `$${Math.round(wonValue/1_000)}K`) : "—", color: COLORS.green },
          ].map(({ l, v, color }) => (
            <div key={l} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "0.9rem 1.1rem" }}>
              <div style={{ fontSize: "0.62rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{l}</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 800, color }}>{v}</div>
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "3rem", color: COLORS.textFaint, fontSize: "0.85rem" }}>Loading reports…</div>
        ) : error ? (
          <div style={{ background: COLORS.redDim, border: `1px solid ${COLORS.red}30`, borderRadius: 8, padding: "1rem", color: COLORS.red, fontSize: "0.82rem" }}>
            ⚠️ {error}
            <button onClick={load} style={{ marginLeft: "1rem", background: "none", border: "none", color: COLORS.accent, cursor: "pointer", fontSize: "0.8rem" }}>Retry</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ background: COLORS.surfaceAlt, border: `1px dashed ${COLORS.border}`, borderRadius: 12, padding: "3rem", textAlign: "center" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>📋</div>
            <div style={{ color: COLORS.text, fontWeight: 700, marginBottom: "0.4rem" }}>
              {search ? "No reports match your search." : "No saved reports yet."}
            </div>
            <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", marginBottom: "1rem" }}>
              {search ? "Try a different search term." : "Run a Full Underwriting and click Save Report to start building your deal history."}
            </div>
            {!search && (
              <Link href="/underwriting" style={{ background: COLORS.accent, color: "#fff", borderRadius: 7, padding: "0.6rem 1.25rem", fontSize: "0.82rem", fontWeight: 700, textDecoration: "none" }}>
                Run First Report →
              </Link>
            )}
          </div>
        ) : view === "list" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: "1rem" }}>
            {filtered.map(r => <ReportCard key={r.id} r={r} />)}
          </div>
        ) : (
          // Kanban view
          <div style={{ display: "flex", gap: "0.75rem", overflowX: "auto", paddingBottom: "1rem" }}>
            {STAGES.map(stage => {
              const stageReports = filtered.filter(r => r.deal_stage === stage.id);
              return (
                <div key={stage.id} style={{ minWidth: 300, maxWidth: 340, flexShrink: 0 }}>
                  <div style={{
                    background: COLORS.surfaceAlt, border: `1px solid ${stage.color}40`,
                    borderTop: `3px solid ${stage.color}`,
                    borderRadius: "0 0 8px 8px", padding: "0.65rem 0.9rem",
                    marginBottom: "0.6rem", display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <div style={{ fontWeight: 700, fontSize: "0.8rem", color: stage.color }}>
                      {stage.emoji} {stage.label}
                    </div>
                    <span style={{ background: stage.color + "20", color: stage.color, borderRadius: 10, fontSize: "0.65rem", fontWeight: 800, padding: "0.1rem 0.45rem" }}>
                      {stageReports.length}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                    {stageReports.map(r => <ReportCard key={r.id} r={r} />)}
                    {stageReports.length === 0 && (
                      <div style={{ padding: "1.25rem", textAlign: "center", color: COLORS.textFaint, fontSize: "0.75rem", border: `1px dashed ${COLORS.border}`, borderRadius: 8 }}>
                        No deals
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
