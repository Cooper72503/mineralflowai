/**
 * TRRC Public Records Report Builder
 *
 * Simple, focused output:
 *   1. Cover page — identifiers used, date
 *   2. Records page(s) — every TRRC source queried, status, key data, direct link
 *
 * Nothing else.
 */

import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
  Link,
} from "@react-pdf/renderer";
import type {
  TrrcDueDiligenceRun,
  TrrcFinding,
  AcquisitionScorecard,
  TrrcDDProductionRow,
  SourceCoverageStatus,
} from "./types";
import type { TrrcManifest } from "./manifest-builder";

export type LiteSourceAttempt = {
  source_id: string;
  source_name: string;
  status: string;
  result_count: number;
  error_message: string | null;
  attempted_at: string;
  result_data_json: Record<string, unknown> | null;
};

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  navy:    "#0F2A47",
  accent:  "#1E5FAD",
  white:   "#FFFFFF",
  offWhite:"#F8FAFC",
  border:  "#E2E8F0",
  gray:    "#6B7280",
  dark:    "#1F2937",
  green:   "#166534",
  greenBg: "#DCFCE7",
  red:     "#991B1B",
  redBg:   "#FEE2E2",
  yellow:  "#92400E",
  yellowBg:"#FEF3C7",
  blueBg:  "#DBEAFE",
  blue:    "#1E40AF",
  link:    "#1E5FAD",
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.dark,
    backgroundColor: C.white,
    paddingHorizontal: 40,
    paddingTop: 36,
    paddingBottom: 48,
  },
  coverPage: {
    fontFamily: "Helvetica",
    backgroundColor: C.navy,
    paddingHorizontal: 50,
    paddingTop: 80,
    paddingBottom: 60,
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: C.border,
    paddingTop: 6,
  },
  footerText: {
    fontSize: 7,
    color: C.gray,
    fontFamily: "Helvetica",
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  // Source record card
  card: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    marginBottom: 8,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.offWhite,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  cardBody: {
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  badge: {
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  kvRow: {
    flexDirection: "row",
    marginBottom: 3,
  },
  kvLabel: {
    fontSize: 7.5,
    color: C.gray,
    fontFamily: "Helvetica",
    width: 110,
    flexShrink: 0,
  },
  kvValue: {
    fontSize: 7.5,
    color: C.dark,
    fontFamily: "Helvetica",
    flex: 1,
  },
  trrcLink: {
    fontSize: 7.5,
    color: C.link,
    fontFamily: "Helvetica",
    textDecoration: "underline",
  },
  // Table
  tableHeader: {
    flexDirection: "row",
    backgroundColor: C.navy,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  tableHeaderCell: {
    color: C.white,
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: C.border,
  },
  tableRowAlt: {
    flexDirection: "row",
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: C.border,
    backgroundColor: C.offWhite,
  },
  tableCell: {
    fontSize: 7,
    color: C.dark,
    fontFamily: "Helvetica",
  },
  tableCellMono: {
    fontSize: 7,
    color: C.dark,
    fontFamily: "Courier",
  },
});

// ─── Source labels ─────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  search_by_api:              "Wellbore Query (API Number)",
  search_by_lease:            "Wellbore Query (Lease Number)",
  search_by_operator:         "Operator / P5 Organization",
  search_by_legal_description:"Legal Description (GIS)",
  fetch_production:           "Production Data",
  fetch_completion_records:   "Completion Records (W-2)",
  fetch_well_status:          "Well Status",
  fetch_inactive_well_status: "Inactive Well Aging Report (IWAR)",
  fetch_orphan_well:          "Orphan Well Check",
  fetch_plugging_records:     "Plugging Records (W-3C)",
  fetch_p4_records:           "P-4 Production Test Records",
  fetch_proration:            "Proration Schedule / Daily Allowable",
  fetch_injection_records:    "UIC / Injection Well Records",
  fetch_severance_records:    "Wellbore Severance Records",
  fetch_compliance_violations:"Compliance Violations",
  fetch_imaged_records:       "Imaged Document Packets (CMPL)",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function badge(label: string, bg: string, color: string) {
  return React.createElement(
    Text,
    { style: [S.badge, { backgroundColor: bg, color }] },
    label,
  );
}

function kv(label: string, value: string) {
  return React.createElement(
    View,
    { style: S.kvRow },
    React.createElement(Text, { style: S.kvLabel }, label),
    React.createElement(Text, { style: S.kvValue }, value || "—"),
  );
}

function Footer({ generatedAt, runId }: { generatedAt: string; runId: string }) {
  const date = generatedAt.slice(0, 10);
  return React.createElement(
    View,
    { style: S.footer },
    React.createElement(Text, { style: S.footerText }, "CONFIDENTIAL — Mineral Flow AI — TRRC Public Records"),
    React.createElement(Text, { style: S.footerText }, `Run ${runId.slice(0, 8)} · ${date}`),
  );
}

// ─── Cover Page ───────────────────────────────────────────────────────────────

function CoverPage({ run, generatedAt }: { run: TrrcDueDiligenceRun; generatedAt: string }) {
  const date = new Date(generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return React.createElement(
    Page,
    { size: "LETTER", style: S.coverPage },

    // Title block
    React.createElement(
      View,
      { style: { marginBottom: 40 } },
      React.createElement(Text, {
        style: { fontSize: 10, color: "#94A3B8", fontFamily: "Helvetica-Bold", letterSpacing: 2, marginBottom: 16 },
      }, "MINERAL FLOW AI"),
      React.createElement(Text, {
        style: { fontSize: 28, color: C.white, fontFamily: "Helvetica-Bold", lineHeight: 1.25, marginBottom: 8 },
      }, "TRRC PUBLIC RECORDS"),
      React.createElement(Text, {
        style: { fontSize: 13, color: "#94A3B8", fontFamily: "Helvetica" },
      }, "Due Diligence Report"),
    ),

    // Identifiers used
    React.createElement(
      View,
      { style: { marginBottom: 36, paddingVertical: 16, paddingHorizontal: 20, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" } },
      run.resolved_primary_api ? React.createElement(
        View, { style: { marginBottom: 10 } },
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 } }, "API Number"),
        React.createElement(Text, { style: { fontSize: 14, color: C.white, fontFamily: "Helvetica-Bold" } }, run.resolved_primary_api),
      ) : null,
      run.resolved_lease_number ? React.createElement(
        View, { style: { marginBottom: 10 } },
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 } }, "Lease Number"),
        React.createElement(Text, { style: { fontSize: 14, color: C.white, fontFamily: "Helvetica-Bold" } }, run.resolved_lease_number),
      ) : null,
      React.createElement(
        View, {},
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 } }, "Original Input"),
        React.createElement(Text, { style: { fontSize: 11, color: "#CBD5E1", fontFamily: "Helvetica" } }, run.original_input),
      ),
    ),

    // Meta
    React.createElement(
      View,
      { style: { flexDirection: "row", gap: 24 } },
      React.createElement(
        View, {},
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "GENERATED"),
        React.createElement(Text, { style: { fontSize: 9, color: "#94A3B8", fontFamily: "Helvetica" } }, date),
      ),
      run.resolved_district ? React.createElement(
        View, {},
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "TRRC DISTRICT"),
        React.createElement(Text, { style: { fontSize: 9, color: "#94A3B8", fontFamily: "Helvetica" } }, run.resolved_district),
      ) : null,
    ),

    // Disclaimer
    React.createElement(
      View,
      { style: { position: "absolute", bottom: 32, left: 50, right: 50 } },
      React.createElement(Text, {
        style: { fontSize: 6.5, color: "#475569", fontFamily: "Helvetica", textAlign: "center", lineHeight: 1.6 },
      }, "This report compiles publicly available TRRC records for preliminary screening only. It is not a title opinion, reserve report, or legal due diligence. Records may be incomplete, delayed, or unavailable online."),
    ),
  );
}

// ─── Records Page ─────────────────────────────────────────────────────────────

function extractKeyFacts(data: Record<string, unknown>): Array<[string, string]> {
  const facts: Array<[string, string]> = [];

  // Common fields we want to surface
  const wanted: Array<[string, string]> = [
    ["api_number",       "API Number"],
    ["formatted_api",    "API (Formatted)"],
    ["uic_no_",          "UIC Permit #"],
    ["uic_no",           "UIC Permit #"],
    ["lease_no",         "Lease Number"],
    ["lease_no_",        "Lease Number"],
    ["operator",         "Operator"],
    ["operator_name",    "Operator Name"],
    ["operator_number",  "Operator #"],
    ["district",         "District"],
    ["county",           "County"],
    ["well_type",        "Well Type"],
    ["on_schedule",      "On Schedule"],
    ["is_inactive",      "Inactive"],
    ["is_orphan",        "Orphan Well"],
    ["count",            "Records Found"],
    ["inactive_record_count", "Inactive Records"],
    ["total_wellbores",  "Total Wellbores"],
    ["field",            "Field"],
    ["formation",        "Formation"],
  ];

  for (const [key, label] of wanted) {
    const val = data[key];
    if (val === undefined || val === null || val === "") continue;
    if (typeof val === "boolean") {
      facts.push([label, val ? "Yes" : "No"]);
    } else if (typeof val === "string" || typeof val === "number") {
      const s = String(val).trim();
      if (s) facts.push([label, s]);
    }
  }

  // Pull from nested records array if present
  const records = data["records"] as Record<string, unknown>[] | undefined;
  const wellbores = data["wellbores"] as Record<string, unknown>[] | undefined;
  const arr = records ?? wellbores;
  if (Array.isArray(arr) && arr.length > 0) {
    const first = arr[0];
    if (typeof first === "object" && first !== null) {
      for (const [key, label] of wanted) {
        if (facts.find(f => f[0] === label)) continue;
        const val = (first as Record<string, unknown>)[key];
        if (val !== undefined && val !== null && val !== "") {
          facts.push([label, String(val).trim()]);
        }
      }
    }
  }

  return facts.slice(0, 8);
}

function RecordCard({ attempt }: { attempt: LiteSourceAttempt }) {
  const label = SOURCE_LABELS[attempt.source_name] ?? attempt.source_name;
  const data = attempt.result_data_json ?? {};
  const url = typeof data["trrc_source_url"] === "string" ? data["trrc_source_url"] : null;
  const isError = attempt.status === "failed_transient" || attempt.status === "failed_permanent";
  const isManual = data["data_gap"] === true || data["endpoint_available"] === false;
  const notFound = data["found"] === false;
  const found = !isError && !isManual && !notFound;

  let statusBg: string;
  let statusColor: string;
  let statusLabel: string;

  if (isError) {
    statusBg = C.redBg; statusColor = C.red; statusLabel = "FAILED";
  } else if (isManual) {
    statusBg = C.yellowBg; statusColor = C.yellow; statusLabel = "MANUAL REQUIRED";
  } else if (notFound) {
    statusBg = C.offWhite; statusColor = C.gray; statusLabel = "NOT FOUND";
  } else {
    statusBg = C.greenBg; statusColor = C.green; statusLabel = "FOUND";
  }

  const facts = found ? extractKeyFacts(data) : [];
  const errorMsg = isError ? (attempt.error_message ?? "Query failed") : null;
  const manualMsg = isManual ? (typeof data["message"] === "string" ? (data["message"] as string).slice(0, 180) : "Manual retrieval required.") : null;

  return React.createElement(
    View,
    { style: S.card },

    // Card header
    React.createElement(
      View,
      { style: S.cardHeader },
      React.createElement(Text, { style: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: C.navy, flex: 1 } }, label),
      React.createElement(
        View,
        { style: { flexDirection: "row", alignItems: "center", gap: 8 } },
        badge(statusLabel, statusBg, statusColor),
        url ? React.createElement(
          Link,
          { src: url, style: S.trrcLink },
          "View on TRRC ↗",
        ) : null,
      ),
    ),

    // Card body
    React.createElement(
      View,
      { style: S.cardBody },
      errorMsg ? React.createElement(Text, { style: { fontSize: 7.5, color: C.red, fontFamily: "Helvetica" } }, errorMsg) : null,
      manualMsg ? React.createElement(Text, { style: { fontSize: 7.5, color: C.gray, fontFamily: "Helvetica-Oblique" } }, manualMsg) : null,
      notFound && !isManual ? React.createElement(Text, { style: { fontSize: 7.5, color: C.gray, fontFamily: "Helvetica-Oblique" } }, typeof data["message"] === "string" ? (data["message"] as string).slice(0, 160) : "No records found.") : null,
      facts.length > 0 ? React.createElement(
        View,
        {},
        ...facts.map(([lbl, val], i) =>
          React.createElement(
            View,
            { key: String(i), style: S.kvRow },
            React.createElement(Text, { style: S.kvLabel }, lbl),
            React.createElement(Text, { style: S.kvValue }, val),
          ),
        ),
      ) : null,
    ),
  );
}

function RecordsPage({
  attempts,
  run,
  generatedAt,
}: {
  attempts: LiteSourceAttempt[];
  run: TrrcDueDiligenceRun;
  generatedAt: string;
}) {
  const seen = new Set<string>();
  const unique = attempts.filter(a => {
    if (a.source_name === "submit_report") return false;
    if (seen.has(a.source_name)) return false;
    seen.add(a.source_name);
    return true;
  });

  const found    = unique.filter(a => a.status === "success" && (a.result_data_json?.["found"] !== false) && !a.result_data_json?.["data_gap"] && a.result_data_json?.["endpoint_available"] !== false);
  const notFound = unique.filter(a => a.status === "success" && (a.result_data_json?.["found"] === false || a.result_data_json?.["data_gap"] === true || a.result_data_json?.["endpoint_available"] === false));
  const failed   = unique.filter(a => a.status !== "success");

  const renderGroup = (title: string, items: LiteSourceAttempt[]) => {
    if (items.length === 0) return null;
    return React.createElement(
      View,
      { style: { marginBottom: 14 } },
      React.createElement(Text, { style: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.gray, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 } }, title),
      ...items.map(a => React.createElement(RecordCard, { key: a.source_id, attempt: a })),
    );
  };

  return React.createElement(
    Page,
    { size: "LETTER", style: S.page },

    // Page header
    React.createElement(
      View,
      { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica" } }, run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "TRRC Records"),

    renderGroup("Records Found", found),
    renderGroup("No Records / Manual Required", notFound),
    renderGroup("Query Failed", failed),

    unique.length === 0 ? React.createElement(
      Text,
      { style: { fontSize: 8.5, color: C.gray, fontFamily: "Helvetica-Oblique" } },
      "No source queries were recorded for this run.",
    ) : null,

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function buildTrrcPdfReport(
  run: TrrcDueDiligenceRun,
  _manifest: TrrcManifest,
  _findings: TrrcFinding[],
  _scorecard: AcquisitionScorecard,
  _production: TrrcDDProductionRow[],
  _coverage: SourceCoverageStatus[],
  sourceAttempts: LiteSourceAttempt[] = [],
): Promise<Buffer> {
  const generatedAt = new Date().toISOString();

  const doc = React.createElement(
    Document,
    {
      title: `Mineral Flow AI — TRRC Records — ${run.original_input}`,
      author: "Mineral Flow AI",
      subject: "TRRC Public Records",
      creator: "Mineral Flow AI",
    },
    React.createElement(CoverPage, { run, generatedAt }),
    React.createElement(RecordsPage, { attempts: sourceAttempts, run, generatedAt }),
  );

  const buffer = await renderToBuffer(doc);
  return Buffer.from(buffer);
}
