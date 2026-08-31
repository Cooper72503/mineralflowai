import * as cheerio from "cheerio";

export interface PermitSearchRow {
  /** RRC's own application tracking number (the "Status #" column). */
  statusNumber: string | null;
  apiNumber: string | null;
  operatorName: string | null;
  operatorNumber: string | null;
  leaseName: string | null;
  wellNumber: string | null;
  district: string | null;
  county: string | null;
  wellboreProfile: string | null;
  filingPurpose: string | null;
  totalDepth: string | null;
  /** From the "Current Queue" column — the permit's live status label. */
  currentStatus: string | null;
  applicationDate: string | null; // parsed from "Submitted MM/DD/YYYY" in the first cell
  issuanceDate: string | null; // parsed from "Approved MM/DD/YYYY" in the first cell
  detailUrl: string | null;
}

const BASE_URL = "https://webapps.rrc.state.tx.us";

/**
 * Parses one page of W-1 search results. Every data row is identified by
 * its lease-name link to the drill-down detail page — that link only
 * appears in actual result rows, never in the surrounding page chrome, so
 * this is more robust than guessing which <table> on the page is "the"
 * results table (there is no id/class to select on; this is a ~20-year-old
 * Struts app with no CSS hooks). Verified live against
 * webapps.rrc.state.tx.us/DP on 2026-08-31.
 */
export function parseSearchResultsPage(html: string): PermitSearchRow[] {
  const $ = cheerio.load(html);
  const rows: PermitSearchRow[] = [];

  $('a[href*="drillDownQueryAction.do"]').each((_, link) => {
    const $link = $(link);
    const $row = $link.closest("tr");
    const cells = $row.find("td").map((__, td) => $(td).text().replace(/ /g, " ").trim()).get();
    if (cells.length < 9) return; // not a data row we recognize — skip rather than guess

    const [statusCell, statusNumber, apiRaw, operatorRaw, , wellNumber, district, county, wellboreProfile, filingPurpose, , totalDepth, , currentStatus] = cells;

    const operatorMatch = operatorRaw?.match(/^(.*?)\s*\((\d+)\)\s*$/);
    const submittedMatch = statusCell?.match(/Submitted\s+(\d{2}\/\d{2}\/\d{4})/);
    const approvedMatch = statusCell?.match(/Approved\s+(\d{2}\/\d{2}\/\d{4})/);

    const href = $link.attr("href");
    const detailUrl = href ? new URL(href, BASE_URL).toString() : null;

    rows.push({
      statusNumber: statusNumber || null,
      apiNumber: apiRaw ? `42-${apiRaw}` : null,
      operatorName: operatorMatch ? operatorMatch[1].trim() : operatorRaw || null,
      operatorNumber: operatorMatch ? operatorMatch[2] : null,
      leaseName: $link.text().trim() || null,
      wellNumber: wellNumber || null,
      district: district || null,
      county: county || null,
      wellboreProfile: wellboreProfile || null,
      filingPurpose: filingPurpose || null,
      totalDepth: totalDepth || null,
      currentStatus: currentStatus || null,
      applicationDate: submittedMatch ? submittedMatch[1] : null,
      issuanceDate: approvedMatch ? approvedMatch[1] : null,
      detailUrl,
    });
  });

  return rows;
}

/** True if this looks like a full (non-final) page — i.e. more pages follow. */
export function pageIsFull(rows: PermitSearchRow[], pageSize = 20): boolean {
  return rows.length >= pageSize;
}
