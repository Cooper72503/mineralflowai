"use client";

import { useState, useCallback, useContext, createContext, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { ProductionDeclineChart, DcaProjectionChart, CashFlowChart } from "./UnderwritingCharts";
import type {
  DDReport, DataPoint, DataConfidence, DataSource, MissingItem, NextQuestion,
  EconomicsScenario, RiskCategoryResult, DiligenceCheckItem,
  DowntimeSection, BuyerQASection,
  FormationCompletionSection, OperatorProfileSection, ExecutiveSummarySection,
  WellCompletionData, OperationalTimelineEvent, OperationalTimelineEventType,
  DiligenceStatusItem, DiligenceStatusTier,
  SensitivityMatrix, MonthlyCashFlowRow, NormalizedApi,
  EvidenceSource, DocumentRequest, OfferGate, OfferGateField,
} from "@/lib/underwriting/types";
import type { BuyerQA } from "@/lib/underwriting/buyer-qa-engine";
import type { DowntimePeriod } from "@/lib/underwriting/downtime-engine";

// ─── Design tokens ────────────────────────────────────────────────────────────

const COLORS = {
  bg:            "#0f1117",
  surface:       "#181c25",
  surfaceAlt:    "#1e2333",
  border:        "rgba(255,255,255,0.08)",
  borderStrong:  "rgba(255,255,255,0.15)",
  text:          "#e2e8f0",
  textMuted:     "#8892a4",
  textFaint:     "#5a6478",
  accent:        "#4f8ef7",
  accentDim:     "rgba(79,142,247,0.12)",
  green:         "#22c55e",
  greenDim:      "rgba(34,197,94,0.12)",
  yellow:        "#f59e0b",
  yellowDim:     "rgba(245,158,11,0.12)",
  red:           "#ef4444",
  redDim:        "rgba(239,68,68,0.12)",
  purple:        "#a78bfa",
  purpleDim:     "rgba(167,139,250,0.12)",
};

// ─── Field Audit debug context ────────────────────────────────────────────────
//
// Toggle with Alt+Shift+D. When active, every DataCell exposes its full
// provenance chain: source, source_detail, confidence, note, and audit_trail.
// Internal-only — never shown in exported PDFs or shared views.

const FieldAuditContext = createContext(false);

// ─── Institutional verification badges ───────────────────────────────────────
//
// Every data field shows ONE of:
//   PUBLIC RECORD   — pulled directly from TRRC/state agency
//   VERIFIED        — TRRC data with high confidence
//   OCR EXTRACTED   — parsed from uploaded PDF / document
//   OPERATOR PROVIDED — from run ticket / LOE statement supplied by operator
//   INFERRED        — calculated from other data with reasonable confidence
//   LOW CONFIDENCE  — inferred with limited supporting data
//   MISSING DATA    — not available from any source

function SourceBadge({ source, confidence, sourceDetail }: {
  source: DataSource;
  confidence?: DataConfidence;
  sourceDetail?: string;
}) {
  type BadgeCfg = { label: string; bg: string; color: string };

  let cfg: BadgeCfg;

  if (source === "trrc") {
    cfg = confidence === "high"
      ? { label: "VERIFIED",       bg: "rgba(34,197,94,0.15)",  color: COLORS.green  }
      : { label: "PUBLIC RECORD",  bg: COLORS.accentDim,        color: COLORS.accent };
  } else if (source === "uploaded_doc") {
    cfg = { label: "OCR EXTRACTED",     bg: COLORS.purpleDim, color: COLORS.purple };
  } else if (source === "run_statement") {
    cfg = { label: "OPERATOR PROVIDED", bg: COLORS.greenDim,  color: COLORS.green  };
  } else if (source === "loe_statement") {
    cfg = { label: "OPERATOR PROVIDED", bg: COLORS.yellowDim, color: COLORS.yellow };
  } else if (source === "inferred") {
    cfg = confidence === "low" || confidence === "none"
      ? { label: "LOW CONFIDENCE", bg: "rgba(245,158,11,0.08)", color: "#e09a2a" }
      : { label: "INFERRED",       bg: "rgba(255,255,255,0.06)", color: COLORS.textMuted };
  } else {
    cfg = { label: "MISSING DATA", bg: COLORS.redDim, color: COLORS.red };
  }

  return (
    <span
      title={sourceDetail ?? cfg.label}
      style={{
        display: "inline-block",
        fontSize: "0.6rem",
        fontWeight: 800,
        letterSpacing: "0.05em",
        padding: "0.1rem 0.45rem",
        borderRadius: 4,
        background: cfg.bg,
        color: cfg.color,
        whiteSpace: "nowrap",
        textTransform: "uppercase",
        border: `1px solid ${cfg.color}25`,
      }}
    >
      {cfg.label}
    </span>
  );
}

function ConfBadge({ confidence }: { confidence: DataConfidence }) {
  const map: Record<DataConfidence, { symbol: string; color: string }> = {
    high:   { symbol: "●●●", color: COLORS.green   },
    medium: { symbol: "●●○", color: COLORS.yellow  },
    low:    { symbol: "●○○", color: "#e09a2a"      },
    none:   { symbol: "○○○", color: COLORS.red     },
  };
  const cfg = map[confidence];
  return (
    <span style={{ fontSize: "0.6rem", color: cfg.color, letterSpacing: "0.1em" }} title={`Confidence: ${confidence}`}>
      {cfg.symbol}
    </span>
  );
}

// ─── Data-point cell ──────────────────────────────────────────────────────────

function DataCell<T>({
  dp,
  format = (v: T) => String(v),
  unit = "",
}: {
  dp: DataPoint<T>;
  format?: (v: T) => string;
  unit?: string;
}) {
  const auditMode = useContext(FieldAuditContext);

  if (dp.source === "missing" || dp.value == null) {
    return (
      <span>
        <span style={{ color: COLORS.textFaint, fontStyle: "italic", fontSize: "0.8rem" }}>
          {dp.note ?? "Not provided"}
        </span>
        {auditMode && (
          <span style={{
            display: "block", marginTop: 3, padding: "3px 6px",
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
            borderRadius: 4, fontSize: "0.65rem", color: "#ef9999", fontFamily: "monospace",
          }}>
            ⚠ MISSING · source={dp.source} · confidence={dp.confidence}
            {dp.note && ` · "${dp.note}"`}
            {dp.audit_trail?.map((t, i) => (
              <span key={i} style={{ display: "block" }}>  [{i + 1}] {t}</span>
            ))}
          </span>
        )}
      </span>
    );
  }
  return (
    <span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: COLORS.text, fontWeight: 600 }}>
          {format(dp.value)}{unit ? ` ${unit}` : ""}
        </span>
        <SourceBadge source={dp.source} confidence={dp.confidence} sourceDetail={dp.source_detail} />
        {dp.note && (
          <span style={{ fontSize: "0.7rem", color: COLORS.textMuted }}>({dp.note})</span>
        )}
      </span>
      {auditMode && (
        <span style={{
          display: "block", marginTop: 3, padding: "3px 6px",
          background: "rgba(79,142,247,0.06)", border: "1px solid rgba(79,142,247,0.2)",
          borderRadius: 4, fontSize: "0.65rem", color: "#8bb8f7", fontFamily: "monospace",
        }}>
          ✓ source={dp.source} · confidence={dp.confidence}
          {dp.source_detail && ` · "${dp.source_detail}"`}
          {dp.note && ` · note="${dp.note}"`}
          {dp.audit_trail?.map((t, i) => (
            <span key={i} style={{ display: "block" }}>  [{i + 1}] {t}</span>
          ))}
        </span>
      )}
    </span>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children, icon }: { title: string; children: React.ReactNode; icon?: string }) {
  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      padding: "1.25rem 1.5rem",
      marginBottom: "1rem",
    }}>
      <h3 style={{
        margin: "0 0 1rem 0",
        fontSize: "0.85rem",
        fontWeight: 700,
        color: COLORS.textMuted,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        {icon && <span>{icon}</span>}
        {title}
      </h3>
      {children}
    </div>
  );
}

// ─── Table helper ─────────────────────────────────────────────────────────────

function DdTable({ headers, rows }: { headers: string[]; rows: (React.ReactNode | string | null)[][] }) {
  if (rows.length === 0) {
    return (
      <p style={{ color: COLORS.textFaint, fontSize: "0.8rem", margin: "0.5rem 0" }}>
        No data available.
      </p>
    );
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "0.8rem",
      }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{
                textAlign: "left",
                padding: "0.4rem 0.75rem",
                color: COLORS.textMuted,
                fontWeight: 600,
                fontSize: "0.72rem",
                letterSpacing: "0.05em",
                borderBottom: `1px solid ${COLORS.border}`,
                whiteSpace: "nowrap",
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{
                  padding: "0.5rem 0.75rem",
                  color: COLORS.text,
                  verticalAlign: "top",
                }}>
                  {cell ?? <span style={{ color: COLORS.textFaint }}>—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── KV row ───────────────────────────────────────────────────────────────────

function KvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: "1rem",
      padding: "0.5rem 0",
      borderBottom: `1px solid ${COLORS.border}`,
      fontSize: "0.82rem",
    }}>
      <span style={{ width: 200, minWidth: 200, color: COLORS.textMuted, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

const fmt$ = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const fmtN = (n: number, dec = 0) => n.toLocaleString("en-US", { maximumFractionDigits: dec });
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

const fmtBoe = (oil: number, gasMcf: number) => {
  const boe = oil + gasMcf / 6;
  return boe > 0 ? `${fmtN(Math.round(boe))} BOE/mo` : null;
};

// ─── Report completion label ──────────────────────────────────────────────────
//
// Derives the accurate scan-completion status from the diligence_status array.
// A report is only "Full Underwriting Complete" when every mandatory category is
// either verified or not_applicable. Missing or partially_verified critical items
// produce a "Blocked" label; non-critical gaps produce "Partial."
//
// This prevents the banner from showing green when economics are suppressed,
// ownership is unverified, or LOE/run-tickets are missing. (Finding #7, Manus AI review)

const MANDATORY_DILIGENCE_CATEGORIES = [
  "API / Well Identification",
  "Operator Identity",
  "Production History",
  "Inspection & Compliance History",
  "LOE Statements",
  "Ownership / Division Orders",
  "Water Cut & Fluid Production",
  "Workover History & Invoices",
] as const;

// Tiers that count as "resolved" for the completion gate
const RESOLVED_TIERS = new Set<DiligenceStatusTier>(["verified", "searched_no_records", "not_applicable"]);

function deriveReportCompletionLabel(
  items: DiligenceStatusItem[],
  serverLabel?: DDReport["diligence_run_label"],
): {
  label: string;
  sublabel: string;
  severity: "complete" | "partial" | "blocked";
  blockingCount: number;
} {
  // Server-side gate always wins when present (Manus spec §14 / §11)
  if (serverLabel) {
    switch (serverLabel) {
      case "Failed Verification":
        return {
          label: "Failed Verification",
          sublabel: "A critical report claim is contradicted by official evidence. Report blocked.",
          severity: "blocked",
          blockingCount: 1,
        };
      case "Quick Screen":
        return {
          label: "Quick Screen",
          sublabel: "Preliminary identity scan only. Full evidence pipeline not run.",
          severity: "blocked",
          blockingCount: 1,
        };
      case "Preliminary Diligence":
        return {
          label: "Preliminary Diligence",
          sublabel: "Some official evidence parsed. One or more critical modules are incomplete.",
          severity: "partial",
          blockingCount: 1,
        };
      case "Public-Record Diligence":
        return {
          label: "Public-Record Diligence",
          sublabel: "RRC identity, inventory, production, and compliance verified. Private docs still needed for offer.",
          severity: "partial",
          blockingCount: 0,
        };
      case "Acquisition-Grade Diligence":
        return {
          label: "Acquisition-Grade Diligence",
          sublabel: "All public records, LOE, revenue, ownership, and title verified. Gate open.",
          severity: "complete",
          blockingCount: 0,
        };
    }
  }

  // Fallback: derive from diligence status items
  if (!items || items.length === 0) {
    return { label: "Quick Screen", sublabel: "No evidence modules completed.", severity: "blocked", blockingCount: 1 };
  }

  const mandatory = items.filter(i => MANDATORY_DILIGENCE_CATEGORIES.includes(i.category as typeof MANDATORY_DILIGENCE_CATEGORIES[number]));
  const blocking  = mandatory.filter(i => !RESOLVED_TIERS.has(i.tier));
  const critical  = blocking.filter(i => i.urgency === "critical" || i.tier === "missing" || i.tier === "query_failed");

  if (critical.length > 0) {
    const fields = critical.map(i => i.category).join(", ");
    return {
      label: "Preliminary Diligence",
      sublabel: `${critical.length} critical item(s) unresolved: ${fields}.`,
      severity: "blocked",
      blockingCount: critical.length,
    };
  }
  if (blocking.length > 0) {
    return {
      label: "Preliminary Diligence",
      sublabel: `${blocking.length} mandatory item(s) not yet fully verified.`,
      severity: "partial",
      blockingCount: blocking.length,
    };
  }
  return {
    label: "Public-Record Diligence",
    sublabel: "Public-record mandatory categories verified or confirmed no records.",
    severity: "complete",
    blockingCount: 0,
  };
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type TabId =
  | "executive_summary"
  | "asset_overview"
  | "production_decline"
  | "economics_valuation"
  | "operations_workovers"
  | "compliance_risk"
  | "ownership_interests"
  | "swd_water"
  | "imaged_records"
  | "proration_p5"
  | "documents_sources"
  | "missing_diligence"
  | "ic_memo"
  | "export_center"
  | "production_audit"
  | "data_provenance"
  | "truth_check";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "truth_check",         label: "Truth-Check",            icon: "⚖️" },
  { id: "data_provenance",     label: "Data Provenance",        icon: "🔍" },
  { id: "executive_summary",   label: "Executive Summary",      icon: "📋" },
  { id: "asset_overview",      label: "Asset Overview",         icon: "🪨" },
  { id: "production_decline",  label: "Production & Decline",   icon: "⛽" },
  { id: "production_audit",    label: "Production Audit",       icon: "🔬" },
  { id: "economics_valuation", label: "Economics & Valuation",  icon: "💰" },
  { id: "operations_workovers",label: "Operations & Workovers", icon: "🔧" },
  { id: "compliance_risk",     label: "Compliance & Risk",      icon: "🔒" },
  { id: "ownership_interests", label: "Ownership & Interests",  icon: "📜" },
  { id: "swd_water",           label: "SWD / Water",            icon: "💧" },
  { id: "imaged_records",      label: "Imaged Records",         icon: "📄" },
  { id: "proration_p5",        label: "Proration / P-5",        icon: "🏛️" },
  { id: "documents_sources",   label: "Documents & Sources",    icon: "📂" },
  { id: "missing_diligence",   label: "Missing Diligence",      icon: "⚠️" },
  { id: "ic_memo",             label: "IC Memo",                icon: "🤔" },
  { id: "export_center",       label: "Export Center",          icon: "📦" },
];

// ─── Report sections ──────────────────────────────────────────────────────────

// ─── Production bar chart ─────────────────────────────────────────────────────

function ProductionBarChart({ rows }: {
  rows: { period: string; oil_bbl: number; gas_mcf: number; water_bbl: number | null }[];
}) {
  if (rows.length === 0) return null;

  // Show at most 36 months, sorted
  const sorted = [...rows]
    .sort((a, b) => a.period < b.period ? -1 : 1)
    .slice(-36);

  const maxOil = Math.max(...sorted.map(r => r.oil_bbl), 1);
  const maxGas = Math.max(...sorted.map(r => r.gas_mcf), 1);
  const hasGas = sorted.some(r => r.gas_mcf > 0);
  const hasWater = sorted.some(r => r.water_bbl != null && r.water_bbl > 0);

  const W = 600, H = 130, PAD_L = 38, PAD_B = 22, PAD_T = 8, PAD_R = 8;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barW = Math.max(2, innerW / sorted.length - 2);

  const yTick = (val: number, max: number) => PAD_T + innerH - (val / max) * innerH;

  // Y-axis labels
  const yLabels = [0, 0.5, 1].map(f => ({
    y: PAD_T + innerH - f * innerH,
    label: Math.round(maxOil * f).toLocaleString(),
  }));

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ fontSize: "0.7rem", color: COLORS.textFaint, marginBottom: 4, display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, background: COLORS.accent, display: "inline-block", borderRadius: 2 }} />
          Oil (BBL/mo)
        </span>
        {hasGas && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 10, background: COLORS.green, display: "inline-block", borderRadius: 2, opacity: 0.7 }} />
            Gas (MCF/mo, right axis)
          </span>
        )}
        {hasWater && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 4, background: "rgba(239,68,68,0.4)", display: "inline-block", borderRadius: 1 }} />
            Water (BBL/mo)
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W, height: "auto", display: "block" }}>
        {/* Grid lines */}
        {yLabels.map((yl, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={yl.y} x2={PAD_L + innerW} y2={yl.y}
              stroke={COLORS.border} strokeWidth={i === 0 ? 1 : 0.5} strokeDasharray={i === 0 ? "none" : "3,3"} />
            <text x={PAD_L - 4} y={yl.y + 3} fill={COLORS.textFaint} fontSize="7" textAnchor="end">{yl.label}</text>
          </g>
        ))}
        {/* X axis */}
        <line x1={PAD_L} y1={PAD_T + innerH} x2={PAD_L + innerW} y2={PAD_T + innerH} stroke={COLORS.border} strokeWidth={1} />

        {/* Bars */}
        {sorted.map((r, i) => {
          const x = PAD_L + i * (innerW / sorted.length) + 1;
          const oilH = (r.oil_bbl / maxOil) * innerH;
          const waterH = hasWater && r.water_bbl != null ? Math.min((r.water_bbl / maxOil) * innerH, innerH) : 0;
          const barColor = r.oil_bbl === 0 ? COLORS.red + "80" : COLORS.accent;

          // X label every ~6 months
          const showLabel = i === 0 || i === sorted.length - 1 || i % 6 === 0;

          return (
            <g key={i}>
              {/* Water bar (background, red-tinted) */}
              {hasWater && waterH > 0 && (
                <rect
                  x={x} y={PAD_T + innerH - waterH}
                  width={barW} height={waterH}
                  fill="rgba(239,68,68,0.2)"
                />
              )}
              {/* Oil bar */}
              {oilH > 0 && (
                <rect
                  x={x} y={PAD_T + innerH - oilH}
                  width={barW} height={oilH}
                  fill={barColor}
                  rx={1}
                />
              )}
              {/* Zero-production marker */}
              {r.oil_bbl === 0 && (
                <rect x={x} y={PAD_T + innerH - 3} width={barW} height={3} fill={COLORS.red} opacity={0.5} />
              )}
              {/* Gas line (if present) */}
              {hasGas && r.gas_mcf > 0 && i > 0 && sorted[i - 1].gas_mcf > 0 && (() => {
                const prevX = PAD_L + (i - 1) * (innerW / sorted.length) + 1 + barW / 2;
                const prevY = yTick(sorted[i - 1].gas_mcf, maxGas);
                const currX = x + barW / 2;
                const currY = yTick(r.gas_mcf, maxGas);
                return (
                  <line x1={prevX} y1={prevY} x2={currX} y2={currY}
                    stroke={COLORS.green} strokeWidth={1.2} opacity={0.7} />
                );
              })()}
              {/* X-axis label */}
              {showLabel && (
                <text x={x + barW / 2} y={H - 5} fill={COLORS.textFaint} fontSize="6.5" textAnchor="middle">
                  {r.period.slice(0, 7)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ProductionTab({ report }: { report: DDReport }) {
  const s = report.production;
  const inv = report.lease_well_inventory;
  return (
    <>
      {/* ── MULTI-WELL LEASE ATTRIBUTION WARNING ───────────────────────────── */}
      {/* Manus spec §8: production is ALWAYS lease-level unless allocation evidence exists */}
      {inv && (
        <div style={{
          padding: "0.75rem 1rem",
          borderRadius: 7,
          marginBottom: "1rem",
          background: "#eff6ff",
          border: "1px solid #bfdbfe",
          fontSize: "0.83rem",
          color: "#1e3a8a",
          lineHeight: 1.6,
        }}>
          <strong>⚠ Lease-Level Production ({inv.well_count > 0 ? `${inv.well_count} wells` : "well count unknown"})</strong>
          <br />
          {inv.lease_level_warning}
        </div>
      )}
      {!inv && (
        <div style={{
          padding: "0.65rem 0.9rem",
          borderRadius: 6,
          marginBottom: "0.85rem",
          background: "#fef3c7",
          border: "1px solid #fcd34d",
          fontSize: "0.82rem",
          color: "#92400e",
          fontWeight: 600,
        }}>
          ⚠ Lease-well inventory not retrieved. Production figures represent RRC lease-level aggregate — not single-well production.
          Cannot assert per-well rates.
        </div>
      )}

      <Section title="Production Summary" icon="⛽">
        <KvRow label="Total Monthly Oil (BBL)">
          <DataCell dp={s.total_monthly_oil_bbl} format={n => fmtN(n, 0)} unit="BBL/mo" />
        </KvRow>
        {s.total_daily_oil_bbl.value != null && (
          <KvRow label="Daily Oil Rate (BOPD)">
            <span style={{ fontWeight: 800, fontSize: "1rem", color: COLORS.green }}>
              {s.total_daily_oil_bbl.value.toFixed(1)}
            </span>
            <span style={{ fontSize: "0.75rem", color: COLORS.textFaint, marginLeft: 6 }}>BOPD</span>
          </KvRow>
        )}
        <KvRow label="Total Monthly Gas (MCF)">
          <DataCell dp={s.total_monthly_gas_mcf} format={n => fmtN(n, 0)} unit="MCF/mo" />
        </KvRow>
        {(s.total_monthly_oil_bbl.value || s.total_monthly_gas_mcf.value) && (
          <KvRow label="Total BOE / Month">
            <span style={{ color: COLORS.text, fontWeight: 600 }}>
              {fmtBoe(s.total_monthly_oil_bbl.value ?? 0, s.total_monthly_gas_mcf.value ?? 0)}
            </span>
            <span style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginLeft: 8 }}>
              (oil + gas÷6)
            </span>
          </KvRow>
        )}
        <KvRow label="Total Monthly Water (BBL)">
          <DataCell dp={s.total_monthly_water_bbl} format={n => fmtN(n, 0)} unit="BBL/mo" />
        </KvRow>
        <KvRow label="Water Cut %">
          <DataCell dp={s.water_cut_pct} format={fmtPct} />
        </KvRow>
        <KvRow label="Decline Rate (% / month)">
          <DataCell dp={s.decline_rate_pct_monthly} format={fmtPct} />
        </KvRow>
        <KvRow label="Production Trend">
          <DataCell dp={s.production_trend} format={v => v} />
        </KvRow>
        <KvRow label="Last Production Date">
          <DataCell dp={s.last_production_date} format={v => v} />
        </KvRow>
        {(() => {
          const totalRows = s.wells.reduce((n, w) => n + w.monthly_history.length, 0);
          const firstPeriod = s.wells.flatMap(w => w.monthly_history).sort((a, b) => a.period < b.period ? -1 : 1)[0]?.period ?? null;
          if (totalRows === 0) return null;
          return (
            <KvRow label="Production History Depth">
              <span style={{ fontWeight: 600, color: COLORS.text }}>
                {totalRows.toLocaleString()} months
              </span>
              {firstPeriod && (
                <span style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginLeft: 8 }}>
                  (from {firstPeriod} · {Math.round(totalRows / 12)} years of RRC data)
                </span>
              )}
            </KvRow>
          );
        })()}
        <KvRow label="Reserve Report">
          <DataCell dp={s.reserve_report_present} format={v => v ? "Provided" : "Not provided"} />
        </KvRow>
        {s.reserve_pv10.value && (
          <KvRow label="Reserve PV10">
            <DataCell dp={s.reserve_pv10} format={fmt$} />
          </KvRow>
        )}
      </Section>

      {/* Production history + DCA projection chart */}
      {s.wells.some(w => w.monthly_history.length > 0) && (
        <Section title="Production History & Decline Projection" icon="📈">
          <ProductionDeclineChart report={report} />
          <p style={{ fontSize: "0.68rem", color: COLORS.textFaint, margin: "0.5rem 0 0 0" }}>
            Chart shows most recent 36 months; full history (up to 40 years) used for DCA and averages.
            Dashed line = Arps DCA projection. TRRC data may lag current operations by 3–5 months.
          </p>
        </Section>
      )}

      {s.wells.length > 0 && (
        <Section title="Well-Level Production" icon="🛢️">
          <DdTable
            headers={["Well / Lease", "API", "Latest BBL/mo", "BOPD", "3-Mo Avg", "6-Mo Avg", "12-Mo Avg", "Water Cut", "Trend", "Cum Oil BBL", "Source"]}
            rows={s.wells.map(w => [
              w.well_name,
              w.api,
              <DataCell key="oil"  dp={w.latest_monthly_oil_bbl} format={n => fmtN(n, 0)} />,
              <span key="bopd" style={{ fontWeight: 700, color: w.latest_daily_oil_bbl.value != null ? COLORS.green : COLORS.textFaint }}>
                {w.latest_daily_oil_bbl.value != null ? `${w.latest_daily_oil_bbl.value.toFixed(1)}` : "—"}
              </span>,
              <DataCell key="a3"   dp={w.three_month_avg_bbl}    format={n => fmtN(n, 0)} />,
              <DataCell key="a6"   dp={w.six_month_avg_bbl}      format={n => fmtN(n, 0)} />,
              <DataCell key="a12"  dp={w.twelve_month_avg_bbl}   format={n => fmtN(n, 0)} />,
              <DataCell key="wc"   dp={w.water_cut_pct}          format={fmtPct} />,
              <DataCell key="tr"   dp={w.production_trend}       format={v => v} />,
              <DataCell key="cum"  dp={w.cum_oil_bbl}            format={n => fmtN(n, 0)} />,
              <SourceBadge key="src" source={w.latest_monthly_oil_bbl.source} confidence={w.latest_monthly_oil_bbl.confidence} sourceDetail={w.latest_monthly_oil_bbl.source_detail} />,
            ])}
          />
        </Section>
      )}

      {s.notes.map((note, i) => (
        <div key={i} style={{
          background: COLORS.redDim,
          border: `1px solid ${COLORS.red}30`,
          borderRadius: 8,
          padding: "0.75rem 1rem",
          color: COLORS.text,
          fontSize: "0.82rem",
          marginBottom: "0.5rem",
        }}>
          ⚠️ {note}
        </div>
      ))}
    </>
  );
}

function EconomicsTab({ report }: { report: DDReport }) {
  const s = report.economics;
  return (
    <>
      <Section title="Economics Summary" icon="📊">
        <KvRow label="LOE Months Available">{s.loe_months_available}</KvRow>
        <KvRow label="Avg Monthly LOE">
          <DataCell dp={s.avg_monthly_loe_usd} format={fmt$} />
        </KvRow>
        <KvRow label="Avg Monthly Revenue">
          <DataCell dp={s.avg_monthly_revenue_usd} format={fmt$} />
        </KvRow>
        <KvRow label="Avg Monthly Net Income">
          <DataCell dp={s.avg_monthly_net_income_usd} format={fmt$} />
        </KvRow>
        <KvRow label="LOE per BOE">
          <DataCell dp={s.loe_per_boe} format={fmt$} unit="/ BOE" />
        </KvRow>
        <KvRow label="Severance / Prod. Tax">
          <span style={{ color: COLORS.textMuted, fontSize: "0.8rem" }}>
            TX: 4.6% oil + 7.5% gas (included in economics)
          </span>
        </KvRow>
        <KvRow label="Oil Price Received">
          <DataCell dp={s.oil_price_received} format={fmt$} unit="/ BBL" />
        </KvRow>
        <KvRow label="Gas Price Received">
          <DataCell dp={s.gas_price_received} format={n => n.toFixed(2)} unit="/ MCF" />
        </KvRow>
      </Section>

      <Section title="Operating Cost Breakdown" icon="💵">
        <KvRow label="Electricity / Month">
          <DataCell dp={s.electricity_cost_monthly} format={fmt$} />
        </KvRow>
        <KvRow label="Chemical / Month">
          <DataCell dp={s.chemical_cost_monthly} format={fmt$} />
        </KvRow>
        <KvRow label="Labor / Month">
          <DataCell dp={s.labor_cost_monthly} format={fmt$} />
        </KvRow>
        <KvRow label="Water Disposal / Month">
          <DataCell dp={s.disposal_cost_monthly} format={fmt$} />
        </KvRow>
        <KvRow label="Compression / Month">
          <DataCell dp={s.compression_cost_monthly} format={fmt$} />
        </KvRow>
        <KvRow label="Run Tickets Present">
          <DataCell dp={s.run_tickets_present} format={v => v ? "Yes" : "Not provided"} />
        </KvRow>
        <KvRow label="Purchaser Statements">
          <DataCell dp={s.purchaser_statements_present} format={v => v ? "Yes" : "Not provided"} />
        </KvRow>
      </Section>

      {s.loe_statements.length > 0 && (
        <Section title={`LOE Statements (${s.loe_statements.length} periods)`} icon="📃">
          <DdTable
            headers={["Period", "Total LOE", "Revenue", "Net Income", "Oil $/BBL", "Confidence", "Source"]}
            rows={s.loe_statements.map(stmt => [
              stmt.period,
              stmt.total_loe_usd != null ? fmt$(stmt.total_loe_usd) : <span style={{ color: COLORS.textFaint }}>—</span>,
              stmt.revenue_usd != null ? fmt$(stmt.revenue_usd) : <span style={{ color: COLORS.textFaint }}>—</span>,
              stmt.net_income_usd != null ? fmt$(stmt.net_income_usd) : <span style={{ color: COLORS.textFaint }}>—</span>,
              stmt.oil_price_per_bbl != null ? `$${stmt.oil_price_per_bbl.toFixed(2)}` : <span style={{ color: COLORS.textFaint }}>—</span>,
              <ConfBadge key="conf" confidence={stmt.confidence} />,
              <SourceBadge key="src" source={stmt.source} sourceDetail={stmt.source_detail} />,
            ])}
          />
        </Section>
      )}
    </>
  );
}

function WorkoversTab({ report }: { report: DDReport }) {
  const s = report.workovers;
  return (
    <>
      <Section title="Workover Summary" icon="🔧">
        <KvRow label="Total Workover Cost">
          <DataCell dp={s.total_workover_cost_usd} format={fmt$} />
        </KvRow>
        <KvRow label="Avg Annual Workover Cost">
          <DataCell dp={s.avg_annual_workover_cost_usd} format={fmt$} />
        </KvRow>
        <KvRow label="Last Workover Date">
          <DataCell dp={s.last_workover_date} format={v => v} />
        </KvRow>
      </Section>
      {s.events.length > 0 && (
        <Section title="Workover & Maintenance History" icon="📋">
          <DdTable
            headers={["Date", "Well", "Type", "Cost", "Result", "Source"]}
            rows={s.events.map(e => [
              e.date ?? "—",
              e.well ?? "—",
              e.type,
              e.cost_usd != null ? fmt$(e.cost_usd) : "—",
              e.result ?? "—",
              <SourceBadge key="src" source={e.source} sourceDetail={e.source_detail} />,
            ])}
          />
        </Section>
      )}
      {s.notes.map((n, i) => (
        <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.5rem 0" }}>⚠️ {n}</div>
      ))}
    </>
  );
}

function EquipmentTab({ report }: { report: DDReport }) {
  const s = report.equipment;
  return (
    <>
      <Section title="Equipment Summary" icon="⚙️">
        <KvRow label="Total Est. Equipment Value">
          <DataCell dp={s.total_estimated_value_usd} format={fmt$} />
        </KvRow>
      </Section>
      {s.items.length > 0 && (
        <Section title="Equipment Inventory" icon="📦">
          <DdTable
            headers={["Type", "Qty", "Condition", "Age (yrs)", "Est. Value", "Notes", "Source"]}
            rows={s.items.map(e => [
              e.type,
              e.quantity != null ? String(e.quantity) : "—",
              e.condition ?? "—",
              e.age_years != null ? String(e.age_years) : "—",
              e.estimated_value_usd != null ? fmt$(e.estimated_value_usd) : "—",
              e.notes ?? "—",
              <SourceBadge key="src" source={e.source} />,
            ])}
          />
        </Section>
      )}
      {s.notes.map((n, i) => (
        <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.5rem 0" }}>⚠️ {n}</div>
      ))}
    </>
  );
}

function ComplianceTab({ report }: { report: DDReport }) {
  const s = report.compliance;
  const hasInspections = (s.inspection_records?.length ?? 0) > 0;
  const nonCompliantInspections = s.inspection_records?.filter(r => r.result === "non_compliant") ?? [];
  const dv = report.district_violations;
  const inv = report.lease_well_inventory;
  return (
    <>
      {/* ── DISTRICT VIOLATION FILE (Manus spec §4.5 / §7.2) ──────────────── */}
      {/* This is the AUTHORITATIVE compliance source — full historical record. */}
      {/* A failed download is NOT clean compliance. */}
      <Section title="District Violation File (Official RRC Evidence)" icon="📂">
        {dv ? (
          <>
            {/* Status banner */}
            <div style={{
              padding: "0.65rem 0.9rem",
              borderRadius: 6,
              marginBottom: "0.75rem",
              fontSize: "0.84rem",
              fontWeight: 600,
              background: dv.status === "download_failed" || dv.status === "parse_error"
                ? "#fee2e2"
                : dv.status === "no_url_for_district"
                  ? "#fef3c7"
                  : dv.match_count > 0
                    ? "#fee2e2"
                    : "#d1fae5",
              color: dv.status === "download_failed" || dv.status === "parse_error"
                ? COLORS.red
                : dv.status === "no_url_for_district"
                  ? "#92400e"
                  : dv.match_count > 0
                    ? COLORS.red
                    : "#065f46",
              border: "1px solid",
              borderColor: dv.status === "download_failed" || dv.status === "parse_error"
                ? "#fca5a5"
                : dv.status === "no_url_for_district"
                  ? "#fcd34d"
                  : dv.match_count > 0
                    ? "#fca5a5"
                    : "#6ee7b7",
            }}>
              {dv.status === "download_failed"     && "⛔ DOWNLOAD FAILED — Compliance status UNVERIFIED. Cannot claim clean compliance."}
              {dv.status === "parse_error"          && "⚠ PARSE ERROR — District file downloaded but could not be parsed. Compliance unverified."}
              {dv.status === "no_url_for_district"  && "⚠ District violation file URL not found. Compliance unverified for this district."}
              {dv.status === "success" && dv.match_count > 0 && `🚨 ${dv.match_count} violation record(s) found in District ${dv.district} official file.`}
              {dv.status === "success" && dv.match_count === 0 && `✓ Confirmed clean — 0 matching records in District ${dv.district} official file (${dv.total_rows_in_file.toLocaleString()} total rows searched).`}
            </div>

            <KvRow label="Source"><a href={dv.source_url ?? "#"} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.78rem", color: "#1d4ed8", wordBreak: "break-all" }}>{dv.source_url ?? "—"}</a></KvRow>
            <KvRow label="District">{dv.district}</KvRow>
            <KvRow label="Status">{dv.status}</KvRow>
            {dv.raw_sha256 && <KvRow label="File SHA-256"><span style={{ fontFamily: "monospace", fontSize: "0.72rem" }}>{dv.raw_sha256.slice(0, 24)}…</span></KvRow>}
            {dv.total_rows_in_file > 0 && <KvRow label="Total rows in file">{dv.total_rows_in_file.toLocaleString()}</KvRow>}
            <KvRow label="Matching records">{dv.match_count}</KvRow>
            <KvRow label="Confirmed clean">{dv.confirmed_clean ? "Yes" : "No"}</KvRow>
            <KvRow label="Query time"><span style={{ fontSize: "0.75rem", color: COLORS.textMuted }}>{dv.query_timestamp}</span></KvRow>

            {/* District violation records table */}
            {dv.matching_violations.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: "0.4rem", color: COLORS.red }}>
                  {dv.matching_violations.length} Matching Violation Record(s)
                </div>
                <DdTable
                  headers={["ID", "Date", "Type", "Description", "Status"]}
                  rows={dv.matching_violations.map(v => [
                    v.violation_id ?? "—",
                    v.date ?? "—",
                    v.type,
                    v.description,
                    <span key="st" style={{ color: v.status === "open" ? COLORS.red : v.status === "closed" ? COLORS.green : COLORS.textMuted, fontWeight: 600, textTransform: "capitalize" as const }}>{v.status}</span>,
                  ])}
                />
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: "0.65rem 0.9rem", borderRadius: 6, background: "#fef3c7", fontSize: "0.84rem", color: "#92400e", fontWeight: 600 }}>
            ⚠ District violation file not downloaded. Compliance status UNVERIFIED — do not claim clean compliance.
          </div>
        )}
      </Section>

      {/* ── LEASE-WELL INVENTORY (Manus spec §4.3 / §8) ───────────────────── */}
      {/* canClaimSingleWellProduction is ALWAYS false without allocation evidence */}
      <Section title="Lease-Well Inventory" icon="🗂">
        {inv ? (
          <>
            <div style={{
              padding: "0.65rem 0.9rem",
              borderRadius: 6,
              marginBottom: "0.75rem",
              fontSize: "0.84rem",
              fontWeight: 600,
              background: inv.query_failed ? "#fef3c7" : inv.well_count > 1 ? "#eff6ff" : "#f0fdf4",
              color: inv.query_failed ? "#92400e" : inv.well_count > 1 ? "#1d4ed8" : "#065f46",
              border: "1px solid",
              borderColor: inv.query_failed ? "#fcd34d" : inv.well_count > 1 ? "#bfdbfe" : "#6ee7b7",
            }}>
              {inv.query_failed
                ? "⚠ Lease-well inventory query failed — well count unknown."
                : `${inv.well_count} well(s) discovered on Lease ${inv.lease_number} / District ${inv.district_code}`}
            </div>

            {/* Multi-well lease attribution warning */}
            <div style={{ padding: "0.7rem 0.9rem", borderRadius: 6, background: "#eff6ff", fontSize: "0.82rem", color: "#1e3a8a", marginBottom: "0.75rem", lineHeight: 1.5 }}>
              <strong>⚠ Multi-Well Lease Attribution:</strong> {inv.lease_level_warning}
            </div>

            <KvRow label="District">{inv.district_code}</KvRow>
            <KvRow label="Lease">{inv.lease_number}</KvRow>
            <KvRow label="Well count">{inv.query_failed ? "Unknown" : inv.well_count}</KvRow>
            <KvRow label="Single-well production claim">
              <span style={{ color: COLORS.red, fontWeight: 700 }}>NOT PERMITTED — Lease-level only</span>
            </KvRow>
            <KvRow label="Query time"><span style={{ fontSize: "0.75rem", color: COLORS.textMuted }}>{inv.query_timestamp}</span></KvRow>

            {/* Well inventory table */}
            {inv.wells.length > 0 && (
              <div style={{ marginTop: "0.75rem" }}>
                <DdTable
                  headers={["API-10", "Well #", "Type", "Status", "Operator", "County"]}
                  rows={inv.wells.slice(0, 60).map(w => [
                    w.api10,
                    w.well_number ?? "—",
                    w.well_type ?? "—",
                    w.status ?? "—",
                    w.operator_name ?? "—",
                    w.county ?? "—",
                  ])}
                />
                {inv.wells.length > 60 && (
                  <div style={{ fontSize: "0.78rem", color: COLORS.textMuted, marginTop: "0.4rem" }}>
                    Showing 60 of {inv.well_count} wells. Full inventory in evidence trace.
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: "0.65rem 0.9rem", borderRadius: 6, background: "#fef3c7", fontSize: "0.84rem", color: "#92400e", fontWeight: 600 }}>
            ⚠ Lease-well inventory not retrieved. Well count unknown — do not assert single-well production.
          </div>
        )}
      </Section>

      {/* ── Field Inspection Records (ICE) ── */}
      <Section title="Field Inspection Records (ICE)" icon="🔍">
        <KvRow label="Most Recent Inspection">
          <DataCell dp={s.most_recent_inspection_date} format={v => v} />
        </KvRow>
        <KvRow label="Most Recent Result">
          <DataCell dp={s.most_recent_inspection_result} format={v => {
            if (v === "non_compliant") return "⚠️ Non-Compliant";
            if (v === "compliant")     return "✓ Compliant";
            return "Unknown";
          }} />
        </KvRow>
        {s.notes.map((n, i) => (
          <div key={i} style={{ fontSize: "0.82rem", color: n.startsWith("⚠") ? COLORS.red : COLORS.textMuted, padding: "0.25rem 0", fontStyle: "italic" }}>{n}</div>
        ))}
      </Section>

      {/* ── ICE Inspection Detail Table ── */}
      {hasInspections && (
        <Section title={`Inspection History (${s.inspection_records.length} record${s.inspection_records.length !== 1 ? "s" : ""})`} icon="📋">
          <DdTable
            headers={["API", "Date", "Type", "Result", "Defect / Notes"]}
            rows={s.inspection_records.map(r => [
              r.api,
              r.inspection_date ?? "—",
              r.inspection_type ?? "—",
              <span key="res" style={{
                color: r.result === "non_compliant" ? COLORS.red : r.result === "compliant" ? COLORS.green : COLORS.textMuted,
                fontWeight: 600,
              }}>
                {r.result === "non_compliant" ? "⚠ Non-Compliant" : r.result === "compliant" ? "Compliant" : "Unknown"}
              </span>,
              r.defect_summary ?? r.notes ?? "—",
            ])}
          />
          {nonCompliantInspections.length > 0 && (
            <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.85rem", background: "#fee2e2", borderRadius: 6, fontSize: "0.83rem", color: COLORS.red }}>
              <strong>⚠ Action Required:</strong> {nonCompliantInspections.length} non-compliant inspection(s) found.
              Review defect details and confirm resolution with operator. Request deficiency correction documentation.
            </div>
          )}
        </Section>
      )}

      {/* ── Violations ── */}
      <Section title="Violation Database" icon="🚨">
        <KvRow label="RRC Good Standing">
          <DataCell dp={s.rrc_good_standing} format={v => v ? "Yes — No open violations" : "No — Open violations found"} />
        </KvRow>
        <KvRow label="Open Violations">
          <DataCell dp={s.open_violation_count} format={n => `${n} open`} />
        </KvRow>
        <KvRow label="Most Recent Violation">
          <DataCell dp={s.most_recent_violation_date} format={v => v} />
        </KvRow>
      </Section>

      <Section title="Bonding" icon="🔒">
        <KvRow label="Bond Amount">
          <DataCell dp={s.bond_amount_usd} format={fmt$} />
        </KvRow>
        <KvRow label="Bond Type">
          <DataCell dp={s.bond_type} format={v => v} />
        </KvRow>
        <KvRow label="Bond Number">
          <DataCell dp={s.bond_number} format={v => v} />
        </KvRow>
        <KvRow label="Bonding Company">
          <DataCell dp={s.bonding_company} format={v => v} />
        </KvRow>
      </Section>
      {s.violations.length > 0 && (
        <Section title="Violation Detail" icon="📄">
          <DdTable
            headers={["ID", "Date", "Type", "Description", "Status", "Penalty", "Source"]}
            rows={s.violations.map(v => [
              v.violation_id ?? "—",
              v.date ?? "—",
              v.type,
              v.description,
              <span key="st" style={{
                color: v.status === "open" ? COLORS.red : v.status === "closed" ? COLORS.green : COLORS.textMuted,
                fontWeight: 600,
                textTransform: "capitalize",
              }}>{v.status}</span>,
              v.penalty_usd != null ? fmt$(v.penalty_usd) : "—",
              <SourceBadge key="src" source={v.source} />,
            ])}
          />
        </Section>
      )}
    </>
  );
}

function PluggingTab({ report }: { report: DDReport }) {
  const s = report.plugging_liability;
  return (
    <>
      <Section title="Plugging Liability Summary" icon="🔌">
        <KvRow label="Inactive / Shut-in Wells">
          <DataCell dp={s.inactive_well_count} format={n => `${n} well(s)`} />
        </KvRow>
        <KvRow label="Total Est. Plug Cost">
          <DataCell dp={s.total_estimated_plug_cost_usd} format={fmt$} />
        </KvRow>
        <KvRow label="Orphan Well Risk">
          <DataCell dp={s.orphan_well_risk} format={v => v.charAt(0).toUpperCase() + v.slice(1)} />
        </KvRow>
      </Section>
      {s.wells.length > 0 && (
        <Section title="Well Status Detail" icon="🛢️">
          <DdTable
            headers={["API", "Well Name", "Status", "Inactive Since", "Est. Plug Cost", "RRC Order", "Source"]}
            rows={s.wells.map(w => [
              w.api,
              w.well_name ?? "—",
              w.status,
              w.inactive_since ?? "—",
              w.estimated_plug_cost_usd != null ? fmt$(w.estimated_plug_cost_usd) : "—",
              w.rrc_plugging_order ? <span key="ord" style={{ color: COLORS.red }}>Yes</span> : "No",
              <SourceBadge key="src" source={w.source} />,
            ])}
          />
        </Section>
      )}
      {s.notes.map((n, i) => (
        <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.5rem 0" }}>ℹ️ {n}</div>
      ))}
    </>
  );
}

function InjectionTab({ report }: { report: DDReport }) {
  const s = report.injection;
  const hasSwd = s.wells.length > 0 && s.swd_disposal_revenue_monthly.value != null;
  return (
    <>
      <Section title="SWD / Injection Summary" icon="💧">
        <KvRow label="Total Disposal Capacity">
          <DataCell dp={s.total_disposal_capacity_bwpd} format={n => `${fmtN(n)} BWPD`} />
        </KvRow>
        <KvRow label="Current Utilization">
          <DataCell dp={s.current_utilization_pct} format={fmtPct} />
        </KvRow>
        {s.swd_disposal_rate_per_bbl != null && (
          <KvRow label="Disposal Rate (est.)">
            <span style={{ color: COLORS.text, fontWeight: 600 }}>
              ${s.swd_disposal_rate_per_bbl.toFixed(2)}/BBL
            </span>
            <span style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginLeft: 8 }}>basin estimate — verify with disposal contracts</span>
          </KvRow>
        )}
      </Section>

      {hasSwd && (
        <Section title="SWD Economics (Estimated)" icon="💵">
          <div style={{
            background: COLORS.yellowDim,
            border: `1px solid ${COLORS.yellow}30`,
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
            fontSize: "0.72rem",
            color: COLORS.yellow,
            marginBottom: "0.75rem",
          }}>
            ⚠️ INFERRED — These are estimated economics based on permitted capacity and basin-average disposal rates.
            Request actual injection volumes and disposal contracts to confirm.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem", marginBottom: "0.75rem" }}>
            {[
              { label: "Monthly Disposal Revenue", dp: s.swd_disposal_revenue_monthly },
              { label: "Monthly Operating Cost",   dp: s.swd_operating_cost_monthly   },
              { label: "Monthly Net Income",        dp: s.swd_net_income_monthly       },
            ].map(({ label, dp: dpVal }) => (
              <div key={label} style={{
                background: COLORS.surface,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                padding: "0.75rem 1rem",
              }}>
                <div style={{ fontSize: "0.65rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                  {label}
                </div>
                <div style={{ fontSize: "1rem", fontWeight: 700, color: COLORS.text }}>
                  {dpVal.value != null ? fmt$(dpVal.value) : "—"}
                </div>
                <div style={{ marginTop: 4 }}>
                  <SourceBadge source={dpVal.source} confidence={dpVal.confidence} />
                </div>
              </div>
            ))}
          </div>
          <KvRow label="Annualized SWD Net Income">
            <DataCell dp={s.swd_annual_net_income} format={fmt$} />
          </KvRow>
          {s.swd_economics_notes.map((n, i) => (
            <div key={i} style={{ fontSize: "0.75rem", color: COLORS.textMuted, padding: "0.2rem 0" }}>• {n}</div>
          ))}
        </Section>
      )}
      {s.wells.length > 0 && (
        <Section title="Injection Well Detail" icon="🔩">
          <DdTable
            headers={["API", "Well Name", "Type", "Zone", "Depth", "Max Vol (BWPD)", "Max Press (PSI)", "MIT Status", "Last MIT"]}
            rows={s.wells.map(w => [
              w.api,
              w.well_name ?? "—",
              w.well_type,
              w.injection_zone ?? "—",
              w.depth_ft != null ? `${fmtN(w.depth_ft)} ft` : "—",
              <DataCell key="vol" dp={w.permitted_max_volume_bwpd} format={n => fmtN(n)} />,
              <DataCell key="psi" dp={w.permitted_max_pressure_psi} format={n => fmtN(n)} />,
              <DataCell key="mit" dp={w.mit_status} format={v => v} />,
              <DataCell key="lmit" dp={w.last_mit_date} format={v => v} />,
            ])}
          />
        </Section>
      )}
      {s.notes.map((n, i) => (
        <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.5rem 0" }}>ℹ️ {n}</div>
      ))}
    </>
  );
}

// ─── Imaged Records Tab ───────────────────────────────────────────────────────
//
// Displays TRRC Layer 2 filed document links (W-1, W-2, G-1, P-4).
// Each record has a direct one-click link to the TRRC PDF viewer.

const DOC_TYPE_COLORS: Record<string, string> = {
  "W-1": "#3b82f6", "W-2": "#22c55e", "G-1": "#f97316",
  "P-4": "#ef4444", "W-10": "#a855f7", "OG-2": "#64748b", "OTHER": "#94a3b8",
};

function ImagedRecordsTab({ report }: { report: DDReport }) {
  const s = report.imaged_records;
  if (!s) {
    return (
      <Section title="TRRC Imaged Records" icon="📄">
        <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
          Imaged records are available on full diligence runs with an API number. Re-run in full mode to fetch W-1, W-2, G-1, and P-4 links.
        </div>
      </Section>
    );
  }

  const tierColors: Record<string, string> = {
    verified: COLORS.green, partially_verified: COLORS.yellow,
    searched_no_records: COLORS.accent, query_failed: COLORS.red, missing: COLORS.textFaint, not_applicable: COLORS.textFaint,
  };
  const tierColor = tierColors[s.diligence_tier] ?? COLORS.textFaint;

  return (
    <>
      <Section title="TRRC Imaged Records (Layer 2)" icon="📄">
        {/* Status banner */}
        <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <span style={{ background: tierColor + "18", color: tierColor, border: `1px solid ${tierColor}40`, borderRadius: 6, padding: "0.25rem 0.65rem", fontSize: "0.72rem", fontWeight: 700 }}>
            {s.diligence_tier === "verified" ? "✓ Completion report found" :
             s.diligence_tier === "partially_verified" ? "⚠ Partial records found" :
             s.diligence_tier === "searched_no_records" ? "Searched — no documents found" :
             s.diligence_tier === "query_failed" ? "✗ Query failed" : "Unknown"}
          </span>
          {s.has_completion_report && <span style={{ color: COLORS.green, fontSize: "0.72rem", fontWeight: 600 }}>✓ W-2 Completion Report</span>}
          {s.has_plugging_record   && <span style={{ color: COLORS.red,   fontSize: "0.72rem", fontWeight: 600 }}>⚠ P-4 Plugging Record</span>}
        </div>

        {/* Quick-access links */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          {s.latest_completion_url && (
            <a href={s.latest_completion_url} target="_blank" rel="noopener noreferrer"
              style={{ background: COLORS.greenDim, color: COLORS.green, border: `1px solid ${COLORS.green}40`, borderRadius: 6, padding: "0.35rem 0.75rem", fontSize: "0.75rem", fontWeight: 700, textDecoration: "none" }}>
              Open Completion Report →
            </a>
          )}
          {s.latest_plugging_url && (
            <a href={s.latest_plugging_url} target="_blank" rel="noopener noreferrer"
              style={{ background: COLORS.redDim, color: COLORS.red, border: `1px solid ${COLORS.red}40`, borderRadius: 6, padding: "0.35rem 0.75rem", fontSize: "0.75rem", fontWeight: 700, textDecoration: "none" }}>
              Open P-4 Plugging Record →
            </a>
          )}
          {s.neubus_viewer_url && (
            <a href={s.neubus_viewer_url} target="_blank" rel="noopener noreferrer"
              style={{ background: COLORS.accent + "15", color: COLORS.accent, border: `1px solid ${COLORS.accent}40`, borderRadius: 6, padding: "0.35rem 0.75rem", fontSize: "0.75rem", fontWeight: 700, textDecoration: "none" }}>
              All Imaged Records (Neubus) →
            </a>
          )}
        </div>

        {/* All records table */}
        {s.records.length > 0 ? (
          <DdTable
            headers={["Document Type", "Filing Date", "Operator", "Action"]}
            rows={s.records.map(r => [
              <span key="type" style={{ background: (DOC_TYPE_COLORS[r.doc_type] ?? COLORS.accent) + "18", color: DOC_TYPE_COLORS[r.doc_type] ?? COLORS.accent, borderRadius: 5, padding: "0.15rem 0.45rem", fontSize: "0.72rem", fontWeight: 700 }}>
                {r.doc_type} — {r.doc_label}
              </span>,
              r.filing_date ?? "—",
              r.operator ?? "—",
              <a key="link" href={r.viewer_url} target="_blank" rel="noopener noreferrer"
                style={{ color: COLORS.accent, fontSize: "0.75rem", fontWeight: 600, textDecoration: "none" }}>
                View →
              </a>,
            ])}
          />
        ) : (
          <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
            {s.query_succeeded
              ? "No completion packets found in TRRC CMPL for this API (covers Nov 2009 onward). Pre-2009 records may exist in Neubus — use the button above to search."
              : "CMPL query failed. Use the Neubus link above to search imaged records directly."}
          </div>
        )}
      </Section>

      {/* Why this matters */}
      <Section title="About Imaged Records (Layer 2)" icon="ℹ️">
        <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", lineHeight: 1.7 }}>
          <p style={{ marginBottom: "0.5rem" }}><strong style={{ color: COLORS.text }}>W-2 Completion Report</strong> — Confirms target formation, perforation intervals, total depth, and artificial lift type directly from the driller&apos;s filed report. Upgrades formation and depth data from &quot;model estimate&quot; to TRRC Layer 2 evidence.</p>
          <p style={{ marginBottom: "0.5rem" }}><strong style={{ color: COLORS.text }}>W-1 Drilling Permit</strong> — Confirms the original permitted depth and formation. Useful for identifying permitted vs. completed depth discrepancies.</p>
          <p style={{ marginBottom: "0.5rem" }}><strong style={{ color: COLORS.text }}>P-4 Plugging Record</strong> — If present, confirms the well has been plugged and abandoned. A P-4 for a well shown as &quot;active&quot; is a red flag requiring immediate clarification.</p>
          <p><strong style={{ color: COLORS.text }}>G-1 Gas Well Status</strong> — Initial potential test results filed with TRRC. Useful for verifying original gas deliverability and confirming formation.</p>
        </div>
      </Section>
    </>
  );
}

function ProrationP5Tab({ report }: { report: DDReport }) {
  const pro     = report.proration;
  const p5      = report.p5_operator_status;
  const plugging  = report.plugging_liability;
  const offsets   = report.offset_wells;
  const cmplDetail = report.cmpl_packet_detail;

  const flagColors: Record<string, string> = { green: COLORS.green, yellow: COLORS.yellow, red: COLORS.red };

  return (
    <>
      {/* ── P-5 Operator Status ─────────────────────────────────────────── */}
      <Section title="P-5 Operator Organization Status" icon="🏛️">
        {p5 ? (
          <>
            <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
              <span style={{
                background: (flagColors[p5.risk_flag] ?? COLORS.accent) + "18",
                color: flagColors[p5.risk_flag] ?? COLORS.accent,
                border: `1px solid ${flagColors[p5.risk_flag] ?? COLORS.accent}40`,
                borderRadius: 6, padding: "0.25rem 0.75rem", fontSize: "0.72rem", fontWeight: 700
              }}>
                {p5.risk_flag === "green" ? "✓ Active" : p5.risk_flag === "red" ? "⚠ Risk Flag" : "⚡ Active-Ext / Hold"}
              </span>
              <span style={{ color: COLORS.textMuted, fontSize: "0.78rem" }}>TRRC EWA P-5 Organization Query (live)</span>
            </div>
            <DdTable
              headers={["Field", "Value"]}
              rows={[
                ["Operator No.", p5.operator_no],
                ["Operator Name", p5.operator_name],
                ["Org Status", <span key="s" style={{ color: flagColors[p5.risk_flag], fontWeight: 700 }}>{p5.org_status}</span>],
                ["Org Type", p5.org_type ?? "—"],
                ["Mailing Address", [p5.mailing_address, p5.mailing_city, p5.mailing_state, p5.mailing_zip].filter(Boolean).join(", ") || "—"],
                ["Phone", p5.phone ?? "—"],
                ["TNR §91.114 Hold", <span key="tnr" style={{ color: p5.tnr_91114 ? COLORS.red : COLORS.green, fontWeight: 700 }}>{p5.tnr_91114 ? "YES — Blocks new permits" : "No"}</span>],
                ["Mail Hold", <span key="mh" style={{ color: p5.mail_hold ? COLORS.yellow : COLORS.green, fontWeight: 700 }}>{p5.mail_hold ? "YES" : "No"}</span>],
              ]}
            />
            {p5.tnr_91114 && (
              <div style={{ background: COLORS.redDim, border: `1px solid ${COLORS.red}40`, borderRadius: 6, padding: "0.6rem 0.75rem", marginTop: "0.75rem", color: COLORS.red, fontSize: "0.8rem" }}>
                ⚠ TNR §91.114 hold detected. TRRC will not issue new drilling or injection permits until all unsatisfied orders are resolved. Confirm status directly with operator.
              </div>
            )}
            {p5.org_status === "Delinquent" && (
              <div style={{ background: COLORS.redDim, border: `1px solid ${COLORS.red}40`, borderRadius: 6, padding: "0.6rem 0.75rem", marginTop: "0.75rem", color: COLORS.red, fontSize: "0.8rem" }}>
                ⚠ Delinquent P-5 status — operator's annual renewal is overdue. May indicate financial distress or operational issues. Verify bond and compliance status before closing.
              </div>
            )}
            {p5.org_status === "Active-Ext" && (
              <div style={{ background: COLORS.yellow + "15", border: `1px solid ${COLORS.yellow}40`, borderRadius: 6, padding: "0.6rem 0.75rem", marginTop: "0.75rem", color: COLORS.yellow, fontSize: "0.8rem" }}>
                ⚡ Active-Extension status — operator is on conditional extension. P-5 renewal is pending. Monitor for transition to Delinquent status.
              </div>
            )}
          </>
        ) : (
          <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
            P-5 operator status not yet fetched. Available on full diligence runs when an operator name is resolved.
          </div>
        )}
      </Section>

      {/* ── Proration Factors ──────────────────────────────────────────────── */}
      <Section title="TRRC Proration Factors" icon="⚖️">
        {pro && pro.records.length > 0 ? (
          <>
            <div style={{ color: COLORS.textMuted, fontSize: "0.75rem", marginBottom: "0.5rem" }}>
              Source: TRRC EWA oilProQueryAction / gasProQueryAction (live query)
            </div>
            <DdTable
              headers={["API", "District", "Field", "Well Type", "Potential", "GOR", "Acres", "Daily Allowable"]}
              rows={pro.records.map(r => [
                r.api8,
                r.district,
                r.field_name ?? "—",
                <span key="wt" style={{
                  background: (r.well_type ?? "").toUpperCase().includes("INJECTION") ? COLORS.accent + "18" : COLORS.greenDim,
                  color: (r.well_type ?? "").toUpperCase().includes("INJECTION") ? COLORS.accent : COLORS.green,
                  borderRadius: 5, padding: "0.12rem 0.4rem", fontSize: "0.7rem", fontWeight: 700
                }}>{r.well_type ?? "—"}</span>,
                r.potential !== null ? r.potential.toLocaleString() : "—",
                r.gor !== null ? r.gor.toLocaleString() : "—",
                r.acres !== null ? r.acres.toString() : "—",
                r.daily_allowable ?? "—",
              ])}
            />
            {pro.notes.map((n, i) => (
              <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.78rem", marginTop: "0.4rem" }}>• {n}</div>
            ))}
          </>
        ) : pro && pro.query_succeeded ? (
          <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
            No proration records found for this API. Well may be on a field-wide prorationing schedule or exempt. Verify directly at TRRC EWA.
          </div>
        ) : (
          <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
            Proration data available on full diligence runs with API number and district code.
          </div>
        )}
      </Section>

      {/* ── Plugging Liability (TRRC Inactive Wells) ───────────────────────── */}
      <Section title="TRRC Inactive Well / Plugging Liability" icon="🔩">
        <div style={{ display: "flex", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.6rem 1rem" }}>
            <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: 1 }}>Inactive Count</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, color: (plugging.inactive_well_count.value ?? 0) > 0 ? COLORS.red : COLORS.green }}>
              {plugging.inactive_well_count.value ?? 0}
            </div>
          </div>
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.6rem 1rem" }}>
            <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: 1 }}>Est. Plug Cost</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, color: COLORS.text }}>
              {plugging.total_estimated_plug_cost_usd.value != null
                ? `$${plugging.total_estimated_plug_cost_usd.value.toLocaleString()}`
                : "—"}
            </div>
          </div>
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.6rem 1rem" }}>
            <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: 1 }}>Orphan Risk</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, color: plugging.orphan_well_risk.value === "high" ? COLORS.red : plugging.orphan_well_risk.value === "medium" ? COLORS.yellow : COLORS.green }}>
              {plugging.orphan_well_risk.value ?? "—"}
            </div>
          </div>
        </div>

        {plugging.wells.length > 0 ? (
          <DdTable
            headers={["API", "Well Name", "Status", "Shut-In Date", "Est. Plug Cost", "Compliance Due"]}
            rows={plugging.wells.map(w => [
              w.api,
              w.well_name ?? "—",
              <span key="s" style={{ color: COLORS.yellow, fontSize: "0.72rem", fontWeight: 700 }}>{w.status}</span>,
              w.inactive_since ?? "—",
              w.estimated_plug_cost_usd != null ? `$${w.estimated_plug_cost_usd.toLocaleString()}` : "—",
              "—",
            ])}
          />
        ) : (
          <div style={{ background: COLORS.greenDim, border: `1px solid ${COLORS.green}40`, borderRadius: 6, padding: "0.6rem 0.75rem", color: COLORS.green, fontSize: "0.8rem" }}>
            ✓ Well is NOT on the TRRC inactive well list. No plugging liability identified from TRRC records.
          </div>
        )}

        {plugging.notes.map((n, i) => (
          <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.78rem", marginTop: "0.4rem" }}>• {n}</div>
        ))}
      </Section>

      {/* ── CMPL W-2 Packet Detail (Gap 1) ─────────────────────────────────── */}
      {cmplDetail && (
        <Section title="CMPL W-2 Packet Detail" icon="📋">
          <div style={{ color: COLORS.textMuted, fontSize: "0.75rem", marginBottom: "0.5rem" }}>
            Source: TRRC CMPL publicSearchAction.do → loadPacket (live query, trrc_imaged evidence tier)
          </div>
          <DdTable
            headers={["Field", "Value"]}
            rows={[
              ["Tracking No.", cmplDetail.tracking_no],
              ["Formation (Field Name)", cmplDetail.formation ?? "—"],
              ["Completion Type", cmplDetail.completion_type ?? "—"],
              ["Completion Date", cmplDetail.completion_date ?? "—"],
              ["Wellbore Profile", cmplDetail.wellbore_profile ?? "—"],
              ["Well Type", cmplDetail.well_type ?? "—"],
              ["Field No.", cmplDetail.field_no ?? "—"],
              ["Drilling Permit No.", cmplDetail.permit_no ?? "—"],
            ]}
          />
          {cmplDetail.formation && (
            <div style={{ background: COLORS.greenDim, border: `1px solid ${COLORS.green}40`, borderRadius: 6, padding: "0.5rem 0.75rem", marginTop: "0.5rem", color: COLORS.green, fontSize: "0.78rem" }}>
              ✓ Formation confirmed from TRRC CMPL W-2 record — evidence tier upgraded to <strong>trrc_imaged</strong>.
            </div>
          )}
        </Section>
      )}

      {/* ── OFFSET / NEARBY ACTIVITY (Gap 2) ───────────────────────────────── */}
      <Section title="OFFSET / NEARBY ACTIVITY" icon="🗺️">
        <div style={{ background: COLORS.accent + "10", border: `1px solid ${COLORS.accent}30`, borderRadius: 6, padding: "0.5rem 0.75rem", marginBottom: "0.75rem", color: COLORS.accent, fontSize: "0.75rem", fontWeight: 600 }}>
          ⚠ OFFSET / NEARBY ACTIVITY ONLY — these are wells in the same TRRC field formation, NOT subject-asset production. Do not use for rate or income estimates.
        </div>
        {offsets && offsets.wells.length > 0 ? (
          <>
            <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
              <span style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.25rem 0.75rem", fontSize: "0.72rem", color: COLORS.textMuted }}>
                Field: <strong style={{ color: COLORS.text }}>{offsets.field_name ?? offsets.field_no ?? "—"}</strong>
              </span>
              <span style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.25rem 0.75rem", fontSize: "0.72rem", color: COLORS.textMuted }}>
                {offsets.total_count} well{offsets.total_count !== 1 ? "s" : ""} in field{offsets.truncated ? " (truncated at 100)" : ""}
              </span>
            </div>
            <DdTable
              headers={["API", "Operator", "Lease", "Well #", "Well Type", "Potential (BBL)", "Daily Allow."]}
              rows={offsets.wells.slice(0, 50).map(w => [
                w.is_subject_asset
                  ? <span key="subj" style={{ color: COLORS.accent, fontWeight: 700 }}>{`42${w.api8}`} ★</span>
                  : `42${w.api8}`,
                w.operator_name ?? "—",
                w.lease_name ?? w.lease_no ?? "—",
                w.well_no ?? "—",
                <span key="wt" style={{
                  background: (w.well_type ?? "").toUpperCase().includes("PRODUC") ? COLORS.greenDim : COLORS.accent + "12",
                  color: (w.well_type ?? "").toUpperCase().includes("PRODUC") ? COLORS.green : COLORS.accent,
                  borderRadius: 5, padding: "0.1rem 0.35rem", fontSize: "0.68rem", fontWeight: 700
                }}>{w.well_type ?? "—"}</span>,
                w.potential_bbl !== null ? w.potential_bbl.toLocaleString() : "—",
                w.daily_allowable ?? "—",
              ])}
            />
            {offsets.notes.map((n, i) => (
              <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.78rem", marginTop: "0.4rem" }}>• {n}</div>
            ))}
            {offsets.wells.length > 50 && (
              <div style={{ color: COLORS.textFaint, fontSize: "0.74rem", marginTop: "0.4rem" }}>
                Showing first 50 of {offsets.wells.length} wells loaded. Full field data available in TRRC EWA.
              </div>
            )}
          </>
        ) : offsets && offsets.query_succeeded ? (
          <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
            No offset/nearby wells found in the same TRRC field. Field number may not be available from proration data.
          </div>
        ) : (
          <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.75rem 0" }}>
            Offset/nearby well data available on full diligence runs when a field number is resolved from proration records.
          </div>
        )}
      </Section>
    </>
  );
}

function OwnershipTab({ report }: { report: DDReport }) {
  const s = report.ownership;
  return (
    <>
      <Section title="Interest Summary" icon="📜">
        <KvRow label="Working Interest (WI)">
          <DataCell dp={s.working_interest_decimal} format={n => `${(n * 100).toFixed(4)}%`} />
        </KvRow>
        <KvRow label="Royalty Interest (RI)">
          <DataCell dp={s.royalty_interest_decimal} format={n => `${(n * 100).toFixed(4)}%`} />
        </KvRow>
        <KvRow label="Net Revenue Interest (NRI)">
          <DataCell dp={s.nri_decimal} format={n => `${(n * 100).toFixed(4)}%`} />
        </KvRow>
        <KvRow label="Subject WI">
          <DataCell dp={s.subject_wi} format={n => `${(n * 100).toFixed(4)}%`} />
        </KvRow>
        <KvRow label="Subject NRI">
          <DataCell dp={s.subject_nri} format={n => `${(n * 100).toFixed(4)}%`} />
        </KvRow>
      </Section>
      {s.records.length > 0 && (
        <Section title="Ownership Schedule" icon="📄">
          <DdTable
            headers={["Owner", "Interest Type", "Decimal", "NRI Decimal", "Source"]}
            rows={s.records.map(r => [
              r.owner_name,
              r.interest_type,
              r.decimal_interest != null ? r.decimal_interest.toFixed(6) : "—",
              r.nri_decimal != null ? r.nri_decimal.toFixed(6) : "—",
              <SourceBadge key="src" source={r.source} sourceDetail={r.source_detail} />,
            ])}
          />
        </Section>
      )}
      {s.notes.map((n, i) => (
        <div key={i} style={{ color: COLORS.textMuted, fontSize: "0.82rem", padding: "0.5rem 0" }}>⚠️ {n}</div>
      ))}
    </>
  );
}

// ─── Diligence Status Dashboard ──────────────────────────────────────────────

// ─── Evidence source badge ────────────────────────────────────────────────────

const EVIDENCE_LABELS: Record<EvidenceSource, { label: string; short: string; color: string; bg: string }> = {
  trrc_structured: { label: "TRRC Structured Record",  short: "L1 TRRC",       color: "#22c55e", bg: "rgba(34,197,94,0.12)"   },
  trrc_imaged:     { label: "TRRC Imaged Record (W-1/W-2)", short: "L2 TRRC Imaged", color: "#4f8ef7", bg: "rgba(79,142,247,0.12)"  },
  seller_document: { label: "Seller/Operator Document", short: "L3 Seller Doc", color: "#f59e0b", bg: "rgba(245,158,11,0.12)"   },
  user_assumption: { label: "User Assumption",          short: "User Input",    color: "#8892a4", bg: "rgba(136,146,164,0.10)"  },
  model_estimate:  { label: "Model Estimate (Inferred)", short: "Estimated",    color: "#ef4444", bg: "rgba(239,68,68,0.10)"    },
  not_found:       { label: "Not Found — Doc Required", short: "Not Found",     color: "#ef4444", bg: "rgba(239,68,68,0.10)"    },
};

function EvidenceBadge({ source, small = false }: { source: EvidenceSource; small?: boolean }) {
  const cfg = EVIDENCE_LABELS[source];
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "0.25rem",
      fontSize: small ? "0.57rem" : "0.62rem",
      fontWeight: 700,
      color: cfg.color,
      background: cfg.bg,
      border: `1px solid ${cfg.color}30`,
      borderRadius: 4,
      padding: small ? "0.06rem 0.35rem" : "0.1rem 0.45rem",
      textTransform: "uppercase" as const,
      letterSpacing: "0.04em",
      flexShrink: 0,
    }}>
      {cfg.short}
    </span>
  );
}

function DiligenceStatusDashboard({ items, compact = false }: {
  items: DiligenceStatusItem[];
  compact?: boolean;
}) {
  const tierConfig: Record<DiligenceStatusTier, {
    label: string; icon: string; color: string; bg: string; border: string;
  }> = {
    verified: {
      label: "VERIFIED",
      icon: "✓",
      color: COLORS.green,
      bg: "rgba(34,197,94,0.10)",
      border: "rgba(34,197,94,0.30)",
    },
    partially_verified: {
      label: "PARTIALLY VERIFIED",
      icon: "◑",
      color: COLORS.yellow,
      bg: "rgba(245,158,11,0.10)",
      border: "rgba(245,158,11,0.30)",
    },
    missing: {
      label: "MISSING",
      icon: "✕",
      color: COLORS.red,
      bg: "rgba(239,68,68,0.10)",
      border: "rgba(239,68,68,0.30)",
    },
    searched_no_records: {
      label: "SEARCHED — NO RECORDS",
      icon: "○",
      color: COLORS.green,
      bg: "rgba(34,197,94,0.07)",
      border: "rgba(34,197,94,0.25)",
    },
    query_failed: {
      label: "QUERY FAILED",
      icon: "⚠",
      color: COLORS.red,
      bg: "rgba(239,68,68,0.10)",
      border: "rgba(239,68,68,0.30)",
    },
    not_applicable: {
      label: "N/A",
      icon: "—",
      color: COLORS.textFaint,
      bg: "rgba(255,255,255,0.03)",
      border: COLORS.border,
    },
  };

  const verified        = items.filter(i => i.tier === "verified");
  const searchedNone    = items.filter(i => i.tier === "searched_no_records");
  const partial         = items.filter(i => i.tier === "partially_verified");
  const missing         = items.filter(i => i.tier === "missing" || i.tier === "query_failed");
  const na              = items.filter(i => i.tier === "not_applicable");
  const applicable      = items.filter(i => i.tier !== "not_applicable");

  if (compact) {
    // Compact summary bar for the Executive Summary tab
    return (
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "stretch" }}>
        {[
          { tier: "verified"           as DiligenceStatusTier, count: verified.length + searchedNone.length, label: "Verified / Searched" },
          { tier: "partially_verified" as DiligenceStatusTier, count: partial.length,   label: "Partial"  },
          { tier: "missing"            as DiligenceStatusTier, count: missing.length,   label: "Missing"  },
        ].map(({ tier, count, label }) => {
          const cfg = tierConfig[tier];
          return (
            <div key={tier} style={{
              flex: 1,
              minWidth: 90,
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 8,
              padding: "0.65rem 0.9rem",
              textAlign: "center",
            }}>
              <div style={{ fontSize: "1.4rem", fontWeight: 900, color: cfg.color }}>{count}</div>
              <div style={{ fontSize: "0.62rem", color: cfg.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {cfg.icon} {label}
              </div>
              <div style={{ fontSize: "0.6rem", color: COLORS.textFaint, marginTop: 2 }}>
                of {applicable.length} categories
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Full dashboard view
  const renderColumn = (
    tier: DiligenceStatusTier,
    list: DiligenceStatusItem[],
  ) => {
    const cfg = tierConfig[tier];
    return (
      <div style={{
        flex: 1,
        minWidth: 260,
        background: COLORS.surface,
        border: `1px solid ${cfg.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}>
        {/* Column header */}
        <div style={{
          background: cfg.bg,
          borderBottom: `1px solid ${cfg.border}`,
          padding: "1rem 1.25rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span style={{
              fontSize: "1.1rem",
              fontWeight: 900,
              color: cfg.color,
              width: 26,
              height: 26,
              borderRadius: "50%",
              border: `2px solid ${cfg.color}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}>
              {cfg.icon}
            </span>
            <span style={{
              fontSize: "0.75rem",
              fontWeight: 800,
              color: cfg.color,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}>
              {cfg.label}
            </span>
          </div>
          <span style={{
            fontSize: "1rem",
            fontWeight: 900,
            color: cfg.color,
          }}>
            {list.length}
          </span>
        </div>

        {/* Items */}
        <div style={{ padding: "0.75rem" }}>
          {list.length === 0 ? (
            <div style={{ textAlign: "center", padding: "1.5rem 0", color: COLORS.textFaint, fontSize: "0.78rem" }}>
              {tier === "missing" ? "Nothing outstanding 🎉" : tier === "verified" ? "No items in this category" : "—"}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {list.map((item, i) => (
                <div key={i} style={{
                  background: COLORS.surfaceAlt,
                  borderRadius: 8,
                  padding: "0.75rem 0.9rem",
                  borderLeft: `3px solid ${cfg.color}`,
                }}>
                  {/* Category + urgency + evidence badge */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.35rem", gap: "0.4rem" }}>
                    <span style={{ fontSize: "0.78rem", fontWeight: 700, color: COLORS.text, flex: 1 }}>
                      {item.category}
                    </span>
                    <div style={{ display: "flex", gap: "0.3rem", alignItems: "center", flexShrink: 0 }}>
                      <EvidenceBadge source={item.evidence_source} small />
                      {item.tier !== "verified" && item.tier !== "not_applicable" && (
                        <span style={{
                          fontSize: "0.6rem",
                          fontWeight: 800,
                          color: item.urgency === "critical" ? COLORS.red
                            : item.urgency === "important" ? COLORS.yellow
                            : COLORS.textFaint,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          background: item.urgency === "critical" ? COLORS.redDim
                            : item.urgency === "important" ? COLORS.yellowDim
                            : "transparent",
                          padding: "0.1rem 0.4rem",
                          borderRadius: 3,
                          flexShrink: 0,
                        }}>
                          {item.urgency}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status detail */}
                  <div style={{ fontSize: "0.74rem", color: COLORS.textMuted, lineHeight: 1.45, marginBottom: item.source_label ? "0.3rem" : 0 }}>
                    {item.status_detail}
                  </div>

                  {/* Source */}
                  {item.source_label && (
                    <div style={{ fontSize: "0.67rem", color: COLORS.textFaint, marginBottom: item.action_required ? "0.4rem" : 0 }}>
                      Source: {item.source_label}
                    </div>
                  )}

                  {/* Action required */}
                  {item.action_required && (
                    <div style={{
                      marginTop: "0.4rem",
                      background: item.urgency === "critical" ? COLORS.redDim : COLORS.yellowDim,
                      border: `1px solid ${item.urgency === "critical" ? COLORS.red : COLORS.yellow}25`,
                      borderRadius: 5,
                      padding: "0.35rem 0.55rem",
                      fontSize: "0.71rem",
                      color: COLORS.text,
                      lineHeight: 1.4,
                    }}>
                      <span style={{ fontWeight: 700, color: item.urgency === "critical" ? COLORS.red : COLORS.yellow }}>
                        → Action:{" "}
                      </span>
                      {item.action_required}
                    </div>
                  )}

                  {/* Document request count badge */}
                  {item.document_requests.length > 0 && (
                    <div style={{ marginTop: "0.4rem", fontSize: "0.62rem", color: COLORS.textFaint }}>
                      📋 {item.document_requests.length} document request{item.document_requests.length > 1 ? "s" : ""} generated
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Summary bar */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "0.5rem",
        marginBottom: "1.25rem",
      }}>
        {(["verified", "searched_no_records", "partially_verified", "missing", "query_failed", "not_applicable"] as DiligenceStatusTier[]).map(tier => {
          const cfg = tierConfig[tier];
          const count = items.filter(i => i.tier === tier).length;
          if (count === 0 && tier !== "verified" && tier !== "missing") return null;
          return (
            <div key={tier} style={{
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 8,
              padding: "0.65rem 0.9rem",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
            }}>
              <div style={{ fontSize: "1.5rem", fontWeight: 900, color: cfg.color, lineHeight: 1 }}>{count}</div>
              <div>
                <div style={{ fontSize: "0.62rem", fontWeight: 800, color: cfg.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {cfg.label}
                </div>
                <div style={{ fontSize: "0.6rem", color: COLORS.textFaint }}>categories</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Three-column board (four if searched_no_records items exist) */}
      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        {renderColumn("verified",             verified)}
        {searchedNone.length > 0 && renderColumn("searched_no_records", searchedNone)}
        {renderColumn("partially_verified",   partial)}
        {renderColumn("missing",              missing)}
      </div>

      {/* N/A items — shown compact at bottom */}
      {na.length > 0 && (
        <div style={{
          marginTop: "1rem",
          padding: "0.6rem 0.9rem",
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "center",
        }}>
          <span style={{ fontSize: "0.68rem", color: COLORS.textFaint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Not Applicable:
          </span>
          {na.map((item, i) => (
            <span key={i} style={{
              fontSize: "0.72rem",
              color: COLORS.textFaint,
              background: COLORS.surfaceAlt,
              padding: "0.1rem 0.5rem",
              borderRadius: 4,
              border: `1px solid ${COLORS.border}`,
            }}>
              {item.category}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function OfferGateBanner({ gate }: { gate: OfferGate | null }) {
  if (!gate) return null;

  const bg     = gate.gate_open ? "rgba(34,197,94,0.08)"  : "rgba(239,68,68,0.08)";
  const border = gate.gate_open ? "rgba(34,197,94,0.30)"  : "rgba(239,68,68,0.30)";
  const color  = gate.gate_open ? COLORS.green             : COLORS.red;
  const icon   = gate.gate_open ? "✓" : "⛔";
  const title  = gate.gate_open ? "OFFER GATE: OPEN" : `OFFER GATE: LOCKED (${gate.blocking_count} field${gate.blocking_count !== 1 ? "s" : ""} unsatisfied)`;

  return (
    <div style={{
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: 10,
      padding: "1rem 1.25rem",
      marginBottom: "1.5rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.6rem" }}>
        <span style={{ fontSize: "1.2rem" }}>{icon}</span>
        <span style={{ fontSize: "0.8rem", fontWeight: 800, color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {title}
        </span>
      </div>
      <p style={{ fontSize: "0.75rem", color: COLORS.textMuted, margin: 0, lineHeight: 1.55 }}>
        {gate.gate_message}
      </p>
      {!gate.gate_open && (
        <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {gate.blocking_fields.filter(f => f.blocking).map((f, i) => (
            <div key={i} style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.6rem",
              padding: "0.45rem 0.7rem",
              background: "rgba(239,68,68,0.05)",
              border: "1px solid rgba(239,68,68,0.15)",
              borderRadius: 6,
              fontSize: "0.72rem",
            }}>
              <EvidenceBadge source={f.current_source} small />
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: COLORS.text }}>{f.category}</span>
                <span style={{ color: COLORS.textMuted }}> — {f.resolution}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentRequestChecklist({ items }: { items: DiligenceStatusItem[] }) {
  const allRequests = items.flatMap(item =>
    item.document_requests.map(req => ({ ...req, _category: item.category }))
  );
  if (allRequests.length === 0) return null;

  const critical   = allRequests.filter(r => r.urgency === "critical");
  const important  = allRequests.filter(r => r.urgency === "important");
  const info       = allRequests.filter(r => r.urgency === "informational");

  const fromLabels: Record<string, string> = {
    seller:         "🤝 Seller",
    operator:       "🏭 Operator",
    title_attorney: "⚖️ Title Attorney",
    state_agency:   "🏛️ State Agency",
  };

  const renderRequests = (list: typeof allRequests, urgColor: string) => list.map((req, i) => (
    <div key={i} style={{
      padding: "0.7rem 0.9rem",
      marginBottom: "0.5rem",
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderLeft: `3px solid ${urgColor}`,
      borderRadius: "0 8px 8px 0",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.3rem", gap: "0.5rem" }}>
        <span style={{ fontSize: "0.75rem", fontWeight: 700, color: COLORS.text }}>{req.document_type}</span>
        <span style={{ fontSize: "0.62rem", color: COLORS.textFaint, flexShrink: 0 }}>
          {fromLabels[req.from] ?? req.from}
        </span>
      </div>
      <div style={{ fontSize: "0.7rem", color: COLORS.textMuted, lineHeight: 1.45, marginBottom: "0.25rem" }}>
        {req.description}
      </div>
      <div style={{ fontSize: "0.62rem", color: COLORS.textFaint }}>
        For: <strong style={{ color: COLORS.textMuted }}>{req._category}</strong>
      </div>
    </div>
  ));

  return (
    <Section title={`Document Request Checklist (${allRequests.length} items)`} icon="📋">
      <p style={{ fontSize: "0.75rem", color: COLORS.textMuted, marginBottom: "1rem", lineHeight: 1.55 }}>
        These document requests are automatically generated from fields that could not be verified through
        TRRC structured records (Layer 1) or TRRC imaged records (Layer 2). Send this checklist to the
        seller/operator before issuing an offer.
      </p>

      {/* Legend */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {[
          { src: "trrc_structured" as EvidenceSource, label: "Layer 1: TRRC Structured" },
          { src: "trrc_imaged"     as EvidenceSource, label: "Layer 2: TRRC Imaged" },
          { src: "seller_document" as EvidenceSource, label: "Layer 3: Seller Doc" },
          { src: "model_estimate"  as EvidenceSource, label: "Estimated — needs confirmation" },
          { src: "not_found"       as EvidenceSource, label: "Not found — doc required" },
        ].map(({ src, label }) => (
          <div key={src} style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <EvidenceBadge source={src} small />
            <span style={{ fontSize: "0.65rem", color: COLORS.textFaint }}>{label}</span>
          </div>
        ))}
      </div>

      {critical.length > 0 && (
        <>
          <div style={{ fontSize: "0.7rem", fontWeight: 800, color: COLORS.red, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
            🔴 Critical ({critical.length})
          </div>
          {renderRequests(critical, COLORS.red)}
        </>
      )}
      {important.length > 0 && (
        <>
          <div style={{ fontSize: "0.7rem", fontWeight: 800, color: COLORS.yellow, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem", marginTop: critical.length ? "0.75rem" : 0 }}>
            🟡 Important ({important.length})
          </div>
          {renderRequests(important, COLORS.yellow)}
        </>
      )}
      {info.length > 0 && (
        <>
          <div style={{ fontSize: "0.7rem", fontWeight: 800, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem", marginTop: (critical.length || important.length) ? "0.75rem" : 0 }}>
            ℹ️ Informational ({info.length})
          </div>
          {renderRequests(info, COLORS.textFaint)}
        </>
      )}
    </Section>
  );
}

function MissingItemsTab({ report }: { report: DDReport }) {
  const items    = report.missing_items;
  const critical   = items.filter(i => i.importance === "critical");
  const important  = items.filter(i => i.importance === "important");
  const niceToHave = items.filter(i => i.importance === "nice_to_have");

  const renderGroup = (label: string, color: string, list: MissingItem[]) =>
    list.length > 0 ? (
      <Section
        title={`${label} (${list.length})`}
        icon={color === COLORS.red ? "🔴" : color === COLORS.yellow ? "🟡" : "🟢"}
      >
        {list.map((item, i) => (
          <div key={i} style={{
            padding: "0.6rem 0.75rem",
            marginBottom: "0.5rem",
            borderLeft: `3px solid ${color}`,
            background: COLORS.surfaceAlt,
            borderRadius: "0 6px 6px 0",
            fontSize: "0.82rem",
          }}>
            <div style={{ fontWeight: 600, color: COLORS.text }}>{item.section} → {item.field}</div>
            <div style={{ color: COLORS.textMuted, marginTop: 3 }}>{item.note}</div>
          </div>
        ))}
      </Section>
    ) : null;

  return (
    <>
      {/* Offer Gate Banner */}
      <OfferGateBanner gate={report.offer_gate} />

      {/* Evidence Source Legend */}
      <Section title="Evidence Hierarchy" icon="🔗">
        <p style={{ fontSize: "0.75rem", color: COLORS.textMuted, marginBottom: "0.75rem", lineHeight: 1.55 }}>
          Every diligence field is classified against a three-layer evidence hierarchy.
          Fields sourced only from model estimates or not found in any source block the offer gate.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.5rem" }}>
          {(Object.entries(EVIDENCE_LABELS) as [EvidenceSource, typeof EVIDENCE_LABELS[EvidenceSource]][]).map(([src, cfg]) => (
            <div key={src} style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.6rem",
              padding: "0.5rem 0.75rem",
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
            }}>
              <EvidenceBadge source={src} />
              <span style={{ fontSize: "0.7rem", color: COLORS.textMuted, lineHeight: 1.4 }}>
                {cfg.label}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Diligence Status Board */}
      <Section title="Diligence Status Board" icon="📊">
        <p style={{ fontSize: "0.78rem", color: COLORS.textMuted, marginBottom: "1rem", lineHeight: 1.55 }}>
          Every core underwriting category classified as{" "}
          <strong style={{ color: COLORS.green }}>VERIFIED</strong>,{" "}
          <strong style={{ color: COLORS.yellow }}>PARTIALLY VERIFIED</strong>, or{" "}
          <strong style={{ color: COLORS.red }}>MISSING</strong>.
          Each card shows the evidence source badge and any auto-generated document requests.
        </p>
        <DiligenceStatusDashboard items={report.diligence_status} />
      </Section>

      {/* Document Request Checklist */}
      <DocumentRequestChecklist items={report.diligence_status} />

      {/* Legacy detailed missing items list */}
      {items.length > 0 && (
        <Section title="Detailed Missing Item Log" icon="📋">
          {renderGroup("Critical", COLORS.red, critical)}
          {renderGroup("Important", COLORS.yellow, important)}
          {renderGroup("Nice-to-Have", COLORS.green, niceToHave)}
        </Section>
      )}
    </>
  );
}

function NextQuestionsTab({ questions }: { questions: NextQuestion[] }) {
  const priorityColor: Record<string, string> = {
    high: COLORS.red, medium: COLORS.yellow, low: COLORS.green,
  };
  const directed: Record<string, string> = {
    operator: "🏭 Operator",
    seller:   "🤝 Seller",
    title_attorney: "⚖️ Title Attorney",
    engineer: "🔬 Engineer",
    state_agency: "🏛️ State Agency",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {questions.length === 0 && (
        <div style={{ color: COLORS.textFaint, padding: "2rem", textAlign: "center" }}>
          No follow-up questions generated.
        </div>
      )}
      {questions.map((q, i) => (
        <div key={i} style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderLeft: `4px solid ${priorityColor[q.priority] ?? COLORS.accent}`,
          borderRadius: "0 10px 10px 0",
          padding: "1rem 1.25rem",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
            <span style={{
              fontSize: "0.68rem", fontWeight: 700,
              color: priorityColor[q.priority] ?? COLORS.textMuted,
              textTransform: "uppercase", letterSpacing: "0.08em",
            }}>
              {q.priority} priority
            </span>
            <span style={{ fontSize: "0.72rem", color: COLORS.textMuted }}>
              {directed[q.directed_at] ?? q.directed_at}
            </span>
          </div>
          <div style={{ fontWeight: 600, color: COLORS.text, fontSize: "0.85rem", marginBottom: "0.35rem" }}>
            {q.question}
          </div>
          <div style={{ fontSize: "0.78rem", color: COLORS.textMuted }}>
            {q.rationale}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Recommendation Tab ───────────────────────────────────────────────────────

function RecommendationTab({ report }: { report: DDReport }) {
  const risk = report.risk;
  const rec = risk.recommendation.value;
  const score = risk.overall_score.value ?? 0;

  const recColors: Record<string, string> = {
    pursue: COLORS.green,
    review: COLORS.yellow,
    pass:   COLORS.red,
  };
  const recColor = recColors[rec ?? "review"] ?? COLORS.yellow;

  const catOrder: (keyof typeof risk.categories)[] = [
    "production", "financial", "compliance", "plugging", "operator", "data_quality",
  ];

  function ScoreBar({ score, weight }: { score: number; weight: number }) {
    const color = score <= 3 ? COLORS.green : score <= 6 ? COLORS.yellow : COLORS.red;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, height: 6, background: COLORS.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${score * 10}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.5s" }} />
        </div>
        <span style={{ fontSize: "0.75rem", fontWeight: 700, color, minWidth: 24 }}>{score}</span>
        <span style={{ fontSize: "0.68rem", color: COLORS.textFaint }}>({(weight * 100).toFixed(0)}%)</span>
      </div>
    );
  }

  return (
    <div>
      {/* Hero recommendation banner */}
      <div style={{
        background: COLORS.surface,
        border: `2px solid ${recColor}`,
        borderRadius: 12,
        padding: "1.5rem 2rem",
        marginBottom: "1rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "1rem",
      }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
            Acquisition Recommendation
          </div>
          <div style={{ fontSize: "2.5rem", fontWeight: 900, color: recColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {rec ?? "REVIEW"}
          </div>
          <div style={{ fontSize: "0.85rem", color: COLORS.textMuted, marginTop: 6, maxWidth: 500 }}>
            {risk.recommendation_rationale}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
            Risk Score
          </div>
          <div style={{ fontSize: "3rem", fontWeight: 900, color: recColor, lineHeight: 1 }}>
            {score.toFixed(1)}
          </div>
          <div style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>out of 10</div>
        </div>
        {(() => {
          const lo  = report.acquisition_economics.offer_range_low.value;
          const hi  = report.acquisition_economics.offer_range_high.value;
          const mid = report.acquisition_economics.offer_range_mid.value;
          const validRange = typeof lo === "number" && lo > 0 &&
                             typeof hi === "number" && hi > 0 && hi >= lo &&
                             typeof mid === "number" && mid > 0;
          if (!validRange) return null;
          return (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
                Estimated Offer Range
              </div>
              <div style={{ fontSize: "1.1rem", fontWeight: 800, color: COLORS.green }}>
                {fmt$(lo)} – {fmt$(hi)}
              </div>
              <div style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>base price deck</div>
            </div>
          );
        })()}
      </div>

      {/* Flag summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
        {[
          { title: "🚩 Red Flags", items: risk.red_flags, color: COLORS.red, bg: COLORS.redDim },
          { title: "🟡 Yellow Flags", items: risk.yellow_flags, color: COLORS.yellow, bg: COLORS.yellowDim },
          { title: "✅ Green Flags", items: risk.green_flags, color: COLORS.green, bg: COLORS.greenDim },
        ].map(({ title, items, color, bg }) => (
          <div key={title} style={{
            background: COLORS.surface,
            border: `1px solid ${color}40`,
            borderRadius: 10,
            padding: "1rem",
          }}>
            <div style={{ fontWeight: 700, color, fontSize: "0.8rem", marginBottom: 8 }}>{title}</div>
            {items.length === 0
              ? <div style={{ color: COLORS.textFaint, fontSize: "0.78rem" }}>None identified</div>
              : items.map((f, i) => (
                  <div key={i} style={{ fontSize: "0.78rem", color: COLORS.text, padding: "0.3rem 0", borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none" }}>
                    {f}
                  </div>
                ))
            }
          </div>
        ))}
      </div>

      {/* Category scores */}
      <Section title="Risk Category Breakdown" icon="📊">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          {catOrder.map(key => {
            const cat: RiskCategoryResult = risk.categories[key];
            return (
              <div key={key} style={{
                background: COLORS.surfaceAlt,
                borderRadius: 8,
                padding: "0.9rem 1rem",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: "0.8rem", fontWeight: 600, color: COLORS.text }}>{cat.name}</span>
                </div>
                <ScoreBar score={cat.score} weight={cat.weight} />
                {cat.flags.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {cat.flags.map((f, i) => (
                      <div key={i} style={{ fontSize: "0.72rem", color: COLORS.red, padding: "0.2rem 0" }}>• {f}</div>
                    ))}
                  </div>
                )}
                {cat.mitigants.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {cat.mitigants.map((m, i) => (
                      <div key={i} style={{ fontSize: "0.72rem", color: COLORS.green, padding: "0.2rem 0" }}>✓ {m}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Diligence checklist */}
      <Section title="Diligence Checklist" icon="✅">
        <DdTable
          headers={["Priority", "Item", "Status"]}
          rows={risk.diligence_checklist.map((item: DiligenceCheckItem) => [
            <span key="p" style={{
              fontSize: "0.68rem",
              fontWeight: 700,
              color: item.priority === "critical" ? COLORS.red : item.priority === "important" ? COLORS.yellow : COLORS.textMuted,
              textTransform: "uppercase",
            }}>
              {item.priority.replace("_", " ")}
            </span>,
            item.item,
            <span key="s" style={{
              fontSize: "0.72rem",
              color: item.status === "complete" ? COLORS.green : item.status === "pending" ? COLORS.yellow : COLORS.textFaint,
            }}>
              {item.status === "complete" ? "✓ Complete" : item.status === "pending" ? "⟳ Pending" : "N/A"}
            </span>,
          ])}
        />
      </Section>
    </div>
  );
}

// ─── Data Provenance Tab ──────────────────────────────────────────────────────
//
// Full source audit for every value in the report.
// This is the verification screen — nothing else should be trusted until this
// is reviewed and the production lineage is confirmed.

import type { DataProvenanceReport, ProductionLineage, ProvenanceRecord } from "@/lib/underwriting/types";

// ─── Truth-Check Tab ──────────────────────────────────────────────────────────

function TruthCheckTab({ report }: { report: DDReport }) {
  const tc = report.truth_check;

  if (!tc) {
    return (
      <Section title="RRC Truth-Check Engine" icon="⚖️">
        <div style={{ color: COLORS.textFaint, fontSize: "0.82rem", padding: "1rem 0" }}>
          Truth-check results not available for this report. Re-run the full underwriting pipeline.
        </div>
      </Section>
    );
  }

  const VERDICT_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
    true:                  { label: "TRUE",                  color: COLORS.green,    bg: "rgba(34,197,94,0.10)"  },
    false:                 { label: "FALSE",                 color: COLORS.red,      bg: "rgba(239,68,68,0.12)"  },
    stale:                 { label: "STALE",                 color: COLORS.yellow,   bg: "rgba(234,179,8,0.10)"  },
    unsupported:           { label: "UNSUPPORTED",           color: "#f97316",        bg: "rgba(249,115,22,0.10)" },
    contradicted:          { label: "CONTRADICTED",          color: COLORS.red,      bg: "rgba(239,68,68,0.15)"  },
    query_failed:          { label: "QUERY FAILED",          color: COLORS.red,      bg: "rgba(239,68,68,0.12)"  },
    parse_failed:          { label: "PARSE FAILED",          color: COLORS.red,      bg: "rgba(239,68,68,0.12)"  },
    verified_records_found:{ label: "RECORDS FOUND",         color: "#f97316",        bg: "rgba(249,115,22,0.10)" },
  };

  const overallColor = tc.overall_verdict === "block" ? COLORS.red : tc.overall_verdict === "warn" ? COLORS.yellow : COLORS.green;

  return (
    <>
      {/* Summary */}
      <Section title="RRC Truth-Check Engine" icon="⚖️">
        <div style={{
          background: tc.overall_verdict === "block" ? COLORS.redDim : tc.overall_verdict === "warn" ? COLORS.yellowDim : "rgba(34,197,94,0.08)",
          border: `1px solid ${overallColor}40`,
          borderRadius: 8,
          padding: "0.85rem 1.1rem",
          marginBottom: "1rem",
        }}>
          <div style={{ fontWeight: 800, fontSize: "0.78rem", color: overallColor, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 4 }}>
            Overall: {tc.overall_verdict.toUpperCase()}
          </div>
          <div style={{ fontSize: "0.8rem", color: COLORS.text }}>{tc.summary}</div>
          <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginTop: 4 }}>
            Ran at {new Date(tc.ran_at).toLocaleString()} · {tc.claims.length} claim(s) evaluated
          </div>
        </div>

        {/* Active gates */}
        {(tc.gate.block_production_claims || tc.gate.block_clean_compliance || tc.gate.block_economics || tc.gate.block_offer) && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: "0.4rem", fontWeight: 700 }}>
              Active Blocks
            </div>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" as const }}>
              {tc.gate.block_production_claims && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: COLORS.red, background: COLORS.redDim, padding: "0.25rem 0.6rem", borderRadius: 4, textTransform: "uppercase" as const }}>Production Claims</span>}
              {tc.gate.block_clean_compliance  && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: COLORS.red, background: COLORS.redDim, padding: "0.25rem 0.6rem", borderRadius: 4, textTransform: "uppercase" as const }}>Clean Compliance</span>}
              {tc.gate.block_economics         && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: COLORS.red, background: COLORS.redDim, padding: "0.25rem 0.6rem", borderRadius: 4, textTransform: "uppercase" as const }}>Economics / NPV</span>}
              {tc.gate.block_offer             && <span style={{ fontSize: "0.68rem", fontWeight: 700, color: COLORS.red, background: COLORS.redDim, padding: "0.25rem 0.6rem", borderRadius: 4, textTransform: "uppercase" as const }}>Offer Range</span>}
            </div>
          </div>
        )}
      </Section>

      {/* Claim table */}
      <Section title="Claim-by-Claim Evidence Comparison" icon="📋">
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
          {tc.claims.map((cl, i) => {
            const cfg = VERDICT_CONFIG[cl.verdict] ?? { label: cl.verdict.toUpperCase(), color: COLORS.textFaint, bg: "transparent" };
            return (
              <div key={i} style={{
                background: cl.blocking ? cfg.bg : COLORS.surfaceAlt,
                borderRadius: 8,
                padding: "0.75rem 1rem",
                borderLeft: `3px solid ${cl.blocking ? cfg.color : COLORS.border}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem", marginBottom: "0.3rem", flexWrap: "wrap" as const }}>
                  <span style={{ fontWeight: 700, fontSize: "0.78rem", color: COLORS.text }}>{cl.claim_label}</span>
                  <span style={{
                    fontSize: "0.62rem", fontWeight: 900,
                    color: cfg.color,
                    background: cfg.bg,
                    padding: "0.15rem 0.5rem",
                    borderRadius: 4,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase" as const,
                    flexShrink: 0,
                    border: `1px solid ${cfg.color}60`,
                  }}>
                    {cfg.label}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem 1rem", marginBottom: "0.3rem", fontSize: "0.72rem" }}>
                  <div>
                    <span style={{ color: COLORS.textFaint, textTransform: "uppercase" as const, fontSize: "0.6rem", letterSpacing: "0.06em" }}>Report claims: </span>
                    <span style={{ color: COLORS.text, fontWeight: 600 }}>{cl.report_value ?? "—"}</span>
                  </div>
                  <div>
                    <span style={{ color: COLORS.textFaint, textTransform: "uppercase" as const, fontSize: "0.6rem", letterSpacing: "0.06em" }}>Evidence shows: </span>
                    <span style={{ color: cl.blocking ? cfg.color : COLORS.text, fontWeight: 600 }}>{cl.evidence_value ?? "—"}</span>
                  </div>
                </div>
                <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, lineHeight: 1.5 }}>{cl.explanation}</div>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}

function DataProvenanceTab({ report }: { report: DDReport }) {
  const prov = report.data_provenance;

  const T = {
    surface:    "#181c25",
    surfaceAlt: "#1e2333",
    border:     "rgba(255,255,255,0.08)",
    text:       "#e2e8f0",
    muted:      "#8892a4",
    faint:      "#5a6478",
    accent:     "#4f8ef7",
    accentDim:  "rgba(79,142,247,0.12)",
    green:      "#22c55e",
    greenDim:   "rgba(34,197,94,0.12)",
    yellow:     "#f59e0b",
    yellowDim:  "rgba(245,158,11,0.12)",
    red:        "#ef4444",
    redDim:     "rgba(239,68,68,0.12)",
  };

  const card: React.CSSProperties = {
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: "1rem 1.15rem",
    marginBottom: "1rem",
  };

  const mono: React.CSSProperties = {
    fontFamily: "monospace", fontSize: "0.78rem",
  };

  const sectionHead = (text: string, color = T.text) => (
    <div style={{ fontSize: "0.92rem", fontWeight: 700, color, marginBottom: "0.6rem" }}>{text}</div>
  );

  if (!prov) {
    return (
      <div style={card}>
        <p style={{ color: T.muted, margin: 0 }}>
          Data provenance not available. Run a full underwriting analysis to generate the audit trail.
        </p>
      </div>
    );
  }

  const lin = prov.production_lineage;
  const hasCritical = lin.has_critical_mismatch;
  const docHasData  = lin.doc_month_count > 0;
  const trrcHasData = lin.trrc_month_count > 0;
  const trrcOverrides = lin.trrc_overrides_document;

  return (
    <div style={{ paddingBottom: "2.5rem" }}>

      {/* ── Red banner: critical mismatch ── */}
      {hasCritical && (
        <div style={{
          background: T.redDim,
          border: `1.5px solid ${T.red}`,
          borderRadius: 10,
          padding: "1rem 1.15rem",
          marginBottom: "1.25rem",
        }}>
          <div style={{ fontSize: "1rem", fontWeight: 800, color: T.red, marginBottom: "0.35rem" }}>
            🚨 CRITICAL: Production Data Mismatch
          </div>
          <div style={{ fontSize: "0.85rem", color: T.red, lineHeight: 1.6, marginBottom: "0.5rem" }}>
            {lin.mismatch_summary}
          </div>
          <div style={{ fontSize: "0.82rem", color: T.red, opacity: 0.85, fontWeight: 600 }}>
            Decline curves, reserve estimates, economics, and offer range CANNOT be trusted until this is resolved.
            Verify the TRRC lease number (Dist:Lease {lin.trrc_lease_id ?? "unknown"}) matches the lease on your run statement.
          </div>
        </div>
      )}

      {/* ── Yellow banner: TRRC overrides doc ── */}
      {!hasCritical && trrcOverrides && (
        <div style={{
          background: T.yellowDim,
          border: `1px solid rgba(245,158,11,0.35)`,
          borderRadius: 10,
          padding: "0.85rem 1.15rem",
          marginBottom: "1rem",
          fontSize: "0.84rem",
          color: T.yellow,
          lineHeight: 1.55,
        }}>
          ⚠️ <strong>TRRC data overrides uploaded document production.</strong> {lin.overlapping_periods.length > 0
            ? `${lin.overlapping_periods.length} overlapping period(s) found — no critical divergence detected, but verify the TRRC lease matches your run statement.`
            : `No overlapping periods to compare — cannot confirm TRRC and document data describe the same property.`}
        </div>
      )}

      {/* ── Green banner: clean, no doc data ── */}
      {!hasCritical && !trrcOverrides && docHasData && trrcHasData && (
        <div style={{
          background: T.greenDim, border: `1px solid rgba(34,197,94,0.25)`,
          borderRadius: 10, padding: "0.7rem 1rem", marginBottom: "1rem",
          fontSize: "0.82rem", color: T.green,
        }}>
          ✓ No critical divergence found across {lin.overlapping_periods.length} overlapping period(s).
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 1: Production Lineage
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={card}>
        {sectionHead("Section 1 — Production Lineage")}

        {/* Authoritative source */}
        <div style={{
          background: T.surfaceAlt,
          borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "0.85rem",
          display: "flex", gap: "1.5rem", flexWrap: "wrap",
        }}>
          <div>
            <div style={{ fontSize: "0.68rem", color: T.faint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>Authoritative Source</div>
            <div style={{
              fontWeight: 700, fontSize: "0.95rem",
              color: lin.authoritative_source === "trrc" ? T.accent
                   : lin.authoritative_source === "document" ? T.green : T.red,
            }}>
              {lin.authoritative_source === "trrc" ? "TRRC (public record)"
               : lin.authoritative_source === "document" ? "Uploaded document"
               : "None — no production data"}
            </div>
          </div>
          {lin.trrc_lease_id && (
            <div>
              <div style={{ fontSize: "0.68rem", color: T.faint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>TRRC Dist:Lease</div>
              <div style={{ ...mono, color: T.accent, fontWeight: 700 }}>{lin.trrc_lease_id}</div>
            </div>
          )}
          <div style={{ flex: 1, fontSize: "0.8rem", color: T.muted, lineHeight: 1.5 }}>
            {lin.selection_reason}
          </div>
        </div>

        {/* Side-by-side sources */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.85rem" }}>

          {/* Document data */}
          <div style={{
            background: T.surfaceAlt,
            border: `1px solid ${docHasData && trrcOverrides ? "rgba(245,158,11,0.3)" : T.border}`,
            borderRadius: 8, padding: "0.75rem",
          }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: docHasData ? T.green : T.faint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.4rem" }}>
              📄 Document-Extracted Production
              {trrcOverrides && docHasData && <span style={{ color: T.yellow, marginLeft: 6 }}>⚠️ overridden by TRRC</span>}
            </div>
            {docHasData ? (
              <>
                <div style={{ fontSize: "0.82rem", color: T.text, marginBottom: 2 }}>{lin.doc_month_count} months</div>
                <div style={{ ...mono, color: T.faint, marginBottom: "0.5rem" }}>{lin.doc_date_range}</div>
                <div style={{ overflowX: "auto", maxHeight: 220, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
                    <thead>
                      <tr>
                        {["Period", "Oil BBL", "Gas MCF", "Price", "Revenue"].map(h => (
                          <th key={h} style={{ textAlign: h === "Period" ? "left" : "right", padding: "3px 6px", color: T.faint, fontSize: "0.7rem", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...lin.doc_months].sort((a, b) => a.period.localeCompare(b.period)).map((r, i) => {
                        // Check if this period has a conflict with TRRC
                        const trrcBbl = lin.trrc_months.find(t => t.period === r.period)?.oil_bbl;
                        const hasConflict = trrcBbl != null && r.oil_bbl != null && Math.abs(trrcBbl - r.oil_bbl) / Math.max(r.oil_bbl, 1) * 100 >= 20;
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: hasConflict ? T.redDim : "transparent" }}>
                            <td style={{ padding: "3px 6px", ...mono, color: hasConflict ? T.red : T.text }}>{r.period}</td>
                            <td style={{ padding: "3px 6px", textAlign: "right", fontWeight: 600, color: hasConflict ? T.red : T.text }}>
                              {r.oil_bbl != null ? r.oil_bbl.toLocaleString() : "—"}
                              {hasConflict && trrcBbl != null && (
                                <span style={{ fontSize: "0.65rem", color: T.red, marginLeft: 4 }}>≠TRRC:{trrcBbl}</span>
                              )}
                            </td>
                            <td style={{ padding: "3px 6px", textAlign: "right", color: T.muted }}>{r.gas_mcf != null && r.gas_mcf > 0 ? r.gas_mcf.toLocaleString() : "—"}</td>
                            <td style={{ padding: "3px 6px", textAlign: "right", color: T.muted }}>{r.oil_price_per_bbl != null ? `$${r.oil_price_per_bbl.toFixed(2)}` : "—"}</td>
                            <td style={{ padding: "3px 6px", textAlign: "right", color: T.muted }}>{r.gross_revenue_usd != null ? `$${Math.round(r.gross_revenue_usd).toLocaleString()}` : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div style={{ fontSize: "0.82rem", color: T.faint }}>No document production data extracted.</div>
            )}
          </div>

          {/* TRRC data */}
          <div style={{
            background: T.surfaceAlt,
            border: `1px solid ${hasCritical ? "rgba(239,68,68,0.4)" : trrcHasData ? "rgba(79,142,247,0.25)" : T.border}`,
            borderRadius: 8, padding: "0.75rem",
          }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: trrcHasData ? T.accent : T.faint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.4rem" }}>
              🏛️ TRRC Public Record
              {lin.trrc_lease_id && <span style={{ color: T.faint, fontWeight: 400, marginLeft: 6 }}>{lin.trrc_lease_id}</span>}
            </div>
            {trrcHasData ? (
              <>
                <div style={{ fontSize: "0.82rem", color: T.text, marginBottom: 2 }}>{lin.trrc_month_count} months</div>
                <div style={{ ...mono, color: T.faint, marginBottom: "0.5rem" }}>{lin.trrc_date_range}</div>
                <div style={{ overflowX: "auto", maxHeight: 220, overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
                    <thead>
                      <tr>
                        {["Period", "Oil BBL", "Gas MCF"].map(h => (
                          <th key={h} style={{ textAlign: h === "Period" ? "left" : "right", padding: "3px 6px", color: T.faint, fontSize: "0.7rem", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lin.trrc_months.map((r, i) => {
                        const docBbl = lin.doc_months.find(d => d.period === r.period)?.oil_bbl;
                        const hasConflict = docBbl != null && docBbl > 0 && Math.abs(r.oil_bbl - docBbl) / docBbl * 100 >= 20;
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: hasConflict ? T.redDim : "transparent" }}>
                            <td style={{ padding: "3px 6px", ...mono, color: hasConflict ? T.red : T.text }}>{r.period}</td>
                            <td style={{ padding: "3px 6px", textAlign: "right", fontWeight: 600, color: hasConflict ? T.red : T.text }}>
                              {r.oil_bbl > 0 ? r.oil_bbl.toLocaleString() : "—"}
                              {hasConflict && docBbl != null && (
                                <span style={{ fontSize: "0.65rem", color: T.red, marginLeft: 4 }}>≠Doc:{docBbl}</span>
                              )}
                            </td>
                            <td style={{ padding: "3px 6px", textAlign: "right", color: T.muted }}>{r.gas_mcf != null && r.gas_mcf > 0 ? r.gas_mcf.toLocaleString() : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div style={{ fontSize: "0.82rem", color: T.faint }}>No TRRC data returned. API may not have resolved to a TRRC lease.</div>
            )}
          </div>
        </div>

        {/* Conflict summary */}
        {lin.conflicting_periods.length > 0 && (
          <div style={{
            background: hasCritical ? T.redDim : T.yellowDim,
            border: `1px solid ${hasCritical ? "rgba(239,68,68,0.35)" : "rgba(245,158,11,0.3)"}`,
            borderRadius: 8, padding: "0.75rem 0.9rem",
          }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, color: hasCritical ? T.red : T.yellow, marginBottom: "0.45rem" }}>
              {hasCritical ? "🚨" : "⚠️"} Period-by-Period Conflicts ({lin.conflicting_periods.length} of {lin.overlapping_periods.length} overlapping)
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem" }}>
                <thead>
                  <tr>
                    {["Period", "Doc BBL", "TRRC BBL", "Diff BBL", "Diff %", "Severity"].map(h => (
                      <th key={h} style={{ textAlign: h === "Period" ? "left" : "right", padding: "4px 8px", color: T.faint, fontSize: "0.7rem", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lin.conflicting_periods.map((c, i) => {
                    const isCrit = Math.abs(c.pct_diff) >= 20;
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: "4px 8px", ...mono, color: T.text }}>{c.period}</td>
                        <td style={{ padding: "4px 8px", textAlign: "right", color: T.muted }}>{c.doc_bbl.toLocaleString()}</td>
                        <td style={{ padding: "4px 8px", textAlign: "right", color: T.text, fontWeight: 600 }}>{c.trrc_bbl.toLocaleString()}</td>
                        <td style={{ padding: "4px 8px", textAlign: "right", color: isCrit ? T.red : T.yellow }}>
                          {c.trrc_bbl > c.doc_bbl ? "+" : ""}{Math.round(c.trrc_bbl - c.doc_bbl).toLocaleString()}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", fontWeight: 700, color: isCrit ? T.red : T.yellow }}>
                          {c.pct_diff >= 0 ? "+" : ""}{c.pct_diff.toFixed(1)}%
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right" }}>
                          <span style={{
                            fontSize: "0.68rem", fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                            background: isCrit ? T.redDim : T.yellowDim,
                            color: isCrit ? T.red : T.yellow,
                          }}>{isCrit ? "CRITICAL" : "MINOR"}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 2: Dataset Used at Each Stage
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={card}>
        {sectionHead("Section 2 — Dataset Used at Each Pipeline Stage")}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem" }}>
          {[
            {
              stage: "Decline Curve Analysis",
              source: lin.dca_source,
              detail: `${lin.dca_row_count} row(s) used as DCA input`,
              rate: lin.dca_rate_bbl_used,
              rateLabel: "DCA anchor rate",
            },
            {
              stage: "Economics Engine",
              source: lin.economics_source,
              detail: lin.economics_rate_basis,
              rate: lin.economics_rate_bbl,
              rateLabel: "Rate used",
            },
            {
              stage: "Offer Range",
              source: lin.authoritative_source,
              detail: "Same as economics",
              rate: lin.offer_range_rate_bbl,
              rateLabel: "Rate used",
            },
          ].map(({ stage, source, detail, rate, rateLabel }) => (
            <div key={stage} style={{
              background: T.surfaceAlt,
              border: `1px solid ${hasCritical ? "rgba(239,68,68,0.25)" : T.border}`,
              borderRadius: 8, padding: "0.7rem 0.85rem",
            }}>
              <div style={{ fontSize: "0.72rem", color: T.faint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{stage}</div>
              <div style={{
                fontSize: "0.82rem", fontWeight: 700,
                color: source === "trrc" ? T.accent : source === "document" ? T.green : T.red,
                marginBottom: 2,
              }}>
                {source === "trrc" ? "TRRC" : source === "document" ? "Document" : "None"}
                {hasCritical && source !== "none" && (
                  <span style={{ color: T.red, fontWeight: 700, marginLeft: 6, fontSize: "0.72rem" }}>⚠️ mismatch</span>
                )}
              </div>
              {rate != null && (
                <div style={{ fontSize: "0.8rem", color: T.text, fontWeight: 600, marginBottom: 2 }}>
                  {rate.toLocaleString()} BBL/mo
                  <span style={{ color: T.faint, fontWeight: 400, fontSize: "0.7rem", marginLeft: 4 }}>{rateLabel}</span>
                </div>
              )}
              <div style={{ fontSize: "0.73rem", color: T.faint, lineHeight: 1.4 }}>{detail}</div>
            </div>
          ))}
        </div>
        {hasCritical && (
          <div style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: T.red, lineHeight: 1.5, padding: "0.55rem 0.75rem", background: T.redDim, borderRadius: 7 }}>
            🚨 All three stages above used TRRC data that conflicts with uploaded document production.
            Verify the TRRC lease identity before trusting any calculated value in this report.
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 3: Key Inputs Provenance Table
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={card}>
        {sectionHead("Section 3 — Key Input Provenance")}
        <p style={{ fontSize: "0.8rem", color: T.faint, margin: "0 0 0.85rem", lineHeight: 1.5 }}>
          Every value used in this report — source, raw value returned, transformation applied, and final value displayed.
          Conflicts flag when another source had a different value and was not used.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.79rem" }}>
            <thead>
              <tr>
                {["Field", "Source", "Raw Value", "Transformation", "Final Value", "Confidence", "Conflict"].map(h => (
                  <th key={h} style={{
                    textAlign: "left", padding: "6px 10px",
                    color: T.faint, fontWeight: 600,
                    borderBottom: `1px solid ${T.border}`,
                    fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em",
                    whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prov.key_inputs.map((rec, i) => {
                const confColor = rec.confidence === "high" ? T.green
                  : rec.confidence === "medium" ? T.yellow
                  : rec.confidence === "low" ? T.red : T.faint;
                const isWarning = rec.conflict != null;
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: isWarning ? "rgba(239,68,68,0.04)" : "transparent" }}>
                    <td style={{ padding: "6px 10px", fontWeight: 700, color: T.text, whiteSpace: "nowrap" }}>
                      {rec.field}
                    </td>
                    <td style={{ padding: "6px 10px", color: T.muted, fontSize: "0.76rem", maxWidth: 160, lineHeight: 1.3 }}>
                      {rec.source_label}
                    </td>
                    <td style={{ padding: "6px 10px", ...mono, color: T.muted, maxWidth: 200, lineHeight: 1.35 }}>
                      {rec.raw_value}
                    </td>
                    <td style={{ padding: "6px 10px", color: T.faint, fontSize: "0.74rem", maxWidth: 200, lineHeight: 1.35 }}>
                      {rec.transformation ?? "—"}
                    </td>
                    <td style={{ padding: "6px 10px", fontWeight: 700, color: T.text, whiteSpace: "nowrap" }}>
                      {rec.final_value}
                    </td>
                    <td style={{ padding: "6px 10px" }}>
                      <span style={{
                        display: "inline-block",
                        fontSize: "0.68rem", fontWeight: 700,
                        padding: "1px 6px", borderRadius: 4,
                        background: rec.confidence === "high" ? T.greenDim
                          : rec.confidence === "medium" ? T.yellowDim
                          : rec.confidence === "low" ? T.redDim
                          : T.surfaceAlt,
                        color: confColor,
                      }}>
                        {rec.confidence.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: "6px 10px", maxWidth: 220 }}>
                      {rec.conflict ? (
                        <div style={{ fontSize: "0.73rem", lineHeight: 1.4 }}>
                          <div style={{ color: T.red, fontWeight: 700, marginBottom: 2 }}>⚠️ Conflict</div>
                          <div style={{ color: T.muted }}>{rec.conflict.alt_source}: <span style={{ color: T.yellow }}>{rec.conflict.alt_value}</span></div>
                          <div style={{ color: T.faint, marginTop: 2 }}>{rec.conflict.why_not_used}</div>
                        </div>
                      ) : (
                        <span style={{ color: T.faint, fontSize: "0.72rem" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 4: Warnings
      ══════════════════════════════════════════════════════════════════════ */}
      {lin.warnings.length > 0 && (
        <div style={card}>
          {sectionHead("Section 4 — Lineage Warnings", T.yellow)}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
            {lin.warnings.map((w, i) => (
              <div key={i} style={{
                background: w.startsWith("CRITICAL") ? T.redDim : T.yellowDim,
                border: `1px solid ${w.startsWith("CRITICAL") ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.25)"}`,
                borderRadius: 7, padding: "0.55rem 0.8rem",
                fontSize: "0.82rem",
                color: w.startsWith("CRITICAL") ? T.red : T.yellow,
                lineHeight: 1.5,
              }}>
                {w}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Production Audit Tab ─────────────────────────────────────────────────────
//
// Shows every raw TRRC row before and after classification so analysts can
// verify production numbers against run statements and identify divergence.

function ProductionAuditTab({ report }: { report: DDReport }) {
  const audit = report.production_audit;
  const [showRaw, setShowRaw]            = useState(true);
  const [showClassified, setShowClassified] = useState(true);

  const T = {
    surface:    "#181c25",
    surfaceAlt: "#1e2333",
    border:     "rgba(255,255,255,0.08)",
    text:       "#e2e8f0",
    muted:      "#8892a4",
    faint:      "#5a6478",
    accent:     "#4f8ef7",
    green:      "#22c55e",
    yellow:     "#f59e0b",
    red:        "#ef4444",
    greenDim:   "rgba(34,197,94,0.12)",
    yellowDim:  "rgba(245,158,11,0.12)",
    redDim:     "rgba(239,68,68,0.12)",
    accentDim:  "rgba(79,142,247,0.12)",
  };

  const classColor = (c: string) => {
    if (c === "active")     return { bg: T.greenDim,  color: T.green,  label: "ACTIVE"     };
    if (c === "downtime")   return { bg: T.redDim,    color: T.red,    label: "DOWNTIME"   };
    if (c === "restart")    return { bg: T.yellowDim, color: T.yellow, label: "RESTART"    };
    if (c === "flush")      return { bg: T.accentDim, color: T.accent, label: "FLUSH"      };
    if (c === "incomplete") return { bg: T.yellowDim, color: T.yellow, label: "INCOMPLETE" };
    return                         { bg: T.surfaceAlt, color: T.muted, label: c.toUpperCase() };
  };

  const card: React.CSSProperties = {
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: 12,
    padding: "1rem 1.1rem",
    marginBottom: "1rem",
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: "0.9rem", fontWeight: 700, color: T.text, marginBottom: "0.65rem",
  };

  const mono: React.CSSProperties = {
    fontFamily: "monospace", fontSize: "0.78rem", color: T.muted,
  };

  if (!audit) {
    return (
      <div style={card}>
        <p style={{ color: T.muted, fontSize: "0.88rem", margin: 0 }}>
          Production audit data not available — run a full underwriting analysis to generate audit trail.
        </p>
      </div>
    );
  }

  const totalExcluded =
    audit.months_downtime + audit.months_restart + audit.months_flush + audit.months_incomplete;

  return (
    <div style={{ paddingBottom: "2rem" }}>

      {/* ── Warning banner if no raw rows ── */}
      {audit.raw_row_count === 0 && (
        <div style={{
          background: T.redDim, border: `1px solid rgba(239,68,68,0.3)`,
          borderRadius: 10, padding: "0.85rem 1rem", marginBottom: "1rem",
          color: T.red, fontSize: "0.88rem", lineHeight: 1.5,
        }}>
          ⚠️ <strong>No production rows returned.</strong> TRRC could not resolve a lease from the provided API number(s),
          or the lease returned zero rows. Verify that the API number is correct and that a TRRC production record exists.
        </div>
      )}

      {/* ── Audit notes (if any) ── */}
      {audit.notes.length > 0 && (
        <div style={{ marginBottom: "1rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {audit.notes.map((n, i) => (
            <div key={i} style={{
              background: T.yellowDim,
              border: `1px solid rgba(245,158,11,0.25)`,
              borderRadius: 8, padding: "0.55rem 0.85rem",
              fontSize: "0.82rem", color: T.yellow, lineHeight: 1.5,
            }}>
              {n}
            </div>
          ))}
        </div>
      )}

      {/* ── Identity Resolution ── */}
      <div style={card}>
        <div style={sectionTitle}>Identity Resolution</div>
        <dl style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ ...mono, minWidth: 160, color: T.faint }}>Input API(s)</dt>
            <dd style={{ margin: 0, ...mono, color: T.text }}>
              {audit.input_apis.length > 0 ? audit.input_apis.join(", ") : <span style={{ color: T.faint }}>None provided</span>}
            </dd>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ ...mono, minWidth: 160, color: T.faint }}>Resolved API(s)</dt>
            <dd style={{ margin: 0, ...mono, color: T.text }}>
              {audit.resolved_apis.length > 0 ? audit.resolved_apis.join(", ") : <span style={{ color: T.faint }}>—</span>}
            </dd>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ ...mono, minWidth: 160, color: T.faint }}>TRRC Lease(s)</dt>
            <dd style={{ margin: 0, ...mono, color: T.text }}>
              {audit.resolved_leases.length > 0
                ? audit.resolved_leases.map(l => (
                    <span key={l} style={{ marginRight: "0.75rem" }}>
                      Dist:Lease <strong style={{ color: T.accent }}>{l}</strong>
                    </span>
                  ))
                : <span style={{ color: T.faint }}>—</span>}
            </dd>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ ...mono, minWidth: 160, color: T.faint }}>TRRC District(s)</dt>
            <dd style={{ margin: 0, ...mono, color: T.text }}>
              {audit.trrc_districts.length > 0 ? audit.trrc_districts.join(", ") : <span style={{ color: T.faint }}>—</span>}
            </dd>
          </div>
          {audit.trrc_production_url && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ ...mono, minWidth: 160, color: T.faint }}>Production URL</dt>
              <dd style={{ margin: 0 }}>
                <a href={audit.trrc_production_url} target="_blank" rel="noopener noreferrer"
                   style={{ ...mono, color: T.accent, textDecoration: "underline" }}>
                  {audit.trrc_production_url}
                </a>
              </dd>
            </div>
          )}
        </dl>

        {/* Resolution steps */}
        {audit.resolution_steps.length > 0 && (
          <div style={{ marginTop: "0.85rem" }}>
            <div style={{ fontSize: "0.75rem", color: T.faint, marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Resolution steps
            </div>
            <ol style={{ margin: 0, paddingLeft: "1.2rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
              {audit.resolution_steps.map((s, i) => (
                <li key={i} style={{ fontSize: "0.8rem", color: T.muted, lineHeight: 1.45 }}>{s}</li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* ── Production summary strip ── */}
      <div style={{
        ...card,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
        gap: "0.75rem",
        textAlign: "center",
      }}>
        {[
          { label: "Raw Rows",   value: audit.raw_row_count,        color: T.text   },
          { label: "Active",     value: audit.months_active,        color: T.green  },
          { label: "Downtime",   value: audit.months_downtime,      color: T.red    },
          { label: "Restart",    value: audit.months_restart,       color: T.yellow },
          { label: "Flush",      value: audit.months_flush,         color: T.accent },
          { label: "Incomplete", value: audit.months_incomplete,    color: T.yellow },
          { label: "Excluded",   value: totalExcluded,              color: totalExcluded > 0 ? T.red : T.faint },
          { label: "DCA Input",  value: audit.dca_input_row_count,  color: T.text   },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <div style={{ fontSize: "1.35rem", fontWeight: 800, color }}>{value}</div>
            <div style={{ fontSize: "0.68rem", color: T.faint, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* ── Stabilized rate used ── */}
      {audit.stabilized_rate_bbl != null && (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: "1.5rem" }}>
          <div>
            <div style={{ fontSize: "0.68rem", color: T.faint, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>
              Rate Used in Economics
            </div>
            <div style={{ fontSize: "1.5rem", fontWeight: 800, color: T.green }}>
              {audit.stabilized_rate_bbl.toLocaleString()} <span style={{ fontSize: "0.85rem", fontWeight: 400, color: T.muted }}>BBL/mo</span>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.72rem", color: T.muted, lineHeight: 1.5 }}>
              Basis: {audit.stabilized_rate_basis}
            </div>
          </div>
        </div>
      )}

      {/* ── Raw TRRC / doc rows ── */}
      <div style={card}>
        <button
          type="button"
          onClick={() => setShowRaw(v => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            display: "flex", alignItems: "center", gap: "0.5rem", width: "100%",
          }}
        >
          <span style={sectionTitle}>{showRaw ? "▼" : "▶"} Raw Production Records ({audit.raw_row_count} rows)</span>
          <span style={{ fontSize: "0.72rem", color: T.faint, fontWeight: 400 }}>
            {audit.raw_rows[0]?.source === "trrc_actual" ? "Source: TRRC Specific Lease Query" : "Source: Document extraction"}
            {audit.raw_date_range ? ` · ${audit.raw_date_range}` : ""}
          </span>
        </button>
        {showRaw && (
          <>
            <p style={{ fontSize: "0.8rem", color: T.faint, margin: "0.35rem 0 0.75rem", lineHeight: 1.5 }}>
              These are the exact values returned from TRRC before any classification, filtering, or stabilization.
              Compare directly to run-statement purchaser values to identify source of divergence.
            </p>
            {audit.raw_row_count === 0
              ? <p style={{ color: T.red, fontSize: "0.82rem" }}>No rows returned.</p>
              : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                    <thead>
                      <tr>
                        {["Period", "Oil BBL", "Gas MCF", "Source"].map(h => (
                          <th key={h} style={{
                            textAlign: h === "Period" || h === "Source" ? "left" : "right",
                            padding: "5px 9px",
                            color: T.faint, fontWeight: 600,
                            borderBottom: `1px solid ${T.border}`,
                            fontSize: "0.75rem",
                            textTransform: "uppercase", letterSpacing: "0.04em",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {audit.raw_rows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                          <td style={{ padding: "5px 9px", ...mono, color: T.text }}>{r.period}</td>
                          <td style={{ padding: "5px 9px", textAlign: "right", fontWeight: 600, color: r.oil_bbl > 0 ? T.text : T.faint }}>
                            {r.oil_bbl > 0 ? r.oil_bbl.toLocaleString() : "—"}
                          </td>
                          <td style={{ padding: "5px 9px", textAlign: "right", color: r.gas_mcf != null && r.gas_mcf > 0 ? T.green : T.faint }}>
                            {r.gas_mcf != null && r.gas_mcf > 0 ? r.gas_mcf.toLocaleString() : "—"}
                          </td>
                          <td style={{ padding: "5px 9px", ...mono, color: T.faint }}>
                            {r.source === "trrc_actual" ? "TRRC" : "Doc"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </>
        )}
      </div>

      {/* ── Classified rows ── */}
      <div style={card}>
        <button
          type="button"
          onClick={() => setShowClassified(v => !v)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: 0,
            display: "flex", alignItems: "center", gap: "0.5rem", width: "100%",
          }}
        >
          <span style={sectionTitle}>{showClassified ? "▼" : "▶"} Classification Detail ({audit.classified_rows.length} rows)</span>
          {totalExcluded > 0 && (
            <span style={{ fontSize: "0.72rem", color: T.yellow, fontWeight: 500 }}>
              {totalExcluded} month{totalExcluded !== 1 ? "s" : ""} excluded from economics
            </span>
          )}
        </button>
        {showClassified && (
          <>
            <p style={{ fontSize: "0.8rem", color: T.faint, margin: "0.35rem 0 0.75rem", lineHeight: 1.5 }}>
              Months marked <strong style={{ color: T.green }}>ACTIVE</strong> are used in stabilized averages and economics.
              <strong style={{ color: T.red }}> DOWNTIME</strong> = zero/sub-threshold production.
              <strong style={{ color: T.yellow }}> INCOMPLETE</strong> = within TRRC 3-month lag window and below 55% of trend — excluded to avoid partial-month bias.
              <strong style={{ color: T.yellow }}> RESTART</strong> = first 2 months after a shut-in — excluded as transitional.
              <strong style={{ color: T.accent }}> FLUSH</strong> = &gt;2.5× running median — post-stimulation spike.
            </p>
            {audit.classified_rows.length === 0
              ? <p style={{ color: T.faint, fontSize: "0.82rem" }}>No classified rows available.</p>
              : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.79rem" }}>
                    <thead>
                      <tr>
                        {["Period", "Oil BBL", "Gas MCF", "Classification", "In Stabilized?", "In DCA?", "Note"].map(h => (
                          <th key={h} style={{
                            textAlign: h === "Period" || h === "Classification" || h === "Note" ? "left" : "right",
                            padding: "5px 9px",
                            color: T.faint, fontWeight: 600,
                            borderBottom: `1px solid ${T.border}`,
                            fontSize: "0.72rem",
                            textTransform: "uppercase", letterSpacing: "0.04em",
                            whiteSpace: "nowrap",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {audit.classified_rows.map((r, i) => {
                        const cl = classColor(r.classification);
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                            <td style={{ padding: "5px 9px", ...mono, color: T.text }}>{r.period}</td>
                            <td style={{ padding: "5px 9px", textAlign: "right", fontWeight: 600, color: r.oil_bbl > 0 ? T.text : T.faint }}>
                              {r.oil_bbl > 0 ? r.oil_bbl.toLocaleString() : "—"}
                            </td>
                            <td style={{ padding: "5px 9px", textAlign: "right", color: r.gas_mcf != null && r.gas_mcf > 0 ? T.green : T.faint }}>
                              {r.gas_mcf != null && r.gas_mcf > 0 ? r.gas_mcf.toLocaleString() : "—"}
                            </td>
                            <td style={{ padding: "5px 9px" }}>
                              <span style={{
                                display: "inline-block",
                                background: cl.bg, color: cl.color,
                                fontSize: "0.68rem", fontWeight: 700,
                                padding: "1px 6px", borderRadius: 4,
                                textTransform: "uppercase", letterSpacing: "0.04em",
                              }}>
                                {cl.label}
                              </span>
                            </td>
                            <td style={{ padding: "5px 9px", textAlign: "right" }}>
                              <span style={{ color: r.used_in_stabilized_avg ? T.green : T.red, fontWeight: 700, fontSize: "0.78rem" }}>
                                {r.used_in_stabilized_avg ? "✓" : "✗"}
                              </span>
                            </td>
                            <td style={{ padding: "5px 9px", textAlign: "right" }}>
                              <span style={{ color: r.used_in_dca ? T.green : T.faint, fontWeight: 700, fontSize: "0.78rem" }}>
                                {r.used_in_dca ? "✓" : "—"}
                              </span>
                            </td>
                            <td style={{ padding: "5px 9px", color: T.faint, fontSize: "0.74rem", maxWidth: 260, lineHeight: 1.4 }}>
                              {r.classification_note ?? ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </>
        )}
      </div>

      {/* ── Aggregation logic ── */}
      <div style={card}>
        <div style={sectionTitle}>Aggregation Logic</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.82rem", color: T.muted, lineHeight: 1.55 }}>
          <p style={{ margin: 0 }}>
            <strong style={{ color: T.text }}>Step 1 — Fetch:</strong> TRRC Specific Lease Query returns monthly production for the resolved TRRC lease number.
            Production is <em>lease-level</em> (all wells on the lease aggregated). Individual well allocations are not available from TRRC public records.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: T.text }}>Step 2 — Sort &amp; calendar-index:</strong> Rows are sorted chronologically and assigned a calendar_t (elapsed months from first row).
            This preserves downtime gaps so the DCA time axis is not artificially compressed.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: T.text }}>Step 3 — Classify:</strong> Each month is tagged as active / downtime / restart / flush / incomplete.
            <em> Incomplete</em>: within 3-month TRRC lag window AND &lt;55% of prior 6-month trend.
            <em> Restart</em>: first 2 months after any downtime period.
            <em> Flush</em>: &gt;2.5× running median.
            <em> Downtime</em>: oil_bbl &lt;5 BBL.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: T.text }}>Step 4 — Stabilize:</strong> Stabilized averages (3-mo, 6-mo, 12-mo) are computed from <em>active months only</em>,
            using a trailing calendar window. The best available stabilized rate (preferring 3-mo) is used as the economics input.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: T.text }}>Step 5 — DCA:</strong> Arps hyperbolic/exponential fit runs on active + flush months with calendar time preserved.
            Decline projections are anchored to the current stabilized rate.
          </p>
          <p style={{ margin: 0, padding: "0.5rem 0.75rem", background: T.surfaceAlt, borderRadius: 6, color: T.yellow, fontSize: "0.8rem" }}>
            ⚠️ <strong>Divergence diagnostic:</strong> If the Raw Production Records above already differ from your run-statement values,
            the issue is at the TRRC fetch level — TRRC may have resolved a different lease than the purchaser used.
            Verify the resolved Dist:Lease above against the lease number shown on your run statement.
            If the raw rows match but the economics output differs, the divergence is in the classification step — check the Classification Detail above for excluded months.
          </p>
        </div>
      </div>

    </div>
  );
}

// ─── Decline Curve Tab ────────────────────────────────────────────────────────

function DcaTab({ report }: { report: DDReport }) {
  const dca = report.dca;

  // Derive the last production period for labeled x-axis on the projection chart
  const lastPeriod = (() => {
    let best: string | null = null;
    for (const well of report.production.wells) {
      for (const row of well.monthly_history) {
        if (!best || row.period > best) best = row.period;
      }
    }
    return best;
  })();

  return (
    <div>
      <Section title="Decline-Support Exhibit" icon="📉">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 2rem", marginBottom: "1rem" }}>
          <KvRow label="Model Type"><DataCell dp={dca.model_type} format={v => v.charAt(0).toUpperCase() + v.slice(1)} /></KvRow>
          <KvRow label="Monthly Decline %"><DataCell dp={dca.decline_rate_monthly_pct} format={fmtPct} /></KvRow>
          <KvRow label="Annual Decline %"><DataCell dp={dca.decline_rate_annual_pct} format={fmtPct} /></KvRow>
          <KvRow label="Arps b-Factor"><DataCell dp={dca.b_factor} format={v => v.toFixed(3)} /></KvRow>
          <KvRow label="R² (fit quality)"><DataCell dp={dca.r_squared} format={v => v.toFixed(3)} /></KvRow>
          <KvRow label="Current Rate (BBL/mo)"><DataCell dp={dca.current_rate_bbl} format={v => fmtN(v)} /></KvRow>
          <KvRow label="Current Rate (BOPD)">
            <span style={{ fontWeight: 700, color: dca.current_rate_bopd.value != null ? COLORS.text : COLORS.textFaint }}>
              {dca.current_rate_bopd.value != null ? `${dca.current_rate_bopd.value.toFixed(1)} BOPD` : "—"}
            </span>
          </KvRow>
          <KvRow label="Peak Rate (BBL/mo)"><DataCell dp={dca.peak_rate_bbl} format={v => fmtN(v)} /></KvRow>
          <KvRow label="Cum. Production (BBL)"><DataCell dp={dca.cum_oil_bbl} format={v => fmtN(v)} /></KvRow>
          <KvRow label="EUR (BBL)"><DataCell dp={dca.eur_bbl} format={v => fmtN(v)} /></KvRow>
          <KvRow label="Remaining Reserves (BBL)"><DataCell dp={dca.remaining_reserves_bbl} format={v => fmtN(v)} /></KvRow>
          <KvRow label="Economic Life (months)"><DataCell dp={dca.economic_life_months} format={v => `${v} months`} /></KvRow>
        </div>
        {dca.notes.length > 0 && (
          <div style={{ background: COLORS.surfaceAlt, borderRadius: 6, padding: "0.6rem 0.9rem", fontSize: "0.78rem", color: COLORS.textMuted }}>
            {dca.notes.map((n, i) => <div key={i}>{n}</div>)}
          </div>
        )}
      </Section>

      {dca.projections.length > 0 && (
        <Section title="60-Month Production Projection (Arps Decline)" icon="📈">
          <DcaProjectionChart projections={dca.projections} lastPeriod={lastPeriod} />
          <div style={{ marginTop: "0.75rem", overflowX: "auto" }}>
            <DdTable
              headers={["Month", "1", "6", "12", "18", "24", "36", "48", "60"]}
              rows={[[
                "BBL/mo (projected)",
                ...([1, 6, 12, 18, 24, 36, 48, 60].map(m => {
                  const p = dca.projections.find(p => p.month === m);
                  return p ? fmtN(Math.round(p.rate_bbl)) : "—";
                })),
              ]]}
            />
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Acquisition Economics Tab ────────────────────────────────────────────────

// ─── Sensitivity Matrix Table ─────────────────────────────────────────────────

function SensitivityMatrixTable({ matrix }: { matrix: SensitivityMatrix }) {
  const fmt = (v: number) =>
    v >= 1_000_000  ? `$${(v / 1_000_000).toFixed(2)}MM`
    : v >= 1_000    ? `$${Math.round(v / 1_000)}K`
    : v < 0         ? `-$${Math.round(Math.abs(v) / 1_000)}K`
    : `$${Math.round(v)}`;

  const allNpvs = matrix.cells.flat().map(c => c.npv10_usd);
  const maxNpv  = Math.max(...allNpvs);
  const minNpv  = Math.min(...allNpvs);

  const cellBg = (npv: number, isBase: boolean) => {
    if (isBase) return COLORS.accent + "25";
    if (npv <= 0)  return COLORS.redDim;
    const ratio = maxNpv > 0 ? (npv - Math.max(minNpv, 0)) / Math.max(maxNpv - Math.max(minNpv, 0), 1) : 0;
    // Green gradient: dim → medium → bright
    const g = Math.round(80 + ratio * 120);
    return `rgba(0, ${g}, 60, 0.18)`;
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
        <thead>
          <tr>
            <th style={{ padding: "0.4rem 0.75rem", textAlign: "left", color: COLORS.textMuted, fontWeight: 600, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt }}>
              Prod. / Price →
            </th>
            {matrix.price_decks.map(d => (
              <th key={d} style={{ padding: "0.4rem 0.75rem", textAlign: "right", color: COLORS.textMuted, fontWeight: 600, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt }}>
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.cells.map((row, ri) => {
            const prodPct = matrix.production_multipliers[ri];
            return (
              <tr key={ri}>
                <td style={{ padding: "0.45rem 0.75rem", color: COLORS.textMuted, fontWeight: 600, background: COLORS.surfaceAlt, borderBottom: `1px solid ${COLORS.border}20`, whiteSpace: "nowrap" }}>
                  {prodPct}% Prod.
                  {prodPct === 100 && <span style={{ marginLeft: 6, fontSize: "0.66rem", color: COLORS.accent }}>(base)</span>}
                </td>
                {row.map((cell, ci) => {
                  const isBase = prodPct === 100 && matrix.price_decks[ci] === "Base";
                  return (
                    <td key={ci} style={{
                      padding: "0.45rem 0.75rem",
                      textAlign: "right",
                      fontWeight: isBase ? 800 : 500,
                      color: cell.npv10_usd < 0 ? COLORS.red : cell.npv10_usd === 0 ? COLORS.textFaint : COLORS.text,
                      background: cellBg(cell.npv10_usd, isBase),
                      borderBottom: `1px solid ${COLORS.border}20`,
                      border: isBase ? `1px solid ${COLORS.accent}60` : undefined,
                    }}>
                      {fmt(cell.npv10_usd)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ fontSize: "0.66rem", color: COLORS.textFaint, margin: "0.4rem 0 0 0" }}>
        Green = positive NPV10. Red = value-destructive at that scenario. Base case outlined in blue.
      </p>
    </div>
  );
}

// ─── Monthly Cash Flow Table ──────────────────────────────────────────────────

function MonthlyCFTable({ rows }: { rows: MonthlyCashFlowRow[] }) {
  const fmt$ = (v: number) =>
    v >= 1_000_000  ? `$${(v / 1_000_000).toFixed(2)}MM`
    : v >= 1_000    ? `$${Math.round(v / 1_000)}K`
    : v < 0         ? `($${Math.abs(Math.round(v)).toLocaleString()})`
    : `$${Math.round(v).toLocaleString()}`;
  const fmtN = (v: number) => Math.round(v).toLocaleString();

  // Show first 12 months, then summarize 13-24
  const displayed = rows.slice(0, 24);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
        <thead>
          <tr style={{ background: COLORS.surfaceAlt }}>
            {["Mo.", "Oil Rate (BBL)", "Gross Rev.", "Net Income", "Cum. Net Income"].map(h => (
              <th key={h} style={{ padding: "0.35rem 0.75rem", textAlign: h === "Mo." ? "center" : "right", color: COLORS.textMuted, fontWeight: 600, borderBottom: `1px solid ${COLORS.border}` }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayed.map((r, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : COLORS.surfaceAlt + "60" }}>
              <td style={{ padding: "0.3rem 0.75rem", textAlign: "center", color: COLORS.textFaint }}>{r.month}</td>
              <td style={{ padding: "0.3rem 0.75rem", textAlign: "right", color: COLORS.text }}>{fmtN(r.rate_bbl)}</td>
              <td style={{ padding: "0.3rem 0.75rem", textAlign: "right", color: COLORS.text }}>{fmt$(r.gross_revenue)}</td>
              <td style={{ padding: "0.3rem 0.75rem", textAlign: "right", color: r.net_income >= 0 ? COLORS.green : COLORS.red, fontWeight: 600 }}>
                {fmt$(r.net_income)}
              </td>
              <td style={{ padding: "0.3rem 0.75rem", textAlign: "right", color: r.cumulative_net_income >= 0 ? COLORS.text : COLORS.red }}>
                {fmt$(r.cumulative_net_income)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.66rem", color: COLORS.textFaint, margin: "0.4rem 0 0 0" }}>
        Projected at base-case pricing with Arps decline applied. Net income = Gross Revenue × NRI − LOE × WI − Severance Tax.
      </p>
    </div>
  );
}

// ─── Acquisition Economics Tab ────────────────────────────────────────────────

function AcqEconomicsTab({ report }: { report: DDReport }) {
  const econ = report.acquisition_economics;

  return (
    <div>
      {/* Key metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1rem" }}>
        {[
          { label: "Monthly Net Income", dp: econ.monthly_net_income_usd, fmt: fmt$ },
          { label: "Annual Net Income",  dp: econ.annual_net_income_usd,  fmt: fmt$ },
          { label: "NPV10 (Base)",       dp: econ.npv10_usd,              fmt: fmt$ },
          { label: "Breakeven Oil",      dp: econ.breakeven_oil_price,    fmt: (v: number) => `$${v.toFixed(2)}/bbl` },
        ].map(({ label, dp, fmt }) => (
          <div key={label} style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: "1rem",
          }}>
            <div style={{ fontSize: "0.7rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
              {label}
            </div>
            <div style={{ fontSize: "1.1rem", fontWeight: 800, color: COLORS.text }}>
              {dp.value != null
                ? <><span>{fmt(dp.value)}</span> <SourceBadge source={dp.source} /></>
                : <span style={{ color: COLORS.textFaint, fontSize: "0.8rem", fontStyle: "italic" }}>{dp.note ?? "—"}</span>
              }
            </div>
          </div>
        ))}
      </div>

      {/* Offer range */}
      {econ.offer_range_mid.value && (
        <Section title="Estimated Offer Range (Base Case)" icon="💰">
          <div style={{ display: "flex", gap: "1.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.5rem" }}>
            {[
              { label: "Conservative (3× NCF)", dp: econ.offer_range_low, color: COLORS.yellow },
              { label: "Mid (4.5× NCF)", dp: econ.offer_range_mid, color: COLORS.green },
              { label: "Aggressive (6× NCF)", dp: econ.offer_range_high, color: COLORS.accent },
            ].map(({ label, dp, color }) => (
              <div key={label} style={{
                background: COLORS.surfaceAlt,
                borderRadius: 8,
                padding: "0.75rem 1.25rem",
                flex: 1,
                minWidth: 160,
              }}>
                <div style={{ fontSize: "0.7rem", color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: "1.25rem", fontWeight: 800, color }}>
                  {dp.value != null ? fmt$(dp.value) : "—"}
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: "0.72rem", color: COLORS.textFaint, margin: "0.5rem 0 0 0" }}>
            ⚠️ Preliminary estimates only. Based on TRRC production × price decks minus operator LOE.
            Assumes NRI {((econ.nri_decimal.value ?? 0.75) * 100).toFixed(0)}%, WI {((econ.wi_decimal.value ?? 1) * 100).toFixed(0)}%.
            Not a substitute for a reserve engineer's valuation.
          </p>
        </Section>
      )}

      {/* Scenario table */}
      {econ.scenarios.length > 0 && (
        <Section title="Price Deck Scenarios" icon="📊">
          <DdTable
            headers={["Deck", "Oil Price", "Gross Rev", "Net Rev", "Sev. Tax", "Net Income", "LOE/BOE", "NPV10", "NPV15", "Offer Mid", "IRR", "Payout"]}
            rows={econ.scenarios.map((s: EconomicsScenario) => [
              <strong key="d">{s.deck_label}</strong>,
              `$${s.oil_price_usd}/bbl`,
              fmt$(s.monthly_gross_revenue),
              fmt$(s.monthly_net_revenue),
              s.monthly_severance_tax > 0
                ? <span key="st" style={{ color: COLORS.yellow }}>({fmt$(s.monthly_severance_tax)})</span>
                : "—",
              <span key="ni" style={{ color: s.monthly_net_income >= 0 ? COLORS.green : COLORS.red }}>
                {fmt$(s.monthly_net_income)}
              </span>,
              `$${s.loe_per_boe.toFixed(2)}/BOE`,
              fmt$(s.npv10_usd),
              fmt$(s.npv15_usd),
              fmt$(s.offer_mid_usd),
              s.irr_pct != null ? `${s.irr_pct.toFixed(1)}%` : "—",
              s.payout_months != null ? `${s.payout_months} mo` : "—",
            ])}
          />
        </Section>
      )}

      {/* Sensitivity Matrix */}
      {econ.sensitivity_matrix && (
        <Section title="NPV10 Sensitivity Matrix (Production × Price)" icon="🔢">
          <p style={{ fontSize: "0.72rem", color: COLORS.textMuted, marginTop: 0, marginBottom: "0.75rem" }}>
            NPV10 at each combination of production rate vs. oil price scenario (Base-case highlighted).
            LOE is 50% fixed / 50% variable with production.
          </p>
          <SensitivityMatrixTable matrix={econ.sensitivity_matrix} />
        </Section>
      )}

      {/* Monthly Cash Flow Schedule */}
      {econ.monthly_cash_flow_schedule && econ.monthly_cash_flow_schedule.length > 0 && (
        <Section title="24-Month Projected Cash Flow (Base Deck)" icon="📅">
          <p style={{ fontSize: "0.72rem", color: COLORS.textMuted, marginTop: 0, marginBottom: "0.75rem" }}>
            Arps decline projected forward 24 months at base-case pricing. Net income after NRI, LOE, and severance tax.
          </p>
          <CashFlowChart schedule={econ.monthly_cash_flow_schedule} />
          <div style={{ marginTop: "1rem" }}>
            <MonthlyCFTable rows={econ.monthly_cash_flow_schedule} />
          </div>
        </Section>
      )}

      {/* Interest details */}
      <Section title="Interest Structure" icon="📜">
        <KvRow label="Net Revenue Interest (NRI)"><DataCell dp={econ.nri_decimal} format={v => `${(v * 100).toFixed(4)}%`} /></KvRow>
        <KvRow label="Working Interest (WI)"><DataCell dp={econ.wi_decimal} format={v => `${(v * 100).toFixed(2)}%`} /></KvRow>
        <KvRow label="Economic Life Remaining"><DataCell dp={econ.months_remaining} format={v => `${v} months (~${(v / 12).toFixed(1)} yrs)`} /></KvRow>
      </Section>

      {econ.notes.length > 0 && (
        <div style={{ background: COLORS.surfaceAlt, borderRadius: 6, padding: "0.75rem 1rem", fontSize: "0.78rem", color: COLORS.textMuted }}>
          {econ.notes.map((n, i) => <div key={i} style={{ padding: "0.2rem 0" }}>• {n}</div>)}
        </div>
      )}
    </div>
  );
}

// ─── Downtime Analysis Tab ────────────────────────────────────────────────────

function DowntimeTab({ report }: { report: DDReport }) {
  const s = report.downtime;

  const clsColor: Record<string, string> = {
    workover:         COLORS.green,
    major_workover:   COLORS.yellow,
    regulatory:       COLORS.red,
    mechanical:       COLORS.yellow,
    abandonment_risk: COLORS.red,
    current_offline:  COLORS.red,
    unknown:          COLORS.textFaint,
  };

  const clsLabel: Record<string, string> = {
    workover:         "Routine Workover",
    major_workover:   "Major Workover",
    regulatory:       "Regulatory / Compliance",
    mechanical:       "Mechanical Failure",
    abandonment_risk: "⚠️ Abandonment Risk",
    current_offline:  "🔴 Currently Offline",
    unknown:          "Unknown",
  };

  const consistencyColor: Record<string, string> = {
    consistent:    COLORS.green,
    intermittent:  COLORS.yellow,
    erratic:       COLORS.red,
  };

  return (
    <div>
      {/* Summary metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1rem" }}>
        {[
          {
            label: "Downtime %",
            value: s.downtime_pct.value != null ? `${s.downtime_pct.value.toFixed(1)}%` : "—",
            sub:   `${s.total_zero_months.value ?? 0} zero months / ${s.total_months_analyzed} total`,
            color: (s.downtime_pct.value ?? 0) > 20 ? COLORS.red : (s.downtime_pct.value ?? 0) > 5 ? COLORS.yellow : COLORS.green,
          },
          {
            label: "Normalized Rate",
            value: s.normalized_rate_bbl.value != null ? `${fmtN(s.normalized_rate_bbl.value)} BBL/mo` : "—",
            sub:   "Median of non-zero months",
            color: COLORS.accent,
          },
          {
            label: "Volatility Score",
            value: s.volatility_score.value != null ? `${s.volatility_score.value}/10` : "—",
            sub:   "0 = stable, 10 = erratic",
            color: (s.volatility_score.value ?? 0) >= 7 ? COLORS.red : (s.volatility_score.value ?? 0) >= 4 ? COLORS.yellow : COLORS.green,
          },
          {
            label: "Production Consistency",
            value: s.production_consistency.value ?? "—",
            sub:   s.current_offline.value ? "⚠️ Currently offline" : "Well is producing",
            color: consistencyColor[s.production_consistency.value ?? "erratic"] ?? COLORS.textFaint,
          },
        ].map(({ label, value, sub, color }) => (
          <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1rem" }}>
            <div style={{ fontSize: "0.7rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 800, color }}>{value}</div>
            <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Underwriting notes */}
      {s.underwriting_notes.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          {s.underwriting_notes.map((note, i) => (
            <div key={i} style={{
              background: note.startsWith("⚠️") ? COLORS.redDim : note.startsWith("✓") ? COLORS.greenDim : COLORS.surfaceAlt,
              border: `1px solid ${note.startsWith("⚠️") ? COLORS.red + "40" : note.startsWith("✓") ? COLORS.green + "40" : COLORS.border}`,
              borderRadius: 8,
              padding: "0.6rem 1rem",
              fontSize: "0.82rem",
              color: COLORS.text,
              marginBottom: "0.4rem",
            }}>
              {note}
            </div>
          ))}
        </div>
      )}

      {/* Downtime periods */}
      {s.periods.length > 0 ? (
        <Section title={`Downtime Periods (${s.periods.length})`} icon="⏱️">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {(s.periods as DowntimePeriod[]).map((p, i) => (
              <div key={i} style={{
                background: COLORS.surfaceAlt,
                border: `1px solid ${clsColor[p.classification] ?? COLORS.border}40`,
                borderLeft: `4px solid ${clsColor[p.classification] ?? COLORS.textFaint}`,
                borderRadius: "0 8px 8px 0",
                padding: "0.75rem 1rem",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.4rem" }}>
                  <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{
                      fontSize: "0.68rem", fontWeight: 700,
                      color: clsColor[p.classification] ?? COLORS.textFaint,
                      textTransform: "uppercase", letterSpacing: "0.06em",
                      background: (clsColor[p.classification] ?? COLORS.textFaint) + "20",
                      padding: "0.15rem 0.5rem", borderRadius: 4,
                    }}>
                      {clsLabel[p.classification] ?? p.classification}
                    </span>
                    <span style={{ fontSize: "0.8rem", fontWeight: 700, color: COLORS.text }}>
                      {p.start_period} – {p.end_period}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: COLORS.textMuted }}>
                      {p.duration_months} month{p.duration_months !== 1 ? "s" : ""}
                    </span>
                    {p.is_current && (
                      <span style={{ fontSize: "0.68rem", color: COLORS.red, fontWeight: 700 }}>CURRENT</span>
                    )}
                  </div>
                  {p.recovery_rate_pct != null && (
                    <span style={{
                      fontSize: "0.75rem", fontWeight: 600,
                      color: p.recovery_rate_pct >= 70 ? COLORS.green : p.recovery_rate_pct >= 40 ? COLORS.yellow : COLORS.red,
                    }}>
                      Recovery: {p.recovery_rate_pct}%
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "0.78rem", color: COLORS.textMuted }}>{p.classification_rationale}</div>
                {(p.pre_downtime_rate_bbl != null || p.post_downtime_rate_bbl != null) && (
                  <div style={{ display: "flex", gap: "1.5rem", marginTop: "0.4rem", fontSize: "0.75rem", color: COLORS.textFaint }}>
                    {p.pre_downtime_rate_bbl != null && <span>Pre-downtime: {fmtN(p.pre_downtime_rate_bbl)} BBL/mo</span>}
                    {p.post_downtime_rate_bbl != null && <span>Post-restart: {fmtN(p.post_downtime_rate_bbl)} BBL/mo</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="Downtime Periods" icon="⏱️">
          <p style={{ color: COLORS.textFaint, fontSize: "0.82rem" }}>
            {s.total_months_analyzed > 0
              ? "No zero-production periods detected — production was continuous across all reported months."
              : "No production history available for downtime analysis. Provide API number or upload production documents."}
          </p>
        </Section>
      )}
    </div>
  );
}

// ─── Buyer Q&A Tab ────────────────────────────────────────────────────────────

function BuyerQATab({ report }: { report: DDReport }) {
  const items: BuyerQA[] = report.buyer_qa.items;

  const confConfig: Record<string, { label: string; color: string; bg: string }> = {
    verified:       { label: "VERIFIED",       color: COLORS.green,  bg: COLORS.greenDim },
    inferred:       { label: "INFERRED",       color: COLORS.yellow, bg: COLORS.yellowDim },
    low_confidence: { label: "LOW CONFIDENCE", color: COLORS.yellow, bg: "rgba(245,158,11,0.08)" },
    outstanding:    { label: "OUTSTANDING",    color: COLORS.red,    bg: COLORS.redDim },
  };

  return (
    <div>
      <div style={{ marginBottom: "1rem", fontSize: "0.8rem", color: COLORS.textMuted }}>
        Auto-answered from TRRC data, production analysis, and uploaded documents. No additional AI calls.
        Each answer shows its confidence level: <strong style={{ color: COLORS.green }}>VERIFIED</strong> (third-party data) →{" "}
        <strong style={{ color: COLORS.yellow }}>INFERRED</strong> (rule-based logic) →{" "}
        <strong style={{ color: COLORS.yellow }}>LOW CONFIDENCE</strong> (limited data) →{" "}
        <strong style={{ color: COLORS.red }}>OUTSTANDING</strong> (missing data — action required).
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {items.map((qa, i) => {
          const cfg = confConfig[qa.confidence] ?? confConfig.outstanding;
          return (
            <div key={qa.id} style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10,
              overflow: "hidden",
            }}>
              {/* Header */}
              <div style={{
                background: cfg.bg,
                borderBottom: `1px solid ${cfg.color}30`,
                padding: "0.6rem 1rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.75rem",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <span style={{
                    fontSize: "0.65rem", fontWeight: 800,
                    color: cfg.color, letterSpacing: "0.08em",
                    background: cfg.color + "20", padding: "0.15rem 0.55rem", borderRadius: 4,
                  }}>
                    {cfg.label}
                  </span>
                  <span style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>Q{i + 1}</span>
                </div>
                {qa.sources.length > 0 && (
                  <span style={{ fontSize: "0.68rem", color: COLORS.textFaint }}>
                    {qa.sources.slice(0, 2).join(" · ")}
                  </span>
                )}
              </div>

              {/* Body */}
              <div style={{ padding: "0.9rem 1rem" }}>
                <div style={{ fontSize: "0.82rem", fontWeight: 700, color: COLORS.textMuted, marginBottom: "0.5rem" }}>
                  {qa.question}
                </div>
                <div style={{ fontSize: "0.88rem", fontWeight: 600, color: COLORS.text, marginBottom: "0.6rem" }}>
                  {qa.short_answer}
                </div>
                <div style={{ fontSize: "0.78rem", color: COLORS.textMuted, whiteSpace: "pre-line", lineHeight: 1.55 }}>
                  {qa.detail}
                </div>
                {qa.outstanding_diligence && (
                  <div style={{
                    marginTop: "0.6rem",
                    background: COLORS.redDim,
                    border: `1px solid ${COLORS.red}30`,
                    borderRadius: 6,
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.76rem",
                    color: COLORS.text,
                  }}>
                    <span style={{ color: COLORS.red, fontWeight: 700 }}>⚠️ Action required: </span>
                    {qa.outstanding_diligence}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Operational Timeline Tab ────────────────────────────────────────────────

function OperationalTimelineTab({ report }: { report: DDReport }) {
  const events = report.operational_timeline;

  const typeConfig: Record<OperationalTimelineEventType, { icon: string; label: string }> = {
    workover:             { icon: "🔧", label: "Workover"              },
    major_workover:       { icon: "🏗️", label: "Major Workover"        },
    production_drop:      { icon: "📉", label: "Production Drop"       },
    production_recovery:  { icon: "📈", label: "Production Recovery"   },
    downtime_start:       { icon: "🔴", label: "Offline / Downtime"    },
    downtime_end:         { icon: "🟢", label: "Production Restart"    },
    violation_opened:     { icon: "🚨", label: "Violation Opened"      },
    violation_closed:     { icon: "✅", label: "Violation Closed"      },
    mit_test:             { icon: "🧪", label: "MIT Test"              },
    operator_change:      { icon: "🔄", label: "Operator Change"       },
    inspection:           { icon: "🔍", label: "Inspection"            },
    completion:           { icon: "⛽", label: "Well Completion"       },
    recompletion:         { icon: "🔩", label: "Recompletion"          },
  };

  const severityBorder: Record<string, string> = {
    critical: COLORS.red,
    warning:  COLORS.yellow,
    info:     COLORS.border,
  };
  const severityBg: Record<string, string> = {
    critical: COLORS.redDim,
    warning:  COLORS.yellowDim,
    info:     COLORS.surfaceAlt,
  };

  if (events.length === 0) {
    return (
      <div style={{
        background: COLORS.surfaceAlt,
        border: `1px dashed ${COLORS.border}`,
        borderRadius: 10,
        padding: "2.5rem",
        textAlign: "center",
        color: COLORS.textFaint,
        fontSize: "0.82rem",
      }}>
        <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>📅</div>
        No operational events identified. Provide API numbers or upload workover reports, violation records, and production statements for timeline analysis.
      </div>
    );
  }

  // Group by year for visual separation
  const byYear = new Map<string, OperationalTimelineEvent[]>();
  for (const ev of events) {
    const yr = ev.period ? ev.period.slice(0, 4) : "Unknown";
    const arr = byYear.get(yr) ?? [];
    arr.push(ev);
    byYear.set(yr, arr);
  }

  return (
    <div>
      <div style={{ marginBottom: "1rem", fontSize: "0.78rem", color: COLORS.textMuted }}>
        Chronological correlation of workovers, violations, downtime periods, and production changes.
        Each event is sourced from TRRC, extracted documents, or inferred from production data.
      </div>

      {/* Summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1rem" }}>
        {[
          { label: "Total Events",      value: events.length,                                                   color: COLORS.text  },
          { label: "Critical Events",   value: events.filter(e => e.severity === "critical").length,            color: COLORS.red   },
          { label: "Warnings",          value: events.filter(e => e.severity === "warning").length,             color: COLORS.yellow},
          { label: "Downtime Events",   value: events.filter(e => e.event_type === "downtime_start").length,    color: COLORS.red   },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ fontSize: "0.65rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: "1.1rem", fontWeight: 800, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Timeline */}
      <div style={{ position: "relative" }}>
        {/* Vertical axis line */}
        <div style={{
          position: "absolute",
          left: 19,
          top: 0,
          bottom: 0,
          width: 2,
          background: COLORS.border,
          borderRadius: 2,
        }} />

        {Array.from(byYear.entries()).map(([year, yearEvents]) => (
          <div key={year} style={{ marginBottom: "1.5rem" }}>
            {/* Year marker */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              marginBottom: "0.75rem",
              position: "relative",
            }}>
              <div style={{
                width: 40,
                height: 40,
                background: COLORS.surfaceAlt,
                border: `2px solid ${COLORS.borderStrong}`,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.65rem",
                fontWeight: 800,
                color: COLORS.textMuted,
                flexShrink: 0,
                zIndex: 1,
              }}>
                {year}
              </div>
            </div>

            {/* Events in this year */}
            <div style={{ paddingLeft: "3.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {yearEvents.map((ev, i) => {
                const tc = typeConfig[ev.event_type] ?? { icon: "•", label: ev.event_type };
                const border = severityBorder[ev.severity] ?? COLORS.border;
                const bg = severityBg[ev.severity] ?? COLORS.surfaceAlt;

                return (
                  <div key={i} style={{
                    background: bg,
                    border: `1px solid ${border}40`,
                    borderLeft: `3px solid ${border}`,
                    borderRadius: "0 8px 8px 0",
                    padding: "0.65rem 1rem",
                    position: "relative",
                  }}>
                    {/* Connector dot */}
                    <div style={{
                      position: "absolute",
                      left: -39,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: border,
                      border: `2px solid ${COLORS.bg}`,
                    }} />

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "0.9rem" }}>{tc.icon}</span>
                        <span style={{
                          fontSize: "0.65rem",
                          fontWeight: 800,
                          color: border,
                          background: border + "15",
                          padding: "0.1rem 0.45rem",
                          borderRadius: 4,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}>
                          {tc.label}
                        </span>
                        {ev.period && (
                          <span style={{ fontSize: "0.72rem", color: COLORS.textMuted, fontWeight: 600 }}>
                            {ev.period}
                          </span>
                        )}
                        {ev.well && (
                          <span style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>
                            Well: {ev.well}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                        {ev.production_impact_bbl != null && (
                          <span style={{
                            fontSize: "0.7rem",
                            fontWeight: 700,
                            color: ev.production_impact_bbl >= 0 ? COLORS.green : COLORS.red,
                          }}>
                            {ev.production_impact_bbl >= 0 ? "+" : ""}{fmtN(ev.production_impact_bbl)} BBL
                          </span>
                        )}
                        <SourceBadge source={ev.source} />
                      </div>
                    </div>
                    <div style={{ fontSize: "0.78rem", color: COLORS.text, marginTop: "0.3rem" }}>
                      {ev.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Executive Summary Tab ───────────────────────────────────────────────────

function ExecutiveSummaryTab({ report }: { report: DDReport }) {
  const ex = report.executive_summary;
  const recColors: Record<string, string> = { pursue: COLORS.green, review: COLORS.yellow, pass: COLORS.red };
  const recColor = recColors[ex.recommendation.value ?? "review"] ?? COLORS.yellow;
  const trendColor = ex.production_trend.value === "increasing" ? COLORS.green
    : ex.production_trend.value === "declining" ? COLORS.red
    : ex.production_trend.value === "offline" ? COLORS.red
    : COLORS.yellow;

  const scoreColor = (ex.overall_risk_score.value ?? 5) <= 3 ? COLORS.green
    : (ex.overall_risk_score.value ?? 5) <= 6 ? COLORS.yellow
    : COLORS.red;

  return (
    <div>
      {/* Hero banner */}
      <div style={{
        background: COLORS.surface,
        border: `2px solid ${recColor}`,
        borderRadius: 14,
        padding: "1.75rem 2rem",
        marginBottom: "1.25rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        flexWrap: "wrap",
        gap: "1.5rem",
      }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: "0.68rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
            Acquisition Recommendation
          </div>
          <div style={{ fontSize: "2.75rem", fontWeight: 900, color: recColor, textTransform: "uppercase", letterSpacing: "0.04em", lineHeight: 1 }}>
            {ex.recommendation.value ?? "REVIEW"}
          </div>
          <div style={{ fontSize: "0.82rem", color: COLORS.textMuted, marginTop: 8, maxWidth: 520, lineHeight: 1.55 }}>
            {ex.recommendation_rationale}
          </div>
          <div style={{ fontSize: "0.78rem", color: COLORS.textFaint, marginTop: 8, fontStyle: "italic" }}>
            {ex.asset_description}
          </div>
        </div>

        {/* Key metrics column */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0.75rem", minWidth: 260 }}>
          {[
            { label: "Risk Score",     value: ex.overall_risk_score.value != null ? `${ex.overall_risk_score.value.toFixed(1)} / 10` : "—", color: scoreColor },
            { label: "Production Trend", value: ex.production_trend.value ?? "—", color: trendColor },
            { label: "Current Rate",   value: ex.current_gross_rate_bbl.value != null ? `${fmtN(ex.current_gross_rate_bbl.value)} BBL/mo` : "—", color: COLORS.text },
            { label: "Daily Rate (BOPD)", value: report.dca.current_rate_bopd.value != null ? `${report.dca.current_rate_bopd.value.toFixed(1)} BOPD` : (ex.current_gross_rate_bbl.value != null ? `${(ex.current_gross_rate_bbl.value / 30.44).toFixed(1)} BOPD` : "—"), color: COLORS.green },
            { label: "12-Mo Avg",      value: ex.twelve_month_avg_bbl.value != null ? `${fmtN(ex.twelve_month_avg_bbl.value)} BBL/mo` : "—", color: COLORS.text },
            { label: "Monthly NCF",    value: ex.monthly_net_income_usd.value != null ? fmt$(ex.monthly_net_income_usd.value) : "—", color: (ex.monthly_net_income_usd.value ?? 0) >= 0 ? COLORS.green : COLORS.red },
            { label: "NPV10",          value: ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "—", color: COLORS.text },
            { label: "Offer Range Low", value: ex.offer_range_low.value != null ? fmt$(ex.offer_range_low.value) : "—", color: COLORS.yellow },
            { label: "Offer Range High", value: ex.offer_range_high.value != null ? fmt$(ex.offer_range_high.value) : "—", color: COLORS.green },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: COLORS.surfaceAlt, borderRadius: 8, padding: "0.65rem 0.85rem" }}>
              <div style={{ fontSize: "0.62rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: "0.9rem", fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Downtime banner if significant */}
      {ex.downtime_pct != null && ex.downtime_pct > 10 && (
        <div style={{
          background: COLORS.redDim,
          border: `1px solid ${COLORS.red}40`,
          borderRadius: 8,
          padding: "0.65rem 1rem",
          marginBottom: "1rem",
          fontSize: "0.82rem",
          color: COLORS.text,
        }}>
          ⚠️ <strong>Production Interruptions:</strong> {ex.downtime_pct.toFixed(1)}% of reported months recorded zero production. See Downtime tab for period-by-period analysis.
        </div>
      )}

      {/* IC Memo Narrative */}
      {report.underwriting_narrative && report.underwriting_narrative.length > 0 && (
        <Section title="Investment Committee Memo" icon="📋">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            {report.underwriting_narrative.map((para, i) => (
              <p key={i} style={{
                fontSize: "0.82rem",
                color: COLORS.text,
                lineHeight: 1.65,
                margin: 0,
                paddingLeft: "0.75rem",
                borderLeft: `3px solid ${i === 0 ? COLORS.accent : i === 3 ? (
                  (report.risk.recommendation.value ?? "review") === "pursue" ? COLORS.green
                  : (report.risk.recommendation.value ?? "review") === "pass" ? COLORS.red
                  : COLORS.yellow
                ) : COLORS.border}`,
              }}>
                {para}
              </p>
            ))}
          </div>
          <p style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginTop: "0.75rem", marginBottom: 0, fontStyle: "italic" }}>
            Auto-generated IC memo — template synthesis from verified data. Not a substitute for petroleum engineer review.
          </p>
        </Section>
      )}

      {/* Risks & drivers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
        <div style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.red}30`,
          borderRadius: 10,
          padding: "1rem 1.25rem",
        }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.red, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>
            🚩 Top Risks
          </div>
          {ex.top_risks.length === 0
            ? <div style={{ fontSize: "0.78rem", color: COLORS.textFaint }}>No significant risks identified</div>
            : ex.top_risks.map((r, i) => (
              <div key={i} style={{ fontSize: "0.8rem", color: COLORS.text, padding: "0.3rem 0", borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none", display: "flex", gap: "0.5rem" }}>
                <span style={{ color: COLORS.red, flexShrink: 0 }}>•</span>{r}
              </div>
            ))
          }
        </div>
        <div style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.green}30`,
          borderRadius: 10,
          padding: "1rem 1.25rem",
        }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.green, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>
            ✅ Value Drivers
          </div>
          {ex.value_drivers.length === 0
            ? <div style={{ fontSize: "0.78rem", color: COLORS.textFaint }}>Insufficient data to identify value drivers</div>
            : ex.value_drivers.map((v, i) => (
              <div key={i} style={{ fontSize: "0.8rem", color: COLORS.text, padding: "0.3rem 0", borderTop: i > 0 ? `1px solid ${COLORS.border}` : "none", display: "flex", gap: "0.5rem" }}>
                <span style={{ color: COLORS.green, flexShrink: 0 }}>✓</span>{v}
              </div>
            ))
          }
        </div>
      </div>

      {/* Offer Gate Banner — always visible on exec summary */}
      <OfferGateBanner gate={report.offer_gate} />

      {/* Diligence Status — compact three-pill summary */}
      <Section title="Diligence Status" icon="🔍">
        <p style={{ fontSize: "0.75rem", color: COLORS.textMuted, marginBottom: "0.75rem" }}>
          12 diligence categories auto-classified from available data.{" "}
          <span style={{ color: COLORS.accent, fontSize: "0.75rem" }}>
            See full breakdown in the Missing Diligence tab →
          </span>
        </p>
        <DiligenceStatusDashboard items={report.diligence_status} compact={true} />

        <div style={{ marginTop: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: "0.82rem" }}>
            <span style={{ color: COLORS.textMuted }}>Completeness Score</span>
            <span style={{
              fontWeight: 700,
              color: ex.data_completeness_score >= 70 ? COLORS.green : ex.data_completeness_score >= 40 ? COLORS.yellow : COLORS.red,
            }}>
              {ex.data_completeness_score}/100
            </span>
          </div>
          <div style={{ height: 8, background: COLORS.surfaceAlt, borderRadius: 4, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${ex.data_completeness_score}%`,
              background: ex.data_completeness_score >= 70 ? COLORS.green : ex.data_completeness_score >= 40 ? COLORS.yellow : COLORS.red,
              borderRadius: 4,
              transition: "width 0.6s ease",
            }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.78rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
          <span>
            <span style={{ color: COLORS.red, fontWeight: 700 }}>{ex.critical_missing_count}</span>
            <span style={{ color: COLORS.textMuted }}> critical items missing</span>
          </span>
          <span>
            <span style={{ color: COLORS.yellow, fontWeight: 700 }}>{ex.important_missing_count}</span>
            <span style={{ color: COLORS.textMuted }}> important items missing</span>
          </span>
          <span style={{ color: COLORS.textFaint }}>
            Identity: <strong style={{ color: ex.identity_confidence === "high" ? COLORS.green : ex.identity_confidence === "medium" ? COLORS.yellow : COLORS.red }}>
              {ex.identity_confidence.toUpperCase()}
            </strong>
            {" "}({ex.match_tier.replace(/_/g, " ")})
          </span>
        </div>
      </Section>

      {/* Sources used */}
      {ex.sources_used.length > 0 && (
        <Section title="Data Sources" icon="🔗">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {ex.sources_used.map((src, i) => (
              <span key={i} style={{
                background: COLORS.surfaceAlt,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                padding: "0.2rem 0.6rem",
                fontSize: "0.75rem",
                color: COLORS.textMuted,
              }}>
                {src}
              </span>
            ))}
          </div>
          <p style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginTop: "0.5rem", marginBottom: 0 }}>
            Processing time: {(ex.processing_time_ms / 1000).toFixed(1)}s
          </p>
        </Section>
      )}

      {/* Resolution / Match Path */}
      {report.subject.match_path.length > 0 && (
        <Section title="Identity Resolution Path" icon="🔍">
          <p style={{ fontSize: "0.72rem", color: COLORS.textMuted, marginTop: 0, marginBottom: "0.6rem" }}>
            Step-by-step audit trail showing how well identifiers were normalized and matched.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {report.subject.match_path.map((step, i) => {
              const isWarning = step.toLowerCase().includes("no match") || step.toLowerCase().includes("skipped") || step.toLowerCase().includes("no production") || step.toLowerCase().includes("no rrc lease");
              const isSuccess = step.toLowerCase().includes("confirmed") || step.toLowerCase().includes("resolved") || step.toLowerCase().includes("months of");
              return (
                <div key={i} style={{
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "flex-start",
                  padding: "0.35rem 0.75rem",
                  background: isSuccess ? COLORS.greenDim : isWarning ? COLORS.redDim + "80" : COLORS.surfaceAlt,
                  borderRadius: 6,
                  border: `1px solid ${isSuccess ? COLORS.green + "30" : isWarning ? COLORS.yellow + "30" : COLORS.border}`,
                }}>
                  <span style={{ color: COLORS.textFaint, fontSize: "0.7rem", minWidth: 16, paddingTop: 1 }}>
                    {i + 1}.
                  </span>
                  <span style={{ fontSize: "0.75rem", color: isWarning ? COLORS.yellow : COLORS.text }}>
                    {step}
                  </span>
                </div>
              );
            })}
          </div>
          {/* Normalized API table if available */}
          {report.subject.normalized_apis.length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.4rem" }}>
                Normalized API Numbers
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                {report.subject.normalized_apis.map((n: NormalizedApi, i: number) => (
                  <div key={i} style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, auto)",
                    gap: "0.5rem 1.25rem",
                    fontSize: "0.72rem",
                    color: COLORS.textMuted,
                    background: COLORS.surfaceAlt,
                    borderRadius: 6,
                    padding: "0.3rem 0.75rem",
                    width: "fit-content",
                  }}>
                    <span><strong>Raw:</strong> {n.raw_api}</span>
                    <span><strong>10-digit:</strong> {n.api_10}</span>
                    <span><strong>Formatted:</strong> {n.api_formatted}</span>
                    <span><strong>Full UWI:</strong> {n.api_formatted}-00-00</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// ─── Formation & Completion Tab ───────────────────────────────────────────────

function FormationTab({ report }: { report: DDReport }) {
  const s = report.formation_completion;
  const noData = s.wells.length === 0 && s.primary_formation.source === "missing";

  return (
    <div>
      {noData && (
        <div style={{
          background: COLORS.surfaceAlt,
          border: `1px dashed ${COLORS.border}`,
          borderRadius: 10,
          padding: "2rem",
          textAlign: "center",
          color: COLORS.textFaint,
          fontSize: "0.82rem",
        }}>
          <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>🪨</div>
          No formation or completion data found. Upload W-1/W-2 forms, completion reports, or well records to populate this section.
        </div>
      )}

      {s.primary_formation.value && (
        <Section title="Formation Summary" icon="🪨">
          <KvRow label="Primary Formation">
            <DataCell dp={s.primary_formation} format={v => v} />
          </KvRow>
          {s.depth_range && (
            <KvRow label="Depth Range"><span style={{ color: COLORS.text, fontWeight: 600 }}>{s.depth_range}</span></KvRow>
          )}
          {s.lift_types_present.length > 0 && (
            <KvRow label="Artificial Lift Types">
              <span style={{ color: COLORS.text }}>{s.lift_types_present.join(", ")}</span>
            </KvRow>
          )}
          {s.notes.map((n, i) => (
            <div key={i} style={{ fontSize: "0.78rem", color: COLORS.textMuted, padding: "0.3rem 0" }}>• {n}</div>
          ))}
        </Section>
      )}

      {s.wells.map((well, wi) => (
        <div key={wi} style={{ marginBottom: "1.5rem" }}>
          <div style={{
            background: COLORS.surfaceAlt,
            borderRadius: "10px 10px 0 0",
            borderBottom: `1px solid ${COLORS.border}`,
            padding: "0.75rem 1.25rem",
            display: "flex",
            gap: "1rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}>
            <span style={{ fontWeight: 700, color: COLORS.text, fontSize: "0.9rem" }}>
              {well.well_name ?? well.api}
            </span>
            {well.api && well.api !== well.well_name && (
              <span style={{ fontSize: "0.75rem", color: COLORS.textFaint }}>API: {well.api}</span>
            )}
          </div>

          <div style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderTop: "none",
            borderRadius: "0 0 10px 10px",
            padding: "1rem 1.25rem",
          }}>
            {/* Key specs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.6rem 1.5rem", marginBottom: "1rem" }}>
              <KvRow label="Formation"><DataCell dp={well.formation_name} format={v => v} /></KvRow>
              <KvRow label="Total Depth"><DataCell dp={well.total_depth_ft} format={n => `${fmtN(n)} ft`} /></KvRow>
              <KvRow label="Completion Type"><DataCell dp={well.completion_type} format={v => v.charAt(0).toUpperCase() + v.slice(1)} /></KvRow>
              <KvRow label="Completion Date"><DataCell dp={well.completion_date} format={v => v} /></KvRow>
              <KvRow label="Artificial Lift"><DataCell dp={well.artificial_lift_type} format={v => v} /></KvRow>
              <KvRow label="Producing Zone"><DataCell dp={well.producing_zone} format={v => v} /></KvRow>
            </div>

            {/* Perforations */}
            {well.perforations.length > 0 && (
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                  Perforations ({well.perforations.length} interval{well.perforations.length !== 1 ? "s" : ""})
                </div>
                <DdTable
                  headers={["Top (ft)", "Bottom (ft)", "Formation", "Status"]}
                  rows={well.perforations.map(p => [
                    p.top_ft != null ? fmtN(p.top_ft) : "—",
                    p.bottom_ft != null ? fmtN(p.bottom_ft) : "—",
                    p.formation ?? "—",
                    <span key="st" style={{
                      color: p.status === "Producing" || p.status === "Open" ? COLORS.green
                        : p.status === "Plugged" || p.status === "Squeezed" ? COLORS.textFaint
                        : COLORS.textMuted,
                      fontSize: "0.78rem",
                    }}>{p.status ?? "—"}</span>,
                  ])}
                />
              </div>
            )}

            {/* Casing */}
            {well.casing.length > 0 && (
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                  Casing String
                </div>
                <DdTable
                  headers={["Type", "OD (in)", "Weight (lbs/ft)", "Grade", "Set Depth (ft)"]}
                  rows={well.casing.map(c => [
                    c.type,
                    c.size_inches != null ? c.size_inches.toFixed(3) : "—",
                    c.weight_lbs_ft != null ? c.weight_lbs_ft.toFixed(1) : "—",
                    c.grade ?? "—",
                    c.depth_set_ft != null ? fmtN(c.depth_set_ft) : "—",
                  ])}
                />
              </div>
            )}

            {/* Tubing */}
            {well.tubing.length > 0 && (
              <div>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                  Tubing
                </div>
                <DdTable
                  headers={["OD (in)", "Depth (ft)", "Material"]}
                  rows={well.tubing.map(t => [
                    t.size_inches != null ? t.size_inches.toFixed(3) : "—",
                    t.depth_ft != null ? fmtN(t.depth_ft) : "—",
                    t.material ?? "—",
                  ])}
                />
              </div>
            )}

            {well.notes.length > 0 && (
              <div style={{ marginTop: "0.75rem" }}>
                {well.notes.map((n, i) => (
                  <div key={i} style={{ fontSize: "0.78rem", color: COLORS.textMuted, padding: "0.2rem 0" }}>• {n}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Operator Profile Tab ─────────────────────────────────────────────────────

function OperatorProfileTab({ report }: { report: DDReport }) {
  const s = report.operator_profile;

  const complianceConfig: Record<string, { label: string; color: string }> = {
    clean:            { label: "Clean — No significant violations", color: COLORS.green  },
    minor_history:    { label: "Minor History — Closed violations only", color: COLORS.yellow },
    open_violations:  { label: "⚠️ Open Violations", color: COLORS.red    },
    unknown:          { label: "Unknown — No TRRC data available", color: COLORS.textFaint },
  };
  const compCfg = complianceConfig[s.compliance_status.value ?? "unknown"] ?? complianceConfig.unknown;

  const bondConfig: Record<string, { label: string; color: string }> = {
    confirmed:     { label: "Confirmed", color: COLORS.green  },
    not_confirmed: { label: "Not confirmed", color: COLORS.yellow },
  };
  const bondCfg = bondConfig[s.bond_status.value ?? "not_confirmed"] ?? bondConfig.not_confirmed;

  return (
    <div>
      {/* Operator identity */}
      <Section title="Operator Identity" icon="🏭">
        <KvRow label="Operator Name">
          <DataCell dp={s.name} format={v => v} />
        </KvRow>
        <KvRow label="Public Company">
          <DataCell dp={s.public_company} format={v => v ? "Yes — SEC registrant" : "No (private)"} />
        </KvRow>
        {s.edgar_company_name.value && (
          <KvRow label="EDGAR Entity">
            <DataCell dp={s.edgar_company_name} format={v => v} />
          </KvRow>
        )}
        {s.edgar_loe_per_boe.value != null && (
          <KvRow label="Reported LOE / BOE (EDGAR)">
            <DataCell dp={s.edgar_loe_per_boe} format={v => `$${v.toFixed(2)}`} unit="/ BOE" />
          </KvRow>
        )}
      </Section>

      {/* Compliance */}
      <Section title="Compliance & Regulatory Status" icon="📋">
        <div style={{
          background: compCfg.color + "15",
          border: `1px solid ${compCfg.color}40`,
          borderRadius: 8,
          padding: "0.75rem 1rem",
          marginBottom: "0.75rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: compCfg.color,
        }}>
          {compCfg.label}
        </div>
        <KvRow label="Open Violations">
          <DataCell dp={s.open_violations} format={n => `${n} open`} />
        </KvRow>
        <KvRow label="Total Violations (all time)">
          <DataCell dp={s.total_violations} format={n => `${n} total`} />
        </KvRow>
        <p style={{ fontSize: "0.72rem", color: COLORS.textFaint, margin: "0.5rem 0 0 0" }}>
          Violation data sourced from TRRC public records. Verify directly at trrc.texas.gov for current status.
        </p>
      </Section>

      {/* Bonding */}
      <Section title="Bonding" icon="🔒">
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          background: bondCfg.color + "15",
          border: `1px solid ${bondCfg.color}40`,
          borderRadius: 6,
          padding: "0.4rem 0.75rem",
          marginBottom: "0.75rem",
          fontSize: "0.8rem",
          fontWeight: 600,
          color: bondCfg.color,
        }}>
          {bondCfg.label}
        </div>
        <KvRow label="Bond Amount">
          <DataCell dp={s.bond_amount_usd} format={fmt$} />
        </KvRow>
      </Section>

      {/* Assessment */}
      {s.assessment && (
        <Section title="Qualitative Assessment" icon="🔍">
          <p style={{ margin: 0, fontSize: "0.85rem", color: COLORS.text, lineHeight: 1.65 }}>
            {s.assessment}
          </p>
        </Section>
      )}

      {/* Notes */}
      {s.notes.length > 0 && (
        <div style={{ marginTop: "0.75rem" }}>
          {s.notes.map((n, i) => (
            <div key={i} style={{
              background: COLORS.surfaceAlt,
              borderRadius: 6,
              padding: "0.5rem 0.75rem",
              fontSize: "0.78rem",
              color: COLORS.textMuted,
              marginBottom: "0.35rem",
            }}>
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Composite workspace tab wrappers ────────────────────────────────────────

function AssetOverviewTab({ report }: { report: DDReport }) {
  return (
    <>
      <FormationTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <OperatorProfileTab report={report} />
    </>
  );
}

function ProductionDeclineTab({ report }: { report: DDReport }) {
  return (
    <>
      <ProductionTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <DcaTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <DowntimeTab report={report} />
    </>
  );
}

function EconomicsValuationTab({ report }: { report: DDReport }) {
  return (
    <>
      <AcqEconomicsTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <EconomicsTab report={report} />
    </>
  );
}

function OperationsWorkoverTab({ report }: { report: DDReport }) {
  return (
    <>
      <OperationalTimelineTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <WorkoversTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <EquipmentTab report={report} />
    </>
  );
}

// ─── Cross-Source Contradictions Panel ───────────────────────────────────────
//
// Surfaces findings from the contradiction detection engine.  Each entry
// compared seller documents against TRRC public record and flagged a mismatch
// that requires manual review before any offer can proceed.

function ContradictionsPanel({ report }: { report: DDReport }) {
  const items = report.contradictions ?? [];
  if (items.length === 0) return null;

  const critCount  = items.filter(c => c.severity === "critical").length;
  const impCount   = items.filter(c => c.severity === "important").length;

  const severityStyle = (sev: string): { background: string; color: string; border: string } => {
    if (sev === "critical")     return { background: COLORS.redDim,    color: COLORS.red,    border: `1px solid ${COLORS.red}40`    };
    if (sev === "important")    return { background: COLORS.yellowDim, color: COLORS.yellow, border: `1px solid ${COLORS.yellow}40` };
    return                             { background: COLORS.accentDim, color: COLORS.accent, border: `1px solid ${COLORS.accent}40` };
  };

  const severityLabel = (sev: string) =>
    sev === "critical" ? "CRITICAL" : sev === "important" ? "IMPORTANT" : "INFO";

  return (
    <Section title="Cross-Source Contradictions" icon="⚡">
      {/* Summary banner */}
      <div style={{
        display: "flex",
        gap: "0.75rem",
        flexWrap: "wrap",
        marginBottom: "1.25rem",
      }}>
        {critCount > 0 && (
          <div style={{
            padding: "0.4rem 0.85rem",
            borderRadius: 6,
            background: COLORS.redDim,
            border: `1px solid ${COLORS.red}40`,
            fontSize: "0.75rem",
            fontWeight: 700,
            color: COLORS.red,
          }}>
            ⛔ {critCount} Critical — Economics Suppressed
          </div>
        )}
        {impCount > 0 && (
          <div style={{
            padding: "0.4rem 0.85rem",
            borderRadius: 6,
            background: COLORS.yellowDim,
            border: `1px solid ${COLORS.yellow}40`,
            fontSize: "0.75rem",
            fontWeight: 700,
            color: COLORS.yellow,
          }}>
            ⚠ {impCount} Important — Review Required
          </div>
        )}
        <div style={{
          padding: "0.4rem 0.85rem",
          borderRadius: 6,
          background: COLORS.surfaceAlt,
          border: `1px solid ${COLORS.border}`,
          fontSize: "0.72rem",
          color: COLORS.textFaint,
          display: "flex",
          alignItems: "center",
        }}>
          Seller documents vs. TRRC public record
        </div>
      </div>

      {/* Individual contradiction cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
        {items.map((c) => {
          const style = severityStyle(c.severity);
          return (
            <div key={c.id} style={{
              borderRadius: 8,
              border: style.border,
              background: style.background,
              padding: "0.9rem 1.1rem",
            }}>
              {/* Header row */}
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.55rem", flexWrap: "wrap" }}>
                <span style={{
                  fontSize: "0.64rem",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  color: style.color,
                  padding: "0.15rem 0.5rem",
                  background: "rgba(0,0,0,0.25)",
                  borderRadius: 4,
                }}>
                  {severityLabel(c.severity)}
                </span>
                <span style={{
                  fontSize: "0.64rem",
                  fontWeight: 600,
                  color: COLORS.textFaint,
                  padding: "0.15rem 0.45rem",
                  background: "rgba(0,0,0,0.2)",
                  borderRadius: 4,
                  fontFamily: "monospace",
                }}>
                  {c.id}
                </span>
                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: COLORS.text }}>
                  {c.field}
                </span>
                {c.auto_suppresses_economics && (
                  <span style={{
                    fontSize: "0.62rem",
                    fontWeight: 700,
                    color: COLORS.red,
                    padding: "0.1rem 0.45rem",
                    background: COLORS.redDim,
                    border: `1px solid ${COLORS.red}30`,
                    borderRadius: 4,
                    marginLeft: "auto",
                  }}>
                    ⛔ Suppresses Economics
                  </span>
                )}
              </div>

              {/* Description */}
              <p style={{ margin: "0 0 0.65rem 0", fontSize: "0.78rem", color: COLORS.text, lineHeight: 1.5 }}>
                {c.description}
              </p>

              {/* Source comparison */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "0.5rem",
                marginBottom: "0.65rem",
              }}>
                {[
                  { label: c.source_a, value: c.value_a },
                  { label: c.source_b, value: c.value_b },
                ].map((src, i) => (
                  <div key={i} style={{
                    background: "rgba(0,0,0,0.2)",
                    borderRadius: 6,
                    padding: "0.5rem 0.7rem",
                  }}>
                    <div style={{ fontSize: "0.64rem", color: COLORS.textFaint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.25rem" }}>
                      {src.label}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: COLORS.text, fontWeight: 600 }}>
                      {src.value !== null && src.value !== undefined ? String(src.value) : "—"}
                    </div>
                  </div>
                ))}
              </div>

              {/* Recommended action */}
              <div style={{
                fontSize: "0.73rem",
                color: COLORS.textMuted,
                padding: "0.45rem 0.7rem",
                background: "rgba(0,0,0,0.15)",
                borderRadius: 5,
                borderLeft: `3px solid ${style.color}60`,
                lineHeight: 1.5,
              }}>
                <span style={{ fontWeight: 700, color: style.color }}>Action: </span>
                {c.recommended_action}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function ComplianceRiskTab({ report }: { report: DDReport }) {
  return (
    <>
      <ContradictionsPanel report={report} />
      {(report.contradictions ?? []).length > 0 && <div style={{ height: "1.5rem" }} />}
      <RecommendationTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <ComplianceTab report={report} />
      <div style={{ height: "1.5rem" }} />
      <PluggingTab report={report} />
    </>
  );
}

function DocumentsSourcesTab({ report }: { report: DDReport }) {
  const hasNormalizedApis = report.subject.normalized_apis.length > 0;
  const hasMatchPath      = report.subject.match_path.length > 0;

  return (
    <>
      {/* Documents ingested */}
      <Section title="Documents Ingested" icon="📂">
        {report.input_documents.length === 0 ? (
          <p style={{ color: COLORS.textFaint, fontSize: "0.82rem" }}>
            No documents uploaded. Add LOE statements, run tickets, workover AFEs, division orders, reserve reports, or any other source documents via the intake form.
          </p>
        ) : (
          <DdTable
            headers={["Filename", "Size (chars)", "Type"]}
            rows={report.input_documents.map(d => [
              d.filename,
              d.char_count?.toLocaleString() ?? "—",
              d.doc_type ?? "Auto-detected",
            ])}
          />
        )}
      </Section>

      {/* Identity resolution path — same as exec summary */}
      {hasMatchPath && (
        <Section title="Identity Resolution Path" icon="🔍">
          <p style={{ fontSize: "0.72rem", color: COLORS.textMuted, marginTop: 0, marginBottom: "0.6rem" }}>
            Step-by-step audit trail showing how well identifiers were normalized and matched.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {report.subject.match_path.map((step, i) => {
              const isWarning = step.toLowerCase().includes("no match") || step.toLowerCase().includes("skipped") || step.toLowerCase().includes("no production") || step.toLowerCase().includes("no rrc lease");
              const isSuccess = step.toLowerCase().includes("confirmed") || step.toLowerCase().includes("resolved") || step.toLowerCase().includes("months of");
              return (
                <div key={i} style={{
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "flex-start",
                  padding: "0.35rem 0.75rem",
                  background: isSuccess ? COLORS.greenDim : isWarning ? COLORS.redDim + "80" : COLORS.surfaceAlt,
                  borderRadius: 6,
                  border: `1px solid ${isSuccess ? COLORS.green + "30" : isWarning ? COLORS.yellow + "30" : COLORS.border}`,
                }}>
                  <span style={{ color: COLORS.textFaint, fontSize: "0.7rem", minWidth: 16, paddingTop: 1 }}>{i + 1}.</span>
                  <span style={{ fontSize: "0.75rem", color: isWarning ? COLORS.yellow : COLORS.text }}>{step}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Normalized API table */}
      {hasNormalizedApis && (
        <Section title="Normalized API Numbers" icon="🔢">
          <DdTable
            headers={["Raw Input", "10-Digit", "Formatted", "Full UWI (14-digit)"]}
            rows={report.subject.normalized_apis.map((n: NormalizedApi) => [
              n.raw_api,
              n.api_10,
              n.api_formatted,
              `${n.api_formatted}-00-00`,
            ])}
          />
        </Section>
      )}

      {/* Data sources used */}
      {report.executive_summary.sources_used.length > 0 && (
        <Section title="Data Sources Used" icon="🔗">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {report.executive_summary.sources_used.map((src, i) => (
              <span key={i} style={{
                background: COLORS.surfaceAlt,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                padding: "0.2rem 0.6rem",
                fontSize: "0.75rem",
                color: COLORS.textMuted,
              }}>
                {src}
              </span>
            ))}
          </div>
          <p style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginTop: "0.5rem", marginBottom: 0 }}>
            Processing time: {(report.executive_summary.processing_time_ms / 1000).toFixed(1)}s
          </p>
        </Section>
      )}
    </>
  );
}

function IcMemoTab({ report }: { report: DDReport }) {
  return (
    <>
      {/* IC narrative at top */}
      {report.underwriting_narrative && report.underwriting_narrative.length > 0 && (
        <Section title="Investment Committee Memo" icon="📋">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            {report.underwriting_narrative.map((para, i) => (
              <p key={i} style={{
                fontSize: "0.82rem",
                color: COLORS.text,
                lineHeight: 1.65,
                margin: 0,
                paddingLeft: "0.75rem",
                borderLeft: `3px solid ${i === 0 ? COLORS.accent : i === 3 ? (
                  (report.risk.recommendation.value ?? "review") === "pursue" ? COLORS.green
                  : (report.risk.recommendation.value ?? "review") === "pass" ? COLORS.red
                  : COLORS.yellow
                ) : COLORS.border}`,
              }}>
                {para}
              </p>
            ))}
          </div>
          <p style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginTop: "0.75rem", marginBottom: 0, fontStyle: "italic" }}>
            Auto-generated IC memo — template synthesis from verified data. Not a substitute for petroleum engineer review.
          </p>
        </Section>
      )}
      <div style={{ height: "1.5rem" }} />
      <BuyerQATab report={report} />
      <div style={{ height: "1.5rem" }} />
      <Section title="Follow-Up Questions" icon="❓">
        <NextQuestionsTab questions={report.next_questions} />
      </Section>
    </>
  );
}

// ─── Export / Print Tab ──────────────────────────────────────────────────────

function ExportTab({ report }: { report: DDReport }) {
  const [loiBuyer,     setLoiBuyer]     = useState("");
  const [loiSigner,    setLoiSigner]    = useState("");
  const [loiSeller,    setLoiSeller]    = useState(report.subject.operator_name ?? "");
  const [loiPrice,     setLoiPrice]     = useState(
    report.acquisition_economics.offer_range_mid.value
      ? Math.round(report.acquisition_economics.offer_range_mid.value).toString()
      : ""
  );
  const [loiDdDays,    setLoiDdDays]    = useState("30");
  const [loiClosingDays, setLoiClosingDays] = useState("45");
  const [loiDeposit,   setLoiDeposit]   = useState("");
  const [loiExclDays,  setLoiExclDays]  = useState("14");
  const [loiNotes,     setLoiNotes]     = useState("");
  const [loiPreview,   setLoiPreview]   = useState(false);

  const ex  = report.executive_summary;
  const rec = report.risk.recommendation.value ?? "review";
  const recColors: Record<string, string> = { pursue: COLORS.green, review: COLORS.yellow, pass: COLORS.red };
  const recColor = recColors[rec] ?? COLORS.yellow;

  // Build LOI text
  const buildLoiText = () => {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const propDesc = [
      report.subject.lease_name,
      report.subject.county ? `${report.subject.county} County` : null,
      report.subject.state,
    ].filter(Boolean).join(", ") || "Oil and Gas Interests";

    const apis = report.subject.api_numbers.slice(0, 5).join(", ") || "See Exhibit A";
    const rrc = report.subject.rrc_lease_number ?? "Not confirmed in public records";
    const operator = report.subject.operator_name ?? "See records";
    const currentRate = ex.current_gross_rate_bbl.value != null ? `${fmtN(ex.current_gross_rate_bbl.value)} BBL/mo` : "Not confirmed";
    const avg12 = ex.twelve_month_avg_bbl.value != null ? `${fmtN(ex.twelve_month_avg_bbl.value)} BBL/mo` : "Not confirmed";
    const npv10 = ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "See analysis";
    const priceFormatted = loiPrice ? `$${parseInt(loiPrice).toLocaleString()}` : "[PURCHASE PRICE TBD]";
    const depositText = loiDeposit ? `$${parseInt(loiDeposit).toLocaleString()} earnest money, refundable during Due Diligence Period` : "[EARNEST MONEY AMOUNT] earnest money, refundable during Due Diligence Period";

    return `LETTER OF INTENT TO PURCHASE OIL AND GAS INTERESTS

Date: ${today}

TO:   ${loiSeller || "[SELLER NAME]"}
FROM: ${loiBuyer || "[BUYER COMPANY]"}

RE:   ${propDesc}

─────────────────────────────────────────────────────────────────
I.  INTRODUCTION
─────────────────────────────────────────────────────────────────

${loiBuyer || "[Buyer Company]"} ("Buyer") is pleased to submit this non-binding Letter of Intent
("LOI") to purchase the following oil and gas interests from ${loiSeller || "[Seller]"} ("Seller").

─────────────────────────────────────────────────────────────────
II.  PROPERTY DESCRIPTION
─────────────────────────────────────────────────────────────────

Property:    ${propDesc}
API Number(s): ${apis}
RRC Lease:   ${rrc}
Operator of Record: ${operator}
County/State: ${report.subject.county ?? "[County]"}, ${report.subject.state ?? "TX"}

─────────────────────────────────────────────────────────────────
III.  PURCHASE PRICE
─────────────────────────────────────────────────────────────────

Proposed Purchase Price: ${priceFormatted}

Basis for offer:
  • Current gross production rate:  ${currentRate}
  • 12-month average production:    ${avg12}
  • Estimated NPV10 (base case):    ${npv10}
  • Diligence basis: ${report._meta.trrc_match_tier.replace(/_/g, " ")} — TRRC public records
  • Preliminary underwriting confidence: ${report.overall_confidence.toUpperCase()}

Earnest Money Deposit: ${depositText}

─────────────────────────────────────────────────────────────────
IV.  DUE DILIGENCE PERIOD
─────────────────────────────────────────────────────────────────

Buyer shall have ${loiDdDays} days from execution of this LOI ("Due Diligence Period")
to complete its investigation of the Property, including but not limited to:

  (a) Review of all title records, division orders, and conveyance documents;
  (b) Review of TRRC production records, inspection records, and violation database;
  (c) Review of all LOE statements, run tickets, and purchaser statements;
  (d) Review of wellbore records, completion reports, and workover history;
  (e) Environmental review and plugging liability assessment;
  (f) Confirmation of all regulatory and bonding requirements.

─────────────────────────────────────────────────────────────────
V.  EXCLUSIVITY
─────────────────────────────────────────────────────────────────

In consideration of Buyer's diligence efforts, Seller agrees to provide Buyer
${loiExclDays} days of exclusive negotiating rights from the date of execution.
During this period, Seller shall not solicit, negotiate, or accept any competing offers.

─────────────────────────────────────────────────────────────────
VI.  TARGET CLOSING
─────────────────────────────────────────────────────────────────

Target closing: ${loiClosingDays} days from LOI execution, subject to completion of
due diligence and execution of a definitive Purchase and Sale Agreement ("PSA").

─────────────────────────────────────────────────────────────────
VII.  CONDITIONS PRECEDENT
─────────────────────────────────────────────────────────────────

Buyer's obligation to close is conditioned upon:

  1. Satisfactory completion of title examination;
  2. Satisfactory completion of all due diligence described in Section IV;
  3. Execution of a definitive PSA acceptable to both parties;
  4. No material adverse change in property condition, production, or regulatory status;
  5. Seller's delivery of all requested documents and records.

─────────────────────────────────────────────────────────────────
VIII.  SELLER REPRESENTATIONS (REQUESTED)
─────────────────────────────────────────────────────────────────

Seller represents and warrants that, to Seller's knowledge:
  (a) Seller holds good title to the Property, free and clear of material liens;
  (b) All TRRC regulatory filings are current and in good standing;
  (c) There are no undisclosed environmental liabilities or remediation obligations;
  (d) All production revenue has been accurately reported to royalty owners;
  (e) All workover and maintenance expenses have been disclosed.

─────────────────────────────────────────────────────────────────
IX.  ADDITIONAL TERMS / NOTES
─────────────────────────────────────────────────────────────────

${loiNotes || "None at this time. Final terms to be negotiated in the definitive PSA."}

─────────────────────────────────────────────────────────────────
X.  NON-BINDING NATURE
─────────────────────────────────────────────────────────────────

This LOI is non-binding and is intended solely to outline the general terms
of a possible transaction. Neither party shall have any legal obligation to
consummate the transaction unless and until a definitive PSA is executed.

─────────────────────────────────────────────────────────────────
ACCEPTED AND AGREED:

BUYER:

${loiBuyer || "[BUYER COMPANY]"}

By: ___________________________________
Name: ${loiSigner || "[Authorized Signatory]"}
Title: ________________________________
Date: _________________________________


SELLER:

${loiSeller || "[SELLER NAME]"}

By: ___________________________________
Name: ________________________________
Title: ________________________________
Date: _________________________________

─────────────────────────────────────────────────────────────────
PREPARED USING MINERALFLOWAI — mineralflowai.com
PRELIMINARY DILIGENCE SUPPORT — FOR DISCUSSION ONLY
This LOI was auto-populated from publicly available TRRC records and
preliminary underwriting analysis. Values are estimates only.
Buyer should conduct independent verification before execution.
Production data: TRRC lease-level records as of ${new Date(report.generated_at).toLocaleDateString()}.
─────────────────────────────────────────────────────────────────`;
  };

  const handleLoiDownload = () => {
    const text = buildLoiText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const propSlug = (report.subject.lease_name ?? report.subject.operator_name ?? "property").replace(/\s+/g, "_").toLowerCase().slice(0, 30);
    a.download = `loi_${propSlug}_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [loiDocxLoading, setLoiDocxLoading] = useState(false);
  const handleLoiDocxDownload = async () => {
    setLoiDocxLoading(true);
    try {
      const res = await fetch("/api/underwriting/loi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loi_buyer:        loiBuyer   || undefined,
          loi_signer:       loiSigner  || undefined,
          loi_seller:       loiSeller  || undefined,
          loi_price:        loiPrice   ? parseInt(loiPrice)      : undefined,
          loi_dd_days:      parseInt(loiDdDays),
          loi_closing_days: parseInt(loiClosingDays),
          loi_deposit:      loiDeposit ? parseInt(loiDeposit)    : undefined,
          loi_excl_days:    parseInt(loiExclDays),
          loi_notes:        loiNotes   || undefined,
          report,
        }),
      });
      if (!res.ok) { alert("Failed to generate Word document."); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const propSlug = (report.subject.lease_name ?? report.subject.operator_name ?? "property")
        .replace(/\s+/g, "_").toLowerCase().slice(0, 30);
      a.download = `loi_${propSlug}_${new Date().toISOString().slice(0, 10)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Network error generating Word document.");
    } finally {
      setLoiDocxLoading(false);
    }
  };

  // Shared HTML builder — used by both Save as PDF and Print
  const buildReportHtml = () => {
    const title = `DD Report — ${report.subject.lease_name ?? report.subject.operator_name ?? "Property"}`;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fmtV = (v: number) => v >= 1_000_000 ? `$${(v/1_000_000).toFixed(2)}MM` : v >= 1_000 ? `$${Math.round(v/1_000)}K` : v < 0 ? `($${Math.round(Math.abs(v)/1_000)}K)` : `$${Math.round(v)}`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  @page{size:letter;margin:0.6in 0.65in}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#fff;padding:2.2rem 2.4rem;font-size:10.5px;line-height:1.5}
  h1{font-size:19px;font-weight:900;margin-bottom:2px}
  h2{font-size:12.5px;font-weight:800;margin:20px 0 6px;padding:5px 0 5px 10px;background:#f8fafc;border-left:4px solid #3b82f6;color:#1e3a5f;text-transform:uppercase;letter-spacing:.05em;page-break-after:avoid}
  h3{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.07em;margin:10px 0 4px;font-weight:700}
  .meta{color:#6b7280;font-size:9.5px;margin-bottom:18px;border-bottom:1px solid #e5e7eb;padding-bottom:8px}
  .rec-pursue{color:#15803d;font-size:22px;font-weight:900;text-transform:uppercase}
  .rec-review{color:#92400e;font-size:22px;font-weight:900;text-transform:uppercase}
  .rec-pass{color:#991b1b;font-size:22px;font-weight:900;text-transform:uppercase}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:6px 0}
  .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:6px 0}
  .card{border:1px solid #e5e7eb;border-radius:5px;padding:8px 10px;background:#fafafa}
  .card .lbl{font-size:8.5px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
  .card .val{font-size:13px;font-weight:800;color:#111827}
  .kv{display:flex;gap:10px;padding:3.5px 0;border-bottom:1px solid #f3f4f6;font-size:10px}
  .kv-label{width:190px;min-width:190px;color:#6b7280;flex-shrink:0}
  table{width:100%;border-collapse:collapse;font-size:9.5px;margin:5px 0}
  th{text-align:left;padding:3.5px 6px;color:#6b7280;font-weight:700;border-bottom:2px solid #e5e7eb;background:#f9fafb;white-space:nowrap}
  td{padding:3.5px 6px;border-bottom:1px solid #f3f4f6;vertical-align:top}
  .tag{display:inline-block;padding:1px 5px;border-radius:3px;font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
  .tag-green{background:#dcfce7;color:#15803d}
  .tag-red{background:#fee2e2;color:#991b1b}
  .tag-yellow{background:#fef9c3;color:#92400e}
  .tag-blue{background:#dbeafe;color:#1d4ed8}
  .tag-gray{background:#f3f4f6;color:#6b7280}
  .flag{padding:2px 0;font-size:10px}
  .flag-red{color:#dc2626}
  .flag-green{color:#16a34a}
  .flag-yellow{color:#d97706}
  .section{margin-bottom:20px;page-break-inside:avoid}
  .note-box{background:#fffbeb;border:1px solid #fcd34d;border-radius:4px;padding:6px 8px;font-size:9.5px;color:#92400e;margin:6px 0}
  .warn-box{background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;padding:6px 8px;font-size:9.5px;color:#991b1b;margin:6px 0}
  .ok-box{background:#f0fdf4;border:1px solid #86efac;border-radius:4px;padding:6px 8px;font-size:9.5px;color:#15803d;margin:6px 0}
  .source-url{font-size:8px;color:#9ca3af;word-break:break-all}
  .checklist-item{display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #f3f4f6;font-size:10px}
  .disclaimer{font-size:8.5px;color:#9ca3af;margin-top:28px;border-top:1px solid #e5e7eb;padding-top:10px;line-height:1.6}
  @page{size:letter;margin:1.4cm 1.6cm}
  @media print{h2{page-break-after:avoid}.section{page-break-inside:avoid}}
</style>
</head>
<body>

<h1>Acquisition Due Diligence Report</h1>
<div class="meta">
  <strong>${esc(report.subject.lease_name ?? report.subject.operator_name ?? "Unknown Property")}</strong>
  ${report.subject.county ? ` &mdash; ${esc(report.subject.county)} County` : ""}${report.subject.state ? `, ${esc(report.subject.state)}` : ""}
  &nbsp;|&nbsp; API: ${report.subject.api_numbers.slice(0,4).join(", ") || "Not provided"}
  ${report.subject.rrc_lease_number ? ` &nbsp;|&nbsp; RRC Lease: ${esc(report.subject.rrc_lease_number)}` : ""}
  &nbsp;|&nbsp; Generated: ${new Date(report.generated_at).toLocaleString()}
  &nbsp;|&nbsp; <strong>MineralFlowAI</strong> &nbsp;|&nbsp; PRELIMINARY — FOR DISCUSSION ONLY
  &nbsp;|&nbsp; TRRC match: ${report._meta.trrc_match_tier.replace(/_/g," ")}
  &nbsp;|&nbsp; Confidence: ${report.overall_confidence.replace("_"," ").toUpperCase()}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 1 — EXECUTIVE SUMMARY
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>1. Executive Summary</h2>
  <div class="grid2">
    <div>
      <div class="rec-${rec}">${rec.toUpperCase()}</div>
      <div style="margin-top:6px;font-size:11px;color:#374151;line-height:1.6">${esc(ex.recommendation_rationale)}</div>
      <div style="margin-top:5px;font-size:9.5px;color:#6b7280;font-style:italic">${esc(ex.asset_description)}</div>
    </div>
    <div class="grid2">
      <div class="card"><div class="lbl">Risk Score</div><div class="val">${ex.overall_risk_score.value?.toFixed(1) ?? "—"}/10</div></div>
      <div class="card"><div class="lbl">Data Score</div><div class="val">${ex.data_completeness_score}/100</div></div>
      <div class="card"><div class="lbl">Current Rate</div><div class="val" style="font-size:11px">${ex.current_gross_rate_bbl.value != null ? fmtN(ex.current_gross_rate_bbl.value)+" BBL/mo" : "—"}</div></div>
      <div class="card"><div class="lbl">Monthly NCF</div><div class="val" style="font-size:11px">${ex.monthly_net_income_usd.value != null ? fmt$(ex.monthly_net_income_usd.value) : "—"}</div></div>
      <div class="card"><div class="lbl">NPV10</div><div class="val" style="font-size:11px">${ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "—"}</div></div>
      <div class="card"><div class="lbl">Offer Range</div><div class="val" style="font-size:10px">${ex.offer_range_low.value && ex.offer_range_high.value ? fmt$(ex.offer_range_low.value)+" – "+fmt$(ex.offer_range_high.value) : "—"}</div></div>
    </div>
  </div>
  <div class="grid2" style="margin-top:10px">
    <div>
      <h3>Top Risks</h3>
      ${ex.top_risks.map(r=>`<div class="flag flag-red">• ${esc(r)}</div>`).join("")||"<div style='color:#9ca3af'>None identified</div>"}
    </div>
    <div>
      <h3>Value Drivers</h3>
      ${ex.value_drivers.map(v=>`<div class="flag flag-green">&#10003; ${esc(v)}</div>`).join("")||"<div style='color:#9ca3af'>Insufficient data</div>"}
    </div>
  </div>
  ${ex.critical_missing_count > 0 ? `<div class="warn-box">&#9888; ${ex.critical_missing_count} critical diligence item(s) unresolved — see Section 12.</div>` : `<div class="ok-box">&#10003; No critical diligence gaps identified.</div>`}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 2 — ASSET / LEASE OVERVIEW
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>2. Asset / Lease Overview</h2>
  <div class="kv"><span class="kv-label">Lease / Property Name</span><span>${esc(report.subject.lease_name ?? "Not confirmed")}</span></div>
  <div class="kv"><span class="kv-label">Operator of Record</span><span>${esc(report.subject.operator_name ?? "Not confirmed")}</span></div>
  <div class="kv"><span class="kv-label">County / State</span><span>${[report.subject.county,report.subject.state].filter(Boolean).join(", ")||"—"}</span></div>
  <div class="kv"><span class="kv-label">RRC Lease Number</span><span>${esc(report.subject.rrc_lease_number ?? "Not found in captured public records; request seller/operator or RRC imaged records.")}</span></div>
  <div class="kv"><span class="kv-label">API Number(s)</span><span>${report.subject.api_numbers.join(", ")||"Not provided"}</span></div>
  <div class="kv"><span class="kv-label">TRRC Match Quality</span><span><span class="tag tag-blue">${report._meta.trrc_match_tier.replace(/_/g," ")}</span></span></div>
  <div class="kv"><span class="kv-label">Overall Confidence</span><span>${report.overall_confidence.toUpperCase()} — ${esc(report.overall_confidence_note)}</span></div>
  ${report.formation_completion.primary_formation.value ? `
  <div class="kv"><span class="kv-label">Primary Formation</span><span>${esc(report.formation_completion.primary_formation.value)}</span></div>` : ""}
  ${report.formation_completion.depth_range ? `
  <div class="kv"><span class="kv-label">Depth Range</span><span>${esc(report.formation_completion.depth_range)}</span></div>` : ""}
  ${report.formation_completion.lift_types_present.length > 0 ? `
  <div class="kv"><span class="kv-label">Artificial Lift Type(s)</span><span>${report.formation_completion.lift_types_present.join(", ")}</span></div>` : ""}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 3 — PRODUCING WELL INVENTORY
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>3. Producing Well Inventory</h2>
  ${report.production.wells.length > 0 ? `
  <table>
    <tr>
      <th>Well / Lease</th><th>API</th><th>Latest BBL/mo</th><th>3-Mo Avg</th><th>6-Mo Avg</th><th>12-Mo Avg</th><th>Water Cut</th><th>Trend</th><th>Cum Oil BBL</th>
    </tr>
    ${report.production.wells.map(w=>`
    <tr>
      <td>${esc(w.well_name)}</td>
      <td style="font-family:monospace;font-size:8.5px">${esc(w.api)}</td>
      <td>${w.latest_monthly_oil_bbl.value!=null?fmtN(w.latest_monthly_oil_bbl.value):"—"}</td>
      <td>${w.three_month_avg_bbl.value!=null?fmtN(w.three_month_avg_bbl.value):"—"}</td>
      <td>${w.six_month_avg_bbl.value!=null?fmtN(w.six_month_avg_bbl.value):"—"}</td>
      <td>${w.twelve_month_avg_bbl.value!=null?fmtN(w.twelve_month_avg_bbl.value):"—"}</td>
      <td>${w.water_cut_pct.value!=null?fmtPct(w.water_cut_pct.value):"—"}</td>
      <td><span class="tag ${w.production_trend.value==="increasing"?"tag-green":w.production_trend.value==="declining"?"tag-red":w.production_trend.value==="offline"?"tag-red":"tag-yellow"}">${w.production_trend.value??"—"}</span></td>
      <td>${w.cum_oil_bbl.value!=null?fmtN(w.cum_oil_bbl.value):"—"}</td>
    </tr>`).join("")}
  </table>
  <div class="note-box">RRC oil production is lease-level; this exhibit supports underwriting but is not a formal well-level reserve-engineering decline curve. TRRC data may lag current operations by 3–5 months.</div>
  ` : "<p style='color:#6b7280;font-style:italic'>No TRRC well production data retrieved. Provide API number(s) for production lookup.</p>"}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 4 — OPERATOR OF RECORD VERIFICATION
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>4. Operator of Record Verification</h2>
  <div class="kv"><span class="kv-label">Operator Name</span><span>${esc(report.operator_profile.name.value ?? "Not confirmed")}</span></div>
  <div class="kv"><span class="kv-label">Compliance Status</span><span>
    ${report.operator_profile.compliance_status.value === "clean" ? `<span class="tag tag-green">Clean — No significant violations</span>`
      : report.operator_profile.compliance_status.value === "minor_history" ? `<span class="tag tag-yellow">Minor History</span>`
      : report.operator_profile.compliance_status.value === "open_violations" ? `<span class="tag tag-red">Open Violations</span>`
      : `<span class="tag tag-gray">Unknown</span>`}
  </span></div>
  <div class="kv"><span class="kv-label">Open Violations</span><span>${report.operator_profile.open_violations.value ?? "Not confirmed"}</span></div>
  <div class="kv"><span class="kv-label">Total Violations (all time)</span><span>${report.operator_profile.total_violations.value ?? "Not confirmed"}</span></div>
  <div class="kv"><span class="kv-label">Bond Status</span><span>${report.operator_profile.bond_status.value === "confirmed" ? `<span class="tag tag-green">Confirmed</span>` : `<span class="tag tag-yellow">Not confirmed</span>`}</span></div>
  <div class="kv"><span class="kv-label">Bond Amount</span><span>${report.operator_profile.bond_amount_usd.value != null ? fmt$(report.operator_profile.bond_amount_usd.value) : "Not confirmed in public records"}</span></div>
  <div class="kv"><span class="kv-label">Public Company (EDGAR)</span><span>${report.operator_profile.public_company.value ? "Yes — SEC registrant" : "No (private)"}</span></div>
  ${report.operator_profile.assessment ? `<div style="margin-top:8px;font-size:10px;color:#374151;padding:6px 8px;background:#f8fafc;border-radius:4px;border-left:3px solid #3b82f6">${esc(report.operator_profile.assessment)}</div>` : ""}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 5 — RRC WELLBORE DATA SUMMARY
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>5. RRC Wellbore Data Summary</h2>
  ${report.formation_completion.wells.length > 0 ? report.formation_completion.wells.map(w=>`
  <div style="margin-bottom:10px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:5px">
    <div style="font-weight:800;font-size:11px;margin-bottom:5px">${esc(w.well_name??w.api)} <span style="font-size:9px;color:#6b7280;font-family:monospace">${w.api!==w.well_name?`(${w.api})`:""}</span></div>
    <div class="grid3">
      <div class="kv"><span class="kv-label">Formation</span><span>${esc(w.formation_name.value??"Not confirmed")}</span></div>
      <div class="kv"><span class="kv-label">Total Depth</span><span>${w.total_depth_ft.value!=null?fmtN(w.total_depth_ft.value)+" ft":"Not confirmed"}</span></div>
      <div class="kv"><span class="kv-label">Completion Date</span><span>${esc(w.completion_date.value??"Not confirmed")}</span></div>
      <div class="kv"><span class="kv-label">Completion Type</span><span>${esc(w.completion_type.value??"Not confirmed")}</span></div>
      <div class="kv"><span class="kv-label">Artificial Lift</span><span>${esc(w.artificial_lift_type.value??"Not confirmed")}</span></div>
      <div class="kv"><span class="kv-label">Producing Zone</span><span>${esc(w.producing_zone.value??"Not confirmed")}</span></div>
    </div>
    ${w.perforations.length > 0 ? `
    <div style="margin-top:5px">
      <div class="tag tag-blue" style="margin-bottom:4px">Perforations (${w.perforations.length})</div>
      <table style="font-size:9px">
        <tr><th>Top (ft)</th><th>Bottom (ft)</th><th>Formation</th><th>Status</th></tr>
        ${w.perforations.map(p=>`<tr><td>${p.top_ft??""}</td><td>${p.bottom_ft??""}</td><td>${esc(p.formation??"—")}</td><td>${esc(p.status??"—")}</td></tr>`).join("")}
      </table>
    </div>` : ""}
  </div>`).join("") : `<p style='color:#6b7280;font-style:italic'>Not found in captured public records; request seller/operator or RRC imaged records.</p>`}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 6 — PRODUCTION HISTORY
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>6. Production History</h2>
  <div class="grid4">
    <div class="card"><div class="lbl">Total Monthly Oil</div><div class="val" style="font-size:11px">${report.production.total_monthly_oil_bbl.value!=null?fmtN(report.production.total_monthly_oil_bbl.value)+" BBL/mo":"—"}</div></div>
    <div class="card"><div class="lbl">Daily Rate (BOPD)</div><div class="val" style="font-size:11px;color:#16a34a;font-weight:700">${report.production.total_daily_oil_bbl.value!=null?report.production.total_daily_oil_bbl.value.toFixed(1)+" BOPD":"—"}</div></div>
    <div class="card"><div class="lbl">Water Cut</div><div class="val" style="font-size:11px">${report.production.water_cut_pct.value!=null?fmtPct(report.production.water_cut_pct.value):"—"}</div></div>
    <div class="card"><div class="lbl">Monthly Decline</div><div class="val" style="font-size:11px">${report.production.decline_rate_pct_monthly.value!=null?fmtPct(report.production.decline_rate_pct_monthly.value):"—"}</div></div>
    <div class="card"><div class="lbl">Last Production</div><div class="val" style="font-size:10px">${esc(report.production.last_production_date.value??"—")}</div></div>
  </div>
  ${report.production.wells.some(w=>w.monthly_history.length>0) ? (() => {
    const byPeriod = new Map<string,{oil:number;gas:number;water:number|null}>();
    for (const w of report.production.wells) {
      for (const r of w.monthly_history) {
        const ex2 = byPeriod.get(r.period) ?? {oil:0,gas:0,water:null};
        byPeriod.set(r.period,{oil:ex2.oil+r.oil_bbl,gas:ex2.gas+r.gas_mcf,water:r.water_bbl!=null?(ex2.water??0)+r.water_bbl:ex2.water});
      }
    }
    const rows = Array.from(byPeriod.entries()).sort((a,b)=>a[0]<b[0]?-1:1).slice(-24);
    return `
  <table style="margin-top:8px">
    <tr><th>Period</th><th style="text-align:right">Oil (BBL)</th><th style="text-align:right">Gas (MCF)</th><th style="text-align:right">Water (BBL)</th></tr>
    ${rows.map(([period,v])=>`
    <tr>
      <td style="font-family:monospace;font-size:9px">${period}</td>
      <td style="text-align:right;${v.oil===0?"color:#dc2626":"color:#1d4ed8;font-weight:600"}">${fmtN(v.oil)}</td>
      <td style="text-align:right">${v.gas>0?fmtN(v.gas):"—"}</td>
      <td style="text-align:right">${v.water!=null?fmtN(v.water):"—"}</td>
    </tr>`).join("")}
  </table>
  <div class="note-box" style="margin-top:6px">RRC oil production is lease-level; this exhibit supports underwriting but is not a formal well-level reserve-engineering decline curve. TRRC data may lag current operations by 3–5 months. Red = zero-production month.</div>`;
  })() : "<p style='color:#6b7280;font-style:italic;margin-top:6px'>No monthly production history available.</p>"}
  ${report.production.notes.map(n=>`<div class="${n.startsWith("⚠")?"warn-box":"note-box"}" style="margin-top:4px">${esc(n)}</div>`).join("")}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 7 — DECLINE-SUPPORT ANALYSIS
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>7. Decline-Support Analysis</h2>
  <div class="note-box">DECLINE-SUPPORT EXHIBIT ONLY — This is not a formal reserve-engineering study or Petroleum Engineering Reserves Report. These projections are statistical fits to available TRRC production data and should not be used as a substitute for an independent reserve engineer's evaluation.</div>
  <div class="grid3" style="margin-top:8px">
    <div class="kv"><span class="kv-label">Model Type</span><span>${esc(report.dca.model_type.value??"—")}</span></div>
    <div class="kv"><span class="kv-label">Monthly Decline %</span><span>${report.dca.decline_rate_monthly_pct.value!=null?fmtPct(report.dca.decline_rate_monthly_pct.value):"—"}</span></div>
    <div class="kv"><span class="kv-label">Annual Decline %</span><span>${report.dca.decline_rate_annual_pct.value!=null?fmtPct(report.dca.decline_rate_annual_pct.value):"—"}</span></div>
    <div class="kv"><span class="kv-label">Arps b-Factor</span><span>${report.dca.b_factor.value!=null?report.dca.b_factor.value.toFixed(3):"—"}</span></div>
    <div class="kv"><span class="kv-label">R² (fit quality)</span><span>${report.dca.r_squared.value!=null?report.dca.r_squared.value.toFixed(3):"—"}</span></div>
    <div class="kv"><span class="kv-label">EUR (BBL)</span><span>${report.dca.eur_bbl.value!=null?fmtN(report.dca.eur_bbl.value):"—"}</span></div>
    <div class="kv"><span class="kv-label">Remaining Reserves</span><span>${report.dca.remaining_reserves_bbl.value!=null?fmtN(report.dca.remaining_reserves_bbl.value)+" BBL":"—"}</span></div>
    <div class="kv"><span class="kv-label">Economic Life</span><span>${report.dca.economic_life_months.value!=null?report.dca.economic_life_months.value+" months":"—"}</span></div>
    <div class="kv"><span class="kv-label">Current Rate</span><span>${report.dca.current_rate_bbl.value!=null?fmtN(report.dca.current_rate_bbl.value)+" BBL/mo":"—"}</span></div>
    <div class="kv"><span class="kv-label">Daily Rate (BOPD)</span><span style="font-weight:700;color:#16a34a">${report.dca.current_rate_bopd.value!=null?report.dca.current_rate_bopd.value.toFixed(1)+" BOPD":"—"}</span></div>
  </div>
  ${report.dca.projections.length > 0 ? `
  <h3 style="margin-top:10px">60-Month Projection Milestones (Arps Decline)</h3>
  <table style="font-size:9px">
    <tr><th>Month</th>${[1,6,12,18,24,36,48,60].map(m=>`<th style="text-align:right">${m}</th>`).join("")}</tr>
    <tr><td>BBL/mo</td>${[1,6,12,18,24,36,48,60].map(m=>{const p=report.dca.projections.find(p=>p.month===m);return`<td style="text-align:right">${p?fmtN(Math.round(p.rate_bbl)):"—"}</td>`;}).join("")}</tr>
  </table>` : ""}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 8 — INSPECTION AND COMPLIANCE REVIEW
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>8. Inspection and Compliance Review</h2>
  <h3>Field Inspection Records (ICE — TRRC)</h3>
  <div class="kv"><span class="kv-label">Most Recent Inspection</span><span>${esc(report.compliance.most_recent_inspection_date?.value ?? "Not found in captured public records; request seller/operator or RRC imaged records.")}</span></div>
  <div class="kv"><span class="kv-label">Most Recent Result</span><span style="color:${report.compliance.most_recent_inspection_result?.value==="non_compliant"?"#dc2626":report.compliance.most_recent_inspection_result?.value==="compliant"?"#16a34a":"#6b7280"};font-weight:700">
    ${report.compliance.most_recent_inspection_result?.value==="non_compliant"?"⚠ Non-Compliant":report.compliance.most_recent_inspection_result?.value==="compliant"?"Compliant":"Not found in public records"}
  </span></div>
  ${(report.compliance.inspection_records?.length??0)>0?`
  <table style="margin-top:5px">
    <tr><th>API</th><th>Date</th><th>Type</th><th>Result</th><th>Defect / Notes</th></tr>
    ${report.compliance.inspection_records.map(r=>`
    <tr>
      <td style="font-family:monospace;font-size:8.5px">${r.api}</td>
      <td>${r.inspection_date??"—"}</td>
      <td>${r.inspection_type??"—"}</td>
      <td style="font-weight:700;color:${r.result==="non_compliant"?"#dc2626":r.result==="compliant"?"#16a34a":"#6b7280"}">${r.result==="non_compliant"?"Non-Compliant":r.result==="compliant"?"Compliant":"Unknown"}</td>
      <td>${esc(r.defect_summary??r.notes??"—")}</td>
    </tr>`).join("")}
  </table>
  ${report.compliance.inspection_records.some(r=>r.result==="non_compliant")?`<div class="warn-box">&#9888; Non-compliant inspection(s) found. Request deficiency correction documentation from operator.</div>`:""}
  ` : `<p style='color:#6b7280;font-style:italic;font-size:9.5px'>Not found in captured public records; request seller/operator or RRC imaged records.</p>`}

  <h3 style="margin-top:10px">Violation Database (TRRC)</h3>
  <div class="kv"><span class="kv-label">RRC Good Standing</span><span>${report.compliance.rrc_good_standing.value?`<span class="tag tag-green">Yes — No open violations</span>`:`<span class="tag tag-red">No — Open violations found</span>`}</span></div>
  <div class="kv"><span class="kv-label">Open Violations</span><span>${report.compliance.open_violation_count.value??0}</span></div>
  <div class="kv"><span class="kv-label">Most Recent Violation</span><span>${esc(report.compliance.most_recent_violation_date?.value??"Not found in public records")}</span></div>

  <h3 style="margin-top:10px">Bonding</h3>
  <div class="kv"><span class="kv-label">Bond Amount</span><span>${report.compliance.bond_amount_usd.value!=null?fmt$(report.compliance.bond_amount_usd.value):"Not confirmed in public records"}</span></div>
  <div class="kv"><span class="kv-label">Bond Type</span><span>${esc(report.compliance.bond_type.value??"Not confirmed")}</span></div>
  <div class="kv"><span class="kv-label">Bond Number</span><span>${esc(report.compliance.bond_number.value??"Not confirmed")}</span></div>
  <div class="kv"><span class="kv-label">Bonding Company</span><span>${esc(report.compliance.bonding_company.value??"Not confirmed")}</span></div>

  ${report.compliance.violations.length>0?`
  <h3 style="margin-top:10px">Violation Detail</h3>
  <table>
    <tr><th>Date</th><th>Type</th><th>Description</th><th>Status</th><th>Penalty</th></tr>
    ${report.compliance.violations.map(v=>`
    <tr>
      <td>${v.date??"—"}</td>
      <td>${esc(v.type)}</td>
      <td>${esc(v.description)}</td>
      <td style="font-weight:700;color:${v.status==="open"?"#dc2626":v.status==="closed"?"#16a34a":"#6b7280"}">${v.status}</td>
      <td>${v.penalty_usd!=null?fmt$(v.penalty_usd):"—"}</td>
    </tr>`).join("")}
  </table>` : ""}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 9 — DOWNTIME / NON-PRODUCTION EVIDENCE
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>9. Downtime / Non-Production Evidence</h2>
  <div class="grid4">
    <div class="card"><div class="lbl">Downtime %</div><div class="val" style="color:${(report.downtime.downtime_pct.value??0)>20?"#dc2626":(report.downtime.downtime_pct.value??0)>5?"#d97706":"#15803d"};font-size:13px">${report.downtime.downtime_pct.value!=null?fmtPct(report.downtime.downtime_pct.value):"—"}</div></div>
    <div class="card"><div class="lbl">Zero Months</div><div class="val">${report.downtime.total_zero_months.value??0} / ${report.downtime.total_months_analyzed}</div></div>
    <div class="card"><div class="lbl">Normalized Rate</div><div class="val" style="font-size:11px">${report.downtime.normalized_rate_bbl.value!=null?fmtN(report.downtime.normalized_rate_bbl.value)+" BBL/mo":"—"}</div></div>
    <div class="card"><div class="lbl">Volatility Score</div><div class="val" style="color:${(report.downtime.volatility_score.value??0)>=7?"#dc2626":(report.downtime.volatility_score.value??0)>=4?"#d97706":"#15803d"}">${report.downtime.volatility_score.value!=null?report.downtime.volatility_score.value+"/10":"—"}</div></div>
  </div>
  ${report.downtime.underwriting_notes.map(n=>`<div class="${n.startsWith("⚠")?"warn-box":n.startsWith("✓")?"ok-box":"note-box"}" style="margin-top:5px">${esc(n)}</div>`).join("")}
  ${report.downtime.periods.length>0?`
  <table style="margin-top:8px">
    <tr><th>Period</th><th>Duration</th><th>Classification</th><th>Recovery</th><th>Pre-Rate</th><th>Post-Rate</th><th>Notes</th></tr>
    ${(report.downtime.periods as DowntimePeriod[]).map(p=>`
    <tr>
      <td>${p.start_period} - ${p.end_period}${p.is_current?' <b>CURRENT</b>':''}</td>
      <td>${p.duration_months} mo</td>
      <td><span class="tag ${p.classification==="abandonment_risk"||p.classification==="current_offline"?"tag-red":p.classification==="regulatory"?"tag-red":"tag-yellow"}">${p.classification}</span></td>
      <td>${p.recovery_rate_pct!=null?p.recovery_rate_pct+"%":"—"}</td>
      <td>${p.pre_downtime_rate_bbl!=null?fmtN(p.pre_downtime_rate_bbl)+" BBL":"—"}</td>
      <td>${p.post_downtime_rate_bbl!=null?fmtN(p.post_downtime_rate_bbl)+" BBL":"—"}</td>
      <td style="font-size:9px;color:#6b7280">${esc(p.classification_rationale)}</td>
    </tr>`).join("")}
  </table>` : `<p style='color:#6b7280;font-style:italic;margin-top:6px'>${report.downtime.total_months_analyzed>0?"No zero-production periods detected — production was continuous across all reported months.":"No production history available for downtime analysis."}</p>`}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 10 — COMPLETION / FORMATION / WORKOVER DOCUMENT STATUS
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>10. Completion / Formation / Workover Document Status</h2>
  ${report.workovers.events.length>0?`
  <h3>Workover & Maintenance History</h3>
  <table>
    <tr><th>Date</th><th>Well</th><th>Type</th><th>Cost</th><th>Result</th></tr>
    ${report.workovers.events.map(e=>`
    <tr>
      <td>${e.date??"—"}</td>
      <td>${esc(e.well??"—")}</td>
      <td>${esc(e.type)}</td>
      <td>${e.cost_usd!=null?fmt$(e.cost_usd):"—"}</td>
      <td style="font-size:9px;color:#6b7280">${esc(e.result??"—")}</td>
    </tr>`).join("")}
  </table>
  <div class="kv" style="margin-top:5px"><span class="kv-label">Total Workover Cost</span><span>${report.workovers.total_workover_cost_usd.value!=null?fmt$(report.workovers.total_workover_cost_usd.value):"Not confirmed"}</span></div>
  <div class="kv"><span class="kv-label">Avg Annual Workover</span><span>${report.workovers.avg_annual_workover_cost_usd.value!=null?(fmt$(report.workovers.avg_annual_workover_cost_usd.value)+"/yr"):"Not confirmed"}</span></div>
  ` : `<p style='color:#6b7280;font-style:italic'>Not found in captured public records; request seller/operator or RRC imaged records.</p>`}

  <h3 style="margin-top:10px">Plugging Liability</h3>
  <div class="kv"><span class="kv-label">Inactive / Shut-in Wells</span><span>${report.plugging_liability.inactive_well_count.value??0}</span></div>
  <div class="kv"><span class="kv-label">Total Est. Plug Cost</span><span>${report.plugging_liability.total_estimated_plug_cost_usd.value!=null?fmt$(report.plugging_liability.total_estimated_plug_cost_usd.value):"Not confirmed"}</span></div>
  <div class="kv"><span class="kv-label">Orphan Well Risk</span><span><span class="tag ${report.plugging_liability.orphan_well_risk.value==="high"?"tag-red":report.plugging_liability.orphan_well_risk.value==="medium"?"tag-yellow":"tag-green"}">${report.plugging_liability.orphan_well_risk.value??"unknown"}</span></span></div>
  ${report.plugging_liability.wells.length>0?`
  <table style="margin-top:5px;font-size:9px">
    <tr><th>API</th><th>Well Name</th><th>Status</th><th>Inactive Since</th><th>Est. Plug Cost</th></tr>
    ${report.plugging_liability.wells.map(w=>`<tr><td style="font-family:monospace">${w.api}</td><td>${esc(w.well_name??"—")}</td><td>${esc(w.status)}</td><td>${w.inactive_since??"—"}</td><td>${w.estimated_plug_cost_usd!=null?fmt$(w.estimated_plug_cost_usd):"—"}</td></tr>`).join("")}
  </table>` : ""}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 11 — BUYER REQUEST CHECKLIST (DILIGENCE STATUS)
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>11. Buyer Request Checklist</h2>
  <p style="font-size:9.5px;color:#6b7280;margin-bottom:8px">Auto-classified from available data. VERIFIED = confirmed third-party source. PARTIALLY VERIFIED = present but incomplete. MISSING = not available — action required before offer.</p>
  ${report.diligence_status.map(item=>`
  <div class="checklist-item">
    <span class="tag ${item.tier==="verified"?"tag-green":item.tier==="partially_verified"?"tag-yellow":item.tier==="missing"?"tag-red":"tag-gray"}" style="min-width:100px;text-align:center;flex-shrink:0">
      ${item.tier==="verified"?"✓ VERIFIED":item.tier==="partially_verified"?"◑ PARTIAL":item.tier==="missing"?"✕ MISSING":"— N/A"}
    </span>
    <div style="flex:1">
      <span style="font-weight:700">${esc(item.category)}</span>
      <span style="color:#6b7280;margin-left:8px;font-size:9px">${esc(item.status_detail)}</span>
      ${item.action_required?`<div style="color:#dc2626;font-size:9px;margin-top:1px">→ ${esc(item.action_required)}</div>`:""}
    </div>
    ${item.urgency!=="informational"?`<span class="tag ${item.urgency==="critical"?"tag-red":"tag-yellow"}" style="flex-shrink:0">${item.urgency}</span>`:""}
  </div>`).join("")}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 12 — OPEN ITEMS / SELLER DOCUMENT REQUESTS
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>12. Open Items / Seller Document Requests</h2>
  ${report.missing_items.filter(m=>m.importance==="critical").length>0?`
  <h3 style="color:#dc2626">Critical — Block Offer Until Resolved</h3>
  ${report.missing_items.filter(m=>m.importance==="critical").map(m=>`
  <div class="checklist-item">
    <span class="tag tag-red" style="min-width:60px;text-align:center;flex-shrink:0">CRITICAL</span>
    <div><span style="font-weight:700">${esc(m.section)} → ${esc(m.field)}</span><div style="color:#6b7280;font-size:9px">${esc(m.note)}</div></div>
  </div>`).join("")}` : ""}
  ${report.missing_items.filter(m=>m.importance==="important").length>0?`
  <h3 style="color:#d97706;margin-top:8px">Important — Needed Before Close</h3>
  ${report.missing_items.filter(m=>m.importance==="important").map(m=>`
  <div class="checklist-item">
    <span class="tag tag-yellow" style="min-width:60px;text-align:center;flex-shrink:0">IMPORTANT</span>
    <div><span style="font-weight:700">${esc(m.section)} → ${esc(m.field)}</span><div style="color:#6b7280;font-size:9px">${esc(m.note)}</div></div>
  </div>`).join("")}` : ""}
  ${report.missing_items.length===0?`<div class="ok-box">&#10003; All tracked diligence items present. No outstanding seller document requests.</div>`:""}
  ${report.next_questions.filter(q=>q.priority==="high").length>0?`
  <h3 style="margin-top:10px">High-Priority Follow-Up Questions</h3>
  ${report.next_questions.filter(q=>q.priority==="high").map(q=>`
  <div style="padding:4px 0;border-bottom:1px solid #f3f4f6;font-size:10px">
    <span class="tag tag-red" style="margin-right:5px">HIGH</span>
    <strong>${esc(q.question)}</strong>
    <span style="color:#6b7280;display:block;margin-top:1px;padding-left:65px;font-size:9px">${esc(q.rationale)}</span>
  </div>`).join("")}` : ""}
</div>

<!-- ═══════════════════════════════════════════════════════════════════
     SECTION 13 — SOURCE APPENDIX
     ═══════════════════════════════════════════════════════════════════ -->
<div class="section">
  <h2>13. Source Appendix</h2>
  <h3>Data Sources Consulted</h3>
  ${ex.sources_used.map(s=>`<div style="padding:2px 0;font-size:9.5px">• ${esc(s)}</div>`).join("")||"<p style='color:#6b7280;font-style:italic'>No sources recorded</p>"}

  <h3 style="margin-top:10px">Documents Ingested</h3>
  ${report.input_documents.length>0?`
  <table>
    <tr><th>Filename</th><th>Type</th><th>Size (chars)</th></tr>
    ${report.input_documents.map(d=>`<tr><td>${esc(d.filename)}</td><td>${esc(d.doc_type)}</td><td>${(d.char_count??0).toLocaleString()}</td></tr>`).join("")}
  </table>` : `<p style='color:#6b7280;font-style:italic'>No documents uploaded.</p>`}

  <h3 style="margin-top:10px">Processing Metadata</h3>
  <div class="kv"><span class="kv-label">Report ID</span><span style="font-family:monospace;font-size:9px">${report.report_id}</span></div>
  <div class="kv"><span class="kv-label">Generated At</span><span>${new Date(report.generated_at).toLocaleString()}</span></div>
  <div class="kv"><span class="kv-label">Processing Time</span><span>${(report._meta.processing_time_ms/1000).toFixed(1)}s</span></div>
  <div class="kv"><span class="kv-label">TRRC Match Tier</span><span>${report._meta.trrc_match_tier.replace(/_/g," ")}</span></div>
  <div class="kv"><span class="kv-label">AI Extraction Model</span><span>${esc(report._meta.ai_extraction_model)}</span></div>
  ${report._meta.eia_wti_usd!=null?`<div class="kv"><span class="kv-label">EIA WTI Price</span><span>$${report._meta.eia_wti_usd.toFixed(2)}/bbl (${esc(report._meta.eia_price_source??"")})</span></div>`:""}
  ${report._meta.edgar_operator?`<div class="kv"><span class="kv-label">EDGAR Operator</span><span>${esc(report._meta.edgar_operator)} — LOE $${report._meta.edgar_loe_per_boe?.toFixed(2)??""}/BOE</span></div>`:""}
  ${report._meta.basin?`<div class="kv"><span class="kv-label">Basin</span><span>${esc(report._meta.basin)}</span></div>`:""}
</div>

<div class="disclaimer">
  PRELIMINARY UNDERWRITING REPORT — For discussion and diligence purposes only. Not a reserve engineering study, fairness opinion, or investment advice.
  Generated by MineralFlowAI (mineralflowai.com) · Report ID: ${report.report_id} · ${new Date(report.generated_at).toLocaleString()}.
  All TRRC production data is lease-level and may lag current operations by 3–5 months. Economics are estimates based on available data — verify with a reserve engineer before making an offer.
  Identity: ${report._meta.trrc_match_tier.replace(/_/g," ")} · Confidence: ${report.overall_confidence.replace("_"," ")} · Processing time: ${(report._meta.processing_time_ms/1000).toFixed(1)}s.
  The decline-support analysis in Section 7 is a statistical fit only and should not be used as a substitute for a formal Petroleum Engineering Reserves Report.
  Inspection and violation data sourced from TRRC public records. Verify current status at trrc.texas.gov before closing.
</div>
</body>
</html>`;
    return { html, slug: (report.subject.lease_name ?? report.report_id.slice(0, 8)).replace(/[^a-z0-9]/gi, "-").toLowerCase() };
  };

  // Save as PDF — opens the report in a new tab so the user can review it,
  // then calls tab.print() from the opener (reliable cross-browser).
  // The sticky banner inside the report disappears when printing.
  const handleSavePdf = () => {
    const { html, slug } = buildReportHtml();
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const tab  = window.open(url, "_blank");
    if (!tab) {
      // Popup blocked — download HTML file as fallback
      const a = document.createElement("a");
      a.href = url;
      a.download = `dd-report-${slug}.html`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    tab.addEventListener("load", () => {
      URL.revokeObjectURL(url);
      // Delay so layout is complete, then trigger Save as PDF dialog
      setTimeout(() => { tab.print(); }, 400);
    });
  };

  // Print — same tab approach but print dialog fires immediately.
  // Identical to Save as PDF at the browser level; the user
  // chooses the destination (printer vs. Save as PDF) in the dialog.
  const handlePrint = () => {
    const { html, slug } = buildReportHtml();
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const tab  = window.open(url, "_blank");
    if (!tab) {
      const a = document.createElement("a");
      a.href = url;
      a.download = `dd-report-${slug}.html`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    tab.addEventListener("load", () => {
      URL.revokeObjectURL(url);
      setTimeout(() => { tab.print(); }, 400);
    });
  };

  const handleJsonExport = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dd-report-${report.subject.lease_name ?? report.report_id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Input field style helper
  const inp = (val: string, set: (v: string) => void, placeholder: string, flex?: number) => (
    <input
      type="text"
      value={val}
      onChange={e => set(e.target.value)}
      placeholder={placeholder}
      style={{
        flex: flex ?? 1,
        background: COLORS.surfaceAlt,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 5,
        color: COLORS.text,
        fontSize: "0.8rem",
        padding: "0.45rem 0.65rem",
        outline: "none",
        minWidth: 0,
      }}
    />
  );

  return (
    <div>
      {/* ── Export Actions ─────────────────────────────────────────────────── */}
      <Section title="Export Underwriting Package" icon="📦">
        <p style={{ fontSize: "0.8rem", color: COLORS.textMuted, marginBottom: "1rem", lineHeight: 1.6 }}>
          13-section buyer-ready DD report (Executive Summary → Source Appendix).
          Includes TRRC sources, spec-compliant disclaimers, diligence checklists, and all compliance data.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.85rem", marginBottom: "1rem" }}>
          {/* Save as PDF */}
          <div style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.accent}40`, borderRadius: 10, padding: "1.1rem" }}>
            <div style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>📄</div>
            <div style={{ fontWeight: 700, color: COLORS.text, fontSize: "0.85rem", marginBottom: "0.35rem" }}>Save as PDF</div>
            <div style={{ fontSize: "0.74rem", color: COLORS.textMuted, marginBottom: "0.75rem", lineHeight: 1.55 }}>
              Opens the full 13-section report and prompts you to save it as a PDF file to your computer.
            </div>
            <button
              onClick={handleSavePdf}
              style={{ background: COLORS.accent, color: "#fff", border: "none", borderRadius: 6, padding: "0.55rem 1rem", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer", width: "100%" }}
            >
              Save as PDF →
            </button>
          </div>

          {/* Print */}
          <div style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.1rem" }}>
            <div style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>🖨️</div>
            <div style={{ fontWeight: 700, color: COLORS.text, fontSize: "0.85rem", marginBottom: "0.35rem" }}>Print Report</div>
            <div style={{ fontSize: "0.74rem", color: COLORS.textMuted, marginBottom: "0.75rem", lineHeight: 1.55 }}>
              Opens the report and launches the print dialog. Select your printer or print to PDF manually.
            </div>
            <button
              onClick={handlePrint}
              style={{ background: COLORS.surfaceAlt, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.55rem 1rem", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer", width: "100%" }}
            >
              Print →
            </button>
          </div>

          {/* JSON */}
          <div style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.1rem" }}>
            <div style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>⬇️</div>
            <div style={{ fontWeight: 700, color: COLORS.text, fontSize: "0.85rem", marginBottom: "0.35rem" }}>Full Data Export (JSON)</div>
            <div style={{ fontSize: "0.74rem", color: COLORS.textMuted, marginBottom: "0.75rem", lineHeight: 1.55 }}>
              Complete structured underwriting package. Use for spreadsheet modeling, custom reporting, or integration with your acquisition workflow.
            </div>
            <button
              onClick={handleJsonExport}
              style={{ background: COLORS.surfaceAlt, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.55rem 1rem", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer", width: "100%" }}
            >
              Download JSON
            </button>
          </div>

          {/* LOI quick access */}
          <div style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.green}40`, borderRadius: 10, padding: "1.1rem" }}>
            <div style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>📝</div>
            <div style={{ fontWeight: 700, color: COLORS.text, fontSize: "0.85rem", marginBottom: "0.35rem" }}>Letter of Intent (LOI)</div>
            <div style={{ fontSize: "0.74rem", color: COLORS.textMuted, marginBottom: "0.75rem", lineHeight: 1.55 }}>
              Auto-populated from underwriting data. Fill in buyer info, adjust price, and download a ready-to-send LOI text file.
            </div>
            <button
              onClick={() => { const el = document.getElementById("loi-section"); el?.scrollIntoView({ behavior: "smooth" }); }}
              style={{ background: COLORS.greenDim, color: COLORS.green, border: `1px solid ${COLORS.green}40`, borderRadius: 6, padding: "0.55rem 1rem", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer", width: "100%" }}
            >
              Go to LOI Generator ↓
            </button>
          </div>
        </div>

        <div style={{ background: COLORS.yellowDim, border: `1px solid ${COLORS.yellow}30`, borderRadius: 8, padding: "0.65rem 0.9rem", fontSize: "0.73rem", color: COLORS.yellow }}>
          ⚠️ PRELIMINARY — FOR DISCUSSION ONLY. Not a reserve engineering study, fairness opinion, or investment advice. Verify all economics with a petroleum engineer before making an offer.
        </div>
      </Section>

      {/* ── Report Summary Preview ─────────────────────────────────────────── */}
      <Section title="Report Summary" icon="📋">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.55rem" }}>
          {[
            { label: "Recommendation",    value: rec.toUpperCase(),                                                                              color: recColor   },
            { label: "Risk Score",        value: `${ex.overall_risk_score.value?.toFixed(1) ?? "—"} / 10`,                                      color: COLORS.text },
            { label: "Data Completeness", value: `${ex.data_completeness_score}/100`,                                                           color: ex.data_completeness_score >= 70 ? COLORS.green : COLORS.yellow },
            { label: "Current Rate",      value: ex.current_gross_rate_bbl.value != null ? `${fmtN(ex.current_gross_rate_bbl.value)} BBL/mo` : "—", color: COLORS.text },
            { label: "Monthly NCF",       value: ex.monthly_net_income_usd.value != null ? fmt$(ex.monthly_net_income_usd.value) : "—",          color: (ex.monthly_net_income_usd.value ?? 0) >= 0 ? COLORS.green : COLORS.red },
            { label: "NPV10",             value: ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "—",                                    color: COLORS.text },
            { label: "Offer Range",       value: (ex.offer_range_low.value && ex.offer_range_high.value) ? `${fmt$(ex.offer_range_low.value)} – ${fmt$(ex.offer_range_high.value)}` : "—", color: COLORS.green },
            { label: "Critical Missing",  value: `${ex.critical_missing_count} item${ex.critical_missing_count !== 1 ? "s" : ""}`,              color: ex.critical_missing_count === 0 ? COLORS.green : COLORS.red },
            { label: "Wells Analyzed",    value: `${report.production.wells.length} well${report.production.wells.length !== 1 ? "s" : ""}`,    color: COLORS.text },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "0.65rem 0.85rem" }}>
              <div style={{ fontSize: "0.6rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: "0.85rem", fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── LOI Generator ─────────────────────────────────────────────────── */}
      <div id="loi-section">
        <Section title="Letter of Intent (LOI) Generator" icon="📝">
          <p style={{ fontSize: "0.8rem", color: COLORS.textMuted, marginBottom: "1rem", lineHeight: 1.6 }}>
            Auto-populated from underwriting data. Edit any field and download a formatted LOI text file ready to send to the seller.
            All financial figures are pre-filled from the acquisition economics analysis.
          </p>

          {/* Party info */}
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
              Parties
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              {inp(loiBuyer, setLoiBuyer, "Buyer Company Name (e.g. Acme Minerals LLC)", 2)}
              {inp(loiSigner, setLoiSigner, "Authorized Signatory Name")}
              {inp(loiSeller, setLoiSeller, "Seller / Operator Name")}
            </div>
          </div>

          {/* Property & price */}
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
              Offer Terms
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 140 }}>
                <span style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginBottom: 3 }}>Offer Price ($)</span>
                {inp(loiPrice, setLoiPrice, "e.g. 350000")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 120 }}>
                <span style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginBottom: 3 }}>Earnest Money ($)</span>
                {inp(loiDeposit, setLoiDeposit, "e.g. 25000")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 100 }}>
                <span style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginBottom: 3 }}>DD Period (days)</span>
                {inp(loiDdDays, setLoiDdDays, "30", undefined)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 100 }}>
                <span style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginBottom: 3 }}>Closing (days)</span>
                {inp(loiClosingDays, setLoiClosingDays, "45", undefined)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 100 }}>
                <span style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginBottom: 3 }}>Exclusivity (days)</span>
                {inp(loiExclDays, setLoiExclDays, "14", undefined)}
              </div>
            </div>
          </div>

          {/* Notes */}
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
              Additional Terms / Notes (optional)
            </div>
            <textarea
              value={loiNotes}
              onChange={e => setLoiNotes(e.target.value)}
              placeholder="e.g. Seller to provide signed division orders. Subject to IRS 1031 exchange. Buyer reserves right to renegotiate upon completion of title exam."
              rows={3}
              style={{ width: "100%", background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 5, color: COLORS.text, fontSize: "0.78rem", padding: "0.5rem 0.65rem", resize: "vertical", outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
            />
          </div>

          {/* Auto-populated values display */}
          <div style={{
            background: COLORS.surfaceAlt,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: "0.75rem 1rem",
            marginBottom: "0.85rem",
          }}>
            <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
              Auto-populated from underwriting analysis
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.4rem 1.5rem" }}>
              {[
                { lbl: "Property", val: [report.subject.lease_name, report.subject.county ? `${report.subject.county} Co.` : null, report.subject.state].filter(Boolean).join(", ") || "See API" },
                { lbl: "API Numbers", val: report.subject.api_numbers.slice(0, 3).join(", ") || "Not provided" },
                { lbl: "Operator of Record", val: report.subject.operator_name ?? "Not confirmed" },
                { lbl: "Current Rate", val: ex.current_gross_rate_bbl.value != null ? `${fmtN(ex.current_gross_rate_bbl.value)} BBL/mo` : "Not confirmed" },
                { lbl: "12-Mo Avg Rate", val: ex.twelve_month_avg_bbl.value != null ? `${fmtN(ex.twelve_month_avg_bbl.value)} BBL/mo` : "Not confirmed" },
                { lbl: "NPV10 (base)", val: ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "Not confirmed" },
              ].map(({ lbl, val }) => (
                <div key={lbl} style={{ fontSize: "0.74rem" }}>
                  <span style={{ color: COLORS.textFaint }}>{lbl}: </span>
                  <span style={{ color: COLORS.text, fontWeight: 600 }}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Offer price auto-fill indicator */}
          {report.acquisition_economics.offer_range_mid.value && !loiPrice && (
            <div style={{ fontSize: "0.72rem", color: COLORS.yellow, marginBottom: "0.6rem" }}>
              ⚠️ Offer price not entered — LOI will show "[PURCHASE PRICE TBD]". Suggested mid-point from analysis: {fmt$(report.acquisition_economics.offer_range_mid.value)}
            </div>
          )}

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={handleLoiDocxDownload}
              disabled={loiDocxLoading}
              style={{ background: COLORS.accent, color: "#fff", border: "none", borderRadius: 7, padding: "0.65rem 1.5rem", fontSize: "0.85rem", fontWeight: 700, cursor: loiDocxLoading ? "wait" : "pointer", flex: 1, minWidth: 200, opacity: loiDocxLoading ? 0.7 : 1 }}
            >
              {loiDocxLoading ? "Generating…" : "📝 Download LOI (.docx)"}
            </button>
            <button
              onClick={handleLoiDownload}
              style={{ background: COLORS.surfaceAlt, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "0.65rem 1rem", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}
            >
              📄 .txt
            </button>
            <button
              onClick={() => setLoiPreview(v => !v)}
              style={{ background: COLORS.surfaceAlt, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "0.65rem 1rem", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}
            >
              {loiPreview ? "Hide Preview ▲" : "Preview LOI ▼"}
            </button>
          </div>

          {loiPreview && (
            <div style={{
              marginTop: "1rem",
              background: "#fff",
              color: "#111827",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              padding: "1.25rem 1.5rem",
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: "0.74rem",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              maxHeight: 500,
              overflowY: "auto",
            }}>
              {buildLoiText()}
            </div>
          )}

          <div style={{ marginTop: "0.75rem", background: COLORS.redDim, border: `1px solid ${COLORS.red}30`, borderRadius: 7, padding: "0.6rem 0.85rem", fontSize: "0.72rem", color: COLORS.red }}>
            ⚠️ This LOI is auto-generated from preliminary analysis data and is intended as a starting point only. Have legal counsel review before execution.
            All financial figures are estimates — verify with a reserve engineer. Production data is lease-level TRRC public records.
          </div>
        </Section>
      </div>
    </div>
  );
}

// ─── Input form ───────────────────────────────────────────────────────────────

type FormState = {
  apiNumbers: string;
  rrcLeases: string;
  operatorName: string;
  leaseName: string;
  county: string;
  state: string;
  nriPct: string;      // e.g. "75" for 75% NRI
  wiPct: string;       // e.g. "100" for 100% WI
  docText: string;
  docFilename: string;
};

const INITIAL_FORM: FormState = {
  apiNumbers:   "",
  rrcLeases:    "",
  operatorName: "",
  leaseName:    "",
  county:       "",
  state:        "",
  nriPct:       "",
  wiPct:        "",
  docText:      "",
  docFilename:  "pasted_document.txt",
};

function InputBlock({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "textarea";
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: 4 }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: COLORS.textFaint, marginLeft: 6 }}>({hint})</span>}
      </label>
      {type === "textarea" ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={10}
          style={{
            width: "100%",
            background: COLORS.surfaceAlt,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            color: COLORS.text,
            fontSize: "0.8rem",
            padding: "0.6rem 0.75rem",
            resize: "vertical",
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            width: "100%",
            background: COLORS.surfaceAlt,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            color: COLORS.text,
            fontSize: "0.82rem",
            padding: "0.55rem 0.75rem",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      )}
    </div>
  );
}

// ─── Confidence header banner ─────────────────────────────────────────────────

function ReportHeader({ report }: { report: DDReport }) {
  const confColor: Record<string, string> = {
    high:     COLORS.green,
    medium:   COLORS.yellow,
    low:      COLORS.yellow,
    very_low: COLORS.red,
  };
  const color = confColor[report.overall_confidence] ?? COLORS.textMuted;

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderLeft: `4px solid ${color}`,
      borderRadius: "0 10px 10px 0",
      padding: "1.25rem 1.5rem",
      marginBottom: "1.25rem",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      flexWrap: "wrap",
      gap: "0.75rem",
    }}>
      <div>
        <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
          Due Diligence Report
        </div>
        <div style={{ fontSize: "1rem", fontWeight: 700, color: COLORS.text }}>
          {report.subject.lease_name ?? report.subject.operator_name ?? "Unknown Property"}
          {report.subject.county ? ` — ${report.subject.county} Co.` : ""}
          {report.subject.state ? `, ${report.subject.state}` : ""}
        </div>
        {report.subject.normalized_apis.length > 0 ? (
          <div style={{ fontSize: "0.78rem", color: COLORS.textMuted, marginTop: 4 }}>
            API: {report.subject.normalized_apis.slice(0, 3).map((n: NormalizedApi) => n.api_formatted).join(", ")}
            {report.subject.normalized_apis.length > 3 ? ` +${report.subject.normalized_apis.length - 3} more` : ""}
            {" "}<span style={{ color: COLORS.textFaint, fontSize: "0.68rem" }}>(normalized)</span>
          </div>
        ) : report.subject.api_numbers.length > 0 ? (
          <div style={{ fontSize: "0.78rem", color: COLORS.textMuted, marginTop: 4 }}>
            API: {report.subject.api_numbers.slice(0, 3).join(", ")}
            {report.subject.api_numbers.length > 3 ? ` +${report.subject.api_numbers.length - 3} more` : ""}
          </div>
        ) : null}
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
          Overall Confidence
        </div>
        <div style={{ fontSize: "1.1rem", fontWeight: 800, color, textTransform: "uppercase" }}>
          {report.overall_confidence.replace("_", " ")}
        </div>
        <div style={{ fontSize: "0.75rem", color: COLORS.textMuted, maxWidth: 260, marginTop: 4 }}>
          {report.overall_confidence_note}
        </div>
      </div>
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Recommendation pill */}
        {report.risk.recommendation.value && (() => {
          const recColors: Record<string, string> = { pursue: COLORS.green, review: COLORS.yellow, pass: COLORS.red };
          const rc = recColors[report.risk.recommendation.value] ?? COLORS.yellow;
          return (
            <div style={{ textAlign: "center" }}>
              <div style={{
                fontSize: "0.95rem", fontWeight: 900, color: "#fff",
                background: rc, borderRadius: 6,
                padding: "0.25rem 0.75rem", textTransform: "uppercase", letterSpacing: "0.06em",
              }}>
                {report.risk.recommendation.value}
              </div>
              <div style={{ fontSize: "0.6rem", color: COLORS.textMuted, textTransform: "uppercase", marginTop: 3 }}>Recommendation</div>
            </div>
          );
        })()}
        {/* Risk score */}
        {report.risk.overall_score.value != null && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "1.2rem", fontWeight: 800, color: COLORS.yellow }}>
              {report.risk.overall_score.value.toFixed(1)}<span style={{ fontSize: "0.7rem", color: COLORS.textFaint }}>/10</span>
            </div>
            <div style={{ fontSize: "0.6rem", color: COLORS.textMuted, textTransform: "uppercase" }}>Risk Score</div>
          </div>
        )}
        {/* Offer range */}
        {report.acquisition_economics.offer_range_mid.value && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: COLORS.green }}>
              {fmt$(report.acquisition_economics.offer_range_low.value ?? 0)} – {fmt$(report.acquisition_economics.offer_range_high.value ?? 0)}
            </div>
            <div style={{ fontSize: "0.6rem", color: COLORS.textMuted, textTransform: "uppercase" }}>Offer Range</div>
          </div>
        )}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "1.2rem", fontWeight: 800, color: COLORS.red }}>
            {report.missing_items.filter(m => m.importance === "critical").length}
          </div>
          <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, textTransform: "uppercase" }}>Critical Missing</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 600, color: COLORS.textMuted }}>
            {report._meta.trrc_match_tier.replace(/_/g, " ")}
          </div>
          <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, textTransform: "uppercase" }}>TRRC Match</div>
        </div>
      </div>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  const badges: { source: DataSource; confidence?: DataConfidence }[] = [
    { source: "trrc",          confidence: "high"   },
    { source: "trrc",          confidence: "medium" },
    { source: "run_statement"                        },
    { source: "loe_statement"                        },
    { source: "uploaded_doc"                         },
    { source: "inferred",      confidence: "high"   },
    { source: "inferred",      confidence: "low"    },
    { source: "missing"                              },
  ];
  return (
    <div style={{
      display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center",
      padding: "0.5rem 0", marginBottom: "0.75rem", fontSize: "0.72rem",
    }}>
      <span style={{ color: COLORS.textFaint, marginRight: 2 }}>Data provenance:</span>
      {badges.map((b, i) => (
        <SourceBadge key={i} source={b.source} confidence={b.confidence} />
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// ─── Pipeline progress step UI types ─────────────────────────────────────────

type PipelineStepState = {
  id: string;
  label: string;
  status: "pending" | "running" | "complete" | "failed" | "skipped";
  detail?: string;
  error?: string;
  usedFallback?: boolean;
  fallbackReason?: string;
  durationMs?: number;
};

const PIPELINE_STEP_LABELS: Record<string, string> = {
  normalize:         "Resolving asset identity",
  parse_documents:   "Parsing documents",          // step 2 — FIRST so API/lease IDs feed all TRRC queries
  resolve_asset:     "Matching RRC lease records", // step 3 — uses identifiers from docs
  pull_production:   "Pulling production history", // step 4
  pull_inspections:  "Pulling inspections & compliance", // step 5
  pull_completions:  "Searching completion records",     // step 6
  build_decline:     "Building decline curves",    // step 7
  run_economics:     "Running economics",          // step 8
  check_diligence:   "Checking missing diligence", // step 9
  generate_report:   "Generating report",          // step 10
};

const INITIAL_PIPELINE: PipelineStepState[] = Object.entries(PIPELINE_STEP_LABELS).map(([id, label]) => ({
  id,
  label,
  status: "pending",
}));

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function UnderwritingPage() {
  const searchParams = useSearchParams();
  const [form, setForm]           = useState<FormState>(INITIAL_FORM);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [report, setReport]       = useState<DDReport | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("executive_summary");
  const [files, setFiles]         = useState<{ name: string; text: string }[]>([]);
  const [showForm, setShowForm]   = useState(true);
  // Field Audit debug mode — toggle with Alt+Shift+D
  const [auditMode, setAuditMode] = useState(false);
  // Run mode: quick scan vs full underwriting
  const [scanMode, setScanMode]   = useState<"quick" | "full">("quick");
  // Full underwriting pipeline progress
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStepState[]>(INITIAL_PIPELINE);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Saved report state
  const [savedReportId, setSavedReportId]   = useState<string | null>(null);
  const [saveStatus, setSaveStatus]         = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Load a saved report from URL param ?load=<id>
  useEffect(() => {
    const id = searchParams?.get("load");
    if (!id) return;
    fetch(`/api/underwriting/reports/${id}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.report?.report_json) {
          setReport(data.report.report_json as DDReport);
          setActiveTab("executive_summary");
          setShowForm(false);
          setSavedReportId(data.report.id);
          setSaveStatus("saved");
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        setAuditMode(m => !m);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /** Save the current report to the database */
  async function handleSaveReport() {
    if (!report) return;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/underwriting/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report }),
      });
      const data = await res.json();
      if (data.ok) {
        setSavedReportId(data.id);
        setSaveStatus("saved");
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    }
  }

  const field = useCallback((key: keyof FormState) => ({
    value: form[key],
    onChange: (v: string) => setForm(f => ({ ...f, [key]: v })),
  }), [form]);

  // Multiple file upload — supports .txt / .csv (native text) and .pdf (server-side parse)
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const newFiles: { name: string; text: string }[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      try {
        if (f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf") {
          // Send PDF to server-side parser
          const form = new FormData();
          form.append("file", f);
          const res = await fetch("/api/parse-document", { method: "POST", body: form });
          if (res.ok) {
            const data = await res.json();
            if (data.ok && data.text) {
              newFiles.push({ name: f.name, text: data.text });
            }
          }
          // If parse fails, skip silently rather than crashing
        } else {
          // Plain text / CSV — read directly in browser
          newFiles.push({ name: f.name, text: await f.text() });
        }
      } catch { /* skip unreadable files */ }
    }

    if (newFiles.length > 0) {
      setFiles(prev => [...prev, ...newFiles].slice(0, 10));
    }
    // Reset so same file can be re-selected
    e.target.value = "";
  }, []);

  /** Build the shared payload from the current form state */
  function buildPayload(mode: "quick" | "full") {
    const documents: { filename: string; text: string; doc_type?: string }[] = [
      ...files.map(f => ({ filename: f.name, text: f.text })),
      ...(form.docText.trim() ? [{ filename: form.docFilename || "pasted.txt", text: form.docText.trim() }] : []),
    ];
    const nriDecimal = form.nriPct.trim() ? parseFloat(form.nriPct) / 100 : undefined;
    const wiDecimal  = form.wiPct.trim()  ? parseFloat(form.wiPct)  / 100 : undefined;
    return {
      api_numbers:       form.apiNumbers.trim() ? form.apiNumbers.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : undefined,
      rrc_lease_numbers: form.rrcLeases.trim()  ? form.rrcLeases.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : undefined,
      operator_name:     form.operatorName.trim() || undefined,
      lease_name:        form.leaseName.trim()    || undefined,
      county:            form.county.trim()        || undefined,
      state:             form.state.trim()         || undefined,
      nri_decimal:       nriDecimal,
      wi_decimal:        wiDecimal,
      documents:         documents.length > 0 ? documents : undefined,
      mode,
    };
  }

  /** Quick Scan — existing fast endpoint, 3–10 s */
  async function runQuickScan() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/underwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload("quick")),
      });
      const data = await res.json();
      if (!data.ok || !data.report) {
        setError(data.error ?? "Unknown error from underwriting API");
        return;
      }
      setReport(data.report);
      setActiveTab("executive_summary");
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  /** Full Underwriting — streaming SSE pipeline */
  async function runFullUnderwriting() {
    // Cancel any in-flight stream
    streamAbortRef.current?.abort();
    const abort = new AbortController();
    streamAbortRef.current = abort;

    setLoading(true);
    setError(null);
    setReport(null);
    // Reset all steps to pending
    setPipelineSteps(INITIAL_PIPELINE);

    const updateStep = (id: string, patch: Partial<PipelineStepState>) => {
      setPipelineSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
    };

    try {
      const res = await fetch("/api/underwriting/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload("full")),
        signal: abort.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setError(`Server error ${res.status}: ${text || "underwriting stream failed"}`);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process all complete SSE lines in the buffer
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 2);

          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const event: any = JSON.parse(line.slice(6));

              if (event.type === "progress") {
                updateStep(event.step, {
                  status:        event.status,
                  detail:        event.detail,
                  error:         event.error,
                  usedFallback:  event.usedFallback,
                  fallbackReason: event.fallbackReason,
                  durationMs:    event.durationMs,
                });
              } else if (event.type === "report") {
                setReport(event.report);
                setActiveTab("executive_summary");
                setShowForm(false);
                // Auto-save: persist the completed report immediately so it
                // appears in deal history without requiring a manual save click.
                setSaveStatus("saving");
                fetch("/api/underwriting/reports", {
                  method:  "POST",
                  headers: { "Content-Type": "application/json" },
                  body:    JSON.stringify({ report: event.report }),
                })
                  .then(r => r.json())
                  .then(d => {
                    if (d.ok) { setSavedReportId(d.id); setSaveStatus("saved"); }
                    else setSaveStatus("idle"); // silent fail — user can still save manually
                  })
                  .catch(() => setSaveStatus("idle"));
              } else if (event.type === "error") {
                setError(event.message ?? "Pipeline error");
              }
              // "done" event is informational — stream will close naturally
            } catch { /* skip malformed JSON */ }
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return; // user cancelled
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  /** Dispatches to the correct run function based on selected mode */
  function runUnderwriting() {
    if (scanMode === "full") {
      runFullUnderwriting();
    } else {
      runQuickScan();
    }
  }

  const missingCountBadge = report ? report.missing_items.filter(m => m.importance === "critical").length : 0;

  return (
    <FieldAuditContext.Provider value={auditMode}>
    <div style={{
      minHeight: "100vh",
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem 1.5rem" }}>

        {/* Field Audit mode banner */}
        {auditMode && (
          <div style={{
            marginBottom: "1rem",
            padding: "0.5rem 1rem",
            background: "rgba(245,158,11,0.12)",
            border: "1px solid rgba(245,158,11,0.4)",
            borderRadius: 8,
            fontSize: "0.78rem",
            color: COLORS.yellow,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <span>
              <strong>🔍 FIELD AUDIT MODE</strong> — Every data cell shows full provenance chain.
              Values labeled MISSING or INFERRED without a source chain are <strong>not verified</strong>.
              Press <kbd style={{ background: "rgba(245,158,11,0.2)", padding: "0 4px", borderRadius: 3 }}>Alt+Shift+D</kbd> to exit.
            </span>
            <button onClick={() => setAuditMode(false)} style={{ background: "none", border: "none", color: COLORS.yellow, cursor: "pointer", fontWeight: 700, fontSize: "0.9rem" }}>✕</button>
          </div>
        )}

        {/* Header */}
        <div style={{ marginBottom: "2rem", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
          <div>
            <h1 style={{ margin: "0 0 0.35rem 0", fontSize: "1.5rem", fontWeight: 800 }}>
              MineralFlow Underwriting
            </h1>
            <p style={{ margin: 0, color: COLORS.textMuted, fontSize: "0.875rem" }}>
              AI-powered acquisition underwriting infrastructure — institutional first-pass diligence across production, decline modeling, economics, compliance, and ownership. Every data field shows its provenance: VERIFIED / OCR EXTRACTED / INFERRED.
            </p>
          </div>
          {report && (
            <button
              onClick={() => setActiveTab("export_center")}
              style={{
                background: COLORS.accent,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "0.55rem 1.1rem",
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              📦 Export / Print
            </button>
          )}
        </div>

        {/* Input form — collapsible after first run */}
        <div style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          marginBottom: "1.5rem",
          overflow: "hidden",
        }}>
          {/* Form header / toggle */}
          <div
            onClick={() => setShowForm(v => !v)}
            style={{
              padding: "0.9rem 1.5rem",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              borderBottom: showForm ? `1px solid ${COLORS.border}` : "none",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "0.9rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {report ? "✏️ Edit Inputs & Re-run" : "Underwriting Intake"}
            </h2>
            <span style={{ color: COLORS.textFaint, fontSize: "0.85rem" }}>{showForm ? "▲" : "▼"}</span>
          </div>

          {loading && !showForm && (
            <div style={{ padding: "0.75rem 1.5rem", color: COLORS.accent, fontSize: "0.82rem", fontWeight: 600 }}>
              ⟳ Running underwriting analysis…
            </div>
          )}

          {showForm && (
            <div style={{ padding: "1.5rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1.5rem" }}>
                <InputBlock
                  label="API Number(s)"
                  hint="Any format — 8, 10, or hyphenated. Comma or newline separated. Texas (42-xxx) auto-detected."
                  {...field("apiNumbers")}
                />
                <InputBlock
                  label="RRC Lease Number(s)"
                  hint="Just the lease number — district code is optional"
                  {...field("rrcLeases")}
                />
                <InputBlock
                  label="Operator Name"
                  {...field("operatorName")}
                />
                <InputBlock
                  label="Lease Name"
                  {...field("leaseName")}
                />
                <InputBlock
                  label="County"
                  {...field("county")}
                />
                <InputBlock
                  label="State"
                  hint="Optional for Texas — inferred from API prefix 42"
                  {...field("state")}
                />
                <InputBlock
                  label="NRI %"
                  hint="Net revenue interest — leave blank to infer from division orders"
                  {...field("nriPct")}
                />
                <InputBlock
                  label="WI %"
                  hint="Working interest — leave blank to infer from JOA / ownership docs"
                  {...field("wiPct")}
                />
              </div>

              <h2 style={{ margin: "1.25rem 0 0.75rem 0", fontSize: "0.9rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Documents
              </h2>
              <p style={{ color: COLORS.textFaint, fontSize: "0.78rem", margin: "0 0 0.75rem 0" }}>
                Upload multiple files: LOE statements, run tickets, workover AFEs, division orders, reserve reports, equipment lists, etc. The AI extracts every structured field from all documents.
              </p>

              {/* Multi-file upload */}
              <div style={{
                border: `2px dashed ${COLORS.borderStrong}`,
                borderRadius: 8,
                padding: "1rem",
                textAlign: "center",
                marginBottom: "0.75rem",
              }}>
                <label style={{ cursor: "pointer", color: COLORS.textMuted, fontSize: "0.82rem", display: "block" }}>
                  <input
                    type="file"
                    accept=".txt,.csv,.pdf"
                    multiple
                    onChange={handleFileChange}
                    style={{ display: "none" }}
                  />
                  📁 Click to add files (.txt, .csv, .pdf) — PDFs are auto-parsed server-side. Up to 10 files.
                </label>
                {files.length > 0 && (
                  <div style={{ marginTop: "0.6rem", textAlign: "left" }}>
                    {files.map((f, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.2rem 0.4rem", fontSize: "0.78rem" }}>
                        <span style={{ color: COLORS.green }}>✓ {f.name}</span>
                        <span style={{ color: COLORS.textFaint }}>{(f.text.length / 1000).toFixed(1)}k chars</span>
                        <button
                          onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}
                          style={{ background: "none", border: "none", color: COLORS.red, cursor: "pointer", fontSize: "0.75rem", padding: "0 4px" }}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <InputBlock
                label="Or paste document text"
                hint="LOE statement, run ticket, equipment list, production report, etc."
                type="textarea"
                {...field("docText")}
              />

              {/* ── Mode selector ─────────────────────────────────────────── */}
              <div style={{ marginTop: "1rem" }}>
                <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.75rem", fontWeight: 700,
                  color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Run Mode
                </p>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  {(["quick", "full"] as const).map(mode => {
                    const isSelected = scanMode === mode;
                    const cfg = mode === "quick"
                      ? { icon: "⚡", title: "Quick Scan",        sub: "3–10 sec · preliminary · triage only" }
                      : { icon: "🔍", title: "Full Underwriting",  sub: "1–5 min · complete pipeline · all sources" };
                    return (
                      <button
                        key={mode}
                        onClick={() => !loading && setScanMode(mode)}
                        disabled={loading}
                        style={{
                          flex: 1,
                          textAlign: "left",
                          padding: "0.65rem 0.85rem",
                          borderRadius: 8,
                          border: `1.5px solid ${isSelected ? COLORS.accent : COLORS.border}`,
                          background: isSelected ? COLORS.accentDim : COLORS.surfaceAlt,
                          cursor: loading ? "default" : "pointer",
                          transition: "border 0.15s, background 0.15s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: "0.95rem" }}>{cfg.icon}</span>
                          <span style={{ fontSize: "0.8rem", fontWeight: 700, color: isSelected ? COLORS.accent : COLORS.text }}>
                            {cfg.title}
                          </span>
                          {isSelected && (
                            <span style={{ fontSize: "0.6rem", background: COLORS.accent, color: "#fff",
                              borderRadius: 4, padding: "0 5px", fontWeight: 800 }}>SELECTED</span>
                          )}
                        </div>
                        <div style={{ fontSize: "0.68rem", color: COLORS.textMuted }}>{cfg.sub}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── Run button ────────────────────────────────────────────── */}
              <button
                onClick={runUnderwriting}
                disabled={loading}
                style={{
                  background: loading ? COLORS.surfaceAlt : COLORS.accent,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "0.75rem 2rem",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.7 : 1,
                  transition: "opacity 0.2s",
                  width: "100%",
                  marginTop: "0.75rem",
                }}
              >
                {loading
                  ? (scanMode === "full" ? "Running Full Underwriting…" : "Running Quick Scan…")
                  : scanMode === "full"
                    ? (report ? "Re-run Full Underwriting" : "Run Full Underwriting")
                    : (report ? "Re-run Quick Scan" : "Run Quick Scan")}
              </button>

              {/* ── Full underwriting progress tracker ───────────────────── */}
              {scanMode === "full" && (loading || pipelineSteps.some(s => s.status !== "pending")) && (
                <div style={{
                  marginTop: "1.25rem",
                  background: COLORS.surfaceAlt,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 10,
                  padding: "1rem 1.25rem",
                }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 800, color: COLORS.textMuted,
                    textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.85rem",
                    display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                      background: COLORS.accent, animation: "pulse 1.4s ease-in-out infinite" }} />
                    Full Underwriting In Progress
                  </div>
                  <style>{`
                    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
                    @keyframes spin  { to{transform:rotate(360deg)} }
                  `}</style>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {pipelineSteps.map((step, idx) => {
                      const isRunning  = step.status === "running";
                      const isComplete = step.status === "complete";
                      const isFailed   = step.status === "failed";
                      const isSkipped  = step.status === "skipped";
                      const isPending  = step.status === "pending";

                      const iconColor = isComplete
                        ? COLORS.green
                        : isFailed
                          ? COLORS.red
                          : isRunning
                            ? COLORS.accent
                            : COLORS.textFaint;

                      return (
                        <div key={step.id} style={{
                          display: "flex", alignItems: "flex-start", gap: 10,
                          opacity: isPending ? 0.4 : 1,
                          transition: "opacity 0.3s",
                        }}>
                          {/* Step number / icon */}
                          <div style={{ width: 20, textAlign: "center", flexShrink: 0, paddingTop: 1 }}>
                            {isRunning ? (
                              <span style={{ display: "inline-block", fontSize: "0.75rem", color: COLORS.accent,
                                animation: "spin 1s linear infinite" }}>◌</span>
                            ) : isComplete ? (
                              <span style={{ fontSize: "0.75rem", color: COLORS.green }}>✓</span>
                            ) : isFailed ? (
                              <span style={{ fontSize: "0.75rem", color: COLORS.red }}>✗</span>
                            ) : isSkipped ? (
                              <span style={{ fontSize: "0.75rem", color: COLORS.textFaint }}>—</span>
                            ) : (
                              <span style={{ fontSize: "0.65rem", color: COLORS.textFaint,
                                fontWeight: 600 }}>{idx + 1}</span>
                            )}
                          </div>

                          {/* Label + detail */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: "0.78rem", fontWeight: isRunning ? 700 : 500,
                                color: isRunning ? COLORS.text : isPending ? COLORS.textFaint : iconColor }}>
                                {step.label}
                              </span>
                              {step.usedFallback && isComplete && (
                                <span style={{ fontSize: "0.6rem", background: COLORS.yellowDim,
                                  color: COLORS.yellow, borderRadius: 4, padding: "0 5px", fontWeight: 700 }}>
                                  FALLBACK
                                </span>
                              )}
                              {step.durationMs != null && isComplete && (
                                <span style={{ fontSize: "0.65rem", color: COLORS.textFaint }}>
                                  {(step.durationMs / 1000).toFixed(1)}s
                                </span>
                              )}
                            </div>
                            {isRunning && (
                              <div style={{ fontSize: "0.68rem", color: COLORS.accent, marginTop: 1 }}>
                                Working…
                              </div>
                            )}
                            {step.detail && (isComplete || isFailed) && (
                              <div style={{ fontSize: "0.68rem", color: isFailed ? COLORS.red : COLORS.textMuted,
                                marginTop: 1, lineHeight: 1.4 }}>
                                {step.detail}
                              </div>
                            )}
                            {step.error && (
                              <div style={{ fontSize: "0.68rem", color: COLORS.red, marginTop: 1 }}>
                                {step.error}
                              </div>
                            )}
                            {step.fallbackReason && step.usedFallback && (
                              <div style={{ fontSize: "0.68rem", color: COLORS.yellow, marginTop: 1 }}>
                                ⚠ {step.fallbackReason}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: "0.75rem", fontSize: "0.68rem", color: COLORS.textFaint,
                    borderTop: `1px solid ${COLORS.border}`, paddingTop: "0.5rem" }}>
                    Full underwriting runs all data sources sequentially. This may take 1–5 minutes.
                  </div>
                </div>
              )}

              {error && (
                <div style={{
                  marginTop: "1rem",
                  background: COLORS.redDim,
                  border: `1px solid ${COLORS.red}40`,
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  color: COLORS.text,
                  fontSize: "0.82rem",
                }}>
                  ⚠️ {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Report */}
        {report && (
          <>
            {/* ── Scan mode banner ───────────────────────────────────────── */}
            {report.scan_mode === "quick" ? (
              <div style={{
                background: "rgba(234,179,8,0.12)",
                border: "2px solid rgba(234,179,8,0.5)",
                borderRadius: 10,
                padding: "1rem 1.25rem",
                marginBottom: "1.25rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
                flexWrap: "wrap",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
                  <span style={{ fontSize: "1.1rem", lineHeight: 1 }}>⚠</span>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: "0.8rem", color: COLORS.yellow,
                      letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: "0.2rem" }}>
                      Preliminary Quick Scan
                    </div>
                    <div style={{ fontSize: "0.78rem", color: COLORS.text, lineHeight: 1.5 }}>
                      This is a <strong>triage-only result</strong> — not a full underwriting report.
                      Data may be incomplete or unverified. Confidence ratings reflect limited source coverage.
                      Run Full Underwriting for institutional-grade analysis with all data sources.
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => { setScanMode("full"); }}
                  style={{
                    flexShrink: 0,
                    background: COLORS.yellow,
                    color: "#000",
                    border: "none",
                    borderRadius: 7,
                    padding: "0.5rem 1rem",
                    fontSize: "0.75rem",
                    fontWeight: 800,
                    cursor: "pointer",
                    letterSpacing: "0.04em",
                    whiteSpace: "nowrap" as const,
                  }}
                >
                  🔍 Run Full Underwriting
                </button>
              </div>
            ) : (() => {
                const completionStatus = deriveReportCompletionLabel(report.diligence_status ?? [], report.diligence_run_label);
                const isBlocked  = completionStatus.severity === "blocked";
                const isPartial  = completionStatus.severity === "partial";
                const bgColor    = isBlocked ? "rgba(239,68,68,0.1)" : isPartial ? "rgba(234,179,8,0.12)" : COLORS.greenDim;
                const borderColor = isBlocked ? "rgba(239,68,68,0.4)" : isPartial ? "rgba(234,179,8,0.5)" : "rgba(34,197,94,0.3)";
                const labelColor  = isBlocked ? "#dc2626" : isPartial ? COLORS.yellow : COLORS.green;
                const icon        = isBlocked ? "⛔" : isPartial ? "⚠" : "✓";
                return (
                  <div style={{
                    background: bgColor,
                    border: `1px solid ${borderColor}`,
                    borderRadius: 10,
                    padding: "0.75rem 1.25rem",
                    marginBottom: "1.25rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}>
                    <span style={{ fontSize: "1rem" }}>{icon}</span>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: "0.78rem", color: labelColor,
                        letterSpacing: "0.08em", textTransform: "uppercase" as const }}>
                        {completionStatus.label}
                      </span>
                      <span style={{ fontSize: "0.76rem", color: COLORS.textMuted, marginLeft: "0.6rem" }}>
                        {completionStatus.sublabel}
                      </span>
                    </div>
                  </div>
                );
              })()
            }

            {/* ── Truth-Check Engine banner ────────────────────────────── */}
            {report.truth_check && (() => {
              const tc = report.truth_check;
              const isBlock = tc.overall_verdict === "block";
              const isWarn  = tc.overall_verdict === "warn";
              const bg      = isBlock ? "rgba(239,68,68,0.10)" : isWarn ? "rgba(234,179,8,0.09)" : "rgba(34,197,94,0.08)";
              const border  = isBlock ? "rgba(239,68,68,0.45)" : isWarn ? "rgba(234,179,8,0.45)" : "rgba(34,197,94,0.35)";
              const color   = isBlock ? COLORS.red : isWarn ? COLORS.yellow : COLORS.green;
              const icon    = isBlock ? "⛔" : isWarn ? "⚠" : "✓";
              const label   = isBlock ? "TRUTH-CHECK BLOCKED" : isWarn ? "TRUTH-CHECK WARNINGS" : "TRUTH-CHECK PASSED";
              return (
                <div style={{ background: bg, border: `1.5px solid ${border}`, borderRadius: 10, padding: "0.85rem 1.25rem", marginBottom: "1rem" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "0.65rem" }}>
                    <span style={{ fontSize: "1rem", lineHeight: 1.4 }}>{icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" as const, marginBottom: "0.4rem" }}>
                        <span style={{ fontWeight: 900, fontSize: "0.72rem", color, letterSpacing: "0.1em", textTransform: "uppercase" as const }}>
                          {label}
                        </span>
                        <span style={{ fontSize: "0.72rem", color: COLORS.textMuted }}>
                          {tc.claims.length} claim{tc.claims.length !== 1 ? "s" : ""} checked against TRRC raw evidence
                        </span>
                      </div>
                      <div style={{ fontSize: "0.76rem", color: COLORS.text, marginBottom: tc.claims.filter(c => c.blocking).length > 0 ? "0.6rem" : 0 }}>
                        {tc.summary}
                      </div>
                      {/* Active blocks */}
                      {tc.claims.filter(c => c.blocking).map((cl, i) => (
                        <div key={i} style={{
                          marginTop: "0.3rem",
                          background: "rgba(0,0,0,0.2)",
                          borderRadius: 6,
                          padding: "0.4rem 0.75rem",
                          borderLeft: `3px solid ${color}`,
                          fontSize: "0.72rem",
                        }}>
                          <span style={{ fontWeight: 800, color, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginRight: 8 }}>
                            {cl.verdict.replace(/_/g, " ")}
                          </span>
                          <span style={{ color: COLORS.textMuted }}>
                            {cl.claim_label}:
                          </span>
                          <span style={{ color: COLORS.text, marginLeft: 6 }}>
                            {cl.explanation}
                          </span>
                        </div>
                      ))}
                      {/* Gate summary */}
                      {(tc.gate.block_production_claims || tc.gate.block_clean_compliance || tc.gate.block_economics) && (
                        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" as const }}>
                          {tc.gate.block_production_claims && (
                            <span style={{ fontSize: "0.62rem", fontWeight: 800, color: COLORS.red, background: COLORS.redDim, padding: "0.2rem 0.5rem", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                              🚫 Production Claims Blocked
                            </span>
                          )}
                          {tc.gate.block_clean_compliance && (
                            <span style={{ fontSize: "0.62rem", fontWeight: 800, color: COLORS.red, background: COLORS.redDim, padding: "0.2rem 0.5rem", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                              🚫 Clean Compliance Blocked
                            </span>
                          )}
                          {tc.gate.block_economics && (
                            <span style={{ fontSize: "0.62rem", fontWeight: 800, color: COLORS.red, background: COLORS.redDim, padding: "0.2rem 0.5rem", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                              🚫 Economics / Offer Blocked
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            <ReportHeader report={report} />
            <Legend />

            {/* Tab bar */}
            <div style={{
              display: "flex",
              gap: 2,
              overflowX: "auto",
              marginBottom: "1rem",
              padding: "0 0 2px 0",
            }}>
              {TABS.map(tab => {
                const isActive = activeTab === tab.id;
                const isMissing = tab.id === "missing_diligence" && missingCountBadge > 0;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      background: isActive ? COLORS.accent : COLORS.surface,
                      color: isActive ? "#fff" : COLORS.textMuted,
                      border: `1px solid ${isActive ? COLORS.accent : COLORS.border}`,
                      borderRadius: 8,
                      padding: "0.45rem 0.9rem",
                      fontSize: "0.75rem",
                      fontWeight: isActive ? 700 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      flexShrink: 0,
                    }}
                  >
                    <span>{tab.icon}</span>
                    {tab.label}
                    {isMissing && (
                      <span style={{
                        background: COLORS.red,
                        color: "#fff",
                        borderRadius: 10,
                        fontSize: "0.6rem",
                        fontWeight: 800,
                        padding: "0.05rem 0.35rem",
                      }}>
                        {missingCountBadge}
                      </span>
                    )}
                  </button>
                );
              })}
              <div style={{ flex: 1 }} />
              {/* Save report button */}
              <button
                onClick={handleSaveReport}
                disabled={saveStatus === "saving"}
                style={{
                  background: saveStatus === "saved" ? COLORS.greenDim : saveStatus === "error" ? COLORS.redDim : COLORS.accentDim,
                  color: saveStatus === "saved" ? COLORS.green : saveStatus === "error" ? COLORS.red : COLORS.accent,
                  border: `1px solid ${saveStatus === "saved" ? COLORS.green + "40" : saveStatus === "error" ? COLORS.red + "40" : COLORS.accent + "40"}`,
                  borderRadius: 8,
                  padding: "0.45rem 0.9rem",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  cursor: saveStatus === "saving" ? "wait" : "pointer",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "✓ Saved" : saveStatus === "error" ? "Save Failed" : "💾 Save"}
              </button>
              {saveStatus === "saved" && savedReportId && (
                <a
                  href="/underwriting/history"
                  style={{
                    background: "transparent",
                    color: COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 8,
                    padding: "0.45rem 0.9rem",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                    flexShrink: 0,
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  📋 History
                </a>
              )}
              <button
                onClick={() => { setReport(null); setFiles([]); setForm(INITIAL_FORM); setShowForm(true); setError(null); setSavedReportId(null); setSaveStatus("idle"); }}
                style={{
                  background: "transparent",
                  color: COLORS.textMuted,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 8,
                  padding: "0.45rem 0.9rem",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                ← New Report
              </button>
            </div>

            {/* Tab content */}
            <div>
              {activeTab === "truth_check"           && <TruthCheckTab          report={report} />}
              {activeTab === "data_provenance"       && <DataProvenanceTab      report={report} />}
              {activeTab === "executive_summary"    && <ExecutiveSummaryTab    report={report} />}
              {activeTab === "asset_overview"        && <AssetOverviewTab       report={report} />}
              {activeTab === "production_decline"    && <ProductionDeclineTab   report={report} />}
              {activeTab === "production_audit"      && <ProductionAuditTab     report={report} />}
              {activeTab === "economics_valuation"   && <EconomicsValuationTab  report={report} />}
              {activeTab === "operations_workovers"  && <OperationsWorkoverTab  report={report} />}
              {activeTab === "compliance_risk"       && <ComplianceRiskTab      report={report} />}
              {activeTab === "ownership_interests"   && <OwnershipTab           report={report} />}
              {activeTab === "swd_water"             && <InjectionTab           report={report} />}
              {activeTab === "imaged_records"        && <ImagedRecordsTab       report={report} />}
              {activeTab === "proration_p5"          && <ProrationP5Tab         report={report} />}
              {activeTab === "documents_sources"     && <DocumentsSourcesTab    report={report} />}
              {activeTab === "missing_diligence"     && <MissingItemsTab        report={report} />}
              {activeTab === "ic_memo"               && <IcMemoTab              report={report} />}
              {activeTab === "export_center"         && <ExportTab              report={report} />}
            </div>

            {/* Meta footer */}
            <div style={{
              marginTop: "1.5rem",
              padding: "0.75rem 1rem",
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              fontSize: "0.72rem",
              color: COLORS.textFaint,
              display: "flex",
              gap: "1.5rem",
              flexWrap: "wrap",
            }}>
              <span>Generated: {new Date(report.generated_at).toLocaleString()}</span>
              <span>Model: {report._meta.ai_extraction_model}</span>
              <span>Processing: {(report._meta.processing_time_ms / 1000).toFixed(1)}s</span>
              <span>TRRC match: {report._meta.trrc_match_tier.replace(/_/g, " ")}</span>
              <span>Documents: {report.input_documents.length}</span>
              {report._meta.basin && <span>Basin: {report._meta.basin}</span>}
              {report._meta.eia_wti_usd && (
                <span style={{ color: COLORS.accent }}>
                  EIA WTI: ${report._meta.eia_wti_usd.toFixed(2)}/bbl ({report._meta.eia_price_source})
                </span>
              )}
              {report._meta.edgar_operator && (
                <span style={{ color: COLORS.accent }}>
                  EDGAR: {report._meta.edgar_operator} LOE ${report._meta.edgar_loe_per_boe?.toFixed(2)}/BOE
                </span>
              )}
              {report._meta.production_confidence && (
                <span style={{
                  color: report._meta.production_confidence === "VERIFIED" ? COLORS.green
                    : report._meta.production_confidence === "PARTIAL" ? COLORS.yellow
                    : COLORS.red,
                  fontWeight: 700,
                }}>
                  Production: {report._meta.production_confidence}
                  {report._meta.production_active_months != null && ` (${report._meta.production_active_months} active mo)`}
                  {report._meta.production_downtime_pct != null && report._meta.production_downtime_pct > 0 && ` · ${report._meta.production_downtime_pct.toFixed(0)}% downtime`}
                  {report._meta.production_stabilized_bbl != null && ` · ${report._meta.production_stabilized_bbl} BBL/mo stabilized`}
                  {report._meta.production_restart_events != null && report._meta.production_restart_events > 0 && ` · ${report._meta.production_restart_events} restart(s)`}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
    </FieldAuditContext.Provider>
  );
}
