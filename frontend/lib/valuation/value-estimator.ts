import type { DealValuationActivityLevel } from "./types";
import type { DealValuationDealType } from "./types";
import type { DealValuationInput } from "./types";
import { textSuggestsInfrastructure } from "./deal-type";
import { logValuationDev } from "./normalize";

export type ValueEstimateResult = {
  value_per_acre_low: number | null;
  value_per_acre_high: number | null;
  estimated_total_value_low: number | null;
  estimated_total_value_high: number | null;
  method: string;
};

const UNDEV_HIGH = { lo: 3000, hi: 10_000 };
const UNDEV_MOD = { lo: 1000, hi: 3000 };
const UNDEV_LOW = { lo: 0, hi: 1000 };

function tierForUndeveloped(activity: DealValuationActivityLevel): { lo: number; hi: number } | null {
  switch (activity) {
    case "high":
      return UNDEV_HIGH;
    case "moderate":
      return UNDEV_MOD;
    case "low":
      return UNDEV_LOW;
    case "unknown":
      return { lo: 0, hi: 500 };
    default:
      return null;
  }
}

function annualFromFinancial(input: DealValuationInput): { low: number; high: number } | null {
  const fs = input.financial_summary;
  if (!fs) return null;
  if (fs.annual_revenue_estimate_min != null && fs.annual_revenue_estimate_max != null) {
    const lo = Math.min(fs.annual_revenue_estimate_min, fs.annual_revenue_estimate_max);
    const hi = Math.max(fs.annual_revenue_estimate_min, fs.annual_revenue_estimate_max);
    if (lo > 0 && hi > 0) return { low: lo, high: hi };
  }
  if (fs.monthly_revenue_estimate_min != null && fs.monthly_revenue_estimate_max != null) {
    const lo = Math.min(fs.monthly_revenue_estimate_min, fs.monthly_revenue_estimate_max) * 12;
    const hi = Math.max(fs.monthly_revenue_estimate_min, fs.monthly_revenue_estimate_max) * 12;
    if (lo > 0 && hi > 0) return { low: lo, high: hi };
  }
  return null;
}

function infraHeavy(input: DealValuationInput, dealType: DealValuationDealType): boolean {
  const text = `${input.document_type ?? ""}\n${input.legal_description ?? ""}\n${input.extracted_text_sample ?? ""}`;
  const textInfra = textSuggestsInfrastructure(text);
  const devInfra = input.development_signals?.has_infrastructure_language === true;
  if (dealType === "infrastructure") return true;
  if (dealType === "mixed") return textInfra || devInfra;
  return false;
}

function nullResult(method: string): ValueEstimateResult {
  return {
    value_per_acre_low: null,
    value_per_acre_high: null,
    estimated_total_value_low: null,
    estimated_total_value_high: null,
    method,
  };
}

/**
 * Conservative directional ranges — not reserve engineering.
 */
export function estimateValueRange(args: {
  input: DealValuationInput;
  dealType: DealValuationDealType;
  activity: DealValuationActivityLevel;
}): ValueEstimateResult {
  const { input, dealType, activity } = args;
  const acres = input.acreage != null && input.acreage > 0 ? input.acreage : null;
  const annual = annualFromFinancial(input);

  if (infraHeavy(input, dealType)) {
    if (annual) {
      const multLo = 1.2;
      const multHi = 3.5;
      const method = "infrastructure / mixed (facilities): revenue-multiple band — wide";
      logValuationDev("value_method", { method, dealType });
      return {
        value_per_acre_low: acres != null ? (annual.low * multLo) / acres : null,
        value_per_acre_high: acres != null ? (annual.high * multHi) / acres : null,
        estimated_total_value_low: annual.low * multLo,
        estimated_total_value_high: annual.high * multHi,
        method,
      };
    }
    const baseLow = acres != null ? acres * 500 : 25_000;
    const baseHigh = acres != null ? acres * 8000 : 400_000;
    const method = "infrastructure / mixed: broad strategic band when revenue is thin";
    logValuationDev("value_method", { method });
    return {
      value_per_acre_low: acres != null ? baseLow / acres : null,
      value_per_acre_high: acres != null ? baseHigh / acres : null,
      estimated_total_value_low: baseLow,
      estimated_total_value_high: baseHigh,
      method,
    };
  }

  if (dealType === "producing" || dealType === "mixed") {
    if (annual) {
      // Mineral rights market multiples based on basin activity quality.
      // Buyers pay more for higher-activity basins (stronger development pipeline).
      // These are industry-standard ranges used in royalty acquisition.
      let multLo: number;
      let multHi: number;
      if (activity === "high") {
        multLo = 4.0; multHi = 6.0;      // Permian, Eagle Ford, Utica core, SCOOP/STACK
      } else if (activity === "moderate") {
        multLo = 3.0; multHi = 4.5;      // Active basins, moderate development pipeline
      } else if (activity === "low") {
        multLo = 2.0; multHi = 3.5;      // Low activity — conventional or mature fields
      } else {
        multLo = 2.5; multHi = 4.0;      // Unknown activity — conservative band
      }
      const method = `producing: market income multiple (${multLo}x–${multHi}x annual royalty income, ${activity} basin activity)`;
      const low = annual.low * multLo;
      const high = annual.high * multHi;
      logValuationDev("value_method", { method, multLo, multHi, activity });
      return {
        value_per_acre_low: acres != null ? low / acres : null,
        value_per_acre_high: acres != null ? high / acres : null,
        estimated_total_value_low: low,
        estimated_total_value_high: high,
        method,
      };
    }

    const bopd = input.bopd;
    if (bopd != null && bopd > 0) {
      const roy = input.royalty_rate ?? 0.2;
      const netBopd = bopd * Math.min(1, Math.max(0.05, roy));
      const annLo = netBopd * 40 * 30 * 12;
      const annHi = netBopd * 70 * 30 * 12;
      const method = "producing: BOPD × illustrative net-back × time — very wide band";
      logValuationDev("value_method", { method, bopd, roy });
      return {
        value_per_acre_low: acres != null ? (annLo * 1.2) / acres : null,
        value_per_acre_high: acres != null ? (annHi * 2.8) / acres : null,
        estimated_total_value_low: annLo * 1.2,
        estimated_total_value_high: annHi * 2.8,
        method,
      };
    }

    return nullResult("producing: no annual revenue or BOPD usable for numeric screening");
  }

  if (dealType === "undeveloped" || dealType === "lease" || dealType === "unknown") {
    const tier = tierForUndeveloped(activity);
    if (!tier || acres == null) {
      const method = "undeveloped/legal: insufficient acreage for per-acre math";
      logValuationDev("value_method", { method, activity });
      return nullResult(method);
    }
    let lo = tier.lo;
    let hi = tier.hi;
    if (input.royalty_rate != null && input.royalty_rate > 0 && input.royalty_rate <= 1) {
      const bump = 0.85 + input.royalty_rate * 0.25;
      lo *= bump;
      hi *= bump;
    }
    const method = `undeveloped/legal: activity-tier per-acre band (${activity}) — directional`;
    logValuationDev("value_method", { method, activity, acres });
    return {
      value_per_acre_low: lo,
      value_per_acre_high: hi,
      estimated_total_value_low: lo * acres,
      estimated_total_value_high: hi * acres,
      method,
    };
  }

  return nullResult("fallback: limited signals");
}
