/**
 * Adapts a persisted research job into DecisionInputs, and derives the
 * default scenario set from the findings themselves.
 *
 * The governing rule: an absent buyer criterion becomes NOT_PROVIDED, never
 * a house default. Where the system does supply a convention (severance
 * rates, discount rate, horizon) it is tagged SYSTEM_DEFAULT so the reader
 * can tell a buyer's policy from ours. The asking price and the minimum
 * margin are never defaulted under any circumstance, because both change
 * what the report recommends.
 */

import { Fraction } from "./fraction";
import type { FractionJson } from "./fraction";
import type { ChainFinding, TitleAssessmentClassification } from "./chain-types";
import type {
  AssetIdentity, Criterion, DecisionInputs, PriceDeckInput, SourceFreshness, UnderwritingCriteria,
} from "./decision-types";
import { provided } from "./position-value";
import { dilutedFraction, type ScenarioDefinition } from "./scenarios";

export const DEFAULT_RECONCILIATION_THRESHOLD_PCT = 2;
export const SYSTEM_DISCOUNT_RATE = 0.10;
export const SYSTEM_HORIZON_YEARS = 20;
export const SYSTEM_TIMING = "Mid-year discounting";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function frac(n: unknown, d: unknown): FractionJson | null {
  const nn = num(n), dd = num(d);
  if (nn == null || dd == null || dd === 0) return null;
  return { n: String(Math.round(nn)), d: String(Math.round(dd)) };
}

/** Applies a symmetric percentage move to a deck, used only when the buyer supplied the move. */
export function shiftDeck(base: PriceDeckInput, factor: number): PriceDeckInput {
  return { ...base, oilUsdPerBbl: base.oilUsdPerBbl * factor, gasUsdPerMcf: base.gasUsdPerMcf * factor };
}

export interface CriteriaSeed {
  discountRate?: number | null;
  minimumMarginPct?: number | null;
  underwriteAgainst?: UnderwritingCriteria["underwriteAgainst"]["value"];
  baseDeck?: PriceDeckInput | null;
  downsideDeck?: PriceDeckInput | null;
  upsideDeck?: PriceDeckInput | null;
  forecastHorizonYears?: number | null;
  riskHaircutPct?: number | null;
  /** Where each buyer-supplied value came from, for the provenance column. */
  buyerPolicySource?: string;
}

export function buildUnderwritingCriteria(seed: CriteriaSeed): UnderwritingCriteria {
  const policy = seed.buyerPolicySource ?? "Buyer underwriting policy";
  return {
    discountRate: seed.discountRate != null
      ? provided(seed.discountRate, policy, "USER_INPUT")
      : provided(SYSTEM_DISCOUNT_RATE, "MineralFlow stated convention", "SYSTEM_DEFAULT", "Disclosed convention, not a buyer input."),
    // Never defaulted: this sets the maximum price.
    minimumMarginPct: provided(seed.minimumMarginPct ?? null, policy, "USER_INPUT"),
    underwriteAgainst: seed.underwriteAgainst
      ? provided(seed.underwriteAgainst, policy, "USER_INPUT")
      : provided("evidence_adjusted", "MineralFlow stated convention", "SYSTEM_DEFAULT", "Underwrites against value after measured exposure."),
    baseDeck: provided(seed.baseDeck ?? null, seed.baseDeck ? policy : "", "USER_INPUT"),
    downsideDeck: provided(seed.downsideDeck ?? null, seed.downsideDeck ? policy : "", "USER_INPUT",
      "A downside deck is a buyer assumption about prices only. It carries no asset-specific risk."),
    upsideDeck: provided(seed.upsideDeck ?? null, seed.upsideDeck ? policy : "", "USER_INPUT"),
    forecastHorizonYears: seed.forecastHorizonYears != null
      ? provided(seed.forecastHorizonYears, policy, "USER_INPUT")
      : provided(SYSTEM_HORIZON_YEARS, "MineralFlow stated convention", "SYSTEM_DEFAULT"),
    timingConvention: provided(SYSTEM_TIMING, "MineralFlow stated convention", "SYSTEM_DEFAULT"),
    riskHaircutPct: seed.riskHaircutPct != null
      ? provided(seed.riskHaircutPct, policy, "USER_INPUT")
      : provided(0, "No haircut applied", "SYSTEM_DEFAULT", "Asset-specific risk is carried as measured exposure instead of a blanket haircut."),
  };
}

export interface JobDecisionContext {
  job: Record<string, unknown>;
  jobId: string;
  analysisId: string;
  assetIdentity: AssetIdentity;
  positionLabel: string;
  titleStatus: TitleAssessmentClassification;
  findings: ChainFinding[];
  confirmedTractCount: number;
  verifiedInstrumentCount: number;
  indexOnlyInstrumentCount: number;
  openReviewItemCount: number;
  unresolvedAllocationCount: number;
  sourceFreshness: SourceFreshness[];
  reconciliationVariancePct?: number | null;
  openRegulatoryItems?: string[];
}

export function buildDecisionInputsFromJob(ctx: JobDecisionContext): DecisionInputs {
  const j = ctx.job;
  const oil = num(j.oil_price_usd_bbl), gas = num(j.gas_price_usd_mcf);
  const baseDeck: PriceDeckInput | null = oil != null && gas != null ? {
    oilUsdPerBbl: oil, gasUsdPerMcf: gas,
    oilDifferentialUsdPerBbl: num(j.oil_differential_usd_bbl) ?? 0,
    gasDifferentialUsdPerMcf: num(j.gas_differential_usd_mcf) ?? 0,
  } : null;
  const downFactor = num(j.downside_price_factor), upFactor = num(j.upside_price_factor);

  return {
    jobId: ctx.jobId,
    analysisId: ctx.analysisId,
    asOfDate: (j.as_of_date as string | null) ?? null,
    assetIdentity: ctx.assetIdentity,
    positionLabel: ctx.positionLabel,
    titleStatus: ctx.titleStatus,
    findings: ctx.findings,
    confirmedTractCount: ctx.confirmedTractCount,
    verifiedInstrumentCount: ctx.verifiedInstrumentCount,
    indexOnlyInstrumentCount: ctx.indexOnlyInstrumentCount,
    openReviewItemCount: ctx.openReviewItemCount,
    unresolvedAllocationCount: ctx.unresolvedAllocationCount,
    basis: {
      grossTractAcres: num(j.gross_tract_acres),
      prorationUnitAcres: num(j.proration_unit_acres),
      mineralFraction: frac(j.mineral_fraction_numerator, j.mineral_fraction_denominator),
      leaseRoyaltyFraction: frac(j.lease_royalty_numerator, j.lease_royalty_denominator),
      netMineralAcres: null, netRevenueInterest: null, derivation: "",
    },
    criteria: buildUnderwritingCriteria({
      discountRate: num(j.discount_rate),
      minimumMarginPct: num(j.required_margin_pct),
      underwriteAgainst: (j.underwrite_against as UnderwritingCriteria["underwriteAgainst"]["value"]) ?? undefined,
      baseDeck,
      downsideDeck: baseDeck && downFactor != null ? shiftDeck(baseDeck, downFactor) : null,
      upsideDeck: baseDeck && upFactor != null ? shiftDeck(baseDeck, upFactor) : null,
      forecastHorizonYears: num(j.forecast_horizon_years),
      riskHaircutPct: num(j.risk_haircut_pct),
    }),
    remainingOilBbl: num(j.remaining_oil_bbl),
    remainingGasMcf: num(j.remaining_gas_mcf),
    annualDecline: num(j.annual_decline_pct) == null ? null : num(j.annual_decline_pct)! / 100,
    forecastBasisNote: (j.forecast_basis_note as string | null) ?? "Vendor forecast; the parent-child relationship behind it has not been separately confirmed.",
    askingPriceUsd: num(j.asking_price_usd),   // never defaulted
    openRegulatoryItems: ctx.openRegulatoryItems ?? [],
    reconciliationVariancePct: ctx.reconciliationVariancePct ?? null,
    reconciliationThresholdPct: DEFAULT_RECONCILIATION_THRESHOLD_PCT,
    sourceFreshness: ctx.sourceFreshness,
  };
}

/**
 * The primary scenario is the reconciled record. Additional scenarios exist
 * only where the record supports them: an ownership scenario for each
 * competing claim whose fraction is readable, and commodity scenarios only
 * where the buyer actually supplied a downside or upside deck.
 */
export function defaultScenarioDefinitions(input: DecisionInputs): ScenarioDefinition[] {
  const defs: ScenarioDefinition[] = [{
    id: "primary", label: "Record as reconciled", axis: "ownership",
    description: "Ownership exactly as the reviewed instruments support it, with unsupported claims excluded.",
    toggles: "Competing claims excluded",
    ownershipDescription: input.basis.mineralFraction ? `${input.basis.mineralFraction.n}/${input.basis.mineralFraction.d} of the minerals` : "not computable",
    supportedBy: "Reviewed instruments", isPrimary: true,
  }];

  if (input.basis.mineralFraction) {
    for (const f of input.findings) {
      if (f.type !== "UNSUPPORTED_TRANSITION" && f.type !== "OVER_CONVEYANCE") continue;
      const claim = Fraction.parse(f.explanation);
      if (!claim || claim.isZero()) continue;   // unreadable fraction, so no measurable scenario
      const diluted = dilutedFraction(input.basis.mineralFraction, claim.toJSON());
      defs.push({
        id: `admit-${f.findingId}`, label: `${f.findingId} admitted`, axis: "ownership",
        description: `Treats the competing ${claim.toString()} interest as valid, diluting every reconciled holder proportionally.`,
        toggles: `${claim.toString()} competing claim admitted`,
        ownershipDescription: `${diluted.n}/${diluted.d} after dilution`,
        supportedBy: `Instrument cited in ${f.findingId}, whose stated fraction is legible`,
        mineralFractionOverride: diluted, quantifiesFindingId: f.findingId,
      });
    }
  }

  const own = input.basis.mineralFraction ? `${input.basis.mineralFraction.n}/${input.basis.mineralFraction.d} of the minerals` : "not computable";
  if (input.criteria.downsideDeck.value) {
    defs.push({ id: "deck-down", label: "Downside commodity deck", axis: "commodity",
      description: "Ownership unchanged; only the price deck moves to the buyer's downside case.",
      toggles: "Downside price deck", ownershipDescription: own,
      supportedBy: input.criteria.downsideDeck.source, deckOverride: input.criteria.downsideDeck.value });
  }
  if (input.criteria.upsideDeck.value) {
    defs.push({ id: "deck-up", label: "Upside commodity deck", axis: "commodity",
      description: "Ownership unchanged; only the price deck moves to the buyer's upside case.",
      toggles: "Upside price deck", ownershipDescription: own,
      supportedBy: input.criteria.upsideDeck.source, deckOverride: input.criteria.upsideDeck.value });
  }
  return defs;
}
