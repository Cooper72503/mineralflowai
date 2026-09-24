import { describe, it, expect, vi } from "vitest";
vi.mock("../tools/browser.js", () => ({ getCodaDocuments: vi.fn(), getBrowser: vi.fn(), closeBrowser: vi.fn() }));
vi.mock("../tools/ewa.js", () => ({ searchWellbore: vi.fn(), getGisLocation: vi.fn(), getDrillingPermits: vi.fn(), getCompletionRecords: vi.fn(), PDA_BASE: "x" }));
import { splitIndexNames } from "../title-sequencer.js";

// Verbatim grantor strings from the Midland clerk index for Sec 37 Blk 39 T4S.
describe("splitIndexNames", () => {
  it("keeps an entity name whole when & or AND is part of the name", () => {
    for (const name of [
      "TEXAS & PACIFIC RAILWAY COMPANY",
      "HUMBLE OIL & REFINING COMPANY",
      "T&P PIPE AND SUPPLY INC",
      "BOB AND TONI MIDKIFF LTD",
      "BOB & TONI MIDKIFF LTD",
      "SINCLAIR OIL & GAS COMPANY",
      "MIDLAND FEDERAL SAVINGS & LOAN ASN",
      "K & S LAND CO INC",
    ]) expect(splitIndexNames(name), name).toEqual([name]);
  });
  it("still separates distinct parties", () => {
    expect(splitIndexNames("XTO ENERGY INC & CHEVRON USA INC")).toEqual(["XTO ENERGY INC", "CHEVRON USA INC"]);
    expect(splitIndexNames("MIDKIFF TONI; MIDKIFF FRANK")).toEqual(["MIDKIFF TONI", "MIDKIFF FRANK"]);
    expect(splitIndexNames("RUTTER & WILBANKS")).toEqual(["RUTTER", "WILBANKS"]);
  });
  it("never emits single-letter fragments that would be spent as predecessor searches", () => {
    for (const name of ["T&P PIPE AND SUPPLY INC", "K & S LAND CO INC"]) {
      expect(splitIndexNames(name).some(n => n.replace(/[^A-Za-z]/g, "").length <= 3 && !/\b(INC|LLC|LTD|CO)\b/.test(n))).toBe(false);
    }
  });
});
