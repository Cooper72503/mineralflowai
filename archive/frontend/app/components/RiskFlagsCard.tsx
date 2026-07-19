"use client";

import type { RiskFlagsResult, RiskFlag, RiskFlagSeverity } from "@/lib/risk/risk-flags";
import { useState } from "react";

function severityStyle(s: RiskFlagSeverity): { bg: string; text: string; border: string; dot: string } {
  switch (s) {
    case "critical": return { bg: "#fef2f2", text: "#991b1b", border: "#fecaca", dot: "#dc2626" };
    case "high":     return { bg: "#fff7ed", text: "#c2410c", border: "#fed7aa", dot: "#ea580c" };
    case "medium":   return { bg: "#fffbeb", text: "#92400e", border: "#fde68a", dot: "#d97706" };
    case "low":      return { bg: "#f0fdf4", text: "#166534", border: "#bbf7d0", dot: "#16a34a" };
  }
}

function overallStyle(r: RiskFlagsResult["overall_risk"]): { bg: string; text: string; border: string } {
  switch (r) {
    case "critical": return { bg: "#fef2f2", text: "#991b1b", border: "#fecaca" };
    case "high":     return { bg: "#fff7ed", text: "#c2410c", border: "#fed7aa" };
    case "moderate": return { bg: "#fffbeb", text: "#92400e", border: "#fde68a" };
    case "low":      return { bg: "#f0fdf4", text: "#166534", border: "#bbf7d0" };
  }
}

function SeverityBadge({ severity }: { severity: RiskFlagSeverity }) {
  const s = severityStyle(severity);
  return (
    <span style={{
      fontSize: "0.65rem",
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      padding: "0.15rem 0.4rem",
      borderRadius: 4,
      background: s.bg,
      color: s.text,
      border: `1px solid ${s.border}`,
      flexShrink: 0,
    }}>
      {severity}
    </span>
  );
}

function FlagRow({ flag }: { flag: RiskFlag }) {
  const [expanded, setExpanded] = useState(false);
  const s = severityStyle(flag.severity);

  return (
    <div style={{
      border: `1px solid ${s.border}`,
      borderRadius: 8,
      overflow: "hidden",
      background: s.bg,
    }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          padding: "0.6rem 0.85rem",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: s.dot,
          flexShrink: 0,
        }} />
        <span style={{ flex: 1, fontSize: "0.83rem", fontWeight: 600, color: s.text }}>
          {flag.title}
        </span>
        <SeverityBadge severity={flag.severity} />
        <span style={{ fontSize: "0.7rem", color: s.text, opacity: 0.6, flexShrink: 0 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div style={{
          padding: "0 0.85rem 0.75rem",
          borderTop: `1px solid ${s.border}`,
        }}>
          <p style={{ fontSize: "0.8rem", color: s.text, margin: "0.5rem 0 0.35rem", lineHeight: 1.5 }}>
            {flag.description}
          </p>
          <div style={{ fontSize: "0.72rem", color: s.text, opacity: 0.75, marginBottom: "0.35rem" }}>
            <strong>Evidence:</strong> {flag.evidence}
          </div>
          <div style={{
            background: "rgba(255,255,255,0.6)",
            borderRadius: 6,
            padding: "0.4rem 0.6rem",
            fontSize: "0.75rem",
            color: "#374151",
            lineHeight: 1.45,
          }}>
            <strong>Due diligence:</strong> {flag.mitigation}
          </div>
        </div>
      )}
    </div>
  );
}

export function RiskFlagsCard({ data }: { data: RiskFlagsResult }) {
  const os = overallStyle(data.overall_risk);

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
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
          <span style={{ fontSize: "1rem" }}>⚑</span>
          <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#0f172a" }}>Risk Assessment</span>
        </div>
        <span style={{
          fontSize: "0.72rem",
          fontWeight: 700,
          padding: "0.2rem 0.65rem",
          borderRadius: 20,
          background: os.bg,
          color: os.text,
          border: `1px solid ${os.border}`,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}>
          {data.overall_risk} risk
        </span>
      </div>

      <div style={{ padding: "0.85rem 1.25rem" }}>
        {/* Severity summary bar */}
        {data.flags.length > 0 && (
          <div style={{
            display: "flex",
            gap: "0.5rem",
            marginBottom: "0.85rem",
            flexWrap: "wrap",
          }}>
            {data.critical_count > 0 && (
              <span style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem", borderRadius: 12, background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", fontWeight: 600 }}>
                {data.critical_count} Critical
              </span>
            )}
            {data.high_count > 0 && (
              <span style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem", borderRadius: 12, background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa", fontWeight: 600 }}>
                {data.high_count} High
              </span>
            )}
            {data.medium_count > 0 && (
              <span style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem", borderRadius: 12, background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", fontWeight: 600 }}>
                {data.medium_count} Medium
              </span>
            )}
            {data.low_count > 0 && (
              <span style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem", borderRadius: 12, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", fontWeight: 600 }}>
                {data.low_count} Low
              </span>
            )}
          </div>
        )}

        {/* Flag list */}
        {data.flags.length === 0 ? (
          <div style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            fontSize: "0.83rem",
            color: "#166534",
          }}>
            ✓ No significant risk flags identified from available data. Proceed with standard due diligence.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {data.flags.map(flag => (
              <FlagRow key={flag.id} flag={flag} />
            ))}
          </div>
        )}

        <p style={{ fontSize: "0.7rem", color: "#9ca3af", margin: "0.75rem 0 0", lineHeight: 1.4 }}>
          Click any flag to expand description and due diligence guidance.
          Flags are automated from available well, legal, and location data — not a substitute for title review or engineering.
        </p>
      </div>
    </div>
  );
}
