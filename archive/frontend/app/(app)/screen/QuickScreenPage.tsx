"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import type { DealValuationOutput } from "@/lib/valuation";
import type { LegalDescriptionParseResult } from "@/lib/location/legal-description-parser";
import type { LocationContext } from "@/lib/location/location-context";
import type { ProductionSnapshot } from "@/lib/production/production-snapshot";
import type { ParcelLookupResult } from "@/lib/parcels";
import type { DealBrief } from "@/lib/intelligence/deal-brief";
import { ProductionSnapshotCard } from "@/app/components/ProductionSnapshotCard";
import { DealBriefCard } from "@/app/components/DealBriefCard";
import { ParcelMapCard } from "@/app/components/ParcelMapCard";
import { NearbyWellsCard } from "@/app/components/NearbyWellsCard";
import { DeclineAnalysisCard } from "@/app/components/DeclineAnalysisCard";
import { OperatingEconomicsCard } from "@/app/components/OperatingEconomicsCard";
import { RiskFlagsCard } from "@/app/components/RiskFlagsCard";
import { ProductionHistoryTable } from "@/app/components/ProductionHistoryTable";
import { OfferCalculatorCard } from "@/app/components/OfferCalculatorCard";
import type { NearbyWellIntelligence } from "@/lib/wells/nearby-wells";
import type { DeclineCurveResult } from "@/lib/decline/decline-curve";
import type { MineralEconomicsResult } from "@/lib/economics/mineral-economics";
import type { RiskFlagsResult } from "@/lib/risk/risk-flags";
import type { PaLiabilityResult } from "@/lib/risk/pa-liability";
import type { ScreenResultPdfData } from "@/app/components/ScreenResultPdf";
import { normalizeRoyaltyToDecimal } from "@/lib/valuation/normalize";

// PdfDownloadButton imports both PDFDownloadLink and ScreenResultPdfDocument
// in one module so they always load together — prevents white-screen crash
// that occurs when PDFDownloadLink receives a null document prop while the
// PDF component is still lazy-loading.
const PdfDownloadButton = dynamic(
  () => import("@/app/components/PdfDownloadButton").then((m) => m.PdfDownloadButton),
  { ssr: false, loading: () => null }
);

const EM_DASH = "—";

type ScreenResult = {
  county: string | null;
  state: string | null;
  acreage: number | null;
  royalty_rate?: string | null;
  legal_description_parsed: LegalDescriptionParseResult;
  location_context: LocationContext;
  valuation: DealValuationOutput;
  production_snapshot?: ProductionSnapshot | null;
  producing_status?: "yes" | "no" | "unknown";
  parcel_data?: ParcelLookupResult | null;
  deal_brief?: DealBrief | null;
  nearby_well_intelligence?: NearbyWellIntelligence | null;
  decline_analysis?: DeclineCurveResult | null;
  mineral_economics?: MineralEconomicsResult | null;
  risk_flags?: RiskFlagsResult | null;
  pa_liability?: PaLiabilityResult | null;
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

function ValuationResult({ result, clientProducing }: { result: ScreenResult; clientProducing: "yes" | "no" | "unknown" }) {
  const v = result.valuation;
  const rec = recBadge(v.recommendation);
  const conf = confBadge(v.confidence);
  const confReason = v.confidence_reasoning;
  const reasoning = v.reasoning ?? [];
  const risks = v.risks ?? [];
  const missingData = v.missing_data ?? [];

  const recColors = {
    PURSUE: { bg: "#dcfce7", border: "#16a34a", text: "#14532d", icon: "✓" },
    REVIEW: { bg: "#fef9c3", border: "#ca8a04", text: "#713f12", icon: "~" },
    PASS:   { bg: "#fee2e2", border: "#dc2626", text: "#7f1d1d", icon: "✗" },
  }[v.recommendation] ?? { bg: "#f3f4f6", border: "#9ca3af", text: "#374151", icon: "?" };

  const pdfData: ScreenResultPdfData = {
    county: result.county,
    state: result.state,
    acreage: result.acreage,
    royalty_rate: result.royalty_rate,
    producing_status: clientProducing,
    location_context: result.location_context,
    valuation: result.valuation,
    production_snapshot: result.production_snapshot,
    deal_brief: result.deal_brief,
    nearby_well_intelligence: result.nearby_well_intelligence,
    decline_analysis: result.decline_analysis,
    mineral_economics: result.mineral_economics,
    risk_flags: result.risk_flags,
    pa_liability: result.pa_liability,
    generatedAt: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
  };

  const pdfFileName = [
    result.county?.replace(/\s+/g, "-") ?? "screen",
    result.state ?? "",
    "MineralFlowAI",
  ].filter(Boolean).join("-") + ".pdf";

  return (
    <div style={{ marginTop: "2rem" }}>
      {/* Verdict banner */}
      <div style={{
        maxWidth: 560,
        marginBottom: "1rem",
        background: recColors.bg,
        border: `2px solid ${recColors.border}`,
        borderRadius: 12,
        padding: "1rem 1.25rem",
        display: "flex",
        alignItems: "center",
        gap: "1rem",
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: "50%",
          background: recColors.border,
          color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1.4rem", fontWeight: 900, flexShrink: 0,
        }}>
          {recColors.icon}
        </div>
        <div>
          <div style={{ fontSize: "1.3rem", fontWeight: 800, color: recColors.text, letterSpacing: "-0.01em" }}>
            {v.recommendation}
          </div>
          <div style={{ fontSize: "0.82rem", color: recColors.text, opacity: 0.85, marginTop: "0.1rem" }}>
            {v.recommendation === "PURSUE"
              ? "Strong signals — worth moving forward on diligence."
              : v.recommendation === "PASS"
              ? "Weak signals or high risk — likely not worth pursuing."
              : "Mixed signals — review carefully before committing."}
            {result.nearby_well_intelligence && result.nearby_well_intelligence.total_count > 0 && (
              <span style={{ display: "block", marginTop: "0.2rem", fontStyle: "italic", fontSize: "0.78rem" }}>
                Production inferred from {result.nearby_well_intelligence.total_count} nearby well
                {result.nearby_well_intelligence.total_count !== 1 ? "s" : ""}
                {result.nearby_well_intelligence.geocode_source !== "none"
                  ? ` within ${result.nearby_well_intelligence.radius_miles} mi`
                  : " in county"}
                {" "}— not confirmed on this tract.
              </span>
            )}
          </div>
        </div>
        {(v.point_estimate != null || (v.estimated_total_value_low != null && v.estimated_total_value_high != null)) && (
          <div style={{ marginLeft: "auto", textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: "0.72rem", color: recColors.text, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Est. Value{v.point_estimate_basis === "full_underwriting" ? " · Full Analysis" : v.point_estimate_basis === "bopd_anchored" ? " · Live Data" : ""}
            </div>
            <div style={{ fontSize: "1.05rem", fontWeight: 800, color: recColors.text }}>
              {v.point_estimate != null ? formatUsdCompact(v.point_estimate) : formatUsdRange(v.estimated_total_value_low, v.estimated_total_value_high)}
            </div>
            {v.point_estimate != null && v.estimated_total_value_low != null && v.estimated_total_value_high != null && (
              <div style={{ fontSize: "0.7rem", color: recColors.text, opacity: 0.65 }}>
                {formatUsdRange(v.estimated_total_value_low, v.estimated_total_value_high)} range
              </div>
            )}
          </div>
        )}
      </div>

      {/* PDF Download */}
      <div style={{ maxWidth: 560, marginBottom: "1rem", display: "flex", justifyContent: "flex-end" }}>
        <PdfDownloadButton data={pdfData} fileName={pdfFileName} />
      </div>

      {/* Nearby Well Intelligence */}
      {result.nearby_well_intelligence && (
        <div style={{ maxWidth: 680, marginTop: "0.5rem", marginBottom: "0.5rem" }}>
          <NearbyWellsCard data={result.nearby_well_intelligence} />
        </div>
      )}

      {/* Decline Curve Analysis */}
      {result.decline_analysis && (
        <div style={{ maxWidth: 680, marginBottom: "0.5rem" }}>
          <DeclineAnalysisCard data={result.decline_analysis} />
        </div>
      )}

      {/* Operating Economics */}
      {result.mineral_economics && (
        <div style={{ maxWidth: 680, marginBottom: "0.5rem" }}>
          <OperatingEconomicsCard data={result.mineral_economics} />
        </div>
      )}

      {/* Production Statement */}
      <div style={{ maxWidth: 680, marginBottom: "0.5rem" }}>
        <ProductionHistoryTable
          declineAnalysis={result.decline_analysis ?? null}
          nearbyWellIntelligence={result.nearby_well_intelligence ?? null}
          royaltyRate={normalizeRoyaltyToDecimal(result.royalty_rate)}
        />
      </div>

      {/* Risk Assessment */}
      {result.risk_flags && (
        <div style={{ maxWidth: 680, marginBottom: "0.5rem" }}>
          <RiskFlagsCard data={result.risk_flags} />
        </div>
      )}

      {/* Offer Calculator */}
      <div style={{ maxWidth: 680, marginBottom: "0.5rem" }}>
        <OfferCalculatorCard
          declineAnalysis={result.decline_analysis ?? null}
          nearbyWellIntelligence={result.nearby_well_intelligence ?? null}
          royaltyRate={normalizeRoyaltyToDecimal(result.royalty_rate)}
          acreage={result.acreage ?? null}
          activityLevel={(() => {
            const lvl = result.nearby_well_intelligence?.inferred_activity_level;
            if (lvl === "none" || lvl == null) return "unknown";
            return lvl as "high" | "moderate" | "low";
          })()}
          county={result.county ?? null}
          state={result.state ?? null}
        />
      </div>

      {/* Deal Brief */}
      {result.deal_brief && <DealBriefCard brief={result.deal_brief} />}

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
              {result.acreage != null ? (
                <>
                  {result.acreage} acres
                  {result.parcel_data?.source === "ohio_dnr" && result.parcel_data.acreage != null && (
                    <span style={{ fontSize: "0.75rem", color: "#6b7280", marginLeft: "0.4rem" }}>
                      (Ohio auditor)
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: "#d97706" }}>Not provided — add acreage for BOPD estimate</span>
              )}
            </dd>
          </div>
          {result.parcel_data?.source === "ohio_dnr" && result.parcel_data.owner && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Owner</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.parcel_data.owner}</dd>
            </div>
          )}
          {result.parcel_data?.source === "ohio_dnr" && result.parcel_data.property_class && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Property class</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.parcel_data.property_class}</dd>
            </div>
          )}
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
          {result.legal_description_parsed.civil_township && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Township</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.legal_description_parsed.civil_township}</dd>
            </div>
          )}
          {result.legal_description_parsed.parcel_id && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Parcel ID</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>{result.legal_description_parsed.parcel_id}</dd>
            </div>
          )}
          {result.legal_description_parsed.vms_survey_number && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Survey</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>
                Survey No. {result.legal_description_parsed.vms_survey_number}
                {result.legal_description_parsed.lot_number ? `, Lot ${result.legal_description_parsed.lot_number}` : ""}
              </dd>
            </div>
          )}
          {!result.legal_description_parsed.vms_survey_number && result.legal_description_parsed.lot_number && (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <dt style={{ fontSize: "0.82rem", color: "#6b7280", minWidth: 100 }}>Lot</dt>
              <dd style={{ fontSize: "0.85rem", margin: 0 }}>Lot {result.legal_description_parsed.lot_number}</dd>
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
            Signal Confidence: {v.confidence}
          </span>
          <span style={{ fontSize: "0.85rem", color: "#374151", alignSelf: "center" }}>
            Deal type: {v.deal_type.replace(/_/g, " ")} · Activity: {v.activity_level}
          </span>
        </div>

        {confReason && (confReason.summary || (confReason.present_signals?.length ?? 0) > 0 || (confReason.missing_signals?.length ?? 0) > 0) ? (
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.25rem" }}>What signals were found</div>
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

        {/* Point estimate — prominent single-value display */}
        {v.point_estimate != null && (
          <div style={{
            background: (v.point_estimate_basis === "full_underwriting" || v.point_estimate_basis === "bopd_anchored") ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${(v.point_estimate_basis === "full_underwriting" || v.point_estimate_basis === "bopd_anchored") ? "#86efac" : "#e2e8f0"}`,
            borderRadius: 10,
            padding: "0.85rem 1rem",
            marginBottom: "0.85rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
          }}>
            <div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" }}>
                Estimated Value
                {v.point_estimate_basis === "full_underwriting" && (
                  <span style={{ marginLeft: "0.4rem", color: "#16a34a", fontWeight: 600 }}>· Decline + economics + risk adjusted</span>
                )}
                {v.point_estimate_basis === "bopd_anchored" && (
                  <span style={{ marginLeft: "0.4rem", color: "#16a34a", fontWeight: 600 }}>· Anchored to nearby well data</span>
                )}
              </div>
              <div style={{ fontSize: "1.55rem", fontWeight: 800, color: "#0f172a", lineHeight: 1 }}>
                {formatUsdCompact(v.point_estimate)}
              </div>
              {v.estimated_total_value_low != null && v.estimated_total_value_high != null && (
                <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>
                  Range: {formatUsdRange(v.estimated_total_value_low, v.estimated_total_value_high)}
                </div>
              )}
            </div>
            {v.value_per_acre_low != null && v.value_per_acre_high != null && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" }}>Per Acre</div>
                <div style={{ fontSize: "1rem", fontWeight: 700, color: "#374151" }}>
                  {formatUsdCompact(Math.round((v.value_per_acre_low + v.value_per_acre_high) / 2))}
                </div>
                <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>
                  {formatUsdRange(v.value_per_acre_low, v.value_per_acre_high)} range
                </div>
              </div>
            )}
          </div>
        )}

        <dl style={{ display: "flex", flexDirection: "column", gap: "0.65rem", marginBottom: "0.75rem" }}>
          {v.point_estimate == null && (
            <div>
              <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Estimated total value</dt>
              <dd style={{ fontSize: "0.95rem", margin: 0 }}>
                {formatUsdRange(v.estimated_total_value_low, v.estimated_total_value_high)}
                {v.estimated_total_value_low == null && v.estimated_total_value_high == null ? (
                  <span style={{ display: "block", fontSize: "0.78rem", color: "#6b7280", marginTop: "0.25rem" }}>
                    No directional dollar estimate from available inputs — use missing data list and manual diligence.
                  </span>
                ) : null}
              </dd>
            </div>
          )}
          {v.point_estimate == null && (
            <div>
              <dt style={{ fontSize: "0.8rem", color: "#555", marginBottom: "0.2rem" }}>Value per acre</dt>
              <dd style={{ fontSize: "0.95rem", margin: 0 }}>
                {formatUsdRange(v.value_per_acre_low, v.value_per_acre_high)}
              </dd>
            </div>
          )}
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

      {/* Show snapshot when server returns one, OR when user explicitly said "no", OR when county is resolved */}
      {(result.production_snapshot || clientProducing === "no" || result.county) ? (
        <div style={{ maxWidth: 560, marginTop: "1rem" }}>
          {(clientProducing === "no" || result.producing_status === "no") && (
            <div style={{
              display: "flex", alignItems: "flex-start", gap: "0.5rem",
              background: "#fef9c3", border: "1px solid #fde047", borderRadius: 8,
              padding: "0.6rem 0.75rem", marginBottom: "0.5rem", fontSize: "0.82rem",
              color: "#854d0e", lineHeight: 1.45,
            }}>
              <span style={{ fontSize: "1rem", flexShrink: 0 }}>⚠️</span>
              <span>
                <strong>Not currently producing</strong> — the estimate below reflects potential development
                based on nearby well activity and basin benchmarks for this area, not current production.
              </span>
            </div>
          )}
          {result.production_snapshot ? (
            <ProductionSnapshotCard snap={result.production_snapshot} />
          ) : (
            <div className="card" style={{ marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.5rem" }}>
                Potential Production Estimate
              </h2>
              <p style={{ fontSize: "0.85rem", color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
                Enter acreage, county, and state to see a directional BOPD and royalty estimate
                based on nearby well activity in this basin. Because this property is not currently
                producing, estimates are benchmarked against comparable developed leases in the area.
              </p>
            </div>
          )}
        </div>
      ) : null}

      {result.legal_description_parsed?.plss_township && result.legal_description_parsed?.plss_range && (
        <ParcelMapCard
          township={result.legal_description_parsed.plss_township}
          range={result.legal_description_parsed.plss_range}
          section={result.legal_description_parsed.section ?? null}
          state={result.state}
          county={result.county}
        />
      )}
    </div>
  );
}

export default function QuickScreenPage() {
  const [legalDescription, setLegalDescription] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [acreage, setAcreage] = useState("");
  const [royaltyRate, setRoyaltyRate] = useState("");
  const [apiNumbers, setApiNumbers] = useState("");
  const [producing, setProducing] = useState<"yes" | "no" | "unknown">("unknown");
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
          producing,
          api_numbers: apiNumbers.trim() || undefined,
        }),
      });

      const body = await res.json() as { ok: boolean; error?: string } & Partial<ScreenResult>;
      console.log("[QuickScreen] API response:", JSON.stringify({
        ok: body.ok,
        producing_status: body.producing_status,
        has_snapshot: !!body.production_snapshot,
        snapshot_status: (body.production_snapshot as {status?: string} | null | undefined)?.status,
      }));
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

          {/* Producing status */}
          <div>
            <label htmlFor="qs-producing" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              Currently producing?
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              {(["yes", "no", "unknown"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setProducing(opt)}
                  disabled={loading}
                  style={{
                    flex: 1,
                    padding: "0.45rem 0",
                    borderRadius: 6,
                    fontSize: "0.88rem",
                    fontWeight: 600,
                    cursor: "pointer",
                    border: producing === opt ? "2px solid #2563eb" : "1px solid #d1d5db",
                    background: producing === opt
                      ? opt === "yes" ? "#dcfce7"
                        : opt === "no" ? "#fee2e2"
                        : "#dbeafe"
                      : "#fff",
                    color: producing === opt
                      ? opt === "yes" ? "#166534"
                        : opt === "no" ? "#991b1b"
                        : "#1e40af"
                      : "#6b7280",
                    transition: "all 0.1s",
                  }}
                >
                  {opt === "yes" ? "Yes" : opt === "no" ? "No" : "Unknown"}
                </button>
              ))}
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

          {/* API numbers — optional, bypasses county sampling for exact well match */}
          <div>
            <label htmlFor="qs-api" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              API number(s) <span style={{ fontSize: "0.8rem", color: "#888" }}>(optional — paste from your run statement for exact data)</span>
            </label>
            <input
              id="qs-api"
              type="text"
              value={apiNumbers}
              onChange={(e) => setApiNumbers(e.target.value)}
              placeholder="e.g. 42-151-00161 or 4215100161, 4215100165"
              style={{
                width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem",
                border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.88rem",
              }}
              disabled={loading}
            />
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

      {result ? <ValuationResult result={result} clientProducing={producing} /> : null}
    </div>
  );
}
