"use client";

import type { CSSProperties } from "react";

const badgeStyle: CSSProperties = {
  display: "inline-block",
  marginLeft: "0.35rem",
  padding: "0.1rem 0.4rem",
  borderRadius: 4,
  fontSize: "0.68rem",
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "#6b7280",
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  verticalAlign: "baseline",
  lineHeight: 1.25,
};

function labelForScore(score: number): string | null {
  if (score >= 85) return "🚨 Premium Deal";
  if (score >= 70) return "🔥 Hot Deal";
  return null;
}

/** Renders next to numeric deal score when score crosses hot / premium thresholds. */
export function DealScoreHotBadge({ score }: { score: number | null | undefined }) {
  if (score == null || Number.isNaN(score)) return null;
  const label = labelForScore(score);
  if (!label) return null;
  return <span style={badgeStyle}>{label}</span>;
}
