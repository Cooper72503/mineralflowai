import type { ProductionSnapshotInput } from "./types";

export type ClassifyStatusSignals = {
  textLower: string;
  hasDirectRevenue: boolean;
  hasDirectBopd: boolean;
  hasDirectBwpd: boolean;
  hasStrongProducingLanguage: boolean;
  hasLikelyProducingLanguage: boolean;
  hasDecliningLegacyLanguage: boolean;
  hasUndevelopedLanguage: boolean;
  hasOperatorOrActivityContext: boolean;
};

const STRONG_PRODUCING =
  /\b(producing\s+well|currently\s+producing|active\s+production|oil\s+sales|gas\s+sales|runs?\s+in\s+pay|in\s+pay\s+status|allocated\s+production|production\s+allocation)\b/i;

const LIKELY_PRODUCING =
  /\b(royalt(y|ies)\s+from\s+production|off\s+the\s+lease|lease\s+production|wellhead|tank\s+battery|gathering\s+line|pipeline\s+receipt)\b/i;

const DECLINING_LEGACY =
  /\b(stripper|marginal\s+well|tail\s*[- ]?end|mature\s+field|legacy\s+well|workover\s+history|plugged\s+and\s+abandoned|p\s*&\s*a|inactive\s+well|shut[- ]?in\s+well)\b/i;

const UPSIDE_UNDEVELOPED =
  /\b(undeveloped|drill\s+site|pds|permit\s+to\s+drill|spacing\s+unit\s+only|mineral\s+interest\s+only|non[- ]?operated\s+mineral)\b/i;

export function scanProductionLanguage(text: string): Omit<
  ClassifyStatusSignals,
  "hasDirectRevenue" | "hasDirectBopd" | "hasDirectBwpd" | "hasOperatorOrActivityContext"
> & { textLower: string } {
  const textLower = text.slice(0, 120_000).toLowerCase();
  return {
    textLower,
    hasStrongProducingLanguage: STRONG_PRODUCING.test(textLower),
    hasLikelyProducingLanguage: LIKELY_PRODUCING.test(textLower),
    hasDecliningLegacyLanguage: DECLINING_LEGACY.test(textLower),
    hasUndevelopedLanguage: UPSIDE_UNDEVELOPED.test(textLower),
  };
}

function hasMeaningfulLocation(input: ProductionSnapshotInput): boolean {
  const c = input.county?.trim();
  const s = input.state?.trim();
  return Boolean(c || s || (input.legal_description?.trim().length ?? 0) >= 20);
}

export type ProductionStatusResult =
  | "producing"
  | "likely_producing"
  | "declining_or_legacy"
  | "undeveloped"
  | "unknown";

export function classifyProductionStatus(
  input: ProductionSnapshotInput,
  lang: ClassifyStatusSignals
): ProductionStatusResult {
  const hasDirectRevenue =
    lang.hasDirectRevenue ||
    (input.annual_revenue != null && input.annual_revenue > 0) ||
    (input.monthly_revenue != null && input.monthly_revenue > 0);
  const hasDirectBopd = lang.hasDirectBopd || (input.bopd != null && input.bopd > 0);
  const hasDirectBwpd = lang.hasDirectBwpd || (input.bwpd != null && input.bwpd > 0);

  if (hasDirectRevenue || hasDirectBopd) {
    if (lang.hasDecliningLegacyLanguage && !hasDirectRevenue && hasDirectBopd) {
      return "declining_or_legacy";
    }
    return "producing";
  }

  if (hasDirectBwpd && (lang.hasStrongProducingLanguage || lang.hasLikelyProducingLanguage)) {
    return "likely_producing";
  }

  if (lang.hasStrongProducingLanguage) {
    return "producing";
  }

  if (
    lang.hasLikelyProducingLanguage ||
    (lang.hasOperatorOrActivityContext &&
      (input.nearby_activity_signal === "High" || input.nearby_activity_signal === "Moderate"))
  ) {
    return "likely_producing";
  }

  if (lang.hasDecliningLegacyLanguage && !lang.hasUndevelopedLanguage) {
    return "declining_or_legacy";
  }

  if (hasMeaningfulLocation(input) && !lang.hasStrongProducingLanguage && !lang.hasLikelyProducingLanguage) {
    return "undeveloped";
  }

  if (!hasMeaningfulLocation(input) && !lang.hasLikelyProducingLanguage && !lang.hasStrongProducingLanguage) {
    return "unknown";
  }

  return "unknown";
}
