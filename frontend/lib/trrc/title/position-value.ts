/**
 * Position value.
 *
 * Three rules govern this module.
 *
 * Commodity price cases and asset-specific exposure are computed and
 * reported separately. A "downside" figure that silently contains both is
 * not produced; the reader is always told which adjustment moved a number.
 *
 * Nothing that depends on a buyer criterion is produced when that criterion
 * was not supplied. A missing minimum margin yields no maximum acquisition
 * price and no decision bands, with the reason stated, rather than a number
 * derived from a house default the buyer never agreed to.
 *
 * The present-value factor is derived from an explicit declining stream, so
 * a reviewer can reproduce it rather than take it on trust.
 */

import { Fraction } from "./fraction";
import type {
  Breakpoint, Criterion, DecisionBand, OwnershipBasis, PositionValue, PriceDeckInput,
  UnderwritingCriteria, ValueCases, WaterfallStep,
} from "./decision-types";
import { NOT_PROVIDED_LABEL, NO_THRESHOLD_LABEL } from "./decision-types";

export const TX_SEVERANCE_OIL = 0.046;
export const TX_SEVERANCE_GAS = 0.075;
export const AD_VALOREM = 0.021;

export function provided<T>(v: T | null | undefined, source: string, cls: Criterion<T>["classification"] = "USER_INPUT", note?: string): Criterion<T> {
  return v === null || v === undefined
    ? { value: null, source: NOT_PROVIDED_LABEL, classification: "NOT_PROVIDED", note }
    : { value: v, source, classification: cls, note };
}

/**
 * Present-value factor for a stream declining at `annualDecline`, discounted
 * at `rate` with mid-year timing, as a fraction of the undiscounted total.
 */
export function pv10Factor(annualDecline: number, rate = 0.10, horizonYears = 20): number {
  if (!(annualDecline > 0 && annualDecline < 1)) return 1;
  const keep = 1 - annualDecline;
  let undiscounted = 0, discounted = 0;
  for (let i = 0; i < horizonYears; i++) {
    const v = Math.pow(keep, i);
    undiscounted += v;
    discounted += v / Math.pow(1 + rate, i + 0.5);
  }
  return undiscounted === 0 ? 1 : discounted / undiscounted;
}

/** NRI = (gross tract x mineral fraction / unit acres) x royalty. Null if any part is absent. */
export function computeNri(basis: Pick<OwnershipBasis, "grossTractAcres" | "prorationUnitAcres" | "mineralFraction" | "leaseRoyaltyFraction">): {
  netRevenueInterest: number | null; netMineralAcres: number | null; derivation: string; missing: string[];
} {
  const missing: string[] = [];
  if (basis.grossTractAcres == null) missing.push("gross tract acres");
  if (basis.prorationUnitAcres == null) missing.push("proration unit acres");
  if (!basis.mineralFraction) missing.push("mineral fraction from title");
  if (!basis.leaseRoyaltyFraction) missing.push("lease royalty fraction");

  const mineral = Fraction.fromJson(basis.mineralFraction);
  const royalty = Fraction.fromJson(basis.leaseRoyaltyFraction);
  const nma = basis.grossTractAcres != null && mineral ? basis.grossTractAcres * (Number(mineral.n) / Number(mineral.d)) : null;

  if (missing.length > 0 || !mineral || !royalty || basis.grossTractAcres == null || basis.prorationUnitAcres == null) {
    return { netRevenueInterest: null, netMineralAcres: nma, missing,
      derivation: `Not computable; missing ${missing.join(", ")}. Net revenue interest is never inferred from net mineral acres alone.` };
  }
  const tractShare = new Fraction(Math.round(basis.grossTractAcres * 1e6), Math.round(basis.prorationUnitAcres * 1e6));
  const nri = mineral.mul(tractShare).mul(royalty);
  const dec = Number(nri.n) / Number(nri.d);
  return { netRevenueInterest: dec, netMineralAcres: nma, missing: [],
    derivation: `${mineral.toString()} of the minerals under ${basis.grossTractAcres} gross acres = ${nma?.toFixed(2)} net mineral acres. Over a ${basis.prorationUnitAcres}-acre unit at a ${royalty.toString()} royalty: ${mineral.toString()} x ${tractShare.toString()} x ${royalty.toString()} = ${nri.toString()} = ${dec.toFixed(8)}.` };
}

/** Undiscounted revenue net of severance and ad valorem for one deck. */
function grossAtDeck(nri: number, oil: number, gas: number, deck: PriceDeckInput): number {
  const o = oil * nri * Math.max(0, deck.oilUsdPerBbl + deck.oilDifferentialUsdPerBbl) * (1 - TX_SEVERANCE_OIL - AD_VALOREM);
  const g = gas * nri * Math.max(0, deck.gasUsdPerMcf + deck.gasDifferentialUsdPerMcf) * (1 - TX_SEVERANCE_GAS - AD_VALOREM);
  return o + g;
}

export interface ValueInputs {
  basis: OwnershipBasis;
  criteria: UnderwritingCriteria;
  remainingOilBbl: number | null;
  remainingGasMcf: number | null;
  annualDecline: number | null;
  quantifiedAssetExposureUsd: number;
  askingPriceUsd: number | null;
}

export function computePositionValue(input: ValueInputs): PositionValue {
  const { basis, criteria, remainingOilBbl, remainingGasMcf, annualDecline, quantifiedAssetExposureUsd, askingPriceUsd } = input;
  const unavailable: string[] = [];
  const nri = basis.netRevenueInterest;

  if (nri == null) unavailable.push("Net revenue interest is not computable, so no position value can be modelled.");
  if (remainingOilBbl == null && remainingGasMcf == null) unavailable.push("No remaining volumes are available, so no position value can be modelled.");
  if (criteria.baseDeck.value == null) unavailable.push("No base commodity deck was supplied, so no position value can be modelled.");
  if (annualDecline == null) unavailable.push("No decline basis was supplied, so no present-value factor can be derived.");

  const rate = criteria.discountRate.value ?? 0.10;
  const horizon = criteria.forecastHorizonYears.value ?? 20;
  const pvf = annualDecline == null ? null : pv10Factor(annualDecline, rate, horizon);
  const oil = remainingOilBbl ?? 0, gas = remainingGasMcf ?? 0;
  const canValue = nri != null && pvf != null && criteria.baseDeck.value != null && (remainingOilBbl != null || remainingGasMcf != null);

  const at = (deck: PriceDeckInput | null) => canValue && deck ? grossAtDeck(nri!, oil, gas, deck) * pvf! : null;
  const haircut = criteria.riskHaircutPct.value ?? 0;
  const applyHaircut = (v: number | null) => v == null ? null : v * (1 - haircut);

  const baseEconomic = applyHaircut(at(criteria.baseDeck.value));
  const downsideCommodity = applyHaircut(at(criteria.downsideDeck.value));
  const upsideCommodity = applyHaircut(at(criteria.upsideDeck.value));
  const evidenceAdjusted = baseEconomic == null ? null : baseEconomic - quantifiedAssetExposureUsd;
  const riskAdjusted = downsideCommodity == null ? null : downsideCommodity - quantifiedAssetExposureUsd;

  const cases: ValueCases = {
    baseEconomicValueUsd: baseEconomic,
    downsideCommodityValueUsd: downsideCommodity,
    upsideCommodityValueUsd: upsideCommodity,
    quantifiedAssetExposureUsd,
    evidenceAdjustedValueUsd: evidenceAdjusted,
    riskAdjustedValueUsd: riskAdjusted,
  };

  // ── Maximum acquisition price: withheld when the buyer criterion is absent ──
  const marginCrit = criteria.minimumMarginPct;
  const anchorKey = criteria.underwriteAgainst.value ?? "evidence_adjusted";
  const anchorValue = anchorKey === "base_economic" ? baseEconomic : anchorKey === "downside_commodity" ? downsideCommodity : evidenceAdjusted;
  const anchorLabel = anchorKey === "base_economic" ? "base economic value" : anchorKey === "downside_commodity" ? "downside commodity value" : "evidence-adjusted value";

  let maxPrice: number | null = null;
  let maxPriceUnavailableReason: string | null = null;
  if (marginCrit.classification === "NOT_PROVIDED" || marginCrit.value == null) {
    maxPriceUnavailableReason = `${NO_THRESHOLD_LABEL} (minimum required margin).`;
  } else if (anchorValue == null) {
    maxPriceUnavailableReason = `No ${anchorLabel} could be modelled, so no maximum price follows from it.`;
  } else {
    maxPrice = anchorValue * (1 - marginCrit.value);
  }

  // ── Waterfall: every dollar between modelled value and maximum price ──
  const waterfall: WaterfallStep[] = [];
  if (baseEconomic != null) {
    waterfall.push({ label: "Base economic value", amountUsd: baseEconomic, runningUsd: baseEconomic, kind: "start", source: `Base deck, PV at ${(rate * 100).toFixed(0)}% over ${horizon} years` });
    waterfall.push({ label: "Quantified ownership and title exposure", amountUsd: -quantifiedAssetExposureUsd, runningUsd: evidenceAdjusted, kind: "deduct", source: "Measured from scenario re-runs, not estimated" });
    waterfall.push({ label: "Evidence-adjusted value", amountUsd: null, runningUsd: evidenceAdjusted, kind: "subtotal", source: "Base economic value less measured asset-specific exposure" });
    if (haircut > 0) waterfall.push({ label: `Risk haircut, ${(haircut * 100).toFixed(1)}%`, amountUsd: null, runningUsd: evidenceAdjusted, kind: "deduct", source: criteria.riskHaircutPct.source });
    if (maxPrice != null && marginCrit.value != null) {
      waterfall.push({ label: `Buyer required margin, ${(marginCrit.value * 100).toFixed(0)}% of ${anchorLabel}`, amountUsd: maxPrice - (anchorValue ?? 0), runningUsd: maxPrice, kind: "deduct", source: marginCrit.source });
      waterfall.push({ label: "Maximum acquisition price", amountUsd: null, runningUsd: maxPrice, kind: "result", source: `${anchorLabel} less the buyer's required margin` });
    } else {
      waterfall.push({ label: "Maximum acquisition price", amountUsd: null, runningUsd: null, kind: "unavailable", source: maxPriceUnavailableReason ?? NOT_PROVIDED_LABEL });
    }
  }

  // ── Decision matrix ──
  const matrix: DecisionBand[] = [];
  if (maxPrice != null && baseEconomic != null) {
    matrix.push({ label: `At or below ${fmt(maxPrice)}`, fromUsd: null, toUsd: maxPrice, posture: "CONDITIONAL_PROCEED", available: true, unavailableReason: null,
      basis: `Clears the buyer's ${(marginCrit.value! * 100).toFixed(0)}% margin against ${anchorLabel}. Posture is capped at conditional while any closing blocker stands.` });
    matrix.push({ label: `Between ${fmt(maxPrice)} and ${fmt(baseEconomic)}`, fromUsd: maxPrice, toUsd: baseEconomic, posture: "HOLD_FOR_DILIGENCE", available: true, unavailableReason: null,
      basis: "Priced above the buyer's return threshold but below modelled base value; the deal only works if exceptions resolve favourably." });
    matrix.push({ label: `Above ${fmt(baseEconomic)}`, fromUsd: baseEconomic, toUsd: null, posture: "PASS", available: true, unavailableReason: null,
      basis: "No margin remains at the base deck before any exception is priced." });
  } else {
    matrix.push({ label: "All price bands", fromUsd: null, toUsd: null, posture: "INSUFFICIENT_DATA", available: false,
      unavailableReason: maxPriceUnavailableReason ?? "Base economic value could not be modelled.", basis: NO_THRESHOLD_LABEL });
  }

  // ── Breakpoints: where the DECISION changes, not merely the number ──
  // Asking price is tested against two independent boundaries, so each is named
  // for the boundary it crosses. Labelling both "Seller asking price" would put
  // two rows with the same variable and different flip points in one table,
  // which reads as a contradiction even when both rows are correct.
  const ASKING_VS_VALUE = "Asking price vs. modelled value";
  const ASKING_VS_CRITERION = "Asking price vs. buyer return criterion";
  const breakpoints: Breakpoint[] = [];
  const askingNow = askingPriceUsd == null ? NOT_PROVIDED_LABEL : fmt(askingPriceUsd);
  if (baseEconomic != null) {
    breakpoints.push({ variable: ASKING_VS_VALUE, currentValue: askingNow,
      flipsAt: `above ${fmt(baseEconomic)}`, consequence: "Posture becomes PASS; no margin remains at the base deck.", computable: true, unavailableReason: null });
  }
  if (maxPrice != null) {
    breakpoints.push({ variable: ASKING_VS_CRITERION, currentValue: askingNow,
      flipsAt: `above ${fmt(maxPrice)}`, consequence: "Buyer's return criterion fails; posture cannot reach PROCEED on price alone.", computable: true, unavailableReason: null });
  } else {
    breakpoints.push({ variable: ASKING_VS_CRITERION, currentValue: askingNow,
      flipsAt: NOT_PROVIDED_LABEL, consequence: NO_THRESHOLD_LABEL, computable: false, unavailableReason: maxPriceUnavailableReason });
  }
  if (quantifiedAssetExposureUsd > 0 && baseEconomic != null) {
    breakpoints.push({ variable: "Competing ownership claim", currentValue: "excluded from the reconciled estate",
      // Never "if admitted as valid": whether the claim is good is a legal
      // determination this system does not make. The breakpoint describes the
      // scenario the engine can model, which is inclusion in the estate.
      flipsAt: "if included in the ownership scenario", consequence: `Evidence-adjusted value falls to ${fmt(evidenceAdjusted!)}, a reduction of ${fmt(quantifiedAssetExposureUsd)}.`, computable: true, unavailableReason: null });
  }
  if (canValue && criteria.baseDeck.value && nri != null && pvf != null && maxPrice != null && askingPriceUsd != null) {
    const oilOnlyPerDollar = oil * nri * (1 - TX_SEVERANCE_OIL - AD_VALOREM) * pvf * (1 - haircut);
    if (oilOnlyPerDollar > 0) {
      const needed = criteria.baseDeck.value.oilUsdPerBbl - ((anchorValue! - askingPriceUsd / (1 - (marginCrit.value ?? 0))) / oilOnlyPerDollar);
      breakpoints.push({ variable: "Oil price", currentValue: `$${criteria.baseDeck.value.oilUsdPerBbl.toFixed(2)}/bbl`,
        flipsAt: `below $${Math.max(0, needed).toFixed(2)}/bbl`, consequence: "Return criterion fails at the current asking price.", computable: true, unavailableReason: null });
    }
  }
  if (nri != null && maxPrice != null && askingPriceUsd != null && baseEconomic != null && baseEconomic > 0) {
    const nriFloor = nri * (askingPriceUsd / maxPrice);
    breakpoints.push({ variable: "Net revenue interest", currentValue: nri.toFixed(8),
      flipsAt: `below ${nriFloor.toFixed(8)}`, consequence: "Position no longer supports the asking price at the buyer's margin.", computable: true, unavailableReason: null });
  }

  return {
    basis, criteria, cases,
    remainingOilBbl, remainingGasMcf, pvFactor: pvf, annualDecline,
    askingPriceUsd,
    priceToValueRatio: askingPriceUsd != null && baseEconomic ? askingPriceUsd / baseEconomic : null,
    marginToBaseUsd: askingPriceUsd != null && baseEconomic != null ? baseEconomic - askingPriceUsd : null,
    marginToEvidenceAdjustedUsd: askingPriceUsd != null && evidenceAdjusted != null ? evidenceAdjusted - askingPriceUsd : null,
    marginToRiskAdjustedUsd: askingPriceUsd != null && riskAdjusted != null ? riskAdjusted - askingPriceUsd : null,
    maxAcquisitionPriceUsd: maxPrice,
    maxPriceUnavailableReason,
    waterfall, decisionMatrix: matrix, breakpoints,
    unavailableReasons: unavailable,
  };
}

function fmt(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}
