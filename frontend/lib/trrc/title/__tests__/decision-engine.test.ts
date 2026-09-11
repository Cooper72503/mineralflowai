/**
 * Acquisition decision layer — unit behaviour. All inputs are FIXTURES.
 */
import { describe, it, expect } from "vitest";
import { computeNri, computePositionValue, pv10Factor, provided } from "../position-value";
import { buildExceptionImpacts, totalQuantifiedExposure } from "../exception-impact";
import { decidePosture, assessClosingReadiness, assessConfidence, POSTURE_RULES } from "../decision-rules";
import { runScenarios, dilutedFraction } from "../scenarios";
import { buildDecisionRecord, gradeFreshness, ageInDays } from "../decision-record";
import { buildUnderwritingCriteria, defaultScenarioDefinitions, shiftDeck } from "../decision-inputs";
import { DECISION_RULE_VERSION, NOT_PROVIDED_LABEL, NO_ASKING_PRICE_LABEL, NO_THRESHOLD_LABEL, UNQUANTIFIED_LABEL } from "../decision-types";
import type { DecisionInputs } from "../decision-types";
import { goldenInput, GOLDEN_BASE_DECK, F } from "./fixtures/golden-asset";

const withMargin = (i: DecisionInputs, pct: number): DecisionInputs => ({
  ...i, criteria: buildUnderwritingCriteria({
    discountRate: 0.10, minimumMarginPct: pct, baseDeck: GOLDEN_BASE_DECK,
    downsideDeck: shiftDeck(GOLDEN_BASE_DECK, 0.8), upsideDeck: shiftDeck(GOLDEN_BASE_DECK, 1.2), forecastHorizonYears: 20,
  }),
});

function valued(i: DecisionInputs, exposure = 0) {
  const nr = computeNri(i.basis);
  const basis = { ...i.basis, netMineralAcres: nr.netMineralAcres, netRevenueInterest: nr.netRevenueInterest, derivation: nr.derivation };
  return computePositionValue({ basis, criteria: i.criteria, remainingOilBbl: i.remainingOilBbl, remainingGasMcf: i.remainingGasMcf, annualDecline: i.annualDecline, quantifiedAssetExposureUsd: exposure, askingPriceUsd: i.askingPriceUsd });
}
const run = (i: DecisionInputs, exposure = 0, impacts = buildExceptionImpacts(i.findings, {})) => decidePosture(i, valued(i, exposure), impacts);

describe("ownership decimal — exact fractions only", () => {
  it("derives NRI and shows every step", () => {
    const r = computeNri({ grossTractAcres: 160, prorationUnitAcres: 640, mineralFraction: F(1, 4), leaseRoyaltyFraction: F(3, 16) });
    expect(r.netRevenueInterest).toBeCloseTo(0.01171875, 12);
    expect(r.netMineralAcres).toBe(40);
    expect(r.derivation).toMatch(/40\.00 net mineral acres/);
    expect(r.derivation).toMatch(/1\/4 x 1\/4 x 3\/16/);
  });
  it("returns null rather than guessing when any component is absent", () => {
    for (const patch of [{ leaseRoyaltyFraction: null }, { mineralFraction: null }, { prorationUnitAcres: null }, { grossTractAcres: null }]) {
      const r = computeNri({ grossTractAcres: 160, prorationUnitAcres: 640, mineralFraction: F(1, 4), leaseRoyaltyFraction: F(3, 16), ...patch } as never);
      expect(r.netRevenueInterest).toBeNull();
      expect(r.derivation).toMatch(/never inferred from net mineral acres alone/);
    }
  });
});

describe("value cases stay separate from asset exposure", () => {
  it("keeps commodity movement and title exposure in different fields", () => {
    const v = valued(goldenInput(), 5000);
    const c = v.cases;
    expect(c.downsideCommodityValueUsd!).toBeLessThan(c.baseEconomicValueUsd!);
    expect(c.upsideCommodityValueUsd!).toBeGreaterThan(c.baseEconomicValueUsd!);
    // Commodity cases carry NO exposure; the adjusted figures do.
    const clean = valued(goldenInput(), 0);
    expect(c.downsideCommodityValueUsd).toBeCloseTo(clean.cases.downsideCommodityValueUsd!, 6);
    expect(c.evidenceAdjustedValueUsd).toBeCloseTo(c.baseEconomicValueUsd! - 5000, 6);
    expect(c.riskAdjustedValueUsd).toBeCloseTo(c.downsideCommodityValueUsd! - 5000, 6);
    expect(c.quantifiedAssetExposureUsd).toBe(5000);
  });
  it("derives the PV factor from a decline stream", () => {
    expect(pv10Factor(0.202)).toBeGreaterThan(0.65);
    expect(pv10Factor(0.202)).toBeLessThan(0.78);
    expect(pv10Factor(0.5)).toBeGreaterThan(pv10Factor(0.1));  // steep decline front-loads, so discounts less
  });
});

describe("buyer criteria are never invented", () => {
  it("withholds the maximum price and the decision matrix when no margin was supplied", () => {
    const v = valued(goldenInput());
    expect(v.maxAcquisitionPriceUsd).toBeNull();
    expect(v.maxPriceUnavailableReason).toContain(NO_THRESHOLD_LABEL);
    expect(v.decisionMatrix.every(b => !b.available)).toBe(true);
    expect(v.decisionMatrix[0].basis).toBe(NO_THRESHOLD_LABEL);
    expect(v.waterfall.find(w => w.kind === "unavailable")).toBeTruthy();
  });
  it("produces the maximum price once the buyer supplies a margin", () => {
    const v = valued(withMargin(goldenInput(), 0.25));
    expect(v.maxAcquisitionPriceUsd).not.toBeNull();
    expect(v.decisionMatrix.filter(b => b.available)).toHaveLength(3);
    expect(v.decisionMatrix.map(b => b.posture)).toEqual(["CONDITIONAL_PROCEED", "HOLD_FOR_DILIGENCE", "PASS"]);
  });
  it("tags each criterion with a source and classification, and marks absent ones NOT_PROVIDED", () => {
    const c = goldenInput().criteria;
    expect(c.minimumMarginPct.classification).toBe("NOT_PROVIDED");
    expect(c.minimumMarginPct.source).toBe(NOT_PROVIDED_LABEL);
    expect(c.baseDeck.classification).toBe("USER_INPUT");
    expect(c.timingConvention.classification).toBe("SYSTEM_DEFAULT");
    expect(provided(null, "x").classification).toBe("NOT_PROVIDED");
  });
  it("never invents an asking price", () => {
    const v = valued(goldenInput());
    expect(v.askingPriceUsd).toBeNull();
    expect(v.priceToValueRatio).toBeNull();
    expect(v.marginToBaseUsd).toBeNull();
    expect(NO_ASKING_PRICE_LABEL).toBe("ASKING PRICE NOT PROVIDED");
  });
});

describe("exception properties are independent, not inferred", () => {
  it("lets one exception block closing, be measured, and be priceable at the same time", () => {
    const rec = buildDecisionRecord({ input: goldenInput(), scenarioDefinitions: defaultScenarioDefinitions(goldenInput()) });
    const e1 = rec.exceptionImpacts.find(i => i.findingId === "E-01")!;
    expect(e1.blocksClosing).toBe(true);
    expect(e1.decisionMaterial).toBe(true);
    expect(e1.quantifiable).toBe(true);
    expect(e1.quantifiedValueImpactUsd!).toBeLessThan(0);
    expect(e1.ownershipMaterial).toBe(true);
    expect(e1.requiresProfessionalReview).toBe(true);
    expect(e1.decisionEffectNote).toMatch(/must still be cured or waived before closing/i);
  });
  it("distinguishes a blocker that is not decision-material from one that is", () => {
    const rec = buildDecisionRecord({ input: goldenInput(), scenarioDefinitions: defaultScenarioDefinitions(goldenInput()) });
    const enc = rec.exceptionImpacts.find(i => i.findingId === "E-02")!;
    expect(enc.blocksClosing).toBe(true);
    expect(enc.decisionMaterial).toBe(false);      // does not change the price
    expect(enc.quantifiable).toBe(false);
    expect(enc.ownershipMaterial).toBe(false);
    const idx = rec.exceptionImpacts.find(i => i.findingId === "E-04")!;
    expect(idx.blocksClosing).toBe(false);          // but IS decision-material
    expect(idx.decisionMaterial).toBe(true);
  });
  it("separates quantifiable in principle from actually measured", () => {
    const [i] = buildExceptionImpacts([{ ...goldenInput().findings[0] }], {});
    expect(i.quantifiable).toBe(true);
    expect(i.quantifiedValueImpactUsd).toBeNull();
    expect(i.unquantifiedReason).toContain(UNQUANTIFIED_LABEL);
  });
  it("counts only measured adverse impacts toward exposure", () => {
    expect(totalQuantifiedExposure(buildExceptionImpacts(goldenInput().findings, {}))).toBe(0);
  });
});

describe("posture ladder — deterministic, versioned, first match wins", () => {
  it("INSUFFICIENT_DATA on missing tract, unread instruments, or uncomputable NRI", () => {
    expect(run(goldenInput({ confirmedTractCount: 0 })).ruleId).toBe("R-01");
    expect(run(goldenInput({ verifiedInstrumentCount: 0 })).ruleId).toBe("R-02");
    const i = goldenInput(); i.basis.leaseRoyaltyFraction = null;
    expect(run(i).ruleId).toBe("R-03");
  });
  it("PASS when asking price exceeds base economic value", () => {
    const r = run(goldenInput({ askingPriceUsd: 10_000_000 }));
    expect(r.posture).toBe("PASS"); expect(r.ruleId).toBe("R-06");
  });
  it("HOLD_FOR_DILIGENCE while an unpriceable blocker stands", () => {
    const r = run(goldenInput());
    expect(r.posture).toBe("HOLD_FOR_DILIGENCE"); expect(r.ruleId).toBe("R-07");
  });
  it("CONDITIONAL_PROCEED when every blocker is measured", () => {
    const only = goldenInput({ findings: [goldenInput().findings[0]] });
    const impacts = buildExceptionImpacts(only.findings, { "E-01": { valueImpactUsd: -5298, nriFrom: 0.0117, nriTo: 0.0104, note: "m" } });
    const r = decidePosture(only, valued(only, 5298), impacts);
    expect(r.posture).toBe("CONDITIONAL_PROCEED"); expect(r.ruleId).toBe("R-08");
  });
  it("PROCEED only with nothing outstanding", () => {
    const r = run(goldenInput({ findings: [], titleStatus: "NO_SURFACE_DISCONTINUITIES_DETECTED", indexOnlyInstrumentCount: 0, openReviewItemCount: 0, unresolvedAllocationCount: 0, reconciliationVariancePct: null, openRegulatoryItems: [] }));
    expect(r.posture).toBe("PROCEED"); expect(r.ruleId).toBe("R-12");
  });
  it("records every rule evaluated and is reproducible", () => {
    const a = run(goldenInput()), b = run(goldenInput());
    expect(a.trace).toEqual(b.trace);
    expect(a.trace[0].ruleId).toBe("R-01");
    expect(a.trace[a.trace.length - 1].matched).toBe(true);
    expect(a.ruleVersion).toBe(DECISION_RULE_VERSION);
    expect(POSTURE_RULES.map(r => r.id)).toEqual([...POSTURE_RULES].sort((x, y) => x.id.localeCompare(y.id)).map(r => r.id));
  });
});

describe("confidence is decomposed and explained", () => {
  it("reports six domains and caps overall at the lowest decision-changing one", () => {
    const i = goldenInput();
    const c = assessConfidence({ input: i, value: valued(i), impacts: buildExceptionImpacts(i.findings, {}),
      unpriceableBlockers: [], pricedBlockers: [], decisionMaterialNonBlockers: [] } as never);
    expect(c.components).toHaveLength(6);
    expect(c.components.map(x => x.domain).sort()).toEqual(["economic_model", "forecast", "ownership", "production", "regulatory", "title_evidence"]);
    expect(c.overall).toBe("LOW");
    expect(c.cappedBy).toBeTruthy();
    expect(c.reason).toMatch(/because/);
    expect(c.rule).toMatch(/lowest level among the domains that can change the decision/);
  });
  it("does not let a non-decision-changing domain drag the overall figure down", () => {
    const i = goldenInput({ findings: [], titleStatus: "NO_SURFACE_DISCONTINUITIES_DETECTED", indexOnlyInstrumentCount: 0, unresolvedAllocationCount: 0, reconciliationVariancePct: null, openRegulatoryItems: ["something open"] });
    const c = assessConfidence({ input: i, value: valued(i), impacts: [], unpriceableBlockers: [], pricedBlockers: [], decisionMaterialNonBlockers: [] } as never);
    expect(c.components.find(x => x.domain === "regulatory")!.level).toBe("MEDIUM");
    expect(c.components.find(x => x.domain === "regulatory")!.canChangeDecision).toBe(false);
    expect(c.cappedBy).not.toBe("regulatory");
  });
});

describe("posture and closing readiness are independent", () => {
  it("can be economically attractive yet not ready to close", () => {
    const i = goldenInput({ findings: [goldenInput().findings[1]] });   // encumbrance only: blocks, not decision-material
    const impacts = buildExceptionImpacts(i.findings, {});
    const p = decidePosture(i, valued(i), impacts);
    const r = assessClosingReadiness(i, impacts, true);
    expect(p.posture).toBe("HOLD_FOR_DILIGENCE");
    expect(r.readiness).toBe("NOT_READY");
    expect(r.independenceNote).toMatch(/independent/i);
    expect(r.disclaimer).toMatch(/not a statement that title is marketable/i);
  });
  it("reaches READY_FOR_FINAL_REVIEW only with nothing outstanding", () => {
    const r = assessClosingReadiness(goldenInput({ findings: [], indexOnlyInstrumentCount: 0, openReviewItemCount: 0 }), [], true);
    expect(r.readiness).toBe("READY_FOR_FINAL_REVIEW");
  });
});

describe("scenarios propagate ownership to NRI, value, posture and readiness", () => {
  it("dilutes exactly and measures the delta", () => {
    expect(dilutedFraction(F(1, 4), F(1, 8))).toEqual({ n: "2", d: "9" });
    const i = goldenInput();
    const { scenarios, quantifiers } = runScenarios(i, defaultScenarioDefinitions(i), buildExceptionImpacts(i.findings, {}));
    const primary = scenarios.find(s => s.isPrimary)!;
    const admitted = scenarios.find(s => s.id === "admit-E-01")!;
    expect(admitted.netRevenueInterest! / primary.netRevenueInterest!).toBeCloseTo(8 / 9, 12);
    expect(admitted.deltaUsd!).toBeLessThan(0);
    expect(admitted.deltaPct!).toBeCloseTo(-1 / 9, 6);
    expect(quantifiers["E-01"].valueImpactUsd).toBeCloseTo(admitted.deltaUsd!, 6);
    expect(admitted.closingReadiness).toBeTruthy();
  });
  it("separates commodity scenarios from ownership scenarios and builds none unsupported", () => {
    const i = goldenInput();
    const { scenarios } = runScenarios(i, defaultScenarioDefinitions(i), buildExceptionImpacts(i.findings, {}));
    expect(scenarios.filter(s => s.axis === "ownership").length).toBe(2);
    expect(scenarios.filter(s => s.axis === "commodity").length).toBe(2);
    expect(scenarios.every(s => s.supportedBy.length > 0)).toBe(true);
    // Commodity scenarios leave ownership untouched.
    for (const s of scenarios.filter(x => x.axis === "commodity")) {
      expect(s.netRevenueInterest).toBeCloseTo(scenarios.find(x => x.isPrimary)!.netRevenueInterest!, 12);
    }
  });
  it("creates no ownership scenario when the competing fraction is unreadable", () => {
    const i = goldenInput({ findings: [{ ...goldenInput().findings[0], explanation: "A party conveyed an interest with no legible fraction." }] });
    expect(defaultScenarioDefinitions(i).filter(d => d.quantifiesFindingId)).toHaveLength(0);
  });
});

describe("breakpoints tell the reader where the DECISION changes", () => {
  it("names the price above which posture becomes PASS", () => {
    const v = valued(goldenInput());
    const bp = v.breakpoints.find(b => b.consequence.includes("PASS"))!;
    expect(bp.variable).toBe("Asking price vs. modelled value");
    expect(bp.computable).toBe(true);
  });
  it("marks the return-criterion breakpoint uncomputable when no margin was supplied", () => {
    const v = valued(goldenInput());
    const bp = v.breakpoints.find(b => !b.computable)!;
    expect(bp.variable).toBe("Asking price vs. buyer return criterion");
    expect(bp.consequence).toBe(NO_THRESHOLD_LABEL);
    expect(bp.unavailableReason).toContain(NO_THRESHOLD_LABEL);
  });
  it("never lists the same variable twice, which would read as a contradiction", () => {
    for (const v of [valued(goldenInput()), valued({ ...withMargin(goldenInput(), 0.25), askingPriceUsd: 20000 })]) {
      const names = v.breakpoints.map(b => b.variable);
      expect(new Set(names).size).toBe(names.length);
    }
  });
  it("adds an oil-price and an NRI breakpoint once a price and margin exist", () => {
    const v = valued({ ...withMargin(goldenInput(), 0.25), askingPriceUsd: 20000 });
    expect(v.breakpoints.some(b => b.variable === "Oil price")).toBe(true);
    expect(v.breakpoints.some(b => b.variable === "Net revenue interest")).toBe(true);
  });
});

describe("freshness", () => {
  it("grades age against a per-source window and preserves missing sources", () => {
    const graded = gradeFreshness(goldenInput().sourceFreshness, "2026-10-01");
    expect(graded.find(f => f.role === "county")!.status).toBe("current");
    expect(graded.find(f => f.role === "regulator")!.status).toBe("stale");
    expect(graded.find(f => f.role === "regulator")!.note).toMatch(/beyond the 30-day freshness window/);
    expect(graded.find(f => f.role === "county_pre1962")!.status).toBe("missing");
    expect(ageInDays("2026-10-01", "2026-09-01")).toBe(30);
  });
});
