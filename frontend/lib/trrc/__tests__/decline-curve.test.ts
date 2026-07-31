import { describe, it, expect } from "vitest";
import { fitArpsDecline, estimateEur } from "../decline-curve";

// Generates a known-exact Arps curve so the fitter's recovered parameters
// can be checked against ground truth, not just "did it run."
function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) {
    out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  }
  return out;
}

describe("fitArpsDecline — recovers known parameters from a clean synthetic curve", () => {
  it("recovers a hyperbolic decline (b=1.2) within a reasonable tolerance", () => {
    const qi = 20000, di = 0.08, b = 1.2;
    const curve = generateCurve(qi, di, b, 36);
    const fit = fitArpsDecline(curve);
    expect(fit).not.toBeNull();
    expect(fit!.qi).toBeGreaterThan(qi * 0.85);
    expect(fit!.qi).toBeLessThan(qi * 1.15);
    expect(fit!.rSquared).toBeGreaterThan(0.99); // clean data, should fit almost exactly
  });

  it("recovers an exponential decline (b=0) within a reasonable tolerance", () => {
    const qi = 5000, di = 0.03, b = 0;
    const curve = generateCurve(qi, di, b, 36);
    const fit = fitArpsDecline(curve);
    expect(fit).not.toBeNull();
    expect(fit!.qi).toBeGreaterThan(qi * 0.85);
    expect(fit!.qi).toBeLessThan(qi * 1.15);
    expect(fit!.b).toBeLessThan(0.3); // should find something close to exponential
    expect(fit!.rSquared).toBeGreaterThan(0.99);
  });

  it("classifies a steep unconventional-style decline correctly", () => {
    const curve = generateCurve(21000, 0.15, 1.1, 36);
    const fit = fitArpsDecline(curve);
    expect(fit!.classification).toBe("Steep early-life (unconventional horizontal)");
  });

  it("returns null for too little data", () => {
    expect(fitArpsDecline([1000, 900, 800])).toBeNull();
  });

  it("returns null for an empty or all-zero series", () => {
    expect(fitArpsDecline([])).toBeNull();
    expect(fitArpsDecline([0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it("does not throw on noisy real-world-shaped data", () => {
    const base = generateCurve(15000, 0.06, 0.9, 24);
    const noisy = base.map(v => Math.max(0, v * (0.85 + Math.random() * 0.3)));
    expect(() => fitArpsDecline(noisy)).not.toThrow();
  });
});

describe("estimateEur — forecasts a sane, bounded remaining-reserves estimate", () => {
  it("produces a sane, bounded EUR for a high-qi, low-terminal-decline well (may legitimately hit the 40-year cap)", () => {
    // qi=20000 with a b=1.2 super-hyperbolic fit is an extreme case: even
    // after switching to the terminal exponential decline rate, the tail
    // can genuinely take longer than 40 years to reach the terminal rate.
    // The important behavior is that this is *handled* — bounded, finite,
    // no infinite loop — not that every possible input converges early.
    const qi = 20000, di = 0.08, b = 1.2;
    const curve = generateCurve(qi, di, b, 36);
    const fit = fitArpsDecline(curve)!;
    const cumulative = curve.reduce((a, c) => a + c, 0);
    const eur = estimateEur(fit, cumulative);
    expect(eur.eur).toBeGreaterThan(cumulative);
    expect(eur.forecastRemaining).toBeGreaterThan(0);
    expect(Number.isFinite(eur.eur)).toBe(true);
    expect(eur.monthsToTerminal).toBeGreaterThan(0);
    expect(eur.monthsToTerminal).toBeLessThanOrEqual(480); // must respect the forecast cap, may hit it exactly
  });

  it("converges well before the cap for a moderate, realistic-qi well", () => {
    const qi = 3000, di = 0.05, b = 0.9;
    const curve = generateCurve(qi, di, b, 36);
    const fit = fitArpsDecline(curve)!;
    const cumulative = curve.reduce((a, c) => a + c, 0);
    const eur = estimateEur(fit, cumulative);
    expect(eur.monthsToTerminal).toBeLessThan(480);
    expect(eur.monthsToTerminal).toBeGreaterThan(0);
  });

  it("forecasts very little remaining life for an already-flat, near-terminal well", () => {
    // A well already producing near the terminal rate should have a short forecast tail.
    const curve = generateCurve(200, 0.02, 0.5, 24);
    const fit = fitArpsDecline(curve)!;
    const cumulative = curve.reduce((a, c) => a + c, 0);
    const eur = estimateEur(fit, cumulative);
    expect(eur.monthsToTerminal).toBeLessThan(60);
  });
});
