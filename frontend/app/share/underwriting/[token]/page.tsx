"use client";
/**
 * /share/underwriting/[token]
 *
 * Public read-only view of a shared underwriting report.
 * No authentication required. Accessible outside the (app) layout.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { DDReport } from "@/lib/underwriting/types";

const COLORS = {
  bg: "#0d0f14", surface: "#13161e", surfaceAlt: "#181b24",
  border: "#232736", borderStrong: "#2e3247",
  text: "#e8eaf0", textMuted: "#8b8fa8", textFaint: "#565a72",
  accent: "#3b82f6", green: "#22c55e", yellow: "#eab308",
  red: "#ef4444", greenDim: "rgba(34,197,94,0.08)",
  yellowDim: "rgba(234,179,8,0.1)", redDim: "rgba(239,68,68,0.08)",
};

const fmt$ = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}MM`
  : n >= 1_000 ? `$${Math.round(n / 1_000).toLocaleString()}K`
  : `$${Math.round(n).toLocaleString()}`;

const fmtN = (n: number) => Math.round(n).toLocaleString();

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const [report, setReport] = useState<DDReport | null>(null);
  const [meta, setMeta] = useState<{ deal_stage: string; created_at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.token) return;
    fetch(`/api/underwriting/share/${params.token}`)
      .then(r => r.json())
      .then(data => {
        if (!data.ok) { setError(data.error ?? "Report not found."); return; }
        setReport(data.report as DDReport);
        setMeta(data.meta);
      })
      .catch(() => setError("Failed to load report."))
      .finally(() => setLoading(false));
  }, [params?.token]);

  if (loading) return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: COLORS.textMuted, fontSize: "0.9rem" }}>Loading report…</div>
    </div>
  );

  if (error || !report) return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ color: COLORS.red, fontSize: "1.25rem", fontWeight: 700 }}>Report Not Found</div>
      <div style={{ color: COLORS.textMuted, fontSize: "0.85rem" }}>{error ?? "This report may not exist or sharing has been disabled."}</div>
      <a href="/" style={{ color: COLORS.accent, fontSize: "0.82rem", marginTop: "0.5rem" }}>← MineralFlowAI</a>
    </div>
  );

  const ex = report.executive_summary;
  const rec = report.risk?.recommendation?.value ?? "review";
  const recColors: Record<string, string> = { pursue: COLORS.green, review: COLORS.yellow, pass: COLORS.red };
  const recColor = recColors[rec] ?? COLORS.yellow;

  const STAGE_LABELS: Record<string, string> = {
    underwriting: "Underwriting", loi_sent: "LOI Sent", counter: "Counter",
    under_contract: "Under Contract", closed_won: "Closed — Won", passed: "Passed",
  };

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* Banner */}
      <div style={{ background: COLORS.surface, borderBottom: `1px solid ${COLORS.border}`, padding: "0.65rem 1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 800, color: COLORS.text }}>
          MineralFlow<span style={{ color: COLORS.accent }}>AI</span>
        </div>
        <div style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>
          Shared Underwriting Report — Read Only
          {meta?.created_at && ` · ${new Date(meta.created_at).toLocaleDateString()}`}
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "2rem 1.5rem" }}>
        {/* Deal stage badge */}
        {meta?.deal_stage && meta.deal_stage !== "underwriting" && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "0.4rem",
            background: meta.deal_stage === "closed_won" ? COLORS.greenDim : meta.deal_stage === "passed" ? COLORS.redDim : COLORS.yellowDim,
            border: `1px solid ${meta.deal_stage === "closed_won" ? COLORS.green : meta.deal_stage === "passed" ? COLORS.red : COLORS.yellow}40`,
            borderRadius: 6, padding: "0.3rem 0.75rem", fontSize: "0.75rem", fontWeight: 700,
            color: meta.deal_stage === "closed_won" ? COLORS.green : meta.deal_stage === "passed" ? COLORS.red : COLORS.yellow,
            marginBottom: "1rem",
          }}>
            Deal Stage: {STAGE_LABELS[meta.deal_stage] ?? meta.deal_stage}
          </div>
        )}

        {/* Hero */}
        <div style={{ background: COLORS.surface, border: `2px solid ${recColor}50`, borderRadius: 14, padding: "1.75rem 2rem", marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "1.5rem" }}>
            <div>
              <div style={{ fontSize: "0.65rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Acquisition Due Diligence</div>
              <div style={{ fontSize: "1.5rem", fontWeight: 900, color: COLORS.text }}>
                {report.subject.lease_name ?? report.subject.operator_name ?? "Property"}
                {report.subject.county ? ` — ${report.subject.county} Co.` : ""}
                {report.subject.state ? `, ${report.subject.state}` : ""}
              </div>
              <div style={{ fontSize: "0.75rem", color: COLORS.textMuted, marginTop: 6 }}>
                {report.subject.api_numbers.slice(0, 3).join("  ·  ")}
              </div>
              <div style={{ marginTop: "1rem" }}>
                <div style={{ fontSize: "2.5rem", fontWeight: 900, color: recColor, textTransform: "uppercase" }}>{rec}</div>
                <div style={{ fontSize: "0.82rem", color: COLORS.textMuted, maxWidth: 480, lineHeight: 1.6 }}>{ex.recommendation_rationale}</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem", minWidth: 260 }}>
              {[
                { l: "Risk Score", v: ex.overall_risk_score.value != null ? `${ex.overall_risk_score.value.toFixed(1)} / 10` : "—" },
                { l: "Current Rate", v: ex.current_gross_rate_bbl.value != null ? `${fmtN(ex.current_gross_rate_bbl.value)} BBL/mo` : "—" },
                { l: "Monthly NCF", v: ex.monthly_net_income_usd.value != null ? fmt$(ex.monthly_net_income_usd.value) : "—" },
                { l: "NPV10", v: ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "—" },
                { l: "Offer Low", v: ex.offer_range_low.value != null ? fmt$(ex.offer_range_low.value) : "—" },
                { l: "Offer High", v: ex.offer_range_high.value != null ? fmt$(ex.offer_range_high.value) : "—" },
              ].map(({ l, v }) => (
                <div key={l} style={{ background: COLORS.surfaceAlt, borderRadius: 8, padding: "0.6rem 0.85rem" }}>
                  <div style={{ fontSize: "0.6rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{l}</div>
                  <div style={{ fontSize: "0.9rem", fontWeight: 700, color: COLORS.text }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* IC Memo */}
        {report.underwriting_narrative?.length > 0 && (
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.25rem 1.5rem", marginBottom: "1.25rem" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.85rem" }}>
              📋 Investment Committee Memo
            </div>
            {report.underwriting_narrative.map((para, i) => (
              <p key={i} style={{ fontSize: "0.84rem", color: COLORS.text, lineHeight: 1.65, margin: "0 0 0.85rem 0", paddingLeft: "0.75rem", borderLeft: `3px solid ${i === 0 ? COLORS.accent : COLORS.border}` }}>
                {para}
              </p>
            ))}
          </div>
        )}

        {/* Key metrics grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.85rem", marginBottom: "1.25rem" }}>
          {[
            { icon: "⛽", label: "Production Trend", value: ex.production_trend.value ?? "—", color: ex.production_trend.value === "increasing" ? COLORS.green : ex.production_trend.value === "declining" ? COLORS.red : COLORS.yellow },
            { icon: "⏱️", label: "Downtime", value: ex.downtime_pct != null ? `${ex.downtime_pct.toFixed(1)}%` : "—", color: (ex.downtime_pct ?? 0) > 15 ? COLORS.red : (ex.downtime_pct ?? 0) > 5 ? COLORS.yellow : COLORS.green },
            { icon: "📊", label: "Data Completeness", value: `${ex.data_completeness_score}/100`, color: ex.data_completeness_score >= 70 ? COLORS.green : COLORS.yellow },
          ].map(({ icon, label, value, color }) => (
            <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1rem 1.25rem" }}>
              <div style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>{icon}</div>
              <div style={{ fontSize: "0.65rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: "1.1rem", fontWeight: 800, color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Top risks / Value drivers */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.red}30`, borderRadius: 10, padding: "1rem 1.25rem" }}>
            <div style={{ fontSize: "0.7rem", fontWeight: 700, color: COLORS.red, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>🚩 Top Risks</div>
            {ex.top_risks.length === 0 ? <div style={{ fontSize: "0.78rem", color: COLORS.textFaint }}>None identified</div>
              : ex.top_risks.map((r, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.text, padding: "0.25rem 0", borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none" }}>• {r}</div>)}
          </div>
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.green}30`, borderRadius: 10, padding: "1rem 1.25rem" }}>
            <div style={{ fontSize: "0.7rem", fontWeight: 700, color: COLORS.green, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>✅ Value Drivers</div>
            {ex.value_drivers.length === 0 ? <div style={{ fontSize: "0.78rem", color: COLORS.textFaint }}>Insufficient data</div>
              : ex.value_drivers.map((v, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.text, padding: "0.25rem 0", borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none" }}>✓ {v}</div>)}
          </div>
        </div>

        {/* Disclaimer */}
        <div style={{ background: COLORS.yellowDim, border: `1px solid ${COLORS.yellow}30`, borderRadius: 8, padding: "0.75rem 1rem", fontSize: "0.72rem", color: COLORS.yellow, textAlign: "center" }}>
          ⚠️ PRELIMINARY — FOR DISCUSSION ONLY. Not a reserve engineering study or investment advice.
          Powered by <strong>MineralFlowAI</strong> · mineralflowai.com
        </div>
      </div>
    </div>
  );
}
