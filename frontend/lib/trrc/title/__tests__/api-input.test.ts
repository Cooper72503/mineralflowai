import { describe, it, expect } from "vitest";
import { parseApiBatch, parseApiInput } from "../api-input";

describe("parseApiInput — formats, suffixes, validation", () => {
  it("accepts 10-digit dashed and plain forms and preserves leading zeros", () => {
    const a = parseApiInput("42-165-02733");
    expect(a.ok).toBe(true);
    expect(a.api10).toBe("4216502733");
    expect(a.api14).toBe("42165027330000");
    expect(a.countyName).toBe("Gaines");
    expect(parseApiInput("4216502733").api10).toBe("4216502733");
  });

  it("accepts the 8-digit TRRC form and prefixes the Texas state code", () => {
    const a = parseApiInput("165-02733");
    expect(a.ok).toBe(true);
    expect(a.api10).toBe("4216502733");
    expect(a.stateCode).toBe("42");
  });

  it("preserves sidetrack and completion suffixes instead of truncating them", () => {
    const a = parseApiInput("42-165-02733-01-02");
    expect(a.ok).toBe(true);
    expect(a.sidetrackSuffix).toBe("01");
    expect(a.completionSuffix).toBe("02");
    expect(a.api14).toBe("42165027330102");
    expect(a.formatted).toBe("42-165-02733-01-02");
  });

  it("rejects non-Texas state codes and bad county codes with a specific reason", () => {
    expect(parseApiInput("30-015-12345").error).toMatch(/state code 30/);
    expect(parseApiInput("42-002-12345").error).toMatch(/county code 002/);
    // "42-165-027" strips to 8 digits, which is a legitimate county+well form,
    // so the digit-count guard passes it. The segment-shape guard is what
    // catches that the dashes reveal a truncated 10-digit number instead.
    expect(parseApiInput("42-165-027").error).toMatch(/segment lengths/);
    expect(parseApiInput("42-165-ABCDE").error).toMatch(/not digits/);
  });
});

describe("parseApiBatch — batch splitting and deduplication", () => {
  it("splits on spaces, commas, semicolons, and line breaks and never fails the batch on one bad entry", () => {
    const batch = parseApiBatch("42-165-02733, 4232942230;\n42-999-00001 42-165-02733-00-00\tbogus");
    expect(batch.inputs).toHaveLength(5);
    expect(batch.validCount).toBe(2);        // 42-165-02733 and 42-329-42230
    expect(batch.invalidCount).toBe(2);      // county 999 and "bogus"
    expect(batch.duplicateCount).toBe(1);    // the 14-digit form of the first entry
    expect(batch.inputs[3].duplicateOf).toBe("42-165-02733");
    expect(batch.inputs.every(i => i.originalInput.length > 0)).toBe(true);
  });

  it("does not deduplicate two entries that differ only by sidetrack suffix", () => {
    const batch = parseApiBatch(["42-165-02733-00-00", "42-165-02733-01-00"]);
    expect(batch.validCount).toBe(2);
    expect(batch.duplicateCount).toBe(0);
  });
});
