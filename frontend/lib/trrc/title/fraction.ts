/**
 * Exact rational arithmetic for ownership fractions.
 *
 * Every fraction in the chain engine is a reduced BigInt rational — never a
 * float. A 1/3 interest conveyed twice must sum to exactly 2/3, and an
 * over-conveyance check (3/8 + 3/8 + 3/8 > 1) has to be exact, not "close
 * enough". JSON-safe form is {n, d} with decimal-string numerator and
 * denominator so a fraction survives a round trip through Postgres jsonb
 * and the report download without precision loss.
 *
 * Pure module — no I/O, no dependencies.
 */

export interface FractionJson {
  n: string;
  d: string;
}

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
function pow10(places: number): bigint {
  let r = ONE;
  for (let i = 0; i < places; i++) r = r * TEN;
  return r;
}

export class Fraction {
  readonly n: bigint;
  readonly d: bigint;

  constructor(n: bigint | number | string, d: bigint | number | string = ONE) {
    let nn = BigInt(n);
    let dd = BigInt(d);
    if (dd === ZERO) throw new Error("Fraction: zero denominator");
    if (dd < ZERO) { nn = -nn; dd = -dd; }
    const g = gcd(nn < ZERO ? -nn : nn, dd);
    this.n = g === ZERO ? ZERO : nn / g;
    this.d = g === ZERO ? ONE : dd / g;
  }

  static zero(): Fraction { return new Fraction(ZERO, ONE); }
  static one(): Fraction { return new Fraction(ONE, ONE); }

  static fromJson(j: FractionJson | null | undefined): Fraction | null {
    if (!j) return null;
    try { return new Fraction(BigInt(j.n), BigInt(j.d)); } catch { return null; }
  }

  /**
   * Parses common instrument phrasings: "1/2", "an undivided 3/16ths",
   * "one-half", "1/8th of 8/8ths", "all", "100%", "25%", "0.25", "3/4 of".
   * Returns null rather than guessing when the text carries no fraction.
   */
  static parse(raw: string | null | undefined): Fraction | null {
    if (!raw) return null;
    const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!s) return null;

    if (/^(all|entire|100\s*%|whole|100 percent)$/.test(s) || /\ball of\b/.test(s) && !/\d/.test(s)) return Fraction.one();

    // "1/8th of 8/8ths" style — take the product of successive fractions joined by "of"
    const chain = s.match(/(\d+)\s*\/\s*(\d+)(?:ths?|rds?|nds?)?(?:\s+of\s+(\d+)\s*\/\s*(\d+)(?:ths?|rds?|nds?)?)+/);
    if (chain) {
      const rx = /(\d+)\s*\/\s*(\d+)/g;
      let acc = Fraction.one();
      let p: RegExpExecArray | null;
      while ((p = rx.exec(s)) !== null) acc = acc.mul(new Fraction(BigInt(p[1]), BigInt(p[2])));
      return acc;
    }

    const simple = s.match(/(\d+)\s*\/\s*(\d+)/);
    if (simple) {
      const d = BigInt(simple[2]);
      if (d === ZERO) return null;
      return new Fraction(BigInt(simple[1]), d);
    }

    const pct = s.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
    if (pct) return Fraction.fromDecimalString(pct[1]).div(new Fraction(BigInt(100)));

    const dec = s.match(/(?<![\d/])(0?\.\d+)(?![\d/])/);
    if (dec) return Fraction.fromDecimalString(dec[1]);

    const words = WORD_FRACTIONS.find(([re]) => re.test(s));
    if (words) return words[1];

    return null;
  }

  static fromDecimalString(text: string): Fraction {
    const [intPart, fracPart = ""] = text.split(".");
    const denom = pow10(fracPart.length);
    return new Fraction(BigInt(intPart || "0") * denom + BigInt(fracPart || "0"), denom);
  }

  add(o: Fraction): Fraction { return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Fraction): Fraction { return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Fraction): Fraction { return new Fraction(this.n * o.n, this.d * o.d); }
  div(o: Fraction): Fraction { return new Fraction(this.n * o.d, this.d * o.n); }
  neg(): Fraction { return new Fraction(-this.n, this.d); }

  cmp(o: Fraction): number {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o: Fraction): boolean { return this.cmp(o) === 0; }
  gt(o: Fraction): boolean { return this.cmp(o) > 0; }
  lt(o: Fraction): boolean { return this.cmp(o) < 0; }
  isZero(): boolean { return this.n === ZERO; }
  isNegative(): boolean { return this.n < ZERO; }

  toJSON(): FractionJson { return { n: this.n.toString(), d: this.d.toString() }; }
  toString(): string { return this.d === ONE ? this.n.toString() : `${this.n}/${this.d}`; }
  toDecimal(places = 8): string {
    const scale = pow10(places);
    const scaled = (this.n * scale) / this.d;
    const neg = scaled < ZERO;
    const abs = neg ? -scaled : scaled;
    const int = abs / scale;
    const frac = (abs % scale).toString().padStart(places, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== ZERO) { const t = a % b; a = b; b = t; }
  return a;
}

const WORD_FRACTIONS: Array<[RegExp, Fraction]> = [
  [/\bone[- ]half\b/, new Fraction(ONE, BigInt(2))],
  [/\bone[- ]third\b/, new Fraction(ONE, BigInt(3))],
  [/\btwo[- ]thirds\b/, new Fraction(BigInt(2), BigInt(3))],
  [/\bone[- ]fourth\b|\bone[- ]quarter\b/, new Fraction(ONE, BigInt(4))],
  [/\bthree[- ]fourths\b|\bthree[- ]quarters\b/, new Fraction(BigInt(3), BigInt(4))],
  [/\bone[- ]eighth\b/, new Fraction(ONE, BigInt(8))],
  [/\bthree[- ]eighths\b/, new Fraction(BigInt(3), BigInt(8))],
  [/\bone[- ]sixteenth\b/, new Fraction(ONE, BigInt(16))],
  [/\bthree[- ]sixteenths\b/, new Fraction(BigInt(3), BigInt(16))],
  [/\bone[- ]thirty[- ]second\b/, new Fraction(ONE, BigInt(32))],
];

/** Sums a list, returning null if any entry is null (an unknown term makes the total unknown). */
export function sumFractions(list: Array<Fraction | null>): Fraction | null {
  let acc = Fraction.zero();
  for (const f of list) {
    if (!f) return null;
    acc = acc.add(f);
  }
  return acc;
}
