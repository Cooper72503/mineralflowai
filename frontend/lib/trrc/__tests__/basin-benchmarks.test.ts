import { describe, it, expect } from "vitest";
import { classifyBasin, loeMidpoint, checkDeclineAgainstBasin, BASIN_BENCHMARKS } from "../basin-benchmarks";

describe("classifyBasin", () => {
  it("classifies real TRRC field names confirmed live this session", () => {
    // Lease 52210, district 08 (Permian/Sprabery) and lease 253905,
    // district 09 (Barnett Shale) — both real, captured live this session.
    expect(classifyBasin("SPRABERRY (TREND AREA)", "MIDLAND")?.id).toBe("west_tx_conventional");
    expect(classifyBasin("NEWARK, EAST (BARNETT SHALE)", "TARRANT")?.id).toBe("barnett_shale");
  });

  it("falls back to county when field name doesn't match", () => {
    expect(classifyBasin("SOME UNKNOWN FIELD", "KARNES")?.id).toBe("eagle_ford");
  });

  it("returns null rather than guessing when neither field nor county match anything", () => {
    expect(classifyBasin("SOME UNKNOWN FIELD", "SOME UNKNOWN COUNTY")).toBeNull();
    expect(classifyBasin(null, null)).toBeNull();
  });

  it("field-name match takes priority over a county match that would suggest a different basin", () => {
    // Wolfcamp field name in a non-Permian-listed county still classifies as Permian.
    expect(classifyBasin("WOLFCAMP (WOLFCAMP)", "SOME OTHER COUNTY")?.id).toBe("permian_basin");
  });
});

describe("loeMidpoint", () => {
  it("returns the arithmetic midpoint of the basin's LOE range", () => {
    const permian = BASIN_BENCHMARKS.find(b => b.id === "permian_basin")!;
    expect(loeMidpoint(permian)).toBeCloseTo((7.5 + 20) / 2, 4);
  });
});

describe("checkDeclineAgainstBasin", () => {
  it("returns null when the basin has no decline range to compare against", () => {
    const haynesville = BASIN_BENCHMARKS.find(b => b.id === "east_tx_haynesville")!;
    expect(checkDeclineAgainstBasin(haynesville, 50)).toBeNull();
  });

  it("flags a decline rate wildly outside the basin's typical range", () => {
    const permian = BASIN_BENCHMARKS.find(b => b.id === "permian_basin")!;
    const result = checkDeclineAgainstBasin(permian, 99.9); // an extreme, implausible annual decline
    expect(result).not.toBeNull();
    expect(result!.inRange).toBe(false);
  });

  it("does not flag a decline rate within the basin's typical range", () => {
    const permian = BASIN_BENCHMARKS.find(b => b.id === "permian_basin")!;
    // Convert the 2.5-3.0%/mo range to its own annual figure and test the midpoint.
    const midMonthly = 2.75;
    const annual = (1 - Math.pow(1 - midMonthly / 100, 12)) * 100;
    const result = checkDeclineAgainstBasin(permian, annual);
    expect(result!.inRange).toBe(true);
  });
});
