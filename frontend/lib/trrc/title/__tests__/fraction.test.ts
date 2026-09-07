import { describe, it, expect } from "vitest";
import { Fraction, sumFractions } from "../fraction";

describe("Fraction — exact arithmetic", () => {
  it("reduces and sums exactly", () => {
    const third = new Fraction(1, 3);
    expect(third.add(third).toString()).toBe("2/3");
    expect(third.add(third).add(third).eq(Fraction.one())).toBe(true);
    expect(new Fraction(3, 8).add(new Fraction(3, 8)).add(new Fraction(3, 8)).gt(Fraction.one())).toBe(true);
  });

  it("parses instrument phrasings", () => {
    expect(Fraction.parse("an undivided 3/16ths")!.toString()).toBe("3/16");
    expect(Fraction.parse("one-half")!.toString()).toBe("1/2");
    expect(Fraction.parse("1/8th of 8/8ths")!.toString()).toBe("1/8");
    expect(Fraction.parse("1/2 of 1/4")!.toString()).toBe("1/8");
    expect(Fraction.parse("25%")!.toString()).toBe("1/4");
    expect(Fraction.parse("0.125")!.toString()).toBe("1/8");
    expect(Fraction.parse("all")!.toString()).toBe("1");
    expect(Fraction.parse("the land")).toBeNull();
    expect(Fraction.parse("1/0")).toBeNull();
  });

  it("round-trips through JSON without precision loss", () => {
    const f = new Fraction("123456789012345678901234567890", "987654321098765432109876543210");
    const back = Fraction.fromJson(f.toJSON())!;
    expect(back.eq(f)).toBe(true);
  });

  it("sumFractions is null when any term is unknown", () => {
    expect(sumFractions([new Fraction(1, 2), null])).toBeNull();
    expect(sumFractions([new Fraction(1, 2), new Fraction(1, 2)])!.eq(Fraction.one())).toBe(true);
  });

  it("renders decimals for display", () => {
    expect(new Fraction(3, 16).toDecimal(6)).toBe("0.1875");
    expect(new Fraction(1, 3).toDecimal(4)).toBe("0.3333");
  });
});
