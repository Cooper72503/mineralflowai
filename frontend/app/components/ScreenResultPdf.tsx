"use client";

/**
 * PDF export for Quick Screen results.
 * Uses @react-pdf/renderer to produce a professional downloadable report.
 */

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
} from "@react-pdf/renderer";
import type { DealValuationOutput } from "@/lib/valuation";
import type { LocationContext } from "@/lib/location/location-context";
import type { ProductionSnapshot } from "@/lib/production/production-snapshot";
import type { DealBrief } from "@/lib/intelligence/deal-brief";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScreenResultPdfData = {
  county: string | null;
  state: string | null;
  acreage: number | null;
  royalty_rate?: string | null;
  producing_status?: "yes" | "no" | "unknown";
  location_context: LocationContext;
  valuation: DealValuationOutput;
  production_snapshot?: ProductionSnapshot | null;
  deal_brief?: DealBrief | null;
  generatedAt?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

function usdRange(lo?: number | null, hi?: number | null): string {
  if (lo == null || hi == null) return "—";
  if (Math.abs(lo - hi) < 1) return usd(lo);
  return `${usd(lo)} – ${usd(hi)}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const C = {
  blue: "#2563eb",
  green: "#166534",
  greenBg: "#dcfce7",
  yellow: "#713f12",
  yellowBg: "#fef9c3",
  red: "#7f1d1d",
  redBg: "#fee2e2",
  orange: "#7c2d12",
  orangeBg: "#fff7ed",
  gray: "#6b7280",
  darkGray: "#374151",
  black: "#111827",
  border: "#e5e7eb",
  lightBg: "#f9fafb",
};

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.black,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
    lineHeight: 1.45,
  },
  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.blue,
  },
  headerBrand: { fontSize: 14, fontFamily: "Helvetica-Bold", color: C.blue },
  headerSub: { fontSize: 8, color: C.gray, marginTop: 2 },
  headerMeta: { fontSize: 7.5, color: C.gray, textAlign: "right" },
  // Verdict banner
  verdict: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    padding: "8 12",
    marginBottom: 12,
  },
  verdictIcon: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    marginRight: 10,
    width: 22,
    textAlign: "center",
  },
  verdictTitle: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  verdictSub: { fontSize: 8, marginTop: 2 },
  verdictValue: { marginLeft: "auto", textAlign: "right" },
  verdictValueLabel: { fontSize: 7, textTransform: "uppercase", letterSpacing: 0.5 },
  verdictValueAmount: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  // Section
  section: { marginBottom: 12 },
  sectionTitle: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: C.gray,
    marginBottom: 5,
  },
  card: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 5,
    padding: "8 10",
    backgroundColor: C.lightBg,
    marginBottom: 8,
  },
  cardBlue: { borderLeftWidth: 3, borderLeftColor: C.blue },
  // Row / DL
  row: { flexDirection: "row", marginBottom: 3 },
  label: { fontSize: 8, color: C.gray, width: 110, flexShrink: 0 },
  value: { fontSize: 8.5, color: C.black, flex: 1 },
  // Text styles
  narrative: { fontSize: 9, color: C.black, lineHeight: 1.55, marginBottom: 6 },
  riskBox: {
    flexDirection: "row",
    gap: 6,
    backgroundColor: C.orangeBg,
    borderWidth: 1,
    borderColor: "#fed7aa",
    borderRadius: 4,
    padding: "6 8",
    marginBottom: 6,
  },
  riskLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#9a3412", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  riskText: { fontSize: 8.5, color: C.orange, lineHeight: 1.5 },
  recommendBox: {
    flexDirection: "row",
    gap: 6,
    backgroundColor: C.greenBg,
    borderWidth: 1,
    borderColor: "#86efac",
    borderRadius: 4,
    padding: "6 8",
    marginBottom: 6,
  },
  recommendLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#14532d", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  recommendText: { fontSize: 8.5, color: C.green, lineHeight: 1.5 },
  // Grade badge
  gradeRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 4 },
  gradeBadge: {
    width: 18, height: 18, borderRadius: 3,
    alignItems: "center", justifyContent: "center",
    marginRight: 6, flexShrink: 0,
  },
  gradeText: { fontSize: 8, fontFamily: "Helvetica-Bold" },
  gradeItem: { flex: 1 },
  gradeTerm: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.darkGray },
  gradeNote: { fontSize: 7.5, color: C.gray, marginTop: 1 },
  // Bullets
  bullet: { flexDirection: "row", marginBottom: 2 },
  bulletDot: { fontSize: 8, color: C.gray, width: 10, flexShrink: 0 },
  bulletText: { fontSize: 8.5, color: C.darkGray, flex: 1, lineHeight: 1.4 },
  // Footer
  footer: {
    position: "absolute",
    bottom: 18,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 5,
  },
  footerText: { fontSize: 7, color: C.gray },
});

// ─── Grade colors ─────────────────────────────────────────────────────────────

function gradeColors(grade: string | null): { bg: string; text: string; border: string } {
  switch (grade) {
    case "A": return { bg: "#dcfce7", text: "#14532d", border: "#86efac" };
    case "B": return { bg: "#dbeafe", text: "#1e3a5f", border: "#93c5fd" };
    case "C": return { bg: "#fef9c3", text: "#713f12", border: "#fde047" };
    case "D": return { bg: "#fed7aa", text: "#7c2d12", border: "#fb923c" };
    case "F": return { bg: "#fee2e2", text: "#7f1d1d", border: "#fca5a5" };
    default:  return { bg: "#f3f4f6", text: "#4b5563", border: "#e5e7eb" };
  }
}

function verdictColors(rec: string): { bg: string; text: string; border: string } {
  if (rec === "PURSUE") return { bg: "#dcfce7", text: "#166534", border: "#16a34a" };
  if (rec === "PASS")   return { bg: "#fee2e2", text: "#7f1d1d", border: "#dc2626" };
  return { bg: "#fef9c3", text: "#713f12", border: "#ca8a04" };
}

// ─── Document ────────────────────────────────────────────────────────────────

export function ScreenResultPdfDocument({ data }: { data: ScreenResultPdfData }) {
  const v = data.valuation;
  const brief = data.deal_brief;
  const snap = data.production_snapshot;
  const loc = data.location_context;
  const vc = verdictColors(v.recommendation);
  const now = data.generatedAt ?? new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const verdictSubtext =
    v.recommendation === "PURSUE" ? "Strong signals — worth moving forward on diligence." :
    v.recommendation === "PASS"   ? "Weak signals or high risk — likely not worth pursuing." :
                                    "Mixed signals — review carefully before committing.";

  return (
    <Document title="MineralFlowAI Screen Report" author="MineralFlowAI">
      <Page size="LETTER" style={styles.page}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerBrand}>MineralFlowAI</Text>
            <Text style={styles.headerSub}>Quick Screen Report — Pre-Underwriting Analysis</Text>
          </View>
          <View>
            <Text style={styles.headerMeta}>Generated {now}</Text>
            <Text style={styles.headerMeta}>{data.county ?? "Unknown county"}{data.state ? `, ${data.state}` : ""}</Text>
          </View>
        </View>

        {/* ── Verdict Banner ── */}
        <View style={[styles.verdict, { backgroundColor: vc.bg, borderWidth: 1.5, borderColor: vc.border }]}>
          <Text style={[styles.verdictIcon, { color: vc.text }]}>
            {v.recommendation === "PURSUE" ? "✓" : v.recommendation === "PASS" ? "✗" : "~"}
          </Text>
          <View>
            <Text style={[styles.verdictTitle, { color: vc.text }]}>{v.recommendation}</Text>
            <Text style={[styles.verdictSub, { color: vc.text }]}>{verdictSubtext}</Text>
          </View>
          {(v.estimated_total_value_low != null && v.estimated_total_value_high != null) && (
            <View style={styles.verdictValue}>
              <Text style={[styles.verdictValueLabel, { color: vc.text }]}>Est. Value</Text>
              <Text style={[styles.verdictValueAmount, { color: vc.text }]}>
                {usdRange(v.estimated_total_value_low, v.estimated_total_value_high)}
              </Text>
            </View>
          )}
        </View>

        {/* ── Property Details ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Property Details</Text>
          <View style={[styles.card, styles.cardBlue]}>
            <View style={styles.row}>
              <Text style={styles.label}>County / State</Text>
              <Text style={styles.value}>{data.county ?? "—"}{data.state ? `, ${data.state}` : ""}</Text>
            </View>
            {data.acreage != null && (
              <View style={styles.row}>
                <Text style={styles.label}>Acreage</Text>
                <Text style={styles.value}>{data.acreage} acres</Text>
              </View>
            )}
            {data.royalty_rate && (
              <View style={styles.row}>
                <Text style={styles.label}>Royalty Rate</Text>
                <Text style={styles.value}>{data.royalty_rate}</Text>
              </View>
            )}
            {data.producing_status && data.producing_status !== "unknown" && (
              <View style={styles.row}>
                <Text style={styles.label}>Producing</Text>
                <Text style={styles.value}>{cap(data.producing_status)}</Text>
              </View>
            )}
            <View style={styles.row}>
              <Text style={styles.label}>Activity Area</Text>
              <Text style={styles.value}>{loc.approximate_area}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Nearby Activity</Text>
              <Text style={styles.value}>{loc.nearby_activity_signal}</Text>
            </View>
          </View>
        </View>

        {/* ── Deal Brief ── */}
        {brief && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Deal Brief</Text>

            {/* Narrative */}
            <Text style={styles.narrative}>{brief.narrative}</Text>

            {/* Primary Risk */}
            <View style={styles.riskBox}>
              <View>
                <Text style={styles.riskLabel}>Primary Risk</Text>
                <Text style={styles.riskText}>{brief.primary_risk}</Text>
              </View>
            </View>

            {/* Recommendation */}
            <View style={styles.recommendBox}>
              <View>
                <Text style={styles.recommendLabel}>What To Do</Text>
                <Text style={styles.recommendText}>{brief.recommendation}</Text>
              </View>
            </View>

            {/* Lease Term Grades */}
            {brief.lease_term_grades.length > 0 && (
              <View style={{ marginBottom: 6 }}>
                <Text style={[styles.sectionTitle, { marginBottom: 4 }]}>Lease Term Grades</Text>
                {brief.lease_term_grades.map((g, i) => {
                  const gc = gradeColors(g.grade);
                  return (
                    <View key={i} style={styles.gradeRow}>
                      {g.grade && (
                        <View style={[styles.gradeBadge, { backgroundColor: gc.bg, borderWidth: 1, borderColor: gc.border }]}>
                          <Text style={[styles.gradeText, { color: gc.text }]}>{g.grade}</Text>
                        </View>
                      )}
                      <View style={styles.gradeItem}>
                        <Text style={styles.gradeTerm}>
                          {g.term}{g.value ? ` · ${g.value}` : ""}
                        </Text>
                        <Text style={styles.gradeNote}>{g.note}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Negotiation Flags */}
            {brief.negotiation_flags.length > 0 && (
              <View>
                <Text style={[styles.sectionTitle, { marginBottom: 4 }]}>Negotiation Flags</Text>
                {brief.negotiation_flags.map((flag, i) => (
                  <View key={i} style={styles.bullet}>
                    <Text style={styles.bulletDot}>•</Text>
                    <Text style={styles.bulletText}>{flag}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* ── Valuation ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pre-Underwriting Valuation</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.label}>Deal Type</Text>
              <Text style={styles.value}>{cap(v.deal_type.replace(/_/g, " "))}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Activity Level</Text>
              <Text style={styles.value}>{cap(v.activity_level)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Signal Confidence</Text>
              <Text style={styles.value}>{cap(v.confidence)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Total Value Range</Text>
              <Text style={styles.value}>{usdRange(v.estimated_total_value_low, v.estimated_total_value_high)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Value / Acre Range</Text>
              <Text style={styles.value}>{usdRange(v.value_per_acre_low, v.value_per_acre_high)}</Text>
            </View>
            {v.nri != null && (
              <View style={styles.row}>
                <Text style={styles.label}>NRI Proxy</Text>
                <Text style={styles.value}>{String(v.nri)}</Text>
              </View>
            )}
            {v.summary && (
              <Text style={[styles.narrative, { marginTop: 5, fontSize: 8.5 }]}>{v.summary}</Text>
            )}
          </View>

          {/* Reasoning */}
          {(v.reasoning?.length ?? 0) > 0 && (
            <View style={{ marginBottom: 5 }}>
              <Text style={[styles.sectionTitle, { marginBottom: 3 }]}>Reasoning</Text>
              {v.reasoning!.map((r, i) => (
                <View key={i} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>{r}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Risks */}
          {(v.risks?.length ?? 0) > 0 && (
            <View style={{ marginBottom: 5 }}>
              <Text style={[styles.sectionTitle, { marginBottom: 3 }]}>Risks & Limitations</Text>
              {v.risks!.map((r, i) => (
                <View key={i} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={[styles.bulletText, { color: C.gray }]}>{r}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* ── Production Snapshot ── */}
        {snap && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {data.producing_status === "no" ? "Development Potential Estimate" : "Production Snapshot"}
            </Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.label}>Status</Text>
                <Text style={styles.value}>{snap.status}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Trend</Text>
                <Text style={styles.value}>{snap.trend}</Text>
              </View>
              {snap.bopd_low != null && snap.bopd_high != null && (
                <View style={styles.row}>
                  <Text style={styles.label}>BOPD Estimate</Text>
                  <Text style={styles.value}>{snap.bopd_low}–{snap.bopd_high} BOPD</Text>
                </View>
              )}
              {snap.monthly_royalty_low != null && snap.monthly_royalty_high != null && (
                <View style={styles.row}>
                  <Text style={styles.label}>Monthly Royalty Est.</Text>
                  <Text style={styles.value}>{usdRange(snap.monthly_royalty_low, snap.monthly_royalty_high)} / mo</Text>
                </View>
              )}
              {snap.confidence && (
                <View style={styles.row}>
                  <Text style={styles.label}>Confidence</Text>
                  <Text style={styles.value}>{snap.confidence}</Text>
                </View>
              )}
              {snap.reasoning?.length > 0 && (
                <Text style={[styles.gradeNote, { marginTop: 4 }]}>{snap.reasoning[0]}</Text>
              )}
            </View>
          </View>
        )}

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>MineralFlowAI — Preliminary screen only. Not an appraisal, title opinion, or reserve report.</Text>
          <Text style={styles.footerText}>Generated {now}</Text>
        </View>
      </Page>
    </Document>
  );
}
