/**
 * County Real Property Records — deeds, leases, mineral deeds, assignments,
 * releases, liens. This is county clerk data, not TRRC data — a
 * fundamentally different source with no statewide unification.
 *
 * Texas county clerk record systems are NOT unified — each county contracts
 * its own vendor independently, or has none at all with free public access.
 * As of 2026-08-02, real automated coverage: 54 of 254 counties.
 *   - 48 counties on GovOS/Kofile's Cloud Search platform (publicsearch.us),
 *     confirmed against the vendor's own published Texas site directory and
 *     independently verified by hitting every county's subdomain directly —
 *     includes several of the state's largest (Bexar, Dallas, Tarrant,
 *     Hidalgo, Cameron) alongside the original 4 (Midland, Reeves, Reagan,
 *     Live Oak).
 *   - Harris (the single largest county) on its own standalone ASP.NET
 *     portal, cclerk.hctx.net — not GovOS, not Tyler, its own thing.
 *   - 5 counties (Ector, Howard, Calhoun, Taylor, Upshur, Burnet) on Tyler
 *     Technologies' tylerhost.net platform. The apparent "unreliability"
 *     flagged in earlier research was misdiagnosed — it was Playwright's
 *     `networkidle` hanging on a persistent background connection the site
 *     holds open, not real site flakiness; switching to `domcontentloaded`
 *     fixed it, at the cost of the platform genuinely being slow (~70-90s
 *     per search). Other tylerhost.net counties exist (e.g. Liberty,
 *     Brazoria) but return 403 on this subdomain/path convention and were
 *     left out rather than guessed at.
 * countygovernmentrecords.com (also Tyler Technologies, a different tier)
 * requires account registration even for search — not pursued.
 * countyrecords.com claims 220+ TX counties but is a paid commercial
 * product (explicit pricing, landman/oil-and-gas marketing) — not a free
 * public resource, and not something to build against without a business
 * decision on paying for it.
 * Everything else — including Loving, Winkler, Ward, Pecos, Upton, Martin,
 * Andrews, Crane, Karnes, La Salle from the original research pass — has no
 * free automated portal found at all, only paid third-party aggregators.
 *
 * This is a provider-abstraction framework specifically because of that
 * fragmentation: each vendor (or, for Harris, each standalone county site)
 * gets its own isolated connector implementing the same interface, and a
 * county with no connector yet gets an honest manual_required result with a
 * real, verified-working search URL (TexasFile, which has consistent
 * per-county coverage across Texas) rather than being silently omitted
 * from the report.
 */

import { getBrowser } from "./browser.js";
import type { BrowserContext } from "playwright";

export type CountyRecordEntry = {
  grantor: string;
  grantee: string;
  doc_type: string;
  recorded_date: string;
  doc_number: string;
  book_volume_page: string;
  legal_description: string;
};

export type CountyRecordsResult = {
  found: boolean;
  status: "automated" | "manual_required";
  county: string;
  provider: string;
  records: CountyRecordEntry[];
  total_count: number;
  search_url: string;
  message: string;
  error?: string;
  /** Mirrors this codebase's established data_gap convention (see
   * deriveCoverageFromAttempts) so this source is classified the same way
   * as every other manual-fallback source without special-casing it. */
  data_gap?: boolean;
};

export interface CountyRecordsProvider {
  id: string;
  name: string;
  /** Display county name -> provider-specific identifier (e.g. URL slug). */
  counties: Record<string, string>;
  search(countyIdentifier: string, countyDisplayName: string, searchValue: string): Promise<CountyRecordsResult>;
}

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ─── Provider: publicsearch.us (Neumo) ───────────────────────────────────────
//
// Real HTML <table> with <tr role="row"> rows once the client-side app
// finishes fetching — no public JSON API found (extensively checked: no
// XHR/fetch request appears in network capture, no endpoint referenced in
// the served JS bundles), so this drives an actual browser, same pattern
// as this codebase's existing CODA/ICE fetchers (browser.ts). Column
// order confirmed directly from live captured markup: [checkbox, cart
// action, row action, grantor, grantee, doc_type, recorded_date,
// doc_number, book_volume_page, legal_description].

// Full county list confirmed live 2026-08-02 against GovOS/Kofile's own
// published "Cloud Search Active Sites" directory for Texas
// (kofilehelp.zendesk.com), then independently verified by hitting every
// single one of these <slug>.tx.publicsearch.us subdomains directly — all
// returned a real, working results page (no login wall), and Bexar was
// checked end-to-end with an actual search returning real grantor/grantee
// records back to the 1970s in the exact column layout this provider
// already parses. Slugs are the county name lowercased with spaces
// removed — confirmed against the three multi-word counties (Jim Hogg,
// Jim Wells, San Patricio) specifically, not just assumed. This took
// county coverage from 4 to 48 of Texas's 254 counties in one pass, using
// the same already-built connector — no new scraping code needed, only
// real research into which counties are actually on this platform.
const publicSearchUsProvider: CountyRecordsProvider = {
  id: "publicsearch_us",
  name: "PublicSearch.us (Neumo)",
  counties: {
    "Anderson": "anderson",
    "Bee": "bee",
    "Bell": "bell",
    "Bexar": "bexar",
    "Blanco": "blanco",
    "Brazos": "brazos",
    "Brewster": "brewster",
    "Burleson": "burleson",
    "Cameron": "cameron",
    "Chambers": "chambers",
    "Coleman": "coleman",
    "Collin": "collin",
    "Dallas": "dallas",
    "Denton": "denton",
    "Freestone": "freestone",
    "Gillespie": "gillespie",
    "Goliad": "goliad",
    "Grayson": "grayson",
    "Grimes": "grimes",
    "Hidalgo": "hidalgo",
    "Hockley": "hockley",
    "Jim Hogg": "jimhogg",
    "Jim Wells": "jimwells",
    "Jefferson": "jefferson",
    "Johnson": "johnson",
    "Kendall": "kendall",
    "Leon": "leon",
    "Live Oak": "liveoak",
    "Matagorda": "matagorda",
    "Medina": "medina",
    "Midland": "midland",
    "Milam": "milam",
    "Montgomery": "montgomery",
    "Nacogdoches": "nacogdoches",
    "Nueces": "nueces",
    "Potter": "potter",
    "Reagan": "reagan",
    "Reeves": "reeves",
    "Refugio": "refugio",
    "San Patricio": "sanpatricio",
    "Smith": "smith",
    "Starr": "starr",
    "Tarrant": "tarrant",
    "Walker": "walker",
    "Williamson": "williamson",
    "Wilson": "wilson",
    "Young": "young",
    "Zapata": "zapata",
  },
  async search(slug, countyDisplayName, searchValue) {
    const searchUrl = `https://${slug}.tx.publicsearch.us/results?department=RP&keywordSearch=false&recordedDateRange=18000101%2C${todayStamp()}&searchOcrText=false&searchType=quickSearch&searchValue=${encodeURIComponent(searchValue)}`;

    let context: BrowserContext | null = null;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();
      await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30_000 });

      // Either real result rows appear, or the page settles on a genuine
      // "no results" state — race a bounded wait against both so an empty
      // result doesn't hang for the full timeout.
      await Promise.race([
        page.waitForFunction(() => document.querySelectorAll('table tr[role="row"]').length > 1, { timeout: 20_000 }).catch(() => null),
        page.waitForTimeout(8_000),
      ]);

      const rawRows = await page.evaluate(() => {
        const trs = Array.from(document.querySelectorAll('table tr[role="row"]'));
        return trs.map(tr => Array.from(tr.querySelectorAll("td")).map(td => (td.textContent ?? "").trim()));
      });

      const records: CountyRecordEntry[] = rawRows
        .filter(r => r.length >= 10)
        .map(r => ({
          grantor: r[3] ?? "",
          grantee: r[4] ?? "",
          doc_type: r[5] ?? "",
          recorded_date: r[6] ?? "",
          doc_number: r[7] ?? "",
          book_volume_page: r[8] ?? "",
          legal_description: r[9] ?? "",
        }))
        .filter(r => r.grantor || r.grantee);

      return {
        found: records.length > 0,
        status: "automated",
        county: countyDisplayName,
        provider: "publicsearch.us",
        records: records.slice(0, 100),
        total_count: records.length,
        search_url: searchUrl,
        message: records.length > 0
          ? `${records.length} record(s) found for "${searchValue}" in ${countyDisplayName} County.`
          : `No records found for "${searchValue}" in ${countyDisplayName} County.`,
      };
    } catch (e) {
      return {
        found: false,
        status: "automated",
        county: countyDisplayName,
        provider: "publicsearch.us",
        records: [],
        total_count: 0,
        search_url: searchUrl,
        message: `County records search failed: ${String(e).slice(0, 100)}`,
        error: String(e),
      };
    } finally {
      await context?.close();
    }
  },
};

// ─── Provider: Harris County Clerk's own portal (cclerk.hctx.net) ───────────
//
// Harris is Texas's largest county by population and runs its own
// standalone ASP.NET WebForms search — not GovOS, not Tyler, its own thing.
// Confirmed live 2026-08-02: the search itself is free with no login (login
// is only for purchasing document images, same "free index, paid image"
// split as every other connector here) and returns a real, structured
// results table. Driven by Playwright rather than a direct URL like
// publicsearch.us — ASP.NET WebForms postback needs a real browser POST
// (viewstate etc.), not a hand-built query string. DOM structure confirmed
// directly: each real record is a direct-child <tr> of
// #itemPlaceholderContainer with 8 <td>s — file no., file date, instrument
// type (+ vol/page), a nested Grantor/Grantee/Trustee table, a nested legal
// description table, page count, and film code — verified against a real
// "CHEVRON" grantee search returning genuine deed-of-trust/easement records
// back to 2006.
const harrisCountyProvider: CountyRecordsProvider = {
  id: "harris_cclerk",
  name: "Harris County Clerk (cclerk.hctx.net)",
  counties: {
    "Harris": "harris",
  },
  async search(_identifier, countyDisplayName, searchValue) {
    const searchUrl = "https://www.cclerk.hctx.net/Applications/WebSearch/RP.aspx";
    let context: BrowserContext | null = null;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);

      await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30_000 });
      // Grantee field — searching this way (rather than Grantor) matches
      // what a buyer actually wants: who has this party conveyed to.
      await page.fill("#ctl00_ContentPlaceHolder1_txtEE", searchValue);
      await page.click("#ctl00_ContentPlaceHolder1_btnSearch");
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => null);
      await page.waitForTimeout(1_500);

      const bodyText = await page.innerText("body").catch(() => "");
      if (/no records? (were )?found|no results/i.test(bodyText)) {
        return {
          found: false, status: "automated", county: countyDisplayName, provider: "harris_cclerk",
          records: [], total_count: 0, search_url: searchUrl,
          message: `No records found for "${searchValue}" in ${countyDisplayName} County.`,
        };
      }

      const rawRecords = await page.evaluate(() => {
        const table = document.getElementById("itemPlaceholderContainer");
        if (!table) return [];
        const rows = Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > tr"));
        return rows.map((row) => {
          const cells = row.querySelectorAll(":scope > td");
          if (cells.length < 8) return null;
          const doc_number = cells[1]?.querySelector("span")?.textContent?.trim() ?? "";
          const recorded_date = cells[2]?.querySelector("span")?.textContent?.trim() ?? "";
          const doc_type = cells[3]?.querySelector("a")?.textContent?.trim() ?? "";
          const volSpans = Array.from(cells[3]?.querySelectorAll("span") ?? []).map(s => s.textContent?.trim() ?? "").filter(Boolean);
          const book_volume_page = volSpans.join("/");

          const namesRows = Array.from(cells[4]?.querySelectorAll("tr") ?? []);
          const byLabel: Record<string, string[]> = {};
          for (const nr of namesRows) {
            const tds = nr.querySelectorAll("td");
            if (tds.length < 2) continue;
            const label = (tds[0]?.textContent ?? "").replace(/[^A-Za-z]/g, "").trim();
            const value = (tds[1]?.textContent ?? "").trim();
            if (!label || !value) continue;
            (byLabel[label] ??= []).push(value);
          }
          const grantor = (byLabel["Grantor"] ?? []).join("; ");
          const grantee = (byLabel["Grantee"] ?? []).join("; ");

          const legalRows = Array.from(cells[5]?.querySelectorAll("tr") ?? []);
          const legalParts: string[] = [];
          for (const lr of legalRows) {
            const tds = lr.querySelectorAll("td");
            if (tds.length < 2) continue;
            const label = (tds[0]?.textContent ?? "").replace(/[^A-Za-z]/g, "").trim();
            const value = (tds[1]?.textContent ?? "").trim();
            if (label && value) legalParts.push(`${label}: ${value}`);
          }

          return { doc_number, recorded_date, doc_type, book_volume_page, grantor, grantee, legal_description: legalParts.join(", ") };
        }).filter((r): r is NonNullable<typeof r> => r !== null && (!!r.grantor || !!r.grantee));
      });

      const records: CountyRecordEntry[] = rawRecords.slice(0, 100);
      return {
        found: records.length > 0,
        status: "automated",
        county: countyDisplayName,
        provider: "harris_cclerk",
        records,
        total_count: rawRecords.length,
        search_url: searchUrl,
        message: records.length > 0
          ? `${records.length} record(s) found for "${searchValue}" in ${countyDisplayName} County.`
          : `No records found for "${searchValue}" in ${countyDisplayName} County.`,
      };
    } catch (e) {
      return {
        found: false, status: "automated", county: countyDisplayName, provider: "harris_cclerk",
        records: [], total_count: 0, search_url: searchUrl,
        message: `County records search failed: ${String(e).slice(0, 100)}`, error: String(e),
      };
    } finally {
      await context?.close();
    }
  },
};

// ─── Provider: Tyler Technologies (tylerhost.net) ────────────────────────────
//
// A different platform from GovOS/Kofile entirely — jQuery Mobile UI over
// ASP.NET-style postback navigation, county-name-based subdomain
// (<countyname>tx-web.tylerhost.net). No login required for search.
//
// The apparent "unreliability" found in earlier research was misdiagnosed:
// it isn't the site being flaky, it's Playwright's `networkidle` waiting
// forever because the site holds a persistent background connection open.
// Switching to `domcontentloaded` + explicit waits for real page landmarks
// fixed it — 3/3 clean loads under 1s for the disclaimer page, and a full
// disclaimer-to-search-form navigation lands reliably in ~70s (slow, but
// consistent, not flaky).
//
// Navigation discovers the two tile links by their visible text rather than
// hardcoding their href (e.g. /web/action/ACTIONGROUP8S1), because those
// action/search IDs are per-county configuration, not a platform constant —
// hardcoding Ector's IDs would silently break on every other county.
//
// Confirmed end-to-end live 2026-08-02 for Ector County only: disclaimer ->
// accept -> "Official Public Record Search and Copy Request" tile -> same
// link on the resulting page -> Both Names field -> #searchButton -> real
// results for "PIONEER" (971 Deed of Trust records, 249 Assignment of Deed
// of Trust, etc. — consistent with genuine Pioneer Natural Resources
// activity). Result-row DOM confirmed directly: each record is a
// `li.ss-search-row`, with an `<h1>` containing "docNumber • book/vol/page
// • instrument type" (bullet-separated, book/vol/page segment sometimes
// absent) and a `.searchResultFourColumn` with four
// `ul.selfServiceSearchResultColumn` lists whose first `<li>` is a label
// ("Recording Date", "Grantor", "Grantee" or "Grantee (N)", "Legal
// Description") followed by one-or-more value `<li>`s.
//
// Other candidate counties are known to run on tylerhost.net (per the
// vendor's own county list), but not all use this same subdomain/path
// convention — a live probe found Liberty and Brazoria return 403 on
// `-web.tylerhost.net/web/` (likely a different pattern, e.g. Liberty's is
// `-kiosk.tylerhost.net/kiosk/`, not verified further), so they're left out
// rather than guessed at. Howard, Calhoun, Taylor, Upshur, and Burnet were
// each confirmed live 2026-08-02 to return HTTP 200 with the same
// "Self-Service" platform title on this exact pattern, and share Ector's
// nav/DOM structure (same tile-discovery-by-text approach, same jQuery
// Mobile UI) — listed below on that basis, though only Ector has had a full
// end-to-end search run against real results.
const TYLER_SESSION_PROMPT_NO_BUTTON = 'button:has-text("No - Start Over"), a:has-text("No - Start Over")';

async function dismissTylerSessionPrompt(page: import("playwright").Page): Promise<void> {
  const noButton = page.locator(TYLER_SESSION_PROMPT_NO_BUTTON).first();
  if (await noButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await noButton.click().catch(() => null);
    await page.waitForTimeout(500);
  }
}

function tylerCountySearch(subdomain: string): CountyRecordsProvider["search"] {
  return async (_identifier, countyDisplayName, searchValue) => {
    const baseUrl = `https://${subdomain}.tylerhost.net/web/`;
    let context: BrowserContext | null = null;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);

      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await dismissTylerSessionPrompt(page);

      // Disclaimer page, if present.
      const disclaimerAccept = page.locator("#submitDisclaimerAccept, a:has-text(\"Accept\"), button:has-text(\"Accept\")").first();
      if (await disclaimerAccept.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await disclaimerAccept.click();
        await page.waitForLoadState("domcontentloaded").catch(() => null);
        await dismissTylerSessionPrompt(page);
      }

      // First tile: "Official Public Record Search and Copy Request" —
      // discovered by visible text, not a hardcoded href, since the
      // underlying action-group ID is per-county configuration.
      const searchTile = page.locator('a:has-text("Official Public Record Search")').first();
      await searchTile.waitFor({ state: "visible", timeout: 30_000 });
      await searchTile.click();
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      await dismissTylerSessionPrompt(page);

      // Same tile pattern repeats on the landing page that follows.
      const searchLink = page.locator('a:has-text("Official Public Record Search")').first();
      if (await searchLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await searchLink.click();
        await page.waitForLoadState("domcontentloaded").catch(() => null);
        await dismissTylerSessionPrompt(page);
      }

      await page.waitForSelector("#field_BothNamesID", { state: "visible", timeout: 30_000 });
      await page.fill("#field_BothNamesID", searchValue);
      await dismissTylerSessionPrompt(page);
      await page.click("#searchButton");
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      await dismissTylerSessionPrompt(page);

      await Promise.race([
        page.waitForSelector("li.ss-search-row", { timeout: 20_000 }).catch(() => null),
        page.waitForTimeout(8_000),
      ]);

      const rawRows = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("li.ss-search-row"));
        return rows.map((row) => {
          const headerText = (row.querySelector("h1")?.textContent ?? "")
            .split("•")
            .map(s => s.replace(/\s+/g, " ").trim())
            .filter(Boolean);

          const columns: Record<string, string[]> = {};
          const lists = Array.from(row.querySelectorAll(".searchResultFourColumn ul.selfServiceSearchResultColumn"));
          for (const list of lists) {
            const items = Array.from(list.querySelectorAll("li")).map(li => (li.textContent ?? "").trim()).filter(Boolean);
            if (items.length === 0) continue;
            const label = items[0].replace(/\s*\(\d+\)\s*$/, "");
            columns[label] = items.slice(1);
          }

          return { headerText, columns };
        });
      });

      const records: CountyRecordEntry[] = rawRows.map((r) => {
        const doc_number = r.headerText[0] ?? "";
        const instrument = r.headerText[r.headerText.length - 1] ?? "";
        const bookVolPage = r.headerText.length > 2 ? r.headerText.slice(1, -1).join(" ") : "";
        return {
          grantor: (r.columns["Grantor"] ?? []).join("; "),
          grantee: (r.columns["Grantee"] ?? []).join("; "),
          doc_type: r.headerText.length > 1 ? instrument : "",
          recorded_date: (r.columns["Recording Date"] ?? [])[0] ?? "",
          doc_number,
          book_volume_page: bookVolPage,
          legal_description: (r.columns["Legal Description"] ?? [])[0] ?? "",
        };
      }).filter(r => r.grantor || r.grantee);

      return {
        found: records.length > 0,
        status: "automated",
        county: countyDisplayName,
        provider: "tylerhost.net",
        records: records.slice(0, 100),
        total_count: records.length,
        search_url: baseUrl,
        message: records.length > 0
          ? `${records.length} record(s) found for "${searchValue}" in ${countyDisplayName} County.`
          : `No records found for "${searchValue}" in ${countyDisplayName} County.`,
      };
    } catch (e) {
      return {
        found: false,
        status: "automated",
        county: countyDisplayName,
        provider: "tylerhost.net",
        records: [],
        total_count: 0,
        search_url: baseUrl,
        message: `County records search failed: ${String(e).slice(0, 100)}`,
        error: String(e),
      };
    } finally {
      await context?.close();
    }
  };
}

const tylerTechnologiesProvider: CountyRecordsProvider = {
  id: "tyler_technologies",
  name: "Tyler Technologies (tylerhost.net)",
  counties: {
    "Ector": "ectorcountytx-web",
    "Howard": "howardcountytx-web",
    "Calhoun": "calhouncountytx-web",
    "Taylor": "taylorcountytx-web",
    "Upshur": "upshurcountytx-web",
    "Burnet": "burnetcountytx-web",
  },
  search(identifier, countyDisplayName, searchValue) {
    return tylerCountySearch(identifier)(identifier, countyDisplayName, searchValue);
  },
};

const PROVIDERS: CountyRecordsProvider[] = [publicSearchUsProvider, harrisCountyProvider, tylerTechnologiesProvider];

export function findProvider(countyName: string): { provider: CountyRecordsProvider; identifier: string; displayName: string } | null {
  const normalized = countyName.trim().toLowerCase();
  for (const provider of PROVIDERS) {
    for (const [display, identifier] of Object.entries(provider.counties)) {
      if (display.toLowerCase() === normalized) {
        return { provider, identifier, displayName: display };
      }
    }
  }
  return null;
}

/**
 * TexasFile has consistent per-county URL coverage across essentially all
 * of Texas (confirmed live for Midland, Ector, Karnes, and Loving
 * counties — all of which have no automated connector here except
 * Midland). Used as the manual-fallback link for any county without a
 * provider, so the report still gives the analyst a real, working
 * starting point instead of nothing.
 */
function manualFallbackUrl(countyName: string): string {
  const slug = countyName.trim().toLowerCase().replace(/\s+/g, "-");
  return `https://www.texasfile.com/search/texas/${slug}-county/county-clerk-records/`;
}

export async function getCountyRecords(countyName: string, searchValue: string): Promise<CountyRecordsResult> {
  const match = findProvider(countyName);
  if (match) {
    return match.provider.search(match.identifier, match.displayName, searchValue);
  }

  const url = manualFallbackUrl(countyName);
  return {
    found: false,
    status: "manual_required",
    county: countyName,
    provider: "none",
    records: [],
    total_count: 0,
    search_url: url,
    message: `No automated county records connector for ${countyName} County yet — manual search required.`,
    data_gap: true,
  };
}

export function getAutomatedCounties(): string[] {
  return PROVIDERS.flatMap(p => Object.keys(p.counties));
}
