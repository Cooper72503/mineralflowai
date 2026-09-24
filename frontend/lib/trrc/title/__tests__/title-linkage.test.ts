import { describe, it, expect } from "vitest";
import { legalDescriptionCoversTract } from "../legal-match";
import { clerkInstrumentType } from "../clerk-types";
import { selectAll, PAGE_SIZE } from "../select-all";

// The confirmed Buttercup tract (job 31f9fe66): Sec 37, Blk 39 T4S, Midland.
const tract = { sectionName: "37", blockNumber: "39 T4S" };

describe("legalDescriptionCoversTract (same live vectors as worker/src/title-tract-search.ts)", () => {
  it("accepts both Midland clerk formats and section lists covering the tract", () => {
    for (const legal of [
      "SEC 37 BLK 39 T4S T&P RR CO SURV",
      "Survey-  Name: T&P RR CO  Survey Block: 39 Township: T4S Section: 37",
      "Survey- Name: T&P RY CO Survey: 236 Survey Block: 39 Township: T4S Section: 37,38",
      "SEC 7,17,19,37,47 BLK 39 T4S T&P RY CO S",
      "SEC 35-38 BLK 39 T4S",
      "SEC 37 BLK 39 T-4-S T&P",
    ]) expect(legalDescriptionCoversTract(legal, tract), legal).toBe(true);
  });
  it("rejects the transposed tract, the wrong township and multi-block text", () => {
    for (const legal of [
      "SEC 39 BLK 37 T4S T&P RR CO SURV",
      "SEC 37 BLK 39 T3S T&P RY CO SURV",
      "SEC 46 BLK 37,39 T4S T&P RR CO SURV",
      "SEC 1-400 BLK 39 T4S",
      "OWNER: 3810 BUTTERCUP GARDENDALE TX 79758",
    ]) expect(legalDescriptionCoversTract(legal, tract), legal).toBe(false);
  });
  it("needs a township on the tract; it never infers one", () => {
    expect(legalDescriptionCoversTract("SEC 37 BLK 39 T4S", { sectionName: "37", blockNumber: "39" })).toBe(false);
  });
});

describe("clerkInstrumentType", () => {
  it("reads Midland's abbreviations and keeps non-conveyances as other", () => {
    expect(clerkInstrumentType("REL OIL&GAS LS")).toBe("release");
    expect(clerkInstrumentType("RELEASE OF LIEN")).toBe("release");
    expect(clerkInstrumentType("SPECIAL WARRANTY DEED")).toBe("deed");
    expect(clerkInstrumentType("MINERAL DEED")).toBe("mineral_deed");
    // A pipeline easement indexed as AGREEMENT must never read as a conveyance.
    for (const t of ["AGREEMENT", "EASEMENT", "RIGHT OF WAY", "MEMORANDUM"]) expect(clerkInstrumentType(t), t).toBe("other");
    expect(clerkInstrumentType(null)).toBeNull();
  });
});

describe("selectAll", () => {
  it("reads past the 1,000-row response cap", async () => {
    const total = PAGE_SIZE * 2 + 317; // the Buttercup job held 1,317 party rows
    const rows = Array.from({ length: total }, (_, i) => ({ i }));
    const r = await selectAll<{ i: number }>(async (a, b) => ({ data: rows.slice(a, b + 1), error: null }));
    expect(r.data).toHaveLength(total);
    expect(r.error).toBeNull();
  });
  it("returns the error rather than a silently short result", async () => {
    const r = await selectAll(async () => ({ data: null, error: { message: "offline" } }));
    expect(r.error?.message).toBe("offline");
  });
});
