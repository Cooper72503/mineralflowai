/**
 * Geological volumetrics: hydrocarbon pore volume and oil in place.
 * Calculation groups 4–5 of the MineralFlow engineering engine.
 *
 * Oil in place is not recoverable oil and not reserves. Original oil in place
 * (OOIP) is only stated when the saturation used is the initial one; with a
 * present-day saturation (a log run after production, or a residual oil zone)
 * the result is oil in place at that saturation.
 *
 * Uncertainty: when inputs carry documented low/high values, the result is a
 * deterministic envelope (every input at its least favourable end, then every
 * input at its most favourable end). It is not a probabilistic P90/P10, which
 * needs distributions and correlations the sources must supply.
 */
import { asFraction, inUnit, stopped, used, type Calc, type Input, type UsedInput } from "./evidence";

/** Barrels per acre-foot. */
export const BBL_PER_ACRE_FT = 7758;

export interface Envelope {
  low: number | null; central: number; high: number | null;
  /** Inputs with no documented range, held at their central value in the envelope. */
  fixedAtCentral: string[];
}

export interface VolumetricInputs {
  area?: Input; netPay?: Input; porosity?: Input;
  /** Exactly one of oil or water saturation. */
  oilSaturation?: Input; waterSaturation?: Input;
  /** Initial oil formation volume factor, rb/stb (oil in place only). */
  fvf?: Input;
  /** Whether the saturation is the initial one or a present-day measurement. */
  saturationBasis?: "initial" | "present";
}

type Factor = { name: string; symbol: string; input: Input; c: number; lo: number; hi: number; increasing: boolean };

function factors(i: VolumetricInputs, need: { area: boolean; fvf: boolean }, missing: string[], invalid: string[]): { list: Factor[]; usedInputs: UsedInput[] } | null {
  if (need.area && !i.area) missing.push("reservoir area (acres)");
  if (need.area && !i.netPay) missing.push("net pay (ft)");
  if (!i.porosity) missing.push("porosity");
  if (!i.oilSaturation && !i.waterSaturation) missing.push("oil or water saturation");
  if (i.oilSaturation && i.waterSaturation) invalid.push("give oil saturation or water saturation, not both");
  if (!i.saturationBasis) missing.push("whether the saturation is initial or present-day");
  if (need.fvf && !i.fvf) missing.push("oil formation volume factor (rb/stb)");

  const list: Factor[] = [];
  const range = (name: string, x: Input, conv: (v: number) => number | null) => {
    const c = conv(x.value), lo = x.low === undefined ? c : conv(x.low), hi = x.high === undefined ? c : conv(x.high);
    if (c === null || lo === null || hi === null) return null;
    if (lo > c || hi < c) { invalid.push(`${name} range ${x.low}–${x.high} does not contain ${x.value}`); return null; }
    return { c, lo, hi };
  };
  const add = (name: string, symbol: string, x: Input | undefined, conv: (v: number) => number | null, increasing = true) => {
    if (!x) return;
    const r = range(name, x, conv);
    if (r) list.push({ name, symbol, input: x, ...r, increasing });
  };
  const frac = (name: string, x: Input | undefined, lim: [number, number]) => (v: number) => asFraction(name, x && { ...x, value: v }, invalid, lim);
  const unit = (name: string, x: Input | undefined, u: Parameters<typeof inUnit>[2], lim: [number, number]) => (v: number) => inUnit(name, x && { ...x, value: v }, u, invalid, lim);
  if (need.area) {
    add("reservoir area", "A", i.area, unit("reservoir area", i.area, "acres", [0.01, 5_000_000]));
    add("net pay", "h", i.netPay, unit("net pay", i.netPay, "ft", [0, 5_000]));
  }
  add("porosity", "φ", i.porosity, frac("porosity", i.porosity, [0.005, 0.5]));
  if (i.oilSaturation) add("oil saturation", "So", i.oilSaturation, frac("oil saturation", i.oilSaturation, [0, 1]));
  else if (i.waterSaturation) {
    // (1 − Sw): the low outcome takes the high end of Sw.
    const sw = i.waterSaturation, conv = frac("water saturation", sw, [0, 1]);
    const c = conv(sw.value), lo = sw.high === undefined ? c : conv(sw.high), hi = sw.low === undefined ? c : conv(sw.low);
    if (c !== null && lo !== null && hi !== null) {
      if ((sw.low !== undefined && sw.low > sw.value) || (sw.high !== undefined && sw.high < sw.value)) invalid.push(`water saturation range ${sw.low}–${sw.high} does not contain ${sw.value}`);
      else list.push({ name: "water saturation", symbol: "Sw", input: sw, c: 1 - c, lo: 1 - lo, hi: 1 - hi, increasing: true });
    }
  }
  if (need.fvf) add("oil formation volume factor", "Bo", i.fvf, unit("oil formation volume factor", i.fvf, "rb/stb", [1, 3]), false);
  if (missing.length || invalid.length) return null;
  return {
    list,
    usedInputs: list.map(f => used(f.name, f.symbol, f.input, f.symbol === "Sw" ? 1 - f.c : f.c, f.input.unit === "percent" ? "fraction" : f.input.unit)),
  };
}

function envelope(list: Factor[]): Envelope {
  const product = (pick: (f: Factor) => number) => list.reduce((p, f) => f.increasing ? p * pick(f) : p / pick(f), BBL_PER_ACRE_FT);
  const ranged = list.filter(f => f.lo !== f.c || f.hi !== f.c);
  return {
    central: product(f => f.c),
    low: ranged.length ? product(f => (f.increasing ? f.lo : f.hi)) : null,
    high: ranged.length ? product(f => (f.increasing ? f.hi : f.lo)) : null,
    fixedAtCentral: list.filter(f => !ranged.includes(f)).map(f => f.name),
  };
}

const flagsFor = (i: VolumetricInputs, env: Envelope) => [
  ...(env.low === null ? ["No input carries a documented range, so no low/high outcome is stated."] : env.fixedAtCentral.length ? [`Held at central value (no documented range): ${env.fixedAtCentral.join(", ")}.`] : []),
  ...(i.saturationBasis === "present" ? ["Saturation is present-day, so this is oil in place at that saturation, not original oil in place."] : []),
  "Oil in place is not recoverable oil and not reserves.",
];

// 4 ─ Hydrocarbon pore volume ────────────────────────────────────────────────

const HCPV_EQ = "HCPV = 7758 · A · h · φ · So   (So = 1 − Sw)";

export function hydrocarbonPoreVolume(i: VolumetricInputs): Calc<Envelope> {
  const missing: string[] = [], invalid: string[] = [];
  const f = factors(i, { area: true, fvf: false }, missing, invalid);
  if (!f) return stopped("hydrocarbon pore volume", HCPV_EQ, missing, invalid);
  const env = envelope(f.list);
  return { status: "calculated", quantity: "hydrocarbon pore volume", value: env, unit: "rb", equation: HCPV_EQ, method: "Volumetric, uniform average properties over the stated area", inputs: f.usedInputs, flags: flagsFor(i, env) };
}

// 5 ─ Oil in place ───────────────────────────────────────────────────────────

const OIP_EQ = "N = 7758 · A · h · φ · So / Bo   (So = 1 − Swi for original oil in place)";

export function oilInPlace(i: VolumetricInputs): Calc<Envelope> {
  const quantity = i.saturationBasis === "initial" ? "original oil in place" : "oil in place at the measured saturation";
  const missing: string[] = [], invalid: string[] = [];
  const f = factors(i, { area: true, fvf: true }, missing, invalid);
  if (!f) return stopped(quantity, OIP_EQ, missing, invalid);
  const env = envelope(f.list);
  return { status: "calculated", quantity, value: env, unit: "stb", equation: OIP_EQ, method: "Volumetric, uniform average properties over the stated area", inputs: f.usedInputs, flags: flagsFor(i, env) };
}

const OIP_AF_EQ = "N/(A·h) = 7758 · φ · So / Bo";

/** Oil in place per acre-foot of net pay: the property a published study can state without an area. */
export function oilInPlacePerAcreFoot(i: Omit<VolumetricInputs, "area" | "netPay">): Calc<Envelope> {
  const quantity = i.saturationBasis === "initial" ? "original oil in place per acre-foot" : "oil in place per acre-foot at the measured saturation";
  const missing: string[] = [], invalid: string[] = [];
  const f = factors(i, { area: false, fvf: true }, missing, invalid);
  if (!f) return stopped(quantity, OIP_AF_EQ, missing, invalid);
  const env = envelope(f.list);
  return { status: "calculated", quantity, value: env, unit: "stb/acre-ft", equation: OIP_AF_EQ, method: "Volumetric, per unit of net reservoir", inputs: f.usedInputs, flags: flagsFor(i, env) };
}
