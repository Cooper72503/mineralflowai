import { describe, it, expect } from "vitest";
import { scopeTitleToLease } from "../build";
import type { TitleChainAnalysis } from "../../title/chain-types";

const analysis = {
  tracts: [{ id: "h", tractLabel: "T&P RR, Blk 34 T2N, Sec 10, Howard County", matchStatus: "confirmed" }, { id: "p", tractLabel: "junk", matchStatus: "proposed" }],
  wells: [
    { api14: "42227408550000", countyName: "Howard", associations: [{ tractId: "h", tractLabel: "T&P RR, Blk 34 T2N, Sec 10, Howard County" }] },
    { api14: "42317430160000", countyName: "Martin", associations: [] },
  ],
  chronology: [{ tractLabel: "T&P RR, Blk 34 T2N, Sec 10, Howard County", contentVerified: false }, { tractLabel: "elsewhere", contentVerified: true }],
  searchCoverage: [{ provider: "county:tyler_technologies", county: "Howard", status: "success" }, { provider: "none", county: "Martin", status: "provider_unavailable" }, { provider: "trrc_ewa", county: "Martin", status: "success" }],
} as unknown as TitleChainAnalysis;

describe("scopeTitleToLease", () => {
  it("keeps only the lease's own confirmed tracts, recordings and county searches", () => {
    const r = scopeTitleToLease(analysis, ["4222740855"], []);
    expect(r.analysis!.tracts.map(t => t.id)).toEqual(["h"]);
    expect(r.analysis!.chronology).toHaveLength(1);
    expect(r.analysis!.searchCoverage.map(c => c.county)).toEqual(["Howard"]);
  });
  it("gives a lease with no confirmed tract no chain, and says why for its county", () => {
    const r = scopeTitleToLease(analysis, ["4231743016"], []);
    expect(r.analysis).toBeNull();
    expect(r.reason).toBe("Martin County clerk records are not online for automated search");
  });
});
