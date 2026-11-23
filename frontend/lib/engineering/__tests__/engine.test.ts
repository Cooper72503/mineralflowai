import { describe, expect, it } from "vitest";
import type { Input, SourceRef } from "../evidence";
import { archieSaturation, densityPorosity, netPay } from "../petrophysics";
import { hydrocarbonPoreVolume, oilInPlace, oilInPlacePerAcreFoot } from "../volumetrics";
import { GAINES_ROZ_PARTITIONS, ROZ_SOURCE } from "../../geology/san-andres-roz";

const core: SourceRef = { kind: "core_analysis", citation: "Test core report", locator: "Table 2" };
const log: SourceRef = { kind: "well_log", citation: "Test density log", locator: "run 1, 1964-03-02" };
const q = (value: number, unit: Input["unit"], source: SourceRef = core, range?: [number, number]): Input => ({ value, unit, source, ...(range ? { low: range[0], high: range[1] } : {}) });

describe("1. density porosity", () => {
  it("computes φD and carries every input's source", () => {
    const r = densityPorosity({ matrixDensity: q(2.87, "g/cm3"), bulkDensity: q(2.6, "g/cm3", log), fluidDensity: q(1.0, "g/cm3") });
    expect(r.status).toBe("calculated");
    if (r.status !== "calculated") return;
    expect(r.value).toBeCloseTo(0.1444, 4);
    expect(r.inputs.map(x => x.source.citation)).toEqual(["Test core report", "Test density log", "Test core report"]);
  });
  it("stops, naming the cause, when the bulk density exceeds the matrix density or an input is missing", () => {
    const anhydrite = densityPorosity({ matrixDensity: q(2.87, "g/cm3"), bulkDensity: q(2.95, "g/cm3", log), fluidDensity: q(1.0, "g/cm3") });
    expect(anhydrite).toMatchObject({ status: "stopped" });
    if (anhydrite.status === "stopped") expect(anhydrite.invalid[0]).toMatch(/exceeds the stated matrix density/);
    const none = densityPorosity({ bulkDensity: q(2.6, "g/cm3", log) });
    expect(none).toMatchObject({ status: "stopped", missing: ["matrix density", "fluid density"] });
    expect(densityPorosity({ matrixDensity: q(2870, "ft"), bulkDensity: q(2.6, "g/cm3"), fluidDensity: q(1, "g/cm3") }).status).toBe("stopped");
  });
});

describe("2. Archie saturation", () => {
  it("computes Sw and So and states the saturation is as of the log run", () => {
    const r = archieSaturation({ a: q(1, "dimensionless"), m: q(2, "dimensionless"), n: q(2, "dimensionless"), rw: q(0.05, "ohm-m"), rt: q(20, "ohm-m", log), porosity: q(20, "percent", core) });
    expect(r.status).toBe("calculated");
    if (r.status !== "calculated") return;
    expect(r.value.sw).toBeCloseTo(0.25, 6);
    expect(r.value.so).toBeCloseTo(0.75, 6);
    expect(r.flags.some(f => /as of the resistivity log run \(run 1, 1964-03-02\)/.test(f))).toBe(true);
  });
  it("reports Sw above 1 as water-bearing instead of a negative oil saturation", () => {
    const r = archieSaturation({ a: q(1, "dimensionless"), m: q(2, "dimensionless"), n: q(2, "dimensionless"), rw: q(0.5, "ohm-m"), rt: q(2, "ohm-m", log), porosity: q(0.1, "fraction") });
    if (r.status !== "calculated") throw Error("expected a result");
    expect(r.value).toEqual({ sw: 1, so: 0 });
    expect(r.flags[0]).toMatch(/water-bearing/);
  });
  it("stops when any Archie parameter is missing", () => {
    const r = archieSaturation({ rw: q(0.05, "ohm-m"), rt: q(20, "ohm-m"), porosity: q(0.2, "fraction") });
    expect(r).toMatchObject({ status: "stopped", missing: ["tortuosity factor a", "cementation exponent m", "saturation exponent n"] });
  });
});

describe("3. net pay", () => {
  const cut = { porosityMin: { value: 0.06, source: core, basis: "6% porosity cutoff used by the study" }, swMax: { value: 0.6, source: core, basis: "test" } };
  it("counts only the intervals that meet every cutoff", () => {
    const r = netPay([
      { topFt: 5000, baseFt: 5010, porosity: 0.12, sw: 0.4, source: log },
      { topFt: 5010, baseFt: 5030, porosity: 0.04, sw: 0.4, source: log },
      { topFt: 5030, baseFt: 5040, porosity: 0.10, sw: 0.8, source: log },
      { topFt: 5040, baseFt: 5050, porosity: 0.08, sw: 0.5, source: log },
    ], cut);
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.grossFt).toBe(50);
    expect(r.value.netFt).toBe(20);
    expect(r.value.netPorosity).toBeCloseTo(0.10, 6);
    expect(r.value.netSw).toBeCloseTo((10 * 0.12 * 0.4 + 10 * 0.08 * 0.5) / (10 * 0.12 + 10 * 0.08), 6);
    expect(r.value.intervals[1].failed).toEqual(["porosity 0.04 < 0.06"]);
  });
  it("stops on overlapping intervals, a missing property a cutoff needs, or no cutoff", () => {
    expect(netPay([{ topFt: 5000, baseFt: 5020, porosity: 0.1, sw: 0.3, source: log }, { topFt: 5010, baseFt: 5030, porosity: 0.1, sw: 0.3, source: log }], cut).status).toBe("stopped");
    const noSw = netPay([{ topFt: 5000, baseFt: 5010, porosity: 0.1, source: log }], cut);
    expect(noSw.status === "stopped" && noSw.missing[0]).toMatch(/^sw for 1 interval/);
    expect(netPay([{ topFt: 5000, baseFt: 5010, porosity: 0.1, source: log }], {})).toMatchObject({ status: "stopped", missing: ["at least one justified net-pay cutoff"] });
  });
});

describe("4–5. hydrocarbon pore volume and oil in place", () => {
  const base = { area: q(640, "acres"), netPay: q(100, "ft"), porosity: q(0.10, "fraction"), waterSaturation: q(0.30, "fraction"), fvf: q(1.25, "rb/stb", { kind: "fluid_study", citation: "Test PVT" }), saturationBasis: "initial" as const };
  it("states original oil in place only with an initial saturation", () => {
    const r = oilInPlace(base);
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.quantity).toBe("original oil in place");
    expect(r.value.central).toBeCloseTo(7758 * 640 * 100 * 0.1 * 0.7 / 1.25, 3);
    expect(r.value.low).toBeNull();
    expect(r.flags).toContain("Oil in place is not recoverable oil and not reserves.");
    const present = oilInPlace({ ...base, saturationBasis: "present" });
    expect(present.status === "calculated" && present.quantity).toBe("oil in place at the measured saturation");
  });
  it("gives a low/central/high envelope from documented ranges and names the inputs held fixed", () => {
    const r = oilInPlace({ ...base, area: q(640, "acres", core, [480, 800]), waterSaturation: q(0.30, "fraction", core, [0.25, 0.40]) });
    if (r.status !== "calculated") throw Error(r.reason);
    expect(r.value.low).toBeCloseTo(7758 * 480 * 100 * 0.1 * 0.6 / 1.25, 3);
    expect(r.value.high).toBeCloseTo(7758 * 800 * 100 * 0.1 * 0.75 / 1.25, 3);
    expect(r.value.fixedAtCentral).toEqual(["net pay", "porosity", "oil formation volume factor"]);
    const hcpv = hydrocarbonPoreVolume(base);
    expect(hcpv.status === "calculated" && hcpv.value.central).toBeCloseTo(7758 * 640 * 100 * 0.1 * 0.7, 3);
  });
  it("stops rather than invent a missing or impossible input", () => {
    const { fvf, ...noFvf } = base; void fvf;
    expect(oilInPlace(noFvf)).toMatchObject({ status: "stopped", missing: ["oil formation volume factor (rb/stb)"] });
    expect(oilInPlace({ ...base, saturationBasis: undefined })).toMatchObject({ status: "stopped", missing: ["whether the saturation is initial or present-day"] });
    expect(oilInPlace({ ...base, fvf: q(0.8, "rb/stb") }).status).toBe("stopped");
    expect(oilInPlace({ ...base, oilSaturation: q(0.7, "fraction") }).status).toBe("stopped");
    expect(oilInPlace({ ...base, area: q(640, "acres", core, [700, 800]) }).status).toBe("stopped");
  });
});

describe("validation against published data: DOE/NETL-2020/2627, Gaines County ROZ", () => {
  it("reproduces every published oil-in-place-per-acre-foot figure from the study's own inputs", () => {
    let checked = 0;
    for (const p of GAINES_ROZ_PARTITIONS) for (const [label, u] of [["ROZ 1 higher", p.roz1.higher], ["ROZ 1 lower", p.roz1.lower], ["ROZ 2 higher", p.roz2.higher], ["ROZ 2 lower", p.roz2.lower]] as const) {
      const src: SourceRef = { kind: "published_study", citation: ROZ_SOURCE.report, locator: `${p.propertiesExhibit}, Partition #${p.id}, ${label}` };
      const r = oilInPlacePerAcreFoot({ porosity: q(u.porosity, "fraction", src), oilSaturation: q(u.oilSaturation, "fraction", src), fvf: q(u.fvf, "rb/stb", src), saturationBasis: "present" });
      if (r.status !== "calculated") throw Error(r.reason);
      expect(r.quantity).toBe("oil in place per acre-foot at the measured saturation");
      expect(Math.abs(r.value.central - u.oipBblPerAcreFt)).toBeLessThan(1.5);
      expect(r.inputs.every(x => x.source.citation === "DOE/NETL-2020/2627")).toBe(true);
      checked++;
    }
    expect(checked).toBe(20);
  });
});
