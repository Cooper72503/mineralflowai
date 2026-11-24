/**
 * Group 8 — preliminary waterflood and CO2-EOR screening.
 *
 * Every efficiency and pressure is a documented input; none is assumed. A
 * recoverable volume is only computed for a named target with its own in-place
 * oil, displacement efficiency and sweep — never from regional averages alone.
 */
import { asFraction, inUnit, stopped, toStb, used, type Calc, type Input } from "./evidence";
import { cornerEnvelope, envelopeFlags, rangedOf } from "./uncertainty";
import type { Envelope } from "./volumetrics";
import { NOT_RESERVES, PROCESS_LABEL, type RecoveryProcess } from "./recovery";

const frac = (name: string, x: Input, invalid: string[], range: [number, number] = [0, 1]) => rangedOf(name, x.value, x.low, x.high, v => asFraction(name, { ...x, value: v }, invalid, range), invalid);

// ── Displacement and sweep ───────────────────────────────────────────────────

const ED_EQ = "E_D = (Soi/Boi − Sor/Bo) / (Soi/Boi)   (= (Soi − Sor)/Soi when Bo = Boi)";

/** Microscopic displacement efficiency from the oil saturation at the start of the flood and the residual left by the displacing fluid. */
export function displacementEfficiency(i: { soi?: Input; sor?: Input; boi?: Input; bo?: Input; process: RecoveryProcess }): Calc<Envelope> {
  const missing: string[] = [], invalid: string[] = [];
  if (!i.soi) missing.push("oil saturation at the start of the displacement (Soi)");
  if (!i.sor) missing.push(`residual oil saturation to ${PROCESS_LABEL[i.process]} (Sor), from core floods or a documented study`);
  if ((i.boi && !i.bo) || (!i.boi && i.bo)) invalid.push("give both Boi and Bo, or neither");
  if (missing.length || invalid.length) return stopped("displacement efficiency", ED_EQ, missing, invalid);
  const soi = frac("Soi", i.soi!, invalid), sor = frac("Sor", i.sor!, invalid);
  const boi = i.boi ? inUnit("Boi", i.boi, "rb/stb", invalid, [1, 3]) : 1, bo = i.bo ? inUnit("Bo", i.bo, "rb/stb", invalid, [1, 3]) : 1;
  if (!soi || !sor || boi === null || bo === null || invalid.length) return stopped("displacement efficiency", ED_EQ, [], invalid);
  if (sor.hi >= soi.lo) return stopped("displacement efficiency", ED_EQ, [], [`residual oil saturation (${sor.c}) is not below the starting oil saturation (${soi.c}) across their ranges`]);
  const env = cornerEnvelope([soi, sor], v => (v.Soi / boi - v.Sor / bo) / (v.Soi / boi));
  return { status: "calculated", quantity: `displacement efficiency (${PROCESS_LABEL[i.process]})`, value: env, unit: "fraction", equation: ED_EQ, method: "Saturation change over starting saturation",
    inputs: [used("starting oil saturation", "Soi", i.soi!, soi.c, "fraction"), used("residual oil saturation", "Sor", i.sor!, sor.c, "fraction")], flags: envelopeFlags(env) };
}

const EV_EQ = "E_V = E_A × E_I";

/** Volumetric sweep from documented areal and vertical sweep, or a documented volumetric sweep. */
export function volumetricSweep(i: { areal?: Input; vertical?: Input; volumetric?: Input }): Calc<Envelope> {
  const missing: string[] = [], invalid: string[] = [];
  if (i.volumetric) {
    const ev = frac("E_V", i.volumetric, invalid);
    if (!ev || invalid.length) return stopped("volumetric sweep efficiency", EV_EQ, [], invalid);
    const env = cornerEnvelope([ev], v => v.E_V);
    return { status: "calculated", quantity: "volumetric sweep efficiency", value: env, unit: "fraction", equation: "E_V (documented)", method: "Documented volumetric sweep", inputs: [used("volumetric sweep", "E_V", i.volumetric, ev.c, "fraction")], flags: envelopeFlags(env) };
  }
  if (!i.areal) missing.push("areal sweep efficiency (pattern, mobility ratio) from a documented study or field performance");
  if (!i.vertical) missing.push("vertical sweep efficiency (layering, permeability contrast) from a documented study or simulation");
  if (missing.length) return stopped("volumetric sweep efficiency", EV_EQ, missing, invalid);
  const ea = frac("E_A", i.areal!, invalid), ei = frac("E_I", i.vertical!, invalid);
  if (!ea || !ei || invalid.length) return stopped("volumetric sweep efficiency", EV_EQ, [], invalid);
  const env = cornerEnvelope([ea, ei], v => v.E_A * v.E_I);
  return { status: "calculated", quantity: "volumetric sweep efficiency", value: env, unit: "fraction", equation: EV_EQ, method: "Areal × vertical sweep",
    inputs: [used("areal sweep", "E_A", i.areal!, ea.c, "fraction"), used("vertical sweep", "E_I", i.vertical!, ei.c, "fraction")], flags: envelopeFlags(env) };
}

const M_EQ = "M = (krw/μw) / (kro/μo)";

/** Waterflood mobility ratio at reservoir conditions; M > 1 is unfavourable. */
export function mobilityRatio(i: { krw?: Input; muW?: Input; kro?: Input; muO?: Input }): Calc {
  const missing = (["krw", "muW", "kro", "muO"] as const).filter(k => !i[k]).map(k => ({ krw: "water relative permeability at residual oil (krw)", muW: "water viscosity at reservoir conditions (cp)", kro: "oil relative permeability at initial water (kro)", muO: "oil viscosity at reservoir conditions (cp)" })[k]);
  const invalid: string[] = [];
  if (missing.length) return stopped("mobility ratio", M_EQ, missing, invalid);
  const krw = inUnit("krw", i.krw, "dimensionless", invalid, [0, 1]), kro = inUnit("kro", i.kro, "dimensionless", invalid, [0.0001, 1]);
  const muW = inUnit("water viscosity", i.muW, "cp", invalid, [0.1, 5]), muO = inUnit("oil viscosity", i.muO, "cp", invalid, [0.05, 100_000]);
  if (invalid.length || krw === null || kro === null || muW === null || muO === null) return stopped("mobility ratio", M_EQ, [], invalid);
  const mr = (krw / muW) / (kro / muO);
  return { status: "calculated", quantity: "mobility ratio", value: mr, unit: "dimensionless", equation: M_EQ, method: "End-point mobility ratio",
    inputs: [used("krw", "krw", i.krw!), used("water viscosity", "μw", i.muW!), used("kro", "kro", i.kro!), used("oil viscosity", "μo", i.muO!)],
    flags: [mr > 1 ? "M > 1: water is more mobile than oil; expect early breakthrough and reduced areal sweep." : "M ≤ 1: favourable mobility ratio."] };
}

// ── CO2 miscibility and screening ────────────────────────────────────────────

const MISC_EQ = "miscible when p_reservoir ≥ MMP (and below fracture pressure)";

/** Whether a CO2 flood can be miscible at the documented reservoir pressure. The MMP must be measured (slim tube) or documented for this oil. */
export function co2Miscibility(i: { reservoirPressure?: Input; mmp?: Input; fracturePressure?: Input }): Calc<{ miscible: boolean; marginPsi: number }> {
  const missing: string[] = [], invalid: string[] = [];
  if (!i.reservoirPressure) missing.push("current or planned flood reservoir pressure (psia)");
  if (!i.mmp) missing.push("CO2 minimum miscibility pressure for this oil (slim-tube test or documented value, psia)");
  if (missing.length) return stopped("CO2 miscibility", MISC_EQ, missing, invalid);
  const p = inUnit("reservoir pressure", i.reservoirPressure, "psia", invalid, [14.7, 30_000]), mmp = inUnit("MMP", i.mmp, "psia", invalid, [500, 10_000]);
  const fp = i.fracturePressure ? inUnit("fracture pressure", i.fracturePressure, "psia", invalid, [100, 50_000]) : null;
  if (invalid.length || p === null || mmp === null) return stopped("CO2 miscibility", MISC_EQ, [], invalid);
  const flags = [p >= mmp ? `Reservoir pressure exceeds MMP by ${Math.round(p - mmp)} psi: miscible displacement is possible.` : `Reservoir pressure is ${Math.round(mmp - p)} psi below MMP: the flood would be immiscible unless pressure is raised.`];
  if (fp !== null && mmp >= fp) flags.push("MMP is at or above the fracture pressure: miscibility cannot be reached without fracturing.");
  if (fp === null) flags.push("Fracture pressure not documented: whether the needed pressure is attainable is not established.");
  return { status: "calculated", quantity: "CO2 miscibility", value: { miscible: p >= mmp && (fp === null || mmp < fp), marginPsi: p - mmp }, unit: "psi", equation: MISC_EQ, method: "Pressure versus documented MMP",
    inputs: [used("reservoir pressure", "p", i.reservoirPressure!), used("minimum miscibility pressure", "MMP", i.mmp!), ...(i.fracturePressure ? [used("fracture pressure", "p_frac", i.fracturePressure)] : [])], flags };
}

/** Published screening criteria for miscible CO2 flooding. */
export const CO2_MISCIBLE_CRITERIA = {
  citation: "Taber, J.J., Martin, F.D. and Seright, R.S., 1997, EOR Screening Criteria Revisited — Part 1: Introduction to Screening Criteria and Enhanced Recovery Field Projects, SPE Reservoir Engineering 12(3), SPE-35385-PA (CO2 miscible flooding).",
  apiMin: 22, viscosityMaxCp: 10, oilSaturationMin: 0.2, depthMinFt: 2500,
} as const;

export type CriterionResult = { criterion: string; status: "meets" | "fails" | "undetermined"; detail: string };

/** Preliminary CO2 screen against published criteria. A criterion without a documented value is undetermined, never passed. */
export function co2Screening(i: { apiGravity?: Input; reservoirViscosity?: Input; oilSaturation?: Input; depthFt?: Input }): Calc<{ overall: "meets" | "fails" | "undetermined"; criteria: CriterionResult[] }> {
  const invalid: string[] = [], c = CO2_MISCIBLE_CRITERIA;
  const check = (name: string, x: Input | undefined, unit: Parameters<typeof inUnit>[2] | "fraction", range: [number, number], ok: (v: number) => boolean, rule: string, absent: string): CriterionResult => {
    if (!x) return { criterion: name, status: "undetermined", detail: `${absent} — not documented.` };
    const lo = x.low ?? x.value, hi = x.high ?? x.value;
    const conv = (v: number) => unit === "fraction" ? asFraction(name, { ...x, value: v }, invalid, range as [number, number]) : inUnit(name, { ...x, value: v }, unit, invalid, range);
    const a = conv(lo), b = conv(hi);
    if (a === null || b === null) return { criterion: name, status: "undetermined", detail: "Documented value is invalid." };
    const both = [ok(a), ok(b)];
    return { criterion: name, status: both.every(Boolean) ? "meets" : both.some(Boolean) ? "undetermined" : "fails", detail: `${x.value}${x.low !== undefined ? ` (${x.low}–${x.high})` : ""} ${x.unit}; criterion ${rule}.` };
  };
  const criteria = [
    check("Oil gravity", i.apiGravity, "degAPI", [5, 70], v => v > c.apiMin, `> ${c.apiMin} °API`, "Stock-tank oil gravity"),
    check("Oil viscosity at reservoir conditions", i.reservoirViscosity, "cp", [0.05, 100_000], v => v < c.viscosityMaxCp, `< ${c.viscosityMaxCp} cp`, "Reservoir-condition oil viscosity"),
    check("Oil saturation in the target", i.oilSaturation, "fraction", [0, 1], v => v > c.oilSaturationMin, `> ${c.oilSaturationMin * 100}% of pore volume`, "Current oil saturation of the target interval"),
    check("Depth", i.depthFt, "ft", [100, 30_000], v => v > c.depthMinFt, `> ${c.depthMinFt.toLocaleString()} ft`, "Target depth"),
  ];
  const overall = criteria.some(x => x.status === "fails") ? "fails" : criteria.every(x => x.status === "meets") ? "meets" : "undetermined";
  return { status: "calculated", quantity: "CO2 miscible-flood screening", value: { overall, criteria }, unit: "screen", equation: "each documented property against the published criterion", method: "Preliminary screening (Taber, Martin and Seright 1997)",
    inputs: [...(i.apiGravity ? [used("oil gravity", "API", i.apiGravity)] : []), ...(i.reservoirViscosity ? [used("reservoir oil viscosity", "μo", i.reservoirViscosity)] : []), ...(i.oilSaturation ? [used("oil saturation", "So", i.oilSaturation)] : []), ...(i.depthFt ? [used("depth", "D", i.depthFt)] : [])],
    flags: ["Screening identifies candidates only; it does not establish recoverable oil.", c.citation, ...invalid] };
}

// ── Incremental recovery for a defined process ───────────────────────────────

const INC_EQ = "ΔN = N_target × E_D × E_V";

/** Incremental technically recoverable oil from a target's own in-place oil and documented efficiencies. */
export function incrementalRecovery(i: { targetOil?: Input; displacement?: Calc<Envelope>; sweep?: Calc<Envelope>; process: RecoveryProcess; targetName: string }): Calc<Envelope> {
  const quantity = `incremental technically recoverable oil (${PROCESS_LABEL[i.process]}, ${i.targetName})`;
  const missing: string[] = [], invalid: string[] = [];
  if (!i.targetOil) missing.push(`stock-tank oil in place in the ${i.targetName}`);
  if (!i.displacement || i.displacement.status !== "calculated") missing.push(`displacement efficiency${i.displacement?.status === "stopped" ? ` (${i.displacement.reason})` : ""}`);
  if (!i.sweep || i.sweep.status !== "calculated") missing.push(`volumetric sweep efficiency${i.sweep?.status === "stopped" ? ` (${i.sweep.reason})` : ""}`);
  if (missing.length) return stopped(quantity, INC_EQ, missing, invalid);
  const n = rangedOf("N", i.targetOil!.value, i.targetOil!.low, i.targetOil!.high, v => toStb(v, i.targetOil!.unit) ?? (invalid.push(`target oil must be in stock-tank barrels, not ${i.targetOil!.unit}`), null), invalid);
  if (!n || invalid.length || i.displacement!.status !== "calculated" || i.sweep!.status !== "calculated") return stopped(quantity, INC_EQ, [], invalid);
  const d = i.displacement!.value, s = i.sweep!.value;
  const env = cornerEnvelope([n, { name: "ED", c: d.central, lo: d.low ?? d.central, hi: d.high ?? d.central }, { name: "EV", c: s.central, lo: s.low ?? s.central, hi: s.high ?? s.central }], v => v.N * v.ED * v.EV);
  return { status: "calculated", quantity, value: env, unit: "stb", equation: INC_EQ, method: `Displacement × sweep for ${PROCESS_LABEL[i.process]}`,
    inputs: [used(`oil in place, ${i.targetName}`, "N_target", i.targetOil!, n.c, "stb"), ...i.displacement!.inputs, ...i.sweep!.inputs], flags: [...envelopeFlags(env), NOT_RESERVES] };
}

const UTIL_EQ = "CO2 utilization = purchased CO2 / incremental oil";

/** Net CO2 utilization (Mcf or metric tons per barrel) from stated volumes. */
export function co2Utilization(i: { purchasedCo2?: Input; oilRecovered?: Input }): Calc {
  const missing: string[] = [], invalid: string[] = [];
  if (!i.purchasedCo2) missing.push("purchased CO2 volume (Bcf or million metric tons)"); if (!i.oilRecovered) missing.push("incremental oil recovered");
  if (missing.length) return stopped("CO2 utilization", UTIL_EQ, missing, invalid);
  const oil = toStb(i.oilRecovered!.value, i.oilRecovered!.unit);
  if (oil === null || !(oil > 0)) return stopped("CO2 utilization", UTIL_EQ, [], [`incremental oil must be a positive oil volume, not ${i.oilRecovered!.value} ${i.oilRecovered!.unit}`]);
  const co2 = i.purchasedCo2!;
  if (co2.unit !== "Bcf" && co2.unit !== "MMt") return stopped("CO2 utilization", UTIL_EQ, [], [`purchased CO2 must be in Bcf or MMt, not ${co2.unit}`]);
  const value = co2.unit === "Bcf" ? (co2.value * 1e6) / oil : (co2.value * 1e6) / oil;
  return { status: "calculated", quantity: "CO2 utilization", value, unit: co2.unit === "Bcf" ? "Mcf/bbl" : "t/bbl", equation: UTIL_EQ, method: "Ratio of stated volumes",
    inputs: [used("purchased CO2", "CO2", co2), used("incremental oil", "ΔN", i.oilRecovered!, oil, "stb")], flags: [] };
}
