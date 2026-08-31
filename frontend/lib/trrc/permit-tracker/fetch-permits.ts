import { RrcSession } from "./session";
import { countyCodeFor } from "./county-codes";
import { parseSearchResultsPage, pageIsFull, type PermitSearchRow } from "./search-results";

const SEARCH_PATH = "/DP/publicQuerySearchAction.do";
const PAGE_PATH = "/DP/changeQueryPageAction.do";
const NEW_DRILL_PURPOSE_CODE = "01";
const MAX_PAGES = 15; // safety valve — 15 * 20 = 300 rows per request
const MAX_DATE_RANGE_DAYS = 92; // ~1 quarter; RRC's own query caps large unfiltered ranges

export interface PermitSearchParams {
  /** Texas county names, any casing — unrecognized names are dropped with a warning. */
  counties: string[];
  since: Date;
  until: Date;
}

export interface PermitSearchResult {
  rows: PermitSearchRow[];
  skippedCounties: string[];
  truncated: boolean;
}

function formatDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Searches the Railroad Commission's public, no-login W-1 (drilling permit)
 * search for New Drill filings in the given counties and date range.
 * Confirmed live and free of a login wall at
 * https://webapps.rrc.state.tx.us/DP/initializePublicQueryAction.do
 * (verified against real 2026 filings on 2026-08-31).
 *
 * Scoped to New Drill filings only (RRC filing purpose code 01) — this is
 * the one purpose code confirmed correct against live results; broadening
 * to other purpose codes without confirming their values against the live
 * form would risk silently mis-filtering results.
 */
export async function searchNewDrillPermits(params: PermitSearchParams): Promise<PermitSearchResult> {
  const { counties, since, until } = params;

  const rangeDays = (until.getTime() - since.getTime()) / (1000 * 60 * 60 * 24);
  if (rangeDays > MAX_DATE_RANGE_DAYS) {
    throw new Error(`Date range too wide — max ${MAX_DATE_RANGE_DAYS} days per search.`);
  }
  if (rangeDays < 0) {
    throw new Error("Start date must be before end date.");
  }

  const skippedCounties: string[] = [];
  const countyCodes = counties
    .map((name) => ({ name, code: countyCodeFor(name) }))
    .filter((c): c is { name: string; code: string } => {
      if (!c.code) skippedCounties.push(c.name);
      return c.code !== null;
    });

  if (countyCodes.length === 0) {
    return { rows: [], skippedCounties, truncated: false };
  }

  const session = new RrcSession();
  await session.init();

  const body = new URLSearchParams();
  for (const { code } of countyCodes) body.append("countyNames", code);
  body.set("dpFilingPurpose", NEW_DRILL_PURPOSE_CODE);
  body.set("submitStart", formatDate(since));
  body.set("submitEnd", formatDate(until));

  const rows: PermitSearchRow[] = [];
  let html = await session.post(SEARCH_PATH, body);
  let page = parseSearchResultsPage(html);
  rows.push(...page);

  let offset = 20;
  let truncated = false;
  while (pageIsFull(page) && offset / 20 < MAX_PAGES) {
    html = await session.get(`${PAGE_PATH}?pager.offset=${offset}`);
    page = parseSearchResultsPage(html);
    rows.push(...page);
    offset += 20;
  }
  if (pageIsFull(page) && offset / 20 >= MAX_PAGES) truncated = true;

  return { rows, skippedCounties, truncated };
}
