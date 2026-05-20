/**
 * Builds a conservative, merged input for production snapshot heuristics.
 * Never lets null/empty overwrite a usable structured value.
 */

import type { FinancialSummary } from "@/lib/financial/financial-summary";
import type { LocationContext } from "@/lib/location/location-context";
import type { DrillDifficultySnapshotSnake } from "@/lib/scoring/drillDifficultyEngine";
import { preferNonEmptyString } from "@/lib/deals/dashboard-normalize";
import type { ProductionSnapshotInput } from "./types";

function pickFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v.trim().replace(/,/g, ""));
      if (!Number.isNaN(n) && Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickNonEmptyString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
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

export type BuildProductionSnapshotInputArgs = {
  documentId?: string | null;
  parsed: Record<string, unknown>;
  dealScoreInput: Record<string, unknown>;
  financialSummary: FinancialSummary | null;
  locationContext: LocationContext | null;
  drillSnapshot: DrillDifficultySnapshotSnake;
  extractedText: string;
  combinedExtractionText?: string | null;
};

export function buildProductionSnapshotInput(args: BuildProductionSnapshotInputArgs): ProductionSnapshotInput {
  const { parsed, dealScoreInput: dsi } = args;
  const merged: Record<string, unknown> = { ...dsi };
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !v.trim()) continue;
    merged[k] = v;
  }

  const sampleSource =
    [args.combinedExtractionText, args.extractedText].find(
      (s) => typeof s === "string" && s.trim().length > 0,
    ) ?? "";
  const extracted_text_sample = sampleSource.slice(0, 24_000);

  const lc = args.locationContext;
  const nearby =
    lc?.nearby_activity_signal != null ? String(lc.nearby_activity_signal) : null;

  const out: ProductionSnapshotInput = {
    document_id: args.documentId ?? undefined,
    county: preferNonEmptyString(
      typeof merged.county === "string" ? merged.county : null,
      typeof parsed.county === "string" ? parsed.county : null,
    ),
    state: preferNonEmptyString(
      typeof merged.state === "string" ? merged.state : null,
      typeof parsed.state === "string" ? parsed.state : null,
    ),
    basin: pickNonEmptyString(merged.basin),
    legal_description: preferNonEmptyString(
      typeof merged.legal_description === "string" ? merged.legal_description : null,
      typeof parsed.legal_description === "string" ? parsed.legal_description : null,
    ),
    acreage: pickFiniteNumber(merged.acreage, merged.acres, parsed.acreage),
    operator: pickNonEmptyString(
      merged.operator,
      merged.operator_name,
      merged.lessee,
      merged.lessor,
    ),
    document_type: pickNonEmptyString(merged.document_type, parsed.document_type),
    bopd: pickFiniteNumber(merged.bopd, merged.oil_bopd, merged.barrels_per_day),
    bwpd: pickFiniteNumber(merged.bwpd, merged.water_bwpd),
    monthly_revenue: monthlyMid(args.financialSummary),
    annual_revenue: annualMid(args.financialSummary),
    nearby_activity_signal: nearby,
    location_context: lc ?? null,
    drill_difficulty: args.drillSnapshot ?? null,
    extracted_text_sample,
    structured_source: merged,
  };

  if (process.env.NODE_ENV !== "production") {
    console.log("[production-input]", {
      document_id: out.document_id ?? null,
      has_bopd: out.bopd != null && out.bopd > 0,
      has_revenue: (out.annual_revenue ?? 0) > 0 || (out.monthly_revenue ?? 0) > 0,
      nearby: out.nearby_activity_signal ?? null,
      text_len: extracted_text_sample.length,
    });
  }

  return out;
}
