/**
 * TRRC Public Records Due Diligence — PDF Report Builder
 *
 * Builds a multi-page PDF report using @react-pdf/renderer (server-side via renderToBuffer).
 * All rendering is done in an API route context — no client-side APIs used.
 */

import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type {
  TrrcDueDiligenceRun,
  TrrcFinding,
  AcquisitionScorecard,
  TrrcDDProductionRow,
  SourceCoverageStatus,
  FindingSeverity,
  AcquisitionRecommendation,
} from "./types";
import type { TrrcManifest } from "./manifest-builder";

// ─── Color palette ────────────────────────────────────────────────────────────

const C = {
  navy:         "#0F2A47",
  accent:       "#1E5FAD",
  accentLight:  "#DBEAFE",
  accentBorder: "#93C5FD",
  white:        "#FFFFFF",
  offWhite:     "#F8FAFC",
  lightGray:    "#F1F5F9",
  border:       "#E2E8F0",
  gray:         "#6B7280",
  midGray:      "#4B5563",
  darkGray:     "#374151",
  black:        "#0F172A",
  // Severity
  critical:     "#DC2626",
  criticalBg:   "#FEE2E2",
  criticalBorder:"#FCA5A5",
  high:         "#EA580C",
  highBg:       "#FFF7ED",
  highBorder:   "#FED7AA",
  medium:       "#CA8A04",
  mediumBg:     "#FEF9C3",
  mediumBorder: "#FDE047",
  low:          "#2563EB",
  lowBg:        "#DBEAFE",
  lowBorder:    "#93C5FD",
  info:         "#6B7280",
  infoBg:       "#F9FAFB",
  infoBorder:   "#E5E7EB",
  // Recommendation
  green:        "#166534",
  greenBg:      "#DCFCE7",
  greenBorder:  "#86EFAC",
  yellow:       "#713F12",
  yellowBg:     "#FEF3C7",
  yellowBorder: "#FDE68A",
  orange:       "#7C2D12",
  orangeBg:     "#FFEDD5",
  orangeBorder: "#FDBA74",
  red:          "#7F1D1D",
  redBg:        "#FEE2E2",
  redBorder:    "#FCA5A5",
  charcoal:     "#1F2937",
  charcoalBg:   "#F3F4F6",
  charcoalBorder:"#9CA3AF",
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 8.5,
    color: C.black,
    paddingTop: 0,
    paddingBottom: 44,
    paddingHorizontal: 0,
    lineHeight: 1.45,
    backgroundColor: C.white,
  },

  // ── Page header (appears on every page via `fixed`)
  pageHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: C.navy,
    paddingVertical: 8,
    paddingHorizontal: 36,
    marginBottom: 0,
  },
  pageHeaderLeft: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.white },
  pageHeaderRight: { fontSize: 7.5, color: "rgba(255,255,255,0.7)" },

  // ── Body content wrapper
  body: {
    paddingHorizontal: 36,
    paddingTop: 18,
  },

  // ── Cover page
  coverBackground: {
    backgroundColor: C.navy,
    paddingTop: 60,
    paddingBottom: 40,
    paddingHorizontal: 48,
    marginBottom: 30,
  },
  coverTitle: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    color: C.white,
    lineHeight: 1.3,
    marginBottom: 12,
    letterSpacing: -0.3,
  },
  coverSubtitle: {
    fontSize: 11,
    color: "rgba(255,255,255,0.8)",
    marginBottom: 6,
  },
  coverMeta: {
    fontSize: 8.5,
    color: "rgba(255,255,255,0.6)",
    marginBottom: 3,
    fontFamily: "Courier",
  },
  coverConfidential: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: "#F59E0B",
    letterSpacing: 1.5,
    marginTop: 20,
    textTransform: "uppercase",
  },
  coverDisclaimer: {
    fontSize: 7.5,
    color: C.midGray,
    lineHeight: 1.6,
    paddingHorizontal: 48,
  },
  coverDisclaimerTitle: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: C.darkGray,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  // ── Section
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: C.navy,
    flex: 1,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    paddingBottom: 5,
    borderBottomWidth: 1.5,
    borderBottomColor: C.accent,
  },

  // ── Recommendation box
  recBox: {
    borderRadius: 6,
    padding: "12 16",
    marginBottom: 12,
    borderWidth: 1.5,
  },
  recLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 4,
  },
  recVerdict: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    lineHeight: 1.1,
  },

  // ── Score bar
  scoreRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  scoreLabel: { fontSize: 8, color: C.midGray, width: 120, flexShrink: 0 },
  scoreTrack: { flex: 1, height: 8, backgroundColor: C.lightGray, borderRadius: 4 },
  scoreFill: { height: 8, borderRadius: 4 },
  scoreValue: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.darkGray, width: 36, textAlign: "right", flexShrink: 0 },

  // ── Table
  tableHeader: {
    flexDirection: "row",
    backgroundColor: C.navy,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  tableHeaderCell: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    color: C.white,
    letterSpacing: 0.3,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.lightGray,
  },
  tableRowAlt: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: C.offWhite,
    borderBottomWidth: 1,
    borderBottomColor: C.lightGray,
  },
  tableCell: { fontSize: 7.5, color: C.darkGray },
  tableCellMono: { fontSize: 7, fontFamily: "Courier", color: C.darkGray },

  // ── Key-value
  kvRow: { flexDirection: "row", marginBottom: 4 },
  kvLabel: { fontSize: 8, color: C.gray, width: 130, flexShrink: 0 },
  kvValue: { fontSize: 8.5, color: C.darkGray, flex: 1 },
  kvValueBold: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.black, flex: 1 },
  kvValueMono: { fontSize: 7.5, fontFamily: "Courier", color: C.darkGray, flex: 1 },

  // ── Cards
  card: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 5,
    backgroundColor: C.offWhite,
    marginBottom: 8,
    overflow: "hidden",
  },
  cardBody: { padding: "8 10" },

  // ── Findings
  findingRow: {
    borderRadius: 4,
    marginBottom: 6,
    padding: "7 10",
    borderWidth: 1,
  },
  findingTitle: { fontSize: 8.5, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  findingDesc: { fontSize: 8, lineHeight: 1.55, marginBottom: 4 },
  findingBadge: {
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
    marginRight: 6,
    flexShrink: 0,
  },
  findingBadgeRow: { flexDirection: "row", alignItems: "center", marginBottom: 5 },

  // ── Bullet
  bullet: { flexDirection: "row", marginBottom: 3 },
  bulletDot: { fontSize: 8, color: C.gray, width: 12, flexShrink: 0, marginTop: 0.5 },
  bulletText: { fontSize: 8, color: C.darkGray, flex: 1, lineHeight: 1.5 },

  // ── Status badge
  statusBadge: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
  },

  // ── Footer
  footer: {
    position: "absolute",
    bottom: 16,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 5,
  },
  footerText: { fontSize: 6.5, color: C.gray },

  // ── Note boxes
  noteBox: {
    backgroundColor: C.accentLight,
    borderLeftWidth: 3,
    borderLeftColor: C.accent,
    padding: "6 8",
    marginBottom: 8,
    borderRadius: 2,
  },
  noteText: { fontSize: 7.5, color: "#1E3A5F", lineHeight: 1.5 },

  // ── Group header
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.lightGray,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 5,
    borderRadius: 3,
  },
  groupHeaderText: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.darkGray, textTransform: "uppercase", letterSpacing: 0.5 },
});

// ─── Helper functions ─────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

function fmtMono(s: string | null | undefined): string {
  return s ?? "—";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return iso;
  }
}

function recPalette(rec: AcquisitionRecommendation) {
  switch (rec) {
    case "PURSUE":  return { bg: C.greenBg,    border: C.greenBorder,    text: C.green };
    case "REVIEW":  return { bg: C.yellowBg,   border: C.yellowBorder,   text: C.yellow };
    case "PASS":    return { bg: C.orangeBg,   border: C.orangeBorder,   text: C.orange };
    case "BLOCKED": return { bg: C.charcoalBg, border: C.charcoalBorder, text: C.charcoal };
  }
}

function severityPalette(s: FindingSeverity) {
  switch (s) {
    case "critical": return { bg: C.criticalBg, border: C.criticalBorder, text: C.critical };
    case "high":     return { bg: C.highBg,     border: C.highBorder,     text: C.high };
    case "medium":   return { bg: C.mediumBg,   border: C.mediumBorder,   text: C.medium };
    case "low":      return { bg: C.lowBg,      border: C.lowBorder,      text: C.low };
    case "info":     return { bg: C.infoBg,     border: C.infoBorder,     text: C.info };
  }
}

function coveragePalette(status: SourceCoverageStatus["status"]) {
  switch (status) {
    case "complete":           return { bg: C.greenBg,    border: C.greenBorder,    text: C.green };
    case "partial":            return { bg: C.yellowBg,   border: C.yellowBorder,   text: C.yellow };
    case "retrieval_failed":   return { bg: C.criticalBg, border: C.criticalBorder, text: C.critical };
    case "manual_required":    return { bg: C.charcoalBg, border: C.charcoalBorder, text: C.charcoal };
    case "no_applicable_record": return { bg: C.infoBg,  border: C.infoBorder,     text: C.info };
    case "not_checked":        return { bg: C.lightGray,  border: C.border,         text: C.gray };
  }
}

function coverageLabel(status: SourceCoverageStatus["status"]): string {
  switch (status) {
    case "complete":             return "COMPLETE";
    case "partial":              return "PARTIAL";
    case "retrieval_failed":     return "FAILED";
    case "manual_required":      return "MANUAL";
    case "no_applicable_record": return "N/A";
    case "not_checked":          return "NOT CHECKED";
  }
}

function scoreColor(score: number): string {
  if (score >= 75) return C.green;
  if (score >= 50) return C.accent;
  if (score >= 25) return C.medium;
  return C.critical;
}

const FULL_DISCLAIMER =
  "Mineral Flow AI compiles and analyzes publicly available regulatory information for preliminary " +
  "acquisition screening. This report is not a title opinion, reserve report, engineering certification, " +
  "environmental assessment, legal opinion, or substitute for independent land, legal, engineering, " +
  "environmental, tax, and regulatory due diligence. Public records may be incomplete, delayed, amended, " +
  "incorrectly indexed, or unavailable online.";

// ─── Sub-components ───────────────────────────────────────────────────────────

function PageHeader({ runId }: { runId: string }) {
  return React.createElement(
    View,
    { style: S.pageHeader, fixed: true },
    React.createElement(Text, { style: S.pageHeaderLeft }, "TRRC Due Diligence — Mineral Flow AI"),
    React.createElement(Text, { style: S.pageHeaderRight }, `Run ID: ${runId}`),
  );
}

function PageFooter({ generatedAt }: { generatedAt: string }) {
  return React.createElement(
    View,
    { style: S.footer, fixed: true },
    React.createElement(
      Text,
      { style: S.footerText },
      "CONFIDENTIAL — FOR INTERNAL USE ONLY · Mineral Flow AI · Not a title opinion or reserve report",
    ),
    React.createElement(
      Text,
      { style: [S.footerText, { fontFamily: "Helvetica-Bold" }] as Style[] },
      `Generated ${fmtDateShort(generatedAt)}`,
    ),
  );
}

function SectionHeader({ title }: { title: string }) {
  return React.createElement(
    View,
    { style: S.sectionHeader },
    React.createElement(Text, { style: S.sectionTitle }, title),
  );
}

function KV({ label, value, mono, bold }: { label: string; value: string; mono?: boolean; bold?: boolean }) {
  return React.createElement(
    View,
    { style: S.kvRow },
    React.createElement(Text, { style: S.kvLabel }, label),
    React.createElement(
      Text,
      { style: mono ? S.kvValueMono : bold ? S.kvValueBold : S.kvValue },
      value,
    ),
  );
}

function Bullet({ text }: { text: string }) {
  return React.createElement(
    View,
    { style: S.bullet },
    React.createElement(Text, { style: S.bulletDot }, "\u2022"),
    React.createElement(Text, { style: S.bulletText }, text),
  );
}

function ScoreBar({ label, score, color }: { label: string; score: number; color: string }) {
  const pct = Math.max(0, Math.min(100, score));
  return React.createElement(
    View,
    { style: S.scoreRow },
    React.createElement(Text, { style: S.scoreLabel }, label),
    React.createElement(
      View,
      { style: S.scoreTrack },
      React.createElement(View, {
        style: [S.scoreFill, { width: `${pct}%`, backgroundColor: color }] as Style[],
      }),
    ),
    React.createElement(Text, { style: S.scoreValue }, `${pct}`),
  );
}

function StatusBadge({ label, bg, border, text }: { label: string; bg: string; border: string; text: string }) {
  return React.createElement(
    Text,
    { style: [S.statusBadge, { backgroundColor: bg, borderColor: border, color: text }] as Style[] },
    label,
  );
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function CoverPage({
  run,
  generatedAt,
}: {
  run: TrrcDueDiligenceRun;
  generatedAt: string;
}) {
  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId: run.id }),

    // Navy cover block
    React.createElement(
      View,
      { style: S.coverBackground },
      React.createElement(
        Text,
        { style: S.coverTitle },
        "MINERAL FLOW AI\nTRRC PUBLIC RECORDS\nDUE DILIGENCE REPORT",
      ),
      React.createElement(Text, { style: S.coverSubtitle }, run.normalized_input),
      React.createElement(
        Text,
        { style: S.coverMeta },
        `Run ID: ${run.id}`,
      ),
      React.createElement(
        Text,
        { style: S.coverMeta },
        `Generated: ${fmtDate(generatedAt)}`,
      ),
      React.createElement(
        Text,
        { style: S.coverMeta },
        `Input Type: ${run.selected_input_type.replace(/_/g, " ").toUpperCase()}`,
      ),
      run.resolved_district
        ? React.createElement(Text, { style: S.coverMeta }, `District: ${run.resolved_district}`)
        : null,
      React.createElement(
        Text,
        { style: S.coverConfidential },
        "CONFIDENTIAL — FOR INTERNAL USE ONLY",
      ),
    ),

    // Disclaimer
    React.createElement(
      View,
      { style: S.coverDisclaimer },
      React.createElement(Text, { style: S.coverDisclaimerTitle }, "Important Disclaimer"),
      React.createElement(Text, { style: { fontSize: 7.5, color: C.midGray, lineHeight: 1.6 } }, FULL_DISCLAIMER),
    ),

    React.createElement(PageFooter, { generatedAt }),
  );
}

function ExecutiveSummaryPage({
  scorecard,
  generatedAt,
  runId,
}: {
  scorecard: AcquisitionScorecard;
  generatedAt: string;
  runId: string;
}) {
  const rp = recPalette(scorecard.recommendation);

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },

      // Section: Executive Summary
      React.createElement(SectionHeader, { title: "Executive Summary & Recommendation" }),

      // Recommendation box
      React.createElement(
        View,
        { style: [S.recBox, { backgroundColor: rp.bg, borderColor: rp.border }] as Style[] },
        React.createElement(Text, { style: [S.recLabel, { color: rp.text }] as Style[] }, "Recommendation"),
        React.createElement(Text, { style: [S.recVerdict, { color: rp.text }] as Style[] }, scorecard.recommendation),
      ),

      // Score bars
      React.createElement(
        View,
        { style: { marginBottom: 14 } },
        React.createElement(ScoreBar, {
          label: "Opportunity Score",
          score: scorecard.opportunity_score,
          color: scoreColor(scorecard.opportunity_score),
        }),
        React.createElement(ScoreBar, {
          label: "Risk Score (higher = more risk)",
          score: scorecard.risk_score,
          color: scorecard.risk_score > 60 ? C.critical : scorecard.risk_score > 40 ? C.medium : C.green,
        }),
        React.createElement(ScoreBar, {
          label: "Overall Confidence",
          score: scorecard.overall_confidence,
          color: scoreColor(scorecard.overall_confidence),
        }),
      ),

      // Gating conditions
      scorecard.gating_conditions.length > 0
        ? React.createElement(
            View,
            { style: { marginBottom: 12 } },
            React.createElement(
              View,
              { style: S.groupHeader },
              React.createElement(Text, { style: [S.groupHeaderText, { color: C.critical }] as Style[] }, "Gating Conditions — Must Resolve Before Proceeding"),
            ),
            ...scorecard.gating_conditions.map((c, i) =>
              React.createElement(Bullet, { key: String(i), text: c }),
            ),
          )
        : null,

      // Missing critical evidence
      scorecard.missing_critical_evidence.length > 0
        ? React.createElement(
            View,
            { style: { marginBottom: 12 } },
            React.createElement(
              View,
              { style: S.groupHeader },
              React.createElement(Text, { style: [S.groupHeaderText, { color: C.high }] as Style[] }, "Missing Critical Evidence"),
            ),
            ...scorecard.missing_critical_evidence.map((m, i) =>
              React.createElement(Bullet, { key: String(i), text: m }),
            ),
          )
        : null,

      // Reasons for/against
      React.createElement(
        View,
        { style: { flexDirection: "row", gap: 12 } },
        // Reasons FOR
        React.createElement(
          View,
          { style: { flex: 1 } },
          React.createElement(
            View,
            { style: [S.groupHeader, { backgroundColor: C.greenBg }] as Style[] },
            React.createElement(
              Text,
              { style: [S.groupHeaderText, { color: C.green }] as Style[] },
              "Top Reasons FOR",
            ),
          ),
          ...scorecard.reasons_for.slice(0, 3).map((r, i) =>
            React.createElement(Bullet, { key: String(i), text: r }),
          ),
          scorecard.reasons_for.length === 0
            ? React.createElement(Text, { style: { fontSize: 8, color: C.gray, fontFamily: "Helvetica-Oblique" } }, "None identified.")
            : null,
        ),
        // Reasons AGAINST
        React.createElement(
          View,
          { style: { flex: 1 } },
          React.createElement(
            View,
            { style: [S.groupHeader, { backgroundColor: C.redBg }] as Style[] },
            React.createElement(
              Text,
              { style: [S.groupHeaderText, { color: C.critical }] as Style[] },
              "Top Reasons AGAINST",
            ),
          ),
          ...scorecard.reasons_against.slice(0, 3).map((r, i) =>
            React.createElement(Bullet, { key: String(i), text: r }),
          ),
          scorecard.reasons_against.length === 0
            ? React.createElement(Text, { style: { fontSize: 8, color: C.gray, fontFamily: "Helvetica-Oblique" } }, "None identified.")
            : null,
        ),
      ),
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function AssetIdentityPage({
  run,
  generatedAt,
}: {
  run: TrrcDueDiligenceRun;
  generatedAt: string;
}) {
  const entity = run.entities?.find((e) => e.is_user_selected);

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId: run.id }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Asset Identity" }),

      React.createElement(
        View,
        { style: S.card },
        React.createElement(
          View,
          { style: S.cardBody },
          React.createElement(KV, { label: "Normalized Input", value: run.normalized_input }),
          React.createElement(KV, { label: "Input Type", value: run.selected_input_type.replace(/_/g, " ") }),
          React.createElement(KV, { label: "Original Input", value: run.original_input }),
          run.resolved_primary_api
            ? React.createElement(KV, { label: "Primary API Number", value: run.resolved_primary_api, mono: true })
            : null,
          run.resolved_lease_number
            ? React.createElement(KV, { label: "Lease Number", value: run.resolved_lease_number, mono: true })
            : null,
          run.resolved_gas_id
            ? React.createElement(KV, { label: "Gas Well ID", value: run.resolved_gas_id, mono: true })
            : null,
          run.resolved_district
            ? React.createElement(KV, { label: "TRRC District", value: run.resolved_district })
            : null,
          run.resolved_operator_number
            ? React.createElement(KV, { label: "Operator Number", value: run.resolved_operator_number, mono: true })
            : null,
        ),
      ),

      // Resolved entity details
      entity
        ? React.createElement(
            View,
            { style: { marginTop: 8 } },
            React.createElement(SectionHeader, { title: "Primary Resolved Entity" }),
            React.createElement(
              View,
              { style: S.card },
              React.createElement(
                View,
                { style: S.cardBody },
                React.createElement(KV, { label: "Display Name", value: entity.display_name, bold: true }),
                React.createElement(KV, { label: "Entity Type", value: entity.entity_type }),
                React.createElement(KV, { label: "Canonical ID", value: entity.canonical_identifier, mono: true }),
                React.createElement(KV, { label: "Resolution Method", value: entity.resolution_method }),
                React.createElement(KV, { label: "Confidence", value: `${(entity.confidence * 100).toFixed(0)}%` }),
              ),
            ),
          )
        : null,

      // All resolved entities
      (run.entities ?? []).length > 1
        ? React.createElement(
            View,
            { style: { marginTop: 8 } },
            React.createElement(SectionHeader, { title: "All Candidate Entities" }),
            React.createElement(
              View,
              { style: { borderWidth: 1, borderColor: C.border, borderRadius: 4, overflow: "hidden" } },
              React.createElement(
                View,
                { style: S.tableHeader },
                React.createElement(Text, { style: [S.tableHeaderCell, { flex: 2 }] as Style[] }, "Display Name"),
                React.createElement(Text, { style: [S.tableHeaderCell, { flex: 1 }] as Style[] }, "Type"),
                React.createElement(Text, { style: [S.tableHeaderCell, { flex: 2 }] as Style[] }, "Canonical ID"),
                React.createElement(Text, { style: [S.tableHeaderCell, { width: 50, textAlign: "right" }] as Style[] }, "Conf."),
              ),
              ...(run.entities ?? []).map((e, i) =>
                React.createElement(
                  View,
                  { key: e.id, style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
                  React.createElement(
                    Text,
                    { style: [S.tableCell, { flex: 2 }] as Style[] },
                    e.display_name + (e.is_user_selected ? " [SELECTED]" : ""),
                  ),
                  React.createElement(Text, { style: [S.tableCell, { flex: 1 }] as Style[] }, e.entity_type),
                  React.createElement(Text, { style: [S.tableCellMono, { flex: 2 }] as Style[] }, e.canonical_identifier),
                  React.createElement(Text, { style: [S.tableCell, { width: 50, textAlign: "right" }] as Style[] }, `${(e.confidence * 100).toFixed(0)}%`),
                ),
              ),
            ),
          )
        : null,
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function ScorecardPage({
  scorecard,
  generatedAt,
  runId,
}: {
  scorecard: AcquisitionScorecard;
  generatedAt: string;
  runId: string;
}) {
  const dims = [
    { key: "record_completeness",    label: "Record Completeness" },
    { key: "identity_confidence",    label: "Identity Confidence" },
    { key: "production_quality",     label: "Production Quality" },
    { key: "production_consistency", label: "Production Consistency" },
    { key: "mechanical_integrity",   label: "Mechanical Integrity" },
    { key: "plugging_exposure",      label: "Plugging Exposure" },
    { key: "regulatory_compliance",  label: "Regulatory Compliance" },
    { key: "operator_profile",       label: "Operator Profile" },
    { key: "development_activity",   label: "Development Activity" },
    { key: "data_confidence",        label: "Data Confidence" },
  ] as const;

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Acquisition Scorecard" }),

      React.createElement(
        View,
        { style: { borderWidth: 1, borderColor: C.border, borderRadius: 4, overflow: "hidden", marginBottom: 14 } },
        React.createElement(
          View,
          { style: S.tableHeader },
          React.createElement(Text, { style: [S.tableHeaderCell, { flex: 2 }] as Style[] }, "Dimension"),
          React.createElement(Text, { style: [S.tableHeaderCell, { width: 100 }] as Style[] }, "Score"),
          React.createElement(Text, { style: [S.tableHeaderCell, { width: 40, textAlign: "right" }] as Style[] }, "Wt."),
          React.createElement(Text, { style: [S.tableHeaderCell, { flex: 3 }] as Style[] }, "Rationale"),
        ),
        ...dims.map((d, i) => {
          const dim = scorecard.dimensions[d.key];
          const color = scoreColor(dim.score);
          const pct = Math.max(0, Math.min(100, dim.score));
          return React.createElement(
            View,
            { key: d.key, style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
            React.createElement(Text, { style: [S.tableCell, { flex: 2, fontFamily: "Helvetica-Bold" }] as Style[] }, d.label),
            React.createElement(
              View,
              { style: { width: 100, flexDirection: "row", alignItems: "center", gap: 5 } },
              React.createElement(
                View,
                { style: { flex: 1, height: 7, backgroundColor: C.lightGray, borderRadius: 3 } },
                React.createElement(View, {
                  style: [{ height: 7, borderRadius: 3, width: `${pct}%`, backgroundColor: color }] as Style[],
                }),
              ),
              React.createElement(
                Text,
                { style: [{ fontSize: 7.5, fontFamily: "Helvetica-Bold", color, width: 22, textAlign: "right", flexShrink: 0 }] as Style[] },
                String(dim.score),
              ),
            ),
            React.createElement(
              Text,
              { style: [S.tableCell, { width: 40, textAlign: "right" }] as Style[] },
              `${(dim.weight * 100).toFixed(0)}%`,
            ),
            React.createElement(
              Text,
              { style: [S.tableCell, { flex: 3 }] as Style[] },
              dim.rationale,
            ),
          );
        }),
      ),
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function ProductionPage({
  production,
  generatedAt,
  runId,
}: {
  production: TrrcDDProductionRow[];
  generatedAt: string;
  runId: string;
}) {
  // Sort by production_month desc, take last 24 months
  const sorted = [...production].sort((a, b) =>
    b.production_month.localeCompare(a.production_month),
  );
  const rows = sorted.slice(0, 24);

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Production Summary" }),

      React.createElement(
        View,
        { style: S.noteBox },
        React.createElement(
          Text,
          { style: S.noteText },
          "Production is reported at lease level. Multiple wells may share this lease. " +
            "canClaimSingleWellProduction is always false for lease-level sources.",
        ),
      ),

      production.length === 0
        ? React.createElement(
            Text,
            { style: { fontSize: 8.5, color: C.gray, fontFamily: "Helvetica-Oblique" } },
            "No production data was retrieved during this run.",
          )
        : React.createElement(
            View,
            { style: { borderWidth: 1, borderColor: C.border, borderRadius: 4, overflow: "hidden" } },
            React.createElement(
              View,
              { style: S.tableHeader },
              React.createElement(Text, { style: [S.tableHeaderCell, { width: 55 }] as Style[] }, "Month"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 1, textAlign: "right" }] as Style[] }, "Oil (bbl)"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 1, textAlign: "right" }] as Style[] }, "Casinghead Gas (MCF)"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 1, textAlign: "right" }] as Style[] }, "Gas (MCF)"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 1, textAlign: "right" }] as Style[] }, "Condensate (bbl)"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 1, textAlign: "right" }] as Style[] }, "Water (bbl)"),
            ),
            ...rows.map((row, i) =>
              React.createElement(
                View,
                { key: `${row.production_month}_${i}`, style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
                React.createElement(Text, { style: [S.tableCellMono, { width: 55 }] as Style[] }, row.production_month),
                React.createElement(Text, { style: [S.tableCell, { flex: 1, textAlign: "right" }] as Style[] }, fmt(row.oil_bbl)),
                React.createElement(Text, { style: [S.tableCell, { flex: 1, textAlign: "right" }] as Style[] }, fmt(row.casinghead_gas_mcf)),
                React.createElement(Text, { style: [S.tableCell, { flex: 1, textAlign: "right" }] as Style[] }, fmt(row.gas_mcf)),
                React.createElement(Text, { style: [S.tableCell, { flex: 1, textAlign: "right" }] as Style[] }, fmt(row.condensate_bbl)),
                React.createElement(Text, { style: [S.tableCell, { flex: 1, textAlign: "right" }] as Style[] }, fmt(row.water_bbl)),
              ),
            ),
          ),

      production.length > 24
        ? React.createElement(
            Text,
            { style: { fontSize: 7, color: C.gray, marginTop: 4, fontFamily: "Helvetica-Oblique" } },
            `Showing most recent 24 of ${production.length} records. Full dataset included in the ZIP archive.`,
          )
        : null,
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function FindingsPage({
  findings,
  generatedAt,
  runId,
}: {
  findings: TrrcFinding[];
  generatedAt: string;
  runId: string;
}) {
  const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

  const grouped = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    items: findings.filter((f) => f.severity === sev),
  })).filter((g) => g.items.length > 0);

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Findings" }),

      findings.length === 0
        ? React.createElement(
            Text,
            { style: { fontSize: 8.5, color: C.gray, fontFamily: "Helvetica-Oblique" } },
            "No findings were generated during this run.",
          )
        : grouped.map((group) => {
            const sp = severityPalette(group.severity);
            return React.createElement(
              View,
              { key: group.severity, style: { marginBottom: 10 } },
              React.createElement(
                View,
                { style: [S.groupHeader, { backgroundColor: sp.bg }] as Style[] },
                React.createElement(
                  Text,
                  { style: [S.groupHeaderText, { color: sp.text }] as Style[] },
                  `${group.severity.toUpperCase()} (${group.items.length})`,
                ),
              ),
              ...group.items.map((finding) =>
                React.createElement(
                  View,
                  {
                    key: finding.id,
                    style: [S.findingRow, { backgroundColor: sp.bg, borderColor: sp.border }] as Style[],
                  },
                  // Badge row
                  React.createElement(
                    View,
                    { style: S.findingBadgeRow },
                    React.createElement(
                      Text,
                      { style: [S.findingBadge, { backgroundColor: sp.bg, borderColor: sp.border, color: sp.text }] as Style[] },
                      group.severity.toUpperCase(),
                    ),
                    React.createElement(
                      Text,
                      {
                        style: [
                          S.findingBadge,
                          {
                            backgroundColor: finding.is_directly_reported ? C.greenBg : C.yellowBg,
                            borderColor: finding.is_directly_reported ? C.greenBorder : C.yellowBorder,
                            color: finding.is_directly_reported ? C.green : C.medium,
                          },
                        ] as Style[],
                      },
                      finding.is_directly_reported ? "DIRECTLY REPORTED" : "INFERRED",
                    ),
                    React.createElement(
                      Text,
                      { style: { fontSize: 7, color: C.gray, marginLeft: 4 } },
                      `Confidence: ${(finding.confidence * 100).toFixed(0)}%`,
                    ),
                  ),
                  // Title
                  React.createElement(
                    Text,
                    { style: [S.findingTitle, { color: sp.text }] as Style[] },
                    finding.title,
                  ),
                  // Description
                  React.createElement(
                    Text,
                    { style: [S.findingDesc, { color: sp.text }] as Style[] },
                    finding.description,
                  ),
                  // Evidence summary
                  Object.keys(finding.evidence).length > 0
                    ? React.createElement(
                        Text,
                        { style: [{ fontSize: 7, color: sp.text, opacity: 0.8, marginBottom: 3, fontFamily: "Helvetica-Oblique" }] as Style[] },
                        `Evidence: ${Object.entries(finding.evidence)
                          .slice(0, 3)
                          .map(([k, v]) => `${k}: ${String(v)}`)
                          .join(" · ")}`,
                      )
                    : null,
                  // Recommended action
                  React.createElement(
                    Text,
                    { style: [{ fontSize: 7.5, color: sp.text, fontFamily: "Helvetica-Bold" }] as Style[] },
                    `Action: ${finding.recommended_action}`,
                  ),
                ),
              ),
            );
          }),
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function SourceCoveragePage({
  coverage,
  generatedAt,
  runId,
}: {
  coverage: SourceCoverageStatus[];
  generatedAt: string;
  runId: string;
}) {
  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Source Coverage Matrix" }),

      coverage.length === 0
        ? React.createElement(
            Text,
            { style: { fontSize: 8.5, color: C.gray, fontFamily: "Helvetica-Oblique" } },
            "No coverage data available.",
          )
        : React.createElement(
            View,
            { style: { borderWidth: 1, borderColor: C.border, borderRadius: 4, overflow: "hidden" } },
            React.createElement(
              View,
              { style: S.tableHeader },
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 2 }] as Style[] }, "Category"),
              React.createElement(Text, { style: [S.tableHeaderCell, { width: 72 }] as Style[] }, "Status"),
              React.createElement(Text, { style: [S.tableHeaderCell, { width: 52, textAlign: "right" }] as Style[] }, "Records"),
              React.createElement(Text, { style: [S.tableHeaderCell, { width: 75 }] as Style[] }, "Current Through"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 2 }] as Style[] }, "Notes"),
            ),
            ...coverage.map((cov, i) => {
              const cp = coveragePalette(cov.status);
              return React.createElement(
                View,
                { key: cov.category, style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
                React.createElement(
                  Text,
                  { style: [S.tableCell, { flex: 2, fontFamily: "Helvetica-Bold" }] as Style[] },
                  cov.label,
                ),
                React.createElement(
                  View,
                  { style: { width: 72 } },
                  React.createElement(StatusBadge, {
                    label: coverageLabel(cov.status),
                    bg: cp.bg,
                    border: cp.border,
                    text: cp.text,
                  }),
                ),
                React.createElement(
                  Text,
                  { style: [S.tableCell, { width: 52, textAlign: "right" }] as Style[] },
                  String(cov.records_found),
                ),
                React.createElement(
                  Text,
                  { style: [S.tableCellMono, { width: 75 }] as Style[] },
                  cov.data_current_through ? cov.data_current_through.slice(0, 10) : "—",
                ),
                React.createElement(
                  Text,
                  { style: [S.tableCell, { flex: 2 }] as Style[] },
                  cov.notes ?? "",
                ),
              );
            }),
          ),
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function MissingRecordsPage({
  manifest,
  generatedAt,
  runId,
}: {
  manifest: TrrcManifest;
  generatedAt: string;
  runId: string;
}) {
  const missing = manifest.missing_items;

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Missing Records & Manual Follow-Up" }),

      React.createElement(
        View,
        { style: [S.noteBox, { backgroundColor: C.mediumBg, borderLeftColor: C.medium }] as Style[] },
        React.createElement(
          Text,
          { style: [S.noteText, { color: "#713F12" }] as Style[] },
          "The absence of a result from a query does not confirm the absence of a record. " +
            "TRRC records may be delayed, incorrectly indexed, or available only through manual retrieval.",
        ),
      ),

      missing.length === 0
        ? React.createElement(
            Text,
            { style: { fontSize: 8.5, color: C.gray, fontFamily: "Helvetica-Oblique" } },
            "No missing records identified.",
          )
        : React.createElement(
            View,
            { style: { borderWidth: 1, borderColor: C.border, borderRadius: 4, overflow: "hidden" } },
            React.createElement(
              View,
              { style: S.tableHeader },
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 2 }] as Style[] }, "Record Type"),
              React.createElement(Text, { style: [S.tableHeaderCell, { width: 80 }] as Style[] }, "Category"),
              React.createElement(Text, { style: [S.tableHeaderCell, { width: 80 }] as Style[] }, "Status"),
              React.createElement(Text, { style: [S.tableHeaderCell, { flex: 3 }] as Style[] }, "Recommended Action"),
            ),
            ...missing.map((item, i) =>
              React.createElement(
                View,
                { key: item.id, style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
                React.createElement(
                  Text,
                  { style: [S.tableCell, { flex: 2 }] as Style[] },
                  item.expected_record_type,
                ),
                React.createElement(
                  Text,
                  { style: [S.tableCell, { width: 80 }] as Style[] },
                  item.category,
                ),
                React.createElement(
                  Text,
                  { style: [S.tableCellMono, { width: 80 }] as Style[] },
                  item.status.replace(/_/g, " "),
                ),
                React.createElement(
                  Text,
                  { style: [S.tableCell, { flex: 3 }] as Style[] },
                  item.recommended_action,
                ),
              ),
            ),
          ),

      // Manual retrieval links
      manifest.manual_retrieval_required.length > 0
        ? React.createElement(
            View,
            { style: { marginTop: 14 } },
            React.createElement(SectionHeader, { title: "Manual Retrieval URLs" }),
            ...manifest.manual_retrieval_required.map((mr, i) =>
              React.createElement(
                View,
                {
                  key: `mr_${i}`,
                  style: {
                    borderWidth: 1,
                    borderColor: C.border,
                    borderRadius: 4,
                    padding: "6 8",
                    marginBottom: 5,
                    backgroundColor: C.offWhite,
                  },
                },
                React.createElement(
                  Text,
                  { style: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.darkGray, marginBottom: 2 } },
                  mr.source,
                ),
                React.createElement(
                  Text,
                  { style: { fontSize: 7, fontFamily: "Courier", color: C.accent, marginBottom: 3 } },
                  mr.url,
                ),
                React.createElement(Text, { style: { fontSize: 7.5, color: C.midGray } }, mr.description),
              ),
            ),
          )
        : null,
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

function MethodologyPage({
  manifest,
  generatedAt,
  runId,
}: {
  manifest: TrrcManifest;
  generatedAt: string;
  runId: string;
}) {
  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },
    React.createElement(PageHeader, { runId }),
    React.createElement(
      View,
      { style: S.body },
      React.createElement(SectionHeader, { title: "Methodology, Assumptions & Disclaimer" }),

      // Assumptions
      React.createElement(
        View,
        { style: { marginBottom: 14 } },
        React.createElement(
          View,
          { style: S.groupHeader },
          React.createElement(Text, { style: S.groupHeaderText }, "Analysis Assumptions"),
        ),
        ...manifest.report_assumptions.map((assumption, i) =>
          React.createElement(Bullet, { key: String(i), text: assumption }),
        ),
      ),

      // Source methodology
      React.createElement(
        View,
        { style: { marginBottom: 14 } },
        React.createElement(
          View,
          { style: S.groupHeader },
          React.createElement(Text, { style: S.groupHeaderText }, "Source Citation Methodology"),
        ),
        React.createElement(
          Bullet,
          { text: "All records are retrieved from publicly available TRRC (Texas Railroad Commission) sources." },
        ),
        React.createElement(
          Bullet,
          { text: "Source attempts are logged with HTTP status, retry count, and error messages for auditability." },
        ),
        React.createElement(
          Bullet,
          { text: "Production data is sourced from TRRC Production Data Query System (PDQ) and Oil and Gas Well Report datasets." },
        ),
        React.createElement(
          Bullet,
          { text: `Source registry version: ${manifest.source_registry_version}. App version: ${manifest.app_version}.` },
        ),
        React.createElement(
          Bullet,
          { text: `${manifest.source_attempts.length} source(s) were queried during this run.` },
        ),
      ),

      // Full disclaimer
      React.createElement(
        View,
        { style: { borderWidth: 1.5, borderColor: C.border, borderRadius: 5, padding: "10 12", backgroundColor: C.lightGray } },
        React.createElement(
          Text,
          { style: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.navy, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 } },
          "Full Disclaimer",
        ),
        React.createElement(
          Text,
          { style: { fontSize: 8, color: C.midGray, lineHeight: 1.7 } },
          manifest.disclaimer,
        ),
        React.createElement(
          Text,
          { style: { fontSize: 7.5, color: C.gray, marginTop: 8, fontFamily: "Helvetica-Oblique" } },
          "This report does not constitute and must not be relied upon as a title opinion, reserve report, " +
            "engineering certification, environmental assessment, or legal opinion. Independent land, legal, " +
            "engineering, environmental, tax, and regulatory due diligence is required before any acquisition decision.",
        ),
      ),
    ),
    React.createElement(PageFooter, { generatedAt }),
  );
}

// ─── Main document ────────────────────────────────────────────────────────────

function TrrcReportDocument({
  run,
  manifest,
  findings,
  scorecard,
  production,
  coverage,
  generatedAt,
}: {
  run: TrrcDueDiligenceRun;
  manifest: TrrcManifest;
  findings: TrrcFinding[];
  scorecard: AcquisitionScorecard;
  production: TrrcDDProductionRow[];
  coverage: SourceCoverageStatus[];
  generatedAt: string;
}) {
  return React.createElement(
    Document,
    {
      title: `Mineral Flow AI — TRRC DD — ${run.normalized_input}`,
      author: "Mineral Flow AI",
      subject: "TRRC Public Records Due Diligence Report",
      creator: "Mineral Flow AI",
    },
    // Page 1 — Cover
    React.createElement(CoverPage, { run, generatedAt }),
    // Page 2 — Executive Summary
    React.createElement(ExecutiveSummaryPage, { scorecard, generatedAt, runId: run.id }),
    // Page 3 — Asset Identity
    React.createElement(AssetIdentityPage, { run, generatedAt }),
    // Page 4 — Acquisition Scorecard
    React.createElement(ScorecardPage, { scorecard, generatedAt, runId: run.id }),
    // Page 5 — Production Summary
    React.createElement(ProductionPage, { production, generatedAt, runId: run.id }),
    // Page 6 — Findings
    React.createElement(FindingsPage, { findings, generatedAt, runId: run.id }),
    // Page 7 — Source Coverage Matrix
    React.createElement(SourceCoveragePage, { coverage, generatedAt, runId: run.id }),
    // Page 8 — Missing Records & Manual Follow-Up
    React.createElement(MissingRecordsPage, { manifest, generatedAt, runId: run.id }),
    // Page 9 — Methodology, Assumptions & Disclaimer
    React.createElement(MethodologyPage, { manifest, generatedAt, runId: run.id }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function buildTrrcPdfReport(
  run: TrrcDueDiligenceRun,
  manifest: TrrcManifest,
  findings: TrrcFinding[],
  scorecard: AcquisitionScorecard,
  production: TrrcDDProductionRow[],
  coverage: SourceCoverageStatus[],
): Promise<Buffer> {
  const generatedAt = new Date().toISOString();

  // Build the Document element directly so renderToBuffer receives ReactElement<DocumentProps>
  const doc = React.createElement(
    Document,
    {
      title: `Mineral Flow AI — TRRC DD — ${run.normalized_input}`,
      author: "Mineral Flow AI",
      subject: "TRRC Public Records Due Diligence Report",
      creator: "Mineral Flow AI",
    },
    React.createElement(CoverPage, { run, generatedAt }),
    React.createElement(ExecutiveSummaryPage, { scorecard, generatedAt, runId: run.id }),
    React.createElement(AssetIdentityPage, { run, generatedAt }),
    React.createElement(ScorecardPage, { scorecard, generatedAt, runId: run.id }),
    React.createElement(ProductionPage, { production, generatedAt, runId: run.id }),
    React.createElement(FindingsPage, { findings, generatedAt, runId: run.id }),
    React.createElement(SourceCoveragePage, { coverage, generatedAt, runId: run.id }),
    React.createElement(MissingRecordsPage, { manifest, generatedAt, runId: run.id }),
    React.createElement(MethodologyPage, { manifest, generatedAt, runId: run.id }),
  );

  return renderToBuffer(doc);
}
