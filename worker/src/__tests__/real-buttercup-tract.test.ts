/** Runs the real confirmed Buttercup tract and the 320 legal descriptions
 *  actually retrieved on 2026-09-23 through the new relevance filter. */
import { describe, it, expect } from "vitest";
import { tractQueries, indexMatchesTract, type SearchTract } from "../title-tract-search.js";

// Exactly the row in title_canonical_tracts for job 31f9fe66.
const tract: SearchTract = { id: "t1", county: "Midland", section_name: "37", block_number: "39 T4S", match_status: "confirmed" };

describe("real Buttercup tract", () => {
  it("produces the precise section/block/township queries", () => {
    expect(tractQueries(tract)).toEqual(["SEC 37 BLK 39 T4S", "SECTION 37 BLOCK 39 T4S"]);
  });

  it("refuses to act on an unconfirmed tract", () => {
    expect(tractQueries({ ...tract, match_status: "needs_confirmation" })).toEqual([]);
  });

  it("rejects the near-miss that differs only by township", () => {
    // Doc 2017-3169, actually retrieved: right section and block, wrong township.
    expect(indexMatchesTract("SEC 37 BLK 39 T3S T&P RY CO SURV", tract)).toBe(false);
    expect(indexMatchesTract("SEC 37 BLK 39 T4S T&P RY CO SURV", tract)).toBe(true);
  });

  it("rejects the residential Buttercup street address that the BUTTERCUP query returned", () => {
    expect(indexMatchesTract("OWNER: 3810 BUTTERCUP GARDENDALE TX 79758", tract)).toBe(false);
  });

  // A representative slice of what the 2026-09-23 live run actually returned:
  // broad operator/survey hits across Midland County, plus residential and
  // lien records. None covers the subject tract. Scored here so a future
  // relaxation of the filter cannot silently start accepting them.
  it("accepts none of the records the live run actually retrieved", () => {
    const retrieved = [
      "SEC 37 BLK 39 T3S T&P RY CO SURV",
      "SEC 45 BLK 39 T-3-S T&P RY CO SURV",
      "SE/4 SEC 45 BLK 39 T-3-S T&P RY CO SURV",
      "SEC 8 BLK 41 T4S TEXAS & PACIFIC RAILROAD CO",
      "SEC 28 BLK 41 T4S T&P RR CO SURV",
      "Survey- Name: T&P RY CO Survey Block: 39 Township: T4S Section: 31",
      "NE/4 SEC 13 BLK 39 T-4-S T&P RY CO SURV",
      "SEC 22 BLK 39 T4S T&P RY CO SURV",
      "SW/4 SEC-29 BLK-39 T-3-S T&P RY CO SURV",
      "SEC 17 BLK 39 T3S MIDLAND COUNTY TX",
      "SEC 20 BLK 41 T4S T&P RR CO SURV",
      "SEC 18 BLK 37 T4S T&P RY CO",
      "SEC 8 BLK 38 T2S T&P RR CO SUR",
      "OWNER: 3810 BUTTERCUP GARDENDALE TX 79758",
      "SCOTSDALE ADDN 5 00003 0006 0000A 0197",
      "COLLEGE HEIGHTS ADDN 1-6 0006 00017 0616",
      "SEC 52 37 KING JM",
      "SEE INSTRUMENT",
    ];
    expect(retrieved.filter(l => indexMatchesTract(l, tract))).toEqual([]);
    // The one description that does cover the tract must still be accepted.
    expect(indexMatchesTract("SEC 37 BLK 39 T4S T&P RY CO SURV", tract)).toBe(true);
  });


  // From the 2026-09-24 resumed run: SEC 37 BLK 39 T4S returned 42 index rows.
  // The clerk search is keyword-based, so it also returns the transposed tract
  // (Sec 39 Blk 37). Every row below is verbatim from that result set.
  it("accepts the labeled clerk format and section lists that cover the tract", () => {
    for (const legal of [
      "Survey-  Name: T&P RR CO  Survey Block: 39 Township: T4S Section: 37",
      "Survey- Name: T&P RY CO Survey: 236 Survey Block: 39 Township: T4S Section: 37,38",
      "Survey - Name: T&P RY CO Block: 39 Section: 36,37 Township: T4S",
      "SEC 7,17,19,37,47 BLK 39 T4S T&P RY CO S",
      "SEC 37,38,48 BLK 39 T4S T&P RR CO SURV",
      "SEC 37-38 BLK 39 T4S T&P RY CO SURV",
      "SEC 37 BLK 39 T4S T & P RR CO SUR",
    ]) expect(indexMatchesTract(legal, tract), legal).toBe(true);
  });

  it("rejects the transposed tract, the wrong township and multi-block descriptions", () => {
    for (const legal of [
      "SEC 39 BLK 37 T4S T&P RR CO SURV",
      "Survey-  Name: T&P RR CO  Survey Block: 37 Township: T4S Section: 39",
      "SEC 34,39 BLK 37 T4S",
      "Survey-  Name: T&P RR CO Survey Block: 37 Township: T4S Section: 13,14,22-24,26-28,33-35,38,39",
      "SEC 37 BLK 39 T3S T&P RY CO SURV",
      "SEC 46 BLK 37,39 T4S T&P RR CO SURV",
    ]) expect(indexMatchesTract(legal, tract), legal).toBe(false);
  });

  it("expands section ranges but does not let an implausible span match everything", () => {
    expect(indexMatchesTract("SEC 35-38 BLK 39 T4S", tract)).toBe(true);
    expect(indexMatchesTract("SEC 38-40 BLK 39 T4S", tract)).toBe(false);
    expect(indexMatchesTract("SEC 1-400 BLK 39 T4S", tract)).toBe(false);
  });
});
