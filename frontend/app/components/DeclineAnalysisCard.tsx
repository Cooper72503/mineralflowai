"use client";

import type { DeclineCurveResult } from "@/lib/decline/decline-curve";

function fmt(n: number | null, decimals = 1): string {
  if (n == null) return "—";
  return n.toFixed(decimals);
}

function fmtK(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function healthColor(health: DeclineCurveResult["decline_health"]): { bg: string; text: string; border: string } {
  switch (health) {
    case "strong":    return { bg: "#f0fdf4", text: "#15803d", border: "#86efac" };
    case "moderate":  return { bg: "#fffbeb", text: "#92400e", border: "#fde68a" };
    case "steep":     return { bg: "#fff7ed", text: "#c2410c", border: "#fed7aa" };
    case "exhausted": return { bg: "#fef2f2", text: "#991b1b", border: "#fecaca" };
    default:          return { bg: "#f8fafc", text: "#475569", border: "#e2e8f0" };
  }
}

type MetricCellProps = {
  label: string;
  value: string;
  sub?: string;
};

function MetricCell({ label, value, sub }: MetricCellProps) {
  return (
    <div style={{ padding: "0.6rem 0.75rem", background: "#f8fafc", borderRadius: 8, minWidth: 0 }}>
      <div style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.15rem" }}>{label}</div>
      <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: "0.68rem", color: "#9ca3af", marginTop: "0.1rem" }}>{sub}</div>}
    </div>
  );
}

// Simple ASCII-style bar chart for decline forecast
function ForecastBar({ label, value, max }: { label: string; value: number | null; max: number }) {
  if (value == null || max === 0) return null;
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.8rem" }}>
      <span style={{ color: "#6b7280", width: 28, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, background: "#e5e7eb", borderRadius: 4, height: 8 }}>
        <div style={{ width: `${pct}%`, background: "#2563eb", borderRadius: 4, height: 8, transition: "width 0.3s" }} />
      </div>
      <span style={{ color: "#374151", fontWeight: 600, width: 52, textAlign: "right", flexShrink: 0 }}>
        {value.toFixed(1)} BOPD
      </span>
    </div>
  );
}

export function DeclineAnalysisCard({ data }: { data: DeclineCurveResult }) {
  if (data.basis === "insufficient_data") {
    return (
      <div style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "1rem 1.25rem",
        background: "#fff",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <span style={{ fontSize: "1rem" }}>📉</span>
          <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>Decline Curve Analysis</span>
        </div>
        <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: 0 }}>
          Insufficient well production data to run decline analysis. At least one well with estimated BOPD is required.
        </p>
      </div>
    );
  }

  const hc = healthColor(data.decline_health);
  const forecastMax = data.current_rate_bopd ?? 1;

  const healthLabel: Record<DeclineCurveResult["decline_health"], string> = {
    strong: "Healthy — <25%/yr",
    moderate: "Moderate — 25–50%/yr",
    steep: "Steep — >50%/yr ⚠",
    exhausted: "Near Exhausted ⚠",
    unknown: "Unknown",
  };

  const basisLabel: Record<DeclineCurveResult["basis"], string> = {
    multi_well_radius: `Aggregate of ${data.well_count} nearby producing wells`,
    single_well_cumulative: "Based on 1 nearby producing well",
    insufficient_data: "Insufficient data",
  };

  return (
    <div style={{
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      overflow: "hidden",
      background: "#fff",
    }}>
      {/* Header */}
      <div style={{
        padding: "0.75rem 1.25rem",
        borderBottom: "1px solid #f3f4f6",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.75rem",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "1rem" }}>📉</span>
          <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>Decline Curve Analysis</span>
        </div>
        <span style={{
          fontSize: "0.72rem",
          fontWeight: 600,
          padding: "0.2rem 0.6rem",
          borderRadius: 20,
          background: hc.bg,
          color: hc.text,
          border: `1px solid ${hc.border}`,
        }}>
          {healthLabel[data.decline_health]}
        </span>
      </div>

      <div style={{ padding: "1rem 1.25rem" }}>
        {/* Metrics grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem", marginBottom: "1rem" }}>
          <MetricCell
            label="Current Rate"
            value={`${fmt(data.current_rate_bopd)} BOPD`}
            sub="aggregate area estimate"
          />
          <MetricCell
            label="Annual Decline"
            value={data.annual_decline_pct ? `${data.annual_decline_pct}/yr` : "—"}
            sub="exponential Dᵢ"
          />
          <MetricCell
            label="Initial Peak"
            value={`${fmt(data.initial_rate_bopd)} BOPD`}
            sub="estimated qᵢ"
          />
          <MetricCell
            label="EUR"
            value={`${fmtK(data.eur_bbl)} BBL`}
            sub="total estimated recovery"
          />
          <MetricCell
            label="Remaining Reserves"
            value={`${fmtK(data.remaining_reserves_bbl)} BBL`}
            sub="from today to abandonment"
          />
          <MetricCell
            label="Economic Life"
            value={data.economic_life_months
              ? `${(data.economic_life_months / 12).toFixed(1)} yrs`
              : "—"}
            sub="at current decline rate"
          />
        </div>

        {/* Forward production forecast */}
        {(data.forecast_12mo_bopd != null) && (
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "0.4rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Forward Production Forecast
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <ForecastBar label="Now" value={data.current_rate_bopd} max={forecastMax} />
              <ForecastBar label="+1yr" value={data.forecast_12mo_bopd} max={forecastMax} />
              <ForecastBar label="+2yr" value={data.forecast_24mo_bopd} max={forecastMax} />
              <ForecastBar label="+3yr" value={data.forecast_36mo_bopd} max={forecastMax} />
            </div>
          </div>
        )}

        {/* Basis label */}
        <div style={{ fontSize: "0.72rem", color: "#9ca3af", borderTop: "1px solid #f3f4f6", paddingTop: "0.5rem" }}>
          {basisLabel[data.basis]} · Exponential decline model (Arps) · Screening-grade only
        </div>
      </div>
    </div>
  );
}
