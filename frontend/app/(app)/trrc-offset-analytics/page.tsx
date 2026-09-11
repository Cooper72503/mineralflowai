"use client";

/**
 * Offset Analytics — standalone pre-drill tool.
 *
 * The real engine (lib/trrc/offset-analytics/service.ts's
 * runOffsetAnalytics) already runs today, but only as PDF Section 9 of a
 * completed due-diligence run, with no UI surface of its own. This page
 * exposes it directly: enter a real Texas legal description, get a real
 * formation-matched analog set, a real composite type curve, and a real
 * ownership-resolved (royalty vs. working-interest, never NMA-only) proxy
 * valuation — for any tract, not a fixed demo set.
 *
 * Static, dense, numbers-first. No animation, no play controls — per
 * feedback_enterprise_visual_design, this reads as an analytical workbench,
 * not a presentation.
 */

import { useState } from "react";
import { COLORS as C } from "./colors";
import type { OffsetAnalyticsPayload, LegalDescription } from "@/lib/trrc/offset-analytics";

interface FormState {
  legalDescriptionText: string;
  subjectState: string;
  grossAcres: string;
  netMineralAcres: string;
  ownershipType: "UNKNOWN" | "ROYALTY_INTEREST" | "WORKING_INTEREST";
  mineralFraction: string;
  leaseRoyaltyFraction: string;
  netRevenueInterest: string;
  workingInterest: string;
  subjectFieldName: string;
  subjectLateralLengthFt: string;
  subjectCompletionYear: string;
  subjectTvdFt: string;
  radiusMiles: "2" | "5" | "10";
  distanceMode: "CENTROID_TO_WELL" | "TRACT_BOUNDARY_TO_WELL";
}

const EMPTY_FORM: FormState = {
  legalDescriptionText: "",
  subjectState: "",
  grossAcres: "",
  netMineralAcres: "",
  ownershipType: "UNKNOWN",
  mineralFraction: "",
  leaseRoyaltyFraction: "",
  netRevenueInterest: "",
  workingInterest: "",
  subjectFieldName: "",
  subjectLateralLengthFt: "",
  subjectCompletionYear: "",
  subjectTvdFt: "",
  radiusMiles: "5",
  distanceMode: "CENTROID_TO_WELL",
};

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
function legalDescriptionSummary(d: LegalDescription): string {
  if (d.jurisdiction === "TX_LAND_GRID") {
    return [d.surveyName ? `${d.surveyName} Survey` : null, d.canonicalAbstractNumber, d.county ? `${d.county} County, Texas` : null].filter(Boolean).join(", ") || "—";
  }
  if (d.jurisdiction === "PLSS") {
    return `T${d.townshipNumber}${d.townshipDirection}, R${d.rangeNumber}${d.rangeDirection}, Sec. ${d.section}, ${d.state}`;
  }
  return `Unparsed — "${d.rawText}"`;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", borderRadius: 6, border: `1px solid ${C.border}`,
  background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
  color: C.textMuted, marginBottom: 6,
};
const fieldWrap: React.CSSProperties = { marginBottom: 14 };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={fieldWrap}><label style={labelStyle}>{label}</label>{children}</div>;
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, minWidth: 140, padding: "12px 14px", background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: C.textMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase", color: C.text, marginBottom: 10, marginTop: 22, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>{children}</div>;
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: `1px solid ${C.border}`, fontSize: 12.5 }}>
      <span style={{ color: C.textMuted }}>{k}</span>
      <span style={{ color: C.text, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}

export default function OffsetAnalyticsToolPage() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OffsetAnalyticsPayload | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.legalDescriptionText.trim()) {
      setError("Enter a legal description to run analog analytics.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    // Built explicitly, not spread — keeps this in sync with what the API
    // route actually accepts rather than silently forwarding stray form
    // state, same discipline as trrc-due-diligence's intake form.
    const payload = {
      legalDescriptionText: form.legalDescriptionText.trim(),
      subjectState: form.subjectState.trim() || undefined,
      grossAcres: form.grossAcres || undefined,
      netMineralAcres: form.netMineralAcres || undefined,
      ownershipType: form.ownershipType,
      mineralFraction: form.ownershipType === "ROYALTY_INTEREST" ? (form.mineralFraction || undefined) : undefined,
      leaseRoyaltyFraction: form.ownershipType === "ROYALTY_INTEREST" ? (form.leaseRoyaltyFraction || undefined) : undefined,
      netRevenueInterest: form.ownershipType === "WORKING_INTEREST" ? (form.netRevenueInterest || undefined) : undefined,
      workingInterest: form.ownershipType === "WORKING_INTEREST" ? (form.workingInterest || undefined) : undefined,
      subjectFieldName: form.subjectFieldName.trim() || undefined,
      subjectLateralLengthFt: form.subjectLateralLengthFt || undefined,
      subjectCompletionYear: form.subjectCompletionYear || undefined,
      subjectTvdFt: form.subjectTvdFt || undefined,
      radiusMiles: form.radiusMiles,
      distanceMode: form.distanceMode,
    };

    try {
      const res = await fetch("/api/trrc/offset-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Offset analytics run failed.");
        return;
      }
      setResult(json.data as OffsetAnalyticsPayload);
    } catch {
      setError("Request failed — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  const notCalculated = result && result.validationStatus === "INVALID";
  const nonInfoWarnings = result ? result.warnings.filter((w) => w.severity !== "info") : [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "32px 24px 64px" }}>

        <div style={{ marginBottom: 20, paddingBottom: 14, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textFaint, marginBottom: 6 }}>
            Pre-Drill Analytics
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0, color: C.text }}>Offset Analytics</h1>
          <p style={{ fontSize: 13, color: C.textMuted, marginTop: 8, maxWidth: 640, lineHeight: 1.5 }}>
            Analog-well production and ownership-resolved proxy valuation for any real Texas tract — evidence-first,
            never a fixed demo set. Enter a legal description below; every analog well, formation match, and warning
            shown is real and independently sourced from TRRC.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <Field label="Legal description (required)">
            <textarea
              value={form.legalDescriptionText}
              onChange={(e) => update("legalDescriptionText", e.target.value)}
              placeholder='e.g. "John Smith Survey, Abstract 693, McLennan County, Texas" — or a Township-Range-Section (PLSS) description with a state code below'
              rows={2}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>

          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            style={{ background: "none", border: "none", color: C.accent, fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: showAdvanced ? 14 : 6 }}
          >
            {showAdvanced ? "− Hide advanced options" : "+ Advanced options (ownership, formation, lateral length, radius)"}
          </button>

          {showAdvanced && (
            <div style={{ padding: 16, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                <Field label="State (PLSS only)"><input style={inputStyle} value={form.subjectState} onChange={(e) => update("subjectState", e.target.value)} maxLength={2} placeholder="TX" /></Field>
                <Field label="Gross acres"><input style={inputStyle} value={form.grossAcres} onChange={(e) => update("grossAcres", e.target.value)} inputMode="decimal" /></Field>
                <Field label="Net mineral acres"><input style={inputStyle} value={form.netMineralAcres} onChange={(e) => update("netMineralAcres", e.target.value)} inputMode="decimal" /></Field>
              </div>

              <Field label="Ownership type">
                <select style={inputStyle} value={form.ownershipType} onChange={(e) => update("ownershipType", e.target.value as FormState["ownershipType"])}>
                  <option value="UNKNOWN">Unknown — gross tract proxy only</option>
                  <option value="ROYALTY_INTEREST">Royalty / mineral owner</option>
                  <option value="WORKING_INTEREST">Working interest / operator</option>
                </select>
              </Field>

              {form.ownershipType === "ROYALTY_INTEREST" && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
                  <Field label="Mineral fraction (0–1)"><input style={inputStyle} value={form.mineralFraction} onChange={(e) => update("mineralFraction", e.target.value)} placeholder="0.125" inputMode="decimal" /></Field>
                  <Field label="Lease royalty fraction (0–1)"><input style={inputStyle} value={form.leaseRoyaltyFraction} onChange={(e) => update("leaseRoyaltyFraction", e.target.value)} placeholder="0.1875" inputMode="decimal" /></Field>
                </div>
              )}
              {form.ownershipType === "WORKING_INTEREST" && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
                  <Field label="Net revenue interest (0–1)"><input style={inputStyle} value={form.netRevenueInterest} onChange={(e) => update("netRevenueInterest", e.target.value)} placeholder="0.78" inputMode="decimal" /></Field>
                  <Field label="Working interest (0–1)"><input style={inputStyle} value={form.workingInterest} onChange={(e) => update("workingInterest", e.target.value)} placeholder="1.0" inputMode="decimal" /></Field>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                <Field label="Target formation"><input style={inputStyle} value={form.subjectFieldName} onChange={(e) => update("subjectFieldName", e.target.value)} placeholder="e.g. Wolfcamp A" /></Field>
                <Field label="Lateral length (ft)"><input style={inputStyle} value={form.subjectLateralLengthFt} onChange={(e) => update("subjectLateralLengthFt", e.target.value)} inputMode="decimal" /></Field>
                <Field label="Completion year"><input style={inputStyle} value={form.subjectCompletionYear} onChange={(e) => update("subjectCompletionYear", e.target.value)} inputMode="numeric" /></Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
                <Field label="TVD (ft)"><input style={inputStyle} value={form.subjectTvdFt} onChange={(e) => update("subjectTvdFt", e.target.value)} inputMode="decimal" /></Field>
                <Field label="Search radius">
                  <select style={inputStyle} value={form.radiusMiles} onChange={(e) => update("radiusMiles", e.target.value as FormState["radiusMiles"])}>
                    <option value="2">2 mi</option><option value="5">5 mi</option><option value="10">10 mi</option>
                  </select>
                </Field>
                <Field label="Distance mode">
                  <select style={inputStyle} value={form.distanceMode} onChange={(e) => update("distanceMode", e.target.value as FormState["distanceMode"])}>
                    <option value="CENTROID_TO_WELL">Centroid to well</option>
                    <option value="TRACT_BOUNDARY_TO_WELL">Tract boundary to well</option>
                  </select>
                </Field>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "10px 20px", borderRadius: 6, border: `1px solid ${C.accent}`,
              background: loading ? C.accentDim : C.accent, color: loading ? C.accent : "#0b0d12",
              fontSize: 13, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Running…" : "Run offset analytics"}
          </button>
        </form>

        {loading && (
          <div style={{ marginTop: 20, padding: 14, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12.5, color: C.textMuted }}>
            Running analog search — geocoding the tract, searching offset wells, and pulling real production for up
            to 15 qualified analogs. This is a live, multi-request TRRC operation and can take a few minutes for a
            well-developed area. Do not close this tab.
          </div>
        )}

        {error && (
          <div style={{ marginTop: 20, padding: 14, background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 8, fontSize: 13, color: C.text }}>
            {error}
          </div>
        )}

        {result && notCalculated && (
          <div style={{ marginTop: 20, padding: 14, background: C.yellowDim, border: `1px solid ${C.yellow}`, borderRadius: 8, fontSize: 13, color: C.text }}>
            Offset analytics not calculated: the tract could not be mapped with sufficient confidence, or no
            qualified producing analogs were identified within the search radius. Geocode match method:{" "}
            <b>{result.geocode.matchMethod}</b> · {result.search.candidatesFound} candidate well(s) found within{" "}
            {result.search.radiusMiles} mi.
          </div>
        )}

        {result && !notCalculated && (
          <div>
            <SectionTitle>Subject Tract</SectionTitle>
            <KV k="Legal description used" v={legalDescriptionSummary(result.subjectAsset.legalDescription)} />
            <KV k="Geocode match" v={`${result.geocode.matchMethod} — source ${result.geocode.sourceProvider}, confidence ${pct(result.geocode.confidence)}`} />
            <KV k="Tract boundary precision" v={result.geocode.geometryType === "Polygon" || result.geocode.geometryType === "MultiPolygon" ? "Real surveyed tract polygon" : "Centroid point only — no tract polygon available"} />
            <KV k="Search radius" v={`${result.search.radiusMiles} mi (${result.search.distanceMode === "TRACT_BOUNDARY_TO_WELL" ? "tract boundary to well" : "centroid to well"})`} />

            <SectionTitle>Analog Wells ({result.analogWells.length} qualified of {result.search.candidatesFound} found)</SectionTitle>
            {result.analogWells.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted }}>No qualified analogs — see warnings below.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      {["API", "Distance", "Formation", "Score", "Decline fit (qi / Di / b)"].map((h, i) => (
                        <th key={h} style={{ textAlign: i >= 3 ? "right" : "left", padding: "8px 10px", borderBottom: `1px solid ${C.border}`, color: C.textMuted, fontWeight: 600, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.analogWells.map((a) => (
                      <tr key={a.api}>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, fontVariantNumeric: "tabular-nums" }}>{a.api}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, fontVariantNumeric: "tabular-nums" }}>{a.distanceMiles.toFixed(2)} mi</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}` }}>{a.canonicalFormation || "—"}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{a.analogScore.toFixed(0)}</td>
                        <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {a.declineFit ? `${Math.round(a.declineFit.qiOilBblPerMonth)} / ${(a.declineFit.diNominalMonthly * 100).toFixed(1)}% / ${a.declineFit.bFactor.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <SectionTitle>Composite Analog Profile</SectionTitle>
            {result.compositeProfile ? (
              <div>
                <KV k="Method" v={result.compositeProfile.method === "NORMALIZED_TYPE_CURVE_P50" ? "Normalized type curve (P50 baseline)" : "Median parameter aggregation"} />
                <KV k="Analog count used" v={String(result.compositeProfile.analogCount)} />
                <KV k="Median initial rate (qi)" v={result.compositeProfile.oil.qiBblPerMonth !== null ? `${Math.round(result.compositeProfile.oil.qiBblPerMonth).toLocaleString("en-US")} BBL/mo` : "—"} />
                <KV k="Median technical EUR" v={result.compositeProfile.oil.technicalEurBbl !== null ? `${Math.round(result.compositeProfile.oil.technicalEurBbl).toLocaleString("en-US")} BBL` : "—"} />
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>No composite profile — insufficient QC-passed decline fits among selected analogs.</div>
            )}

            <SectionTitle>Development Case &amp; Proxy Valuation</SectionTitle>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <StatBox label="Unrisked PV-10" value={result.economics ? fmtUsd(result.economics.unriskedPv10) : "—"} />
              <StatBox label="Risked PV-10" value={result.economics ? fmtUsd(result.economics.riskedPv10) : "—"} />
              <StatBox label="Probability of development" value={pct(result.developmentCase.probabilityOfDevelopment)} />
            </div>
            {result.economics ? (
              <div style={{ fontSize: 13, color: result.economics.valuationType === "GROSS_TRACT_PROXY_PV10" ? C.yellow : C.text, lineHeight: 1.5 }}>
                <b>Valuation type: {result.economics.valuationType}</b>
                {result.economics.valuationType === "GROSS_TRACT_PROXY_PV10"
                  ? " — a gross-tract proxy value, NOT an owner-level interest valuation (no verified ownership fraction was supplied above)."
                  : "."}{" "}
                Development case: {result.developmentCase.caseType === "SINGLE_WELL_PROXY" ? "single proxy well" : `${result.developmentCase.wellCount} configured wells`}.
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>No proxy valuation computed — see composite profile and warnings.</div>
            )}

            <SectionTitle>Confidence &amp; Key Warnings</SectionTitle>
            <KV k="Overall confidence" v={result.confidence.overall} />
            {nonInfoWarnings.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>No material warnings.</div>
            ) : (
              <div style={{ marginTop: 8 }}>
                {nonInfoWarnings.map((w, i) => (
                  <div key={i} style={{ fontSize: 12.5, color: w.severity === "critical" ? C.red : C.yellow, marginBottom: 4 }}>• {w.message}</div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 24, paddingTop: 14, borderTop: `1px solid ${C.border}`, fontSize: 11.5, color: C.textFaint, lineHeight: 1.6 }}>
              Screening-grade analog estimate based on nearby producing wells. Not a reserve report, title opinion,
              drilling recommendation, or guarantee of future production. Run ID: {result.analysisId}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
