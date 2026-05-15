"use client";

/**
 * Full underwriting PDF report for Quick Screen results.
 * Sections: Verdict · Property · Nearby Wells · Decline Curve ·
 *           Operating Economics · Risk Assessment · P&A Liability ·
 *           Production Snapshot · Deal Brief · Valuation Detail
 */

import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { DealValuationOutput } from "@/lib/valuation";
import type { LocationContext } from "@/lib/location/location-context";
import type { ProductionSnapshot } from "@/lib/production/production-snapshot";
import type { DealBrief } from "@/lib/intelligence/deal-brief";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import type { DeclineCurveResult } from "@/lib/decline/decline-curve";
import type { MineralEconomicsResult } from "@/lib/economics/mineral-economics";
import type { RiskFlagsResult, RiskFlag } from "@/lib/risk/risk-flags";
import type { PaLiabilityResult } from "@/lib/risk/pa-liability";
import { buildProductionHistory } from "@/app/components/ProductionHistoryTable";
import { normalizeRoyaltyToDecimal } from "@/lib/valuation/normalize";

// ─── Data type ───────────────────────────────────────────────────────────────

export type ScreenResultPdfData = {
  county: string | null;
  state: string | null;
  acreage: number | null;
  royalty_rate?: string | null;
  producing_status?: "yes" | "no" | "unknown";
  location_context?: LocationContext | null;
  legal_description_parsed?: import("@/lib/location/legal-description-parser").LegalDescriptionParseResult | null;
  valuation: DealValuationOutput;
  production_snapshot?: ProductionSnapshot | null;
  deal_brief?: DealBrief | null;
  nearby_well_intelligence?: NearbyWellIntelligence | null;
  decline_analysis?: DeclineCurveResult | null;
  mineral_economics?: MineralEconomicsResult | null;
  risk_flags?: RiskFlagsResult | null;
  pa_liability?: PaLiabilityResult | null;
  generatedAt?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(0)}`;
}
function usdRange(lo?: number | null, hi?: number | null): string {
  if (lo == null || hi == null) return "—";
  if (Math.abs(lo - hi) < 1) return usd(lo);
  return `${usd(lo)} – ${usd(hi)}`;
}
function pct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}
function fmtK(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M BBL`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k BBL`;
  return `${Math.round(n)} BBL`;
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "—";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─── Color palette ───────────────────────────────────────────────────────────

const C = {
  navy:       "#0c1526",
  blue:       "#2563eb",
  blueMid:    "#1d4ed8",
  blueBg:     "#eff6ff",
  blueBorder: "#bfdbfe",
  green:      "#166534",
  greenBg:    "#dcfce7",
  greenBorder:"#86efac",
  yellow:     "#713f12",
  yellowBg:   "#fef9c3",
  yellowBorder:"#fde047",
  orange:     "#7c2d12",
  orangeBg:   "#fff7ed",
  orangeBorder:"#fed7aa",
  red:        "#7f1d1d",
  redBg:      "#fee2e2",
  redBorder:  "#fca5a5",
  gray:       "#6b7280",
  midGray:    "#4b5563",
  darkGray:   "#374151",
  black:      "#0f172a",
  border:     "#e2e8f0",
  lightBg:    "#f8fafc",
  white:      "#ffffff",
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 8.5,
    color: C.black,
    paddingTop: 38,
    paddingBottom: 52,
    paddingHorizontal: 38,
    lineHeight: 1.45,
    backgroundColor: C.white,
  },

  // ── Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 16,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: C.blue,
  },
  headerBrand: { fontSize: 15, fontFamily: "Helvetica-Bold", color: C.navy, letterSpacing: -0.3 },
  headerTagline: { fontSize: 7.5, color: C.gray, marginTop: 2 },
  headerRight: { fontSize: 7.5, color: C.gray, textAlign: "right" },

  // ── Verdict
  verdictBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 7,
    padding: "10 14",
    marginBottom: 12,
    borderWidth: 1.5,
  },
  verdictBadge: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    marginRight: 12, flexShrink: 0,
  },
  verdictBadgeText: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  verdictTitle: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  verdictSub: { fontSize: 8, marginTop: 2 },
  verdictRight: { marginLeft: "auto", textAlign: "right" },
  verdictValueLabel: { fontSize: 7, textTransform: "uppercase", letterSpacing: 0.6 },
  verdictValueAmount: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 1 },
  verdictRangeNote: { fontSize: 7, marginTop: 1 },

  // ── Section
  section: { marginBottom: 14 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sectionTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: C.midGray,
    flex: 1,
  },
  sectionBadge: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },

  // ── Card
  card: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 5,
    backgroundColor: C.lightBg,
    marginBottom: 6,
    overflow: "hidden",
  },
  cardBody: { padding: "8 10" },
  cardHighlight: {
    padding: "10 12",
    backgroundColor: C.navy,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderRadius: 5,
    marginBottom: 6,
  },

  // ── Key-value rows
  kvRow: { flexDirection: "row", marginBottom: 3.5 },
  kvLabel: { fontSize: 8, color: C.gray, width: 130, flexShrink: 0 },
  kvValue: { fontSize: 8.5, color: C.darkGray, flex: 1 },
  kvValueBold: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black, flex: 1 },

  // ── Two-column grid
  grid2: { flexDirection: "row", gap: 8, marginBottom: 6 },
  gridCell: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 5,
    padding: "7 9",
    backgroundColor: C.lightBg,
  },
  gridCellLabel: { fontSize: 7, color: C.gray, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  gridCellValue: { fontSize: 10, fontFamily: "Helvetica-Bold", color: C.black },
  gridCellSub: { fontSize: 7, color: C.gray, marginTop: 1 },

  // ── Well table
  tableHeader: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  tableRowAlt: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: "#f8fafc",
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  tableColHeader: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.midGray, textTransform: "uppercase", letterSpacing: 0.4 },
  tableColCell: { fontSize: 7.5, color: C.darkGray },

  // ── Forecast bar
  barTrack: { height: 7, backgroundColor: "#e2e8f0", borderRadius: 3, flex: 1 },
  barFill: { height: 7, backgroundColor: C.blue, borderRadius: 3 },

  // ── Text
  narrative: { fontSize: 8.5, color: C.darkGray, lineHeight: 1.6, marginBottom: 6 },
  bullet: { flexDirection: "row", marginBottom: 2.5 },
  bulletDot: { fontSize: 8, color: C.gray, width: 10, flexShrink: 0, marginTop: 0.5 },
  bulletText: { fontSize: 8.5, color: C.darkGray, flex: 1, lineHeight: 1.45 },

  // ── Severity / highlight boxes
  alertBox: {
    flexDirection: "row",
    borderRadius: 4,
    padding: "6 8",
    marginBottom: 5,
    borderWidth: 1,
  },
  alertBoxLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  alertBoxText: { fontSize: 8, lineHeight: 1.5 },

  // ── Flag row
  flagRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 4,
    marginBottom: 3.5,
    padding: "5 8",
    borderWidth: 1,
  },
  flagSeverityTag: {
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
    marginRight: 8,
    flexShrink: 0,
    marginTop: 1,
  },
  flagTitle: { fontSize: 8.5, fontFamily: "Helvetica-Bold", flex: 1 },

  // ── Grade badge
  gradeBadge: {
    width: 18, height: 18, borderRadius: 3,
    alignItems: "center", justifyContent: "center",
    marginRight: 7, flexShrink: 0,
  },

  // ── Footer
  footer: {
    position: "absolute",
    bottom: 20,
    left: 38,
    right: 38,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 5,
  },
  footerText: { fontSize: 6.5, color: "#9ca3af" },
});

// ─── Color helpers ────────────────────────────────────────────────────────────

function verdictPalette(rec: string) {
  if (rec === "PURSUE") return { bg: C.greenBg, border: C.greenBorder, text: C.green, badgeBg: "#16a34a", icon: "✓" };
  if (rec === "PASS")   return { bg: C.redBg,   border: C.redBorder,   text: C.red,   badgeBg: "#dc2626", icon: "✗" };
  return { bg: C.yellowBg, border: C.yellowBorder, text: C.yellow, badgeBg: "#ca8a04", icon: "~" };
}

function severityPalette(s: RiskFlag["severity"]) {
  switch (s) {
    case "critical": return { bg: C.redBg,    border: C.redBorder,    text: C.red };
    case "high":     return { bg: C.orangeBg, border: C.orangeBorder, text: C.orange };
    case "medium":   return { bg: C.yellowBg, border: C.yellowBorder, text: C.yellow };
    default:         return { bg: C.greenBg,  border: C.greenBorder,  text: C.green };
  }
}

function overallRiskPalette(r: RiskFlagsResult["overall_risk"]) {
  switch (r) {
    case "critical": return { bg: C.redBg,    border: C.redBorder,    text: C.red };
    case "high":     return { bg: C.orangeBg, border: C.orangeBorder, text: C.orange };
    case "moderate": return { bg: C.yellowBg, border: C.yellowBorder, text: C.yellow };
    default:         return { bg: C.greenBg,  border: C.greenBorder,  text: C.green };
  }
}

function gradeColors(g: string | null) {
  switch (g) {
    case "A": return { bg: C.greenBg,  text: "#14532d", border: C.greenBorder };
    case "B": return { bg: C.blueBg,   text: "#1e3a5f", border: C.blueBorder  };
    case "C": return { bg: C.yellowBg, text: "#713f12", border: C.yellowBorder };
    case "D": return { bg: C.orangeBg, text: C.orange,  border: C.orangeBorder };
    default:  return { bg: C.lightBg,  text: C.midGray, border: C.border      };
  }
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function SectionHeader({ title, badge, badgeColor }: {
  title: string;
  badge?: string;
  badgeColor?: { bg: string; border: string; text: string };
}) {
  return (
    <View style={S.sectionHeader}>
      <Text style={S.sectionTitle}>{title}</Text>
      {badge && badgeColor && (
        <Text style={[S.sectionBadge, { backgroundColor: badgeColor.bg, borderColor: badgeColor.border, color: badgeColor.text }]}>
          {badge}
        </Text>
      )}
    </View>
  );
}

function KV({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={S.kvRow}>
      <Text style={S.kvLabel}>{label}</Text>
      <Text style={bold ? S.kvValueBold : S.kvValue}>{value}</Text>
    </View>
  );
}

function MetricCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={S.gridCell}>
      <Text style={S.gridCellLabel}>{label}</Text>
      <Text style={S.gridCellValue}>{value}</Text>
      {sub && <Text style={S.gridCellSub}>{sub}</Text>}
    </View>
  );
}

function Bullet({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <View style={S.bullet}>
      <Text style={S.bulletDot}>•</Text>
      <Text style={[S.bulletText, muted ? { color: C.gray } : {}]}>{text}</Text>
    </View>
  );
}

// ─── Document ────────────────────────────────────────────────────────────────

export function ScreenResultPdfDocument({ data }: { data: ScreenResultPdfData }) {
  const v      = data.valuation;
  const brief  = data.deal_brief;
  const snap   = data.production_snapshot;
  const loc    = data.location_context;
  const wells  = data.nearby_well_intelligence;
  const dec    = data.decline_analysis;
  const econ   = data.mineral_economics;
  const flags  = data.risk_flags;
  const pa     = data.pa_liability;

  const vp   = verdictPalette(v.recommendation);
  const now  = data.generatedAt
    ?? new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const location = [data.county, data.state].filter(Boolean).join(", ") || "Unknown Location";

  const verdictSubtext =
    v.recommendation === "PURSUE" ? "Strong signals — worth moving forward on full diligence." :
    v.recommendation === "PASS"   ? "Weak signals or elevated risk — likely not worth pursuing." :
                                    "Mixed signals — review carefully before committing capital.";

  return (
    <Document title={`MineralFlow AI — ${location}`} author="MineralFlow AI">
      <Page size="LETTER" style={S.page}>

        {/* ════════════════════════════════════════════════════════════════
            HEADER
        ════════════════════════════════════════════════════════════════ */}
        <View style={S.header}>
          <View>
            <Text style={S.headerBrand}>MineralFlow AI</Text>
            <Text style={S.headerTagline}>Automated Underwriting Report · Pre-Underwriting Analysis</Text>
          </View>
          <View>
            <Text style={S.headerRight}>{location}</Text>
            <Text style={S.headerRight}>Generated {now}</Text>
          </View>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            VERDICT BANNER
        ════════════════════════════════════════════════════════════════ */}
        <View style={[S.verdictBanner, { backgroundColor: vp.bg, borderColor: vp.border }]}>
          <View style={[S.verdictBadge, { backgroundColor: vp.badgeBg }]}>
            <Text style={[S.verdictBadgeText, { color: "#fff" }]}>{vp.icon}</Text>
          </View>
          <View>
            <Text style={[S.verdictTitle, { color: vp.text }]}>{v.recommendation}</Text>
            <Text style={[S.verdictSub, { color: vp.text }]}>{verdictSubtext}</Text>
            {wells && wells.total_count > 0 && (
              <Text style={[S.verdictSub, { color: vp.text, marginTop: 2, fontFamily: "Helvetica-Oblique" }]}>
                Production inferred from {wells.total_count} nearby well{wells.total_count !== 1 ? "s" : ""}
                {wells.geocode_source !== "none" ? ` within ${wells.radius_miles} mi` : " in county"} — not confirmed on this tract.
              </Text>
            )}
          </View>
          <View style={S.verdictRight}>
            {v.point_estimate != null ? (
              <>
                <Text style={[S.verdictValueLabel, { color: vp.text }]}>
                  Est. Value{v.point_estimate_basis === "bopd_anchored" ? " · Live Data" : ""}
                </Text>
                <Text style={[S.verdictValueAmount, { color: vp.text }]}>{usd(v.point_estimate)}</Text>
                {v.estimated_total_value_low != null && v.estimated_total_value_high != null && (
                  <Text style={[S.verdictRangeNote, { color: vp.text }]}>
                    {usdRange(v.estimated_total_value_low, v.estimated_total_value_high)} range
                  </Text>
                )}
              </>
            ) : (v.estimated_total_value_low != null && v.estimated_total_value_high != null) && (
              <>
                <Text style={[S.verdictValueLabel, { color: vp.text }]}>Est. Value Range</Text>
                <Text style={[S.verdictValueAmount, { color: vp.text }]}>
                  {usdRange(v.estimated_total_value_low, v.estimated_total_value_high)}
                </Text>
              </>
            )}
          </View>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            PROPERTY DETAILS
        ════════════════════════════════════════════════════════════════ */}
        <View style={S.section}>
          <SectionHeader title="Property Details" />
          <View style={[S.grid2]}>
            <View style={S.gridCell}>
              <Text style={S.gridCellLabel}>Location</Text>
              <Text style={[S.gridCellValue, { fontSize: 9 }]}>{location}</Text>
              {loc && loc.approximate_area !== location && (
                <Text style={S.gridCellSub}>{loc.approximate_area}</Text>
              )}
            </View>
            <View style={S.gridCell}>
              <Text style={S.gridCellLabel}>Acreage</Text>
              <Text style={S.gridCellValue}>{data.acreage != null ? `${data.acreage} acres` : "—"}</Text>
              {data.royalty_rate && <Text style={S.gridCellSub}>Royalty: {data.royalty_rate}</Text>}
            </View>
            <View style={S.gridCell}>
              <Text style={S.gridCellLabel}>Activity Signal</Text>
              <Text style={[S.gridCellValue, { fontSize: 8 }]}>{loc?.nearby_activity_signal ?? v.activity_level}</Text>
            </View>
            <View style={S.gridCell}>
              <Text style={S.gridCellLabel}>Producing Status</Text>
              <Text style={S.gridCellValue}>{data.producing_status ? cap(data.producing_status) : "—"}</Text>
              <Text style={S.gridCellSub}>{cap(v.activity_level)} activity</Text>
            </View>
          </View>
        </View>

        {/* ════════════════════════════════════════════════════════════════
            NEARBY WELLS (API MATCHING / TRRC RESEARCH)
        ════════════════════════════════════════════════════════════════ */}
        {wells && (
          <View style={S.section}>
            <SectionHeader
              title="Nearby Well Intelligence"
              badge={`${wells.total_count} wells found`}
              badgeColor={{ bg: C.blueBg, border: C.blueBorder, text: C.blue }}
            />

            {/* Summary stats */}
            <View style={S.grid2}>
              <MetricCell
                label="Total Wells"
                value={String(wells.total_count)}
                sub={`${wells.producing_count} producing`}
              />
              <MetricCell
                label="Median BOPD"
                value={wells.median_bopd != null ? `${wells.median_bopd.toFixed(1)} BOPD` : "—"}
                sub="area production rate"
              />
              <MetricCell
                label="BOPD Range"
                value={wells.min_bopd != null && wells.max_bopd != null
                  ? `${wells.min_bopd.toFixed(1)} – ${wells.max_bopd.toFixed(1)}`
                  : "—"}
                sub="min – max BOPD"
              />
              <MetricCell
                label="Search Radius"
                value={wells.geocode_source !== "none" ? `${wells.radius_miles} mi` : "County-wide"}
                sub={wells.geocode_source === "plss_blm" ? "PLSS geocoded" : wells.geocode_source === "plss_estimated" ? "Estimated centroid" : "No geocode"}
              />
            </View>

            {/* Well table */}
            {wells.wells.length > 0 && (
              <View style={[S.card, { marginBottom: 0 }]}>
                <View style={S.tableHeader}>
                  <Text style={[S.tableColHeader, { width: 95 }]}>API #</Text>
                  <Text style={[S.tableColHeader, { flex: 1 }]}>Well Name</Text>
                  <Text style={[S.tableColHeader, { width: 80 }]}>Operator</Text>
                  <Text style={[S.tableColHeader, { width: 50 }]}>Status</Text>
                  <Text style={[S.tableColHeader, { width: 48, textAlign: "right" }]}>BOPD</Text>
                  <Text style={[S.tableColHeader, { width: 38, textAlign: "right" }]}>Dist.</Text>
                </View>
                {wells.wells.slice(0, 8).map((w, i) => (
                  <View key={w.api} style={i % 2 === 0 ? S.tableRow : S.tableRowAlt}>
                    <Text style={[S.tableColCell, { width: 95, color: C.blue }]}>{w.api}</Text>
                    <Text style={[S.tableColCell, { flex: 1 }]}>{truncate(w.well_name, 22)}</Text>
                    <Text style={[S.tableColCell, { width: 80 }]}>{truncate(w.operator, 14)}</Text>
                    <Text style={[S.tableColCell, { width: 50 }]}>{truncate(w.status, 10)}</Text>
                    <Text style={[S.tableColCell, { width: 48, textAlign: "right", fontFamily: w.latest_bopd ? "Helvetica-Bold" : "Helvetica" }]}>
                      {w.latest_bopd != null ? `${w.latest_bopd.toFixed(1)}` : "—"}
                    </Text>
                    <Text style={[S.tableColCell, { width: 38, textAlign: "right", color: C.gray }]}>
                      {w.distance_miles != null ? `${w.distance_miles.toFixed(1)} mi` : "—"}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            DECLINE CURVE ANALYSIS
        ════════════════════════════════════════════════════════════════ */}
        {dec && dec.basis !== "insufficient_data" && (
          <View style={S.section}>
            <SectionHeader
              title="Decline Curve Analysis"
              badge={
                dec.decline_health === "strong"   ? "Healthy < 25%/yr" :
                dec.decline_health === "moderate"  ? "Moderate 25–50%/yr" :
                dec.decline_health === "steep"     ? "Steep > 50%/yr ⚠" :
                dec.decline_health === "exhausted" ? "Near Exhausted ⚠" : "Unknown"
              }
              badgeColor={
                dec.decline_health === "strong"    ? { bg: C.greenBg,  border: C.greenBorder,  text: C.green  } :
                dec.decline_health === "moderate"  ? { bg: C.yellowBg, border: C.yellowBorder, text: C.yellow } :
                dec.decline_health === "steep"     ? { bg: C.orangeBg, border: C.orangeBorder, text: C.orange } :
                dec.decline_health === "exhausted" ? { bg: C.redBg,    border: C.redBorder,    text: C.red    } :
                                                     { bg: C.lightBg,  border: C.border,       text: C.gray   }
              }
            />
            <View style={S.grid2}>
              <MetricCell label="Current Rate"       value={dec.current_rate_bopd != null ? `${dec.current_rate_bopd.toFixed(1)} BOPD` : "—"} sub="aggregate area estimate" />
              <MetricCell label="Annual Decline"     value={dec.annual_decline_pct ?? "—"}                                                      sub="exponential Dᵢ" />
              <MetricCell label="Initial Peak (qᵢ)"  value={dec.initial_rate_bopd != null ? `${dec.initial_rate_bopd.toFixed(1)} BOPD` : "—"}  sub="estimated peak" />
              <MetricCell label="EUR"                value={fmtK(dec.eur_bbl)}                                                                   sub="total recovery" />
              <MetricCell label="Remaining Reserves" value={fmtK(dec.remaining_reserves_bbl)}                                                   sub="to abandonment" />
              <MetricCell label="Economic Life"      value={dec.economic_life_months ? `${(dec.economic_life_months / 12).toFixed(1)} yrs` : "—"} sub="at current decline" />
            </View>

            {/* Forward forecast bar chart */}
            {dec.current_rate_bopd != null && dec.forecast_12mo_bopd != null && (
              <View style={[S.card, { marginBottom: 0 }]}>
                <View style={S.cardBody}>
                  <Text style={[S.gridCellLabel, { marginBottom: 6 }]}>Forward Production Forecast (BOPD)</Text>
                  {[
                    { label: "Now",   val: dec.current_rate_bopd   },
                    { label: "+1 yr", val: dec.forecast_12mo_bopd  },
                    { label: "+2 yr", val: dec.forecast_24mo_bopd  },
                    { label: "+3 yr", val: dec.forecast_36mo_bopd  },
                  ].map(({ label, val }) => {
                    if (val == null) return null;
                    const pctWidth = Math.min(100, ((val) / (dec.current_rate_bopd ?? 1)) * 100);
                    return (
                      <View key={label} style={{ flexDirection: "row", alignItems: "center", marginBottom: 5, gap: 8 }}>
                        <Text style={{ fontSize: 7.5, color: C.gray, width: 30, flexShrink: 0 }}>{label}</Text>
                        <View style={S.barTrack}>
                          <View style={[S.barFill, { width: `${pctWidth}%` }]} />
                        </View>
                        <Text style={{ fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.darkGray, width: 55, textAlign: "right", flexShrink: 0 }}>
                          {val.toFixed(1)} BOPD
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
            <Text style={[S.footerText, { marginTop: 4, color: C.gray }]}>
              {dec.basis === "multi_well_radius"
                ? `Aggregate of ${dec.well_count} nearby producing wells · `
                : `Based on ${dec.well_count} nearby producing well · `}
              Exponential decline model (Arps) · Screening-grade only
            </Text>
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            OPERATING ECONOMICS
        ════════════════════════════════════════════════════════════════ */}
        {econ && econ.basis !== "insufficient" && (
          <View style={S.section}>
            <SectionHeader title="Operating Economics" />

            {/* Net royalty highlight */}
            {econ.annual_net_royalty != null && (
              <View style={S.cardHighlight}>
                <View>
                  <Text style={{ fontSize: 7, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                    Annual Net Royalty Income
                  </Text>
                  <Text style={{ fontSize: 20, fontFamily: "Helvetica-Bold", color: "#fff" }}>
                    {usd(econ.annual_net_royalty)}
                  </Text>
                  <Text style={{ fontSize: 7.5, color: "rgba(255,255,255,0.6)", marginTop: 2 }}>
                    {usd(econ.monthly_net_royalty)}/mo after taxes
                  </Text>
                </View>
                {econ.effective_net_pct != null && (
                  <View style={{ textAlign: "right" }}>
                    <Text style={{ fontSize: 7, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 0.5 }}>Net Pct</Text>
                    <Text style={{ fontSize: 16, fontFamily: "Helvetica-Bold", color: "#fff" }}>{econ.effective_net_pct}%</Text>
                    <Text style={{ fontSize: 7, color: "rgba(255,255,255,0.4)" }}>of gross royalty</Text>
                  </View>
                )}
                {econ.implied_cap_rate != null && (
                  <View style={{ textAlign: "right" }}>
                    <Text style={{ fontSize: 7, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: 0.5 }}>Cap Rate</Text>
                    <Text style={{ fontSize: 16, fontFamily: "Helvetica-Bold", color: "#fff" }}>{econ.implied_cap_rate}%</Text>
                    <Text style={{ fontSize: 7, color: "rgba(255,255,255,0.4)" }}>income ÷ value</Text>
                  </View>
                )}
              </View>
            )}

            {/* Revenue waterfall */}
            <View style={[S.card, { marginBottom: 0 }]}>
              <View style={S.cardBody}>
                <KV label="Gross Oil Revenue"   value={usd(econ.annual_gross_oil_revenue)} />
                <KV label="Royalty Interest"    value={usd(econ.annual_royalty_gross)} />
                <KV label={`Severance Tax (${pct(econ.state_economics.oil_severance_rate * 100)})`}
                    value={econ.annual_severance_tax != null ? `–${usd(econ.annual_severance_tax)}` : "—"} />
                <KV label={`Ad Valorem Tax (${pct(econ.state_economics.ad_valorem_rate * 100)})`}
                    value={econ.annual_ad_valorem_tax != null ? `–${usd(econ.annual_ad_valorem_tax)}` : "—"} />
                <View style={[S.kvRow, { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 5, marginTop: 2 }]}>
                  <Text style={[S.kvLabel, { fontFamily: "Helvetica-Bold", color: C.black }]}>Annual Net Royalty</Text>
                  <Text style={S.kvValueBold}>{usd(econ.annual_net_royalty)}</Text>
                </View>
                {econ.wi_noi_estimate != null && (
                  <View style={{ marginTop: 6, paddingTop: 5, borderTopWidth: 1, borderTopColor: C.border }}>
                    <Text style={[S.gridCellLabel, { marginBottom: 4 }]}>Working Interest Economics (reference)</Text>
                    <KV label={`Operator LOE (${econ.state_economics.state} avg)`}
                        value={econ.loe_estimate_annual != null ? `–${usd(econ.loe_estimate_annual)}` : "—"} />
                    <KV label="WI Net Operating Income" value={usd(econ.wi_noi_estimate)} bold />
                  </View>
                )}
              </View>
            </View>
            <Text style={[S.footerText, { marginTop: 4, color: C.gray }]}>
              {econ.state_economics.state} state economics applied · Mineral owners do not pay LOE · Screening estimate only
            </Text>
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            RISK ASSESSMENT
        ════════════════════════════════════════════════════════════════ */}
        {flags && (
          <View style={S.section}>
            <SectionHeader
              title="Risk Assessment"
              badge={`${cap(flags.overall_risk)} Risk`}
              badgeColor={overallRiskPalette(flags.overall_risk)}
            />

            {/* Severity summary */}
            {flags.flags.length > 0 && (
              <View style={{ flexDirection: "row", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                {flags.critical_count > 0 && (
                  <Text style={[S.sectionBadge, { backgroundColor: C.redBg, borderColor: C.redBorder, color: C.red }]}>
                    {flags.critical_count} Critical
                  </Text>
                )}
                {flags.high_count > 0 && (
                  <Text style={[S.sectionBadge, { backgroundColor: C.orangeBg, borderColor: C.orangeBorder, color: C.orange }]}>
                    {flags.high_count} High
                  </Text>
                )}
                {flags.medium_count > 0 && (
                  <Text style={[S.sectionBadge, { backgroundColor: C.yellowBg, borderColor: C.yellowBorder, color: C.yellow }]}>
                    {flags.medium_count} Medium
                  </Text>
                )}
                {flags.low_count > 0 && (
                  <Text style={[S.sectionBadge, { backgroundColor: C.greenBg, borderColor: C.greenBorder, color: C.green }]}>
                    {flags.low_count} Low
                  </Text>
                )}
              </View>
            )}

            {flags.flags.length === 0 ? (
              <View style={[S.alertBox, { backgroundColor: C.greenBg, borderColor: C.greenBorder }]}>
                <Text style={[S.alertBoxText, { color: C.green }]}>
                  ✓ No significant risk flags identified from available data. Proceed with standard due diligence.
                </Text>
              </View>
            ) : (
              flags.flags.map((flag) => {
                const sp = severityPalette(flag.severity);
                return (
                  <View key={flag.id} style={[S.flagRow, { backgroundColor: sp.bg, borderColor: sp.border }]}>
                    <Text style={[S.flagSeverityTag, { backgroundColor: sp.bg, borderColor: sp.border, color: sp.text }]}>
                      {flag.severity.toUpperCase()}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[S.flagTitle, { color: sp.text }]}>{flag.title}</Text>
                      <Text style={[S.alertBoxText, { color: sp.text, marginTop: 2 }]}>{flag.description}</Text>
                      <Text style={[S.footerText, { color: sp.text, marginTop: 3, opacity: 0.75 }]}>
                        Due diligence: {flag.mitigation}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            P&A LIABILITY
        ════════════════════════════════════════════════════════════════ */}
        {pa && pa.well_count > 0 && (
          <View style={S.section}>
            <SectionHeader
              title="Plug & Abandon Liability"
              badge={`${cap(pa.severity)} Severity`}
              badgeColor={
                pa.severity === "critical" ? { bg: C.redBg,    border: C.redBorder,    text: C.red    } :
                pa.severity === "high"     ? { bg: C.orangeBg, border: C.orangeBorder, text: C.orange } :
                pa.severity === "moderate" ? { bg: C.yellowBg, border: C.yellowBorder, text: C.yellow } :
                                             { bg: C.greenBg,  border: C.greenBorder,  text: C.green  }
              }
            />
            <View style={[S.card, { marginBottom: 0 }]}>
              <View style={S.cardBody}>
                <KV label="Wells Analyzed"          value={String(pa.well_count)} />
                <KV label="At-Risk Wells"           value={String(pa.at_risk_count)} />
                <KV label="Plugged / Abandoned"     value={String(pa.plugged_count)} />
                <KV label="Est. P&A Exposure (low)" value={usd(pa.total_liability_low)} />
                <KV label="Est. P&A Exposure (high)" value={usd(pa.total_liability_high)} bold />
                {pa.primary_driver && (
                  <Text style={[S.narrative, { marginTop: 5, marginBottom: 0 }]}>{pa.primary_driver}</Text>
                )}
              </View>
            </View>
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            PRODUCTION SNAPSHOT
        ════════════════════════════════════════════════════════════════ */}
        {snap && (
          <View style={S.section}>
            <SectionHeader title={data.producing_status === "no" ? "Development Potential Estimate" : "Production Snapshot"} />
            <View style={S.grid2}>
              <MetricCell label="Status"         value={snap.status} />
              <MetricCell label="Trend"          value={snap.trend} />
              {snap.bopd_low != null && snap.bopd_high != null && (
                <MetricCell label="BOPD Estimate" value={`${snap.bopd_low}–${snap.bopd_high} BOPD`} />
              )}
              {snap.monthly_royalty_low != null && snap.monthly_royalty_high != null && (
                <MetricCell label="Monthly Royalty Est." value={usdRange(snap.monthly_royalty_low, snap.monthly_royalty_high) + " / mo"} />
              )}
              {snap.confidence && (
                <MetricCell label="Confidence" value={snap.confidence} />
              )}
            </View>
            {snap.reasoning?.length > 0 && (
              <Text style={[S.narrative, { marginBottom: 0, color: C.gray, fontFamily: "Helvetica-Oblique" }]}>
                {snap.reasoning[0]}
              </Text>
            )}
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            PRODUCTION STATEMENT (36 MONTHS)
        ════════════════════════════════════════════════════════════════ */}
        {(() => {
          const ph = buildProductionHistory({
            declineAnalysis: dec ?? null,
            nearbyWellIntelligence: wells ?? null,
            royaltyRate: normalizeRoyaltyToDecimal(data.royalty_rate),
          });
          if (!ph) return null;
          const showRev = ph.months[0]?.gross_revenue != null;
          const showRoy = ph.months[0]?.net_royalty != null;
          const basisLabel = ph.basis === "decline_model" ? "Decline Model" : "Basin Estimate";
          const fmtUsd = (n: number | null) =>
            n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
          const fmtBbl = (n: number) => n.toLocaleString("en-US");
          // Show up to 12 most recent months in the PDF (condensed)
          const rows = [...ph.months].reverse().slice(0, 12);
          return (
            <View style={S.section}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <Text style={S.sectionTitle}>Production Statement — Last 12 Months</Text>
                <View style={{ backgroundColor: ph.basis === "decline_model" ? "#dbeafe" : "#fef9c3", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 7, fontFamily: "Helvetica-Bold", color: ph.basis === "decline_model" ? "#1e40af" : "#854d0e" }}>{basisLabel.toUpperCase()}</Text>
                </View>
              </View>

              {/* Summary stats */}
              <View style={[S.grid2, { marginBottom: 6 }]}>
                <View style={S.gridCell}>
                  <Text style={S.gridCellLabel}>36-Mo Oil Production</Text>
                  <Text style={S.gridCellValue}>{fmtBbl(ph.total_oil_bbl)} BBL</Text>
                </View>
                {ph.total_gross_revenue != null && (
                  <View style={S.gridCell}>
                    <Text style={S.gridCellLabel}>36-Mo Gross Revenue</Text>
                    <Text style={S.gridCellValue}>{fmtUsd(ph.total_gross_revenue)}</Text>
                  </View>
                )}
                {ph.total_net_royalty != null && (
                  <View style={S.gridCell}>
                    <Text style={S.gridCellLabel}>36-Mo Net Royalty</Text>
                    <Text style={[S.gridCellValue, { color: C.green }]}>{fmtUsd(ph.total_net_royalty)}</Text>
                  </View>
                )}
                <View style={S.gridCell}>
                  <Text style={S.gridCellLabel}>Annual Decline Rate</Text>
                  <Text style={S.gridCellValue}>{(ph.annual_decline_rate * 100).toFixed(0)}%/yr</Text>
                </View>
              </View>

              {/* Table header */}
              <View style={{ flexDirection: "row", backgroundColor: C.lightBg, borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 3, paddingHorizontal: 4 }}>
                <Text style={{ flex: 2, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.gray }}>Month</Text>
                <Text style={{ flex: 1, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.gray, textAlign: "right" }}>BOPD</Text>
                <Text style={{ flex: 1.5, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.gray, textAlign: "right" }}>Oil (BBL)</Text>
                {showRev && <Text style={{ flex: 2, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.gray, textAlign: "right" }}>Gross Rev.</Text>}
                {showRoy && <Text style={{ flex: 2, fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.gray, textAlign: "right" }}>Net Royalty</Text>}
              </View>

              {/* Table rows */}
              {rows.map((row, idx) => (
                <View key={row.label} style={{ flexDirection: "row", backgroundColor: idx % 2 === 0 ? "#fff" : C.lightBg, paddingVertical: 2.5, paddingHorizontal: 4 }}>
                  <Text style={{ flex: 2, fontSize: 7.5, color: C.darkGray }}>{row.label}</Text>
                  <Text style={{ flex: 1, fontSize: 7.5, color: C.darkGray, textAlign: "right" }}>{row.bopd.toFixed(1)}</Text>
                  <Text style={{ flex: 1.5, fontSize: 7.5, color: C.darkGray, textAlign: "right" }}>{fmtBbl(row.oil_bbl)}</Text>
                  {showRev && <Text style={{ flex: 2, fontSize: 7.5, color: C.darkGray, textAlign: "right" }}>{fmtUsd(row.gross_revenue)}</Text>}
                  {showRoy && <Text style={{ flex: 2, fontSize: 7.5, color: C.green, textAlign: "right" }}>{fmtUsd(row.net_royalty)}</Text>}
                </View>
              ))}
              {rows.length < 36 && (
                <Text style={{ fontSize: 7, color: C.gray, marginTop: 3, fontFamily: "Helvetica-Oblique" }}>
                  Showing most recent 12 of 36 estimated months. Full history available in the web report.
                </Text>
              )}
              <Text style={[S.footerText, { marginTop: 4, color: C.gray }]}>{ph.note}</Text>
            </View>
          );
        })()}

        {/* ════════════════════════════════════════════════════════════════
            DEAL BRIEF
        ════════════════════════════════════════════════════════════════ */}
        {brief && (
          <View style={S.section}>
            <SectionHeader title="Deal Brief" />
            <Text style={S.narrative}>{brief.narrative}</Text>

            <View style={[S.alertBox, { backgroundColor: C.orangeBg, borderColor: C.orangeBorder }]}>
              <View>
                <Text style={[S.alertBoxLabel, { color: "#9a3412" }]}>Primary Risk</Text>
                <Text style={[S.alertBoxText, { color: C.orange }]}>{brief.primary_risk}</Text>
              </View>
            </View>

            <View style={[S.alertBox, { backgroundColor: C.greenBg, borderColor: C.greenBorder }]}>
              <View>
                <Text style={[S.alertBoxLabel, { color: "#14532d" }]}>What To Do</Text>
                <Text style={[S.alertBoxText, { color: C.green }]}>{brief.recommendation}</Text>
              </View>
            </View>

            {brief.lease_term_grades.length > 0 && (
              <View style={{ marginBottom: 6 }}>
                <Text style={[S.sectionTitle, { marginBottom: 5 }]}>Lease Term Grades</Text>
                {brief.lease_term_grades.map((g, i) => {
                  const gc = gradeColors(g.grade);
                  return (
                    <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4 }}>
                      {g.grade && (
                        <View style={[S.gradeBadge, { backgroundColor: gc.bg, borderWidth: 1, borderColor: gc.border }]}>
                          <Text style={{ fontSize: 8, fontFamily: "Helvetica-Bold", color: gc.text }}>{g.grade}</Text>
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.darkGray }}>
                          {g.term}{g.value ? ` · ${g.value}` : ""}
                        </Text>
                        <Text style={{ fontSize: 7.5, color: C.gray, marginTop: 1 }}>{g.note}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {brief.negotiation_flags.length > 0 && (
              <View>
                <Text style={[S.sectionTitle, { marginBottom: 4 }]}>Negotiation Flags</Text>
                {brief.negotiation_flags.map((flag, i) => (
                  <Bullet key={i} text={flag} />
                ))}
              </View>
            )}
          </View>
        )}

        {/* ════════════════════════════════════════════════════════════════
            VALUATION DETAIL
        ════════════════════════════════════════════════════════════════ */}
        <View style={S.section}>
          <SectionHeader title="Pre-Underwriting Valuation" />
          <View style={S.card}>
            <View style={S.cardBody}>
              <KV label="Deal Type"         value={cap(v.deal_type.replace(/_/g, " "))} />
              <KV label="Activity Level"    value={cap(v.activity_level)} />
              <KV label="Signal Confidence" value={cap(v.confidence)} />
              {v.point_estimate != null && (
                <KV label="Point Estimate"  value={usd(v.point_estimate)} bold />
              )}
              <KV label="Value Range"       value={usdRange(v.estimated_total_value_low, v.estimated_total_value_high)} bold />
              {v.value_per_acre_low != null && v.value_per_acre_high != null && (
                <KV label="Value / Acre"    value={usdRange(v.value_per_acre_low, v.value_per_acre_high)} />
              )}
              {v.summary && (
                <Text style={[S.narrative, { marginTop: 6, marginBottom: 0, fontFamily: "Helvetica-Oblique", color: C.midGray }]}>
                  {v.summary}
                </Text>
              )}
            </View>
          </View>

          {(v.reasoning?.length ?? 0) > 0 && (
            <View style={{ marginBottom: 6 }}>
              <Text style={[S.sectionTitle, { marginBottom: 4 }]}>Reasoning</Text>
              {v.reasoning!.map((r, i) => <Bullet key={i} text={r} />)}
            </View>
          )}
          {(v.risks?.length ?? 0) > 0 && (
            <View>
              <Text style={[S.sectionTitle, { marginBottom: 4 }]}>Risks & Limitations</Text>
              {v.risks!.map((r, i) => <Bullet key={i} text={r} muted />)}
            </View>
          )}
        </View>

        {/* ════════════════════════════════════════════════════════════════
            FOOTER
        ════════════════════════════════════════════════════════════════ */}
        <View style={S.footer} fixed>
          <Text style={S.footerText}>
            MineralFlow AI — Preliminary screen only. Not a title opinion, reserve report, or investment advice.
          </Text>
          <Text style={S.footerText}>Generated {now}</Text>
        </View>

      </Page>
    </Document>
  );
}
