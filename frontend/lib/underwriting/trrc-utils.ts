/**
 * Shared TRRC fetch utilities — retry, timeout, and column detection.
 *
 * TRRC EWA is a Java Struts app on a shared-state server. It returns HTTP 500s,
 * drops TCP connections, and issues stale-session responses more frequently than
 * most web services. These utilities wrap every TRRC fetch in:
 *
 *   withTrrcRetry    — AbortSignal timeout + exponential-backoff retry
 *   detectTrrcColumns — parse <th> header row → column-name : index map
 *
 * Usage pattern:
 *
 *   // Internal fetcher that accepts a cancellation signal
 *   async function _inner(signal: AbortSignal): Promise<SomeType[]> {
 *     const res = await fetch(url, { ..., signal });
 *     ...
 *   }
 *
 *   // Public export: wraps with timeout + retry
 *   export async function fetchSomething(): Promise<SomeType[]> {
 *     return withTrrcRetry(_inner, []);
 *   }
 */

export type TrrcRetryOpts = {
  /** Per-attempt wall-clock timeout in ms. Default: 45_000 (45 s). */
  timeout?: number;
  /** Number of retry attempts after the first failure. Default: 2. */
  retries?: number;
  /** Base back-off delay in ms; doubles each attempt. Default: 1_500. */
  backoffMs?: number;
};

/**
 * Wrap a TRRC async operation in timeout + exponential-backoff retry.
 *
 * `fn` receives a fresh AbortSignal for each attempt and must surface it to
 * every `fetch()` call it makes. On transient failure (network error, TCP
 * reset, timeout abort) it retries up to `retries` additional times with
 * doubling back-off. Non-transient errors (parse failures, logic errors)
 * short-circuit immediately to `fallback`.
 *
 * Never throws.
 */
export async function withTrrcRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  {
    timeout   = 45_000,
    retries   = 2,
    backoffMs = 1_500,
  }: TrrcRetryOpts = {},
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) return fallback;
      // Only retry on transient connectivity / timeout errors.
      // Parse errors, type errors from our own code, etc. → bail fast.
      const isTransient =
        err instanceof TypeError ||          // Node.js "fetch failed" network error
        (err instanceof Error && (
          err.name  === "AbortError" ||      // timeout abort
          err.name  === "FetchError" ||
          /ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(err.message)
        ));
      if (!isTransient) return fallback;
      await new Promise<void>(r => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
  }
  return fallback;
}

/**
 * Detect TRRC EWA table column positions from the HTML header row.
 *
 * Finds the first `<tr>` that contains `<th>` elements, extracts each
 * header's text, and normalises it to lowercase_with_underscores.
 *
 * Returns a map of column name → 0-based index, or null if no valid
 * header row is found. Callers should fall back to hardcoded column
 * offsets when null is returned (graceful degradation).
 *
 * Examples:
 *   "Well No."   → "well_no"     : 7
 *   "Lease Name" → "lease_name"  : 4
 *   "API No."    → "api_no"      : 0
 */
export function detectTrrcColumns(html: string): Record<string, number> | null {
  const allRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  const headerRow = allRows.find(row => /<th/i.test(row));
  if (!headerRow) return null;

  const thCells = headerRow.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) ?? [];
  if (thCells.length < 2) return null;

  const cols: Record<string, number> = {};
  thCells.forEach((th, i) => {
    const name = th
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g,  " ")
      .replace(/&amp;/g,   "&")
      .replace(/\s+/g,     " ")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g,    "");
    if (name) cols[name] = i;
  });

  return Object.keys(cols).length >= 2 ? cols : null;
}

// ── ICE portal dynamic component ID extraction ────────────────────────────────

/**
 * Live JSF/PrimeFaces component IDs for the TRRC ICE portal.
 * The j_idt* segments are auto-generated and change on every server redeploy.
 */
export type IceIds = {
  /** TabView component ID, e.g. "j_idt39" */
  tabViewId: string;
  /** Inspections search button ID (short segment), e.g. "j_idt95" */
  inspBtnId: string;
  /** Violations search button ID (short segment), e.g. "j_idt181" */
  violBtnId: string;
};

/** Last-known-good defaults — used as fallback when live extraction fails. */
export const ICE_ID_DEFAULTS: IceIds = {
  tabViewId: "j_idt39",
  inspBtnId: "j_idt95",
  violBtnId: "j_idt181",
};

/**
 * Extract auto-generated PrimeFaces component IDs from the TRRC ICE portal HTML.
 *
 * PrimeFaces assigns sequential j_idt* IDs to unnamed components on each server
 * deployment. Hardcoding them causes silent breakage after any TRRC server update.
 *
 * Extracts:
 *   tabViewId — from the hidden _activeIndex input (`IceQueryForm:j_idt39_activeIndex`)
 *   inspBtnId — first submit button scoped to IceQueryForm:{tabViewId}:*
 *   violBtnId — second submit button (violations tab, appears later in the DOM)
 *
 * Falls back to ICE_ID_DEFAULTS on any failure so callers always get usable IDs.
 */
export function extractIceIds(html: string): IceIds {
  const result: IceIds = { ...ICE_ID_DEFAULTS };

  // TabView ID from its hidden activeIndex input:
  //   <input type="hidden" name="IceQueryForm:j_idt39_activeIndex" ...>
  const tabM = html.match(/name=["']IceQueryForm:(\w+)_activeIndex["']/i);
  if (tabM) result.tabViewId = tabM[1];

  // Collect submit button IDs scoped to this form+tabView.
  // PrimeFaces commandButton renders as <button type="submit" class="ui-button ...">
  // or (older PF) as <input type="submit" ...>.
  // The first one is the inspections button; the second is the violations button.
  const btnIds: string[] = [];

  const addBtnId = (attrs: string) => {
    const idM = attrs.match(/(?:id|name)=["'](IceQueryForm:\w+:\w+)["']/i);
    if (!idM) return;
    const parts = idM[1].split(":");
    if (parts.length !== 3 || parts[1] !== result.tabViewId) return;
    if (!btnIds.includes(parts[2])) btnIds.push(parts[2]);
  };

  const btnRe = /<button([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = btnRe.exec(html)) !== null) {
    if (/type=["']submit["']|class=["'][^"']*ui-button/i.test(m[1])) addBtnId(m[1]);
  }

  const inputRe = /<input([^>]+)>/gi;
  while ((m = inputRe.exec(html)) !== null) {
    if (/type=["']submit["']/i.test(m[1])) addBtnId(m[1]);
  }

  if (btnIds.length >= 1) result.inspBtnId = btnIds[0];
  if (btnIds.length >= 2) result.violBtnId = btnIds[1];

  return result;
}

/**
 * Build a column resolver for a TRRC EWA data row, given a detected column map.
 *
 * When `colMap` is non-null, resolves column values by header name (robust).
 * When null, resolves by `apiCellIdx + fallbackOffset` (hardcoded, brittle).
 *
 * @param colMap         Output of detectTrrcColumns(), or null
 * @param headerApiIdx   Index of the "api" column in the header row (usually 0)
 * @param cells          Cell text array for the current data row
 * @param dataCellApiIdx Index of the API value in `cells`
 */
export function makeColResolver(
  colMap:         Record<string, number> | null,
  headerApiIdx:   number,
  cells:          string[],
  dataCellApiIdx: number,
) {
  return (colName: string, fallbackOffset: number): string | null => {
    if (colMap) {
      const hIdx = colMap[colName];
      if (hIdx !== undefined) {
        const dIdx = dataCellApiIdx + (hIdx - headerApiIdx);
        return cells[dIdx] ?? null;
      }
    }
    return cells[dataCellApiIdx + fallbackOffset] ?? null;
  };
}
