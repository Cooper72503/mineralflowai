"use client";

/**
 * UnderwritingCharts.tsx
 *
 * Recharts-based chart components for the underwriting report.
 * Kept in a separate file to avoid bloating UnderwritingPage.tsx further.
 *
 * Components:
 *   ProductionDeclineChart — historical oil bars + DCA projected decline line
 *   CashFlowChart          — 24-month monthly NCF bars + cumulative NCF line
 *   DcaProjectionChart     — 60-month Arps decline curve (DCA tab)
 */

import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import type { DDReport, MonthlyCashFlowRow } from "@/lib/underwriting/types";

// ── Design tokens (mirror parent) ─────────────────────────────────────────────
const C = {
  accent:    "#4f8ef7",
  green:     "#22c55e",
  yellow:    "#f59e0b",
  red:       "#ef4444",
  text:      "#e2e8f0",
  muted:     "#8892a4",
  faint:     "#5a6478",
  border:    "rgba(255,255,255,0.08)",
  grid:      "rgba(255,255,255,0.04)",
  tooltip:   "#13161e",
};

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmtN = (n: number) => Math.round(n).toLocaleString();
const fmt$ = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}MM`
  : n >= 1_000   ? `$${Math.round(n / 1_000)}K`
  : n < 0        ? `-$${Math.round(Math.abs(n) / 1_000)}K`
  : `$${Math.round(n)}`;

function addMonths(period: string, n: number): string {
  const [yr, mo] = period.split("-").map(Number);
  const d = new Date(yr, mo - 1 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const tooltipContentStyle = {
  backgroundColor: C.tooltip,
  border: `1px solid rgba(255,255,255,0.12)`,
  borderRadius: 8,
  fontSize: "0.76rem",
  color: C.text,
};
const tooltipLabelStyle = { color: C.muted, marginBottom: 4 };

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.7rem", color: C.faint }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, flexShrink: 0 }} />
      {label}
    </span>
  );
}
function LegendLine({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.7rem", color: C.faint }}>
      <svg width={20} height={10} style={{ flexShrink: 0 }}>
        <line x1={0} y1={5} x2={20} y2={5} stroke={color} strokeWidth={2}
          strokeDasharray={dashed ? "5 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

// ── Production + Decline Curve Chart ──────────────────────────────────────────
// Shows up to 36 months of actual oil/gas production (bars/line) and overlays
// the DCA projected decline curve starting from the last actual period.

export function ProductionDeclineChart({ report }: { report: DDReport }) {
  const { production: prod, dca } = report;

  // Aggregate historical data across all wells by period
  const byPeriod = new Map<string, { oil: number; gas: number }>();
  for (const well of prod.wells) {
    for (const row of well.monthly_history) {
      const ex = byPeriod.get(row.period) ?? { oil: 0, gas: 0 };
      byPeriod.set(row.period, { oil: ex.oil + row.oil_bbl, gas: ex.gas + row.gas_mcf });
    }
  }

  const historicalSorted = Array.from(byPeriod.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-36);

  if (historicalSorted.length === 0 && dca.projections.length === 0) return null;

  const lastPeriod = historicalSorted[historicalSorted.length - 1]?.[0] ?? null;
  const hasGas = historicalSorted.some(([, v]) => v.gas > 0);

  // Build historical data points
  type Point = {
    period: string;
    actual?: number;
    gas?: number;
    projected?: number;
  };

  const historicalData: Point[] = historicalSorted.map(([period, v]) => ({
    period,
    actual: v.oil,
    gas:    v.gas > 0 ? v.gas : undefined,
  }));

  // Overlap: last actual period also gets the month-0 projected value so the
  // decline line connects seamlessly to the bars.
  if (lastPeriod && dca.projections.length > 0 && historicalData.length > 0) {
    historicalData[historicalData.length - 1].projected = Math.round(dca.projections[0].rate_bbl);
  }

  // Project forward 36 months from the last actual period
  const projData: Point[] = lastPeriod
    ? dca.projections.slice(0, 36).map(p => ({
        period:    addMonths(lastPeriod, p.month),
        projected: Math.round(p.rate_bbl),
      }))
    : [];

  const data: Point[] = [...historicalData, ...projData];

  const yMax = Math.ceil(
    Math.max(
      ...historicalData.map(d => d.actual ?? 0),
      ...projData.map(d => d.projected ?? 0),
      1,
    ) * 1.1,
  );

  const xInterval = Math.max(1, Math.floor(data.length / 9) - 1);

  return (
    <div>
      <ResponsiveContainer width="100%" height={270}>
        <ComposedChart data={data} margin={{ top: 8, right: hasGas ? 56 : 12, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="period"
            tick={{ fill: C.faint, fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: C.border }}
            interval={xInterval}
          />
          <YAxis
            yAxisId="oil"
            tick={{ fill: C.faint, fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtN}
            domain={[0, yMax]}
            width={48}
            label={{ value: "BBL/mo", angle: -90, position: "insideLeft", fill: C.faint, fontSize: 9, dy: 32 }}
          />
          {hasGas && (
            <YAxis
              yAxisId="gas"
              orientation="right"
              tick={{ fill: C.green, fontSize: 9, opacity: 0.7 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtN}
              width={48}
              label={{ value: "MCF/mo", angle: 90, position: "insideRight", fill: C.green, fontSize: 9, opacity: 0.7, dy: -30 }}
            />
          )}
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            formatter={(value: unknown, name: unknown) => {
              const v = value as number;
              if (name === "actual")    return [`${fmtN(v)} BBL`, "Oil — Actual"];
              if (name === "projected") return [`${fmtN(v)} BBL`, "Oil — Projected (DCA)"];
              if (name === "gas")       return [`${fmtN(v)} MCF`, "Gas — Actual"];
              return [v, String(name ?? "")];
            }}
          />
          {lastPeriod && (
            <ReferenceLine
              yAxisId="oil"
              x={lastPeriod}
              stroke={C.faint}
              strokeDasharray="4 4"
              label={{ value: "▶ projected", position: "insideTopRight", fill: C.faint, fontSize: 8 }}
            />
          )}
          <Bar
            yAxisId="oil"
            dataKey="actual"
            name="actual"
            fill={C.accent}
            opacity={0.85}
            radius={[2, 2, 0, 0]}
            maxBarSize={16}
          />
          <Line
            yAxisId="oil"
            dataKey="projected"
            name="projected"
            stroke={C.yellow}
            strokeWidth={2}
            dot={false}
            strokeDasharray="6 3"
            connectNulls
          />
          {hasGas && (
            <Line
              yAxisId="gas"
              dataKey="gas"
              name="gas"
              stroke={C.green}
              strokeWidth={1.5}
              dot={false}
              opacity={0.7}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: 4 }}>
        <LegendDot color={C.accent} label="Oil — Actual (BBL/mo)" />
        {dca.projections.length > 0 && <LegendLine color={C.yellow} dashed label="DCA Projection (BBL/mo)" />}
        {hasGas && <LegendLine color={C.green} label="Gas — Actual (MCF/mo)" />}
      </div>
    </div>
  );
}

// ── DCA 60-Month Projection Chart ─────────────────────────────────────────────
// Standalone decline curve for the DCA tab — shows the full 60-month Arps curve.

export function DcaProjectionChart({
  projections,
  lastPeriod,
}: {
  projections: { month: number; rate_bbl: number }[];
  lastPeriod?: string | null;
}) {
  if (projections.length === 0) return null;

  const data = projections.map(p => ({
    label:    lastPeriod ? addMonths(lastPeriod, p.month) : `Mo ${p.month}`,
    rate:     Math.round(p.rate_bbl),
    month:    p.month,
  }));

  const yMax = Math.ceil(Math.max(...data.map(d => d.rate), 1) * 1.1);
  const xInterval = Math.max(1, Math.floor(data.length / 8) - 1);

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="label"
            tick={{ fill: C.faint, fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: C.border }}
            interval={xInterval}
          />
          <YAxis
            tick={{ fill: C.faint, fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmtN}
            domain={[0, yMax]}
            width={48}
            label={{ value: "BBL/mo", angle: -90, position: "insideLeft", fill: C.faint, fontSize: 9, dy: 32 }}
          />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            formatter={(value: unknown) => [`${fmtN(value as number)} BBL/mo`, "Projected Rate"]}
          />
          {/* Area under curve */}
          <Bar dataKey="rate" name="rate" fill={C.accent} opacity={0} maxBarSize={0} />
          <Line
            dataKey="rate"
            name="rate"
            stroke={C.accent}
            strokeWidth={2.5}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: "1.25rem", marginTop: 4 }}>
        <LegendLine color={C.accent} label="Projected Production — Arps Decline (BBL/mo)" />
      </div>
    </div>
  );
}

// ── Cash Flow Chart ────────────────────────────────────────────────────────────
// 24-month monthly net income (bars) + cumulative NCF (line).

export function CashFlowChart({ schedule }: { schedule: MonthlyCashFlowRow[] }) {
  if (!schedule || schedule.length === 0) return null;

  const data = schedule.slice(0, 24).map(r => ({
    label:      `Mo ${r.month}`,
    net_income: Math.round(r.net_income),
    cumulative: Math.round(r.cumulative_net_income),
  }));

  const maxIncome = Math.max(...data.map(d => d.net_income), 1);
  const maxCum    = Math.max(...data.map(d => d.cumulative), 1);

  const xInterval = Math.max(0, Math.floor(data.length / 10) - 1);

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 60, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis
            dataKey="label"
            tick={{ fill: C.faint, fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: C.border }}
            interval={xInterval}
          />
          <YAxis
            yAxisId="income"
            tick={{ fill: C.faint, fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmt$}
            domain={[0, Math.ceil(maxIncome * 1.15)]}
            width={52}
            label={{ value: "Net Income", angle: -90, position: "insideLeft", fill: C.faint, fontSize: 9, dy: 42 }}
          />
          <YAxis
            yAxisId="cum"
            orientation="right"
            tick={{ fill: C.accent, fontSize: 9, opacity: 0.8 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmt$}
            domain={[0, Math.ceil(maxCum * 1.1)]}
            width={56}
            label={{ value: "Cumulative", angle: 90, position: "insideRight", fill: C.accent, fontSize: 9, opacity: 0.8, dy: -46 }}
          />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            formatter={(value: unknown, name: unknown) => {
              const v = value as number;
              if (name === "net_income") return [fmt$(v), "Monthly Net Income"];
              if (name === "cumulative") return [fmt$(v), "Cumulative NCF"];
              return [v, String(name ?? "")];
            }}
          />
          <Bar
            yAxisId="income"
            dataKey="net_income"
            name="net_income"
            fill={C.green}
            opacity={0.75}
            radius={[2, 2, 0, 0]}
            maxBarSize={18}
          />
          <Line
            yAxisId="cum"
            dataKey="cumulative"
            name="cumulative"
            stroke={C.accent}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: 4 }}>
        <LegendDot color={C.green} label="Monthly Net Income" />
        <LegendLine color={C.accent} label="Cumulative NCF" />
      </div>
    </div>
  );
}
