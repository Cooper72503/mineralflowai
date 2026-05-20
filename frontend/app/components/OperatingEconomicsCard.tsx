"use client";

import type { MineralEconomicsResult } from "@/lib/economics/mineral-economics";

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

type RowProps = {
  label: string;
  value: string;
  sub?: string;
  bold?: boolean;
  color?: string;
  borderTop?: boolean;
};

function Row({ label, value, sub, bold, color, borderTop }: RowProps) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      padding: "0.45rem 0",
      borderTop: borderTop ? "1px solid #f3f4f6" : undefined,
    }}>
      <div>
        <span style={{ fontSize: "0.83rem", color: bold ? "#0f172a" : "#4b5563", fontWeight: bold ? 700 : 400 }}>
          {label}
        </span>
        {sub && <span style={{ fontSize: "0.72rem", color: "#9ca3af", marginLeft: "0.35rem" }}>{sub}</span>}
      </div>
      <span style={{ fontSize: "0.88rem", fontWeight: bold ? 700 : 500, color: color ?? (bold ? "#0f172a" : "#374151") }}>
        {value}
      </span>
    </div>
  );
}

export function OperatingEconomicsCard({ data }: { data: MineralEconomicsResult }) {
  const se = data.state_economics;
  const basisLabel: Record<MineralEconomicsResult["basis"], string> = {
    tract_production: "Verified TRRC lease production on this tract",
    bopd_anchored: "Anchored to nearby well BOPD data",
    revenue_document: "From document-extracted royalty revenue",
    production_snapshot: "From production snapshot estimates",
    insufficient: "Insufficient data",
  };

  if (data.basis === "insufficient") {
    return (
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem 1.25rem", background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <span style={{ fontSize: "1rem" }}>💰</span>
          <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>Operating Economics</span>
        </div>
        <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: 0 }}>
          Insufficient production data to compute mineral economics. Submit acreage, royalty rate, and county/state to enable this analysis.
        </p>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
      {/* Header */}
      <div style={{
        padding: "0.75rem 1.25rem",
        borderBottom: "1px solid #f3f4f6",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "1rem" }}>💰</span>
          <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>Operating Economics</span>
        </div>
        <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>{basisLabel[data.basis]}</span>
      </div>

      <div style={{ padding: "0.75rem 1.25rem" }}>
        {/* Net royalty highlight */}
        {data.annual_net_royalty != null && (
          <div style={{
            background: "linear-gradient(135deg, #1e3a5f, #2563eb)",
            borderRadius: 10,
            padding: "0.85rem 1rem",
            marginBottom: "0.85rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <div>
              <div style={{ fontSize: "0.68rem", color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.15rem" }}>
                Annual Net Royalty Income
              </div>
              <div style={{ fontSize: "1.5rem", fontWeight: 800, color: "#fff", lineHeight: 1 }}>
                {fmtUsd(data.annual_net_royalty)}
              </div>
              <div style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.6)", marginTop: "0.2rem" }}>
                {fmtUsd(data.monthly_net_royalty)}/mo after taxes
              </div>
            </div>
            {data.effective_net_pct != null && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "0.68rem", color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Net Pct</div>
                <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "#fff" }}>{data.effective_net_pct}%</div>
                <div style={{ fontSize: "0.68rem", color: "rgba(255,255,255,0.5)" }}>of gross royalty</div>
              </div>
            )}
          </div>
        )}

        {/* Revenue waterfall */}
        <div style={{ marginBottom: "0.5rem" }}>
          <Row
            label="Gross Oil Revenue"
            value={fmtUsd(data.annual_gross_oil_revenue)}
            sub={`$${se.oil_price_per_bbl}/bbl assumption`}
          />
          <Row
            label={`Royalty Interest (${data.annual_royalty_gross != null && data.annual_gross_oil_revenue != null
              ? `${((data.annual_royalty_gross / data.annual_gross_oil_revenue) * 100).toFixed(1)}%`
              : "royalty"})`}
            value={fmtUsd(data.annual_royalty_gross)}
          />
          <Row
            label={`Severance Tax (${fmtPct(se.oil_severance_rate * 100)})`}
            value={data.annual_severance_tax != null ? `–${fmtUsd(data.annual_severance_tax)}` : "—"}
            color="#dc2626"
          />
          <Row
            label={`Ad Valorem Tax (${fmtPct(se.ad_valorem_rate * 100)})`}
            value={data.annual_ad_valorem_tax != null ? `–${fmtUsd(data.annual_ad_valorem_tax)}` : "—"}
            color="#dc2626"
          />
          <Row
            label="Annual Net Royalty"
            value={fmtUsd(data.annual_net_royalty)}
            bold
            borderTop
          />
        </div>

        {/* Implied cap rate */}
        {data.implied_cap_rate != null && (
          <div style={{
            background: "#f8fafc",
            borderRadius: 8,
            padding: "0.5rem 0.75rem",
            marginBottom: "0.5rem",
            fontSize: "0.8rem",
            color: "#475569",
          }}>
            Implied cap rate: <strong>{data.implied_cap_rate}%</strong> (net income ÷ estimated value)
          </div>
        )}

        {/* WI economics reference */}
        {data.wi_noi_estimate != null && (
          <div style={{ marginBottom: "0.5rem" }}>
            <div style={{ fontSize: "0.72rem", color: "#6b7280", marginBottom: "0.25rem", fontWeight: 600, textTransform: "uppercase" }}>
              Working Interest Economics (reference)
            </div>
            <Row
              label={`Operator LOE (${se.state} avg $${se.loe_low_per_bbl}–$${se.loe_high_per_bbl}/bbl)`}
              value={data.loe_estimate_annual != null ? `–${fmtUsd(data.loe_estimate_annual)}` : "—"}
              color="#dc2626"
            />
            <Row
              label="WI Net Operating Income"
              value={fmtUsd(data.wi_noi_estimate)}
              bold
              color={data.wi_noi_estimate != null && data.wi_noi_estimate < 0 ? "#dc2626" : "#0f172a"}
            />
          </div>
        )}

        {/* Footer note */}
        <div style={{ fontSize: "0.7rem", color: "#9ca3af", borderTop: "1px solid #f3f4f6", paddingTop: "0.5rem" }}>
          {se.state} state economics applied · Mineral owners do not pay LOE · Screening estimate only
        </div>
      </div>
    </div>
  );
}
