/**
 * Group 7 — recovery factor and future recoverable oil.
 *
 * Quantities are kept distinct:
 *  - historical recovery: Np / N as of a date;
 *  - estimated ultimate recovery (EUR): N × RF_ultimate for a named process, where
 *    RF_ultimate must come from evidence (a documented study, field performance,
 *    or a displacement calculation from group 8) — never chosen;
 *  - future technically recoverable oil: EUR − Np, for that process;
 *  - commercially recoverable reserves are NOT produced here: they need a defined
 *    development project, costs, prices and commerciality (SPE-PRMS).
 */
import { asFraction, stopped, toStb, used, type Calc, type Input } from "./evidence";
import type { CumulativeProduction } from "./depletion";
import { cornerEnvelope, envelopeFlags, rangedOf } from "./uncertainty";
import type { Envelope } from "./volumetrics";

export type RecoveryProcess = "primary" | "waterflood" | "co2_eor";
export const PROCESS_LABEL: Record<RecoveryProcess, string> = { primary: "primary depletion", waterflood: "waterflood", co2_eor: "CO2 enhanced oil recovery" };
export const NOT_RESERVES = "A technically recoverable resource for the stated process, not reserves: reserves need a defined development project, costs, prices and commerciality (SPE-PRMS).";

const oil = (name: string, x: Input, invalid: string[]) => rangedOf(name, x.value, x.low, x.high, v => (v >= 0 ? toStb(v, x.unit) : null) ?? (invalid.push(`${name} must be a non-negative oil volume, not ${v} ${x.unit}`), null), invalid);
const frac = (name: string, x: Input, invalid: string[], range: [number, number] = [0, 1]) => rangedOf(name, x.value, x.low, x.high, v => asFraction(name, { ...x, value: v }, invalid, range), invalid);

const HIST_EQ = "RF_historical = Np / N";

/** Recovery to date. */
export function historicalRecovery(i: { ooip?: Input; ooipIsOriginal?: boolean; production?: CumulativeProduction; reservoirScope: string; ooipScope?: string }): Calc<Envelope & { asOf: string }> {
  const missing: string[] = [], invalid: string[] = [];
  if (!i.ooip) missing.push("original oil in place for this reservoir");
  else if (i.ooipIsOriginal !== true) invalid.push("the oil-in-place figure is not stated as original oil in place");
  if (!i.production) missing.push("cumulative oil production with its as-of date");
  else if (i.production.attribution.name !== i.reservoirScope) invalid.push(`production is attributed to ${i.production.attribution.name}, not ${i.reservoirScope}`);
  if (i.ooipScope && i.ooipScope !== i.reservoirScope) invalid.push(`oil in place is for ${i.ooipScope}, not ${i.reservoirScope}`);
  if (missing.length || invalid.length) return stopped("historical recovery factor", HIST_EQ, missing, invalid);
  const n = oil("N", i.ooip!, invalid), np = oil("Np", i.production!.oil, invalid);
  if (!n || !np || invalid.length) return stopped("historical recovery factor", HIST_EQ, [], invalid);
  if (np.c > n.c) return stopped("historical recovery factor", HIST_EQ, [], ["cumulative production exceeds original oil in place"]);
  const env = cornerEnvelope([n, np], v => v.Np / v.N);
  return { status: "calculated", quantity: "historical recovery factor", value: { ...env, asOf: i.production!.asOf }, unit: "fraction", equation: HIST_EQ, method: "Cumulative production over original oil in place",
    inputs: [used("original oil in place", "N", i.ooip!, n.c, "stb"), used(`cumulative oil as of ${i.production!.asOf}`, "Np", i.production!.oil, np.c, "stb")],
    flags: [...envelopeFlags(env), `As of ${i.production!.asOf}.`, ...(i.production!.coverage === "partial" ? ["Production covers only part of the history, so this understates recovery to date."] : [])] };
}

const FUTURE_EQ = "EUR = N × RF_ultimate;  future = EUR − Np";

/** Ultimate and future recoverable oil under a named process, from an evidenced ultimate recovery factor. */
export function futureRecoverable(i: { ooip?: Input; ooipIsOriginal?: boolean; production?: CumulativeProduction; ultimateRecoveryFactor?: Input; process: RecoveryProcess; reservoirScope: string }): Calc<{ eur: Envelope; future: Envelope; asOf: string }> {
  const quantity = `future technically recoverable oil (${PROCESS_LABEL[i.process]})`;
  const missing: string[] = [], invalid: string[] = [];
  if (!i.ooip) missing.push("original oil in place for this reservoir");
  else if (i.ooipIsOriginal !== true) invalid.push("the oil-in-place figure is not stated as original oil in place");
  if (!i.ultimateRecoveryFactor) missing.push(`an ultimate recovery factor for ${PROCESS_LABEL[i.process]} supported by evidence (field performance, a documented engineering study, or a displacement calculation) — it is never assumed`);
  if (!i.production) missing.push("cumulative oil production with its as-of date (to subtract what is already produced)");
  else {
    if (i.production.coverage !== "since_first_production") invalid.push("cumulative production must run from first production");
    if (i.production.attribution.name !== i.reservoirScope) invalid.push(`production is attributed to ${i.production.attribution.name}, not ${i.reservoirScope}`);
  }
  if (missing.length || invalid.length) return stopped(quantity, FUTURE_EQ, missing, invalid);
  const n = oil("N", i.ooip!, invalid), np = oil("Np", i.production!.oil, invalid), rf = frac("RF", i.ultimateRecoveryFactor!, invalid);
  if (!n || !np || !rf || invalid.length) return stopped(quantity, FUTURE_EQ, [], invalid);
  const eur = cornerEnvelope([n, rf], v => v.N * v.RF);
  const future = cornerEnvelope([n, np, rf], v => v.N * v.RF - v.Np);
  if (future.central < 0) return stopped(quantity, FUTURE_EQ, [], [`the ultimate recovery factor ${(rf.c * 100).toFixed(1)}% is below the ${((np.c / n.c) * 100).toFixed(1)}% already recovered`]);
  return { status: "calculated", quantity, value: { eur, future, asOf: i.production!.asOf }, unit: "stb", equation: FUTURE_EQ, method: `Evidenced ultimate recovery factor for ${PROCESS_LABEL[i.process]}`,
    inputs: [used("original oil in place", "N", i.ooip!, n.c, "stb"), used(`cumulative oil as of ${i.production!.asOf}`, "Np", i.production!.oil, np.c, "stb"), used("ultimate recovery factor", "RF", i.ultimateRecoveryFactor!, rf.c, "fraction")],
    flags: [...envelopeFlags(future), NOT_RESERVES] };
}

const TRF_EQ = "RF = recovered / in place";

/** A recovery factor from a recoverable volume and the in-place volume it was estimated from. */
export function recoveryFactorOf(i: { recovered?: Input; inPlace?: Input }): Calc {
  const missing: string[] = [], invalid: string[] = [];
  if (!i.recovered) missing.push("recoverable volume"); if (!i.inPlace) missing.push("in-place volume");
  if (missing.length) return stopped("recovery factor", TRF_EQ, missing, invalid);
  const r = oil("recovered", i.recovered!, invalid), n = oil("in place", i.inPlace!, invalid);
  if (!r || !n || invalid.length) return stopped("recovery factor", TRF_EQ, [], invalid);
  if (r.c > n.c) return stopped("recovery factor", TRF_EQ, [], ["recovered volume exceeds the in-place volume"]);
  return { status: "calculated", quantity: "recovery factor", value: r.c / n.c, unit: "fraction", equation: TRF_EQ, method: "Ratio of stated volumes",
    inputs: [used("recovered", "R", i.recovered!, r.c, "stb"), used("in place", "N", i.inPlace!, n.c, "stb")], flags: [] };
}
