import type { FinancialSummary } from "@/lib/financial/financial-summary";
import type { LocationContext } from "@/lib/location/location-context";
import type { DealValuationInput, ValuationFieldSource } from "./types";
import { parseFinancialSignalsFromText } from "@/lib/financial/financial-summary";
import {
  normalizeOwnershipPercentToDecimal,
  normalizeRoyaltyToDecimal,
  pickFirstFiniteNumber,
} from "./normalize";
import type { DrillDifficultySnapshotSnake } from "@/lib/scoring/drillDifficultyEngine";
import type { DevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";
import {
  extractAcreageFromTexts,
  inferCountyAndStateFromTexts,
  inferUSStateFromText,
  parseLegalDescription,
} from "@/lib/location/legal-description-parser";

function readString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function monthlyMid(fs: FinancialSummary | null | undefined): number | null {
  if (!fs) return null;
  const a = fs.monthly_revenue_estimate_min;
  const b = fs.monthly_revenue_estimate_max;
  if (a != null && b != null && a > 0 && b > 0) return (a + b) / 2;
  if (a != null && a > 0) return a;
  if (b != null && b > 0) return b;
  return null;
}

function annualMid(fs: FinancialSummary | null | undefined): number | null {
  if (!fs) return null;
  const a = fs.annual_revenue_estimate_min;
  const b = fs.annual_revenue_estimate_max;
  if (a != null && b != null && a > 0 && b > 0) return (a + b) / 2;
  const m = monthlyMid(fs);
  return m != null ? m * 12 : null;
}

/**
 * Pulls a single conservative input object from merged deal + parsed extraction — never overwrites
 * non-null with null.
 */
export function buildValuationInput(args: {
  documentId?: string | null;
  parsed: Record<string, unknown>;
  dealScoreInput: Record<string, unknown>;
  financialSummary: FinancialSummary | null;
  locationContext: LocationContext | null;
  drillSnapshot: DrillDifficultySnapshotSnake;
  extractedText: string;
}): DealValuationInput {
  const { parsed, dealScoreInput: dsi } = args;
  const merged: Record<string, unknown> = { ...dsi, ...parsed };

  const legalDescRaw =
    (typeof parsed.legal_description === "string" && parsed.legal_description.trim()
      ? parsed.legal_description.trim()
      : null) ?? readString(merged, ["legal_description"]);
  const legal_description_parsed = parseLegalDescription(legalDescRaw);
  const locationHaystack = [legalDescRaw, args.extractedText ?? ""].join("\n\n");

  const countyExtracted = readString(merged, ["county"]);
  const stateExtracted = readString(merged, ["state"]);
  const inferredLoc = inferCountyAndStateFromTexts(legalDescRaw, args.extractedText);

  let county = countyExtracted ?? null;
  let county_source: ValuationFieldSource | null = null;
  if (county?.trim()) {
    county_source = "extracted";
  } else {
    county = inferredLoc.county;
    county_source = county?.trim() ? "inferred" : null;
  }

  let state = stateExtracted ?? null;
  let state_source: ValuationFieldSource | null = null;
  if (state?.trim()) {
    state_source = "extracted";
  } else {
    state = inferredLoc.state ?? inferUSStateFromText(locationHaystack);
    state_source = state?.trim() ? "inferred" : null;
  }

  const acreage = pickFirstFiniteNumber(
    merged.acreage,
    merged.acres,
    merged.net_acres,
    merged.nma,
    merged.net_mineral_acres,
    parsed.acreage,
    extractAcreageFromTexts(legalDescRaw, args.extractedText)
  );

  const royaltyRaw =
    readString(merged, ["royalty_rate", "lease_royalty", "royalty"]) ??
    (typeof parsed.royalty_rate === "string" ? parsed.royalty_rate : null);
  const royalty_rate = normalizeRoyaltyToDecimal(royaltyRaw);

  const ownership_percent = normalizeOwnershipPercentToDecimal(
    pickFirstFiniteNumber(merged.ownership_percent, merged.mineral_interest, merged.working_interest) ??
      readString(merged, ["ownership", "working_interest", "mineral_interest"])
  );

  const financial_summary = args.financialSummary;
  const monthly_revenue = monthlyMid(financial_summary);
  const annual_revenue = annualMid(financial_summary);

  const sig = parseFinancialSignalsFromText(args.extractedText ?? "", royaltyRaw);
  const oilMonthly = sig.oilBblMonthlyApprox;
  const bopd =
    oilMonthly != null && oilMonthly > 0 ? oilMonthly / 30 : pickFirstFiniteNumber(merged.bopd, merged.oil_bopd, merged.barrels_per_day);

  const out: DealValuationInput = {
    document_id: args.documentId ?? undefined,
    county,
    county_source,
    state,
    state_source,
    basin: readString(merged, ["basin"]) ?? null,
    legal_description: legalDescRaw,
    legal_description_parsed,
    acreage,
    royalty_rate,
    ownership_percent,
    interest_type: readString(merged, ["interest_type"]),
    bopd: bopd != null && bopd > 0 ? bopd : null,
    bwpd: pickFirstFiniteNumber(merged.bwpd, merged.water_bwpd),
    monthly_revenue: monthly_revenue != null && monthly_revenue > 0 ? monthly_revenue : null,
    annual_revenue: annual_revenue != null && annual_revenue > 0 ? annual_revenue : null,
    operator: readString(merged, ["operator", "operator_name"]),
    document_type:
      readString(merged, ["document_type"]) ??
      (typeof parsed.document_type === "string" ? parsed.document_type : null),
    location_context: args.locationContext,
    drill_difficulty: args.drillSnapshot,
    structured_source: merged,
    development_signals:
      dsi.development_signals != null && typeof dsi.development_signals === "object"
        ? (dsi.development_signals as DevelopmentSignalsSnapshot)
        : null,
    financial_summary: financial_summary ?? undefined,
    extracted_text_sample: (args.extractedText ?? "").slice(0, 4000) || null,
  };

  return out;
}
