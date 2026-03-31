/**
 * MVP document-based financial context for mineral buyers.
 * Directional / preliminary only — not reserve engineering or formal appraisal.
 */

export type FinancialConfidenceLabel = "High" | "Medium" | "Low";

export type FinancialSummary = {
  has_financials: boolean;
  confidence: FinancialConfidenceLabel;
  monthly_revenue_estimate_min?: number;
  monthly_revenue_estimate_max?: number;
  annual_revenue_estimate_min?: number;
  annual_revenue_estimate_max?: number;
  valuation_estimate_min?: number;
  valuation_estimate_max?: number;
  payback_context?: string;
  methodology?: string[];
  warnings?: string[];
  sources?: Record<string, string>;
};

const STANDARD_WARNINGS = [
  "Does not include decline curve, operating costs, or taxes.",
  "Preliminary, document-based estimates — not a formal valuation or reserve report.",
];

function uniqStrings(list: string[], cap = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

function clampPositive(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Parse $1,234, $30K, $1.2M style amounts from a numeric + optional suffix group. */
export function parseMoneyToken(numRaw: string, suffixRaw?: string): number | null {
  const n = parseFloat(String(numRaw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = (suffixRaw ?? "").toLowerCase().trim();
  if (s === "k" || s === "thousand") return n * 1_000;
  if (s === "m" || s === "million") return n * 1_000_000;
  return n;
}

const MONTHLY_HINT =
  /(?:per\s*month|\/\s*mo(?:nth)?\b|\bmonthly\b|\bmonth\s+payment\b|\bowner\s+payment\b|\bcheck\s+detail\b)/i;
const ANNUAL_HINT = /(?:per\s*year|\/\s*yr\b|\bannually\b|\bannual\b(?!\s+report))/i;

/**
 * Extract explicit monthly revenue range or single from text (highest-priority financial signal).
 */
export function extractExplicitMonthlyRevenueRange(text: string): { min: number; max: number } | null {
  if (!text || !text.trim()) return null;
  const t = text.replace(/\r\n/g, "\n");

  const rangeRe =
    /\$\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand|m|M|million)?\s*(?:-|to|through|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand|m|M|million)?/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(t)) !== null) {
    const tail = t.slice(m.index, Math.min(t.length, m.index + 120));
    if (!MONTHLY_HINT.test(tail) && !MONTHLY_HINT.test(t.slice(Math.max(0, m.index - 40), m.index + 120))) {
      continue;
    }
    const a = parseMoneyToken(m[1], m[2]);
    const b = parseMoneyToken(m[3], m[4]);
    if (a == null || b == null) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo > 0 && hi > 0) return { min: lo, max: hi };
  }

  const singleRe =
    /\$\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand|m|M|million)?\s*(?:per\s*month|\/\s*mo(?:nth)?\b|\bmonthly\b)/gi;
  let s: RegExpExecArray | null;
  while ((s = singleRe.exec(t)) !== null) {
    const n = parseMoneyToken(s[1], s[2]);
    if (n != null && n > 0) return { min: n, max: n };
  }

  return null;
}

/**
 * Extract explicit annual revenue range or single when paired with annual hints.
 */
export function extractExplicitAnnualRevenueRange(text: string): { min: number; max: number } | null {
  if (!text || !text.trim()) return null;
  const t = text.replace(/\r\n/g, "\n");

  const rangeRe =
    /\$\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand|m|M|million)?\s*(?:-|to|through|–|—)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand|m|M|million)?/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(t)) !== null) {
    const tail = t.slice(m.index, Math.min(t.length, m.index + 120));
    if (!ANNUAL_HINT.test(tail)) continue;
    const a = parseMoneyToken(m[1], m[2]);
    const b = parseMoneyToken(m[3], m[4]);
    if (a == null || b == null) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo > 0 && hi > 0) return { min: lo, max: hi };
  }

  const singleRe = /\$\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand|m|M|million)?\s*(?:per\s*year|\/\s*yr\b|\bannually\b)/gi;
  let s: RegExpExecArray | null;
  while ((s = singleRe.exec(t)) !== null) {
    const n = parseMoneyToken(s[1], s[2]);
    if (n != null && n > 0) return { min: n, max: n };
  }

  return null;
}

/** Parse royalty / NRI / decimal into 0–1 fraction (best effort). */
export function parseRoyaltyOrDecimalFraction(raw: string | null | undefined): number | null {
  if (raw == null || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;

  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const a = parseInt(frac[1], 10);
    const b = parseInt(frac[2], 10);
    if (b > 0 && a >= 0 && a <= b) return a / b;
  }

  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const n = parseFloat(pct[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n / 100;
  }

  const decWord = t.match(
    /\b(?:decimal|nri|n\.r\.i\.)\s*(?:interest)?\s*[:=]?\s*([\d.]+)\b/i
  );
  if (decWord) {
    const n = parseFloat(decWord[1]);
    if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  }

  const plain = parseFloat(t.replace(/,/g, ""));
  if (Number.isFinite(plain) && plain > 0) {
    if (plain <= 1) return plain;
    if (plain <= 100) return plain / 100;
  }
  return null;
}

export type ParsedFinancialSignals = {
  explicitMonthlyRange: { min: number; max: number } | null;
  explicitAnnualRange: { min: number; max: number } | null;
  /** Approximate oil bbl per month (from text). */
  oilBblMonthlyApprox: number | null;
  /** Approximate gas MCF per month. */
  gasMcfMonthlyApprox: number | null;
  royaltyFraction: number | null;
  hasNetRevenueKeyword: boolean;
  hasGrossRevenueKeyword: boolean;
  hasRoyaltyKeyword: boolean;
  hasProductionKeyword: boolean;
  hasCheckOrDivisionKeyword: boolean;
};

function extractOilGasMonthlyApprox(text: string): { oil: number | null; gas: number | null } {
  if (!text.trim()) return { oil: null, gas: null };
  const t = text.slice(0, 200_000);

  let oil: number | null = null;
  let gas: number | null = null;

  const oilDaily =
    /([\d,]+(?:\.\d+)?)\s*(?:bbl|barrels?)\s*(?:per\s*day|\/\s*day|daily|bopd)/i.exec(t);
  if (oilDaily) {
    const n = parseFloat(oilDaily[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) oil = n * 30;
  }
  if (oil == null) {
    const oilMo = /([\d,]+(?:\.\d+)?)\s*(?:bbl|barrels?)\s*(?:per\s*month|\/\s*mo|monthly|\bpm\b)/i.exec(
      t
    );
    if (oilMo) {
      const n = parseFloat(oilMo[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) oil = n;
    }
  }
  if (oil == null) {
    const oilLoose = /([\d,]+(?:\.\d+)?)\s*(?:bbl|barrels?)\b/i.exec(t);
    if (oilLoose) {
      const n = parseFloat(oilLoose[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 500_000) oil = n;
    }
  }

  const gasDaily =
    /([\d,]+(?:\.\d+)?)\s*(?:mcf|MCF)\s*(?:per\s*day|\/\s*day|daily)/i.exec(t);
  if (gasDaily) {
    const n = parseFloat(gasDaily[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) gas = n * 30;
  }
  if (gas == null) {
    const gasMo = /([\d,]+(?:\.\d+)?)\s*(?:mcf|MCF)\s*(?:per\s*month|\/\s*mo|monthly|\bpm\b)/i.exec(t);
    if (gasMo) {
      const n = parseFloat(gasMo[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) gas = n;
    }
  }
  if (gas == null) {
    const gasLoose = /([\d,]+(?:\.\d+)?)\s*(?:mcf|MCF)\b/i.exec(t);
    if (gasLoose) {
      const n = parseFloat(gasLoose[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 1_000_000_000) gas = n;
    }
  }

  return { oil, gas };
}

/** Detect financial / production keywords for methodology and regional mode. */
export function parseFinancialSignalsFromText(
  text: string,
  royaltyRateStr: string | null | undefined
): ParsedFinancialSignals {
  const lt = text.toLowerCase();
  const explicitMonthlyRange = extractExplicitMonthlyRevenueRange(text);
  const explicitAnnualRange =
    explicitMonthlyRange == null ? extractExplicitAnnualRevenueRange(text) : null;
  const { oil: oilBblMonthlyApprox, gas: gasMcfMonthlyApprox } = extractOilGasMonthlyApprox(text);

  const royaltyFromField = parseRoyaltyOrDecimalFraction(royaltyRateStr ?? null);
  let royaltyFraction = royaltyFromField;
  if (royaltyFraction == null) {
    const nri = /\bNRI\b|net\s+revenue\s+interest|decimal\s+interest/i;
    const after = text.match(
      new RegExp(`${nri.source}[\\s\\S]{0,40}([\\d.]+%|\\d+\\s*/\\s*\\d+)`, "i")
    );
    if (after) {
      royaltyFraction = parseRoyaltyOrDecimalFraction(after[1]);
    }
  }
  if (royaltyFraction == null) {
    const pctNearRoyalty = /royalty[^%\n]{0,40}(\d+(?:\.\d+)?)\s*%/i.exec(text);
    if (pctNearRoyalty) royaltyFraction = parseRoyaltyOrDecimalFraction(`${pctNearRoyalty[1]}%`);
  }

  return {
    explicitMonthlyRange,
    explicitAnnualRange,
    oilBblMonthlyApprox,
    gasMcfMonthlyApprox,
    royaltyFraction,
    hasNetRevenueKeyword: /\bnet\s+revenue\b/i.test(text),
    hasGrossRevenueKeyword: /\bgross\s+revenue\b/i.test(text),
    hasRoyaltyKeyword: /\broyalt(y|ies)\b/i.test(lt) || /\bNRI\b/i.test(text),
    hasProductionKeyword: /\bproduction\b/i.test(lt) || /\bbarrels?\b/i.test(lt) || /\bmcf\b/i.test(lt),
    hasCheckOrDivisionKeyword: /\bcheck\s+detail\b/i.test(lt) || /\bdivision\s+order\b/i.test(lt),
  };
}

function valuationFromMonthlyRange(min: number, max: number): { vmin: number; vmax: number } {
  return {
    vmin: clampPositive(min * 24),
    vmax: clampPositive(max * 48),
  };
}

function readFiniteNumberLoose(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.replace(/,/g, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

type DevelopmentSignalsLike = {
  has_development_signals?: boolean;
  matched_signals?: unknown;
  has_infrastructure_language?: boolean;
  has_legal_development_context?: boolean;
};

function developmentStrength(s: unknown): "stronger" | "weaker" | "neutral" {
  if (s == null || typeof s !== "object") return "neutral";
  const d = s as DevelopmentSignalsLike;
  const n = Array.isArray(d.matched_signals) ? d.matched_signals.length : 0;
  if (d.has_development_signals && (n >= 2 || d.has_infrastructure_language)) return "stronger";
  if (d.has_legal_development_context) return "stronger";
  return "neutral";
}

export type BuildFinancialSummaryArgs = {
  extractedText: string;
  /** Enriched deal score input (development_signals, acreage, etc.). */
  dealScoreInput: Record<string, unknown>;
  royaltyRateStr: string | null | undefined;
  /** County from parsed extraction or document. */
  county: string | null | undefined;
};

/**
 * Build persisted financial summary from extracted text + deal context.
 */
export function buildFinancialSummary(args: BuildFinancialSummaryArgs): FinancialSummary {
  const text = args.extractedText ?? "";
  const signals = parseFinancialSignalsFromText(text, args.royaltyRateStr);
  const acreage = readFiniteNumberLoose(args.dealScoreInput.acreage);
  const dev = args.dealScoreInput.development_signals;
  const county =
    typeof args.county === "string" && args.county.trim()
      ? args.county.trim()
      : typeof args.dealScoreInput.county === "string" && args.dealScoreInput.county.trim()
        ? String(args.dealScoreInput.county).trim()
        : null;

  const sources: Record<string, string> = {};

  /** CASE 1: explicit monthly revenue */
  if (signals.explicitMonthlyRange != null) {
    const { min, max } = signals.explicitMonthlyRange;
    const { vmin, vmax } = valuationFromMonthlyRange(min, max);
    const conf: FinancialConfidenceLabel = min === max ? "High" : "Medium";
    sources.revenue_basis = "Explicit monthly revenue language in document text.";
    return {
      has_financials: true,
      confidence: conf,
      monthly_revenue_estimate_min: min,
      monthly_revenue_estimate_max: max,
      annual_revenue_estimate_min: min * 12,
      annual_revenue_estimate_max: max * 12,
      valuation_estimate_min: vmin,
      valuation_estimate_max: vmax,
      payback_context:
        "At this revenue level, a buyer may recover capital in roughly 24–48 months depending on decline and operating costs.",
      methodology: uniqStrings([
        "Based on explicit monthly revenue language found in the document (preliminary).",
        "Annual revenue shown as monthly × 12 (directional).",
        "Rough market valuation range: 24× to 48× monthly cash flow — directional only, not a formal appraisal.",
        "Document-based snapshot — not reserve engineering.",
      ]),
      warnings: uniqStrings([...STANDARD_WARNINGS]),
      sources,
    };
  }

  /** Explicit annual → monthly */
  if (signals.explicitAnnualRange != null) {
    const { min, max } = signals.explicitAnnualRange;
    const moMin = min / 12;
    const moMax = max / 12;
    const { vmin, vmax } = valuationFromMonthlyRange(moMin, moMax);
    sources.revenue_basis = "Explicit annual revenue language in document text.";
    return {
      has_financials: true,
      confidence: "Medium",
      monthly_revenue_estimate_min: moMin,
      monthly_revenue_estimate_max: moMax,
      annual_revenue_estimate_min: min,
      annual_revenue_estimate_max: max,
      valuation_estimate_min: vmin,
      valuation_estimate_max: vmax,
      payback_context:
        "At this revenue level, a buyer may recover capital in roughly 24–48 months depending on decline and operating costs.",
      methodology: uniqStrings([
        "Derived monthly range from explicit annual revenue in the document (÷12).",
        "Rough market valuation range: 2–4× annualized cash flow proxy using 24×–48× monthly multiples (directional).",
        "Document-based snapshot — not reserve engineering.",
      ]),
      warnings: uniqStrings([...STANDARD_WARNINGS]),
      sources,
    };
  }

  /** CASE 2: production + royalty / ownership */
  const rf = signals.royaltyFraction;
  const hasVol =
    (signals.oilBblMonthlyApprox != null && signals.oilBblMonthlyApprox > 0) ||
    (signals.gasMcfMonthlyApprox != null && signals.gasMcfMonthlyApprox > 0);
  const hasFinancialContextForVolume =
    signals.hasRoyaltyKeyword ||
    signals.hasNetRevenueKeyword ||
    signals.hasGrossRevenueKeyword ||
    signals.hasProductionKeyword ||
    signals.hasCheckOrDivisionKeyword;
  if (hasVol && rf != null && rf > 0 && rf <= 1 && hasFinancialContextForVolume) {
    const oil = signals.oilBblMonthlyApprox ?? 0;
    const gas = signals.gasMcfMonthlyApprox ?? 0;
    const oilPriceLo = 35;
    const oilPriceHi = 85;
    const gasPriceLo = 1;
    const gasPriceHi = 4;
    const grossMin = oil * oilPriceLo + gas * gasPriceLo;
    const grossMax = oil * oilPriceHi + gas * gasPriceHi;
    const moMin = grossMin * rf;
    const moMax = grossMax * rf;
    if (moMin > 0 && moMax > 0 && Number.isFinite(moMin) && Number.isFinite(moMax)) {
      const { vmin, vmax } = valuationFromMonthlyRange(moMin, moMax);
      sources.revenue_basis =
        "Approximate gross commodity value × parsed royalty/NRI from document signals (very wide band).";
      return {
        has_financials: true,
        confidence: "Low",
        monthly_revenue_estimate_min: moMin,
        monthly_revenue_estimate_max: moMax,
        annual_revenue_estimate_min: moMin * 12,
        annual_revenue_estimate_max: moMax * 12,
        valuation_estimate_min: vmin,
        valuation_estimate_max: vmax,
        payback_context:
          "Limited financial confidence: production-based estimate uses illustrative commodity ranges; actual net cash may differ materially.",
        methodology: uniqStrings([
          "Estimated net revenue using stated or inferred volumes and a parsed royalty/decimal/NRI (illustrative pricing bands).",
          "Rough market valuation range: 24× to 48× monthly cash flow — directional only.",
          "Document-based snapshot — not reserve engineering.",
        ]),
        warnings: uniqStrings([
          ...STANDARD_WARNINGS,
          "Commodity prices and timing are assumed for illustration; realizations vary by lease, operator, and market.",
          "Volume units (daily vs monthly) may be ambiguous in OCR text — treat as directional.",
        ]),
        sources,
      };
    }
  }

  /** CASE 3: regional / heuristic — no fabricated dollars */
  const hasLoc = county != null || (acreage != null && acreage > 0);
  const devSig = dev != null && typeof dev === "object" && (dev as DevelopmentSignalsLike).has_development_signals === true;
  const keywordBundle =
    signals.hasProductionKeyword ||
    signals.hasRoyaltyKeyword ||
    signals.hasNetRevenueKeyword ||
    signals.hasGrossRevenueKeyword ||
    signals.hasCheckOrDivisionKeyword;

  if (hasLoc && (devSig || keywordBundle)) {
    const strength = developmentStrength(dev);
    const note =
      strength === "stronger"
        ? "Economic potential appears stronger based on development and location signals in the document (directional only)."
        : strength === "weaker"
          ? "Economic potential appears limited based on available document signals (directional only)."
          : "Some mineral economic context may exist, but no reliable monthly revenue could be inferred from this document alone.";
    return {
      has_financials: false,
      confidence: "Low",
      payback_context: note,
      methodology: uniqStrings([
        "County / acreage / development cues present; no explicit revenue or production volumes suitable for a numeric estimate.",
        "Directional, document-based read — not a formal valuation.",
      ]),
      warnings: uniqStrings([
        "Financial estimate unavailable — document lacks direct revenue or usable production data for a numeric range.",
      ]),
      sources: { context: "Regional/heuristic mode — qualitative only." },
    };
  }

  if (hasLoc && acreage != null && acreage > 0) {
    return {
      has_financials: false,
      confidence: "Low",
      payback_context: "Limited financial confidence due to missing production and revenue detail in the document.",
      methodology: uniqStrings([
        "Acreage and location noted; no explicit revenue or production figures to support a numeric estimate.",
      ]),
      warnings: uniqStrings([
        "Not enough direct production or revenue data found to estimate deal economics from this document alone.",
      ]),
      sources: { context: "Insufficient financial signals." },
    };
  }

  return {
    has_financials: false,
    confidence: "Low",
    payback_context: "Limited financial confidence due to missing production and revenue detail.",
    methodology: uniqStrings([
      "Document-based preliminary screen only.",
    ]),
    warnings: uniqStrings([
      "Not enough direct production or revenue data found to estimate deal economics from this document alone.",
    ]),
    sources: { context: "Insufficient financial signals." },
  };
}
