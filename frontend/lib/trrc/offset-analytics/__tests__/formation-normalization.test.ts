import { describe, it, expect } from "vitest";
import { normalizeFormation, matchFormations } from "../formation-normalization";

describe("normalizeFormation", () => {
  it("normalizes the real field name confirmed live this session for the Sprabery lease", () => {
    const result = normalizeFormation("SPRABERRY (TREND AREA)");
    expect(result.canonicalFormation).toBe("SPRABERRY");
    expect(result.basin).toBe("Permian Basin");
  });

  it("normalizes the real field name confirmed live this session for the Barnett gas lease", () => {
    const result = normalizeFormation("NEWARK, EAST (BARNETT SHALE)");
    expect(result.canonicalFormation).toBe("BARNETT SHALE");
    expect(result.basin).toBe("Fort Worth Basin");
  });

  it("distinguishes Lower Spraberry from bare Spraberry — does not collapse variants that mean different things", () => {
    const lower = normalizeFormation("LOWER SPRABERRY UNIT");
    const bare = normalizeFormation("SPRABERRY TREND AREA");
    expect(lower.canonicalFormation).toBe("LOWER SPRABERRY");
    expect(bare.canonicalFormation).toBe("SPRABERRY");
    expect(lower.canonicalFormation).not.toBe(bare.canonicalFormation);
  });

  it("checks Wolfcamp sub-bench variants before the bare Wolfcamp catch-all", () => {
    expect(normalizeFormation("WOLFCAMP A").canonicalFormation).toBe("WOLFCAMP A");
    expect(normalizeFormation("SOME WOLFCAMP FIELD").canonicalFormation).toBe("WOLFCAMP");
  });

  it("returns an explicit UNKNOWN profile, never null, for an unrecognized field name", () => {
    const result = normalizeFormation("SOME RANDOM FIELD NAME 123");
    expect(result.canonicalFormation).toBe("UNKNOWN");
    expect(result.confidence).toBe(0);
  });
});

describe("matchFormations — the qualification filter offset-intelligence-engine.ts never had", () => {
  it("accepts SAME_FORMATION when both wells are in the same canonical formation", () => {
    const subject = normalizeFormation("SPRABERRY (TREND AREA)");
    const candidate = normalizeFormation("SPRABERRY UNIT 4");
    const result = matchFormations(subject, candidate);
    expect(result.tier).toBe("SAME_FORMATION");
    expect(result.accepted).toBe(true);
  });

  it("accepts SAME_GROUP_AND_BASIN for related but distinct benches in the same play", () => {
    const subject = normalizeFormation("LOWER SPRABERRY UNIT");
    const candidate = normalizeFormation("UPPER SPRABERRY UNIT");
    const result = matchFormations(subject, candidate);
    expect(result.tier).toBe("SAME_GROUP_AND_BASIN");
    expect(result.accepted).toBe(true);
  });

  it("rejects an incompatible formation in a totally different basin — the core fix vs. the archived version", () => {
    const subject = normalizeFormation("SPRABERRY (TREND AREA)"); // Permian
    const candidate = normalizeFormation("NEWARK, EAST (BARNETT SHALE)"); // Fort Worth Basin
    const result = matchFormations(subject, candidate);
    expect(result.tier).toBe("INCOMPATIBLE");
    expect(result.accepted).toBe(false);
  });

  it("rejects when one side is known and the other unknown, rather than guessing compatibility", () => {
    const subject = normalizeFormation("SPRABERRY (TREND AREA)");
    const candidate = normalizeFormation("SOME UNKNOWN FIELD");
    const result = matchFormations(subject, candidate);
    expect(result.tier).toBe("INCOMPATIBLE");
    expect(result.accepted).toBe(false);
  });

  it("accepts UNKNOWN_BUT_SIMILAR, with a warning, only when BOTH sides are unknown", () => {
    const subject = normalizeFormation("SOME UNKNOWN FIELD A");
    const candidate = normalizeFormation("SOME UNKNOWN FIELD B");
    const result = matchFormations(subject, candidate);
    expect(result.tier).toBe("UNKNOWN_BUT_SIMILAR");
    expect(result.accepted).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
