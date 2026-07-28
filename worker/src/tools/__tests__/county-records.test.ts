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

import { describe, it, expect } from "vitest";
import { getCountyRecords, getAutomatedCounties, findProvider } from "../county-records.js";

describe("getAutomatedCounties", () => {
  it("lists exactly the counties confirmed live on the publicsearch.us platform", () => {
    expect(getAutomatedCounties().sort()).toEqual(["Live Oak", "Midland", "Reagan", "Reeves"].sort());
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
    expect(findProvider("Harris")).toBeNull();
  });

  it("resolves the correct provider-specific slug", () => {
    expect(findProvider("Live Oak")?.identifier).toBe("liveoak");
    expect(findProvider("Reeves")?.identifier).toBe("reeves");
  });
});
