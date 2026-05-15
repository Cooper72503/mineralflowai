"use client";

/**
 * Production Statement — Last 36 Months
 *
 * Priority:
 *   1. Real TRRC monthly production data (fetched from /api/wells/production)
 *   2. Arps exponential backcast from decline-model current rate
 *   3. Basin estimate backcast (county type-curve BOPD)
 *
 * Only option 1 represents actual reported production. Options 2 & 3 are
 * mathematical projections and are clearly labelled as estimates.
 */

import { useState, useEffect, useMemo } from "react";
import type { DeclineCurveResult } from "@/lib/decline/decline-curve";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import type { StateProductionResult } from "@/lib/wells/production-types";
import { SOURCE_LABELS } from "@/lib/wells/production-types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProductionMonthRow = {
  /** e.g. "Jan 2023" */
  label: string;
  /** BOPD for that month */
  bopd: number;
  /** Oil production in BBL */
  oil_bbl: number;
  /** Gross oil revenue ($) */
  gross_revenue: number | null;
  /** Net royalty income ($) — null when royalty rate unknown */
  net_royalty: number | null;
};

export type ProductionHistoryResult = {
  months: ProductionMonthRow[];
  basis: "state_actual" | "trrc_actual" | "decline_model" | "basin_estimate" | "insufficient";
  source_label: string;  // e.g. "TRRC Actual", "WV DEP Actual"
  annual_decline_rate: number;
  current_bopd: number;
  total_oil_bbl: number;
  total_gross_revenue: number | null;
  total_net_royalty: number | null;
  note: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_OIL_PRICE   = 70;
const DEFAULT_DECLINE_RATE = 0.20;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "short", year: "numeric",
  });
}

function monthLabelAgo(monthsAgo: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

// ── Build from real state agency data ─────────────────────────────────────────

export function buildProductionHistoryFromState(args: {
  stateData:   StateProductionResult;
  royaltyRate: number | null;
  oilPrice?:   number;
}): ProductionHistoryResult {
  const { stateData, royaltyRate } = args;
  const oilPrice = args.oilPrice ?? DEFAULT_OIL_PRICE;

  const months: ProductionMonthRow[] = stateData.rows.map(row => {
    const days        = daysInMonth(row.year, row.month);
    const bopd        = row.oil_bbl > 0 ? row.oil_bbl / days : 0;
    const gross       = row.oil_bbl * oilPrice;
    const net_royalty = royaltyRate != null ? gross * royaltyRate : null;
    return {
      label:         monthLabel(row.year, row.month),
      bopd:          Math.round(bopd * 10) / 10,
      oil_bbl:       row.oil_bbl,
      gross_revenue: row.oil_bbl > 0 ? Math.round(gross) : null,
      net_royalty:   net_royalty != null && row.oil_bbl > 0 ? Math.round(net_royalty) : null,
    };
  });

  // Most-recent month's BOPD as "current"
  const lastRow     = stateData.rows[stateData.rows.length - 1];
  const lastDays    = lastRow ? daysInMonth(lastRow.year, lastRow.month) : 30;
  const currentBopd = lastRow && lastRow.oil_bbl > 0 ? lastRow.oil_bbl / lastDays : 0;

  const total_oil_bbl       = months.reduce((s, r) => s + r.oil_bbl, 0);
  const total_gross_revenue = months.reduce((s, r) => s + (r.gross_revenue ?? 0), 0);
  const total_net_royalty   = royaltyRate != null
    ? months.reduce((s, r) => s + (r.net_royalty ?? 0), 0)
    : null;

  const sourceLabel = SOURCE_LABELS[stateData.source] ?? stateData.source;

  const noteBySource: Record<string, string> = {
    trrc_actual:  `Actual reported production from Texas Railroad Commission${
      stateData.lease_number ? ` (lease ${stateData.lease_number}, district ${stateData.district_code})` : ""
    }. Oil price assumed at $${oilPrice}/BBL. Not a royalty statement.`,
    wvdep_actual: `Actual reported production from WV Department of Environmental Protection (API ${stateData.api_number}). Oil price assumed at $${oilPrice}/BBL. Not a royalty statement.`,
  };

  return {
    months,
    basis:               "state_actual",
    source_label:        sourceLabel,
    annual_decline_rate: 0,
    current_bopd:        Math.round(currentBopd * 10) / 10,
    total_oil_bbl,
    total_gross_revenue,
    total_net_royalty,
    note: noteBySource[stateData.source] ?? `Actual reported production from ${sourceLabel}. Oil price assumed at $${oilPrice}/BBL. Not a royalty statement.`,
  };
}

/** @deprecated Use buildProductionHistoryFromState instead */
export function buildProductionHistoryFromTrrc(args: {
  trrcData:    StateProductionResult;
  royaltyRate: number | null;
  oilPrice?:   number;
}): ProductionHistoryResult {
  return buildProductionHistoryFromState({ stateData: args.trrcData, royaltyRate: args.royaltyRate, oilPrice: args.oilPrice });
}

// ── Build from decline model / basin estimate (backcast) ─────────────────────

export function buildProductionHistory(args: {
  declineAnalysis:        DeclineCurveResult | null;
  nearbyWellIntelligence: NearbyWellIntelligence | null;
  royaltyRate:            number | null;
  oilPrice?:              number;
}): ProductionHistoryResult | null {
  const { declineAnalysis: dc, nearbyWellIntelligence: nw, royaltyRate } = args;
  const oilPrice = args.oilPrice ?? DEFAULT_OIL_PRICE;

  let currentBopd: number | null = null;
  let annualDi: number;
  let basis: ProductionHistoryResult["basis"];

  if (dc && dc.basis !== "insufficient_data" && dc.current_rate_bopd != null && dc.current_rate_bopd > 0) {
    currentBopd = dc.current_rate_bopd;
    annualDi    = dc.annual_decline_rate ?? DEFAULT_DECLINE_RATE;
    basis       = "decline_model";
  } else if (nw && (nw.median_bopd ?? nw.avg_bopd) != null) {
    currentBopd = (nw.median_bopd ?? nw.avg_bopd)!;
    annualDi    = DEFAULT_DECLINE_RATE;
    basis       = "basin_estimate";
  } else {
    return null;
  }

  const Di_monthly = annualDi / 12;
  const months: ProductionMonthRow[] = [];

  for (let monthsAgo = 36; monthsAgo >= 1; monthsAgo--) {
    const bopd         = currentBopd * Math.exp(Di_monthly * monthsAgo);
    const oil_bbl      = Math.round(bopd * 30.44);
    const gross        = oil_bbl * oilPrice;
    const net_royalty  = royaltyRate != null ? gross * royaltyRate : null;
    months.push({
      label:         monthLabelAgo(monthsAgo),
      bopd:          Math.round(bopd * 10) / 10,
      oil_bbl,
      gross_revenue: Math.round(gross),
      net_royalty:   net_royalty != null ? Math.round(net_royalty) : null,
    });
  }

  const total_oil_bbl       = months.reduce((s, r) => s + r.oil_bbl, 0);
  const total_gross_revenue = months[0].gross_revenue != null
    ? months.reduce((s, r) => s + (r.gross_revenue ?? 0), 0) : null;
  const total_net_royalty   = months[0].net_royalty != null
    ? months.reduce((s, r) => s + (r.net_royalty ?? 0), 0) : null;

  const noteByBasis: Record<string, string> = {
    decline_model:  "Reconstructed from Arps exponential decline model anchored to nearby well data. Figures are estimates — not operator statements.",
    basin_estimate: "Estimated using county basin type-curve BOPD (no specific well production data available). Figures are directional only.",
  };

  return {
    months,
    basis,
    source_label:        basis === "decline_model" ? "Decline Model" : "Basin Estimate",
    annual_decline_rate: annualDi,
    current_bopd:        currentBopd,
    total_oil_bbl,
    total_gross_revenue,
    total_net_royalty,
    note: noteByBasis[basis] ?? "",
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtBbl(n: number): string { return n.toLocaleString("en-US"); }

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(n);
}

// ── Component ─────────────────────────────────────────────────────────────────

type Props = {
  declineAnalysis:        DeclineCurveResult | null;
  nearbyWellIntelligence: NearbyWellIntelligence | null;
  royaltyRate:            number | null;
  oilPrice?:              number;
};

const basisMeta = {
  trrc_actual:    { label: "TRRC Actual",     bg: "#dcfce7", text: "#15803d", border: "#86efac" },
  decline_model:  { label: "Decline Model",   bg: "#dbeafe", text: "#1e40af", border: "#93c5fd" },
  basin_estimate: { label: "Basin Estimate",  bg: "#fef9c3", text: "#854d0e", border: "#fde047" },
  insufficient:   { label: "",                bg: "#f3f4f6", text: "#6b7280", border: "#e5e7eb" },
};

export function ProductionHistoryTable({
  declineAnalysis, nearbyWellIntelligence, royaltyRate, oilPrice,
}: Props) {
  const [stateData,      setStateData]      = useState<StateProductionResult | null>(null);
  const [prodLoading,    setProdLoading]    = useState(false);
  const [prodAttempted,  setProdAttempted]  = useState(false);

  // Gather real API numbers from nearby wells (skip synthetic/unknown)
  const realApiNumbers = useMemo(() => {
    if (!nearbyWellIntelligence?.wells) return [];
    return nearbyWellIntelligence.wells
      .map(w => w.api)
      .filter(a => a && !a.startsWith("synthetic") && a !== "unknown");
  }, [nearbyWellIntelligence]);

  // Attempt to fetch real production data once we have API numbers
  useEffect(() => {
    if (prodAttempted || realApiNumbers.length === 0) return;
    setProdAttempted(true);
    setProdLoading(true);

    const params = realApiNumbers.slice(0, 5).join(",");
    fetch(`/api/wells/production?api=${encodeURIComponent(params)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: StateProductionResult | null) => {
        if (data?.rows?.length) setStateData(data);
      })
      .catch(() => null)
      .finally(() => setProdLoading(false));
  }, [realApiNumbers, prodAttempted]);

  // Resolve which history to display
  const history: ProductionHistoryResult | null = useMemo(() => {
    if (stateData) {
      return buildProductionHistoryFromState({ stateData, royaltyRate, oilPrice });
    }
    return buildProductionHistory({ declineAnalysis, nearbyWellIntelligence, royaltyRate, oilPrice });
  }, [stateData, declineAnalysis, nearbyWellIntelligence, royaltyRate, oilPrice]);

  // ── empty state ─────────────────────────────────────────────────────────────
  if (!history && !prodLoading) {
    return (
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          Production Statement (36 Months)
        </h2>
        <p style={{ fontSize: "0.88rem", color: "#6b7280", margin: 0 }}>
          Insufficient production data to generate a 36-month history.
        </p>
      </div>
    );
  }

  if (prodLoading && !history) {
    return (
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          Production Statement (36 Months)
        </h2>
        <p style={{ fontSize: "0.88rem", color: "#6b7280", margin: 0 }}>
          Fetching production records…
        </p>
      </div>
    );
  }

  if (!history) return null;

  const showRevenue = history.months[0]?.gross_revenue != null;
  const showRoyalty = history.months[0]?.net_royalty   != null;
  const isActual    = history.basis === "state_actual" || history.basis === "trrc_actual";
  const bs          = isActual ? basisMeta.trrc_actual : basisMeta[history.basis as keyof typeof basisMeta] ?? basisMeta.insufficient;

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <div>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: "0 0 0.2rem" }}>
            Production Statement
          </h2>
          <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: 0 }}>
            {isActual ? "Actual reported · " : "Estimated · "}last {history.months.length} months
            {history.months.length > 0 && (
              <> · {history.months[0].label} → {history.months[history.months.length - 1].label}</>
            )}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {prodLoading && (
            <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>checking records…</span>
          )}
          <span style={{
            fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase",
            padding: "0.2rem 0.55rem", borderRadius: 6,
            background: bs.bg, color: bs.text, border: `1px solid ${bs.border}`,
          }}>
            {isActual ? "✓ " : ""}{isActual ? history.source_label : bs.label}
          </span>
        </div>
      </div>

      {/* Summary stats */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: "0.6rem", marginBottom: "1rem", padding: "0.75rem",
        background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0",
      }}>
        <div>
          <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.2rem" }}>
            {history.months.length}-Mo Oil Production
          </div>
          <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>
            {fmtBbl(history.total_oil_bbl)} BBL
          </div>
        </div>
        {showRevenue && (
          <div>
            <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.2rem" }}>
              Gross Revenue
            </div>
            <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>
              {fmtUsd(history.total_gross_revenue)}
            </div>
          </div>
        )}
        {showRoyalty && (
          <div>
            <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.2rem" }}>
              Net Royalty
            </div>
            <div style={{ fontSize: "1rem", fontWeight: 700, color: "#15803d" }}>
              {fmtUsd(history.total_net_royalty)}
            </div>
          </div>
        )}
        {!isActual && (
          <div>
            <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.2rem" }}>
              Annual Decline
            </div>
            <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>
              {(history.annual_decline_rate * 100).toFixed(0)}%/yr
            </div>
          </div>
        )}
        {isActual && (
          <div>
            <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.2rem" }}>
              Latest Rate
            </div>
            <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>
              {history.current_bopd.toFixed(1)} BOPD
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <thead>
            <tr style={{ background: "#f1f5f9", borderBottom: "2px solid #e2e8f0" }}>
              <th style={{ padding: "0.45rem 0.65rem", textAlign: "left",  fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>Month</th>
              <th style={{ padding: "0.45rem 0.65rem", textAlign: "right", fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>BOPD</th>
              <th style={{ padding: "0.45rem 0.65rem", textAlign: "right", fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>Oil (BBL)</th>
              {showRevenue && <th style={{ padding: "0.45rem 0.65rem", textAlign: "right", fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>Gross Revenue</th>}
              {showRoyalty && <th style={{ padding: "0.45rem 0.65rem", textAlign: "right", fontWeight: 600, color: "#475569", whiteSpace: "nowrap" }}>Net Royalty</th>}
            </tr>
          </thead>
          <tbody>
            {[...history.months].reverse().map((row, idx) => (
              <tr key={row.label} style={{ borderBottom: "1px solid #f1f5f9", background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
                <td style={{ padding: "0.4rem 0.65rem", color: "#374151", fontWeight: 500, whiteSpace: "nowrap" }}>{row.label}</td>
                <td style={{ padding: "0.4rem 0.65rem", textAlign: "right", color: "#111827" }}>{row.bopd.toFixed(1)}</td>
                <td style={{ padding: "0.4rem 0.65rem", textAlign: "right", color: "#111827" }}>{fmtBbl(row.oil_bbl)}</td>
                {showRevenue && <td style={{ padding: "0.4rem 0.65rem", textAlign: "right", color: "#374151" }}>{fmtUsd(row.gross_revenue)}</td>}
                {showRoyalty && <td style={{ padding: "0.4rem 0.65rem", textAlign: "right", color: "#15803d", fontWeight: 500 }}>{fmtUsd(row.net_royalty)}</td>}
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid #e2e8f0", background: "#f8fafc", fontWeight: 700 }}>
              <td style={{ padding: "0.5rem 0.65rem", color: "#111827" }}>{history.months.length}-Month Total</td>
              <td style={{ padding: "0.5rem 0.65rem", textAlign: "right", color: "#6b7280" }}>—</td>
              <td style={{ padding: "0.5rem 0.65rem", textAlign: "right", color: "#111827" }}>{fmtBbl(history.total_oil_bbl)}</td>
              {showRevenue && <td style={{ padding: "0.5rem 0.65rem", textAlign: "right", color: "#111827" }}>{fmtUsd(history.total_gross_revenue)}</td>}
              {showRoyalty && <td style={{ padding: "0.5rem 0.65rem", textAlign: "right", color: "#15803d" }}>{fmtUsd(history.total_net_royalty)}</td>}
            </tr>
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: "0.75rem", color: "#9ca3af", margin: "0.75rem 0 0", lineHeight: 1.5 }}>
        {history.note}{!isActual ? ` Oil price assumed at $${oilPrice ?? DEFAULT_OIL_PRICE}/BBL.` : ""}
      </p>
    </div>
  );
}
