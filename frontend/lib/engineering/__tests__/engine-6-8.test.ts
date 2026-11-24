import { describe, expect, it } from "vitest";
import type { Input, SourceRef } from "../evidence";
import { materialBalanceOoip, remainingOilInPlace, type CumulativeProduction } from "../depletion";
import { futureRecoverable, historicalRecovery, recoveryFactorOf } from "../recovery";
import { co2Miscibility, co2Screening, co2Utilization, displacementEfficiency, incrementalRecovery, mobilityRatio, volumetricSweep } from "../eor";

const doc: SourceRef = { kind: "published_study", citation: "Test study", locator: "Table 1" };
const doe: SourceRef = { kind: "published_study", citation: "DOE/NETL-2020/2627", locator: "Exhibits 2-7 to 2-9" };
const q = (value: number, unit: Input["unit"], source: SourceRef = doc, range?: [number, number]): Input => ({ value, unit, source, ...(range ? { low: range[0], high: range[1] } : {}) });
const prod = (mmbbl: number, extra: Partial<CumulativeProduction> = {}): CumulativeProduction => ({ oil: q(mmbbl, "MMbbl"), asOf: "1979-01-01", coverage: "since_first_production", attribution: { level: "field", name: "Seminole field" }, ...extra });

describe("validation against published values: DOE/NETL-2020/2627, Gaines County", () => {
  it("reproduces every published technical recovery factor (Exhibits 2-7 and 2-8, and the county total)", () => {
    const rows: [number, number, number][] = [[300, 1110, 27], [1150, 3930, 29], [3360, 10820, 31], [3200, 10630, 30], [4120, 14880, 28], [12130, 41370, 29]];
    for (const [tr, oip, pct] of rows) {
      const r = recoveryFactorOf({ recovered: q(tr, "MMbbl", doe), inPlace: q(oip, "MMbbl", doe) });
      if (r.status !== "calculated") throw Error(r.reason);
      expect(Math.round(r.value * 100)).toBe(pct);
    }
  });
  it("reproduces every published CO2 utilization ratio (Exhibit 2-9 by partition; Exhibits 2-8/ES-4 for the county)", () => {
    const mcf: [number, number, string][] = [[1490, 150, "9.9"], [7430, 1030, "7.2"], [31120, 3240, "9.6"], [22700, 2700, "8.4"], [23610, 2980, "7.9"], [86350, 10100, "8.5"], [132190, 12130, "10.9"]];
    const mt: [number, number, string][] = [[79, 150, "0.53"], [393, 1030, "0.38"], [1647, 3240, "0.51"], [1201, 2700, "0.44"], [1249, 2980, "0.42"], [4569, 10100, "0.45"], [6994, 12130, "0.58"]];
    for (const [co2, oil, pub] of mcf) { const r = co2Utilization({ purchasedCo2: q(co2, "Bcf", doe), oilRecovered: q(oil, "MMbbl", doe) }); expect(r.status === "calculated" && (r.value as number).toFixed(1)).toBe(pub); }
    for (const [co2, oil, pub] of mt) { const r = co2Utilization({ purchasedCo2: q(co2, "MMt", doe), oilRecovered: q(oil, "MMbbl", doe) }); expect(r.status === "calculated" && (r.value as number).toFixed(2)).toBe(pub); }
  });
});

describe("6. remaining oil in place", () => {
  it("subtracts cumulative production from OOIP for the same reservoir, dated, with the OOIP range carried", () => {
    const r = remainingOilInPlace({ ooip: q(1100, "MMstb", doc, [1000, 1200]), ooipIsOriginal: true, ooipScope: "Seminole field", production: prod(274), reservoirScope: "Seminole field" });
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.central).toBe(826e6); expect(r.value.low).toBe(726e6); expect(r.value.high).toBe(926e6);
    expect(r.value.asOf).toBe("1979-01-01");
    expect(r.flags.some(f => /does not give where the remaining oil is, its saturation distribution/.test(f))).toBe(true);
  });
  it("stops for a different reservoir, a partial production window, non-original OOIP, or more production than oil", () => {
    expect(remainingOilInPlace({ ooip: q(1100, "MMstb"), ooipIsOriginal: true, production: prod(274, { attribution: { level: "lease", name: "SSAU lease" } }), reservoirScope: "Seminole field" }).status).toBe("stopped");
    expect(remainingOilInPlace({ ooip: q(1100, "MMstb"), ooipIsOriginal: true, production: prod(274, { coverage: "partial" }), reservoirScope: "Seminole field" }).status).toBe("stopped");
    expect(remainingOilInPlace({ ooip: q(1100, "MMstb"), ooipIsOriginal: false, production: prod(274), reservoirScope: "Seminole field" }).status).toBe("stopped");
    const over = remainingOilInPlace({ ooip: q(1.1, "MMstb"), ooipIsOriginal: true, production: prod(274), reservoirScope: "Seminole field" });
    expect(over.status === "stopped" && over.invalid[0]).toMatch(/exceeds original oil in place/);
  });
});

describe("6. material balance (forward-model checks: a tank with known N is rebuilt, then solved)", () => {
  const N = 50e6, boi = 1.3, pi = 4000, swi = 0.25, cw = 3e-6, cf = 4e-6, co = 1.5e-5;
  const init = { pressure: q(pi, "psia"), Boi: q(boi, "rb/stb"), Swi: q(swi, "fraction"), cw: q(cw, "1/psi"), cf: q(cf, "1/psi"), m: q(0, "dimensionless"), bubblePoint: q(2000, "psia") };
  const absent = { kind: "documented_absent" as const, evidence: q(0, "dimensionless") };
  const undersat = (p: number) => { const bo = boi * (1 + co * (pi - p)); const Et = (bo - boi) + boi * (cw * swi + cf) * (pi - p) / (1 - swi); return { date: `p${p}`, pressure: q(p, "psia"), Bo: q(bo, "rb/stb"), Np: q(N * Et / bo, "stb") }; };
  it("recovers N above the bubble point, and the depletion-drive average saturation", () => {
    const pts = [undersat(3600), undersat(3200), undersat(2800)];
    const r = materialBalanceOoip(init, pts, absent);
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.central).toBeCloseTo(N, -1);
    const last = pts[2];
    expect(r.value.averageOilSaturation).toBeCloseTo((1 - swi) * (1 - last.Np.value / N) * (last.Bo.value / boi), 9);
  });
  it("recovers N below the bubble point with free-gas terms", () => {
    const rsi = 600, rs = 450, bo = 1.25, bg = 0.0012, rp = 900, p = 1700;
    const Eo = (bo - boi) + (rsi - rs) * bg, Efw = boi * (cw * swi + cf) * (pi - p) / (1 - swi);
    const np = (N * (Eo + Efw)) / (bo + (rp - rs) * bg);
    const r = materialBalanceOoip({ ...init, Rsi: q(rsi, "scf/stb") }, [{ date: "below pb", pressure: q(p, "psia"), Bo: q(bo, "rb/stb"), Np: q(np, "stb"), Rs: q(rs, "scf/stb"), Bg: q(bg, "rb/scf"), Rp: q(rp, "scf/stb") }], absent);
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.central).toBeCloseTo(N, -1);
    expect(r.value.averageOilSaturation).not.toBeNull();
  });
  it("accounts for documented water influx and states no average saturation when influx exists", () => {
    const p = undersat(3000), we = 2e6, Et = (p.Bo.value - boi) + boi * (cw * swi + cf) * 1000 / (1 - swi);
    const np = (N * Et + we) / p.Bo.value;
    const r = materialBalanceOoip(init, [{ ...p, Np: q(np, "stb"), We: q(we, "rb") }], { kind: "per_point" });
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.central).toBeCloseTo(N, -1);
    expect(r.value.averageOilSaturation).toBeNull();
  });
  it("stops without a statement on water influx, without a bubble point, or with pressure above initial", () => {
    expect(materialBalanceOoip(init, [undersat(3000)]).status).toBe("stopped");
    expect(materialBalanceOoip({ ...init, bubblePoint: undefined }, [undersat(3000)], absent).status).toBe("stopped");
    expect(materialBalanceOoip(init, [{ ...undersat(3000), pressure: q(4500, "psia") }], absent).status).toBe("stopped");
  });
  it("flags inconsistent points rather than hiding them", () => {
    const bad = undersat(2800); bad.Np = q(bad.Np.value * 1.6, "stb");
    const r = materialBalanceOoip(init, [undersat(3600), undersat(3200), bad], absent);
    expect(r.status === "calculated" && r.flags.some(f => /differ by more than 20%/.test(f))).toBe(true);
  });
});

describe("7. recovery factor", () => {
  it("separates historical recovery from ultimate and future recovery, and never calls them reserves", () => {
    const h = historicalRecovery({ ooip: q(1100, "MMstb"), ooipIsOriginal: true, production: prod(274), reservoirScope: "Seminole field" });
    expect(h.status === "calculated" && h.value.central).toBeCloseTo(274 / 1100, 9);
    const f = futureRecoverable({ ooip: q(1100, "MMstb"), ooipIsOriginal: true, production: prod(274), ultimateRecoveryFactor: q(0.4, "fraction", doc, [0.35, 0.45]), process: "waterflood", reservoirScope: "Seminole field" });
    if (f.status !== "calculated") throw Error(f.reason);
    expect(f.value.eur.central).toBeCloseTo(440e6, 0);
    expect(f.value.future.central).toBeCloseTo(166e6, 0);
    expect(f.value.future.low).toBeCloseTo(1100e6 * 0.35 - 274e6, 0);
    expect(f.flags).toContain("A technically recoverable resource for the stated process, not reserves: reserves need a defined development project, costs, prices and commerciality (SPE-PRMS).");
  });
  it("refuses to assume a recovery factor, or one below what is already recovered", () => {
    const none = futureRecoverable({ ooip: q(1100, "MMstb"), ooipIsOriginal: true, production: prod(274), process: "primary", reservoirScope: "Seminole field" });
    expect(none.status === "stopped" && none.missing[0]).toMatch(/never assumed/);
    expect(futureRecoverable({ ooip: q(1100, "MMstb"), ooipIsOriginal: true, production: prod(274), ultimateRecoveryFactor: q(0.2, "fraction"), process: "primary", reservoirScope: "Seminole field" }).status).toBe("stopped");
  });
});

describe("8. EOR screening and displacement", () => {
  it("computes displacement efficiency with ranges, and stops when Sor is not below Soi", () => {
    const r = displacementEfficiency({ soi: q(0.32, "fraction"), sor: q(0.12, "fraction", doc, [0.10, 0.14]), process: "co2_eor" });
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.central).toBeCloseTo(0.625, 9); expect(r.value.low).toBeCloseTo(0.5625, 9); expect(r.value.high).toBeCloseTo(0.6875, 9);
    expect(displacementEfficiency({ soi: q(0.3, "fraction"), sor: q(0.3, "fraction"), process: "waterflood" }).status).toBe("stopped");
    expect(displacementEfficiency({ soi: q(0.3, "fraction"), process: "co2_eor" })).toMatchObject({ status: "stopped" });
  });
  it("multiplies documented areal and vertical sweep, and requires both", () => {
    const r = volumetricSweep({ areal: q(0.7, "fraction"), vertical: q(0.6, "fraction") });
    expect(r.status === "calculated" && r.value.central).toBeCloseTo(0.42, 9);
    expect(volumetricSweep({ areal: q(0.7, "fraction") }).status).toBe("stopped");
  });
  it("judges miscibility only against a documented MMP", () => {
    const r = co2Miscibility({ reservoirPressure: q(2000, "psia"), mmp: q(1300, "psia") });
    expect(r.status === "calculated" && r.value).toEqual({ miscible: true, marginPsi: 700 });
    expect(co2Miscibility({ reservoirPressure: q(2000, "psia") }).status).toBe("stopped");
  });
  it("screens Seminole's documented oil and depth, leaving undocumented criteria undetermined rather than passed", () => {
    const ri116: SourceRef = { kind: "published_study", citation: "RI 116", locator: "Table 7" };
    const r = co2Screening({ apiGravity: q(33.6, "degAPI", ri116), depthFt: q(5240, "ft", ri116, [5240, 5270]) });
    if (r.status !== "calculated") throw Error("screen");
    expect(r.value.criteria.map(c => [c.criterion, c.status])).toEqual([["Oil gravity", "meets"], ["Oil viscosity at reservoir conditions", "undetermined"], ["Oil saturation in the target", "undetermined"], ["Depth", "meets"]]);
    expect(r.value.overall).toBe("undetermined");
  });
  it("computes the mobility ratio and incremental recovery only from documented parts", () => {
    const m = mobilityRatio({ krw: q(0.3, "dimensionless"), muW: q(0.5, "cp"), kro: q(0.8, "dimensionless"), muO: q(1.2, "cp") });
    expect(m.status === "calculated" && m.value).toBeCloseTo(0.9, 9);
    const ed = displacementEfficiency({ soi: q(0.32, "fraction"), sor: q(0.12, "fraction"), process: "co2_eor" });
    const ev = volumetricSweep({ volumetric: q(0.5, "fraction") });
    const inc = incrementalRecovery({ targetOil: q(100, "MMstb"), displacement: ed, sweep: ev, process: "co2_eor", targetName: "test ROZ" });
    expect(inc.status === "calculated" && inc.value.central).toBeCloseTo(100e6 * 0.625 * 0.5, 0);
    expect(incrementalRecovery({ targetOil: q(100, "MMstb"), displacement: ed, sweep: volumetricSweep({}), process: "co2_eor", targetName: "test ROZ" }).status).toBe("stopped");
  });
});
