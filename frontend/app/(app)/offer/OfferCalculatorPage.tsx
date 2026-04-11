"use client";

import { useState } from "react";
import {
  buildOfferScenarios,
  parseRoyaltyRate,
  type OfferCalculatorResult,
} from "@/lib/valuation/offer-calculator";

const EM_DASH = "—";

function fmt(n: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n);
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return fmt(n);
}

// "Core zone" multiples and prices for highlighting
const CORE_MULTIPLES = new Set([5, 8, 12]);
const CORE_PRICES    = new Set([65, 70, 75]);

function SensitivityTable({ result }: { result: OfferCalculatorResult }) {
  const { matrix, oil_prices, multiples } = result;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: "0.82rem", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ padding: "0.4rem 0.6rem", textAlign: "left", color: "#6b7280", fontWeight: 500, borderBottom: "1px solid #e5e7eb" }}>
              Oil $/bbl ↓ · Multiple →
            </th>
            {multiples.map((m) => (
              <th
                key={m}
                style={{
                  padding: "0.4rem 0.6rem",
                  textAlign: "right",
                  fontWeight: CORE_MULTIPLES.has(m) ? 600 : 400,
                  color: CORE_MULTIPLES.has(m) ? "#1e40af" : "#6b7280",
                  borderBottom: "1px solid #e5e7eb",
                  background: CORE_MULTIPLES.has(m) ? "#eff6ff" : "transparent",
                }}
              >
                {m}×
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {oil_prices.map((price, pi) => {
            const isCoreRow = CORE_PRICES.has(price);
            return (
              <tr key={price} style={{ background: isCoreRow ? "#fafafa" : "transparent" }}>
                <td style={{
                  padding: "0.4rem 0.6rem",
                  fontWeight: isCoreRow ? 600 : 400,
                  color: isCoreRow ? "#111827" : "#374151",
                  borderBottom: "1px solid #f3f4f6",
                  whiteSpace: "nowrap",
                }}>
                  ${price}/bbl
                </td>
                {multiples.map((m, mi) => {
                  const val = matrix[pi][mi];
                  const isCore = CORE_MULTIPLES.has(m) && isCoreRow;
                  return (
                    <td
                      key={m}
                      style={{
                        padding: "0.4rem 0.6rem",
                        textAlign: "right",
                        fontWeight: isCore ? 700 : 400,
                        color: isCore ? "#1e3a8a" : "#374151",
                        background: isCore ? "#dbeafe" : CORE_MULTIPLES.has(m) ? "#eff6ff" : "transparent",
                        borderBottom: "1px solid #f3f4f6",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fmtK(val)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ fontSize: "0.75rem", color: "#9ca3af", margin: "0.5rem 0 0", lineHeight: 1.4 }}>
        Highlighted column = 5×–12× range · Highlighted rows = $65–$75/bbl core price band
      </p>
    </div>
  );
}

function ResultView({ result }: { result: OfferCalculatorResult }) {
  const isUndeveloped =
    result.suggested_offer_low < result.annual_royalty_at_70 * 5;

  return (
    <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      {/* Summary strip */}
      <div className="card" style={{ maxWidth: 680, background: "#f0f9ff", border: "1px solid #bae6fd" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem" }}>
          <div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Suggested Offer</div>
            <div style={{ fontSize: "1.15rem", fontWeight: 700, color: "#0c4a6e" }}>
              {fmt(result.suggested_offer_low)} – {fmt(result.suggested_offer_high)}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginTop: "0.15rem" }}>
              {isUndeveloped ? "3×–6× annual royalty @ $70" : "5×–10× annual royalty @ $70"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>$/NMA</div>
            <div style={{ fontSize: "1.15rem", fontWeight: 700, color: "#0c4a6e" }}>
              {fmt(result.dollar_per_nma_low)} – {fmt(result.dollar_per_nma_high)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Est. Monthly Royalty</div>
            <div style={{ fontSize: "1.15rem", fontWeight: 700, color: "#0c4a6e" }}>
              {fmt(result.monthly_royalty_at_70)}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginTop: "0.15rem" }}>@ $70/bbl benchmark</div>
          </div>
          <div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginBottom: "0.2rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Activity Tier</div>
            <div style={{ fontSize: "1.15rem", fontWeight: 700, color: "#0c4a6e", textTransform: "capitalize" }}>
              {result.activity_level}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#0369a1", marginTop: "0.15rem" }}>
              ~{result.bopd_lo.toFixed(2)}–{result.bopd_hi.toFixed(2)} BOPD est.
            </div>
          </div>
        </div>
      </div>

      {/* Sensitivity table */}
      <div className="card" style={{ maxWidth: 680 }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.6rem" }}>
          Offer Sensitivity — Implied Price by Oil Price × Royalty Multiple
        </h2>
        <SensitivityTable result={result} />
      </div>

      {/* Caveats */}
      <div className="card" style={{ maxWidth: 680, background: "#fffbeb", border: "1px solid #fde68a" }}>
        <h3 style={{ fontSize: "0.85rem", fontWeight: 600, color: "#92400e", marginBottom: "0.4rem" }}>
          ⚠ Directional estimate — not an appraisal
        </h3>
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", color: "#78350f", lineHeight: 1.5 }}>
          {result.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      </div>
    </div>
  );
}

export default function OfferCalculatorPage() {
  const [nma, setNma]           = useState("");
  const [royalty, setRoyalty]   = useState("");
  const [dealType, setDealType] = useState("producing");
  const [activity, setActivity] = useState("");
  const [county, setCounty]     = useState("");
  const [state, setState]       = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [result, setResult]     = useState<OfferCalculatorResult | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const nmaVal = parseFloat(nma.replace(/,/g, ""));
    if (!nma.trim() || isNaN(nmaVal) || nmaVal <= 0) {
      setError("NMA must be a positive number.");
      return;
    }

    const rr = parseRoyaltyRate(royalty);
    if (rr == null || rr <= 0 || rr > 0.5) {
      setError("Enter a valid royalty rate (e.g. 3/16, 18.75%, or 0.1875).");
      return;
    }

    const activityVal = (activity.trim() || undefined) as
      | "high" | "moderate" | "low" | "unknown" | undefined;

    const res = buildOfferScenarios({
      nma: nmaVal,
      royalty_rate: rr,
      deal_type: dealType || null,
      activity_level: activityVal ?? null,
      county: county.trim() || null,
      state: state.trim() || null,
    });

    setResult(res);
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Offer Calculator</h1>
        <p>Generate a directional offer range and sensitivity table from NMA, royalty rate, and basin activity.</p>
      </div>

      <div className="card" style={{ maxWidth: 560 }}>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.9rem", color: "#555", marginBottom: "0.3rem" }}>
                NMA <span style={{ color: "#e53e3e" }}>*</span>
              </label>
              <input
                type="text"
                value={nma}
                onChange={(e) => setNma(e.target.value)}
                placeholder="e.g. 160"
                style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.9rem", color: "#555", marginBottom: "0.3rem" }}>
                Royalty rate <span style={{ color: "#e53e3e" }}>*</span>
              </label>
              <input
                type="text"
                value={royalty}
                onChange={(e) => setRoyalty(e.target.value)}
                placeholder="e.g. 3/16 or 18.75%"
                style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.9rem", color: "#555", marginBottom: "0.3rem" }}>Deal type</label>
              <select
                value={dealType}
                onChange={(e) => setDealType(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem", background: "white" }}
              >
                <option value="producing">Producing</option>
                <option value="undeveloped">Undeveloped</option>
                <option value="lease">Lease</option>
                <option value="mineral_deed">Mineral Deed</option>
                <option value="mixed">Mixed</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.9rem", color: "#555", marginBottom: "0.3rem" }}>
                Activity level <span style={{ fontSize: "0.8rem", color: "#888" }}>(opt)</span>
              </label>
              <select
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem", background: "white" }}
              >
                <option value="">Auto (from county)</option>
                <option value="high">High</option>
                <option value="moderate">Moderate</option>
                <option value="low">Low</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.9rem", color: "#555", marginBottom: "0.3rem" }}>
                County <span style={{ fontSize: "0.8rem", color: "#888" }}>(opt)</span>
              </label>
              <input
                type="text"
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                placeholder="e.g. McKenzie"
                style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.9rem", color: "#555", marginBottom: "0.3rem" }}>
                State <span style={{ fontSize: "0.8rem", color: "#888" }}>(opt)</span>
              </label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="e.g. ND"
                style={{ width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem" }}
              />
            </div>
          </div>

          {error ? <p style={{ color: "#dc2626", fontSize: "0.88rem", margin: 0 }}>{error}</p> : null}

          <button
            type="submit"
            className="btn btnPrimary"
            style={{ alignSelf: "flex-start" }}
          >
            Calculate Offer Range
          </button>
        </form>
      </div>

      {result ? <ResultView result={result} /> : null}
    </div>
  );
}
