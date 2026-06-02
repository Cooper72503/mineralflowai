"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AcreageValuationReport, OffsetWellProfile } from "@/lib/underwriting/types-acreage";

// ─── Design tokens ────────────────────────────────────────────────────────────

const T = {
  bg:          "#0f1117",
  surface:     "#181c25",
  surfaceAlt:  "#1e2333",
  border:      "rgba(255,255,255,0.08)",
  borderMid:   "rgba(255,255,255,0.12)",
  borderStrong:"rgba(255,255,255,0.18)",
  text:        "#e2e8f0",
  textMuted:   "#8892a4",
  textFaint:   "#5a6478",
  accent:      "#4f8ef7",
  accentDim:   "rgba(79,142,247,0.12)",
  green:       "#22c55e",
  greenDim:    "rgba(34,197,94,0.12)",
  yellow:      "#f59e0b",
  yellowDim:   "rgba(245,158,11,0.12)",
  red:         "#ef4444",
  redDim:      "rgba(239,68,68,0.12)",
} as const;

// ─── Formatters ───────────────────────────────────────────────────────────────

const EM_DASH = "—";

function fmt$(n: number | null | undefined): string {
  if (n == null) return EM_DASH;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000).toLocaleString()}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtN(n: number | null | undefined): string {
  if (n == null) return EM_DASH;
  return n.toLocaleString();
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return EM_DASH;
  return `${n.toFixed(1)}%`;
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

type BadgeStyle = { background: string; color: string; border: string };

function recStyle(rec: "PURSUE" | "REVIEW" | "PASS"): BadgeStyle {
  if (rec === "PURSUE") return { background: T.greenDim,  color: T.green,  border: `1px solid rgba(34,197,94,0.3)`  };
  if (rec === "PASS")   return { background: T.redDim,    color: T.red,    border: `1px solid rgba(239,68,68,0.3)`  };
  return                       { background: T.yellowDim, color: T.yellow, border: `1px solid rgba(245,158,11,0.3)` };
}

function confStyle(c: "HIGH" | "MEDIUM" | "LOW"): BadgeStyle {
  if (c === "HIGH")   return { background: T.accentDim,  color: T.accent,    border: `1px solid rgba(79,142,247,0.3)` };
  if (c === "MEDIUM") return { background: T.surfaceAlt, color: T.textMuted, border: T.border };
  return                     { background: T.surfaceAlt, color: T.textFaint, border: T.border };
}

function provStyle(label: string): BadgeStyle {
  if (label === "VERIFIED")      return { background: T.greenDim,  color: T.green,  border: `1px solid rgba(34,197,94,0.3)`   };
  if (label === "PUBLIC_RECORD") return { background: T.accentDim, color: T.accent, border: `1px solid rgba(79,142,247,0.3)`  };
  if (label === "INFERRED")      return { background: T.yellowDim, color: T.yellow, border: `1px solid rgba(245,158,11,0.3)`  };
  if (label === "ESTIMATED")     return { background: T.surfaceAlt, color: T.textMuted, border: T.border };
  return                                { background: T.surfaceAlt, color: T.textFaint, border: T.border };
}

function InlineBadge({ label, style }: { label: string; style: BadgeStyle }) {
  return (
    <span style={{
      display: "inline-block", fontSize: "0.72rem", fontWeight: 700,
      padding: "1px 7px", borderRadius: 4, textTransform: "uppercase",
      letterSpacing: "0.04em", ...style,
    }}>
      {label}
    </span>
  );
}

// ─── Card wrapper ─────────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: 12,
      padding: "1rem 1.1rem",
      ...style,
    }}>
      {children}
    </div>
  );
}

// ─── Shared row component ─────────────────────────────────────────────────────

function Row({ label, value, badge }: { label: string; value: React.ReactNode; badge?: string }) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", paddingBottom: "0.45rem", alignItems: "flex-start" }}>
      <dt style={{ fontSize: "0.82rem", color: T.textMuted, minWidth: 160, flexShrink: 0, paddingTop: 1 }}>
        {label}
      </dt>
      <dd style={{ fontSize: "0.85rem", color: T.text, margin: 0, flex: 1 }}>
        {value}
      </dd>
      {badge && (
        <InlineBadge label={badge} style={provStyle(badge)} />
      )}
    </div>
  );
}

// ─── Input shared styles ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.48rem 0.65rem",
  background: T.surfaceAlt,
  border: `1px solid ${T.border}`,
  borderRadius: 7,
  fontSize: "0.88rem",
  color: T.text,
  fontFamily: "inherit",
  outline: "none",
  transition: "border-color 0.15s",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "0.3rem",
  fontSize: "0.83rem",
  fontWeight: 600,
  color: T.textMuted,
  letterSpacing: "0.01em",
};

// ─── Results display ──────────────────────────────────────────────────────────

function ValuationResult({ report }: { report: AcreageValuationReport }) {
  const v   = report.valuation;
  const rec = recStyle(v.recommendation);
  const [showOffsets, setShowOffsets] = useState(false);
  const [showProv,    setShowProv]    = useState(false);

  const recIcons = { PURSUE: "✓", REVIEW: "~", PASS: "✗" };

  return (
    <div style={{ marginTop: "1.5rem" }}>

      {/* ── Verdict banner ── */}
      <div style={{
        maxWidth: 580, marginBottom: "1rem",
        background: rec.background,
        border: rec.border,
        borderRadius: 12,
        padding: "1rem 1.25rem",
        display: "flex", alignItems: "center", gap: "1rem",
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: "50%",
          background: rec.color, color: "#0f1117",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1.4rem", fontWeight: 900, flexShrink: 0,
        }}>
          {recIcons[v.recommendation]}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "1.25rem", fontWeight: 800, color: rec.color, letterSpacing: "-0.01em" }}>
            {v.recommendation}
          </div>
          <div style={{ fontSize: "0.82rem", color: rec.color, opacity: 0.85, marginTop: "0.15rem", lineHeight: 1.4 }}>
            {v.recommendation_rationale}
          </div>
        </div>
        {v.pv10_mid != null && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: "0.68rem", color: rec.color, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              PV10 Est.
            </div>
            <div style={{ fontSize: "1.1rem", fontWeight: 800, color: rec.color }}>
              {fmt$(v.pv10_mid)}
            </div>
            {v.pv10_low != null && v.pv10_high != null && (
              <div style={{ fontSize: "0.7rem", color: rec.color, opacity: 0.6 }}>
                {fmt$(v.pv10_low)} – {fmt$(v.pv10_high)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Flags ── */}
      {report.flags.filter(f => f.severity !== "info").length > 0 && (
        <div style={{ maxWidth: 580, marginBottom: "1rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          {report.flags.filter(f => f.severity !== "info").map((f, i) => (
            <div key={i} style={{
              display: "flex", gap: "0.5rem", alignItems: "flex-start",
              background: f.severity === "critical" ? T.redDim : T.yellowDim,
              border: `1px solid ${f.severity === "critical" ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
              borderRadius: 8, padding: "0.55rem 0.75rem",
              fontSize: "0.82rem",
              color: f.severity === "critical" ? T.red : T.yellow,
              lineHeight: 1.45,
            }}>
              <span style={{ flexShrink: 0 }}>{f.severity === "critical" ? "🔴" : "⚠️"}</span>
              <span>{f.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Meta strip ── */}
      <div style={{
        maxWidth: 580, marginBottom: "1rem",
        display: "flex", flexWrap: "wrap", gap: "0.5rem 1rem",
        fontSize: "0.78rem", color: T.textFaint,
      }}>
        <span>📍 {report._meta.geocoding_source !== "none" ? report.location?.description ?? "Located" : "Not geocoded"}</span>
        <span>🛢️ {report._meta.offset_well_count} offset wells ({report._meta.wells_with_production} with production)</span>
        <span>⏱ {(report._meta.processing_time_ms / 1000).toFixed(1)}s</span>
        <InlineBadge
          label={`Parse: ${report.parsed.parse_confidence}`}
          style={confStyle(report.parsed.parse_confidence as "HIGH" | "MEDIUM" | "LOW")}
        />
      </div>

      {/* ── Valuation card ── */}
      <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.2rem" }}>
          Acreage Valuation
        </h2>
        <p style={{ fontSize: "0.78rem", color: T.textFaint, margin: "0 0 0.9rem", lineHeight: 1.4 }}>
          Risk-adjusted, probability-weighted estimate — ESTIMATED, not a reserve engineering study.
        </p>

        {/* PV10 range */}
        <div style={{
          background: v.pv10_mid != null ? T.greenDim : T.surfaceAlt,
          border: `1px solid ${v.pv10_mid != null ? "rgba(34,197,94,0.2)" : T.border}`,
          borderRadius: 10, padding: "0.85rem 1rem", marginBottom: "0.85rem",
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", textAlign: "center",
        }}>
          {[
            { label: "PV10 Low (P90)",  val: v.pv10_low  },
            { label: "PV10 Mid (P50)",  val: v.pv10_mid  },
            { label: "PV10 High (P10)", val: v.pv10_high },
          ].map(({ label, val }) => (
            <div key={label}>
              <div style={{ fontSize: "0.68rem", color: T.textFaint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: val != null ? "1.25rem" : "1rem", fontWeight: 800, color: T.text }}>{fmt$(val)}</div>
            </div>
          ))}
        </div>

        <dl style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <Row label="Acreage quality"    value={`${v.acreage_quality_score}/100`} badge="INFERRED" />
          <Row label="Data confidence"    value={`${v.confidence_score}/100`}      badge="INFERRED" />
          <Row label="Drill probability"  value={`${v.drill_probability_pct ?? 0}%`} badge="INFERRED" />
          <Row label="Potential wells"    value={v.potential_well_count_p50 != null ? `${v.potential_well_count_p50} wells at ${v.spacing_assumption_acres ?? "—"} ac/well spacing` : EM_DASH} badge="ESTIMATED" />
          <Row label="$/NMA (mid)"        value={v.value_per_nma_mid != null ? `$${v.value_per_nma_mid.toLocaleString()}/NMA` : EM_DASH} badge="ESTIMATED" />
          <Row label="Royalty/mo (P50)"   value={v.expected_royalty_boe_p50 != null ? `${fmtN(v.expected_royalty_boe_p50)} BBL/mo NRI share` : EM_DASH} badge="ESTIMATED" />
          <Row label="Price deck"         value={`$${v.oil_price_deck}/BBL, ${(v.discount_rate * 100).toFixed(0)}% discount`} badge="ESTIMATED" />
          <Row label="NRI used"           value={`${(v.nri_used * 100).toFixed(3)}%`} badge={report.input.nri != null ? "VERIFIED" : "ESTIMATED"} />
          <Row label="Development timing" value={v.development_timing_label ?? EM_DASH} />
        </dl>
      </Card>

      {/* ── Formation ── */}
      {report.formation && (
        <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.65rem" }}>
            Formation &amp; Basin
          </h2>
          <dl style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <Row label="Basin"              value={report.formation.basin}            badge="ESTIMATED" />
            <Row label="Primary target"     value={report.formation.primary_formation} badge="ESTIMATED" />
            <Row label="Play type"          value={report.formation.play_type.replace(/_/g, " ")} />
            <Row label="Avg lateral"        value={report.formation.avg_lateral_length_ft != null ? `${report.formation.avg_lateral_length_ft.toLocaleString()} ft` : "Conventional / N/A"} badge="ESTIMATED" />
            <Row label="P50 EUR (bench.)"   value={report.formation.benchmark_p50_eur_bbl != null ? `${Math.round(report.formation.benchmark_p50_eur_bbl / 1000)}K BBL/well` : EM_DASH} badge="ESTIMATED" />
            <Row label="Peak rate (bench.)" value={report.formation.benchmark_peak_month_bbl != null ? `${fmtN(report.formation.benchmark_peak_month_bbl)} BBL/mo` : EM_DASH} badge="ESTIMATED" />
            <Row label="Spacing"            value={report.formation.benchmark_spacing_acres != null ? `${report.formation.benchmark_spacing_acres} ac/well` : EM_DASH} badge="ESTIMATED" />
          </dl>
          {report.formation.secondary_formations.length > 0 && (
            <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: T.textFaint }}>
              Secondary targets: {report.formation.secondary_formations.join(", ")}
            </div>
          )}
          <p style={{ fontSize: "0.8rem", color: T.textMuted, lineHeight: 1.5, margin: "0.65rem 0 0", fontStyle: "italic" }}>
            {report.formation.commentary}
          </p>
        </Card>
      )}

      {/* ── Type curve ── */}
      {(report.type_curve || report.formation?.benchmark_p50_eur_bbl) && (
        <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.3rem" }}>
            Type Curve &amp; EUR
          </h2>
          <p style={{ fontSize: "0.78rem", color: T.textFaint, margin: "0 0 0.75rem" }}>
            {report.type_curve
              ? `Built from ${report.type_curve.well_count} offset wells with production data.`
              : "No offset production data — showing regional basin benchmarks only."}
          </p>

          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
            gap: "0.5rem", marginBottom: "0.75rem",
          }}>
            {[
              { label: "P10 EUR (upside)",  eur: report.type_curve?.p10_eur_bbl ?? report.formation?.benchmark_p10_eur_bbl, peak: report.type_curve?.p10_peak_bbl },
              { label: "P50 EUR (base)",    eur: report.type_curve?.p50_eur_bbl ?? report.formation?.benchmark_p50_eur_bbl, peak: report.type_curve?.p50_peak_bbl },
              { label: "P90 EUR (downside)",eur: report.type_curve?.p90_eur_bbl ?? report.formation?.benchmark_p90_eur_bbl, peak: report.type_curve?.p90_peak_bbl },
            ].map(({ label, eur, peak }) => (
              <div key={label} style={{
                background: T.surfaceAlt,
                border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "0.65rem 0.75rem", textAlign: "center",
              }}>
                <div style={{ fontSize: "0.68rem", color: T.textFaint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 800, color: T.text }}>
                  {eur != null ? (eur >= 1_000_000 ? `${(eur/1_000_000).toFixed(2)}M` : `${Math.round(eur/1_000)}K`) : EM_DASH}
                </div>
                <div style={{ fontSize: "0.68rem", color: T.textFaint }}>BBL/well</div>
                {peak != null && <div style={{ fontSize: "0.72rem", color: T.textMuted, marginTop: 2 }}>Peak {fmtN(peak)} BBL/mo</div>}
              </div>
            ))}
          </div>

          {report.type_curve && (
            <dl style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <Row label="Confidence"     value={<InlineBadge label={report.type_curve.confidence} style={confStyle(report.type_curve.confidence)} />} />
              <Row label="Avg decline/yr" value={report.type_curve.avg_decline_annual_pct != null ? fmtPct(report.type_curve.avg_decline_annual_pct) : EM_DASH} badge="PUBLIC_RECORD" />
              <Row label="Recency score"  value={`${(report.type_curve.recency_score * 100).toFixed(0)}% (${report.type_curve.recency_score >= 0.7 ? "recent wells" : report.type_curve.recency_score >= 0.4 ? "mixed vintage" : "older wells"})`} />
            </dl>
          )}

          {report.type_curve?.data_quality_note && (
            <p style={{ fontSize: "0.78rem", color: T.yellow, background: T.yellowDim, border: `1px solid rgba(245,158,11,0.25)`, borderRadius: 6, padding: "0.4rem 0.65rem", margin: "0.5rem 0 0", lineHeight: 1.5 }}>
              ⚠️ {report.type_curve.data_quality_note}
            </p>
          )}
        </Card>
      )}

      {/* ── Drilling momentum ── */}
      <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.35rem" }}>
          Drilling Momentum
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.65rem" }}>
          <div style={{
            width: 52, height: 52, borderRadius: "50%", flexShrink: 0,
            border: `3px solid ${report.drilling_momentum.score >= 65 ? T.green : report.drilling_momentum.score >= 40 ? T.yellow : T.red}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "1.05rem", fontWeight: 800,
            color: report.drilling_momentum.score >= 65 ? T.green : report.drilling_momentum.score >= 40 ? T.yellow : T.red,
          }}>
            {report.drilling_momentum.score}
          </div>
          <div>
            <InlineBadge
              label={report.drilling_momentum.trend}
              style={{
                background: report.drilling_momentum.trend === "ACCELERATING" ? T.greenDim : report.drilling_momentum.trend === "STABLE" ? T.yellowDim : report.drilling_momentum.trend === "DECLINING" ? T.redDim : T.surfaceAlt,
                color:      report.drilling_momentum.trend === "ACCELERATING" ? T.green    : report.drilling_momentum.trend === "STABLE" ? T.yellow    : report.drilling_momentum.trend === "DECLINING" ? T.red    : T.textMuted,
                border:     "none",
              }}
            />
            {report.drilling_momentum.dominant_operator && (
              <div style={{ fontSize: "0.8rem", color: T.textMuted, marginTop: 3 }}>
                Lead: <strong style={{ color: T.text }}>{report.drilling_momentum.dominant_operator}</strong>
              </div>
            )}
          </div>
        </div>
        <dl style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <Row label="Wells (last 3yr)" value={report.drilling_momentum.wells_spud_last_3yr} />
          <Row label="Wells (last 5yr)" value={report.drilling_momentum.wells_spud_last_5yr} />
          <Row label="Post-2020"        value={fmtPct(report.drilling_momentum.pct_wells_post_2020)} />
        </dl>
        <p style={{ fontSize: "0.82rem", color: T.textMuted, lineHeight: 1.5, margin: "0.5rem 0 0" }}>
          {report.drilling_momentum.interpretation}
        </p>
      </Card>

      {/* ── Operator intelligence ── */}
      {report.operators.length > 0 && (
        <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.65rem" }}>
            Operator Intelligence
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {report.operators.map(op => (
              <div key={op.name} style={{
                background: T.surfaceAlt,
                border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "0.65rem 0.85rem",
                display: "flex", gap: "0.75rem", alignItems: "center",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.88rem", color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{op.name}</div>
                  <div style={{ fontSize: "0.75rem", color: T.textFaint, marginTop: 1 }}>{op.tier_rationale}</div>
                </div>
                <div style={{ textAlign: "center", minWidth: 36 }}>
                  <div style={{ fontSize: "0.95rem", fontWeight: 700, color: T.text }}>{op.well_count}</div>
                  <div style={{ fontSize: "0.65rem", color: T.textFaint }}>wells</div>
                </div>
                <div style={{ textAlign: "center", minWidth: 72 }}>
                  <div style={{ fontSize: "0.85rem", fontWeight: 600, color: op.avg_eur_bbl != null ? T.green : T.textFaint }}>
                    {op.avg_eur_bbl != null ? `${Math.round(op.avg_eur_bbl/1000)}K BBL` : EM_DASH}
                  </div>
                  <div style={{ fontSize: "0.65rem", color: T.textFaint }}>avg EUR</div>
                </div>
                <InlineBadge
                  label={op.quality_tier}
                  style={op.quality_tier === "TIER1" ? { background: T.greenDim,  color: T.green,  border: `1px solid rgba(34,197,94,0.3)`   }
                       : op.quality_tier === "TIER2" ? { background: T.yellowDim, color: T.yellow, border: `1px solid rgba(245,158,11,0.3)`  }
                       :                               { background: T.redDim,    color: T.red,    border: `1px solid rgba(239,68,68,0.3)`   }}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Nearby activity summary ── */}
      <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.5rem" }}>
          Nearby Activity Intelligence
        </h2>
        <p style={{ fontSize: "0.85rem", color: T.textMuted, lineHeight: 1.6, margin: 0 }}>
          {report.nearby_activity_summary}
        </p>
      </Card>

      {/* ── Offset wells (collapsible) ── */}
      {report.offset_wells.length > 0 && (
        <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
          <button
            type="button"
            onClick={() => setShowOffsets(o => !o)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "0.5rem",
              fontSize: "1rem", fontWeight: 600, color: T.text, padding: 0,
              width: "100%", textAlign: "left",
            }}
          >
            {showOffsets ? "▼" : "▶"} Offset Wells ({report.offset_wells.length})
            <span style={{ fontSize: "0.75rem", color: T.textFaint, fontWeight: 400 }}>
              — click to {showOffsets ? "collapse" : "expand"}
            </span>
          </button>

          {showOffsets && (
            <div style={{ marginTop: "0.75rem", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
                <thead>
                  <tr>
                    {["API", "Operator", "Dist", "Dir", "Peak BBL/mo", "EUR", "Decline", "Status"].map(h => (
                      <th key={h} style={{
                        textAlign: "left", padding: "5px 7px",
                        color: T.textFaint, fontWeight: 600,
                        borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap",
                        fontSize: "0.75rem",
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.offset_wells.map((w: OffsetWellProfile) => (
                    <tr key={w.api} style={{ borderBottom: `1px solid ${T.border}` }}>
                      <td style={{ padding: "4px 7px", color: T.textFaint, fontFamily: "monospace", fontSize: "0.72rem" }}>{w.api}</td>
                      <td style={{ padding: "4px 7px", color: T.text, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.operator}</td>
                      <td style={{ padding: "4px 7px", color: T.text }}>{w.distance_mi.toFixed(1)} mi</td>
                      <td style={{ padding: "4px 7px", color: T.textFaint }}>{w.direction}</td>
                      <td style={{ padding: "4px 7px", textAlign: "right", color: T.text }}>{fmtN(w.peak_month_bbl)}</td>
                      <td style={{ padding: "4px 7px", textAlign: "right", fontWeight: w.eur_bbl != null ? 600 : 400, color: w.eur_bbl != null ? T.green : T.textFaint }}>
                        {w.eur_bbl != null ? (w.eur_bbl >= 1_000_000 ? `${(w.eur_bbl/1_000_000).toFixed(2)}M` : `${Math.round(w.eur_bbl/1_000)}K`) : EM_DASH}
                      </td>
                      <td style={{ padding: "4px 7px", textAlign: "right", color: T.textMuted }}>{w.decline_annual_pct != null ? fmtPct(w.decline_annual_pct) : EM_DASH}</td>
                      <td style={{ padding: "4px 7px" }}>
                        <span style={{
                          fontSize: "0.68rem", fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                          background: w.is_active ? T.greenDim : T.surfaceAlt,
                          color:      w.is_active ? T.green    : T.textFaint,
                        }}>
                          {w.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ── IC narrative ── */}
      {report.investment_narrative.length > 0 && (
        <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.65rem" }}>
            Investment Committee Memo
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
            {report.investment_narrative.map((para, i) => (
              <p key={i} style={{
                fontSize: "0.83rem", lineHeight: 1.65, color: T.textMuted, margin: 0,
                paddingLeft: 10,
                borderLeft: `3px solid ${
                  i === 0 ? T.accent
                  : i === report.investment_narrative.length - 1
                    ? (v.recommendation === "PURSUE" ? T.green : v.recommendation === "PASS" ? T.red : T.yellow)
                    : T.border
                }`,
              }}>
                {para}
              </p>
            ))}
          </div>
        </Card>
      )}

      {/* ── Resolved inputs ── */}
      <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, color: T.text, marginBottom: "0.6rem" }}>Resolved Inputs</h2>
        <dl style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <Row label="County"    value={report.parsed.county   ?? EM_DASH} />
          <Row label="State"     value={report.parsed.state    ?? EM_DASH} />
          <Row label="Acreage"   value={report.parsed.acreage  != null ? `${report.parsed.acreage} gross acres` : <span style={{ color: T.yellow }}>Not found — defaulted to 160 acres</span>} />
          <Row label="NRI"       value={report.parsed.nri      != null ? `${(report.parsed.nri * 100).toFixed(3)}%` : <span style={{ color: T.yellow }}>Not provided — defaulted to 12.5%</span>} />
          <Row label="Format"    value={report.parsed.format_detected.replace(/_/g, " ")} />
          {report.parsed.abstract_number && <Row label="Abstract #"  value={report.parsed.abstract_number} />}
          {report.parsed.survey_name     && <Row label="Survey"      value={report.parsed.survey_name} />}
          {report.parsed.block           && <Row label="Block"       value={report.parsed.block} />}
          {report.parsed.section         && <Row label="Section"     value={report.parsed.section} />}
          {report.parsed.plss_township   && <Row label="Township"    value={report.parsed.plss_township} />}
          {report.parsed.plss_range      && <Row label="Range"       value={report.parsed.plss_range} />}
          {report.location && (
            <Row label="Geocode" value={<span>{report.location.description} <InlineBadge label={report.location.source.replace(/_/g," ")} style={provStyle("PUBLIC_RECORD")} /></span>} />
          )}
        </dl>
      </Card>

      {/* ── Provenance (collapsible) ── */}
      <Card style={{ maxWidth: 580, marginBottom: "2rem" }}>
        <button
          type="button"
          onClick={() => setShowProv(o => !o)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", gap: "0.4rem",
            fontSize: "0.9rem", fontWeight: 600, color: T.textMuted, padding: 0,
          }}
        >
          {showProv ? "▼" : "▶"} Data Provenance &amp; Assumptions
        </button>
        {showProv && (
          <>
            <dl style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: "0.75rem" }}>
              {report.provenance.map(p => (
                <Row key={p.field} label={p.field} value={<span>{p.value} <span style={{ fontSize: "0.72rem", color: T.textFaint }}>({p.source})</span></span>} badge={p.label} />
              ))}
            </dl>
            <p style={{ fontSize: "0.72rem", color: T.textFaint, lineHeight: 1.55, marginTop: "0.75rem" }}>
              PRELIMINARY — For discussion purposes only. Not a reserve engineering study, fairness opinion, or investment advice.
              All EUR and PV estimates are directional. Verify with a petroleum engineer before committing capital.
              Generated by MineralFlowAI. Processing time: {(report._meta.processing_time_ms / 1000).toFixed(1)}s.
            </p>
          </>
        )}
      </Card>

    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AcreageValuationPage() {
  const [legalDescription, setLegalDescription] = useState("");
  const [county,  setCounty]  = useState("");
  const [state,   setState]   = useState("");
  const [acreage, setAcreage] = useState("");
  const [nri,     setNri]     = useState("");
  const [operatorHint,  setOperatorHint]  = useState("");
  const [formationHint, setFormationHint] = useState("");

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [report,  setReport]  = useState<AcreageValuationReport | null>(null);

  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setReport(null);

    const trimmed = legalDescription.trim();
    if (!trimmed) { setError("Legal description is required."); return; }

    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const nriRaw = parseFloat(nri.trim());
      const body = {
        legal_description: trimmed,
        county:         county.trim()   || undefined,
        state:          state.trim()    || undefined,
        acreage:        acreage.trim()  ? parseFloat(acreage.replace(/,/g, "")) : undefined,
        nri:            !isNaN(nriRaw)  ? nriRaw / 100 : undefined,
        operator_hint:  operatorHint.trim()  || undefined,
        formation_hint: formationHint.trim() || undefined,
      };

      const res = await fetch("/api/underwriting/acreage", {
        method:      "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as AcreageValuationReport & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, padding: "2rem 1.5rem 3rem" }}>

      {/* ── Page header ── */}
      <div style={{ maxWidth: 580, marginBottom: "1.75rem" }}>
        <h1 style={{ fontSize: "1.55rem", fontWeight: 800, color: T.text, letterSpacing: "-0.02em", margin: "0 0 0.4rem" }}>
          Acreage Valuation
        </h1>
        <p style={{ fontSize: "0.88rem", color: T.textMuted, margin: 0, lineHeight: 1.55 }}>
          Paste a legal description to get a first-pass acquisition read — offset well intelligence,
          type curve benchmarking, formation analysis, and risk-adjusted value range.
          No file upload needed.
        </p>
      </div>

      {/* ── Input form ── */}
      <Card style={{ maxWidth: 580, marginBottom: "1.5rem" }}>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

          {/* Legal description */}
          <div>
            <label htmlFor="av-legal" style={labelStyle}>
              Legal description <span style={{ color: T.red }}>*</span>
            </label>
            <textarea
              id="av-legal"
              value={legalDescription}
              onChange={e => setLegalDescription(e.target.value)}
              rows={5}
              style={{
                ...inputStyle,
                resize: "vertical",
                lineHeight: 1.5,
              }}
              disabled={loading}
            />
          </div>

          {/* County / State */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="av-county" style={labelStyle}>
                County <span style={{ fontSize: "0.78rem", color: T.textFaint, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="av-county" type="text" value={county}
                onChange={e => setCounty(e.target.value)}
                style={inputStyle}
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="av-state" style={labelStyle}>
                State <span style={{ fontSize: "0.78rem", color: T.textFaint, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="av-state" type="text" value={state}
                onChange={e => setState(e.target.value)}
                style={inputStyle}
                disabled={loading}
              />
            </div>
          </div>

          {/* Acreage / NRI */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="av-acreage" style={labelStyle}>
                Gross acres <span style={{ fontSize: "0.78rem", color: T.textFaint, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="av-acreage" type="text" value={acreage}
                onChange={e => setAcreage(e.target.value)}
                style={inputStyle}
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="av-nri" style={labelStyle}>
                Royalty / NRI % <span style={{ fontSize: "0.78rem", color: T.textFaint, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="av-nri" type="text" value={nri}
                onChange={e => setNri(e.target.value)}
                style={inputStyle}
                disabled={loading}
              />
            </div>
          </div>

          {/* Operator / Formation hints */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="av-op" style={labelStyle}>
                Operator hint <span style={{ fontSize: "0.78rem", color: T.textFaint, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="av-op" type="text" value={operatorHint}
                onChange={e => setOperatorHint(e.target.value)}
                style={inputStyle}
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="av-form" style={labelStyle}>
                Formation hint <span style={{ fontSize: "0.78rem", color: T.textFaint, fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="av-form" type="text" value={formationHint}
                onChange={e => setFormationHint(e.target.value)}
                style={inputStyle}
                disabled={loading}
              />
            </div>
          </div>

          {error && (
            <p style={{ color: T.red, fontSize: "0.88rem", margin: 0 }}>{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !legalDescription.trim()}
            style={{
              alignSelf: "flex-start",
              padding: "0.55rem 1.3rem",
              background: loading || !legalDescription.trim() ? "rgba(79,142,247,0.35)" : T.accent,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: "0.9rem",
              fontWeight: 700,
              cursor: loading || !legalDescription.trim() ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {loading ? "Analyzing acreage…" : "Run Acreage Valuation"}
          </button>
        </form>
      </Card>

      {/* ── Loading state ── */}
      {loading && (
        <Card style={{ maxWidth: 580, marginBottom: "1rem" }}>
          <p style={{ fontSize: "0.88rem", color: T.textMuted, margin: 0, lineHeight: 1.6 }}>
            Resolving legal description → geocoding → querying nearby wells → fetching production histories →
            running decline curves → building type curve → generating valuation…
          </p>
        </Card>
      )}

      {report && !loading && <ValuationResult report={report} />}
    </div>
  );
}
