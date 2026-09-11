/**
 * The deterministic posture ladder, the confidence decomposition, and the
 * separate closing-readiness ladder.
 *
 * Posture and readiness are produced by different ladders from different
 * inputs, because a deal can be economically attractive and still not be
 * ready to close. Neither is derived from the other.
 *
 * Confidence is decomposed into six domains. The overall figure is the
 * lowest level among the domains that can actually change the decision;
 * a domain that cannot change the decision never drags confidence down.
 * That rule is stated on the report so a reader can check it.
 *
 * Changing behaviour means bumping DECISION_RULE_VERSION, because a stored
 * record carries the version that produced it.
 */

import type {
  AcquisitionPosture, ClosingReadiness, ClosingReadinessResult, ConfidenceAssessment, ConfidenceComponent,
  DecisionConfidence, DecisionInputs, ExceptionImpact, PositionValue, PostureResult,
} from "./decision-types";
import {
  CONFIDENCE_RANK, DECISION_RULE_VERSION, NOT_PROVIDED_LABEL, POSTURE_VS_READINESS_NOTE, READINESS_DISCLAIMER,
} from "./decision-types";

const usd = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

interface Ctx {
  input: DecisionInputs;
  value: PositionValue;
  impacts: ExceptionImpact[];
  /** Blocks closing and no dollar figure was measured. */
  unpriceableBlockers: ExceptionImpact[];
  /** Blocks closing and a dollar figure WAS measured. */
  pricedBlockers: ExceptionImpact[];
  /** Decision-material but does not block closing. */
  decisionMaterialNonBlockers: ExceptionImpact[];
}

interface Rule {
  id: string;
  test: string;
  posture: AcquisitionPosture;
  when: (c: Ctx) => boolean;
  because: (c: Ctx) => string;
}

/** Precedence order. First match wins. */
export const POSTURE_RULES: Rule[] = [
  { id: "R-01", test: "No tract confirmed", posture: "INSUFFICIENT_DATA",
    when: c => c.input.confirmedTractCount === 0,
    because: () => "No candidate tract has been confirmed, so there is no defined asset to evaluate." },
  { id: "R-02", test: "No instrument text reviewed", posture: "INSUFFICIENT_DATA",
    when: c => c.input.verifiedInstrumentCount === 0,
    because: () => "No instrument text has been reviewed. County index entries alone cannot support an ownership conclusion." },
  { id: "R-03", test: "Net revenue interest not computable", posture: "INSUFFICIENT_DATA",
    when: c => c.value.basis.netRevenueInterest == null,
    because: c => `Net revenue interest could not be derived. ${c.value.basis.derivation}` },
  { id: "R-04", test: "Base economic value not modellable", posture: "INSUFFICIENT_DATA",
    when: c => c.value.cases.baseEconomicValueUsd == null,
    because: c => c.value.unavailableReasons.join(" ") || "No base economic value could be modelled." },
  { id: "R-05", test: "Base economic value not positive", posture: "PASS",
    when: c => (c.value.cases.baseEconomicValueUsd ?? 0) <= 0,
    because: () => "The modelled base economic value is not positive, so there is no economic case at any price." },
  { id: "R-06", test: "Asking price above base economic value", posture: "PASS",
    when: c => c.value.askingPriceUsd != null && c.value.cases.baseEconomicValueUsd != null && c.value.askingPriceUsd > c.value.cases.baseEconomicValueUsd,
    because: c => `The asking price of ${usd(c.value.askingPriceUsd!)} exceeds the modelled base economic value of ${usd(c.value.cases.baseEconomicValueUsd!)}, leaving no margin before any exception is priced.` },
  { id: "R-07", test: "A closing blocker exists with no measured impact", posture: "HOLD_FOR_DILIGENCE",
    when: c => c.unpriceableBlockers.length > 0,
    because: c => `${c.unpriceableBlockers.length} closing blocker(s) carry no measurable dollar impact: ${c.unpriceableBlockers.map(i => i.issue).join("; ")}. An unpriceable blocker cannot be offset by an offer adjustment, so the deal is held rather than repriced.` },
  { id: "R-08", test: "Closing blockers exist but every one is measured", posture: "CONDITIONAL_PROCEED",
    when: c => c.pricedBlockers.length > 0,
    because: c => `${c.pricedBlockers.length} closing blocker(s) are measured at ${usd(c.value.cases.quantifiedAssetExposureUsd)} of exposure. They can be priced into an offer or escrowed, but must still be cured before closing.` },
  { id: "R-09", test: "Asking price above the buyer's return ceiling", posture: "CONDITIONAL_PROCEED",
    when: c => c.value.askingPriceUsd != null && c.value.maxAcquisitionPriceUsd != null && c.value.askingPriceUsd > c.value.maxAcquisitionPriceUsd,
    because: c => `The asking price of ${usd(c.value.askingPriceUsd!)} is above the ${usd(c.value.maxAcquisitionPriceUsd!)} ceiling implied by the buyer's stated return criteria, though still below base economic value.` },
  { id: "R-10", test: "A decision-material exception is open", posture: "CONDITIONAL_PROCEED",
    when: c => c.decisionMaterialNonBlockers.length > 0,
    because: c => `${c.decisionMaterialNonBlockers.length} decision-material exception(s) remain open without blocking closing: ${c.decisionMaterialNonBlockers.map(i => i.issue).join("; ")}.` },
  { id: "R-11", test: "Vendor and regulator production disagree beyond threshold", posture: "CONDITIONAL_PROCEED",
    when: c => c.input.reconciliationVariancePct != null && Math.abs(c.input.reconciliationVariancePct) > c.input.reconciliationThresholdPct,
    because: c => `Vendor and regulator volumes disagree by ${c.input.reconciliationVariancePct!.toFixed(2)}%, above the ${c.input.reconciliationThresholdPct.toFixed(2)}% review threshold, so the production basis of the valuation is not yet settled.` },
  { id: "R-12", test: "No blocking condition matched", posture: "PROCEED",
    when: () => true,
    because: () => "No closing blocker, decision-material exception, price ceiling breach, or unresolved production variance was found in the evidence reviewed." },
];

// ─── Confidence, decomposed by domain ───────────────────────────────────────

export const CONFIDENCE_RULE =
  "Overall confidence is the lowest level among the domains that can change the decision. A domain that cannot change the decision is reported but does not cap the overall figure.";

export function assessConfidence(c: Ctx): ConfidenceAssessment {
  const i = c.input;
  const comps: ConfidenceComponent[] = [];

  // Title evidence
  const unreadBearing = i.indexOnlyInstrumentCount > 0;
  const unsupported = c.impacts.some(x => x.type === "UNSUPPORTED_TRANSITION" || x.type === "OVER_CONVEYANCE");
  comps.push({
    domain: "title_evidence",
    level: i.verifiedInstrumentCount === 0 ? "INSUFFICIENT" : (unreadBearing && unsupported) ? "LOW" : (unreadBearing || unsupported) ? "LOW" : i.titleStatus === "NO_SURFACE_DISCONTINUITIES_DETECTED" ? "HIGH" : "MEDIUM",
    canChangeDecision: true,
    reason: i.verifiedInstrumentCount === 0
      ? "No instrument text has been reviewed."
      : [unreadBearing ? `${i.indexOnlyInstrumentCount} indexed instrument(s) remain unread` : null,
         unsupported ? "one conveying party lacks an evidenced acquisition" : null]
        .filter(Boolean).join(" and ") || `${i.verifiedInstrumentCount} instruments read in full with no discontinuity detected.`,
  });

  // Ownership
  const ownershipOpen = c.impacts.filter(x => x.ownershipMaterial && x.quantifiedValueImpactUsd == null).length;
  comps.push({
    domain: "ownership",
    level: c.value.basis.netRevenueInterest == null ? "INSUFFICIENT" : i.unresolvedAllocationCount > 0 || ownershipOpen > 0 ? "LOW" : "HIGH",
    canChangeDecision: true,
    reason: c.value.basis.netRevenueInterest == null
      ? "Net revenue interest is not computable from the evidence available."
      : i.unresolvedAllocationCount > 0
        ? `${i.unresolvedAllocationCount} holding(s) have no stated allocation, and equal shares are never assumed.`
        : ownershipOpen > 0 ? `${ownershipOpen} ownership-material exception(s) remain unmeasured.` : "Every reconciled holding carries a stated exact share.",
  });

  // Production
  const varOver = i.reconciliationVariancePct != null && Math.abs(i.reconciliationVariancePct) > i.reconciliationThresholdPct;
  comps.push({
    domain: "production",
    level: i.remainingOilBbl == null && i.remainingGasMcf == null ? "INSUFFICIENT" : varOver ? "LOW" : i.reconciliationVariancePct == null ? "MEDIUM" : "HIGH",
    canChangeDecision: true,
    reason: i.remainingOilBbl == null && i.remainingGasMcf == null
      ? "No production volumes are available."
      : varOver ? `Vendor and regulator disagree by ${i.reconciliationVariancePct!.toFixed(2)}%, above the ${i.reconciliationThresholdPct.toFixed(2)}% threshold.`
      : i.reconciliationVariancePct == null ? "Only one production source was available; no cross-check was possible."
      : `Vendor and regulator agree within ${i.reconciliationThresholdPct.toFixed(2)}%.`,
  });

  // Forecast
  comps.push({
    domain: "forecast",
    level: i.annualDecline == null ? "INSUFFICIENT" : "MEDIUM",
    canChangeDecision: true,
    reason: i.annualDecline == null ? "No decline basis was supplied." : i.forecastBasisNote,
  });

  // Regulatory — reported, but cannot change this posture on its own
  comps.push({
    domain: "regulatory",
    level: i.openRegulatoryItems.length > 0 ? "MEDIUM" : "HIGH",
    canChangeDecision: false,
    reason: i.openRegulatoryItems.length > 0
      ? `${i.openRegulatoryItems.length} open regulatory item(s): ${i.openRegulatoryItems.join("; ")}`
      : "No open regulatory item against the operator or the well.",
  });

  // Economic model
  const notProvided = Object.entries(i.criteria).filter(([, v]) => (v as { classification: string }).classification === "NOT_PROVIDED").map(([k]) => k);
  comps.push({
    domain: "economic_model",
    level: c.value.cases.baseEconomicValueUsd == null ? "INSUFFICIENT" : notProvided.length > 0 ? "MEDIUM" : "HIGH",
    canChangeDecision: true,
    reason: c.value.cases.baseEconomicValueUsd == null
      ? "No base economic value could be modelled."
      : notProvided.length > 0 ? `${notProvided.length} underwriting criterion(s) not provided: ${notProvided.join(", ")}.`
      : "Every underwriting criterion was supplied and every value is derived from it.",
  });

  const deciding = comps.filter(x => x.canChangeDecision);
  const pool = deciding.length > 0 ? deciding : comps;
  const lowest = pool.reduce((min, x) => (CONFIDENCE_RANK[x.level] < CONFIDENCE_RANK[min.level] ? x : min), pool[0]);

  return {
    overall: lowest.level,
    rule: CONFIDENCE_RULE,
    cappedBy: lowest.domain,
    reason: `${lowest.level} because ${lowest.reason}`,
    components: comps,
  };
}

// ─── Investment thesis, assembled from structured facts ─────────────────────

function buildThesis(c: Ctx, posture: AcquisitionPosture, confidence: DecisionConfidence): string {
  const v = c.value;
  // Assembled from structured facts in a fixed shape:
  //   <economics clause><joiner><evidence clause><confidence>. <trailing caveats>
  // Kept to one main sentence; anything conditional becomes its own short
  // sentence rather than a second subordinate clause, which is what made an
  // earlier version read "though ... but ...".
  const trailing: string[] = [];

  const economics = (() => {
    if (v.cases.baseEconomicValueUsd == null) return "The position cannot be valued from the evidence available";
    if (posture === "PASS" && v.askingPriceUsd != null) return `The asking price of ${usd(v.askingPriceUsd)} exceeds the ${usd(v.cases.baseEconomicValueUsd)} modelled value`;
    if (v.maxAcquisitionPriceUsd != null) return `Current economics support continued acquisition work at prices at or below ${usd(v.maxAcquisitionPriceUsd)}`;
    trailing.push("No buyer return criterion was supplied, so no maximum acquisition price is stated.");
    return `Current economics model the position at ${usd(v.cases.baseEconomicValueUsd)}`;
  })();

  const evidence = (() => {
    const un = c.unpriceableBlockers.length, pr = c.pricedBlockers.length;
    if (un > 0 && pr > 0) {
      trailing.push(`A further ${usd(v.cases.quantifiedAssetExposureUsd)} of measured exposure would need to be priced into any offer.`);
      return "unresolved ownership and encumbrance evidence prevents closing";
    }
    if (un > 0) {
      const kinds = Array.from(new Set(c.unpriceableBlockers.map(i => i.ownershipMaterial ? "ownership" : "encumbrance")));
      return `unresolved ${kinds.join(" and ")} evidence prevents closing`;
    }
    if (pr > 0) return `${usd(v.cases.quantifiedAssetExposureUsd)} of measured title exposure must be priced in and cured before closing`;
    if (c.decisionMaterialNonBlockers.length > 0) return "open decision-material exceptions could still move the price";
    return "no closing blocker was found in the evidence reviewed";
  })();

  const conf = confidence === "HIGH" ? "" : `, at ${confidence.toLowerCase()} confidence`;
  const joiner = posture === "PROCEED" ? " and " : ", but ";
  const main = `${economics}${joiner}${evidence}${conf}.`;
  return [main, ...trailing].join(" ");
}

// ─── Posture ────────────────────────────────────────────────────────────────

export function decidePosture(input: DecisionInputs, value: PositionValue, impacts: ExceptionImpact[]): PostureResult {
  const ctx: Ctx = {
    input, value, impacts,
    unpriceableBlockers: impacts.filter(i => i.blocksClosing && i.quantifiedValueImpactUsd == null),
    pricedBlockers: impacts.filter(i => i.blocksClosing && i.quantifiedValueImpactUsd != null),
    decisionMaterialNonBlockers: impacts.filter(i => i.decisionMaterial && !i.blocksClosing),
  };

  const trace: PostureResult["trace"] = [];
  let fired: Rule | null = null;
  for (const r of POSTURE_RULES) {
    const matched = r.when(ctx);
    trace.push({ ruleId: r.id, matched, test: r.test });
    if (matched) { fired = r; break; }
  }
  const rule = fired ?? POSTURE_RULES[POSTURE_RULES.length - 1];
  const confidence = assessConfidence(ctx);

  const positives: string[] = [];
  const v = value;
  if (v.cases.baseEconomicValueUsd != null && v.cases.baseEconomicValueUsd > 0) {
    positives.push(`Position models to ${usd(v.cases.baseEconomicValueUsd)} at the base deck on a derived net revenue interest of ${v.basis.netRevenueInterest?.toFixed(8)}.`);
  }
  if (v.marginToRiskAdjustedUsd != null && v.marginToRiskAdjustedUsd > 0) {
    positives.push(`Asking price sits ${usd(v.marginToRiskAdjustedUsd)} below the risk-adjusted value, which already carries both the downside deck and measured exposure.`);
  }
  if (input.titleStatus === "NO_SURFACE_DISCONTINUITIES_DETECTED") positives.push("No discontinuities were detected across the instruments reviewed.");
  if (input.verifiedInstrumentCount > 0) positives.push(`${input.verifiedInstrumentCount} instrument(s) were read in full rather than taken from an index.`);
  if (input.unresolvedAllocationCount === 0 && v.basis.netRevenueInterest != null) positives.push("Every reconciled holding carries a stated exact share; no allocation was assumed.");
  if (input.openRegulatoryItems.length === 0) positives.push("No open regulatory item was found against the operator or the well.");
  if (ctx.pricedBlockers.length > 0 && ctx.unpriceableBlockers.length === 0) positives.push("Every closing blocker carries a measured dollar impact, so each can be priced rather than merely noted.");

  const risks = impacts.map(i =>
    `${i.issue}${i.quantifiedValueImpactUsd != null ? ` — measured at ${usd(i.quantifiedValueImpactUsd)}` : " — not yet measurable"}${i.blocksClosing ? ", blocks closing" : ""}`);

  const assumptions: string[] = [];
  for (const [k, crit] of Object.entries(input.criteria)) {
    const c2 = crit as { classification: string; source: string };
    if (c2.classification === "NOT_PROVIDED") assumptions.push(`${k} was not provided; dependent outputs are withheld rather than defaulted.`);
    else if (c2.classification === "SYSTEM_DEFAULT") assumptions.push(`${k} uses a stated system convention (${c2.source}) rather than a buyer input.`);
  }
  if (v.askingPriceUsd == null) assumptions.push("No asking price was supplied, so price comparisons are shown as thresholds rather than results.");
  if (input.reconciliationVariancePct != null) assumptions.push(`Production basis carries a ${input.reconciliationVariancePct.toFixed(2)}% unreconciled variance between vendor and regulator.`);
  if (v.pvFactor != null && input.annualDecline != null) assumptions.push(`Present-value factor of ${v.pvFactor.toFixed(4)} derived from a ${(input.annualDecline * 100).toFixed(1)}% annual decline, not asserted.`);

  const advance = impacts.filter(i => i.blocksClosing).map(i => i.resolution);
  if (v.askingPriceUsd == null) {
    advance.push(v.maxAcquisitionPriceUsd != null
      ? `Obtain the seller's asking price; the buyer's criteria support up to ${usd(v.maxAcquisitionPriceUsd)}.`
      : `Obtain the seller's asking price and the buyer's minimum margin, neither of which is on file.`);
  }

  const reverse: string[] = [];
  for (const i of impacts.filter(x => x.decisionMaterial)) {
    reverse.push(i.quantifiedValueImpactUsd != null
      ? `${i.issue} resolving against the buyer would remove ${usd(i.quantifiedValueImpactUsd)} of value.`
      : `${i.issue} resolving against the buyer would introduce an unpriced liability.`);
  }
  for (const b of v.breakpoints.filter(x => x.computable)) reverse.push(`${b.variable} ${b.flipsAt}: ${b.consequence}`);

  return {
    posture: rule.posture,
    ruleId: rule.id,
    ruleVersion: DECISION_RULE_VERSION,
    rationale: rule.because(ctx),
    investmentThesis: buildThesis(ctx, rule.posture, confidence.overall),
    trace,
    confidence,
    strongestPositives: positives.slice(0, 5),
    materialRisks: risks,
    unresolvedAssumptions: assumptions,
    conditionsToAdvance: Array.from(new Set(advance)),
    conditionsThatReverse: Array.from(new Set(reverse)).slice(0, 6),
  };
}

// ─── Closing readiness, from its own ladder ─────────────────────────────────

export function assessClosingReadiness(input: DecisionInputs, impacts: ExceptionImpact[], nriComputable: boolean): ClosingReadinessResult {
  const blockers = impacts.filter(i => i.blocksClosing);
  const unpriceable = blockers.filter(i => i.quantifiedValueImpactUsd == null);

  let readiness: ClosingReadiness, ruleId: string, rationale: string;
  if (input.confirmedTractCount === 0 || input.verifiedInstrumentCount === 0 || !nriComputable) {
    readiness = "INSUFFICIENT_EVIDENCE"; ruleId = "C-01";
    rationale = "The evidence file is not complete enough to assess closing at all.";
  } else if (unpriceable.length > 0) {
    readiness = "NOT_READY"; ruleId = "C-02";
    rationale = `${unpriceable.length} closing blocker(s) remain unresolved and unmeasured: ${unpriceable.map(i => i.issue).join("; ")}.`;
  } else if (blockers.length > 0) {
    readiness = "CONDITIONAL"; ruleId = "C-03";
    rationale = `${blockers.length} closing blocker(s) are measured but still require cure or waiver before funds are released.`;
  } else if (input.openReviewItemCount > 0 || input.indexOnlyInstrumentCount > 0) {
    readiness = "CONDITIONAL"; ruleId = "C-04";
    rationale = "No closing blocker stands, but items remain in the review queue or unread in the county index.";
  } else {
    readiness = "READY_FOR_FINAL_REVIEW"; ruleId = "C-05";
    rationale = "No closing blocker and no outstanding review item; the file is assembled for professional review.";
  }

  return {
    readiness, ruleId, rationale,
    disclaimer: READINESS_DISCLAIMER,
    independenceNote: POSTURE_VS_READINESS_NOTE,
    unresolvedTitleIssues: impacts.filter(i => i.ownershipMaterial).map(i => i.issue),
    missingInstruments: impacts.filter(i => i.type === "MISSING_REFERENCED_INSTRUMENT" || i.type === "INDEX_ONLY_EVIDENCE").map(i => i.issue),
    unresolvedRegulatoryIssues: input.openRegulatoryItems,
    unresolvedEconomicAssumptions: [
      ...(input.reconciliationVariancePct != null && Math.abs(input.reconciliationVariancePct) > input.reconciliationThresholdPct
        ? [`Vendor and regulator production differ by ${input.reconciliationVariancePct.toFixed(2)}%, above the ${input.reconciliationThresholdPct.toFixed(2)}% threshold.`] : []),
      ...Object.entries(input.criteria)
        .filter(([, c]) => (c as { classification: string }).classification === "NOT_PROVIDED")
        .map(([k]) => `Buyer criterion "${k}" is ${NOT_PROVIDED_LABEL}.`),
    ],
    requiredProfessionalReview: [
      "Title opinion by a licensed attorney covering the instruments assembled here.",
      ...impacts.filter(i => i.requiresProfessionalReview).map(i => `${i.issue}: requires professional judgement rather than additional data.`),
    ],
    actionsBeforeClosing: Array.from(new Set(blockers.map(i => i.resolution))),
  };
}
