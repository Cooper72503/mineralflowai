/**
 * Group 6 — depletion and material balance.
 *
 * Remaining oil in place is a reservoir-wide inventory (N − Np). It says nothing
 * about where the remaining oil is, its saturation distribution, or whether it can
 * flow, and it is only valid when OOIP and cumulative production describe the same
 * reservoir and the production record covers its whole history.
 *
 * Material balance (Havlena and Odeh form) estimates OOIP from pressure, PVT and
 * production history:
 *   F  = Np·[Bo + (Rp − Rs)·Bg] + Wp·Bw − Wi·Bw − Gi·Bg
 *   Eo = (Bo − Boi) + (Rsi − Rs)·Bg
 *   Eg = Boi·(Bg/Bgi − 1)
 *   Efw = (1 + m)·Boi·(cw·Swi + cf)·(pi − p)/(1 − Swi)
 *   F − We = N·(Eo + m·Eg + Efw)
 */
import { asFraction, inUnit, stopped, toStb, used, type Calc, type Input, type UsedInput } from "./evidence";
import { cornerEnvelope, envelopeFlags, rangedOf } from "./uncertainty";
import type { Envelope } from "./volumetrics";

/** Cumulative production with its reservoir attribution and the period it covers. */
export interface CumulativeProduction {
  oil: Input;
  /** Date the cumulative is stated as of (YYYY-MM-DD). */
  asOf: string;
  /** Whether the figure runs from first production; a partial window cannot be used for remaining oil. */
  coverage: "since_first_production" | "partial";
  /** The reservoir, field or lease the volume is attributed to, as the source states it. */
  attribution: { level: "reservoir" | "field" | "unit" | "lease" | "well"; name: string };
}

const OIL_UNITS = ["stb", "bbl", "Mstb", "MMstb", "MMbbl"];
const stbOf = (name: string, x: Input, invalid: string[]) => {
  if (!OIL_UNITS.includes(x.unit)) { invalid.push(`${name} must be an oil volume (stb, Mstb, MMstb, MMbbl), not ${x.unit}`); return null; }
  return (v: number) => (v >= 0 && Number.isFinite(v) ? toStb(v, x.unit) : (invalid.push(`${name} ${v} is not a non-negative volume`), null));
};

const REMAINING_EQ = "N_remaining = N − Np";

/** Remaining oil in place: inventory only, and only for one consistently defined reservoir. */
export function remainingOilInPlace(i: { ooip?: Input; ooipIsOriginal?: boolean; ooipScope?: string; production?: CumulativeProduction; reservoirScope: string }): Calc<Envelope & { asOf: string }> {
  const missing: string[] = [], invalid: string[] = [];
  if (!i.ooip) missing.push("original oil in place (stb) for this reservoir");
  else if (i.ooipIsOriginal !== true) invalid.push("the oil-in-place figure is not stated as original oil in place");
  if (!i.production) missing.push("cumulative oil production for this reservoir, with its as-of date");
  else {
    if (i.production.coverage !== "since_first_production") invalid.push(`cumulative production covers only part of the reservoir's history (as of ${i.production.asOf}); remaining oil needs production since first production`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.production.asOf)) invalid.push("cumulative production needs an as-of date (YYYY-MM-DD)");
    if (i.production.attribution.name !== i.reservoirScope) invalid.push(`production is attributed to ${i.production.attribution.name}, not ${i.reservoirScope}`);
  }
  if (i.ooip && i.ooipScope && i.ooipScope !== i.reservoirScope) invalid.push(`oil in place is for ${i.ooipScope}, not ${i.reservoirScope}`);
  if (missing.length || invalid.length) return stopped("remaining oil in place", REMAINING_EQ, missing, invalid);
  const nConv = stbOf("original oil in place", i.ooip!, invalid), pConv = stbOf("cumulative oil", i.production!.oil, invalid);
  const n = nConv && rangedOf("N", i.ooip!.value, i.ooip!.low, i.ooip!.high, nConv, invalid);
  const np = pConv && rangedOf("Np", i.production!.oil.value, i.production!.oil.low, i.production!.oil.high, pConv, invalid);
  if (!n || !np || invalid.length) return stopped("remaining oil in place", REMAINING_EQ, [], invalid);
  if (np.c > n.c) return stopped("remaining oil in place", REMAINING_EQ, [], [`cumulative production (${np.c.toLocaleString()} stb) exceeds original oil in place (${n.c.toLocaleString()} stb): the two do not describe the same reservoir, or one is wrong`]);
  const env = cornerEnvelope([n, np], v => v.N - v.Np);
  return { status: "calculated", quantity: "remaining oil in place", value: { ...env, asOf: i.production!.asOf }, unit: "stb", equation: REMAINING_EQ, method: "Reservoir-wide inventory",
    inputs: [used("original oil in place", "N", i.ooip!, n.c, "stb"), used(`cumulative oil as of ${i.production!.asOf}`, "Np", i.production!.oil, np.c, "stb")],
    flags: [...envelopeFlags(env), "Inventory only: it does not give where the remaining oil is, its saturation distribution, or whether it can flow to a well.", `Evaluated as of ${i.production!.asOf}.`] };
}

// ── Material balance ─────────────────────────────────────────────────────────

export interface MbInitial {
  pressure?: Input; Boi?: Input; Swi?: Input; cw?: Input; cf?: Input;
  /** Initial gas-cap to oil-zone hydrocarbon volume ratio; a documented 0 means no gas cap. */
  m?: Input; bubblePoint?: Input;
  /** Needed when any point is below the bubble point or there is a gas cap. */
  Rsi?: Input; Bgi?: Input;
}
export interface MbPoint {
  date: string; pressure?: Input; Np?: Input; Bo?: Input;
  Rp?: Input; Rs?: Input; Bg?: Input; Wp?: Input; Wi?: Input; Gi?: Input; Bw?: Input;
  /** Cumulative water influx (rb), when an aquifer is documented. */
  We?: Input;
}
/** Water influx must be documented either way: per point, or as documented absence. */
export type Aquifer = { kind: "documented_absent"; evidence: Input } | { kind: "per_point" };

const MB_EQ = "F − We = N·(Eo + m·Eg + Efw)  (Havlena–Odeh)";

export function materialBalanceOoip(init: MbInitial, points: MbPoint[], aquifer?: Aquifer): Calc<Envelope & { perPoint: { date: string; F: number; Et: number; N: number }[]; averageOilSaturation: number | null }> {
  const missing: string[] = [], invalid: string[] = [];
  const req = (name: string, x: Input | undefined, unit: Parameters<typeof inUnit>[2], range: [number, number]) => { if (!x) { missing.push(name); return null; } return inUnit(name, x, unit, invalid, range); };
  const pi = req("initial reservoir pressure (psia)", init.pressure, "psia", [14.7, 30_000]);
  const boi = req("initial oil FVF Boi (rb/stb)", init.Boi, "rb/stb", [1, 3]);
  const swi = init.Swi ? asFraction("initial water saturation", init.Swi, invalid, [0, 0.95]) : (missing.push("initial water saturation Swi"), null);
  const cw = req("water compressibility cw (1/psi)", init.cw, "1/psi", [1e-7, 1e-4]);
  const cf = req("formation compressibility cf (1/psi)", init.cf, "1/psi", [1e-7, 1e-3]);
  const m = init.m ? inUnit("gas-cap ratio m", init.m, "dimensionless", invalid, [0, 10]) : (missing.push("gas-cap ratio m (documented 0 if no gas cap)"), null);
  const pb = req("bubble-point pressure (psia)", init.bubblePoint, "psia", [14.7, 30_000]);
  if (!aquifer) missing.push("water influx: per-point cumulative influx, or documented evidence that there is no active aquifer");
  if (!points.length) missing.push("at least one dated pressure and production point");
  if (missing.length || invalid.length || pi === null || boi === null || swi === null || cw === null || cf === null || m === null || pb === null) return stopped("material-balance original oil in place", MB_EQ, missing, invalid);
  const needGas = m > 0 || points.some(p => p.pressure && p.pressure.value < pb);
  const rsi = needGas ? req("initial solution GOR Rsi (scf/stb)", init.Rsi, "scf/stb", [0, 10_000]) : null;
  const bgi = m > 0 ? req("initial gas FVF Bgi (rb/scf)", init.Bgi, "rb/scf", [1e-5, 0.1]) : null;

  const perPoint: { date: string; F: number; Et: number; N: number }[] = [];
  const usedInputs: UsedInput[] = [used("initial pressure", "pi", init.pressure!), used("initial oil FVF", "Boi", init.Boi!), used("initial water saturation", "Swi", init.Swi!, swi, "fraction"), used("water compressibility", "cw", init.cw!), used("formation compressibility", "cf", init.cf!), used("gas-cap ratio", "m", init.m!), used("bubble point", "pb", init.bubblePoint!)];
  for (const pt of points) {
    const at = (n: string) => `${n} at ${pt.date}`;
    const p = req(at("pressure (psia)"), pt.pressure, "psia", [14.7, 30_000]);
    const np = pt.Np ? (() => { const c = stbOf(at("Np"), pt.Np!, invalid); return c && c(pt.Np!.value); })() : (missing.push(at("cumulative oil Np")), null);
    const bo = req(at("oil FVF Bo (rb/stb)"), pt.Bo, "rb/stb", [1, 3]);
    const opt = (x: Input | undefined, name: string, unit: Parameters<typeof inUnit>[2], range: [number, number]) => x ? inUnit(at(name), x, unit, invalid, range) : 0;
    const wp = pt.Wp ? (() => { const c = stbOf(at("Wp"), pt.Wp!, invalid); return c && c(pt.Wp!.value); })() ?? 0 : 0;
    const wi = pt.Wi ? (() => { const c = stbOf(at("Wi"), pt.Wi!, invalid); return c && c(pt.Wi!.value); })() ?? 0 : 0;
    const bw = (wp || wi) ? req(at("water FVF Bw (rb/stb)"), pt.Bw, "rb/stb", [0.9, 1.2]) : 1;
    const below = p !== null && p < pb;
    const rs = below ? req(at("solution GOR Rs (scf/stb)"), pt.Rs, "scf/stb", [0, 10_000]) : rsi ?? 0;
    const bg = below || m > 0 ? req(at("gas FVF Bg (rb/scf)"), pt.Bg, "rb/scf", [1e-5, 0.1]) : 0;
    const rp = below ? req(at("cumulative produced GOR Rp (scf/stb)"), pt.Rp, "scf/stb", [0, 100_000]) : (rs ?? 0);
    const gi = opt(pt.Gi, "injected gas Gi (scf)", "scf", [0, 1e15]);
    if (gi && !bg) missing.push(at("gas FVF Bg for injected gas"));
    const we = aquifer?.kind === "per_point" ? (pt.We ? inUnit(at("water influx We (rb)"), pt.We, "rb", invalid, [0, 1e12]) : (missing.push(at("cumulative water influx We")), null)) : 0;
    if (p === null || np === null || bo === null || rs === null || bg === null || rp === null || bw === null || we === null || gi === null) continue;
    if (p > pi) invalid.push(at(`pressure ${p} psia exceeds initial pressure ${pi} psia; repressurization needs injection documented at this point`));
    const F = np * (bo + (rp - rs) * bg) + wp * bw - wi * bw - gi * bg;
    const Eo = (bo - boi) + ((rsi ?? rs) - rs) * bg;
    const Eg = m > 0 ? boi * (bg / bgi! - 1) : 0;
    const Efw = (1 + m) * boi * (cw * swi + cf) * (pi - p) / (1 - swi);
    const Et = Eo + m * Eg + Efw;
    if (!(Et > 0)) { invalid.push(at(`total expansion Et = ${Et.toExponential(3)} rb/stb is not positive; this point carries no material-balance information`)); continue; }
    perPoint.push({ date: pt.date, F, Et, N: (F - we) / Et });
    usedInputs.push(used(at("pressure"), "p", pt.pressure!), used(at("cumulative oil"), "Np", pt.Np!, np, "stb"), used(at("oil FVF"), "Bo", pt.Bo!));
  }
  if (missing.length || invalid.length || !perPoint.length) return stopped("material-balance original oil in place", MB_EQ, missing, invalid);
  // Least squares through the origin: N = Σ Et·(F − We) / Σ Et².
  const n = perPoint.reduce((s, x) => s + x.Et * x.N * x.Et, 0) / perPoint.reduce((s, x) => s + x.Et * x.Et, 0);
  const env: Envelope = perPoint.length > 1 ? { central: n, low: Math.min(...perPoint.map(x => x.N)), high: Math.max(...perPoint.map(x => x.N)), fixedAtCentral: [] } : { central: n, low: null, high: null, fixedAtCentral: [] };
  const last = points[points.length - 1];
  // (1 − Swi)(1 − Np/N)(Bo/Boi) holds for depletion with no influx, injection or gas cap.
  const volumetric = aquifer?.kind === "documented_absent" && m === 0 && points.every(p => !p.Wi && !p.Gi);
  const so = volumetric && last.Bo && last.Np ? (1 - swi) * (1 - (toStb(last.Np.value, last.Np.unit) ?? NaN) / n) * (last.Bo.value / boi) : null;
  const spread = perPoint.length > 1 ? (env.high! - env.low!) / n : 0;
  return { status: "calculated", quantity: "material-balance original oil in place", value: { ...env, perPoint, averageOilSaturation: so !== null && Number.isFinite(so) && so >= 0 ? so : null }, unit: "stb", equation: MB_EQ, method: perPoint.length > 1 ? `Least-squares fit through the origin over ${perPoint.length} dated points` : "Single dated point",
    inputs: usedInputs, flags: [
      perPoint.length > 1 ? `Low/high are the spread of single-point estimates (${(spread * 100).toFixed(1)}% of the fit), a consistency check rather than a propagated input range.` : "One point gives no consistency check; at least three dated points are normally needed.",
      ...(spread > 0.2 ? ["Single-point estimates differ by more than 20%: the drive mechanism, influx or PVT data may be wrong for this reservoir."] : []),
      ...(so !== null ? [`Average remaining oil saturation ${(so * 100).toFixed(1)}% as of ${last.date}: a reservoir average for volumetric depletion (no influx or injection documented), not a saturation distribution.`] : ["No average remaining saturation is stated: it needs documented absence of water influx and injection."]),
    ] };
}
