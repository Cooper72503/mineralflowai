"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { DealValuationOutput } from "@/lib/valuation";
import type { LegalDescriptionParseResult } from "@/lib/location/legal-description-parser";
import type { LocationContext } from "@/lib/location/location-context";

const EM_DASH = "—";

type ScreenResult = {
  county: string | null;
  state: string | null;
  acreage: number | null;
  legal_description_parsed: LegalDescriptionParseResult;
  location_context: LocationContext;
  valuation: DealValuationOutput;
};

function formatUsdCompact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1_000_000 ? 2 : 0,
  }).format(n);
}

function formatUsdRange(min?: number | null, max?: number | null): string {
  if (min == null || max == null) return EM_DASH;
  if (Math.abs(min - max) < 1e-6) return formatUsdCompact(min);
  return `${formatUsdCompact(min)}–${formatUsdCompact(max)}`;
}

function recBadge(r: DealValuationOutput["recommendation"]): { background: string; color: string; borderColor: string } {
  if (r === "PURSUE") return { background: "#dcfce7", color: "#166534", borderColor: "#86efac" };
  if (r === "PASS") return { background: "#fee2e2", color: "#991b1b", borderColor: "#fecaca" };
  return { background: "#fef9c3", color: "#854d0e", borderColor: "#fde047" };
}

function confBadge(c: DealValuationOutput["confidence"]): { background: string; color: string; borderColor: string } {
  if (c === "high") return { background: "#dbeafe", color: "#1e40af", borderColor: "#93c5fd" };
  if (c === "medium") return { background: "#f3f4f6", color: "#374151", borderColor: "#e5e7eb" };
  return { background: "#fafafa", color: "#6b7280", borderColor: "#e5e7eb" };
}

function ValuationResult({ result }: { result: ScreenResult }) {
  const v = result.valuation;
  const rec = recBadge(v.recommendation);
  const conf = confBadge(v.confidence);
  const confReason = v.confidence_reasoning;
  const reasoning = v.reasoning ?? [];
  const risks = v.risks ?? [];
  const missingData = v.missing_data ?? [];

  return (
    <div style={{ marginTop: "2rem" }}>
      {/* Resolved fields */}
      <div className="card" style={{ maxWidth: 560, marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.6rem" }}>Resolved inputs</h2>
        <dl style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>County</dt>
            <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.county ?? EM_DASH}</dd>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>State</dt>
            <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.state ?? EM_DASH}</dd>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Acreage</dt>
            <dd style={{ fontSize: "0.85rem", margin: 0 }}>
              {result.acreage != null ? `${result.acreage} acres` : EM_DASH}
            </dd>
          </div>
          {(result.legal_description_parsed.plss_township || result.legal_description_parsed.section) && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>PLSS parsed</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>
                {[
                  result.legal_description_parsed.plss_aliquot,
                  result.legal_description_parsed.section ? `Section ${result.legal_description_parsed.section}` : null,
                  result.legal_description_parsed.plss_township ? `T${result.legal_description_parsed.plss_township}` : null,
                  result.legal_description_parsed.plss_range ? `R${result.legal_description_parsed.plss_range}` : null,
                ].filter(Boolean).join(", ")}
              </dd>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Activity area</dt>
            <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.location_context.approximate_area}</dd>
          </div>
        </dl>
      </div>

      {/* Valuation card */}
      <div className="card" style={{ maxWidth: 560 }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Pre-Underwriting Valuation
        </h2>
        <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0 0 0.75rem", lineHeight: 1.45 }}>
          Directional first-pass screening only — not an appraisal, title opinion, or reserve report.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <span style={{
            display: "inline-block", fontSize: "0.75rem", fontWeight: 600,
            padding: "0.2rem 0.55rem", borderRadius: 6,
            border: `1px solid ${rec.borderColor}`, background: rec.background, color: rec.color,
          }}>
            {v.recommendation}
          </span>
          <span style={{
            display: "inline-block", fontSize: "0.75rem", fontWeight: 600,
            padding: "0.2rem 0.55rem", borderRadius: 6,
            border: `1px solid ${conf.borderColor}`, background: conf.background, color: conf.color,
          }}>
            Confidence: {v.confidence}
          </span>
          <span style={{ fontSize: "0.85rem", color: "#374151", alignSelf: "center" }}>
            Deal type: {v.deal_type.replace(/_/g, " ")} · Activity: {v.activity_level}
          </span>
        </div>

        {confReason && (confReason.summary || (confReason.present_signals?.length ?? 0) > 0 || (confReason.missing_signals?.length ?? 0) > 0) ? (
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>Confidence reasoning</div>
            {confReason.summary ? (
              <p style={{ fontSize: "0.82rem", color: "#4b5563", margin: "0 0 0.5rem", lineHeight: 1.45 }}>
                {confReason.summary}
              </p>
            ) : null}
            {(confReason.present_signals?.length ?? 0) > 0 ? (
              <div style={{ marginBottom: "0.35rem" }}>
                <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "0.15rem" }}>Present signals</div>
                <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "#374151", lineHeight: 1.4 }}>
                  {(confReason.present_signals ?? []).map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(confReason.missing_signals?.length ?? 0) > 0 ? (
              <div>
                <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "0.15rem" }}>Missing or weak signals</div>
                <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "#6b7280", lineHeight: 1.4 }}>
                  {(confReason.missing_signals ?? []).map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <dl style={{ display: "flex", flexDirection: "column", gap: "0.65rem", marginBottom: "0.75rem" }}>
          <div>
            <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Estimated total value (range)</dt>
            <dd style={{ fontSize: "0.95rem", margin: 0 }}>
              {formatUsdRange(v.estimated_total_value_low, v.estimated_total_value_high)}
              {v.estimated_total_value_low == null && v.estimated_total_value_high == null ? (
                <span style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", marginTop: "0.25rem" }}>
                  No directional dollar band from available inputs — use missing data list and manual diligence.
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Value per acre (range)</dt>
            <dd style={{ fontSize: "0.95rem", margin: 0 }}>
              {formatUsdRange(v.value_per_acre_low, v.value_per_acre_high)}
            </dd>
          </div>
          {v.nri != null && Number.isFinite(v.nri) ? (
            <div>
              <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Estimated NRI Proxy</dt>
              <dd style={{ fontSize: "0.95rem", margin: 0 }}>
                {String(v.nri)}
                {v.nri_basis ? (
                  <span style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", marginTop: "0.25rem" }}>
                    {v.nri_basis}
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        <p style={{ color: "#111827", fontSize: "0.92rem", lineHeight: 1.5, margin: "0 0 0.75rem" }}>{v.summary}</p>

        {reasoning.length > 0 ? (
          <div style={{ marginBottom: "0.65rem" }}>
            <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>Reasoning</div>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem", color: "#374151", lineHeight: 1.45 }}>
              {reasoning.map((line, idx) => <li key={idx}>{line}</li>)}
            </ul>
          </div>
        ) : null}

        {risks.length > 0 ? (
          <div style={{ marginBottom: "0.65rem" }}>
            <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>Risks & limitations</div>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem", color: "#6b7280", lineHeight: 1.45 }}>
              {risks.map((line, idx) => <li key={idx}>{line}</li>)}
            </ul>
          </div>
        ) : null}

        {missingData.length > 0 ? (
          <div>
            <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>Missing data</div>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.85rem", color: "#6b7280", lineHeight: 1.45 }}>
              {missingData.map((line, idx) => <li key={idx}>{line}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function QuickScreenPage() {
  const [legalDescription, setLegalDescription] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [acreage, setAcreage] = useState("");
  const [royaltyRate, setRoyaltyRate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScreenResult | null>(null);

  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const trimmed = legalDescription.trim();
    if (!trimmed) {
      setError("Legal description is required.");
      return;
    }

    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch("/api/screen", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          legal_description: trimmed,
          county: county.trim() || undefined,
          state: state.trim() || undefined,
          acreage: acreage.trim() ? parseFloat(acreage.trim().replace(/,/g, "")) : undefined,
          royalty_rate: royaltyRate.trim() || undefined,
        }),
      });

      const body = await res.json() as { ok: boolean; error?: string } & Partial<ScreenResult>;
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Screening failed. Please try again.");
        return;
      }

      setResult(body as ScreenResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Quick Screen</h1>
        <p>Paste a legal description to get an instant pre-underwriting read — no file upload needed.</p>
      </div>

      <div className="card" style={{ maxWidth: 560, marginBottom: "1.5rem" }}>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div>
            <label htmlFor="qs-legal" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              Legal description <span style={{ color: "#e53e3e" }}>*</span>
            </label>
            <textarea
              id="qs-legal"
              value={legalDescription}
              onChange={(e) => setLegalDescription(e.target.value)}
              rows={5}
              placeholder={"e.g. SE/4 of Section 12, Township 140 North, Range 94 West, Mountrail County, North Dakota\nor: Abstract 1234, John Smith Survey, Midland County, Texas"}
              style={{
                width: "100%", boxSizing: "border-box", padding: "0.5rem 0.6rem",
                border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem",
                fontFamily: "inherit", resize: "vertical", lineHeight: 1.5,
              }}
              disabled={loading}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="qs-county" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                County <span style={{ fontSize: "0.8rem", color: "#888" }}>(optional)</span>
              </label>
              <input
                id="qs-county"
                type="text"
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                placeholder="e.g. Mountrail County"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem",
                  border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem",
                }}
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="qs-state" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                State <span style={{ fontSize: "0.8rem", color: "#888" }}>(optional)</span>
              </label>
              <input
                id="qs-state"
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="e.g. North Dakota"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem",
                  border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem",
                }}
                disabled={loading}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="qs-acreage" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                Acreage / NMA <span style={{ fontSize: "0.8rem", color: "#888" }}>(optional)</span>
              </label>
              <input
                id="qs-acreage"
                type="text"
                value={acreage}
                onChange={(e) => setAcreage(e.target.value)}
                placeholder="e.g. 160"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem",
                  border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem",
                }}
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="qs-royalty" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                Royalty rate <span style={{ fontSize: "0.8rem", color: "#888" }}>(optional)</span>
              </label>
              <input
                id="qs-royalty"
                type="text"
                value={royaltyRate}
                onChange={(e) => setRoyaltyRate(e.target.value)}
                placeholder="e.g. 3/16 or 18.75%"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem",
                  border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem",
                }}
                disabled={loading}
              />
            </div>
          </div>

          {error ? (
            <p style={{ color: "#dc2626", fontSize: "0.88rem", margin: 0 }}>{error}</p>
          ) : null}

          <button
            type="submit"
            className="btn btnPrimary"
            disabled={loading || !legalDescription.trim()}
            style={{ alignSelf: "flex-start" }}
          >
            {loading ? "Screening…" : "Run Quick Screen"}
          </button>
        </form>
      </div>

      {result ? <ValuationResult result={result} /> : null}
    </div>
  );
}
