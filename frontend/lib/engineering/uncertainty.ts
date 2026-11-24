/**
 * Deterministic uncertainty propagation shared by calculation groups 6–8.
 *
 * Each ranged input is evaluated at its documented low and high ends in every
 * combination (corner enumeration); the result's low and high are the extremes
 * found. For functions monotonic in each input this is the exact envelope. Inputs
 * without a documented range are held at their central value and named. It is not
 * a probabilistic P90/P10.
 */
import type { Envelope } from "./volumetrics";

export interface Ranged { name: string; c: number; lo: number; hi: number }

export function cornerEnvelope(vars: Ranged[], f: (v: Record<string, number>) => number): Envelope {
  const central = f(Object.fromEntries(vars.map(v => [v.name, v.c])));
  const ranged = vars.filter(v => v.lo !== v.c || v.hi !== v.c);
  if (!ranged.length || ranged.length > 10) return { central, low: null, high: null, fixedAtCentral: vars.map(v => v.name) };
  let low = Infinity, high = -Infinity;
  for (let mask = 0; mask < 1 << ranged.length; mask++) {
    const point = Object.fromEntries(vars.map(v => [v.name, v.c]));
    ranged.forEach((v, i) => { point[v.name] = mask & (1 << i) ? v.hi : v.lo; });
    const y = f(point);
    if (Number.isFinite(y)) { low = Math.min(low, y); high = Math.max(high, y); }
  }
  return { central, low, high, fixedAtCentral: vars.filter(v => !ranged.includes(v)).map(v => v.name) };
}

/** A ranged value from an input already converted by `conv`; null (with the reason recorded) when the range is invalid. */
export function rangedOf(name: string, value: number, low: number | undefined, high: number | undefined, conv: (x: number) => number | null, invalid: string[]): Ranged | null {
  const c = conv(value), lo = low === undefined ? c : conv(low), hi = high === undefined ? c : conv(high);
  if (c === null || lo === null || hi === null) return null;
  if (lo > c || hi < c) { invalid.push(`${name} range ${low}–${high} does not contain ${value}`); return null; }
  return { name, c, lo, hi };
}

export const envelopeFlags = (env: Envelope): string[] =>
  env.low === null ? ["No input carries a documented range, so no low/high outcome is stated."] : env.fixedAtCentral.length ? [`Held at central value (no documented range): ${env.fixedAtCentral.join(", ")}.`] : [];
