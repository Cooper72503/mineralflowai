"use client";

import type { ProductionSnapshot, ProductionStatus, ProductionTrend } from "@/lib/production/production-snapshot";

const EM_DASH = "—";

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatUsdRange(lo?: number | null, hi?: number | null): string {
  if (lo == null || hi == null) return EM_DASH;
  if (Math.abs(lo - hi) < 1e-6) return formatUsd(lo);
  return `${formatUsd(lo)}–${formatUsd(hi)}`;
}

function formatBopd(lo?: number | null, hi?: number | null): string {
  if (lo == null || hi == null) return EM_DASH;
  const fmt = (n: number) => n < 1 ? n.toFixed(2) : n.toFixed(1);
  if (Math.abs(lo - hi) < 0.01) return `${fmt(lo)} BOPD`;
  return `${fmt(lo)}–${fmt(hi)} BOPD`;
}

function statusLabel(s: ProductionStatus): string {
  switch (s) {
    case "producing": return "Producing";
    case "likely_producing": return "Likely Producing";
    case "undeveloped": return "Undeveloped";
    case "unknown": return "Unknown";
  }
}

function trendLabel(t: ProductionTrend): string {
  switch (t) {
    case "active": return "Active";
    case "declining": return "Declining";
    case "legacy": return "Legacy";
    case "unknown": return "Unknown";
  }
}

function statusBadge(s: ProductionStatus): { background: string; color: string; borderColor: string } {
  switch (s) {
    case "producing":
      return { background: "#dcfce7", color: "#166534", borderColor: "#86efac" };
    case "likely_producing":
      return { background: "#dbeafe", color: "#1e40af", borderColor: "#93c5fd" };
    case "undeveloped":
      return { background: "#fef9c3", color: "#854d0e", borderColor: "#fde047" };
    case "unknown":
      return { background: "#f3f4f6", color: "#6b7280", borderColor: "#e5e7eb" };
  }
}

function trendBadge(t: ProductionTrend): { background: string; color: string; borderColor: string } {
  switch (t) {
    case "active":
      return { background: "#dcfce7", color: "#166534", borderColor: "#86efac" };
    case "declining":
      return { background: "#fef3c7", color: "#92400e", borderColor: "#fcd34d" };
    case "legacy":
      return { background: "#fee2e2", color: "#991b1b", borderColor: "#fecaca" };
    case "unknown":
      return { background: "#f3f4f6", color: "#6b7280", borderColor: "#e5e7eb" };
  }
}

function confBadge(c: ProductionSnapshot["confidence"]): { background: string; color: string; borderColor: string } {
  if (c === "high") return { background: "#dbeafe", color: "#1e40af", borderColor: "#93c5fd" };
  if (c === "medium") return { background: "#f3f4f6", color: "#374151", borderColor: "#e5e7eb" };
  return { background: "#fafafa", color: "#6b7280", borderColor: "#e5e7eb" };
}

export function ProductionSnapshotCard({ snap }: { snap: ProductionSnapshot }) {
  const sb = statusBadge(snap.status);
  const tb = trendBadge(snap.trend);
  const cb = confBadge(snap.confidence);
  const hasNumbers = snap.bopd_low != null || snap.monthly_royalty_low != null;

  return (
    <div className="card" style={{ maxWidth: 560, marginBottom: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
        Projected Production
      </h2>
      <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0 0 0.75rem", lineHeight: 1.45 }}>
        Directional production screening only — not a reserve report or engineering estimate.
        {` Oil price assumption: $${snap.oil_price_assumption}/bbl.`}
      </p>

      {/* Status / Trend / Confidence badges */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <span style={{
          display: "inline-block", fontSize: "0.75rem", fontWeight: 600,
          padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${sb.borderColor}`, background: sb.background, color: sb.color,
        }}>
          {statusLabel(snap.status)}
        </span>
        <span style={{
          display: "inline-block", fontSize: "0.75rem", fontWeight: 600,
          padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${tb.borderColor}`, background: tb.background, color: tb.color,
        }}>
          {trendLabel(snap.trend)} trend
        </span>
        <span style={{
          display: "inline-block", fontSize: "0.75rem", fontWeight: 600,
          padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${cb.borderColor}`, background: cb.background, color: cb.color,
        }}>
          Estimate Reliability: {snap.confidence}
        </span>
      </div>

      {/* Numbers */}
      <dl style={{ display: "flex", flexDirection: "column", gap: "0.65rem", marginBottom: "0.75rem" }}>
        <div>
          <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>
            Estimated production rate
          </dt>
          <dd style={{ fontSize: "0.95rem", margin: 0 }}>
            {formatBopd(snap.bopd_low, snap.bopd_high)}
            {!hasNumbers && (
              <span style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", marginTop: "0.25rem" }}>
                Insufficient acreage or location signals for a numeric estimate.
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>
            Est. monthly royalty revenue
          </dt>
          <dd style={{ fontSize: "0.95rem", margin: 0 }}>
            {formatUsdRange(snap.monthly_royalty_low, snap.monthly_royalty_high)}
          </dd>
        </div>
      </dl>

      {/* Reasoning */}
      {snap.reasoning.length > 0 && (
        <div style={{ marginBottom: "0.65rem" }}>
          <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>Reasoning</div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", color: "#374151", lineHeight: 1.45 }}>
            {snap.reasoning.map((line, idx) => <li key={idx}>{line}</li>)}
          </ul>
        </div>
      )}

      {/* Caveats */}
      {snap.caveats.length > 0 && (
        <div>
          <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>Caveats</div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", color: "#6b7280", lineHeight: 1.45 }}>
            {snap.caveats.map((line, idx) => <li key={idx}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
