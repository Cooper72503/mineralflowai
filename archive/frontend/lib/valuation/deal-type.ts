import type { DealValuationDealType } from "./types";
import type { DealValuationInput } from "./types";
import type { FinancialSummary } from "@/lib/financial/financial-summary";
import type { DevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";
import {
  mergeLegalDescriptionParseResults,
  parseLegalDescription,
} from "@/lib/location/legal-description-parser";
import { logValuationDev } from "./normalize";

const INFRA_RE =
  /\b(swd|salt\s*water\s*disposal|disposal\s*well|injection\s*well|water\s*handling|saltwater|injection\s*facility|disposal\s*facility)\b/i;

/** Exported for valuation / value-estimator alignment with classification. */
export function textSuggestsInfrastructure(text: string): boolean {
  return INFRA_RE.test(text);
}

function scanInfra(text: string): boolean {
  return textSuggestsInfrastructure(text);
}

function scanLeaseLanguage(text: string): boolean {
  return /\b(lessor|lessee|lease|working\s*interest|wi\b|royalty\s*interest|ri\b|paid-up\s*lease|habendum)\b/i.test(
    text
  );
}

export function inferHasProductionSignals(
  input: DealValuationInput,
  financial: FinancialSummary | null
): boolean {
  const fsNumeric =
    financial?.has_financials === true &&
    ((financial.annual_revenue_estimate_min != null && financial.annual_revenue_estimate_min > 0) ||
      (financial.monthly_revenue_estimate_min != null && financial.monthly_revenue_estimate_min > 0));
  return (
    (input.annual_revenue != null && input.annual_revenue > 0) ||
    (input.monthly_revenue != null && input.monthly_revenue > 0) ||
    (input.bopd != null && input.bopd > 0) ||
    fsNumeric === true
  );
}

/**
 * Rule-based deal typing from extracted fields + text cues — no ML.
 * Pass producingStatusOverride="yes" to force "producing" when the user has confirmed it
 * (e.g. Quick Screen form) even if no financial signals were extracted.
 */
export function classifyDealType(args: {
  documentType: string | null;
  legalDescription: string | null;
  extractedText: string;
  developmentSignals: DevelopmentSignalsSnapshot | null;
  acreage: number | null;
  county: string | null;
  hasProduction: boolean;
  producingStatusOverride?: "yes" | "no" | "unknown";
}): DealValuationDealType {
  const ocrAndLegal = `${args.legalDescription ?? ""}\n${args.extractedText ?? ""}`;
  const text = `${args.documentType ?? ""}\n${ocrAndLegal}`.slice(0, 120_000);
  const infra = scanInfra(text);
  const dev = args.developmentSignals;
  const infraDev =
    infra ||
    dev?.has_infrastructure_language === true ||
    (Array.isArray(dev?.matched_signals) &&
      dev!.matched_signals!.some((s) => /infra|swd|disposal|injection|water/i.test(String(s))));

  // User-supplied override takes precedence over text-inferred production signals.
  // "yes" means the user confirmed this property is currently producing — treat it as such
  // even if no income/BOPD data was extracted from the bare legal description.
  const override = args.producingStatusOverride;
  if (override === "yes" && !infraDev) {
    logValuationDev("deal_type_path", { result: "producing", note: "user_confirmed_producing" });
    return "producing";
  }
  if (override === "no") {
    logValuationDev("deal_type_path", { note: "user_confirmed_not_producing — suppressing producing classification" });
    // fall through to non-producing paths below
  }

  // If override is "no", treat as if there's no production regardless of extracted signals
  const prod = override === "no" ? false : args.hasProduction;

  if (infraDev && prod) {
    logValuationDev("deal_type_path", { result: "mixed", note: "infra+production" });
    return "mixed";
  }
  if (infraDev && !prod) {
    logValuationDev("deal_type_path", { result: "infrastructure", note: "infra_signals" });
    return "infrastructure";
  }

  if (prod) {
    logValuationDev("deal_type_path", { result: "producing", note: "revenue_or_production" });
    return "producing";
  }

  const leaseOnly = scanLeaseLanguage(text) && !prod;
  const legalParsed = mergeLegalDescriptionParseResults(
    parseLegalDescription(args.extractedText ?? ""),
    parseLegalDescription(args.legalDescription ?? "")
  );
  const hasStructuredLegal = Boolean(
    legalParsed.section ||
      legalParsed.block ||
      legalParsed.survey_name ||
      legalParsed.abstract_number ||
      (legalParsed.plss_township && legalParsed.plss_range)
  );
  // A PLSS township+range pair is a strong location anchor even without a county name (common in
  // pure legal description documents where county may not appear in the text).
  const hasPlssAnchor = Boolean(legalParsed.plss_township && legalParsed.plss_range);
  const hasLoc =
    (Boolean(args.county?.trim()) || hasPlssAnchor) &&
    ((args.acreage != null && args.acreage > 0) || hasStructuredLegal);
  const legalTrim = ocrAndLegal.trim();
  const hasLegal =
    Boolean(legalTrim) && (legalTrim.length >= 40 || hasStructuredLegal);

  if (leaseOnly && hasLoc) {
    logValuationDev("deal_type_path", { result: "lease", note: "lease_language_no_production" });
    return "lease";
  }

  if (hasLegal && hasLoc && !prod) {
    logValuationDev("deal_type_path", { result: "undeveloped", note: "legal_acreage_county_no_production" });
    return "undeveloped";
  }

  if (leaseOnly) {
    return "lease";
  }

  logValuationDev("deal_type_path", { result: "unknown", note: "sparse_signals" });
  return "unknown";
}
