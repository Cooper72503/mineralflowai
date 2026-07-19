"use client";

/**
 * OfferCalculatorCard
 *
 * Inline offer calculator that auto-populates from real analysis data
 * (decline curve BOPD, nearby-well BOPD, royalty rate, acreage).
 * When actual BOPD is available the calculation is anchored to real
 * production data instead of basin benchmarks.
 */

import { useState, useMemo } from "react";
import { buildOfferScenarios } from "@/lib/valuation/offer-calculator";
import type { DeclineCurveResult } from "@/lib/decline/decline-curve";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return fmt(n);
}

const PAYOUT_YEARS = [1, 2, 3, 4, 5] as const;
const TABLE_PRICES = [55, 60, 65, 70, 75, 80, 85, 90, 95];

// ── types ─────────────────────────────────────────────────────────────────────

type Props = {
  declineAnalysis:       DeclineCurveResult | null;
  nearbyWellIntelligence: NearbyWellIntelligence | null;
  /** Royalty rate as decimal (0.1875 = 3/16). */
  royaltyRate:           number | null;
  /** Net mineral acres. */
  acreage:               number | null;
  /** Deal type for multiple selection logic. */
  dealType?:             string | null;
  /** Activity level override — falls through to county lookup if omitted. */
  activityLevel?:        "high" | "moderate" | "low" | "unknown" | null;
  county?:               string | null;
  state?:                string | null;
};

// ── component ─────────────────────────────────────────────────────────────────

export function OfferCalculatorCard({
  declineAnalysis,
  nearbyWellIntelligence,
  royaltyRate,
  acreage,
  dealType,
  activityLevel,
  county,
  state,
}: Props) {
  // Resolve the best available BOPD from real data
  const resolvedBopd: number | null = useMemo(() => {
    if (declineAnalysis?.current_rate_bopd && declineAnalysis.current_rate_bopd > 0) {
      return declineAnalysis.current_rate_bopd;
    }
    const wb = nearbyWellIntelligence?.median_bopd ?? nearbyWellIntelligence?.avg_bopd;
    if (wb && wb > 0) return wb;
    return null;
  }, [declineAnalysis, nearbyWellIntelligence]);

  // Editable overrides — pre-filled from real data
  const [payoutMin,    setPayoutMin]    = useState(1);
  const [payoutMax,    setPayoutMax]    = useState(5);
  const [oilPrice,     setOilPrice]     = useState(70);
  const [bopdEdit,     setBopdEdit]     = useState<string>(
    resolvedBopd != null ? resolvedBopd.toFixed(2) : ""
  );
  const [royaltyEdit,  setRoyaltyEdit]  = useState<string>(
    royaltyRate != null ? (royaltyRate * 100).toFixed(4).replace(/\.?0+$/, "") + "%" : ""
  );
  const [acreageEdit,  setAcreageEdit]  = useState<string>(
    acreage != null ? String(acreage) : ""
  );

  // Parse editable fields
  const bopdVal    = parseFloat(bopdEdit)   || 0;
  const royaltyVal = (() => {
    const s = royaltyEdit.trim().replace(/%$/, "");
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    return n > 1 ? n / 100 : n;
  })();
  const acreageVal = parseFloat(acreageEdit.replace(/,/g, "")) || 0;

  const canCalculate = bopdVal > 0 && royaltyVal > 0 && acreageVal > 0;

  const result = useMemo(() => {
    if (!canCalculate) return null;
    return buildOfferScenarios({
      nma:           acreageVal,
      royalty_rate:  royaltyVal,
      bopd_actual:   bopdVal > 0 ? bopdVal : null,
      deal_type:     dealType ?? null,
      activity_level: activityLevel ?? null,
      county:        county ?? null,
      state:         state ?? null,
    });
  }, [bopdVal, royaltyVal, acreageVal, dealType, activityLevel, county, state, canCalculate]);

  const annualAt = (price: number) =>
    bopdVal * 365 * price * royaltyVal;

  const offerLow  = canCalculate ? annualAt(oilPrice) * payoutMin : 0;
  const offerHigh = canCalculate ? annualAt(oilPrice) * payoutMax : 0;
  const nmaLow    = acreageVal > 0 ? offerLow  / acreageVal : 0;
  const nmaHigh   = acreageVal > 0 ? offerHigh / acreageVal : 0;

  const bopdSource =
    declineAnalysis?.current_rate_bopd && declineAnalysis.current_rate_bopd > 0
      ? "Decline Model"
      : (nearbyWellIntelligence?.median_bopd ?? nearbyWellIntelligence?.avg_bopd)
        ? "Nearby Wells (median)"
        : null;

  return (
    <div className="card" style={{ marginBottom: "1.5rem" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
        <div>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: "0 0 0.2rem" }}>
            Offer Calculator
          </h2>
          <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: 0 }}>
            Pre-filled from analysis · adjust any field to recalculate
          </p>
        </div>
        {bopdSource && (
          <span style={{
            fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase",
            padding: "0.2rem 0.55rem", borderRadius: 6,
            background: "#dcfce7", color: "#15803d", border: "1px solid #86efac",
          }}>
            ✓ Live Data — {bopdSource}
          </span>
        )}
      </div>

      {/* Editable inputs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.65rem", marginBottom: "1rem" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.25rem" }}>
            BOPD (actual)
          </label>
          <input
            type="text"
            value={bopdEdit}
            onChange={e => setBopdEdit(e.target.value)}
            placeholder="e.g. 12.5"
            style={{ width: "100%", boxSizing: "border-box", padding: "0.4rem 0.55rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
          />
          {resolvedBopd != null && (
            <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
              From analysis: {resolvedBopd.toFixed(2)} BOPD
            </span>
          )}
        </div>
        <div>
          <label style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.25rem" }}>
            Royalty Rate
          </label>
          <input
            type="text"
            value={royaltyEdit}
            onChange={e => setRoyaltyEdit(e.target.value)}
            placeholder="e.g. 18.75% or 3/16"
            style={{ width: "100%", boxSizing: "border-box", padding: "0.4rem 0.55rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.25rem" }}>
            Net Mineral Acres (NMA)
          </label>
          <input
            type="text"
            value={acreageEdit}
            onChange={e => setAcreageEdit(e.target.value)}
            placeholder="e.g. 160"
            style={{ width: "100%", boxSizing: "border-box", padding: "0.4rem 0.55rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
          />
        </div>
      </div>

      {!canCalculate && (
        <p style={{ fontSize: "0.83rem", color: "#9ca3af", margin: "0 0 0.75rem" }}>
          Enter BOPD, royalty rate, and NMA above to generate offer targets.
        </p>
      )}

      {canCalculate && (
        <>
          {/* Suggested offer banner */}
          {result && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "0.75rem",
              padding: "0.75rem 1rem",
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
              borderRadius: 8,
              marginBottom: "1rem",
            }}>
              <div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>Suggested Offer</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0c4a6e" }}>{fmt(result.suggested_offer_low)} – {fmt(result.suggested_offer_high)}</div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", marginTop: "0.15rem" }}>
                  {result.using_actual_bopd
                    ? `${dealType === "undeveloped" ? "3×–6×" : "5×–10×"} annual royalty @ $70 · real BOPD`
                    : `${dealType === "undeveloped" ? "3×–6×" : "5×–10×"} annual royalty @ $70`}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>$/NMA</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0c4a6e" }}>{fmt(result.dollar_per_nma_low)} – {fmt(result.dollar_per_nma_high)}</div>
              </div>
              <div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>Monthly Royalty</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0c4a6e" }}>{fmt(result.monthly_royalty_at_70)}</div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", marginTop: "0.15rem" }}>@ $70/bbl</div>
              </div>
              <div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>BOPD Used</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#0c4a6e" }}>{bopdVal.toFixed(2)}</div>
                <div style={{ fontSize: "0.72rem", color: "#0369a1", marginTop: "0.15rem" }}>
                  {result.using_actual_bopd ? "actual well data" : "basin benchmark"}
                </div>
              </div>
            </div>
          )}

          {/* Payout range controls */}
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "#374151", marginBottom: "0.5rem" }}>
              Payout Range Filter
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Min Payout (yr)</label>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <input type="range" min={1} max={5} step={1} value={payoutMin}
                    onChange={e => { const v = Number(e.target.value); setPayoutMin(v); if (v > payoutMax) setPayoutMax(v); }}
                    style={{ flex: 1, accentColor: "#2563eb" }} />
                  <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "#1e40af", minWidth: 28, textAlign: "right" }}>{payoutMin}yr</span>
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Max Payout (yr)</label>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <input type="range" min={1} max={5} step={1} value={payoutMax}
                    onChange={e => { const v = Number(e.target.value); setPayoutMax(v); if (v < payoutMin) setPayoutMin(v); }}
                    style={{ flex: 1, accentColor: "#2563eb" }} />
                  <span style={{ fontSize: "0.9rem", fontWeight: 700, color: "#1e40af", minWidth: 28, textAlign: "right" }}>{payoutMax}yr</span>
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.75rem", color: "#6b7280", fontWeight: 600, marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Oil Price ($/bbl)</label>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <input type="range" min={40} max={120} step={5} value={oilPrice}
                    onChange={e => setOilPrice(Number(e.target.value))}
                    style={{ flex: 1, accentColor: oilPrice === 70 ? "#16a34a" : "#2563eb" }} />
                  <span style={{ fontSize: "0.9rem", fontWeight: 700, minWidth: 38, textAlign: "right", color: oilPrice === 70 ? "#15803d" : "#1e40af" }}>
                    ${oilPrice}{oilPrice === 70 ? <span style={{ fontSize: "0.65rem" }}>★</span> : null}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Live payout target */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "0.6rem",
            padding: "0.65rem 0.85rem",
            background: "#f8fafc",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            marginBottom: "1rem",
          }}>
            <div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>Target Offer Range</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>
                {payoutMin === payoutMax ? fmt(offerLow) : `${fmt(offerLow)} – ${fmt(offerHigh)}`}
              </div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "0.15rem" }}>
                {payoutMin === payoutMax ? `${payoutMin}-yr payout` : `${payoutMin}–${payoutMax}-yr payout`} @ ${oilPrice}/bbl
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>$/NMA</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>
                {payoutMin === payoutMax ? fmt(nmaLow) : `${fmt(nmaLow)} – ${fmt(nmaHigh)}`}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.2rem" }}>Annual Royalty</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "#111827" }}>{fmt(annualAt(oilPrice))}</div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "0.15rem" }}>@ ${oilPrice}/bbl</div>
            </div>
          </div>

          {/* 1–5yr payout table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: "0.82rem", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ padding: "0.4rem 0.6rem", textAlign: "left", color: "#6b7280", fontWeight: 500, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                    $/bbl ↓ · Payout →
                  </th>
                  {PAYOUT_YEARS.map(yr => {
                    const inRange = yr >= payoutMin && yr <= payoutMax;
                    return (
                      <th key={yr} style={{
                        padding: "0.4rem 0.6rem", textAlign: "right",
                        fontWeight: inRange ? 700 : 400,
                        color: inRange ? "#1e40af" : "#6b7280",
                        borderBottom: "1px solid #e5e7eb",
                        background: inRange ? "#eff6ff" : "transparent",
                        whiteSpace: "nowrap",
                      }}>
                        {yr}yr
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {TABLE_PRICES.map(price => {
                  const isMedian = price === 70;
                  const rowAnnual = annualAt(price);
                  return (
                    <tr key={price} style={{ background: isMedian ? "#fafafa" : "transparent" }}>
                      <td style={{ padding: "0.4rem 0.6rem", fontWeight: isMedian ? 700 : 400, color: isMedian ? "#111827" : "#374151", borderBottom: "1px solid #f3f4f6", whiteSpace: "nowrap" }}>
                        ${price}/bbl{isMedian ? " ★" : ""}
                      </td>
                      {PAYOUT_YEARS.map(yr => {
                        const inRange = yr >= payoutMin && yr <= payoutMax;
                        const isHighlight = inRange && isMedian;
                        return (
                          <td key={yr} style={{
                            padding: "0.4rem 0.6rem", textAlign: "right",
                            fontWeight: isHighlight ? 700 : inRange ? 600 : 400,
                            color: isHighlight ? "#1e3a8a" : inRange ? "#1e40af" : "#374151",
                            background: isHighlight ? "#dbeafe" : inRange ? "#eff6ff" : "transparent",
                            borderBottom: "1px solid #f3f4f6",
                            whiteSpace: "nowrap",
                          }}>
                            {fmtK(rowAnnual * yr)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p style={{ fontSize: "0.75rem", color: "#9ca3af", margin: "0.5rem 0 0", lineHeight: 1.4 }}>
              ★ = $70/bbl median · Blue = selected payout range · Payout = offer ÷ annual royalty at given price
            </p>
          </div>

          {/* Caveats */}
          {result && result.caveats.length > 0 && (
            <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.8rem", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6 }}>
              <p style={{ fontSize: "0.75rem", fontWeight: 600, color: "#92400e", margin: "0 0 0.25rem" }}>⚠ Directional estimate — not an appraisal</p>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {result.caveats.map((c, i) => (
                  <li key={i} style={{ fontSize: "0.75rem", color: "#78350f", lineHeight: 1.5 }}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
