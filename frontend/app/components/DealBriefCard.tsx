"use client";

import type { DealBrief, LeaseTermGrade } from "@/lib/intelligence/deal-brief";

function gradeColor(grade: LeaseTermGrade["grade"]): { bg: string; text: string; border: string } {
  switch (grade) {
    case "A": return { bg: "#dcfce7", text: "#14532d", border: "#86efac" };
    case "B": return { bg: "#dbeafe", text: "#1e3a5f", border: "#93c5fd" };
    case "C": return { bg: "#fef9c3", text: "#713f12", border: "#fde047" };
    case "D": return { bg: "#fed7aa", text: "#7c2d12", border: "#fb923c" };
    case "F": return { bg: "#fee2e2", text: "#7f1d1d", border: "#fca5a5" };
    default:  return { bg: "#f3f4f6", text: "#4b5563", border: "#e5e7eb" };
  }
}

function confColor(c: DealBrief["confidence"]): string {
  if (c === "high") return "#166534";
  if (c === "medium") return "#854d0e";
  return "#6b7280";
}

export function DealBriefCard({ brief }: { brief: DealBrief }) {
  return (
    <div className="card" style={{ maxWidth: 560, marginBottom: "1.5rem", borderLeft: "4px solid #2563eb" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 700, margin: 0, color: "#111827" }}>
          Deal Brief
        </h2>
        <span style={{
          fontSize: "0.72rem", fontWeight: 700, color: confColor(brief.confidence),
          textTransform: "uppercase", letterSpacing: "0.06em",
          background: "#f3f4f6", padding: "0.2rem 0.55rem", borderRadius: 99,
        }}>
          {brief.confidence} confidence
        </span>
      </div>

      {/* Narrative */}
      <p style={{ fontSize: "0.9rem", color: "#1f2937", lineHeight: 1.6, margin: "0 0 1rem" }}>
        {brief.narrative}
      </p>

      {/* Primary Risk */}
      <div style={{
        background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8,
        padding: "0.6rem 0.75rem", marginBottom: "1rem",
        display: "flex", gap: "0.5rem", alignItems: "flex-start",
      }}>
        <span style={{ fontSize: "0.95rem", flexShrink: 0 }}>⚠️</span>
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#9a3412", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" }}>
            Primary Risk
          </div>
          <p style={{ fontSize: "0.85rem", color: "#7c2d12", margin: 0, lineHeight: 1.5 }}>
            {brief.primary_risk}
          </p>
        </div>
      </div>

      {/* Recommendation */}
      <div style={{
        background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8,
        padding: "0.6rem 0.75rem", marginBottom: "1rem",
        display: "flex", gap: "0.5rem", alignItems: "flex-start",
      }}>
        <span style={{ fontSize: "0.95rem", flexShrink: 0 }}>→</span>
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#14532d", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" }}>
            What To Do
          </div>
          <p style={{ fontSize: "0.85rem", color: "#166534", margin: 0, lineHeight: 1.5 }}>
            {brief.recommendation}
          </p>
        </div>
      </div>

      {/* Lease Term Grades */}
      {brief.lease_term_grades.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
            Lease Term Grades
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {brief.lease_term_grades.map((g, i) => {
              const c = gradeColor(g.grade);
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem" }}>
                  {g.grade && (
                    <span style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                      background: c.bg, border: `1px solid ${c.border}`, color: c.text,
                      fontSize: "0.75rem", fontWeight: 800,
                    }}>
                      {g.grade}
                    </span>
                  )}
                  <div style={{ fontSize: "0.83rem", lineHeight: 1.45 }}>
                    <span style={{ fontWeight: 600, color: "#374151" }}>{g.term}</span>
                    {g.value && <span style={{ color: "#6b7280" }}> · {g.value}</span>}
                    <span style={{ display: "block", color: "#6b7280", fontSize: "0.79rem" }}>{g.note}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Negotiation Flags */}
      {brief.negotiation_flags.length > 0 && (
        <div>
          <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
            Negotiation Flags
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {brief.negotiation_flags.map((flag, i) => (
              <li key={i} style={{ fontSize: "0.83rem", color: "#374151", lineHeight: 1.45 }}>
                {flag}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
