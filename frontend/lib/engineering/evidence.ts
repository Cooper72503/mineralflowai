/**
 * Evidence-carrying inputs and results for MineralFlow's engineering calculations.
 *
 * Every input states its value, unit and source. A calculation either returns a
 * value together with the exact inputs, equation and method that produced it,
 * or it STOPS and names what is missing or invalid. Nothing is defaulted,
 * interpolated or invented: an absent critical parameter is a stop, not a guess.
 */

export type Unit =
  | "fraction" | "percent"
  | "ft" | "acres" | "mi2"
  | "g/cm3" | "ohm-m" | "md" | "us/ft" | "pu"
  | "rb/stb"
  | "rb" | "stb" | "bbl" | "Mstb" | "MMstb"
  | "dimensionless";

export type SourceKind = "published_study" | "core_analysis" | "well_log" | "fluid_study" | "production_record" | "reservoir_map" | "user_entry";

export interface SourceRef {
  kind: SourceKind;
  /** Full citation: report, document or record identifier. */
  citation: string;
  /** Where in the source: exhibit, page, table, depth interval, log run date. */
  locator?: string;
}

/** One measured or published input. `low`/`high` are the documented range, when the source gives one. */
export interface Input {
  value: number;
  unit: Unit;
  source: SourceRef;
  low?: number;
  high?: number;
  /** How the value was obtained (e.g. "core plug average, 12 plugs"). */
  basis?: string;
}

export interface UsedInput { name: string; symbol: string; value: number; unit: Unit; source: SourceRef; basis?: string }

export type Calc<T = number> =
  | { status: "calculated"; quantity: string; value: T; unit: string; equation: string; method: string; inputs: UsedInput[]; flags: string[] }
  | { status: "stopped"; quantity: string; equation: string; missing: string[]; invalid: string[]; reason: string };

export const stopped = (quantity: string, equation: string, missing: string[], invalid: string[]): Calc<never> => ({
  status: "stopped", quantity, equation, missing, invalid,
  reason: [missing.length ? `missing ${missing.join(", ")}` : "", invalid.length ? invalid.join("; ") : ""].filter(Boolean).join("; ") + ". The calculation was not performed.",
});

/** A fraction from an input stated as a fraction or a percent; anything else is invalid. */
export function asFraction(name: string, x: Input | undefined, invalid: string[], range: [number, number] = [0, 1]): number | null {
  if (!x) return null;
  const v = x.unit === "fraction" ? x.value : x.unit === "percent" ? x.value / 100 : NaN;
  if (Number.isNaN(v)) { invalid.push(`${name} must be a fraction or percent, not ${x.unit}`); return null; }
  if (!Number.isFinite(v) || v < range[0] || v > range[1]) { invalid.push(`${name} ${x.value} ${x.unit} is outside ${range[0]}–${range[1]}`); return null; }
  return v;
}

/** A value that must already be in `unit` and inside `range`. */
export function inUnit(name: string, x: Input | undefined, unit: Unit, invalid: string[], range: [number, number] = [-Infinity, Infinity]): number | null {
  if (!x) return null;
  if (x.unit !== unit) { invalid.push(`${name} must be stated in ${unit}, not ${x.unit}`); return null; }
  if (!Number.isFinite(x.value) || x.value < range[0] || x.value > range[1]) { invalid.push(`${name} ${x.value} ${unit} is outside ${range[0]}–${range[1]} ${unit}`); return null; }
  return x.value;
}

export const used = (name: string, symbol: string, x: Input, value = x.value, unit: Unit = x.unit): UsedInput => ({ name, symbol, value, unit, source: x.source, ...(x.basis ? { basis: x.basis } : {}) });
