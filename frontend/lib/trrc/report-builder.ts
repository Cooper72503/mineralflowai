/**
 * TRRC Due Diligence Report Builder
 *
 * 11-section structured report:
 *   1. Executive Summary (well identity + critical/important flags)
 *   2. Operator Standing (P-5 registration, bond, compliance)
 *   3. Production History (monthly table + computed analytics + charts)
 *   4. Well Construction (W-2 completion data + W-1 permits + imaged docs)
 *   5. Compliance and Legal Status (violations, orphan, plugging)
 *   6. Legal Description and Location (GLO + GIS + Maps + offset wells + lateral path)
 *   7. Missing Documents and Gaps
 *   8. Timeline (dated regulatory events, chronological)
 *   9. Evidence Index (per-source query ledger)
 *  10. Acquisition Scorecard (transparent rule-based screening aid)
 *  11. Overall Assessment (data completeness, narrative)
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
  Svg,
  Line,
  Polyline,
  Image,
} from "@react-pdf/renderer";
import type {
  TrrcDueDiligenceRun,
  TrrcFinding,
  AcquisitionScorecard,
  TrrcDDProductionRow,
  SourceCoverageStatus,
} from "./types";
import type { TrrcManifest } from "./manifest-builder";
import { buildEvidenceIndex, type EvidenceIndexEntry } from "./evidence-index";
import { buildTimeline } from "./timeline-builder";
import { fetchStaticMapImage } from "./maps-builder";
import { fetchOffsetWells, type OffsetWell } from "./offset-wells";
import { fetchLateralPath, type LateralPath } from "./lateral-path";
import { buildAcquisitionScorecard } from "./scorecard-builder";

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
  navy:     "#0F2A47",
  accent:   "#1E5FAD",
  white:    "#FFFFFF",
  offWhite: "#F8FAFC",
  border:   "#E2E8F0",
  gray:     "#6B7280",
  lightGray:"#9CA3AF",
  dark:     "#1F2937",
  green:    "#166534",
  greenBg:  "#DCFCE7",
  red:      "#991B1B",
  redBg:    "#FEE2E2",
  yellow:   "#92400E",
  yellowBg: "#FEF3C7",
  blueBg:   "#DBEAFE",
  blue:     "#1E40AF",
  link:     "#1E5FAD",
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
  footerText: { fontSize: 7, color: C.gray, fontFamily: "Helvetica" },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    marginBottom: 8,
    paddingBottom: 5,
    borderBottomWidth: 1.5,
    borderBottomColor: C.navy,
    marginTop: 14,
  },
  subTitle: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: C.dark,
    marginBottom: 5,
    marginTop: 8,
  },
  kvRow: { flexDirection: "row", marginBottom: 4 },
  kvLabel: { fontSize: 8, color: C.gray, fontFamily: "Helvetica-Bold", width: 130, flexShrink: 0 },
  kvValue: { fontSize: 8, color: C.dark, fontFamily: "Helvetica", flex: 1 },
  badge: {
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  flagBox: {
    borderRadius: 4,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 5,
  },
  flagLabel: { fontSize: 7, fontFamily: "Helvetica-Bold", letterSpacing: 0.5, marginBottom: 3 },
  flagItem: { fontSize: 7.5, fontFamily: "Helvetica", marginBottom: 2 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: C.navy,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  tableHeaderCell: { color: C.white, fontFamily: "Helvetica-Bold", fontSize: 7 },
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
  tableCell:     { fontSize: 7, color: C.dark, fontFamily: "Helvetica" },
  tableCellMono: { fontSize: 7, color: C.dark, fontFamily: "Courier" },
  summaryStatBox: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    padding: 8,
    flex: 1,
    marginRight: 6,
  },
  noteText: { fontSize: 7.5, color: C.gray, fontFamily: "Helvetica-Oblique", marginBottom: 6 },
  bodyText: { fontSize: 8, color: C.dark, fontFamily: "Helvetica", lineHeight: 1.5, marginBottom: 6 },
  trrcLink: { fontSize: 7.5, color: C.link, fontFamily: "Helvetica", textDecoration: "underline" },
  divider: { borderBottomWidth: 0.5, borderBottomColor: C.border, marginVertical: 6 },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtMonth(iso: string): string {
  const [yr, mo] = iso.split("-");
  return `${MONTH_NAMES[(parseInt(mo ?? "1") - 1)] ?? mo} ${yr}`;
}

function fmtMonthShort(iso: string): string {
  const [yr, mo] = iso.split("-");
  const name = MONTH_NAMES[(parseInt(mo ?? "1") - 1)] ?? mo;
  return `${name.slice(0, 3)} '${(yr ?? "").slice(2)}`;
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "NO RPT";
  return v.toLocaleString("en-US");
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// ─── Production chart (hand-rolled SVG, one axis per chart) ─────────────────
//
// Oil (BBL) and gas (MCF) are different units on different scales — rendered
// as two separate single-axis charts rather than one dual-axis chart, since
// a shared axis would silently misrepresent one series' magnitude relative
// to the other. Null months render as a gap in the line, never as a false
// zero — a missing report is not the same claim as a reported zero.

function ProductionChart({ months, metricKey, title, unit, color }: {
  months: TrrcDDProductionRow[];
  metricKey: "oil_bbl" | "gas_mcf";
  title: string;
  unit: string;
  color: string;
}) {
  const width = 252, height = 92;
  const padLeft = 34, padRight = 6, padTop = 10, padBottom = 16;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const known = months
    .map(m => m[metricKey] as number | null)
    .filter((v): v is number => v !== null && v !== undefined);

  if (known.length === 0) {
    return React.createElement(
      View, { style: { width, marginRight: 8 } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.dark, marginBottom: 2 } }, `${title} (${unit})`),
      React.createElement(View, { style: { width, height, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.border } },
        React.createElement(Text, { style: { fontSize: 7, color: C.lightGray } }, "No data retrieved"),
      ),
    );
  }

  const maxV = Math.max(...known);
  const range = maxV || 1; // anchored at zero — production volumes are never negative
  const n = months.length;
  const xStep = n > 1 ? plotW / (n - 1) : 0;

  // Break the line at each null month instead of interpolating through it.
  const segments: string[] = [];
  let current: string[] = [];
  months.forEach((m, i) => {
    const v = m[metricKey] as number | null;
    if (v === null || v === undefined) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = padLeft + i * xStep;
    const y = padTop + plotH - (v / range) * plotH;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  const labelIdx = n <= 1 ? [0]
    : n <= 4 ? months.map((_, i) => i)
    : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];

  return React.createElement(
    View, { style: { width, marginRight: 8 } },
    React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.dark, marginBottom: 2 } }, `${title} (${unit})`),
    React.createElement(
      Svg, { width, height, viewBox: `0 0 ${width} ${height}` },
      React.createElement(Line, { x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + plotH, stroke: C.border, strokeWidth: 0.5 }),
      React.createElement(Line, { x1: padLeft, y1: padTop + plotH, x2: width - padRight, y2: padTop + plotH, stroke: C.border, strokeWidth: 0.5 }),
      React.createElement(Text, { x: 2, y: padTop + 4, style: { fontSize: 5.5, fill: C.lightGray } }, fmtNum(Math.round(maxV))),
      React.createElement(Text, { x: 2, y: padTop + plotH + 3, style: { fontSize: 5.5, fill: C.lightGray } }, "0"),
      ...segments.map((pts, i) => React.createElement(Polyline, {
        key: String(i), points: pts, fill: "none", stroke: color, strokeWidth: 1.5,
        strokeLinejoin: "round", strokeLinecap: "round",
      })),
      ...labelIdx.map(i => React.createElement(Text, {
        key: `lbl${i}`,
        x: Math.max(padLeft, Math.min(width - padRight - 16, padLeft + i * xStep - 8)),
        y: height - 4,
        style: { fontSize: 5.5, fill: C.lightGray },
      }, fmtMonthShort(months[i].production_month))),
    ),
  );
}

function kv(label: string, value: string | null | undefined, highlight?: "red" | "yellow") {
  const color = highlight === "red" ? C.red : highlight === "yellow" ? C.yellow : C.dark;
  return React.createElement(
    View, { style: S.kvRow },
    React.createElement(Text, { style: S.kvLabel }, label),
    React.createElement(Text, { style: [S.kvValue, { color }] }, value || "—"),
  );
}

function Footer({ generatedAt, runId }: { generatedAt: string; runId: string }) {
  return React.createElement(
    View, { style: S.footer },
    React.createElement(Text, { style: S.footerText }, "CONFIDENTIAL — Mineral Flow AI — TRRC Public Records"),
    React.createElement(Text, { style: S.footerText }, `Run ${runId.slice(0, 8)} · ${generatedAt.slice(0, 10)}`),
  );
}

function SectionTitle({ children }: { children: string }) {
  return React.createElement(Text, { style: S.sectionTitle }, children);
}

// ─── Data extraction ──────────────────────────────────────────────────────────

function getAttempt(attempts: LiteSourceAttempt[], ...names: string[]): Record<string, unknown> | null {
  for (const name of names) {
    const a = attempts.find(x => x.source_name === name && x.status === "success");
    if (a?.result_data_json) return a.result_data_json;
  }
  return null;
}

function getAttemptRaw(attempts: LiteSourceAttempt[], name: string): LiteSourceAttempt | null {
  return attempts.find(x => x.source_name === name) ?? null;
}

interface WellIdentity {
  wellName: string;
  operator: string;
  operatorNo: string;
  county: string;
  field: string;
  formation: string;
  wellType: string;
  district: string;
  apiNumber: string;
  leaseNumber: string;
  leaseNumbers: string[];
}

function extractIdentity(attempts: LiteSourceAttempt[], run: TrrcDueDiligenceRun): WellIdentity {
  const wb = getAttempt(attempts, "search_by_api", "search_by_lease");
  // searchWellbore()'s actual return shape (worker/src/tools/ewa.ts) puts
  // rows under the key "wells" — "wellbores"/"records" never matched
  // anything, which silently voided every field below that depended on
  // `first`, even though the real data was present one key over.
  const records = Array.isArray(wb?.["wells"])     ? (wb!["wells"]     as Record<string, unknown>[]) :
                  Array.isArray(wb?.["wellbores"]) ? (wb!["wellbores"] as Record<string, unknown>[]) :
                  Array.isArray(wb?.["records"])   ? (wb!["records"]   as Record<string, unknown>[]) : [];
  const first = records[0] ?? {};

  const leaseNumbers = records.map(r => str(r["lease_no"])).filter(Boolean);

  return {
    wellName:    str(first["lease_name"] ?? first["well_name"] ?? wb?.["well_name"]),
    operator:    str(first["operator_name"] ?? wb?.["operator_name"] ?? wb?.["operator"]),
    operatorNo:  str(first["operator_no"]   ?? wb?.["operator_no"]   ?? wb?.["operator_number"]),
    county:      str(first["county"]        ?? wb?.["county"]),
    field:       str(first["field_name"]    ?? first["field"]       ?? wb?.["field"]),
    formation:   str(first["formation"]     ?? wb?.["formation"]),
    wellType:    str(first["well_type"]     ?? wb?.["well_type"]),
    district:    str(first["dist_code"]     ?? first["district"]    ?? run.resolved_district ?? wb?.["district"]),
    apiNumber:   run.resolved_primary_api ?? str(run.original_input),
    leaseNumber: run.resolved_lease_number ?? leaseNumbers[0] ?? "",
    leaseNumbers,
  };
}

// ─── Production analytics ─────────────────────────────────────────────────────

export interface ProductionAnalytics {
  months: TrrcDDProductionRow[];
  recent12AvgOil: number | null;
  prior12AvgOil: number | null;
  yoyDeclineOil: number | null;
  recent12AvgGas: number | null;
  cumulativeOil: number | null;
  cumulativeGas: number | null;
  currentWOR: number | null;
  worTrend: "Stable" | "Rising" | "Declining" | "N/A";
  zeroMonths: number;
  declineFlagged: boolean;
}

export function computeProductionAnalytics(production: TrrcDDProductionRow[]): ProductionAnalytics {
  const sorted = [...production].sort((a, b) => a.production_month.localeCompare(b.production_month));

  const avg = (rows: TrrcDDProductionRow[], key: keyof TrrcDDProductionRow): number | null => {
    const vals = rows.map(r => r[key] as number | null).filter((v): v is number => v !== null && v !== undefined);
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const sum = (rows: TrrcDDProductionRow[], key: keyof TrrcDDProductionRow): number | null => {
    const vals = rows.map(r => r[key] as number | null).filter((v): v is number => v !== null && v !== undefined);
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0);
  };

  const recent = sorted.slice(-12);
  const prior  = sorted.slice(-24, -12);

  const recent12AvgOil = avg(recent, "oil_bbl");
  const prior12AvgOil  = avg(prior, "oil_bbl");
  const recent12AvgGas = avg(recent, "gas_mcf");

  let yoyDeclineOil: number | null = null;
  if (recent12AvgOil !== null && prior12AvgOil !== null && prior12AvgOil > 0) {
    yoyDeclineOil = ((prior12AvgOil - recent12AvgOil) / prior12AvgOil) * 100;
  }

  const cumulativeOil = sum(sorted, "oil_bbl");
  const cumulativeGas = sum(sorted, "gas_mcf");

  // WOR on last 3 months
  const last3 = sorted.slice(-3);
  const last3Oil   = sum(last3, "oil_bbl") ?? 0;
  const last3Water = sum(last3, "water_bbl") ?? 0;
  const currentWOR = last3Oil > 0 ? last3Water / last3Oil : null;

  // WOR trend: compare last 3 vs prior 3
  const prev3 = sorted.slice(-6, -3);
  const prev3Oil   = sum(prev3, "oil_bbl") ?? 0;
  const prev3Water = sum(prev3, "water_bbl") ?? 0;
  const prevWOR = prev3Oil > 0 ? prev3Water / prev3Oil : null;

  let worTrend: "Stable" | "Rising" | "Declining" | "N/A" = "N/A";
  if (currentWOR !== null && prevWOR !== null) {
    const delta = currentWOR - prevWOR;
    if (delta > 0.1) worTrend = "Rising";
    else if (delta < -0.1) worTrend = "Declining";
    else worTrend = "Stable";
  }

  const zeroMonths = sorted.filter(r => (r.oil_bbl ?? 0) === 0 && (r.gas_mcf ?? 0) === 0).length;
  const declineFlagged = yoyDeclineOil !== null && yoyDeclineOil > 30;

  return {
    months: sorted,
    recent12AvgOil,
    prior12AvgOil,
    yoyDeclineOil,
    recent12AvgGas,
    cumulativeOil,
    cumulativeGas,
    currentWOR,
    worTrend,
    zeroMonths,
    declineFlagged,
  };
}

// ─── Flag generation ──────────────────────────────────────────────────────────

export interface Flags {
  critical: string[];
  important: string[];
}

export function generateFlags(
  attempts: LiteSourceAttempt[],
  analytics: ProductionAnalytics,
  run: TrrcDueDiligenceRun,
): Flags {
  const critical: string[] = [];
  const important: string[] = [];

  // Well identity unverifiable — if the wellbore PDQ, GIS location database,
  // and CODA imaged documents all fail to positively confirm this asset
  // exists, it cannot be confirmed at all. "Positively confirm" must count
  // a FAILED lookup (TRRC error, unparseable response) the same as an
  // explicit "not found" — a failed query is not evidence of anything, and
  // treating it as neutral would let a report with real TRRC outages still
  // render as "no critical or important flags identified." Only a genuine
  // found:true (or CODA returning at least one document) counts as positive
  // confirmation; getAttempt() only returns success-status rows, so failures
  // must be read via getAttemptRaw() or they're invisible to this check.
  const notPositivelyConfirmed = (raw: LiteSourceAttempt | null): boolean => {
    if (!raw || raw.status !== "success") return true;
    const d = raw.result_data_json ?? {};
    if (d["found"] === true) return false;
    if (Array.isArray(d["documents"]) && (d["documents"] as unknown[]).length > 0) return false;
    return true;
  };
  const wellboreUnconfirmed = notPositivelyConfirmed(getAttemptRaw(attempts, "search_by_api"));
  const gisUnconfirmed = notPositivelyConfirmed(getAttemptRaw(attempts, "fetch_gis_plat"));
  const codaUnconfirmed = notPositivelyConfirmed(getAttemptRaw(attempts, "fetch_coda_records"));
  if (wellboreUnconfirmed && gisUnconfirmed && codaUnconfirmed) {
    critical.push(
      "WELL IDENTITY COULD NOT BE VERIFIED — this identifier was not positively confirmed in the TRRC " +
      "wellbore PDQ, GIS well-location database, or CODA imaged documents (either no record was found, or " +
      "the lookup failed). The asset may be misidentified, the API/lease number may be incorrect, or the " +
      "well may not exist as described. Do not proceed until the seller provides a verifiable identifier " +
      "and, if any lookups failed due to a TRRC outage, re-run this research once the source is restored.",
    );
  }

  // Orphan well
  const orphan = getAttempt(attempts, "fetch_orphan_well");
  if (orphan?.["is_orphan"] === true) {
    critical.push("ORPHAN WELL — operator has forfeited bond; no responsible party. Do not proceed without legal counsel.");
  }

  // P-5 status
  const p5 = getAttempt(attempts, "search_by_operator");
  const p5Record = (p5?.["record"] ?? {}) as Record<string, unknown>;
  const p5Status = str(p5?.["p5_status"] ?? p5Record["organization_status"]);
  if (p5Status && /inactive|revoked/i.test(p5Status)) {
    critical.push(`OPERATOR P-5 STATUS: ${p5Status.toUpperCase()} — operator may not be legally permitted to operate wells in Texas.`);
  }

  // Plugged well with no W-3C
  const wellStatus = getAttempt(attempts, "fetch_well_status");
  const statusStr = str(wellStatus?.["status"] ?? wellStatus?.["well_status"]);
  const plugging = getAttempt(attempts, "fetch_plugging_records");
  if (/plugged/i.test(statusStr) && plugging?.["found"] === false) {
    critical.push("WELL SHOWS PLUGGED STATUS but no W-3C plugging certificate found — possible abandonment without proper documentation.");
  }

  // >30% YoY production decline
  if (analytics.declineFlagged && analytics.yoyDeclineOil !== null) {
    critical.push(`PRODUCTION DECLINE ${analytics.yoyDeclineOil.toFixed(1)}% YoY (oil) — material finding. Verify whether shut-in or reporting gap.`);
  }

  // Bond adequacy
  const bondAmt = str(p5?.["bond_amount"] ?? p5Record["bond_amount"]);
  if (bondAmt && bondAmt !== "—") {
    const bondNum = parseFloat(bondAmt.replace(/[^0-9.]/g, ""));
    if (!isNaN(bondNum) && bondNum < 25000) {
      important.push(`OPERATOR BOND $${bondNum.toLocaleString()} — may be below statutory minimum for the number of wells operated.`);
    }
  }

  // Inactive well plugging deadline
  const inactive = getAttempt(attempts, "fetch_inactive_well_status");
  const inactiveRecords = Array.isArray(inactive?.["records"]) ? (inactive!["records"] as Record<string, unknown>[]) : [];
  for (const rec of inactiveRecords) {
    const deadline = str(rec["plugging_deadline_date"] ?? rec["deadline"]);
    if (deadline) {
      const deadlineDate = new Date(deadline);
      const monthsOut = (deadlineDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
      if (monthsOut <= 12) {
        important.push(`INACTIVE WELL — plugging deadline ${deadline} is within 12 months. Material liability.`);
      }
    }
  }

  // P-4 gatherer/purchaser — a lease with none on file cannot legally sell
  // or transport its production. Only flag on a genuine confirmed-empty
  // result (found:false, no error) — a retrieval failure or data_gap must
  // not be reported as "none on file", since that's a materially different
  // (and false) claim.
  const p4 = getAttempt(attempts, "fetch_p4_records");
  const p4Records = Array.isArray(p4?.["records"]) ? (p4!["records"] as Record<string, unknown>[]) : [];
  if (p4Records.length === 0 && p4?.["found"] === false && !p4?.["error"]) {
    important.push("NO P-4 GATHERER/PURCHASER ON FILE — production cannot legally be sold or transported from this lease without a registered gatherer/purchaser.");
  }

  // Open compliance violations
  const violations = getAttempt(attempts, "fetch_compliance_violations");
  const openCount = typeof violations?.["open_count"] === "number" ? violations["open_count"] as number : 0;
  if (openCount > 0) {
    important.push(`${openCount} OPEN COMPLIANCE VIOLATION(S) — unresolved violations are a material liability that transfers with the asset.`);
  }

  // Zero production months (within retrieved rows)
  if (analytics.zeroMonths > 3) {
    important.push(`${analytics.zeroMonths} MONTHS WITH ZERO PRODUCTION — may indicate shut-in periods or reporting gaps. Verify with operator.`);
  }

  // Production genuinely attempted (lease + district resolved, so the query
  // actually ran) but zero rows came back at all — a distinct, more severe
  // case than "some retrieved months show zero." Without this check, a
  // fully-resolved well with no production history on file renders as "no
  // critical or important flags identified," which is the opposite of the
  // truth: a mineral buyer has zero documented royalty income for the asset.
  //
  // This must NOT fire on a retrieval failure — confirmed live: TRRC's
  // productionQueryAction.do outage makes analytics.months.length === 0
  // for every well right now regardless of its real production history,
  // and reporting that as "zero reported production" would be a false,
  // materially misleading claim (the same retrieval-failure-vs-confirmed-
  // absence distinction already applied to the identity check above and
  // the P-4 gatherer/purchaser check below). Only fire when the production
  // query itself actually completed successfully.
  const productionAttempt = getAttemptRaw(attempts, "fetch_production");
  if (run.resolved_lease_number && run.resolved_district && analytics.months.length === 0) {
    if (productionAttempt?.status === "success") {
      critical.push(
        `ZERO REPORTED PRODUCTION — lease ${run.resolved_lease_number} (District ${run.resolved_district}) ` +
        "returned no production rows over the queryable history, despite the lease/district resolving " +
        "successfully. This means no royalty income stream is documented for this asset. Confirm whether " +
        "the well is long-idle, produced out, or reporting under a different lease ID before assigning value.",
      );
    } else if (productionAttempt && productionAttempt.status !== "success") {
      critical.push(
        `PRODUCTION HISTORY COULD NOT BE VERIFIED — lease ${run.resolved_lease_number} (District ${run.resolved_district}) ` +
        `production query failed (${productionAttempt.error_message ?? "unknown error"}), likely a TRRC-side outage. ` +
        "This is NOT evidence of zero production — it means production history is currently unverifiable. " +
        "Re-run this research once the source is restored before assigning value based on production.",
      );
    }
  }

  // WOR rising
  if (analytics.worTrend === "Rising") {
    important.push("RISING WATER-TO-OIL RATIO — indicator of reservoir depletion or water encroachment.");
  }

  return { critical, important };
}

// ─── Cover Page ───────────────────────────────────────────────────────────────

function CoverPage({ run, id: identity, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  generatedAt: string;
}) {
  const date = new Date(generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return React.createElement(
    Page, { size: "LETTER", style: S.coverPage },

    React.createElement(View, { style: { marginBottom: 40 } },
      React.createElement(Text, { style: { fontSize: 10, color: "#94A3B8", fontFamily: "Helvetica-Bold", letterSpacing: 2, marginBottom: 16 } }, "MINERAL FLOW AI"),
      React.createElement(Text, { style: { fontSize: 26, color: C.white, fontFamily: "Helvetica-Bold", lineHeight: 1.25, marginBottom: 6 } }, "TRRC DUE DILIGENCE REPORT"),
      React.createElement(Text, { style: { fontSize: 11, color: "#94A3B8", fontFamily: "Helvetica" } }, "Veteran-Grade Well Research"),
    ),

    React.createElement(View, { style: { marginBottom: 32, paddingVertical: 16, paddingHorizontal: 20, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" } },
      identity.wellName ? React.createElement(View, { style: { marginBottom: 8 } },
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "WELL NAME"),
        React.createElement(Text, { style: { fontSize: 13, color: C.white, fontFamily: "Helvetica-Bold" } }, identity.wellName),
      ) : null,
      React.createElement(View, { style: { marginBottom: 8 } },
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "API NUMBER"),
        React.createElement(Text, { style: { fontSize: 13, color: C.white, fontFamily: "Helvetica-Bold" } }, identity.apiNumber || run.original_input),
      ),
      identity.operator ? React.createElement(View, { style: { marginBottom: 8 } },
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "OPERATOR"),
        React.createElement(Text, { style: { fontSize: 11, color: "#CBD5E1", fontFamily: "Helvetica" } }, identity.operator),
      ) : null,
    ),

    React.createElement(View, { style: { flexDirection: "row", gap: 24, marginBottom: 20 } },
      React.createElement(View, {},
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "GENERATED"),
        React.createElement(Text, { style: { fontSize: 9, color: "#94A3B8", fontFamily: "Helvetica" } }, date),
      ),
      React.createElement(View, {},
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "PREPARED BY"),
        React.createElement(Text, { style: { fontSize: 9, color: "#94A3B8", fontFamily: "Helvetica" } }, "Mineral Flow AI"),
      ),
      identity.district ? React.createElement(View, {},
        React.createElement(Text, { style: { fontSize: 7, color: "#64748B", fontFamily: "Helvetica-Bold", letterSpacing: 1, marginBottom: 3 } }, "TRRC DISTRICT"),
        React.createElement(Text, { style: { fontSize: 9, color: "#94A3B8", fontFamily: "Helvetica" } }, identity.district),
      ) : null,
    ),

    React.createElement(View, { style: { position: "absolute", bottom: 32, left: 50, right: 50 } },
      React.createElement(Text, { style: { fontSize: 6.5, color: "#475569", fontFamily: "Helvetica", textAlign: "center", lineHeight: 1.6 } },
        "This report compiles publicly available TRRC records for preliminary screening only. It is not a title opinion, reserve report, or legal due diligence. Records may be incomplete, delayed, or unavailable online.",
      ),
    ),
  );
}

// ─── Section 1 — Executive Summary ───────────────────────────────────────────

function ExecutiveSummaryPage({ run, id: identity, flags, wellStatus, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  flags: Flags;
  wellStatus: string;
  generatedAt: string;
}) {
  const hasCritical = flags.critical.length > 0;
  const hasImportant = flags.important.length > 0;

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 1 — EXECUTIVE SUMMARY"),

    // Well identity block
    React.createElement(View, { style: { marginBottom: 12 } },
      kv("Well Name",       identity.wellName),
      kv("Operator",        identity.operator),
      kv("County",          identity.county),
      kv("Field",           identity.field),
      kv("Formation",       identity.formation),
      kv("Well Type",       identity.wellType),
      kv("Current Status",  wellStatus || "—", /shut.in|inactive|plugged|abandon/i.test(wellStatus) ? "yellow" : undefined),
      kv("RRC District",    identity.district),
      kv("API Number",      identity.apiNumber),
      kv("Lease Number(s)", identity.leaseNumbers.join(", ") || identity.leaseNumber),
    ),

    // Critical flags
    hasCritical ? React.createElement(View, { style: [S.flagBox, { backgroundColor: C.redBg, marginBottom: 8 }] },
      React.createElement(Text, { style: [S.flagLabel, { color: C.red }] }, `⚠ CRITICAL FLAGS (${flags.critical.length})`),
      ...flags.critical.map((f, i) => React.createElement(Text, { key: String(i), style: [S.flagItem, { color: C.red }] }, `• ${f}`)),
    ) : null,

    // Important flags
    hasImportant ? React.createElement(View, { style: [S.flagBox, { backgroundColor: C.yellowBg }] },
      React.createElement(Text, { style: [S.flagLabel, { color: C.yellow }] }, `⚠ IMPORTANT FLAGS (${flags.important.length})`),
      ...flags.important.map((f, i) => React.createElement(Text, { key: String(i), style: [S.flagItem, { color: C.yellow }] }, `• ${f}`)),
    ) : null,

    !hasCritical && !hasImportant ? React.createElement(View, { style: [S.flagBox, { backgroundColor: C.greenBg }] },
      React.createElement(Text, { style: [S.flagItem, { color: C.green }] }, "✓ No critical or important flags identified based on available TRRC records."),
    ) : null,

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 2 — Operator Standing ───────────────────────────────────────────

function OperatorStandingPage({ run, id: identity, attempts, flags, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  flags: Flags;
  generatedAt: string;
}) {
  const p5 = getAttempt(attempts, "search_by_operator");
  const p5Record = (p5?.["record"] ?? {}) as Record<string, unknown>;

  const violations = getAttempt(attempts, "fetch_compliance_violations");
  const openCount = typeof violations?.["open_count"] === "number" ? violations["open_count"] as number : null;
  // getComplianceViolations() (worker/src/tools/browser.ts) returns
  // total_count, not violation_count — the old key here always missed,
  // so "Total Violations" showed "—" even when the count was known. There
  // is also no trrc_source_url on that return shape (only p5's does), so
  // the "View ICE Portal" link never had anywhere real to point.
  const totalCount = typeof violations?.["total_count"] === "number" ? violations["total_count"] as number : null;
  const violList = Array.isArray(violations?.["violations"]) ? (violations!["violations"] as Record<string, string>[]) : [];
  const p5Url = typeof p5?.["trrc_source_url"] === "string" ? p5["trrc_source_url"] as string : null;

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 2 — OPERATOR STANDING"),

    React.createElement(Text, { style: S.subTitle }, "P-5 Operator Registration"),
    p5 ? React.createElement(View, { style: { marginBottom: 10 } },
      kv("Operator Name",     str(p5Record["operator_name"] ?? identity.operator)),
      kv("Operator Number",   str(p5Record["operator_number"] ?? identity.operatorNo)),
      kv("P-5 Status",        str(p5?.["p5_status"] ?? p5Record["organization_status"]), /inactive|revoked/i.test(str(p5?.["p5_status"] ?? p5Record["organization_status"])) ? "red" : undefined),
      kv("Organization Type", str(p5Record["organization_type"])),
      kv("Bond Amount on File", str(p5?.["bond_amount"] ?? p5Record["bond_amount"])),
      kv("Registered Agent",  str(p5Record["agent_name"])),
      kv("Mailing Address",   str(p5Record["mailing_address"])),
      p5Url ? React.createElement(View, { style: S.kvRow },
        React.createElement(Text, { style: S.kvLabel }, "TRRC Source"),
        React.createElement(Link, { src: p5Url, style: S.trrcLink }, "View P-5 Record ↗"),
      ) : null,
    ) : React.createElement(Text, { style: S.noteText }, "P-5 registration data not retrieved."),

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "Compliance Violation History"),
    violations ? React.createElement(View, { style: { marginBottom: 10 } },
      kv("Total Violations",  totalCount !== null ? String(totalCount) : "—"),
      kv("Open (Unresolved)", openCount !== null ? String(openCount) : "—", openCount && openCount > 0 ? "red" : undefined),
      kv("Searched By",       violations["searched_by"] === "operator_number" ? "Operator Number" : violations["searched_by"] === "api_number" ? "API Number" : "—"),
    ) : React.createElement(Text, { style: S.noteText }, "Compliance violation data not retrieved."),

    // Violation table (first 10)
    violList.length > 0 ? React.createElement(View, { style: { marginTop: 6 } },
      React.createElement(Text, { style: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: C.dark, marginBottom: 4 } }, `Violation Detail (${Math.min(violList.length, 10)} of ${totalCount ?? violList.length})`),
      React.createElement(View, { style: S.tableHeader },
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "16%" }] }, "Date"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "22%" }] }, "Rule Violated"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "12%" }] }, "Major"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "22%" }] }, "Last Action"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "28%" }] }, "Compliant"),
      ),
      ...violList.slice(0, 10).map((v, i) => React.createElement(
        View, { key: String(i), style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
        React.createElement(Text, { style: [S.tableCellMono, { width: "16%" }] }, v["violation_discovery_date"] ?? ""),
        React.createElement(Text, { style: [S.tableCell, { width: "22%" }] }, v["violated_rule_description"]?.slice(0, 30) ?? v["violated_rule"] ?? ""),
        React.createElement(Text, { style: [S.tableCell, { width: "12%" }] }, v["major_violation"] ?? ""),
        React.createElement(Text, { style: [S.tableCell, { width: "22%" }] }, v["last_enforcement_action"] ?? ""),
        React.createElement(Text, { style: [S.tableCell, { width: "28%" }] }, v["compliant_on_reinspection"] === "Y" ? "Yes" : v["compliant_on_reinspection"] === "N" ? "No (OPEN)" : "—"),
      )),
    ) : null,

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 3 — Production History ──────────────────────────────────────────

function ProductionPage({ run, id: identity, analytics, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  analytics: ProductionAnalytics;
  generatedAt: string;
}) {
  const { months, recent12AvgOil, prior12AvgOil, yoyDeclineOil, recent12AvgGas, cumulativeOil, cumulativeGas, currentWOR, worTrend, zeroMonths, declineFlagged } = analytics;

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 3 — PRODUCTION HISTORY"),

    // Analytics summary
    React.createElement(View, { style: { flexDirection: "row", marginBottom: 10 } },
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "12-MO AVG OIL"),
        React.createElement(Text, { style: { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.navy } }, recent12AvgOil !== null ? `${recent12AvgOil.toFixed(0)} BBL/mo` : "—"),
      ),
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "12-MO AVG GAS"),
        React.createElement(Text, { style: { fontSize: 11, fontFamily: "Helvetica-Bold", color: C.navy } }, recent12AvgGas !== null ? `${recent12AvgGas.toFixed(0)} MCF/mo` : "—"),
      ),
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "YOY DECLINE (OIL)"),
        React.createElement(Text, { style: { fontSize: 11, fontFamily: "Helvetica-Bold", color: declineFlagged ? C.red : C.navy } },
          // Standard PDF core fonts (Helvetica) don't reliably render Unicode
          // arrow glyphs (▼/▲) — they render as a missing/fallback glyph that
          // overlaps the adjacent digit. Plain +/- reads just as clearly.
          yoyDeclineOil !== null ? `${yoyDeclineOil > 0 ? "-" : "+"}${Math.abs(yoyDeclineOil).toFixed(1)}%` : "—",
        ),
      ),
      React.createElement(View, { style: [S.summaryStatBox, { marginRight: 0 }] },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "WOR TREND"),
        React.createElement(Text, { style: { fontSize: 11, fontFamily: "Helvetica-Bold", color: worTrend === "Rising" ? C.red : C.navy } }, worTrend),
      ),
    ),

    months.length > 0 ? React.createElement(View, { style: { flexDirection: "row", marginBottom: 12 } },
      React.createElement(ProductionChart, { months, metricKey: "oil_bbl", title: "Oil Production", unit: "BBL/mo", color: C.accent }),
      React.createElement(ProductionChart, { months, metricKey: "gas_mcf", title: "Gas Production", unit: "MCF/mo", color: C.navy }),
    ) : null,

    React.createElement(View, { style: { marginBottom: 8 } },
      kv("Prior 12-Mo Avg Oil",       prior12AvgOil !== null ? `${prior12AvgOil.toFixed(0)} BBL/mo` : "—"),
      kv("Cumulative Oil Production",  cumulativeOil !== null ? `${cumulativeOil.toLocaleString("en-US")} BBL` : "—"),
      kv("Cumulative Gas Production",  cumulativeGas !== null ? `${cumulativeGas.toLocaleString("en-US")} MCF` : "—"),
      kv("Current Water-to-Oil Ratio", currentWOR !== null ? currentWOR.toFixed(2) : "—"),
      kv("Zero-Production Months",     String(zeroMonths), zeroMonths > 3 ? "yellow" : undefined),
      kv("Months of History",          String(months.length)),
    ),

    declineFlagged ? React.createElement(View, { style: [S.flagBox, { backgroundColor: C.redBg, marginBottom: 8 }] },
      React.createElement(Text, { style: [S.flagItem, { color: C.red }] }, `⚠ Production decline greater than 30% year-over-year is a material finding. Months with zero reported production should be explained — verify with operator whether well was shut in or reporting gap.`),
    ) : null,

    // Monthly table
    React.createElement(Text, { style: S.noteText }, `${months.length} month(s) retrieved from TRRC. Lease-level data — single-well attribution requires per-well allocation. "NO RPT" = no production reported.`),

    months.length > 0 ? React.createElement(View, {},
      React.createElement(View, { style: S.tableHeader },
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "15%" }] }, "Month"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "17%", textAlign: "right" }] }, "Oil (BBL)"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "17%", textAlign: "right" }] }, "Gas (MCF)"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "17%", textAlign: "right" }] }, "Casinghead"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "17%", textAlign: "right" }] }, "Condensate"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "17%", textAlign: "right" }] }, "Water (BBL)"),
      ),
      ...months.map((row, i) => React.createElement(
        View, { key: String(i), style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
        React.createElement(Text, { style: [S.tableCellMono, { width: "15%" }] }, fmtMonth(row.production_month)),
        React.createElement(Text, { style: [S.tableCell, { width: "17%", textAlign: "right" }] }, fmtNum(row.oil_bbl)),
        React.createElement(Text, { style: [S.tableCell, { width: "17%", textAlign: "right" }] }, fmtNum(row.gas_mcf)),
        React.createElement(Text, { style: [S.tableCell, { width: "17%", textAlign: "right" }] }, fmtNum(row.casinghead_gas_mcf)),
        React.createElement(Text, { style: [S.tableCell, { width: "17%", textAlign: "right" }] }, fmtNum(row.condensate_bbl)),
        React.createElement(Text, { style: [S.tableCell, { width: "17%", textAlign: "right" }] }, fmtNum(row.water_bbl)),
      )),
    ) : React.createElement(Text, { style: S.noteText }, "No production records retrieved."),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 4 — Well Construction ───────────────────────────────────────────

function WellConstructionPage({ run, id: identity, attempts, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  generatedAt: string;
}) {
  const comp    = getAttempt(attempts, "fetch_completion_records");
  const imaged  = getAttempt(attempts, "fetch_coda_records");
  const p4      = getAttempt(attempts, "fetch_p4_records");
  const permits = getAttempt(attempts, "fetch_drilling_permits");
  const p4Records = Array.isArray(p4?.["records"]) ? (p4!["records"] as Record<string, unknown>[]) : [];
  const permitRecords = Array.isArray(permits?.["permits"]) ? (permits!["permits"] as Record<string, unknown>[]) : [];
  const latestPermit = permitRecords[permitRecords.length - 1];
  // getCompletionRecords() (worker/src/tools/ewa.ts) returns {found, records:
  // [...], message} — completionQueryAction.do's own table.header, dynamically
  // key-cased. This report previously read completion_date/producing_formation/
  // etc. straight off the top-level `comp` object (which only ever has found/
  // records/message), the same class of bug fixed on the Severance section
  // above: every field here rendered blank regardless of what was retrieved.
  // completionQueryAction.do has been down (HTTP 500) for this session's
  // entire duration, so the exact real column names below are carried over
  // unverified from the pre-existing guess, not confirmed against a live
  // response — re-check against real data once TRRC's endpoint recovers.
  // There is also no trrc_source_url in that return shape, so the "View W-2
  // Record" link (which never had real data to point to) is removed rather
  // than kept pointing at a field that was never populated.
  const compRecord = Array.isArray(comp?.["records"]) ? (comp!["records"] as Record<string, unknown>[])[0] : undefined;
  const imagedUrl = typeof imaged?.["coda_search_url"] === "string" ? imaged["coda_search_url"] as string : null;

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 4 — WELL CONSTRUCTION"),

    React.createElement(Text, { style: S.subTitle }, "W-2 Completion Record (EWA Structured Data)"),
    compRecord ? React.createElement(View, { style: { marginBottom: 10 } },
      kv("Completion Date",        str(compRecord["completion_date"])),
      kv("Producing Formation",    str(compRecord["producing_formation"])),
      kv("Producing Interval",     str(compRecord["producing_interval"] ?? compRecord["depth_interval"])),
      kv("Perforation Intervals",  str(compRecord["perforations"] ?? compRecord["perforation_intervals"])),
      kv("Stimulation Method",     str(compRecord["stimulation_method"])),
      kv("Fracture Fluid Volume",  str(compRecord["fracture_fluid_volume"])),
      kv("Proppant Type",          str(compRecord["proppant_type"])),
      kv("Surface Casing",         str(compRecord["surface_casing"])),
      kv("Production Casing",      str(compRecord["production_casing"])),
      kv("Tubing",                 str(compRecord["tubing"])),
    ) : comp?.["found"] === false
      ? React.createElement(Text, { style: S.noteText }, "No W-2 completion record on file.")
      : React.createElement(Text, { style: S.noteText }, "W-2 completion record not retrieved — manual lookup required."),

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "P-4 Gatherer/Purchaser (Certificate of Compliance)"),
    p4Records.length > 0 ? React.createElement(View, { style: { marginBottom: 10 } },
      ...p4Records.slice(0, 5).map((r, i) => React.createElement(View, { key: i, style: { marginBottom: 4 } },
        kv("Gatherer/Purchaser", str(r["gatherer_purchaser_name"] ?? r["name"])),
        kv("Type",               str(r["type"] ?? r["gatherer_purchaser_type"])),
        kv("Product",            str(r["product"])),
        kv("Oil/Gas",            str(r["oil_gas"])),
        kv("Field",              str(r["field_name"])),
      )),
    ) : React.createElement(Text, { style: S.noteText }, p4?.["found"] === false ? "No P-4 gatherer/purchaser on file — production cannot legally be sold or transported from this lease." : "P-4 gatherer/purchaser records not retrieved."),

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "Drilling Permit (W-1) Records"),
    permitRecords.length > 0 ? React.createElement(View, { style: { marginBottom: 10 } },
      kv("Filing Purpose",   str(latestPermit?.["filing_purpose"])),
      kv("Status",           str(latestPermit?.["status"])),
      kv("Status Date",      str(latestPermit?.["status_date"])),
      kv("Wellbore Profile", str(latestPermit?.["wellbore_profiles"])),
      kv("Total Depth",      str(latestPermit?.["total_depth"])),
      kv("Amended",          str(latestPermit?.["amend"]) === "Y" ? `Yes (${permitRecords.length} filing${permitRecords.length === 1 ? "" : "s"} on record)` : "No"),
    ) : React.createElement(Text, { style: S.noteText }, permits?.["found"] === false ? "No drilling permit (W-1) on record for this API." : "Drilling permit records not retrieved."),

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "Imaged Documents (CODA)"),
    imaged ? React.createElement(View, { style: { marginBottom: 8 } },
      kv("CODA Status",     str(imaged["message"]).slice(0, 80) || "Manual retrieval required"),
      imagedUrl ? React.createElement(View, { style: S.kvRow },
        React.createElement(Text, { style: S.kvLabel }, "TRRC CODA"),
        React.createElement(Link, { src: imagedUrl, style: S.trrcLink }, "Search Imaged Records ↗"),
      ) : null,
      React.createElement(Text, { style: [S.noteText, { marginTop: 4 }] }, "Document types to retrieve: W-2 (original completion), G-1 (gas completion), W-3C (plugging certificate), H-15 (well history), Sundry Notices (zone changes, recompletions), P-12 (plugging extension)."),
    ) : React.createElement(Text, { style: S.noteText }, "CODA imaged record lookup not completed."),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 5 — Compliance and Legal Status ─────────────────────────────────

function CompliancePage({ run, id: identity, attempts, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  generatedAt: string;
}) {
  const wellStatus = getAttempt(attempts, "fetch_well_status");
  const inactive   = getAttempt(attempts, "fetch_inactive_well_status");
  const orphan     = getAttempt(attempts, "fetch_orphan_well");
  const plugging   = getAttempt(attempts, "fetch_plugging_records");
  const injection  = getAttempt(attempts, "fetch_injection_records");
  const severance  = getAttempt(attempts, "fetch_severance_records");

  const inactiveRecords  = Array.isArray(inactive?.["records"])  ? (inactive!["records"]  as Record<string, unknown>[]) : [];
  const plugRecords      = Array.isArray(plugging?.["records"])  ? (plugging!["records"]  as Record<string, unknown>[]) : [];
  // getInjectionRecords() (worker/src/tools/ewa.ts) returns {found, records:
  // [...], message} — no count or trrc_source_url field, unlike what this
  // section previously assumed.
  const injectionRecords = Array.isArray(injection?.["records"]) ? (injection!["records"] as Record<string, unknown>[]) : [];

  const statusStr  = str(wellStatus?.["status"] ?? wellStatus?.["well_status"]);
  const isOrphan   = orphan?.["is_orphan"] === true;

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 5 — COMPLIANCE AND LEGAL STATUS"),

    kv("Well Status (Official RRC)", statusStr || "—", /shut.in|inactive|plugged/i.test(statusStr) ? "yellow" : undefined),
    kv("Inactive Well Designation",  inactive?.["found"] ? "Yes" : inactive?.["found"] === false ? "No" : "—"),
    inactiveRecords.length > 0 ? kv("Plugging Deadline", str(inactiveRecords[0]?.["plugging_deadline_date"] ?? inactiveRecords[0]?.["deadline"]), "yellow") : null,
    kv("Orphan Well Program",        isOrphan ? "YES — CRITICAL" : orphan !== null ? "No" : "—", isOrphan ? "red" : undefined),
    kv("Plugging Records (W-3C)",    plugging?.["found"] === true ? "Filed" : plugging?.["found"] === false ? "Not Filed" : "—"),

    plugRecords.length > 0 ? React.createElement(View, { style: { marginTop: 4, marginBottom: 6 } },
      kv("Plug Date",        str(plugRecords[0]?.["plug_date"] ?? plugRecords[0]?.["date"])),
      kv("Plugging Contractor", str(plugRecords[0]?.["contractor"])),
      kv("RRC Certified",    str(plugRecords[0]?.["certified"])),
    ) : null,

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "Injection / UIC Permits"),
    injection ? React.createElement(View, { style: { marginBottom: 8 } },
      kv("UIC Records Found",  injection["found"] === true ? "Yes" : "No"),
      kv("Active UIC Permits", String(injectionRecords.length)),
    ) : React.createElement(Text, { style: S.noteText }, "UIC/Injection records not retrieved."),

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "Severance/Seal Records"),
    (() => {
      const severanceRecords = Array.isArray(severance?.["records"]) ? (severance!["records"] as Record<string, unknown>[]) : [];
      if (severance?.["found"] === true && severanceRecords.length > 0) {
        const onSchedule = str(severanceRecords[0]?.["on_schedule"]);
        return React.createElement(View, { style: { marginBottom: 8 } },
          kv("On Reporting Schedule", onSchedule === "Y" ? "Yes" : onSchedule === "N" ? "No — outstanding issue" : onSchedule || "—", onSchedule === "N" ? "yellow" : undefined),
          kv("Field",    str(severanceRecords[0]?.["field_name"])),
        );
      }
      if (severance?.["found"] === false) {
        return React.createElement(Text, { style: S.noteText }, "No severance/seal records on file.");
      }
      return React.createElement(Text, { style: S.noteText }, "Severance/seal records not retrieved.");
    })(),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 6 — Legal Description and Location ───────────────────────────────

function LegalDescriptionPage({ run, id: identity, attempts, mapImage, offsetWells, lateralPath, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  mapImage: Buffer | null;
  offsetWells: OffsetWell[];
  lateralPath: LateralPath | null;
  generatedAt: string;
}) {
  const gis = getAttempt(attempts, "fetch_gis_plat");
  const glo = getAttempt(attempts, "fetch_glo_survey");

  const survey    = gis?.["survey"] as Record<string, unknown> | null ?? {};
  const gisLatNum = typeof gis?.["latitude"]  === "number" ? gis["latitude"]  as number : null;
  const gisLngNum = typeof gis?.["longitude"] === "number" ? gis["longitude"] as number : null;
  const gisLat    = gisLatNum !== null ? gisLatNum.toFixed(6) : null;
  const gisLng    = gisLngNum !== null ? gisLngNum.toFixed(6) : null;
  const alerts    = Array.isArray(gis?.["alert_areas"]) ? (gis!["alert_areas"] as string[]) : [];
  // getGisLocation() (worker/src/tools/ewa.ts) returns {found, latitude,
  // longitude, well_type, survey, alert_areas, message, error?} — no
  // trrc_source_url, location_source, or location_reliability field, so
  // those three always rendered blank/dead below. There is also no
  // fetch_glo_survey fetcher anywhere in the worker (Texas GLO survey
  // records, S15, is a documented gap, not an implemented source) — `glo`
  // is therefore always null, and the old "Private (no GLO record found)"
  // fallback falsely implied a GLO search had run and confirmed no record,
  // when no GLO search has ever been attempted.

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 6 — LEGAL DESCRIPTION AND LOCATION"),

    React.createElement(Text, { style: S.subTitle }, "Survey Data"),
    React.createElement(View, { style: { marginBottom: 10 } },
      kv("Abstract Number",  str(survey["abstract_number"] ?? glo?.["abstract_number"])),
      kv("Survey Name",      str(survey["survey_name"] ?? glo?.["survey_name"])),
      kv("Block Number",     str(survey["block_number"] ?? glo?.["block"])),
      kv("Section",          str(survey["section_name"] ?? glo?.["section"])),
      kv("County",           identity.county),
      kv("Mineral Ownership", str(glo?.["mineral_ownership"]) || "Texas GLO survey records not retrieved (no automated connector yet)"),
    ),

    React.createElement(View, { style: S.divider }),

    React.createElement(Text, { style: S.subTitle }, "GIS / Surface Location"),
    gis?.["found"] ? React.createElement(View, { style: { marginBottom: 10 } },
      kv("Coordinates (NAD83)", gisLat && gisLng ? `${gisLat}°N, ${gisLng}°W` : "—"),
      kv("Well Type",           str(gis?.["well_type"])),
      alerts.length > 0 ? kv("Alert Areas", alerts.join("; "), "yellow") : null,
    ) : React.createElement(Text, { style: S.noteText }, gis?.["found"] === false ? "Well not found in RRC GIS database — manual GIS verification required." : "GIS data not retrieved."),

    mapImage ? React.createElement(View, { style: { marginTop: 10 } },
      React.createElement(Text, { style: S.subTitle }, "Well Location Map"),
      React.createElement(View, { style: { position: "relative", width: 320, height: 240 } },
        React.createElement(Image, { src: mapImage, style: { width: 320, height: 240, borderWidth: 1, borderColor: C.border } }),
        React.createElement(View, {
          style: {
            position: "absolute", top: 120 - 7, left: 160 - 7,
            width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: C.red,
          },
        }),
      ),
      React.createElement(Text, { style: [S.noteText, { marginTop: 3 }] }, "Subject well (red circle) among nearby offset wells. Source: TRRC GIS Well Locations layer (rrc_public/RRC_Public_Viewer_Srvs), rendered directly — coordinates only, no basemap imagery."),
    ) : null,

    offsetWells.length > 0 ? React.createElement(View, { style: { marginTop: 10 } },
      React.createElement(Text, { style: S.subTitle }, `Nearest Offset Wells (${offsetWells.length} within 1 mi.)`),
      React.createElement(Text, { style: S.noteText }, "Operator is not available from this GIS layer without a per-well lookup and is not included here — status reflects the GIS symbol classification, not necessarily current TRRC well-status records."),
      React.createElement(View, { style: [S.tableHeader, { marginTop: 6 }] },
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "20%" }] }, "API"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "16%" }] }, "Well No."),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "16%" }] }, "Distance"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "12%" }] }, "Bearing"),
        React.createElement(Text, { style: [S.tableHeaderCell, { width: "36%" }] }, "Status"),
      ),
      ...offsetWells.slice(0, 10).map((w, i) => React.createElement(
        View, { key: String(i), style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
        React.createElement(Text, { style: [S.tableCellMono, { width: "20%" }] }, w.api),
        React.createElement(Text, { style: [S.tableCellMono, { width: "16%" }] }, w.well_number),
        React.createElement(Text, { style: [S.tableCellMono, { width: "16%" }] }, `${w.distance_miles.toFixed(2)} mi`),
        React.createElement(Text, { style: [S.tableCellMono, { width: "12%" }] }, w.bearing),
        React.createElement(Text, { style: [S.tableCell, { width: "36%" }] }, w.status),
      )),
    ) : null,

    lateralPath ? React.createElement(View, { style: { marginTop: 10 } },
      React.createElement(Text, { style: S.subTitle }, "Horizontal Wellbore Path"),
      React.createElement(Text, { style: S.noteText }, "Straight-line surface-to-drainhole distance, not the full curved directional survey — TRRC's public GIS layers don't publish the intermediate path, only these two endpoints."),
      React.createElement(View, { style: { marginTop: 4 } },
        kv("Drainhole Coordinates (NAD83)", `${lateralPath.drainhole_latitude.toFixed(6)}°N, ${lateralPath.drainhole_longitude.toFixed(6)}°W`),
        kv("Lateral Length (straight-line)", `${Math.round(lateralPath.straight_line_length_ft).toLocaleString("en-US")} ft (${(lateralPath.straight_line_length_ft / 5280).toFixed(2)} mi)`),
        kv("Bearing from Surface", lateralPath.bearing),
      ),
    ) : null,

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 7 — Missing Documents and Gaps ──────────────────────────────────

function MissingDocumentsPage({ run, id: identity, attempts, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  generatedAt: string;
}) {
  // Reuses buildEvidenceIndex() (the same source used by Section 9) instead
  // of the previous duplicated label map and ad-hoc gap detection — this is
  // the section a reader hits first when something didn't come back, so it
  // needs the same direct portal link + exact query criteria Section 9 has,
  // not a bare error message with no path to look it up by hand.
  const gaps = buildEvidenceIndex(attempts, run).filter(e => e.status !== "retrieved");
  const severityFor = (status: EvidenceIndexEntry["status"]): "red" | "yellow" | "none" =>
    status === "retrieval_failed" ? "red" : status === "manual_required" || status === "not_attempted" ? "yellow" : "none";

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 7 — MISSING DOCUMENTS AND GAPS"),

    React.createElement(Text, { style: S.noteText }, "Every source that returned no records, failed, or requires manual retrieval is listed here, with a direct link to the TRRC portal and the exact criteria to re-run it by hand. A gap that is not applicable for this well type is noted as such; gaps in critical sources are flagged."),

    gaps.length === 0 ? React.createElement(View, { style: [S.flagBox, { backgroundColor: C.greenBg }] },
      React.createElement(Text, { style: [S.flagItem, { color: C.green }] }, "✓ All queried sources returned data successfully."),
    ) : React.createElement(View, {},
      ...gaps.map((g, i) => {
        const severity = severityFor(g.status);
        const color = severity === "red" ? C.red : severity === "yellow" ? C.yellow : C.border;
        return React.createElement(
          View, { key: String(i), style: { marginBottom: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: color } },
          React.createElement(Link, { src: g.portal_url, style: [S.trrcLink, { fontSize: 8, fontFamily: "Helvetica-Bold", marginBottom: 2, color: severity === "none" ? C.dark : color }] }, `${g.label} ↗`),
          React.createElement(Text, { style: { fontSize: 7.5, color: C.gray, fontFamily: "Helvetica" } }, g.status_note),
          g.status !== "not_attempted" ? React.createElement(Text, { style: { fontSize: 7.5, color: C.dark, fontFamily: "Courier" } }, `Enter: ${g.query_criteria}`) : null,
        );
      }),
    ),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 8 — Timeline ─────────────────────────────────────────────────────

const EVIDENCE_STATUS_LABEL: Record<string, string> = {
  retrieved: "Retrieved",
  confirmed_absent: "No Records Found",
  manual_required: "Manual Required",
  retrieval_failed: "Retrieval Failed",
  not_attempted: "Not Attempted",
};

const TIMELINE_CATEGORY_COLOR: Record<string, string> = {
  permit: C.accent,
  completion: C.navy,
  production: C.green,
  plugging: C.red,
  compliance: C.yellow,
  status: C.gray,
};

function TimelinePage({ run, id: identity, attempts, production, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  production: TrrcDDProductionRow[];
  generatedAt: string;
}) {
  const timeline = buildTimeline(attempts, production);

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 8 — TIMELINE"),

    React.createElement(Text, { style: S.noteText }, "Dated regulatory events assembled from sources already retrieved elsewhere in this report — permits, completion, plugging, compliance, and production. An event only appears here if a date could be confidently parsed from the underlying TRRC record; nothing is estimated."),

    timeline.length === 0
      ? React.createElement(Text, { style: [S.noteText, { marginTop: 8 }] }, "No dated events could be assembled from the sources retrieved for this run.")
      : React.createElement(View, { style: { marginTop: 10 } },
          ...timeline.map((e, i) => React.createElement(
            View, { key: String(i), style: { flexDirection: "row", marginBottom: 7, alignItems: "flex-start" } },
            React.createElement(Text, { style: { width: 70, fontSize: 8, fontFamily: "Helvetica-Bold", color: C.dark } }, e.date),
            React.createElement(View, { style: { width: 8, height: 8, borderRadius: 4, backgroundColor: TIMELINE_CATEGORY_COLOR[e.category] ?? C.gray, marginTop: 1.5, marginRight: 8 } }),
            React.createElement(Text, { style: { fontSize: 8.5, color: C.dark, flex: 1 } }, e.label),
          )),
        ),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 9 — Evidence Index ──────────────────────────────────────────────

function EvidenceIndexPage({ run, id: identity, attempts, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  generatedAt: string;
}) {
  const index = buildEvidenceIndex(attempts, run);

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 9 — EVIDENCE INDEX"),

    React.createElement(Text, { style: S.noteText }, "Every TRRC source this pipeline supports, what was queried, and what came back. TRRC's own query portals are inconsistent about honoring pre-filled links for an unauthenticated visitor, so links here point to the portal itself — re-enter the criteria listed to independently reproduce a result."),

    React.createElement(View, { style: [S.tableHeader, { marginTop: 8 }] },
      React.createElement(Text, { style: [S.tableHeaderCell, { width: "26%" }] }, "Source"),
      React.createElement(Text, { style: [S.tableHeaderCell, { width: "22%" }] }, "Query Criteria"),
      React.createElement(Text, { style: [S.tableHeaderCell, { width: "16%" }] }, "Status"),
      React.createElement(Text, { style: [S.tableHeaderCell, { width: "10%" }] }, "Records"),
      React.createElement(Text, { style: [S.tableHeaderCell, { width: "26%" }] }, "Retrieved At (UTC)"),
    ),
    ...index.map((e, i) => React.createElement(
      View, { key: String(i), style: i % 2 === 0 ? S.tableRow : S.tableRowAlt },
      React.createElement(Link, { src: e.portal_url, style: [S.tableCell, S.trrcLink, { width: "26%" }] }, e.label),
      React.createElement(Text, { style: [S.tableCellMono, { width: "22%" }] }, e.query_criteria),
      React.createElement(Text, { style: [S.tableCell, { width: "16%" }, e.status === "retrieval_failed" ? { color: C.red } : e.status === "manual_required" ? { color: C.yellow } : {}] }, EVIDENCE_STATUS_LABEL[e.status]),
      React.createElement(Text, { style: [S.tableCellMono, { width: "10%" }] }, String(e.record_count)),
      React.createElement(Text, { style: [S.tableCellMono, { width: "26%" }] }, e.retrieved_at ?? "—"),
    )),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 10 — Overall Assessment ─────────────────────────────────────────

const RECOMMENDATION_COLOR: Record<string, string> = {
  PURSUE: C.green, REVIEW: C.yellow, PASS: C.gray, BLOCKED: C.red,
};

function scoreColor(score: number): string {
  if (score >= 70) return C.green;
  if (score >= 40) return C.yellow;
  return C.red;
}

// ─── Section 10 — Acquisition Scorecard ──────────────────────────────────────

function AcquisitionScorecardPage({ run, id: identity, scorecard, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  scorecard: AcquisitionScorecard;
  generatedAt: string;
}) {
  const dimensionEntries = Object.values(scorecard.dimensions);

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 10 — ACQUISITION SCORECARD"),

    React.createElement(Text, { style: S.noteText },
      "A transparent, rule-based screening aid computed only from the TRRC records retrieved in this report — not a black-box model, not investment advice, and not a substitute for the buyer's own underwriting. Every score below states exactly which retrieved facts produced it. Missing data always scores low, never neutral-good.",
    ),

    React.createElement(View, { style: { flexDirection: "row", marginTop: 10, marginBottom: 10 } },
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "SCREENING RESULT"),
        React.createElement(Text, { style: { fontSize: 13, fontFamily: "Helvetica-Bold", color: RECOMMENDATION_COLOR[scorecard.recommendation] ?? C.navy } }, scorecard.recommendation),
      ),
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "OPPORTUNITY"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: scoreColor(scorecard.opportunity_score) } }, String(scorecard.opportunity_score)),
      ),
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "RISK"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: scoreColor(100 - scorecard.risk_score) } }, String(scorecard.risk_score)),
      ),
      React.createElement(View, { style: [S.summaryStatBox, { marginRight: 0 }] },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "CONFIDENCE"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: scoreColor(scorecard.overall_confidence) } }, String(scorecard.overall_confidence)),
      ),
    ),

    scorecard.gating_conditions.length > 0 ? React.createElement(View, { style: [S.flagBox, { backgroundColor: C.redBg, marginBottom: 8 }] },
      React.createElement(Text, { style: [S.flagLabel, { color: C.red }] }, "⚠ SCREENING RESULT IS GATED"),
      React.createElement(Text, { style: [S.flagItem, { color: C.red }] }, "One or more critical findings force a BLOCKED result regardless of the dimension scores below — see Section 1 for detail."),
    ) : null,

    React.createElement(Text, { style: [S.subTitle, { marginTop: 4 }] }, "Scoring Dimensions (0-100)"),
    ...dimensionEntries.map((d, i) => React.createElement(
      View, { key: String(i), style: { marginBottom: 6, paddingBottom: 6, borderBottomWidth: i < dimensionEntries.length - 1 ? 0.5 : 0, borderBottomColor: C.border } },
      React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", marginBottom: 1 } },
        React.createElement(Text, { style: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.dark } }, `${d.label} (weight ${(d.weight * 100).toFixed(0)}%)`),
        React.createElement(Text, { style: { fontSize: 9, fontFamily: "Helvetica-Bold", color: scoreColor(d.score) } }, String(d.score)),
      ),
      React.createElement(Text, { style: { fontSize: 7.5, color: C.gray } }, d.rationale),
      d.data_points.length > 0 ? React.createElement(Text, { style: { fontSize: 7, color: C.lightGray, marginTop: 1 } }, d.data_points.join(" · ")) : null,
    )),

    scorecard.reasons_against.length > 0 ? React.createElement(View, { style: { marginTop: 8 } },
      React.createElement(Text, { style: S.subTitle }, "Reasons Against"),
      ...scorecard.reasons_against.slice(0, 6).map((r, i) => React.createElement(Text, { key: String(i), style: [S.bodyText, { fontSize: 7.5, color: C.red, marginBottom: 2 }] }, `• ${r}`)),
    ) : null,

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Section 11 — Overall Assessment ─────────────────────────────────────────

function OverallAssessmentPage({ run, id: identity, attempts, flags, analytics, scorecard, generatedAt }: {
  run: TrrcDueDiligenceRun;
  id: WellIdentity;
  attempts: LiteSourceAttempt[];
  flags: Flags;
  analytics: ProductionAnalytics;
  scorecard: AcquisitionScorecard;
  generatedAt: string;
}) {
  const seen = new Set<string>();
  let sourcesChecked = 0;
  let sourcesManual = 0;
  let sourcesFailed = 0;

  for (const a of attempts) {
    if (a.source_name === "submit_report") continue;
    if (seen.has(a.source_name)) continue;
    seen.add(a.source_name);
    sourcesChecked++;
    const d = a.result_data_json ?? {};
    if (a.status !== "success") { sourcesFailed++; }
    else if (d["data_gap"] === true || d["endpoint_available"] === false) { sourcesManual++; }
  }

  const completenessMatch = scorecard.dimensions.record_completeness.rationale.match(/^(\d+) of (\d+)/);
  const completenessFraction = completenessMatch ? `${completenessMatch[1]} / ${completenessMatch[2]} sources` : "";

  // Reuses the scorecard's own Record Completeness dimension (Section 10)
  // instead of a separate local calculation — the two used to disagree:
  // this page's old dataCompleteness only counted a source as "complete" if
  // it returned a non-zero record_count, so a confirmed-clean answer (0
  // violations, not an orphan well, no injection permits — genuinely
  // complete, valuable information) counted the same as an outright
  // retrieval failure. That understated completeness far more harshly than
  // Section 10's dimension, which correctly treats confirmed-absence as a
  // definitive answer and excludes not-applicable categories entirely —
  // producing two different completeness numbers for the same run in the
  // same PDF. Single source of truth now.
  const dataCompleteness = Math.round(scorecard.dimensions.record_completeness.score);

  // Build narrative
  const wellDesc = [
    identity.wellName ? `"${identity.wellName}"` : "the subject well",
    identity.county ? `in ${identity.county} County` : "",
    identity.operator ? `operated by ${identity.operator}` : "",
  ].filter(Boolean).join(" ");

  // Same retrieval-failure-vs-confirmed-absence distinction as generateFlags
  // — a hedged "was not retrieved or has no history" statement is dishonest
  // when the evidence index already tells us definitively which one it was.
  const productionAttemptForNarrative = getAttemptRaw(attempts, "fetch_production");
  const productionNarrative = analytics.months.length > 0
    ? `Production history covers ${analytics.months.length} months. The 12-month average is ${analytics.recent12AvgOil !== null ? `${analytics.recent12AvgOil.toFixed(0)} BBL/month (oil)` : "unavailable"} and ${analytics.recent12AvgGas !== null ? `${analytics.recent12AvgGas.toFixed(0)} MCF/month (gas)` : "gas data unavailable"}. ${analytics.yoyDeclineOil !== null ? `Year-over-year production has ${analytics.yoyDeclineOil > 0 ? `declined ${analytics.yoyDeclineOil.toFixed(1)}%` : `increased ${Math.abs(analytics.yoyDeclineOil).toFixed(1)}%`}.` : ""} ${analytics.zeroMonths > 0 ? `${analytics.zeroMonths} month(s) with zero reported production require follow-up.` : ""}`
    : productionAttemptForNarrative?.status === "success"
    ? "TRRC confirms no production history on file for this lease."
    : productionAttemptForNarrative
    ? "Production data could not be retrieved (TRRC query failed) — this is not evidence of zero production. Re-run once the source is restored."
    : "Production was not queried for this run.";

  const complianceNarrative = flags.critical.length > 0
    ? `${flags.critical.length} critical issue(s) were identified that require resolution before proceeding with any transaction. ${flags.important.length > 0 ? `Additionally, ${flags.important.length} important flag(s) warrant further due diligence.` : ""}`
    : flags.important.length > 0
    ? `No critical issues were identified. ${flags.important.length} important flag(s) were noted and should be evaluated in the context of the transaction.`
    : "No critical or important compliance issues were identified based on available TRRC public records.";

  return React.createElement(
    Page, { size: "LETTER", style: S.page },

    React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border } },
      React.createElement(Text, { style: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.navy } }, "TRRC Due Diligence — Mineral Flow AI"),
      React.createElement(Text, { style: { fontSize: 7, color: C.gray } }, identity.apiNumber || run.original_input),
    ),

    React.createElement(Text, { style: S.sectionTitle }, "SECTION 11 — OVERALL ASSESSMENT"),

    // Stats row
    React.createElement(View, { style: { flexDirection: "row", marginBottom: 12 } },
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "DATA COMPLETENESS"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: dataCompleteness >= 70 ? C.green : C.yellow } }, `${dataCompleteness}%`),
        React.createElement(Text, { style: { fontSize: 6.5, color: C.gray } }, completenessFraction),
      ),
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "CRITICAL FLAGS"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: flags.critical.length > 0 ? C.red : C.green } }, String(flags.critical.length)),
      ),
      React.createElement(View, { style: S.summaryStatBox },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "IMPORTANT FLAGS"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: flags.important.length > 0 ? C.yellow : C.green } }, String(flags.important.length)),
      ),
      React.createElement(View, { style: [S.summaryStatBox, { marginRight: 0 }] },
        React.createElement(Text, { style: { fontSize: 7, color: C.gray, fontFamily: "Helvetica-Bold", marginBottom: 2 } }, "MANUAL FOLLOW-UP"),
        React.createElement(Text, { style: { fontSize: 14, fontFamily: "Helvetica-Bold", color: C.navy } }, String(sourcesManual)),
        React.createElement(Text, { style: { fontSize: 6.5, color: C.gray } }, "sources require manual review"),
      ),
    ),

    React.createElement(Text, { style: S.subTitle }, "Summary"),

    React.createElement(Text, { style: S.bodyText },
      `This report covers ${wellDesc}. ${productionNarrative}`,
    ),

    React.createElement(Text, { style: S.bodyText }, complianceNarrative),

    React.createElement(Text, { style: [S.bodyText, { color: C.gray }] },
      "This report does not constitute a buy/sell recommendation — it presents public TRRC records and flags material issues for the buyer's review. A title opinion, reserve engineering report, and environmental assessment may be required before closing.",
    ),

    React.createElement(View, { style: [S.divider, { marginTop: 12 }] }),

    React.createElement(View, { style: { marginTop: 8 } },
      kv("Sources Checked",              String(sourcesChecked)),
      kv("Sources Definitive (Data or Confirmed Absence)", completenessMatch ? completenessMatch[1] : "—"),
      kv("Sources Requiring Manual Review",String(sourcesManual)),
      kv("Sources Failed",               String(sourcesFailed)),
      kv("Report Completed",             new Date(generatedAt).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })),
    ),

    React.createElement(Footer, { generatedAt, runId: run.id }),
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function buildTrrcPdfReport(
  run: TrrcDueDiligenceRun,
  _manifest: TrrcManifest,
  _findings: TrrcFinding[],
  _scorecardArg: AcquisitionScorecard,
  production: TrrcDDProductionRow[],
  coverage: SourceCoverageStatus[],
  sourceAttempts: LiteSourceAttempt[] = [],
): Promise<Buffer> {
  const generatedAt = new Date().toISOString();

  // Deduplicate attempts (keep latest per source_name)
  const seen = new Set<string>();
  const attempts = sourceAttempts.filter(a => {
    if (a.source_name === "submit_report") return false;
    if (seen.has(a.source_name)) return false;
    seen.add(a.source_name);
    return true;
  });

  const identity  = extractIdentity(attempts, run);

  // Static well-location map (TRRC's own public GIS export — no API key,
  // graceful null on any failure so this can never break report generation).
  const gisForMap = getAttempt(attempts, "fetch_gis_plat");
  const mapLat = typeof gisForMap?.["latitude"] === "number" ? gisForMap["latitude"] as number : null;
  const mapLng = typeof gisForMap?.["longitude"] === "number" ? gisForMap["longitude"] as number : null;
  const mapImage = mapLat !== null && mapLng !== null ? await fetchStaticMapImage(mapLat, mapLng) : null;
  const offsetWells = mapLat !== null && mapLng !== null
    ? await fetchOffsetWells(mapLat, mapLng, identity.apiNumber)
    : [];
  const lateralPath = mapLat !== null && mapLng !== null
    ? await fetchLateralPath(identity.apiNumber, mapLat, mapLng)
    : null;
  const analytics = computeProductionAnalytics(production);
  const flags     = generateFlags(attempts, analytics, run);
  const scorecard = buildAcquisitionScorecard({
    attempts, production, coverage,
    criticalFlags: flags.critical,
    importantFlags: flags.important,
    monthsOfHistory: analytics.months.length,
    recentAvgOil: analytics.recent12AvgOil,
    yoyDeclineOilPct: analytics.yoyDeclineOil,
    zeroProductionMonths: analytics.zeroMonths,
    worTrend: analytics.worTrend,
    offsetWellCount: offsetWells.length,
    hasLateralPath: lateralPath !== null,
    resolvedLeaseNumber: run.resolved_lease_number,
    resolvedDistrict: run.resolved_district,
  });

  const wellStatusAttempt = getAttempt(attempts, "fetch_well_status");
  const wellStatus = str(wellStatusAttempt?.["status"] ?? wellStatusAttempt?.["well_status"]);

  const doc = React.createElement(
    Document,
    {
      title: `Mineral Flow AI — TRRC Due Diligence — ${identity.apiNumber || run.original_input}`,
      author: "Mineral Flow AI",
      subject: "TRRC Public Records Due Diligence",
      creator: "Mineral Flow AI",
    },
    React.createElement(CoverPage,              { run, id: identity, generatedAt }),
    React.createElement(ExecutiveSummaryPage,   { run, id: identity, flags, wellStatus, generatedAt }),
    React.createElement(OperatorStandingPage,   { run, id: identity, attempts, flags, generatedAt }),
    React.createElement(ProductionPage,         { run, id: identity, analytics, generatedAt }),
    React.createElement(WellConstructionPage,   { run, id: identity, attempts, generatedAt }),
    React.createElement(CompliancePage,         { run, id: identity, attempts, generatedAt }),
    React.createElement(LegalDescriptionPage,   { run, id: identity, attempts, mapImage, offsetWells, lateralPath, generatedAt }),
    React.createElement(MissingDocumentsPage,   { run, id: identity, attempts, generatedAt }),
    React.createElement(TimelinePage,           { run, id: identity, attempts, production, generatedAt }),
    React.createElement(EvidenceIndexPage,      { run, id: identity, attempts, generatedAt }),
    React.createElement(AcquisitionScorecardPage, { run, id: identity, scorecard, generatedAt }),
    React.createElement(OverallAssessmentPage,  { run, id: identity, attempts, flags, analytics, scorecard, generatedAt }),
  );

  const buffer = await renderToBuffer(doc);
  return Buffer.from(buffer);
}
