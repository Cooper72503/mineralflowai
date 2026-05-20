"use client";

import { useState, useCallback } from "react";
import type {
  DDReport, DataPoint, DataConfidence, DataSource, MissingItem, NextQuestion,
  EconomicsScenario, RiskCategoryResult, DiligenceCheckItem,
} from "@/lib/underwriting/types";

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

// ─── Source badge ─────────────────────────────────────────────────────────────

function SourceBadge({ source, sourceDetail }: { source: DataSource; sourceDetail?: string }) {
  const configs: Record<DataSource, { label: string; bg: string; color: string }> = {
    trrc:          { label: "TRRC",        bg: COLORS.accentDim,  color: COLORS.accent  },
    uploaded_doc:  { label: "Doc",         bg: COLORS.purpleDim,  color: COLORS.purple  },
    run_statement: { label: "Run Ticket",  bg: COLORS.greenDim,   color: COLORS.green   },
    loe_statement: { label: "LOE",         bg: COLORS.yellowDim,  color: COLORS.yellow  },
    inferred:      { label: "Inferred",    bg: "rgba(255,255,255,0.06)", color: COLORS.textMuted },
    missing:       { label: "Missing",     bg: COLORS.redDim,     color: COLORS.red     },
  };
  const cfg = configs[source] ?? configs.missing;
  return (
    <span
      title={sourceDetail ?? cfg.label}
      style={{
        display: "inline-block",
        fontSize: "0.65rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "0.1rem 0.45rem",
        borderRadius: 4,
        background: cfg.bg,
        color: cfg.color,
        whiteSpace: "nowrap",
        textTransform: "uppercase",
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
    low:    { symbol: "●○○", color: COLORS.yellow  },
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
  if (dp.source === "missing" || dp.value == null) {
    return (
      <span style={{ color: COLORS.textFaint, fontStyle: "italic", fontSize: "0.8rem" }}>
        {dp.note ?? "Not provided"}
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: COLORS.text, fontWeight: 600 }}>
        {format(dp.value)}{unit ? ` ${unit}` : ""}
      </span>
      <SourceBadge source={dp.source} sourceDetail={dp.source_detail} />
      <ConfBadge confidence={dp.confidence} />
      {dp.note && (
        <span style={{ fontSize: "0.7rem", color: COLORS.textMuted }}>({dp.note})</span>
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

// ─── Tab types ────────────────────────────────────────────────────────────────

type TabId =
  | "recommendation"
  | "production"
  | "dca"
  | "acq_economics"
  | "economics"
  | "workovers"
  | "equipment"
  | "compliance"
  | "plugging"
  | "injection"
  | "ownership"
  | "missing"
  | "questions";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "recommendation", label: "Recommendation",   icon: "🎯" },
  { id: "production",     label: "Production",       icon: "⛽" },
  { id: "dca",            label: "Decline Curves",   icon: "📉" },
  { id: "acq_economics",  label: "Acq. Economics",   icon: "💰" },
  { id: "economics",      label: "Economics / LOE",  icon: "📊" },
  { id: "workovers",      label: "Workovers",        icon: "🔧" },
  { id: "equipment",      label: "Equipment",        icon: "⚙️" },
  { id: "compliance",     label: "Compliance",       icon: "📋" },
  { id: "plugging",       label: "Plugging Liability",icon: "🔌" },
  { id: "injection",      label: "SWD / Injection",  icon: "💧" },
  { id: "ownership",      label: "Ownership",        icon: "📜" },
  { id: "missing",        label: "Missing Items",    icon: "⚠️" },
  { id: "questions",      label: "Next Steps",       icon: "❓" },
];

// ─── Report sections ──────────────────────────────────────────────────────────

function ProductionTab({ report }: { report: DDReport }) {
  const s = report.production;
  return (
    <>
      <Section title="Production Summary" icon="⛽">
        <KvRow label="Total Monthly Oil (BBL)">
          <DataCell dp={s.total_monthly_oil_bbl} format={n => fmtN(n, 0)} unit="BBL/mo" />
        </KvRow>
        <KvRow label="Total Monthly Gas (MCF)">
          <DataCell dp={s.total_monthly_gas_mcf} format={n => fmtN(n, 0)} unit="MCF/mo" />
        </KvRow>
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
        <KvRow label="Reserve Report">
          <DataCell dp={s.reserve_report_present} format={v => v ? "Provided" : "Not provided"} />
        </KvRow>
        {s.reserve_pv10.value && (
          <KvRow label="Reserve PV10">
            <DataCell dp={s.reserve_pv10} format={fmt$} />
          </KvRow>
        )}
      </Section>

      {s.wells.length > 0 && (
        <Section title="Well-Level Production" icon="🛢️">
          <DdTable
            headers={["Well / Lease", "API", "Latest Month BBL", "6-Mo Avg BBL", "Water Cut", "Trend", "Cum Oil BBL", "Source"]}
            rows={s.wells.map(w => [
              w.well_name,
              w.api,
              <DataCell key="oil" dp={w.latest_monthly_oil_bbl} format={n => fmtN(n, 0)} />,
              <DataCell key="avg" dp={w.six_month_avg_bbl} format={n => fmtN(n, 0)} />,
              <DataCell key="wc" dp={w.water_cut_pct} format={fmtPct} />,
              <DataCell key="tr" dp={w.production_trend} format={v => v} />,
              <DataCell key="cum" dp={w.cum_oil_bbl} format={n => fmtN(n, 0)} />,
              <SourceBadge key="src" source={w.latest_monthly_oil_bbl.source} sourceDetail={w.latest_monthly_oil_bbl.source_detail} />,
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
  return (
    <>
      <Section title="Compliance Overview" icon="📋">
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
        <Section title="Violation Detail" icon="🚨">
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
  return (
    <>
      <Section title="SWD / Injection Summary" icon="💧">
        <KvRow label="Total Disposal Capacity">
          <DataCell dp={s.total_disposal_capacity_bwpd} format={n => `${fmtN(n)} BWPD`} />
        </KvRow>
        <KvRow label="Current Utilization">
          <DataCell dp={s.current_utilization_pct} format={fmtPct} />
        </KvRow>
      </Section>
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

function MissingItemsTab({ items }: { items: MissingItem[] }) {
  const critical   = items.filter(i => i.importance === "critical");
  const important  = items.filter(i => i.importance === "important");
  const niceToHave = items.filter(i => i.importance === "nice_to_have");

  const renderGroup = (label: string, color: string, list: MissingItem[]) =>
    list.length > 0 ? (
      <Section title={`${label} (${list.length})`} icon={color === COLORS.red ? "🔴" : color === COLORS.yellow ? "🟡" : "🟢"}>
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
      {items.length === 0 && (
        <div style={{ color: COLORS.green, padding: "2rem", textAlign: "center" }}>
          ✓ All data items present.
        </div>
      )}
      {renderGroup("Critical", COLORS.red, critical)}
      {renderGroup("Important", COLORS.yellow, important)}
      {renderGroup("Nice-to-Have", COLORS.green, niceToHave)}
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
        {report.acquisition_economics.offer_range_mid.value && (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "0.72rem", color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
              Estimated Offer Range
            </div>
            <div style={{ fontSize: "1.1rem", fontWeight: 800, color: COLORS.green }}>
              {fmt$(report.acquisition_economics.offer_range_low.value ?? 0)} –{" "}
              {fmt$(report.acquisition_economics.offer_range_high.value ?? 0)}
            </div>
            <div style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>base price deck</div>
          </div>
        )}
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

// ─── Decline Curve Tab ────────────────────────────────────────────────────────

function DcaTab({ report }: { report: DDReport }) {
  const dca = report.dca;

  // Mini sparkline via SVG
  function ProjectionChart({ projections }: { projections: { month: number; rate_bbl: number }[] }) {
    if (projections.length === 0) return <p style={{ color: COLORS.textFaint, fontSize: "0.8rem" }}>No projection data</p>;
    const maxRate = Math.max(...projections.map(p => p.rate_bbl), 1);
    const w = 500, h = 120, padL = 40, padB = 20, padT = 10, padR = 10;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    const pts = projections.filter((_, i) => i % 3 === 0); // every 3 months
    const pathD = pts.map((p, i) => {
      const x = padL + (p.month / 60) * innerW;
      const y = padT + innerH - (p.rate_bbl / maxRate) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    return (
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: 500, height: "auto" }}>
        {/* Axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke={COLORS.border} strokeWidth={1} />
        <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke={COLORS.border} strokeWidth={1} />
        {/* Labels */}
        <text x={padL - 5} y={padT + 5}      fill={COLORS.textFaint} fontSize="9" textAnchor="end">{Math.round(maxRate)}</text>
        <text x={padL - 5} y={padT + innerH} fill={COLORS.textFaint} fontSize="9" textAnchor="end">0</text>
        <text x={padL} y={h - 3}             fill={COLORS.textFaint} fontSize="9">0</text>
        <text x={padL + innerW} y={h - 3}    fill={COLORS.textFaint} fontSize="9" textAnchor="end">60mo</text>
        {/* Curve */}
        <path d={pathD} fill="none" stroke={COLORS.accent} strokeWidth={2} />
        {/* Area fill */}
        <path d={`${pathD} L${padL + innerW},${padT + innerH} L${padL},${padT + innerH} Z`}
          fill={COLORS.accent} fillOpacity={0.08} />
      </svg>
    );
  }

  return (
    <div>
      <Section title="Decline Curve Model" icon="📉">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 2rem", marginBottom: "1rem" }}>
          <KvRow label="Model Type"><DataCell dp={dca.model_type} format={v => v.charAt(0).toUpperCase() + v.slice(1)} /></KvRow>
          <KvRow label="Monthly Decline %"><DataCell dp={dca.decline_rate_monthly_pct} format={fmtPct} /></KvRow>
          <KvRow label="Annual Decline %"><DataCell dp={dca.decline_rate_annual_pct} format={fmtPct} /></KvRow>
          <KvRow label="Arps b-Factor"><DataCell dp={dca.b_factor} format={v => v.toFixed(3)} /></KvRow>
          <KvRow label="R² (fit quality)"><DataCell dp={dca.r_squared} format={v => v.toFixed(3)} /></KvRow>
          <KvRow label="Current Rate (BBL/mo)"><DataCell dp={dca.current_rate_bbl} format={v => fmtN(v)} /></KvRow>
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
          <ProjectionChart projections={dca.projections} />
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
            headers={["Deck", "Oil Price", "Monthly Gross Rev", "Monthly Net Rev", "Monthly Net Income", "LOE/BOE", "NPV10", "Offer Mid", "IRR", "Payout"]}
            rows={econ.scenarios.map((s: EconomicsScenario) => [
              <strong key="d">{s.deck_label}</strong>,
              `$${s.oil_price_usd}/bbl`,
              fmt$(s.monthly_gross_revenue),
              fmt$(s.monthly_net_revenue),
              <span key="ni" style={{ color: s.monthly_net_income >= 0 ? COLORS.green : COLORS.red }}>
                {fmt$(s.monthly_net_income)}
              </span>,
              `$${s.loe_per_boe.toFixed(2)}/BOE`,
              fmt$(s.npv10_usd),
              fmt$(s.offer_mid_usd),
              s.irr_pct != null ? `${s.irr_pct.toFixed(1)}%` : "—",
              s.payout_months != null ? `${s.payout_months} mo` : "—",
            ])}
          />
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

// ─── Input form ───────────────────────────────────────────────────────────────

type FormState = {
  apiNumbers: string;
  rrcLeases: string;
  operatorName: string;
  leaseName: string;
  county: string;
  state: string;
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
        {report.subject.api_numbers.length > 0 && (
          <div style={{ fontSize: "0.78rem", color: COLORS.textMuted, marginTop: 4 }}>
            API: {report.subject.api_numbers.slice(0, 3).join(", ")}
            {report.subject.api_numbers.length > 3 ? ` +${report.subject.api_numbers.length - 3} more` : ""}
          </div>
        )}
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
  return (
    <div style={{
      display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center",
      padding: "0.5rem 0", marginBottom: "0.75rem", fontSize: "0.72rem",
    }}>
      <span style={{ color: COLORS.textFaint }}>Sources:</span>
      {(["trrc", "uploaded_doc", "loe_statement", "run_statement", "inferred", "missing"] as DataSource[]).map(s => (
        <SourceBadge key={s} source={s} />
      ))}
      <span style={{ marginLeft: 8, color: COLORS.textFaint }}>Confidence:</span>
      {(["high", "medium", "low", "none"] as DataConfidence[]).map(c => (
        <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ConfBadge confidence={c} />
          <span style={{ color: COLORS.textFaint }}>{c}</span>
        </span>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function UnderwritingPage() {
  const [form, setForm]           = useState<FormState>(INITIAL_FORM);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [report, setReport]       = useState<DDReport | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("recommendation");
  const [fileText, setFileText]   = useState<{ name: string; text: string } | null>(null);

  const field = useCallback((key: keyof FormState) => ({
    value: form[key],
    onChange: (v: string) => setForm(f => ({ ...f, [key]: v })),
  }), [form]);

  // File drag-and-drop / paste
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setFileText({ name: file.name, text });
    setForm(f => ({ ...f, docFilename: file.name, docText: "" }));
  }, []);

  async function runUnderwriting() {
    setLoading(true);
    setError(null);
    setReport(null);

    try {
      const documents: { filename: string; text: string; doc_type?: string }[] = [];

      if (fileText) {
        documents.push({ filename: fileText.name, text: fileText.text });
      }
      if (form.docText.trim()) {
        documents.push({ filename: form.docFilename || "pasted.txt", text: form.docText.trim() });
      }

      const payload = {
        api_numbers:      form.apiNumbers.trim() ? form.apiNumbers.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : undefined,
        rrc_lease_numbers: form.rrcLeases.trim()  ? form.rrcLeases.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) : undefined,
        operator_name:    form.operatorName.trim() || undefined,
        lease_name:       form.leaseName.trim()   || undefined,
        county:           form.county.trim()       || undefined,
        state:            form.state.trim()        || undefined,
        documents:        documents.length > 0 ? documents : undefined,
      };

      const res = await fetch("/api/underwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data.ok || !data.report) {
        setError(data.error ?? "Unknown error from underwriting API");
        return;
      }
      setReport(data.report);
      setActiveTab("recommendation");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  const missingCountBadge = report ? report.missing_items.filter(m => m.importance === "critical").length : 0;

  return (
    <div style={{
      minHeight: "100vh",
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem 1.5rem" }}>

        {/* Header */}
        <div style={{ marginBottom: "2rem", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
          <div>
            <h1 style={{ margin: "0 0 0.35rem 0", fontSize: "1.5rem", fontWeight: 800 }}>
              Acquisition Due Diligence
            </h1>
            <p style={{ margin: 0, color: COLORS.textMuted, fontSize: "0.875rem" }}>
              Autonomous underwriting — DCA, economics, risk scoring, offer ranges, and diligence tracking.
              Every metric is source-labeled: TRRC, uploaded docs, or inferred.
            </p>
          </div>
          {report && (
            <button
              onClick={() => {
                const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `dd-report-${report.subject.lease_name ?? report.report_id.slice(0, 8)}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              style={{
                background: COLORS.surfaceAlt,
                color: COLORS.textMuted,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                padding: "0.55rem 1.1rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ⬇ Export JSON
            </button>
          )}
        </div>

        {/* Input form */}
        {!report && (
          <div style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            padding: "1.5rem",
            marginBottom: "1.5rem",
          }}>
            <h2 style={{ margin: "0 0 1.25rem 0", fontSize: "0.9rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Well Identification
            </h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 1.5rem" }}>
              <InputBlock
                label="API Number(s)"
                hint="Any format — 8, 10, or hyphenated. Comma or newline separated. Texas (42-xxx) auto-detected."
                placeholder="42-151-31926-00-00"
                {...field("apiNumbers")}
              />
              <InputBlock
                label="RRC Lease Number(s)"
                hint="Just the lease number (e.g. 29126) — district code is optional"
                placeholder="29126"
                {...field("rrcLeases")}
              />
              <InputBlock
                label="Operator Name"
                placeholder="Pioneer Natural Resources"
                {...field("operatorName")}
              />
              <InputBlock
                label="Lease Name"
                placeholder="Bomar"
                {...field("leaseName")}
              />
              <InputBlock
                label="County"
                placeholder="Fisher"
                {...field("county")}
              />
              <InputBlock
                label="State"
                hint="Optional for Texas — inferred from API prefix 42"
                placeholder="TX"
                {...field("state")}
              />
            </div>

            <h2 style={{ margin: "1.5rem 0 1rem 0", fontSize: "0.9rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Upload or Paste Documents
            </h2>
            <p style={{ color: COLORS.textFaint, fontSize: "0.78rem", margin: "0 0 1rem 0" }}>
              Paste LOE statements, run tickets, workover AFEs, equipment lists, ownership schedules, etc. The AI will extract every structured field.
            </p>

            {/* File upload */}
            <div style={{
              border: `2px dashed ${COLORS.borderStrong}`,
              borderRadius: 8,
              padding: "1rem",
              textAlign: "center",
              marginBottom: "1rem",
              cursor: "pointer",
            }}>
              <label style={{ cursor: "pointer", color: COLORS.textMuted, fontSize: "0.82rem" }}>
                <input
                  type="file"
                  accept=".txt,.csv,.pdf"
                  onChange={handleFileChange}
                  style={{ display: "none" }}
                />
                {fileText
                  ? <span style={{ color: COLORS.green }}>✓ {fileText.name} ({(fileText.text.length / 1000).toFixed(1)}k chars)</span>
                  : <span>Click to upload a file (.txt or .csv extracted text) — or paste below</span>
                }
              </label>
            </div>

            <InputBlock
              label="Paste document text"
              hint="LOE statement, run ticket, equipment list, etc."
              placeholder={`Example:\n\nLOE STATEMENT - MARCH 2024\nOperator: Smith Energy LLC\nLease: Jones Ranch\nAPI: 42-317-24601-00-00\n\nProduction:\n  Crude Oil: 412 BBL\n  Gas: 18,200 MCF\n\nOperating Costs:\n  Electricity: $2,847\n  Chemical Treating: $890\n  Labor: $3,200\n  Water Disposal: $1,240\n  Total LOE: $8,177\n\nRevenue:\n  Oil Revenue: $32,143\n  Gas Revenue: $7,280\n  Net Income: $31,246`}
              type="textarea"
              {...field("docText")}
            />

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
                marginTop: "0.5rem",
              }}
            >
              {loading ? "Running Underwriting Analysis…" : "Run Due Diligence"}
            </button>

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

        {/* Report */}
        {report && (
          <>
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
                const isMissing = tab.id === "missing" && missingCountBadge > 0;
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
              <button
                onClick={() => { setReport(null); setFileText(null); setForm(INITIAL_FORM); }}
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
              {activeTab === "recommendation" && <RecommendationTab report={report} />}
              {activeTab === "production"     && <ProductionTab     report={report} />}
              {activeTab === "dca"            && <DcaTab            report={report} />}
              {activeTab === "acq_economics"  && <AcqEconomicsTab   report={report} />}
              {activeTab === "economics"      && <EconomicsTab      report={report} />}
              {activeTab === "workovers"      && <WorkoversTab      report={report} />}
              {activeTab === "equipment"      && <EquipmentTab      report={report} />}
              {activeTab === "compliance"     && <ComplianceTab     report={report} />}
              {activeTab === "plugging"       && <PluggingTab       report={report} />}
              {activeTab === "injection"      && <InjectionTab      report={report} />}
              {activeTab === "ownership"      && <OwnershipTab      report={report} />}
              {activeTab === "missing"        && <MissingItemsTab   items={report.missing_items} />}
              {activeTab === "questions"      && <NextQuestionsTab  questions={report.next_questions} />}
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
