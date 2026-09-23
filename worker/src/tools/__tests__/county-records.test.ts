/**
 * Tests for the pure logic in county-records.ts (provider lookup, manual
 * fallback URL construction). The actual Playwright scraping against
 * publicsearch.us was verified directly against the live site
 * (2026-07-28): a real search for "Chevron" in Midland County returned 50
 * real rows (deeds, mineral deeds, releases, overriding royalty
 * conveyances) with the exact column layout this parser expects, and a
 * deliberately nonsense search term returned a clean 0-row empty result
 * with no crash. That path isn't covered by an automated test here for
 * the same reason browser.ts's existing CODA/ICE Playwright fetchers
 * aren't — it needs a live browser and a live third-party site, which
 * isn't suitable for the regular test suite.
 */

import { describe, it, expect, vi } from "vitest";
import { getBrowser } from "../browser.js";
vi.mock("../browser.js", () => ({ getBrowser: vi.fn() }));
import { getCountyRecords, getAutomatedCounties, findProvider } from "../county-records.js";

describe("getAutomatedCounties", () => {
  it("lists exactly the counties confirmed live on the publicsearch.us platform", () => {
    // Confirmed live 2026-08-02 against GovOS/Kofile's own published Texas
    // "Cloud Search Active Sites" directory, then independently verified by
    // hitting every one of these <slug>.tx.publicsearch.us subdomains
    // directly (all returned a real, working results page — no login wall)
    // and checking Bexar end-to-end with an actual search.
    const expected = [
      "Anderson", "Bee", "Bell", "Bexar", "Blanco", "Brazos", "Brewster", "Burleson",
      "Cameron", "Chambers", "Coleman", "Collin", "Dallas", "Denton", "Freestone",
      "Gillespie", "Goliad", "Grayson", "Grimes", "Hidalgo", "Hockley", "Jim Hogg",
      "Jim Wells", "Jefferson", "Johnson", "Kendall", "Leon", "Live Oak", "Matagorda",
      "Medina", "Midland", "Milam", "Montgomery", "Nacogdoches", "Nueces", "Potter",
      "Reagan", "Reeves", "Refugio", "San Patricio", "Smith", "Starr", "Tarrant",
      "Walker", "Williamson", "Wilson", "Young", "Zapata",
      // Harris — its own dedicated provider (cclerk.hctx.net), not GovOS.
      "Harris",
      // Tyler Technologies (tylerhost.net) — a third, separate platform.
      "Ector", "Howard", "Calhoun", "Taylor", "Upshur", "Burnet",
    ];
    expect(getAutomatedCounties().sort()).toEqual(expected.sort());
  });
});

describe("getCountyRecords — manual fallback for unsupported counties", () => {
  it("returns manual_required with a real, correctly-formatted TexasFile URL for a county with no connector", async () => {
    const result = await getCountyRecords("Karnes", "Chevron");
    expect(result.status).toBe("manual_required");
    expect(result.found).toBe(false);
    expect(result.provider).toBe("none");
    expect(result.search_url).toBe("https://www.texasfile.com/search/texas/karnes-county/county-clerk-records/");
    expect(result.message).toMatch(/no automated county records connector/i);
  });

  it("builds a correct multi-word county slug", async () => {
    const result = await getCountyRecords("La Salle", "test");
    expect(result.search_url).toBe("https://www.texasfile.com/search/texas/la-salle-county/county-clerk-records/");
  });

});

describe("findProvider — case-insensitive county matching (pure, no network)", () => {
  it("matches a supported county regardless of input casing", () => {
    expect(findProvider("midland")?.displayName).toBe("Midland");
    expect(findProvider("MIDLAND")?.displayName).toBe("Midland");
    expect(findProvider("Live oak")?.displayName).toBe("Live Oak");
  });

  it("returns null for an unsupported county rather than a false match", () => {
    expect(findProvider("Karnes")).toBeNull();
  });

  it("resolves Harris County to its own dedicated provider, not the GovOS platform", () => {
    // Harris runs its own standalone ASP.NET portal (cclerk.hctx.net), not
    // publicsearch.us — confirmed live 2026-08-02 with a real "CHEVRON"
    // grantee search returning genuine deed/easement records.
    const match = findProvider("Harris");
    expect(match?.displayName).toBe("Harris");
    expect(match?.provider.id).toBe("harris_cclerk");
  });

  it("resolves the correct provider-specific slug", () => {
    expect(findProvider("Live Oak")?.identifier).toBe("liveoak");
    expect(findProvider("Reeves")?.identifier).toBe("reeves");
  });

  it("resolves a Tyler Technologies county to its own provider, distinct from GovOS and Harris", () => {
    // Confirmed live 2026-08-02: a real "PIONEER" grantee search against
    // Ector County returned 100 genuine records (deeds of trust,
    // mechanic's liens, releases) with correctly parsed grantor/grantee/
    // doc-type/date/book-volume-page/legal-description fields.
    const match = findProvider("Ector");
    expect(match?.displayName).toBe("Ector");
    expect(match?.provider.id).toBe("tyler_technologies");
    expect(match?.identifier).toBe("ectorcountytx-web");
  });
});


describe("publicsearch search outcome evidence", () => {
  async function searchSnapshot(rows: string[][], text: string, documentIds: Array<string | null> = []) {
    const close = vi.fn().mockResolvedValue(undefined);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ rows, text, documentIds }),
    };
    vi.mocked(getBrowser).mockResolvedValue({
      newContext: async () => ({ newPage: async () => page, close }),
    } as unknown as Awaited<ReturnType<typeof getBrowser>>);
    const result = await getCountyRecords("Midland", "BUTTERCUP");
    expect(close).toHaveBeenCalledOnce();
    return result;
  }

  it.each(["Loading...", "Sign in to continue", "Verify you are human", "", "Search unavailable"])(
    "does not turn an unverified page into a no-records finding: %s", async text => {
      const result = await searchSnapshot([], text);
      expect(result.error).toContain("outcome unverified");
      expect(result.found).toBe(false);
    },
  );

  it("accepts an explicitly rendered empty search", async () => {
    const result = await searchSnapshot([[]], "No results found");
    expect(result.error).toBeUndefined();
    expect(result.records).toEqual([]);
  });

  it("rejects an unrecognized table even if no-results text also appears", async () => {
    const result = await searchSnapshot([["changed", "layout"]], "No results found");
    expect(result.error).toContain("outcome unverified");
  });

  it("flags a full 50-row page as incomplete without inventing a total", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ["", "", "", "A", "B", "DEED", "2020-01-01", String(i), "1/2", "SEC 37 BLK 39 T4S"]);
    const result = await searchSnapshot(rows, "Results");
    expect(result.records).toHaveLength(50);
    expect(result.total_count).toBe(50);
    expect(result.coverage_incomplete).toBe(true);
  });

  it("preserves retrieved index entries", async () => {
    const result = await searchSnapshot([["", "", "", "A", "B", "DEED", "2020-01-01", "123", "1/2", "Section 25"]], "1 result", ["39265019"]);
    expect(result.error).toBeUndefined();
    expect(result.records[0]).toMatchObject({ grantor: "A", grantee: "B", doc_number: "123", document_url: "https://midland.tx.publicsearch.us/doc/39265019" });
  });
});
