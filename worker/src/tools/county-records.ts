/**
 * County Real Property Records — deeds, leases, mineral deeds, assignments,
 * releases, liens. This is county clerk data, not TRRC data — a
 * fundamentally different source with no statewide unification.
 *
 * Confirmed live (2026-07-28): Texas county clerk record systems are NOT
 * unified. Each county contracts its own vendor independently, or has none
 * at all with free public access. Checked ~20 major oil & gas counties
 * directly — Midland, Reeves, Reagan, and Live Oak share the same vendor
 * platform (publicsearch.us, by Neumo) with a real, free, scrapable
 * results table (grantor, grantee, doc type, recorded date, doc number,
 * book/volume/page, legal description — no login required for search).
 * Ector County uses a completely different vendor (Tyler Technologies).
 * Several others (Loving, Winkler, Ward, Pecos, Upton, Howard, Martin,
 * Andrews, Crane, Karnes, La Salle) have no free automated portal found at
 * all — only paid third-party aggregators.
 *
 * This is a provider-abstraction framework specifically because of that
 * fragmentation: each vendor gets its own isolated connector implementing
 * the same interface, and a county with no connector yet gets an honest
 * manual_required result with a real, verified-working search URL
 * (TexasFile, which has consistent per-county coverage across Texas)
 * rather than being silently omitted from the report.
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

const publicSearchUsProvider: CountyRecordsProvider = {
  id: "publicsearch_us",
  name: "PublicSearch.us (Neumo)",
  counties: {
    "Midland": "midland",
    "Reeves": "reeves",
    "Reagan": "reagan",
    "Live Oak": "liveoak",
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

const PROVIDERS: CountyRecordsProvider[] = [publicSearchUsProvider];

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
