import { describe, it, expect } from "vitest";
import { offersFor, decideLease, decideDeal, type LeaseSignals } from "../underwriting";
import type { InterestValuation } from "../../ownership/interest-value";
import type { LeaseOwnership } from "../../ownership/mineral-roll";

const valued = (over: Partial<InterestValuation> = {}): InterestValuation => ({
  status: "valued", reason: null, priceBasis: "Live EIA", loeUsdPerBoe: 13.75, producingWells: 2, leaseNri: 0.78, leaseNriBasis: null,
  economicLimitMonths: { stress: 90, base: 120, upside: 150 }, economicLimitAtHorizonCap: false,
  royaltyUnitPv10: { stress: 4_000_000, base: 6_000_000, upside: 8_000_000 }, royaltyUnitPv15: { stress: 3_500_000, base: 5_000_000, upside: 7_000_000 },
  workingInterestPv10: { stress: 2_000_000, base: 4_000_000, upside: 6_000_000 }, workingInterestPv15: { stress: 1_800_000, base: 3_500_000, upside: 5_000_000 },
  baseForecast: { oilBbl: [1], gasMcf: [1] }, remainingOilBbl: 100_000, remainingGasMcf: 200_000, owners: [], totalsPv10: { stress: 1, base: 1, upside: 1 }, ...over,
});
const owned: LeaseOwnership = { status: "matched", rrcLeaseNumber: "1", sources: [], tracts: [], rejectedTracts: [], nameVerified: true, productionShareBasis: null, owners: [], reason: null };
const signals = (over: Partial<LeaseSignals> = {}): LeaseSignals => ({
  valuation: valued(), ownership: owned, fitRSquared: 0.9, monthsOfHistory: 36, trailingUnreportedMonths: 1, currentAnnualDeclinePct: 20,
  producingWells: 2, prorationWells: 2, shutInWells: 0, formsLackingWells: 0, regulatoryCritical: [], regulatoryImportant: [],
  title: { status: "published", readInstruments: 5, indexedInstruments: 20, reason: null }, excludedMembers: 0, ...over,
});

describe("offersFor", () => {
  it("prices a royalty decimal from downside PV-10 to base PV-15, capped at base PV-10", () => {
    const o = offersFor(valued());
    expect(o.status).toBe("calculated");
    const [r, w] = o.ranges;
    expect(r.interest).toBe("royalty"); expect(r.low).toBeCloseTo(40_000, 6); expect(r.high).toBeCloseTo(50_000, 6); expect(r.ceiling).toBeCloseTo(60_000, 6);
    expect(w.interest).toBe("working_interest"); expect(w.low).toBeCloseTo(20_000, 6); expect(w.high).toBeCloseTo(35_000, 6); expect(w.ceiling).toBeCloseTo(40_000, 6);
    for (const r of o.ranges) { expect(r.low).toBeLessThanOrEqual(r.high); expect(r.high).toBeLessThanOrEqual(r.ceiling); }
    expect(o.perNra.status).toBe("unavailable");
  });
  it("withholds offers with the valuation's reason", () => {
    const o = offersFor(valued({ status: "unavailable", reason: "No owner on the roll." }));
    expect(o.status).toBe("unavailable");
    expect(o.reason).toBe("No owner on the roll.");
  });
});

describe("decideLease", () => {
  it("buys a valued, owned, well-fit lease subject to title", () => {
    const d = decideLease(signals());
    expect(d.verdict).toBe("BUY");
    expect(d.conditions.some(c => c.startsWith("Title:"))).toBe(true);
  });
  it("passes on a lease at its economic limit or with under a year of life", () => {
    expect(decideLease(signals({ valuation: valued({ status: "unavailable", reason: "The lease is at its economic limit: no volume." }) })).verdict).toBe("PASS");
    expect(decideLease(signals({ valuation: valued({ economicLimitMonths: { stress: 4, base: 8, upside: 12 } }) })).verdict).toBe("PASS");
  });
  it("sends unsupported values to review with the reason", () => {
    const noRoll = decideLease(signals({ ownership: { ...owned, status: "no_match", reason: "No owner carries RRC lease 1." }, valuation: valued({ status: "unavailable", reason: "No owner carries RRC lease 1." }) }));
    expect(noRoll.verdict).toBe("REVIEW");
    expect(noRoll.reasons.join(" ")).toContain("No owner carries RRC lease 1.");
    expect(decideLease(signals({ fitRSquared: 0.4 })).verdict).toBe("REVIEW");
    expect(decideLease(signals({ regulatoryCritical: ["Plugging deadline passed."] })).verdict).toBe("REVIEW");
  });
  it("ranks risks most severe first and keeps title rested on the index as a risk", () => {
    const d = decideLease(signals({ valuation: valued({ economicLimitMonths: { stress: 20, base: 30, upside: 40 } }), title: { status: "not_found", readInstruments: 0, indexedInstruments: 0, reason: "Martin County clerk records are not online." } }));
    expect(d.risks[0].severity).toBe(3);
    expect(d.risks.some(r => r.text.includes("county index"))).toBe(true);
  });
});

describe("decideDeal", () => {
  it("buys the buyable leases and names what it holds or passes", () => {
    const buy = decideLease(signals()), pass = decideLease(signals({ valuation: valued({ economicLimitMonths: { stress: 1, base: 2, upside: 3 } }) }));
    const d = decideDeal([{ name: "A", decision: buy }, { name: "B", decision: pass }]);
    expect(d.verdict).toBe("BUY");
    expect(d.reasons).toEqual(["Buy A within the offer ranges.", "Pass on B."]);
  });
  it("reviews when nothing reconciles", () => {
    expect(decideDeal([]).verdict).toBe("REVIEW");
  });
});
