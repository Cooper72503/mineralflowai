/**
 * Supabase Edge Function: trrc-dd-execute
 *
 * Aggressive TRRC retrieval engine.
 * Input: run_id — the Supabase row that contains user-provided API, lease, operator.
 * Behavior: multi-phase search using ALL three inputs, every angle tried,
 *           context enriched between phases so later steps benefit from earlier findings.
 *
 * POST body: { run_id: string }
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentContext {
  api_numbers:      string[];
  district:         string | null;
  lease_number:     string | null;
  operator_name:    string | null;
  operator_number:  string | null;
  county:           string | null;
  production:       ProductionRow[];
  agentReport:      null;
}

interface ProductionRow {
  year?:           number;
  month?:          number;
  oil_bbl?:        number | null;
  gas_mcf?:        number | null;
  casinghead_mcf?: number | null;
  condensate_bbl?: number | null;
  water_bbl?:      number | null;
  [key: string]: unknown;
}

interface ToolResult {
  ok:      boolean;
  data:    unknown;
  summary: string;
}

interface ProxyResponse {
  html:       string;
  status:     number;
  set_cookie: string[];
}

// ─── HTML parsers ─────────────────────────────────────────────────────────────

function extractText(html: string, maxLen = 4000): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function extractTableRows(html: string, maxRows = 50): string[][] {
  const rows: string[][] = [];
  const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rowMatches) {
    const cells: string[] = [];
    const cellMatches = row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
    for (const cell of cellMatches) {
      cells.push(cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    }
    if (cells.length > 0) rows.push(cells);
    if (rows.length >= maxRows) break;
  }
  return rows;
}

const NOISE_PATTERNS: RegExp[] = [
  /function\s+\w+\s*\(/,
  /doSearch/,
  /Please\s+[Cc]orrect/,
  /Oil\s+&\s+Gas\s+Data\s+Query/i,
  /Search\s+Criteria/i,
  /Inactivity:\s*None/i,
  /Or\s+Search\s+by/i,
  /Links\s+Images\s+GIS/i,
  /Page:\s*\d+\s+of\s+\d+/i,
];

function isNoiseRow(row: string[]): boolean {
  if (row.every(c => !c.trim() || c === "&nbsp;")) return true;
  const joined = row.join(" ");
  return NOISE_PATTERNS.some(p => p.test(joined));
}

function isHeaderRow(
  row: string[],
  minCols = 3,
  kw: RegExp = /API|District|Lease|Operator|Aging|Inactive|Field|Depth|Potential|Allowable|Orphan|Severance|Formation|County/i,
): boolean {
  if (row.length < minCols) return false;
  const matches = row.filter(c => c.length > 0 && c.length <= 50 && kw.test(c));
  return matches.length >= 2;
}

/**
 * Parse monthly production rows from specificLeaseQueryAction.do HTML.
 *
 * The page's complex tab/navigation structure causes extractTableRows to produce
 * unusable field names. Instead we scan the visible text for rows that start with
 * a Month Year pattern and extract the four production/disposition values that follow.
 *
 * Each row in the visible text: {Month} {Year} {oil_prod} {oil_disp} {gas_prod} {gas_disp} ...
 * Values are either "NO RPT" (inactive) or a number like "1,234".
 */
function parseSpecificLeaseMonthly(html: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  const clean = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<select[^>]*>[\s\S]*?<\/select>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ");

  // TRRC specificLeaseQueryAction.do production table column order (for oil leases):
  //   Month Year | Oil Prod | Oil Disp | Gas Prod | Gas Disp | Casinghead Prod | Casinghead Disp
  //              | Condensate Prod | Condensate Disp | Water Prod | Water Disp
  //
  // We capture only the "Prod" columns (odd positions after Month+Year), skipping "Disp".
  // The regex matches up to 10 consecutive VALUE tokens after Month+Year; trailing optional
  // groups handle leases that have fewer columns (e.g. gas-only leases).
  //
  // Group index map (1-based):
  //   m[1]=month  m[2]=year
  //   m[3]=oil_prod   m[4]=oil_disp
  //   m[5]=gas_prod   m[6]=gas_disp
  //   m[7]=casing_prod  m[8]=casing_disp
  //   m[9]=cond_prod  m[10]=cond_disp   (optional)
  //   m[11]=water_prod m[12]=water_disp  (optional)
  const VALUE = "(?:NO RPT|[\\d,]+)";
  const rowRe = new RegExp(
    `(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+(\\d{4})\\s+` +
    `(${VALUE})\\s+(${VALUE})\\s+(${VALUE})\\s+(${VALUE})\\s+(${VALUE})\\s+(${VALUE})` +
    `(?:\\s+(${VALUE})\\s+(${VALUE})(?:\\s+(${VALUE})\\s+(${VALUE}))?)?`,
    "gi",
  );

  const parseVal = (v: string | undefined): string =>
    !v || v === "NO RPT" ? "" : v.replace(/,/g, "");

  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(clean)) !== null) {
    records.push({
      date:           `${m[1]} ${m[2]}`,
      year:           m[2],
      month:          m[1],
      oil_bbl:        parseVal(m[3]),
      gas_mcf:        parseVal(m[5]),
      casinghead_mcf: parseVal(m[7]),
      condensate_bbl: parseVal(m[9]),
      water_bbl:      parseVal(m[11]),
    });
  }
  return records;
}

/** Extract all hidden <input type="hidden"> name→value pairs from an HTML form. */
function extractHiddenInputs(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Handle both attribute orderings: name before value, and value before name
  const re = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag  = m[0];
    const name = (tag.match(/name=["']([^"']+)["']/) ?? [])[1] ?? "";
    const val  = (tag.match(/value=["']([^"']*)["']/) ?? [])[1] ?? "";
    if (name) fields[name] = val;
  }
  return fields;
}

/**
 * Parse wellbore records from wellboreQueryAction.do HTML.
 *
 * Standard extractTableRows() fails on this page because each data row's outer
 * <tr> contains nested <table> elements (for the API-number link and the
 * lease-number link). The lazy </tr> regex closes on the inner table's row
 * before the outer row ends, so dist/lease/operator fields are never captured.
 *
 * Instead each field is sourced from where TRRC actually encodes it:
 *   distCode, leaseNo, apiNo  → URL params of leaseDetailAction.do hrefs
 *   operator_name, op_no      → text/title of <a title="Operator # NNN"> anchors
 *   county                    → text of <a title="County # NNN"> anchors
 */
function parseWellboreHtml(html: string): Array<Record<string, string>> {
  // ── 1. Collect ordered (apiNo, distCode, leaseNo) from searchType=apiNo links ──
  const apiLinks: Array<{ apiNo: string; distCode: string; leaseNo: string }> = [];
  // TRRC inserts ;jsessionid=XXX between ".do" and "?" in every href.
  // [^?"']* absorbs the ;jsessionid segment so \? matches the query-string start.
  // The title "Lease detail for API number" distinguishes the apiNo-type link from
  // the distLease-type link that appears in the same row.
  const apiLinkRe = /href=["']leaseDetailAction\.do[^?"']*\?([^"']+)["'][^>]*title=["']Lease detail for API/gi;
  let m: RegExpExecArray | null;
  while ((m = apiLinkRe.exec(html)) !== null) {
    try {
      const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
      const distCode = params.get("distCode") ?? "";
      const leaseNo  = params.get("leaseNo")  ?? "";
      const apiNo    = params.get("apiNo")     ?? "";
      if (distCode && leaseNo) {
        apiLinks.push({ apiNo, distCode, leaseNo });
      }
    } catch { /* skip malformed params */ }
  }

  // Fallback 2: title attribute absent or in wrong order — match by searchType=apiNo in query params
  if (apiLinks.length === 0) {
    const fallbackRe = /href=["']leaseDetailAction\.do[^?"']*\?([^"']*searchType=apiNo[^"']*)["']/gi;
    while ((m = fallbackRe.exec(html)) !== null) {
      try {
        const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
        const distCode = params.get("distCode") ?? "";
        const leaseNo  = params.get("leaseNo")  ?? "";
        const apiNo    = params.get("apiNo")     ?? "";
        if (distCode && leaseNo) {
          apiLinks.push({ apiNo, distCode, leaseNo });
        }
      } catch { /* skip */ }
    }
  }

  // Fallback 3: catch ANY leaseDetailAction.do link that has distCode + leaseNo params.
  // Needed for lease-based wellbore queries where TRRC uses searchType=lease links instead
  // of searchType=apiNo — neither the title regex nor fallback 2 would match those.
  if (apiLinks.length === 0) {
    const genericRe = /href=["']leaseDetailAction\.do[^?"']*\?([^"']+)["']/gi;
    const seen      = new Set<string>();
    while ((m = genericRe.exec(html)) !== null) {
      try {
        const params   = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
        const distCode = params.get("distCode") ?? "";
        const leaseNo  = params.get("leaseNo")  ?? "";
        const apiNo    = params.get("apiNo")     ?? "";
        const key      = `${distCode}:${leaseNo}:${apiNo}`;
        if (distCode && leaseNo && !seen.has(key)) {
          seen.add(key);
          apiLinks.push({ apiNo, distCode, leaseNo });
        }
      } catch { /* skip */ }
    }
  }

  if (apiLinks.length === 0) return [];

  // ── 2. Operator names+numbers in order from titled anchors ──
  const operators: Array<{ name: string; no: string }> = [];
  const opRe = /<a[^>]*title=["']Operator\s*#\s*(\d+)[^"']*["'][^>]*>([^<]+)<\/a>/gi;
  while ((m = opRe.exec(html)) !== null) {
    operators.push({ no: m[1].trim(), name: m[2].trim() });
  }

  // ── 3. County names in order from titled anchors ──
  const counties: string[] = [];
  const countyRe = /<a[^>]*title=["']County\s*#[^"']*["'][^>]*>([^<]+)<\/a>/gi;
  while ((m = countyRe.exec(html)) !== null) {
    counties.push(m[1].trim());
  }

  // ── 4. Correlate by index — all lists are ordered by row position ──
  return apiLinks.map((link, i) => ({
    api_no:        link.apiNo,
    dist_code:     link.distCode,
    lease_no:      link.leaseNo,
    operator_name: operators[i]?.name ?? "",
    operator_no:   operators[i]?.no   ?? "",
    county:        counties[i]        ?? "",
  }));
}

// ─── ICE/JSF helpers ─────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractViewState(text: string): string | null {
  const m = text.match(
    /name=["']javax\.faces\.ViewState["'][^>]*value=["']([^"']+)["']/i,
  ) ?? text.match(
    /value=["']([^"']+)["'][^>]*name=["']javax\.faces\.ViewState["']/i,
  );
  const xmlM = text.match(
    /<update[^>]*id=["'][^"']*ViewState[^"']*["'][^>]*>(?:<!\[CDATA\[)?([^<\]]+)/i,
  );
  return m ? m[1] : xmlM ? xmlM[1].trim() : null;
}

function extractSetCookieValue(setCookies: string[], name: string): string | null {
  for (const cookie of setCookies) {
    const m = cookie.match(new RegExp(`${name}=([^;,\\s]+)`, "i"));
    if (m) return m[1];
  }
  return null;
}

function extractPartialUpdate(xml: string, targetId: string): string | null {
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<update[^>]*id=["']${escaped}["'][^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</update>`,
    "i",
  );
  const m = xml.match(re);
  if (!m) return null;
  return m[1].replace(/\]\]>?\s*$/, "").replace(/^<!\[CDATA\[/, "").trim() || null;
}

function extractIceIds(html: string): { tabViewId: string; violBtnId: string } {
  const DEFAULTS = { tabViewId: "j_idt39", violBtnId: "j_idt181" };
  const tabM = html.match(/IceQueryForm:(j_idt\d+)_activeIndex/i)
    ?? html.match(/id="IceQueryForm:(j_idt\d+)"[^>]*role="tablist"/i)
    ?? html.match(/IceQueryForm:(j_idt\d+):qvapino/i);
  if (!tabM) return DEFAULTS;
  const tabViewId = tabM[1];
  const btnRe = new RegExp(
    `IceQueryForm:${tabViewId}:(j_idt\\d+)[^"]*"[^>]*type="submit"`,
    "i",
  );
  const btnM = html.match(btnRe);
  return { tabViewId, violBtnId: btnM ? btnM[1] : DEFAULTS.violBtnId };
}

function toApiMask(api10: string): string {
  const digits = api10.replace(/\D/g, "");
  const api8 = digits.startsWith("42") && digits.length === 10
    ? digits.slice(2)
    : digits.slice(0, 8).padEnd(8, "0");
  return `${api8.slice(0, 3)}-${api8.slice(3, 8)}`;
}

function parseViolResultsHtml(html: string): Record<string, string>[] {
  if (!html || html.length < 50) return [];
  if (/your search returned no results/i.test(html)) return [];
  if (/showing 0.0 out of 0/i.test(html)) return [];

  const violations: Record<string, string>[] = [];
  const rowRe  = /<tr[^>]*data-ri="\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cellM: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      cells.push(stripHtml(cellM[1]));
    }
    if (cells.length < 4) continue;
    violations.push({
      date:        cells[0]  ?? "",
      district:    cells[1]  ?? "",
      operator:    cells[2]  ?? "",
      operator_no: cells[3]  ?? "",
      lease_no:    cells[4]  ?? "",
      lease_name:  cells[5]  ?? "",
      api_no:      cells[6]  ?? "",
      county:      cells[7]  ?? "",
      well_no:     cells[8]  ?? "",
      rule:        cells[11] ?? "",
      rule_desc:   cells[12] ?? "",
      is_major:    cells[13] ?? "",
      compliant:   cells[14] ?? "",
      enf_action:  cells[15] ?? "",
      enf_date:    cells[16] ?? "",
    });
  }
  return violations;
}

// ─── TRRC fetch helpers ───────────────────────────────────────────────────────

const EWA_BASE        = "https://webapps2.rrc.texas.gov/EWA";
const ICE_URL         = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";
const EWA_PROXY_URL   = `${Deno.env.get("APP_URL") ?? ""}/api/trrc/ewa-proxy`;
const EWA_PROXY_SECRET = Deno.env.get("TRRC_EWA_PROXY_SECRET") ?? "";

const ALL_DISTRICTS = ["01","02","03","04","05","06","6E","7B","7C","08","8A","09","10"];

function splitApi(apiRaw: string): { prefix: string; suffix: string } | null {
  const digits = apiRaw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return { prefix: digits.slice(2, 5), suffix: digits.slice(5, 10) };
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function callProxy(
  url:           string,
  method:        string,
  body?:         string,
  cookies?:      string,
  extraHeaders?: Record<string, string>,
): Promise<ProxyResponse> {
  if (!EWA_PROXY_URL.startsWith("http")) {
    throw new Error("APP_URL env var not set — cannot proxy EWA requests");
  }
  const res = await fetch(EWA_PROXY_URL, {
    method: "POST",
    signal: AbortSignal.timeout(35_000),
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${EWA_PROXY_SECRET}`,
    },
    body: JSON.stringify({ url, method, body, cookies, extra_headers: extraHeaders }),
  });
  if (!res.ok) throw new Error(`EWA proxy returned HTTP ${res.status}`);
  const json = await res.json() as ProxyResponse & { error?: string };
  if (json.error) throw new Error(`EWA proxy error: ${json.error}`);
  if (!json.html) throw new Error("EWA proxy returned no HTML");
  if ((json.status ?? 200) >= 400) throw new Error(`EWA returned HTTP ${json.status}`);
  return { html: json.html, status: json.status ?? 200, set_cookie: json.set_cookie ?? [] };
}

async function fetchHtml(url: string, opts: RequestInit = {}): Promise<string> {
  const method = (opts.method ?? "GET").toUpperCase();
  const body   = opts.body ? String(opts.body) : undefined;
  return (await callProxy(url, method, body)).html;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function toolSearchByApi(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) return { ok: false, data: { error: "api_number required" }, summary: "search_by_api: no input" };

  const digits = apiRaw.replace(/\D/g, "");
  // Warn if input has extra digits (malformed API — e.g. user typed 11-digit instead of 10)
  const extraDigits = digits.length > 10;
  const api10 = digits.slice(0, 10);
  const split = splitApi(api10);

  if (!split) {
    return { ok: false, data: { error: "API number must be at least 10 digits" }, summary: `search_by_api: invalid API ${apiRaw}` };
  }

  try {
    const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
      method: "POST",
      body: formBody({
        "searchArgs.apiNoPrefixArg":  split.prefix,
        "searchArgs.apiNoSuffixArg":  split.suffix,
        "searchArgs.scheduleTypeArg": "Both",
        "methodToCall":               "search",
      }),
    });

    // parseWellboreHtml sources data from URL params and titled anchors because
    // the TRRC response nests tables inside rows, which breaks the lazy </tr>
    // regex used by extractTableRows — the inner table's </tr> closes first.
    const wells = parseWellboreHtml(html);

    if (wells.length === 0) {
      // Also try plain text check — sometimes TRRC returns a "not found" message
      const bodyText = extractText(html, 500);
      return {
        ok: true,
        data: {
          found:         false,
          api_number:    api10,
          input_warning: extraDigits ? `Input had ${digits.length} digits; only 10 used. Verify API number.` : null,
          message:       `API 42-${split.prefix}-${split.suffix} NOT FOUND in TRRC wellbore PDQ. Well may not yet be in production database.`,
          body_text:     bodyText,
        },
        summary: `search_by_api: 42-${split.prefix}-${split.suffix} — NOT FOUND in TRRC`,
      };
    }

    const first    = wells[0];
    const leaseNo  = first["lease_no"]      ?? "";
    const distCode = first["dist_code"]     ?? "";
    const operator = first["operator_name"] ?? "";
    const county   = first["county"]        ?? "";

    const operatorNo = first["operator_no"] ?? "";

    if (!ctx.api_numbers.includes(api10))       ctx.api_numbers.push(api10);
    // Always use the TRRC-returned district — it overrides any inferred value
    // (county code → district inference is unreliable when wells cross district lines)
    if (distCode)                               ctx.district         = distCode;
    if (!ctx.lease_number     && leaseNo)       ctx.lease_number     = leaseNo;
    if (!ctx.operator_name    && operator)      ctx.operator_name    = operator;
    if (!ctx.operator_number  && operatorNo)    ctx.operator_number  = operatorNo;
    if (!ctx.county           && county)        ctx.county           = county;

    return {
      ok: true,
      data: {
        found:          true,
        api_number:     api10,
        formatted_api:  `42-${split.prefix}-${split.suffix}`,
        input_warning:  extraDigits ? `Input had ${digits.length} digits; only 10 used.` : null,
        lease_number:   leaseNo,
        district:       distCode,
        operator,
        operator_no:    operatorNo,
        county,
        total_wellbores: wells.length,
        wellbores:      wells.slice(0, 10),
        source:         "ewa-wellbore",
        trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`,
      },
      summary: `search_by_api: 42-${split.prefix}-${split.suffix} → Lease ${leaseNo} / District ${distCode} / ${wells.length} wellbore(s) / Operator: ${operator}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_api: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolSearchByLease(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo  = String(input.lease_number ?? "").trim();
  const distHint = String(input.district ?? "").trim();
  if (!leaseNo) {
    return { ok: false, data: { error: "lease_number required" }, summary: "search_by_lease: missing lease_number" };
  }

  // Uses parseWellboreHtml (not extractTableRows) because wellboreQueryAction.do has nested
  // tables inside rows — the lazy </tr> regex in extractTableRows closes on the inner table's
  // row before the outer row ends, producing empty/wrong field values.
  const tryDistrict = async (dist: string, leaseType: string): Promise<Array<Record<string,string>> | null> => {
    try {
      const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.leaseNumberArg":  leaseNo,
          "searchArgs.districtCodeArg": dist,
          "searchArgs.leaseTypeArg":    leaseType,
          "searchArgs.scheduleTypeArg": "Both",
          "methodToCall":               "search",
        }),
      });
      const wells = parseWellboreHtml(html);
      return wells.length > 0 ? wells : null;
    } catch {
      return null;
    }
  };

  // Try the hinted district first (both oil and gas), then scan all remaining districts
  const districtsToTry = distHint
    ? [distHint, ...ALL_DISTRICTS.filter(d => d !== distHint)]
    : ALL_DISTRICTS;

  for (const dist of districtsToTry) {
    for (const lt of ["O", "G"]) {
      const wells = await tryDistrict(dist, lt);
      if (wells && wells.length > 0) {
        const first    = wells[0];
        // parseWellboreHtml returns dist_code, lease_no, api_no, operator_name, operator_no, county
        const distCode = first["dist_code"] || dist;
        const api      = first["api_no"] ?? "";
        const operator = first["operator_name"] ?? "";
        const opNo     = first["operator_no"] ?? "";
        const county   = first["county"] ?? "";

        // Always update district from confirmed TRRC result
        if (distCode) ctx.district = distCode;
        if (!ctx.lease_number) ctx.lease_number = leaseNo;
        if (api) {
          const api10 = api.replace(/\D/g, "").slice(0, 10);
          if (api10.length === 10 && !ctx.api_numbers.includes(api10)) ctx.api_numbers.push(api10);
        }
        if (!ctx.operator_name   && operator)                        ctx.operator_name   = operator;
        if (!ctx.operator_number && opNo && /^\d{5,}$/.test(opNo)) ctx.operator_number = opNo;
        if (!ctx.county          && county)                          ctx.county          = county;

        return {
          ok: true,
          data: {
            found:        true,
            lease_number: leaseNo,
            district:     distCode,
            lease_type:   lt,
            operator,
            operator_no:  opNo,
            county,
            wells:        wells.slice(0, 10),
            trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.leaseNumberArg=${leaseNo}&searchArgs.districtCodeArg=${dist}&searchArgs.leaseTypeArg=${lt}&searchArgs.scheduleTypeArg=Both&methodToCall=search`,
          },
          summary: `search_by_lease: Lease ${leaseNo} / District ${distCode} (${lt}) — ${wells.length} wellbore(s)`,
        };
      }
    }
  }

  return {
    ok: true,
    data: { found: false, lease_number: leaseNo, error: `Lease ${leaseNo} not found in any TRRC district (all ${ALL_DISTRICTS.length} districts tried)` },
    summary: `search_by_lease: Lease ${leaseNo} — NOT FOUND in any TRRC district`,
  };
}

async function toolSearchByOperator(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const opName = input.operator_name   ? String(input.operator_name).trim()   : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  if (!opName && !opNo) {
    return { ok: false, data: { error: "operator_name or operator_number required" }, summary: "search_by_operator: no input" };
  }

  const tryOrgQuery = async (params: Record<string, string>): Promise<Record<string, string> | null> => {
    try {
      const html      = await fetchHtml(`${EWA_BASE}/organizationQueryAction.do`, { method: "POST", body: formBody(params) });
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /Operator No|Operator Name|Organization/i));
      if (hIdx < 0 || cleanRows.length <= hIdx + 1) return null;
      const header   = cleanRows[hIdx] ?? [];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r));
      if (dataRows.length === 0) return null;
      const rec: Record<string, string> = {};
      header.forEach((h, i) => { rec[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = dataRows[0][i] ?? ""; });
      return rec;
    } catch {
      return null;
    }
  };

  // Try by operator number first (most reliable), then by wellbore query with name-based fallback
  let rec: Record<string, string> | null = null;

  if (opNo) {
    rec = await tryOrgQuery({ "methodToCall": "search", "searchArgs.operatorNumbersArg": opNo });
  }

  // If number lookup failed and we have a name, try searching wellbore PDQ by operator name
  // (EWA wellboreQueryAction supports operatorNameArg for fuzzy name matching).
  // Uses parseWellboreHtml — NOT extractTableRows — because the wellbore page uses nested tables.
  if (!rec && opName) {
    try {
      const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.operatorNameArg":  opName,
          "searchArgs.scheduleTypeArg":  "Both",
          "methodToCall":                "search",
        }),
      });
      const wells = parseWellboreHtml(html);
      if (wells.length > 0) {
        const first       = wells[0];
        const foundOpNo   = first["operator_no"]   ?? "";
        const foundOpName = first["operator_name"] ?? opName ?? "";
        const leaseNo     = first["lease_no"]      ?? "";
        const distCode    = first["dist_code"]     ?? "";
        if (foundOpNo && /^\d{5,}$/.test(foundOpNo)) ctx.operator_number = foundOpNo;
        if (!ctx.operator_name)                       ctx.operator_name   = foundOpName;
        if (!ctx.district     && distCode)            ctx.district        = distCode;
        if (!ctx.lease_number && leaseNo)             ctx.lease_number    = leaseNo;
        return {
          ok:   true,
          data: {
            found:           true,
            operator_name:   foundOpName,
            operator_no:     foundOpNo,
            source:          "wellbore-name-search",
            wellbores_found: wells.length,
            note:            `Found ${wells.length} wellbore(s) for operator name "${opName}" — operator number resolved from first result.`,
          },
          summary: `search_by_operator: "${opName}" (${foundOpNo}) — found via wellbore name search (${wells.length} results)`,
        };
      }
    } catch { /* fall through */ }
  }

  if (!rec) {
    return {
      ok:   true,
      data: { found: false, message: `No TRRC organization record found for operator "${opName ?? opNo}".` },
      summary: `search_by_operator: "${opName ?? opNo}" — not found`,
    };
  }

  const resolvedOpNo   = rec["operator_no_"] ?? rec["operator_no"] ?? "";
  const resolvedName   = rec["operator_name"] ?? opName ?? "";
  const orgStatus      = rec["organization_status"] ?? rec["org_status"] ?? rec["status"] ?? "";
  const tnrFlag        = (rec["_tnr_91_114"] ?? rec["tnr_91114"] ?? "").toUpperCase() === "YES" ||
                         (rec["_tnr_91_114"] ?? rec["tnr_91114"] ?? "").toUpperCase() === "Y";

  if (!ctx.operator_number && resolvedOpNo && /^\d{5,}$/.test(resolvedOpNo.replace(/\D/g, ""))) {
    ctx.operator_number = resolvedOpNo;
  }
  if (!ctx.operator_name && resolvedName) ctx.operator_name = resolvedName;

  return {
    ok:   true,
    data: {
      found:           true,
      operator_name:   resolvedName,
      operator_no:     resolvedOpNo,
      org_status:      orgStatus,
      tnr_91114_flag:  tnrFlag,
      mailing_address: [rec["mailing_address"], rec["mailing_city"], rec["mailing_state"], rec["mailing_zip"]].filter(Boolean).join(", "),
      phone:           rec["phone_no_"] ?? rec["phone_no"] ?? "",
      raw:             rec,
      trrc_source_url: resolvedOpNo
        ? `https://webapps2.rrc.texas.gov/EWA/p5QueryAction.do?searchArgs.operatorNumbersArg=${resolvedOpNo}&methodToCall=search`
        : `https://webapps2.rrc.texas.gov/EWA/organizationQueryAction.do`,
    },
    summary: `search_by_operator: "${resolvedName}" (${resolvedOpNo}) — ${orgStatus}${tnrFlag ? " [⚠ TNR §91.114 FLAG]" : ""}`,
  };
}

async function toolFetchProduction(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo  = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number;
  const distHint = input.district     ? String(input.district).trim()     : ctx.district;
  const apiRaw   = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;

  const parseTable = (html: string, kwRe: RegExp, minCols = 3) => {
    if (/Please\s+[Cc]orrect/i.test(html) || /errors?\s+list/i.test(html)) return null;
    const rows      = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, minCols, kwRe));
    if (hIdx < 0 || cleanRows.length <= hIdx + 1) return null;
    const header   = cleanRows[hIdx] ?? [];
    const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= minCols && !isNoiseRow(r)).map(row => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
      return obj;
    });
    if (dataRows.length === 0) return null;
    return { header, dataRows };
  };

  const monthlyRecords: Record<string, string>[] = [];
  const prorationRecords: Record<string, string>[] = [];
  let trrcUrl = "https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/production-data/";
  let confirmedDistrict: string | null = null;

  // ── Monthly production: 3-step TRRC EWA session flow ──────────────────────
  // productionQueryAction.do does NOT accept a direct leaseNumberArg parameter.
  // The correct flow is:
  //   1. GET productionQueryAction.do → session cookie (JSESSIONID) + hidden form state
  //   2. POST productionQueryAction.do with operator + district → lease list page
  //      containing specificLeaseQueryAction.do links per lease
  //   3. GET specificLeaseQueryAction.do for the target lease → monthly rows
  //
  // This requires operator_number in ctx (populated by search_by_api from
  // the title="Operator # NNN" anchor on the wellbore page).
  const opNo = ctx.operator_number ?? null;
  const districtsToTry = distHint
    ? [distHint, ...ALL_DISTRICTS.filter(d => d !== distHint)]
    : ALL_DISTRICTS;

  if (leaseNo && opNo) {
    try {
      // Step 1: establish EWA session
      const sessionResp  = await callProxy(`${EWA_BASE}/productionQueryAction.do`, "GET");
      const jsessionId   = extractSetCookieValue(sessionResp.set_cookie, "JSESSIONID");
      const hiddenFields = extractHiddenInputs(sessionResp.html);
      const cookie       = jsessionId ? `JSESSIONID=${jsessionId}` : undefined;
      const prodUrl      = jsessionId
        ? `${EWA_BASE}/productionQueryAction.do;jsessionid=${jsessionId}`
        : `${EWA_BASE}/productionQueryAction.do`;

      for (const dist of districtsToTry) {
        if (monthlyRecords.length > 0) break;
        for (const lt of ["O", "G"]) {
          if (monthlyRecords.length > 0) break;
          try {
            // Step 2: search by operator + district to get the lease list
            const operatorFields: Record<string, string> = {
              ...hiddenFields,
              "methodToCall":                          "search",
              "searchArgs.operatorNumbersArg":         opNo,
              "searchArgs.districtCodeArg":            dist,
              "searchArgs.leaseTypeArg":               lt,
              "searchArgs.initialViewArg":             "Lease",
              "searchArgs.startMonthArg":              "01",
              "searchArgs.startYearArg":               "1993",
              "searchArgs.endMonthArg":                "12",
              "searchArgs.endYearArg":                 String(new Date().getFullYear()),
            };
            const operatorHtml = (await callProxy(prodUrl, "POST", formBody(operatorFields), cookie)).html;

            // Step 3: find the specificLeaseQueryAction link for target lease number
            const specificLinkRe = new RegExp(
              `href=["'](specificLeaseQueryAction\\.do[^"']*(?:&amp;|&)leaseNo=${leaseNo}[^"']*)["']`,
              "i",
            );
            const linkMatch = operatorHtml.match(specificLinkRe);
            if (!linkMatch) continue;

            const specificPath = linkMatch[1].replace(/&amp;/g, "&");
            const specificUrl  = `${EWA_BASE}/${specificPath}`;
            const leaseHtml    = (await callProxy(specificUrl, "GET", undefined, cookie)).html;

            const parsed = parseSpecificLeaseMonthly(leaseHtml);
            if (parsed.length > 0) {
              monthlyRecords.push(...parsed.slice(0, 60));
              confirmedDistrict = dist;
              if (!ctx.district) ctx.district = dist;
              trrcUrl = specificUrl;
            }
          } catch { /* continue to next district/type */ }
        }
      }
    } catch { /* session setup failed — fall through to "not found" */ }
  }

  // ── Proration by API (both oil and gas) ───────────────────────────────────
  const tryProration = async (params: Record<string, string>) => {
    for (const [ep, lt] of [[`${EWA_BASE}/oilProQueryAction.do`, "OIL"], [`${EWA_BASE}/gasProQueryAction.do`, "GAS"]] as [string,string][]) {
      try {
        const html   = await fetchHtml(ep, { method: "POST", body: formBody({ ...params, "methodToCall": "search" }) });
        const parsed = parseTable(html, /API|District|Lease|Potential|Allowable/i);
        if (parsed) {
          prorationRecords.push(...parsed.dataRows.map(r => ({ ...r, _lease_type: lt })));
        }
      } catch { /* continue */ }
    }
  };

  if (apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      await tryProration({
        "searchArgs.apiPrefixArg": split.prefix,
        "searchArgs.apiSuffixArg": split.suffix,
        ...(confirmedDistrict ? { "searchArgs.districtCodeArg": confirmedDistrict } : {}),
      });
    }
  }
  if (leaseNo && confirmedDistrict && prorationRecords.length === 0) {
    await tryProration({ "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": confirmedDistrict });
  }

  if (monthlyRecords.length === 0 && prorationRecords.length === 0) {
    return {
      ok: true,
      data: {
        found:       false,
        lease_number: leaseNo,
        district:    distHint,
        note:        !leaseNo
          ? "No lease number available — production query requires a lease number. Run search_by_api first."
          : !opNo
          ? `No operator number available — TRRC production query requires operator number to navigate session-based EWA form. Run search_by_api to resolve it.`
          : `No production records found for Lease ${leaseNo} (Operator ${opNo}) in any TRRC district (${ALL_DISTRICTS.length} districts × 2 lease types scanned).`,
        trrc_source_url: trrcUrl,
      },
      summary: `fetch_production: no records found — Lease ${leaseNo ?? "?"} scanned all districts`,
    };
  }

  const MONTH_ABBR: Record<string, number> = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  };
  const parseNum = (v: string | undefined): number | null => {
    if (!v || v === "NO RPT") return null;
    const n = parseFloat(v.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  };
  for (const row of monthlyRecords) {
    const yr    = parseInt(row["year"] ?? "0", 10) || null;
    const rawMo = (row["month"] ?? "").trim().toLowerCase();
    const mo    = MONTH_ABBR[rawMo.slice(0, 3)] ?? (parseInt(rawMo, 10) || null);
    if (yr && mo) {
      ctx.production.push({
        year:           yr,
        month:          mo,
        oil_bbl:        parseNum(row["oil_bbl"]),
        gas_mcf:        parseNum(row["gas_mcf"]),
        casinghead_mcf: parseNum(row["casinghead_mcf"]),
        condensate_bbl: parseNum(row["condensate_bbl"]),
        water_bbl:      parseNum(row["water_bbl"]),
      });
    }
  }

  const firstPro = prorationRecords[0] ?? {};
  return {
    ok: true,
    data: {
      found:           true,
      lease_number:    leaseNo,
      district:        confirmedDistrict ?? distHint,
      production_rows: ctx.production.slice(0, 60),
      monthly_production: {
        record_count: monthlyRecords.length,
        records:      monthlyRecords.slice(0, 60),
        note:         `Monthly lease production volumes from TRRC specificLeaseQueryAction.do (3-step EWA session flow)`,
      },
      proration: prorationRecords.length > 0 ? {
        record_count:    prorationRecords.length,
        records:         prorationRecords.slice(0, 10),
        potential:       firstPro["potential_bbl_"] ?? firstPro["potential"] ?? null,
        daily_allowable: firstPro["daily_allowable"] ?? firstPro["allowable"] ?? null,
      } : null,
      trrc_source_url: trrcUrl,
    },
    summary: `fetch_production: ${monthlyRecords.length} monthly + ${prorationRecords.length} proration records / Lease ${leaseNo ?? "?"} District ${confirmedDistrict ?? "?"}`,
  };
}

async function toolFetchCompletionRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? ctx.api_numbers.slice(0, 5);
  if (apis.length === 0) return { ok: false, data: { error: "api_numbers required" }, summary: "fetch_completion_records: no APIs" };

  try {
    const results: Record<string, unknown>[] = [];
    for (const api of apis.slice(0, 5)) {
      const split = splitApi(api);
      if (!split) { results.push({ api, error: "invalid API format" }); continue; }
      try {
        const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
          method: "POST",
          body: formBody({
            "searchArgs.apiNoPrefixArg":  split.prefix,
            "searchArgs.apiNoSuffixArg":  split.suffix,
            "searchArgs.scheduleTypeArg": "Both",
            "methodToCall":               "search",
          }),
        });
        // Use parseWellboreHtml — NOT extractTableRows — because wellboreQueryAction.do uses
        // nested tables inside rows, breaking the lazy </tr> regex in extractTableRows.
        const wells = parseWellboreHtml(html);
        if (wells.length > 0) {
          const firstWell = wells[0];
          // parseWellboreHtml returns dist_code, lease_no, api_no, operator_name, operator_no
          const foundLease = firstWell["lease_no"]      ?? "";
          const foundDist  = firstWell["dist_code"]     ?? "";
          const foundOpNo  = firstWell["operator_no"]   ?? "";
          const foundOp    = firstWell["operator_name"] ?? "";
          if (!ctx.lease_number    && foundLease)                        ctx.lease_number    = foundLease;
          if (!ctx.district        && foundDist)                         ctx.district        = foundDist;
          if (!ctx.operator_number && foundOpNo && /^\d{5,}$/.test(foundOpNo)) ctx.operator_number = foundOpNo;
          if (!ctx.operator_name   && foundOp)                           ctx.operator_name   = foundOp;
          results.push({
            api:      `42-${split.prefix}-${split.suffix}`,
            source:   "ewa-wellbore",
            wellbores: wells.slice(0, 5),
          });
        } else {
          results.push({ api: `42-${split.prefix}-${split.suffix}`, found: false });
        }
      } catch (e) {
        results.push({ api, error: String(e).slice(0, 80) });
      }
    }

    const firstApiSplit = splitApi(apis[0] ?? "");
    return {
      ok: true,
      data: {
        apis_queried:    apis.length,
        results,
        trrc_source_url: firstApiSplit
          ? `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${firstApiSplit.prefix}&searchArgs.apiNoSuffixArg=${firstApiSplit.suffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`
          : "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do",
      },
      summary: `fetch_completion_records: wellbore data for ${results.filter(r => r["wellbores"]).length}/${apis.length} APIs`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_completion_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchInactiveWellStatus(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw    = input.api_number      ? String(input.api_number).trim()      : ctx.api_numbers[0] ?? null;
  const opNo      = input.operator_number ? String(input.operator_number).trim() : ctx.operator_number ?? null;
  const leaseType = (input.lease_type as string | undefined) ?? "O";

  const results: Record<string, unknown>[] = [];

  // Always try by API if available
  if (apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      try {
        const html      = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
          method: "POST",
          body: formBody({
            "searchArgs.apiNoPrefixArg": split.prefix,
            "searchArgs.apiNoSuffixArg": split.suffix,
            "methodToCall":              "search",
          }),
        });
        const rows      = extractTableRows(html);
        const cleanRows = rows.filter(r => !isNoiseRow(r));
        const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|Inactive|Lease|Operator|Aging/i));
        const dataRows  = hIdx >= 0 ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r)) : [];
        const isInactive = dataRows.length > 0 && !extractText(html, 500).includes("No results found");
        results.push({
          query:              "by_api",
          api_number:         `42-${split.prefix}-${split.suffix}`,
          is_inactive:        isInactive,
          inactive_records:   dataRows.length,
          records:            dataRows.slice(0, 5),
          interpretation:     isInactive
            ? "Well appears on TRRC IWAR. Plugging liability risk present."
            : "Well NOT on inactive list — no plugging liability flagged by TRRC.",
          trrc_source_url:    `https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&methodToCall=search`,
        });
      } catch (e) {
        results.push({ query: "by_api", error: String(e).slice(0, 80) });
      }
    }
  }

  // Also check by operator number if available (shows ALL inactive wells for operator — portfolio-level liability)
  if (opNo) {
    try {
      const html      = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.operatorNumbersArg": opNo,
          "searchArgs.leaseTypeArg":       leaseType,
          "methodToCall":                  "search",
        }),
      });
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|Lease|Operator|Aging/i));
      const dataRows  = hIdx >= 0 ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r)) : [];
      results.push({
        query:              "by_operator",
        operator_number:    opNo,
        inactive_well_count: dataRows.length,
        wells:              dataRows.slice(0, 20),
        trrc_source_url:    `https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do?searchArgs.operatorNumbersArg=${opNo}&methodToCall=search`,
      });
    } catch (e) {
      results.push({ query: "by_operator", error: String(e).slice(0, 80) });
    }
  }

  if (results.length === 0) {
    return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_inactive_well_status: missing input" };
  }

  const apiResult  = results.find(r => r["query"] === "by_api");
  const opResult   = results.find(r => r["query"] === "by_operator");
  const isInactive = apiResult?.["is_inactive"] === true;
  const opCount    = typeof opResult?.["inactive_well_count"] === "number" ? opResult["inactive_well_count"] : null;

  return {
    ok:   true,
    data: { results, is_inactive: isInactive, operator_inactive_count: opCount },
    summary: `fetch_inactive_well_status: API ${isInactive ? "INACTIVE" : "not inactive"}${opCount !== null ? ` / operator has ${opCount} inactive well(s)` : ""}`,
  };
}

async function toolFetchWellStatus(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;
  const dist    = input.district     ? String(input.district).trim()     : ctx.district ?? null;

  try {
    let html: string;
    let label: string;
    if (apiNum) {
      const split = splitApi(apiNum);
      if (!split) return { ok: false, data: { error: "Invalid API number format" }, summary: "fetch_well_status: invalid API" };
      html  = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.apiNoPrefixArg":  split.prefix,
          "searchArgs.apiNoSuffixArg":  split.suffix,
          "searchArgs.scheduleTypeArg": "Both",
          "methodToCall":               "search",
        }),
      });
      label = apiNum;
    } else if (leaseNo && dist) {
      html  = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.leaseNumberArg":  leaseNo,
          "searchArgs.districtCodeArg": dist,
          "searchArgs.scheduleTypeArg": "Both",
          "methodToCall":               "search",
        }),
      });
      label = `Lease ${leaseNo} District ${dist}`;
    } else {
      return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_well_status: missing input" };
    }

    // Use parseWellboreHtml — NOT extractTableRows — because wellboreQueryAction.do uses
    // nested tables inside rows, breaking the lazy </tr> regex in extractTableRows.
    const wellbores = parseWellboreHtml(html).slice(0, 21);

    const split = apiNum ? splitApi(apiNum) : null;
    return {
      ok:   true,
      data: {
        identifier:     label,
        count:          wellbores.length,
        wellbores,
        trrc_source_url: split
          ? `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`
          : leaseNo && dist
          ? `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.leaseNumberArg=${leaseNo}&searchArgs.districtCodeArg=${dist}&searchArgs.scheduleTypeArg=Both&methodToCall=search`
          : "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do",
      },
      summary: `fetch_well_status: ${label} — ${dataRows.length} wellbore record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchOrphanWell(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum = String(input.api_number ?? ctx.api_numbers[0] ?? "").trim();
  if (!apiNum) return { ok: false, data: { error: "api_number required" }, summary: "fetch_orphan_well: no input" };

  try {
    const split  = splitApi(apiNum);
    if (!split) return { ok: false, data: { error: "Invalid API number format" }, summary: "fetch_orphan_well: invalid API" };
    const digits = apiNum.replace(/\D/g, "").slice(0, 10);
    const html   = await fetchHtml(`${EWA_BASE}/orphanWellQueryAction.do`, {
      method: "POST",
      body: formBody({
        "searchArgs.apiNoPrefixArg": split.prefix,
        "searchArgs.apiNoSuffixArg": split.suffix,
        "methodToCall":              "search",
      }),
    });
    const rows      = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|Orphan|Operator|District|Lease|County/i));
    const dataRows  = hIdx >= 0 ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r)) : [];
    const isOrphan  = dataRows.some(r => /^\d{2,}/.test((r[0] ?? "").trim()));

    return {
      ok:   true,
      data: {
        api_number:     digits,
        is_orphan:      isOrphan,
        count:          dataRows.length,
        records:        dataRows.slice(0, 6),
        interpretation: isOrphan
          ? "Well flagged as orphan — operator insolvent or bond forfeited. State plugging liability."
          : "Well NOT on TRRC orphan list.",
      },
      summary: `fetch_orphan_well: ${digits} — ${isOrphan ? `ORPHAN (${dataRows.length} record(s))` : "not on orphan list"}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_orphan_well: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchSeveranceRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo   = input.lease_number    ? String(input.lease_number).trim()    : (ctx.lease_number ?? null);
  const leaseType = input.lease_type      ? String(input.lease_type).trim()      : "O";
  const dist      = input.district        ? String(input.district).trim()        : (ctx.district ?? null);
  const opNo      = input.operator_number ? String(input.operator_number).trim() : (ctx.operator_number ?? null);
  const apiRaw    = input.api_number      ? String(input.api_number).trim()      : ctx.api_numbers[0] ?? null;

  const querySeverance = async (params: Record<string, string>): Promise<{ label: string; records: Record<string, string>[]; url: string } | null> => {
    try {
      const html      = await fetchHtml(`${EWA_BASE}/severanceQueryAction.do`, { method: "POST", body: formBody(params) });
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|District|Lease|Operator|Severance|County/i));
      if (hIdx < 0) return null;
      const header   = cleanRows[hIdx] ?? [];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r));
      if (dataRows.length === 0) return null;
      const records  = dataRows.map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
        return obj;
      }).slice(0, 20);
      const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return { label: JSON.stringify(params), records, url: `https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do?${qs}` };
    } catch {
      return null;
    }
  };

  let result: { label: string; records: Record<string, string>[]; url: string } | null = null;

  // Try lease+district first
  if (leaseNo && dist) {
    result = await querySeverance({
      "methodToCall":                  "search",
      "searchArgs.leaseNumberArg":     leaseNo,
      "searchArgs.districtCodeArg":    dist,
      "searchArgs.leaseTypeArg":       leaseType.toUpperCase() === "G" ? "G" : "O",
    });
  }

  // If no result, try by API prefix/suffix (some TRRC endpoints support this)
  if (!result && apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      result = await querySeverance({
        "methodToCall":                  "search",
        "searchArgs.apiNoPrefixArg":     split.prefix,
        "searchArgs.apiNoSuffixArg":     split.suffix,
      });
    }
  }

  // Fall back to operator number
  if (!result && opNo) {
    result = await querySeverance({
      "methodToCall":                  "search",
      "searchArgs.operatorNumbersArg": opNo,
    });
  }

  // If lease+dist with oil returned nothing, try gas lease type
  if (!result && leaseNo && dist) {
    result = await querySeverance({
      "methodToCall":                  "search",
      "searchArgs.leaseNumberArg":     leaseNo,
      "searchArgs.districtCodeArg":    dist,
      "searchArgs.leaseTypeArg":       "G",
    });
  }

  if (!result) {
    return {
      ok: false,
      data: { error: "No severance records found. Provide (lease_number + district), api_number, or operator_number." },
      summary: "fetch_severance_records: no results from any query angle",
    };
  }

  // Enrich ctx from found records — critical rescue path when wellbore PDQ (search_by_api) fails.
  // Severance is the most aggressive fallback: it indexes by API regardless of PDQ status,
  // and its records carry lease, district, and operator — exactly what production needs.
  const firstRec = result.records[0];
  if (firstRec) {
    const sevLease = (firstRec["lease_no_"] ?? firstRec["lease_no"] ?? firstRec["lease_number"] ?? firstRec["lease"] ?? "").trim();
    const sevDist  = (firstRec["dist_code"] ?? firstRec["district"] ?? firstRec["district_code"] ?? "").trim();
    const sevOpNo  = (firstRec["operator_no_"] ?? firstRec["operator_no"] ?? firstRec["operator_number"] ?? "").trim();
    const sevOpNm  = (firstRec["operator_name"] ?? firstRec["operator"] ?? "").trim();
    if (!ctx.lease_number    && sevLease && /^\d+$/.test(sevLease))    ctx.lease_number    = sevLease;
    if (!ctx.district        && sevDist)                               ctx.district        = sevDist;
    if (!ctx.operator_number && sevOpNo && /^\d{5,}$/.test(sevOpNo)) ctx.operator_number = sevOpNo;
    if (!ctx.operator_name   && sevOpNm)                               ctx.operator_name   = sevOpNm;
  }

  return {
    ok:   true,
    data: { count: result.records.length, records: result.records, trrc_source_url: result.url },
    summary: `fetch_severance_records: ${result.records.length} record(s)`,
  };
}

async function toolFetchComplianceViolations(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;

  if (!apiRaw && !leaseNo) {
    return {
      ok: true,
      data: { found: false, violations: [], note: "No API or lease provided for ICE compliance search." },
      summary: "fetch_compliance_violations: no identifier — skipped",
    };
  }

  const trrcUrl = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";

  try {
    // Step 1 — GET ICE page to establish JSESSIONID and extract live JSF component IDs
    const initResp = await callProxy(ICE_URL, "GET");
    const jsessionId = extractSetCookieValue(initResp.set_cookie, "JSESSIONID");
    const viewState1 = extractViewState(initResp.html);

    if (!jsessionId || !viewState1) {
      throw new Error("Could not establish ICE session (no JSESSIONID or ViewState)");
    }

    const { tabViewId, violBtnId } = extractIceIds(initResp.html);
    const cookieStr = `JSESSIONID=${jsessionId}`;

    // Step 2 — Activate violations tab (index 1 — lazy-loaded, must be activated before searching)
    const tab2Body = new URLSearchParams();
    tab2Body.append("javax.faces.partial.ajax",    "true");
    tab2Body.append("javax.faces.source",          `IceQueryForm:${tabViewId}`);
    tab2Body.append("javax.faces.partial.execute", `IceQueryForm:${tabViewId}`);
    tab2Body.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}`);
    tab2Body.append("javax.faces.behavior.event",  "tabChange");
    tab2Body.append("javax.faces.partial.event",   "tabChange");
    tab2Body.append(`IceQueryForm:${tabViewId}_activeIndex`, "1");
    tab2Body.append("IceQueryForm", "IceQueryForm");
    tab2Body.append("javax.faces.ViewState", viewState1);

    const tab2Resp  = await callProxy(ICE_URL, "POST", tab2Body.toString(), cookieStr, {
      "Faces-Request":    "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
    });
    const viewState2 = extractViewState(tab2Resp.html) ?? viewState1;

    // Step 3 — Search violations.
    // Try by API first, then by lease only if API returns nothing.
    const apiMask = apiRaw ? toApiMask(apiRaw) : "";

    const buildSearchBody = (useApi: boolean): string => {
      const b = new URLSearchParams();
      b.append("javax.faces.partial.ajax",    "true");
      b.append("javax.faces.source",          `IceQueryForm:${tabViewId}:${violBtnId}`);
      b.append("javax.faces.partial.execute", "IceQueryForm");
      b.append("javax.faces.partial.render",  `IceQueryForm:${tabViewId}:violResults`);
      b.append(`IceQueryForm:${tabViewId}:${violBtnId}`, `IceQueryForm:${tabViewId}:${violBtnId}`);
      b.append("IceQueryForm", "IceQueryForm");
      b.append(`IceQueryForm:${tabViewId}:qvapino`,       useApi ? apiMask : "");
      b.append(`IceQueryForm:${tabViewId}:qvopnm`,        "");
      b.append(`IceQueryForm:${tabViewId}:qvopno`,        "");
      b.append(`IceQueryForm:${tabViewId}:qvcnty_input`,  "");
      b.append(`IceQueryForm:${tabViewId}:qvcnty_focus`,  "");
      b.append(`IceQueryForm:${tabViewId}:qvdis_input`,   "");
      b.append(`IceQueryForm:${tabViewId}:qvdis_focus`,   "");
      b.append(`IceQueryForm:${tabViewId}:qvlsnm`,        "");
      b.append(`IceQueryForm:${tabViewId}:qvlsno`,        (!useApi && leaseNo) ? leaseNo.slice(0, 6) : "");
      b.append(`IceQueryForm:${tabViewId}:qvdpno`,        "");
      b.append(`IceQueryForm:${tabViewId}:qvindtf_input`, "");
      b.append(`IceQueryForm:${tabViewId}:qvindtt_input`, "");
      b.append(`IceQueryForm:${tabViewId}:qviRle_focus`,  "");
      b.append(`IceQueryForm:${tabViewId}:qviRle_input`,  "");
      b.append(`IceQueryForm:${tabViewId}_activeIndex`,   "1");
      b.append("javax.faces.ViewState", viewState2);
      return b.toString();
    };

    const ajaxHeaders = {
      "Faces-Request":    "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
    };

    // Try by API
    let violations: Record<string, string>[] = [];
    let searchMethod = "api";
    if (apiMask) {
      const searchResp = await callProxy(ICE_URL, "POST", buildSearchBody(true), cookieStr, ajaxHeaders);
      const violHtml   = extractPartialUpdate(searchResp.html, `IceQueryForm:${tabViewId}:violResults`) ?? searchResp.html;
      violations = parseViolResultsHtml(violHtml);
    }

    // If no results by API, try by lease number
    if (violations.length === 0 && leaseNo) {
      searchMethod = "lease";
      const searchResp = await callProxy(ICE_URL, "POST", buildSearchBody(false), cookieStr, ajaxHeaders);
      const violHtml   = extractPartialUpdate(searchResp.html, `IceQueryForm:${tabViewId}:violResults`) ?? searchResp.html;
      violations = parseViolResultsHtml(violHtml);
    }

    const openCount   = violations.filter(v => !/y|yes|compliant/i.test(v["compliant"] ?? "")).length;
    const closedCount = violations.length - openCount;

    return {
      ok:   true,
      data: {
        found:            violations.length > 0,
        search_method:    searchMethod,
        violation_count:  violations.length,
        open_count:       openCount,
        closed_count:     closedCount,
        violations:       violations.slice(0, 50),
        note:             violations.length === 0
          ? "No violations found (2015-08-01 onward). Pre-2015 records require TRRC district violation files."
          : `${violations.length} violation(s) found via TRRC ICE portal.`,
        trrc_source_url:  trrcUrl,
      },
      summary: `fetch_compliance_violations: ${violations.length} violation(s) found (${openCount} open, ${closedCount} closed) via ICE portal`,
    };

  } catch (e) {
    return {
      ok:   true,
      data: {
        found:           false,
        error:           String(e).slice(0, 200),
        note:            "ICE portal compliance query failed. Visit https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml directly.",
        data_gap:        true,
        trrc_source_url: trrcUrl,
      },
      summary: `fetch_compliance_violations: ICE session failed — ${String(e).slice(0, 80)}`,
    };
  }
}

async function toolFetchProration(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw    = input.api_number   ? String(input.api_number).trim()   : (ctx.api_numbers[0] ?? null);
  const leaseNo   = input.lease_number ? String(input.lease_number).trim() : (ctx.lease_number ?? null);
  const leaseType = (input.lease_type as string | undefined) ?? "oil";
  const distCode  = input.district     ? String(input.district).trim()     : (ctx.district ?? "");

  const parseTable = (html: string, kwRe: RegExp, minCols = 3) => {
    if (/Please\s+[Cc]orrect/i.test(html) || /errors?\s+list/i.test(html)) return null;
    const rows      = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, minCols, kwRe));
    if (hIdx < 0 || cleanRows.length <= hIdx + 1) return null;
    const header   = cleanRows[hIdx] ?? [];
    const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= minCols && !isNoiseRow(r)).map(row => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
      return obj;
    });
    return dataRows.length > 0 ? dataRows : null;
  };

  try {
    const allRecords: Record<string, string>[] = [];
    const proKw = /API|District|Lease|Operator|Potential|Allowable|Daily|Schedule/i;

    for (const [ep, lt] of [[`${EWA_BASE}/oilProQueryAction.do`, "OIL"], [`${EWA_BASE}/gasProQueryAction.do`, "GAS"]] as [string,string][]) {
      // Try by API
      if (apiRaw) {
        const split = splitApi(apiRaw);
        if (split) {
          try {
            const params: Record<string, string> = { "methodToCall": "search", "searchArgs.apiPrefixArg": split.prefix, "searchArgs.apiSuffixArg": split.suffix };
            if (distCode) params["searchArgs.districtCodeArg"] = distCode;
            const html    = await fetchHtml(ep, { method: "POST", body: formBody(params) });
            const records = parseTable(html, proKw);
            if (records) allRecords.push(...records.map(r => ({ ...r, _lease_type: lt, _query: "by_api" })));
          } catch { /* continue */ }
        }
      }
      // Try by lease+district
      if (leaseNo && distCode && allRecords.filter(r => r["_query"] !== "by_api").length === 0) {
        try {
          const params: Record<string, string> = {
            "methodToCall":               "search",
            "searchArgs.leaseNumberArg":  leaseNo,
            "searchArgs.districtCodeArg": distCode,
            "searchArgs.leaseTypeArg":    lt === "GAS" ? "G" : "O",
          };
          const html    = await fetchHtml(ep, { method: "POST", body: formBody(params) });
          const records = parseTable(html, proKw);
          if (records) allRecords.push(...records.map(r => ({ ...r, _lease_type: lt, _query: "by_lease" })));
        } catch { /* continue */ }
      }
    }

    const firstPro = allRecords[0] ?? {};
    return {
      ok:   true,
      data: {
        count:           allRecords.length,
        records:         allRecords.slice(0, 20),
        potential:       firstPro["potential_bbl_"] ?? firstPro["potential"] ?? null,
        daily_allowable: firstPro["daily_allowable"] ?? firstPro["allowable"] ?? null,
        note:            "Proration ALLOWABLE schedule (not monthly production history).",
        trrc_source_url: apiRaw
          ? `https://webapps2.rrc.texas.gov/EWA/oilProQueryAction.do?searchArgs.apiPrefixArg=${splitApi(apiRaw)?.prefix}&searchArgs.apiSuffixArg=${splitApi(apiRaw)?.suffix}&methodToCall=search`
          : `https://webapps2.rrc.texas.gov/EWA/oilProQueryAction.do`,
      },
      summary: `fetch_proration: ${allRecords.length} proration record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_proration: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchInjectionRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : (ctx.api_numbers[0] ?? null);
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    let label: string;
    if (apiNum) {
      const split = splitApi(apiNum);
      if (!split) return { ok: false, data: { error: "Invalid API number format" }, summary: "fetch_injection_records: invalid API" };
      params["searchArgs.apiNoPrefixArg"] = split.prefix;
      params["searchArgs.apiNoSuffixArg"] = split.suffix;
      label = apiNum;
    } else if (opNo) {
      params["searchArgs.operatorNumbersArg"] = opNo;
      label = `Operator ${opNo}`;
    } else {
      return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_injection_records: missing input" };
    }

    const html      = await fetchHtml(`${EWA_BASE}/uicQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows      = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const uicKw     = /UIC|API|Lease|Operator|County|District|Permit|Well\s+No/i;
    const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 2, uicKw));
    const header    = hIdx >= 0 ? cleanRows[hIdx] : null;
    const dataRows  = hIdx >= 0
      ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/^Links\s+Images/i.test(r.join(" ")))
      : [];

    const mergedRows: Array<Record<string, string>> = [];
    if (header) {
      for (const row of dataRows) {
        const cell0 = (row[0] ?? "").trim();
        const isLeaseContinuation = /^\d{1,6}$/.test(cell0) && mergedRows.length > 0 && !mergedRows[mergedRows.length - 1]["lease_no"];
        if (isLeaseContinuation) {
          mergedRows[mergedRows.length - 1]["lease_no"] = cell0;
        } else {
          const obj: Record<string, string> = {};
          header.forEach((h, i) => {
            const key = h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
            const val = (row[i] ?? "").replace(/\bLinks\b.*$/i, "").replace(/\bGIS\b.*$/i, "").trim();
            if (key) obj[key] = val;
          });
          if (Object.values(obj).some(v => /\d/.test(v))) mergedRows.push(obj);
        }
      }
    }
    const records = mergedRows.slice(0, 11);

    if (records.length > 0) {
      const firstRec = records[0];
      const uicLease = firstRec["lease_no"] ?? firstRec["lease_no_"] ?? firstRec["lease"] ?? "";
      if (!ctx.lease_number && uicLease && /^\d+$/.test(uicLease.trim())) ctx.lease_number = uicLease.trim();
      if (!ctx.county && firstRec["county"]) ctx.county = firstRec["county"];
    }

    const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return {
      ok:   true,
      data: { identifier: label, count: records.length, records, trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/uicQueryAction.do?${qs}` },
      summary: `fetch_injection_records: ${label} — ${records.length} UIC injection record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_injection_records: failed — ${String(e).slice(0, 80)}` };
  }
}

function toolFetchPluggingRecords(_input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  return {
    ok:   true,
    data: {
      api_number:         ctx.api_numbers[0] ?? null,
      endpoint_available: false,
      message:            "TRRC EWA pluggingQueryAction.do is not publicly accessible (HTTP 500). Plugging status is inferred from the wellbore query (well_type AB = Abandoned, PP = Partial Plug) and the IWAR. For W-3C plugging records, visit https://www.rrc.texas.gov directly.",
      data_gap:           true,
      trrc_source_url:    "https://www.rrc.texas.gov/oil-and-gas/applications-and-permits/drilling-permits/plugging-records/",
    },
    summary: "fetch_plugging_records: endpoint not accessible — infer from wellbore well_type and IWAR",
  };
}

function toolFetchP4Records(_input: Record<string, unknown>, _ctx: AgentContext): ToolResult {
  return {
    ok:   true,
    data: {
      endpoint_available: false,
      message:            "TRRC EWA p4QueryAction.do is not publicly accessible (HTTP 500). P-4 tested rate and allowable data is reflected in the proration schedule (fetch_proration).",
      data_gap:           true,
      trrc_source_url:    "https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/",
    },
    summary: "fetch_p4_records: endpoint not accessible — use proration data as proxy",
  };
}

function toolFetchImagedRecords(_input: Record<string, unknown>, _ctx: AgentContext): ToolResult {
  return {
    ok:   true,
    data: {
      endpoint_available: false,
      message:            "TRRC CMPL imaged document system (publicCmplQueryAction.do) returns HTTP 404. Scanned W-2, G-1, and P-12 records require direct browser access at https://www.rrc.texas.gov/resource-center/research/online-research-queries/",
      data_gap:           true,
      trrc_source_url:    "https://www.rrc.texas.gov/resource-center/research/online-research-queries/",
    },
    summary: "fetch_imaged_records: CMPL endpoint not accessible — manual document retrieval required",
  };
}

function toolSearchByLegalDescription(_input: Record<string, unknown>, _ctx: AgentContext): ToolResult {
  return {
    ok:   true,
    data: {
      found:           false,
      message:         "TRRC EWA does not provide a stateless GIS/legal description API. Use the TRRC GIS viewer at https://gis.rrc.texas.gov/ directly.",
      data_gap:        true,
      trrc_source_url: "https://gis.rrc.texas.gov/",
    },
    summary: "search_by_legal_description: no stateless endpoint — manual GIS lookup required",
  };
}

// ─── Tool dispatcher ─────────────────────────────────────────────────────────

async function dispatchTool(name: string, toolInput: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  switch (name) {
    case "search_by_api":              return toolSearchByApi(toolInput, ctx);
    case "search_by_lease":            return toolSearchByLease(toolInput, ctx);
    case "search_by_operator":         return toolSearchByOperator(toolInput, ctx);
    case "search_by_legal_description":return toolSearchByLegalDescription(toolInput, ctx);
    case "fetch_production":           return toolFetchProduction(toolInput, ctx);
    case "fetch_completion_records":   return toolFetchCompletionRecords(toolInput, ctx);
    case "fetch_well_status":          return toolFetchWellStatus(toolInput, ctx);
    case "fetch_inactive_well_status": return toolFetchInactiveWellStatus(toolInput, ctx);
    case "fetch_orphan_well":          return toolFetchOrphanWell(toolInput, ctx);
    case "fetch_plugging_records":     return toolFetchPluggingRecords(toolInput, ctx);
    case "fetch_compliance_violations":return toolFetchComplianceViolations(toolInput, ctx);
    case "fetch_p4_records":           return toolFetchP4Records(toolInput, ctx);
    case "fetch_proration":            return toolFetchProration(toolInput, ctx);
    case "fetch_injection_records":    return toolFetchInjectionRecords(toolInput, ctx);
    case "fetch_severance_records":    return toolFetchSeveranceRecords(toolInput, ctx);
    case "fetch_imaged_records":       return toolFetchImagedRecords(toolInput, ctx);
    default:
      return { ok: false, data: { error: `Unknown tool: ${name}` }, summary: `Unknown tool: ${name}` };
  }
}

// ─── Coverage builder ─────────────────────────────────────────────────────────

interface CoverageEntry {
  category: string;
  label:    string;
  status:   "complete" | "partial" | "retrieval_failed" | "manual_required" | "no_applicable_record" | "not_checked";
  records_found:       number;
  data_current_through: string | null;
  sources_checked:     string[];
  notes:               string | null;
}

const TOOL_COVERAGE_MAP: Record<string, { category: string; label: string }> = {
  search_by_api:              { category: "wellbore_identity", label: "Well Identity (API Lookup)" },
  search_by_lease:            { category: "lease_inventory",   label: "Lease Inventory" },
  search_by_operator:         { category: "operator_p5",       label: "Operator / P5 Organization" },
  search_by_legal_description:{ category: "legal_description", label: "Legal Description (GIS)" },
  fetch_production:           { category: "production",        label: "Production Data" },
  fetch_completion_records:   { category: "completion",        label: "Completion Records (W-2)" },
  fetch_well_status:          { category: "well_status",       label: "Well Status" },
  fetch_inactive_well_status: { category: "inactive_well",     label: "Inactive Well Aging Report (IWAR)" },
  fetch_orphan_well:          { category: "orphan_well",       label: "Orphan Well Check" },
  fetch_plugging_records:     { category: "plugging",          label: "Plugging Records (W-3C)" },
  fetch_compliance_violations:{ category: "compliance",        label: "Compliance Violations (ICE)" },
  fetch_p4_records:           { category: "p4_records",        label: "P-4 Production Test Records" },
  fetch_proration:            { category: "proration",         label: "Proration / Daily Allowable" },
  fetch_injection_records:    { category: "injection",         label: "UIC / Injection Well Records" },
  fetch_severance_records:    { category: "severance",         label: "Wellbore Severance Records" },
  fetch_imaged_records:       { category: "imaged_records",    label: "Imaged Document Packets (CMPL)" },
};

function buildCoverageFromAttempts(
  attempts: Array<{ source_name: string; status: string; result_count: number; result_data_json: unknown }>,
): CoverageEntry[] {
  return Object.entries(TOOL_COVERAGE_MAP).map(([toolName, { category, label }]) => {
    const attempt = attempts.findLast(a => a.source_name === toolName);
    if (!attempt) return { category, label, status: "not_checked", records_found: 0, data_current_through: null, sources_checked: [], notes: null };

    const data      = attempt.result_data_json as Record<string, unknown> ?? {};
    const found     = data["found"] === true;
    const dataGap   = data["data_gap"] === true;
    const isSuccess = attempt.status === "success";
    const count     = attempt.result_count ?? 0;

    let status: CoverageEntry["status"];
    if (dataGap)           status = "manual_required";
    else if (!isSuccess)   status = "retrieval_failed";
    else if (!found && count === 0) status = "no_applicable_record";
    else if (count > 0 || found)   status = "complete";
    else                           status = "partial";

    return {
      category,
      label,
      status,
      records_found:        count,
      data_current_through: new Date().toISOString().slice(0, 10),
      sources_checked:      [toolName],
      notes:                typeof data["note"] === "string" ? data["note"] : typeof data["error"] === "string" ? data["error"] : null,
    };
  });
}

// ─── Main retrieval orchestrator ──────────────────────────────────────────────

async function runRetrieval(runId: string): Promise<void> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 1. Load run record
  const { data: runRaw, error: runErr } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (runErr || !runRaw) {
    console.error(`[trrc-dd-execute] run not found: ${runId}`, runErr);
    return;
  }

  await supabase.from("trrc_due_diligence_runs")
    .update({ status: "running", progress_percent: 2, updated_at: new Date().toISOString() })
    .eq("id", runId);

  // 2. Build context — seed from all user-provided identifiers
  const ctx: AgentContext = {
    api_numbers:     [],
    district:        null,
    lease_number:    null,
    operator_name:   null,
    operator_number: null,
    county:          null,
    production:      [],
    agentReport:     null,
  };

  const userApi      = String(runRaw["resolved_primary_api"] ?? "").replace(/\D/g, "").slice(0, 10);
  const userLease    = String(runRaw["resolved_lease_number"] ?? "").trim();
  const userDistrict = String(runRaw["resolved_district"]     ?? "").trim();
  const userOpName   = String(runRaw["operator_name"]            ?? "").trim();
  const userOpNo     = String(runRaw["resolved_operator_number"] ?? "").trim();

  if (userApi.length >= 10) ctx.api_numbers.push(userApi);
  if (userLease)    ctx.lease_number    = userLease;
  if (userDistrict) ctx.district        = userDistrict;
  if (userOpName)   ctx.operator_name   = userOpName;
  if (userOpNo)     ctx.operator_number = userOpNo;

  // Also pull from resolved entities table (populated by the frontend resolver)
  const { data: entityRows } = await supabase
    .from("trrc_resolved_entities")
    .select("*")
    .eq("run_id", runId);

  for (const e of (entityRows ?? [])) {
    if (e["entity_type"] === "wellbore") {
      const api = String(e["canonical_identifier"] ?? "").replace(/\D/g, "").slice(0, 10);
      if (api.length === 10 && !ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
      if (!ctx.district     && e["attributes_json"]?.["district"])    ctx.district     = String(e["attributes_json"]["district"]);
    } else if (e["entity_type"] === "lease") {
      if (!ctx.lease_number && e["attributes_json"]?.["lease_number"]) ctx.lease_number = String(e["attributes_json"]["lease_number"]);
      if (!ctx.district     && e["attributes_json"]?.["district"])     ctx.district     = String(e["attributes_json"]["district"]);
    } else if (e["entity_type"] === "operator") {
      if (!ctx.operator_name   && e["attributes_json"]?.["normalized_name"])  ctx.operator_name   = String(e["attributes_json"]["normalized_name"]);
      if (!ctx.operator_number && e["attributes_json"]?.["operator_number"]) ctx.operator_number = String(e["attributes_json"]["operator_number"]);
    }
  }

  const allAttempts: Array<{ source_name: string; status: string; result_count: number; result_data_json: unknown }> = [];
  let stepIndex = 0;
  const totalSteps = 20; // Phase 3 may add up to 2 rescue runs (search_by_lease + search_by_operator)

  const run = async (name: string, inputFn: () => Record<string, unknown>): Promise<ToolResult> => {
    const result  = await dispatchTool(name, inputFn(), ctx);
    const data    = result.data as Record<string, unknown>;
    const count   = Array.isArray(data?.["wellbores"])  ? (data["wellbores"] as unknown[]).length
                  : Array.isArray(data?.["records"])    ? (data["records"]   as unknown[]).length
                  : Array.isArray(data?.["wells"])      ? (data["wells"]     as unknown[]).length
                  : Array.isArray(data?.["violations"]) ? (data["violations"]as unknown[]).length
                  : Array.isArray(data?.["results"])    ? (data["results"]   as unknown[]).length
                  : data?.["found"] === true ? 1 : 0;

    console.log(`[trrc-dd-execute] [${runId}] ${name}: ${result.summary}`);

    await supabase.from("trrc_source_attempts").upsert({
      run_id:          runId,
      source_id:       `${name}_1`,
      source_name:     name,
      status:          result.ok ? "success" : "failed_transient",
      result_count:    count,
      error_message:   result.ok ? null : String(data?.["error"] ?? ""),
      attempted_at:    new Date().toISOString(),
      result_data_json: result.data,
    }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).then(null, () => {});

    allAttempts.push({ source_name: name, status: result.ok ? "success" : "failed_transient", result_count: count, result_data_json: result.data });

    stepIndex++;
    const progress = Math.min(92, 5 + Math.round(stepIndex / totalSteps * 87));
    await supabase.from("trrc_due_diligence_runs")
      .update({ progress_percent: progress, updated_at: new Date().toISOString() })
      .eq("id", runId);

    return result;
  };

  try {
    // ══════════════════════════════════════════════════════════════
    // PHASE 1 — ENTITY RESOLUTION
    // Use ALL three user inputs simultaneously to build the richest
    // possible context before pulling substantive data.
    // ══════════════════════════════════════════════════════════════

    // 1a. Search by API — wellbore PDQ (fastest path to lease+district)
    if (ctx.api_numbers.length > 0) {
      await run("search_by_api", () => ({ api_number: ctx.api_numbers[0] }));
    }

    // 1b. Search by lease — scan ALL districts (even if API lookup succeeded,
    //     this confirms the lease inventory and can reveal additional wellbores)
    if (ctx.lease_number) {
      await run("search_by_lease", () => ({ lease_number: ctx.lease_number!, district: ctx.district ?? "" }));
    }

    // 1c. Search by operator — resolves operator number, TNR flags, org status
    if (ctx.operator_name || ctx.operator_number) {
      await run("search_by_operator", () => ({ operator_name: ctx.operator_name, operator_number: ctx.operator_number }));
    }

    // 1d. Legal description (always a documented gap — no stateless endpoint)
    await run("search_by_legal_description", () => ({ county: ctx.county }));

    // ══════════════════════════════════════════════════════════════
    // PHASE 2 — EARLY DATA PASS
    // Run completion records and injection records NOW, before
    // production, because both may yield a lease number that can
    // unlock the production query.
    // ══════════════════════════════════════════════════════════════

    if (ctx.api_numbers.length > 0) {
      await run("fetch_completion_records", () => ({ api_numbers: ctx.api_numbers }));
    }

    if (ctx.api_numbers.length > 0 || ctx.operator_number) {
      await run("fetch_injection_records", () => ({ api_number: ctx.api_numbers[0] ?? null, operator_number: ctx.operator_number }));
    }

    // Severance records run EARLY — before production — because severance indexes by API
    // even when wellbore PDQ has no entry (new wells, recently spud, incomplete indexing).
    // When found, its records carry lease + district + operator, which are fed back into
    // ctx immediately so the Phase 3 enrichment and production query can use them.
    await run("fetch_severance_records", () => ({
      lease_number:    ctx.lease_number,
      district:        ctx.district,
      api_number:      ctx.api_numbers[0] ?? null,
      operator_number: ctx.operator_number,
    }));

    // ══════════════════════════════════════════════════════════════
    // PHASE 3 — CONTEXT ENRICHMENT
    // After the early data pass (completion + injection + severance),
    // check whether we now have identifiers we lacked after Phase 1.
    // If so, resolve the missing pieces before pulling production.
    // A well not found in wellbore PDQ can still yield full data
    // if severance hands us the lease number and operator.
    // ══════════════════════════════════════════════════════════════

    const leaseAfterEarlyPass = ctx.lease_number;
    const distAfterEarlyPass  = ctx.district;
    const opNoAfterEarlyPass  = ctx.operator_number;
    const opNmAfterEarlyPass  = ctx.operator_name;

    if (leaseAfterEarlyPass && !distAfterEarlyPass) {
      // We have a lease but no district — scan all districts to confirm
      await run("search_by_lease", () => ({ lease_number: leaseAfterEarlyPass, district: "" }));
    }

    // If severance gave us an operator name but we still have no operator number,
    // resolve it now — production REQUIRES operator_number for its 3-step EWA session.
    if (!opNoAfterEarlyPass && opNmAfterEarlyPass) {
      await run("search_by_operator", () => ({ operator_name: opNmAfterEarlyPass, operator_number: null }));
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE 4 — FULL DATA RETRIEVAL
    // Pull every TRRC record type with the best context we now have.
    // Each source tries multiple angles; none give up on first miss.
    // ══════════════════════════════════════════════════════════════

    // Production — tries ALL districts if primary fails
    await run("fetch_production", () => ({
      lease_number: ctx.lease_number,
      district:     ctx.district,
      api_number:   ctx.api_numbers[0] ?? null,
    }));

    // Well status — by API and by lease+district
    await run("fetch_well_status", () => ({
      api_number:   ctx.api_numbers[0] ?? null,
      lease_number: ctx.lease_number,
      district:     ctx.district,
    }));

    // Inactive well status — by API and by operator (both angles)
    await run("fetch_inactive_well_status", () => ({
      api_number:      ctx.api_numbers[0] ?? null,
      operator_number: ctx.operator_number,
    }));

    // Orphan well
    if (ctx.api_numbers.length > 0) {
      await run("fetch_orphan_well", () => ({ api_number: ctx.api_numbers[0] }));
    }

    // Plugging records (documented endpoint gap)
    await run("fetch_plugging_records", () => ({ api_number: ctx.api_numbers[0] ?? null, lease_number: ctx.lease_number }));

    // Compliance violations — REAL ICE portal query (3-step JSF session)
    await run("fetch_compliance_violations", () => ({
      api_number:   ctx.api_numbers[0] ?? null,
      lease_number: ctx.lease_number,
    }));

    // P-4 production test records (documented endpoint gap)
    await run("fetch_p4_records", () => ({}));

    // Proration / daily allowable — tries by API and by lease+district
    await run("fetch_proration", () => ({
      api_number:   ctx.api_numbers[0] ?? null,
      lease_number: ctx.lease_number,
      district:     ctx.district,
    }));

    // Imaged document packets (documented endpoint gap)
    await run("fetch_imaged_records", () => ({}));

  } catch (err) {
    console.error(`[trrc-dd-execute] [${runId}] retrieval error:`, err);
    await supabase.from("trrc_due_diligence_runs").update({
      status:        "failed",
      error_summary: err instanceof Error ? err.message : String(err),
      completed_at:  new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }).eq("id", runId);
    return;
  }

  // 5. Persist monthly production rows
  if (ctx.production.length > 0) {
    const seen    = new Set<string>();
    const prodRows = ctx.production
      .filter(raw => {
        const year  = Number(raw["year"]);
        const month = Number(raw["month"]);
        if (!year || !month) return false;
        const key = `${ctx.lease_number ?? ""}:${ctx.district ?? ""}:${year}-${String(month).padStart(2, "0")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(raw => ({
        run_id:             runId,
        entity_type:        "lease",
        api_number:         ctx.api_numbers[0] ?? null,
        district:           ctx.district ?? "",
        lease_number:       ctx.lease_number ?? null,
        gas_id:             null,
        operator_number:    ctx.operator_number ?? null,
        production_month:   `${Number(raw["year"])}-${String(Number(raw["month"])).padStart(2, "0")}`,
        oil_bbl:            typeof raw["oil_bbl"]        === "number" ? raw["oil_bbl"]        : null,
        gas_mcf:            typeof raw["gas_mcf"]        === "number" ? raw["gas_mcf"]        : null,
        casinghead_gas_mcf: typeof raw["casinghead_mcf"] === "number" ? raw["casinghead_mcf"] : null,
        condensate_bbl:     typeof raw["condensate_bbl"] === "number" ? raw["condensate_bbl"] : null,
        water_bbl:          typeof raw["water_bbl"]      === "number" ? raw["water_bbl"]      : null,
      }));

    if (prodRows.length > 0) {
      await supabase.from("trrc_production_monthly").upsert(prodRows, {
        onConflict:      "run_id,entity_type,api_number,lease_number,production_month",
        ignoreDuplicates: true,
      }).then(null, () => {});
    }
  }

  // 6. Build coverage and mark complete
  const coverageJson  = buildCoverageFromAttempts(allAttempts);
  const successCount  = allAttempts.filter(a => a.status === "success").length;

  const { error: updateErr } = await supabase.from("trrc_due_diligence_runs").update({
    status:                  "complete",
    progress_percent:        100,
    completed_at:            new Date().toISOString(),
    updated_at:              new Date().toISOString(),
    resolved_primary_api:    ctx.api_numbers[0] ?? null,
    resolved_district:       ctx.district,
    resolved_lease_number:   ctx.lease_number,
    resolved_operator_number: ctx.operator_number,
    coverage_json:           coverageJson,
    result_summary:          `${successCount} of ${allAttempts.length} sources retrieved. ${ctx.production.length} production months found.`,
  }).eq("id", runId);

  if (updateErr) {
    console.error("[trrc-dd-execute] final update error:", updateErr);
  } else {
    console.log(`[trrc-dd-execute] [${runId}] complete — ${successCount}/${allAttempts.length} sources, ${ctx.production.length} production months`);
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let runId: string;
  try {
    const body = await req.json() as Record<string, unknown>;
    runId = String(body["run_id"] ?? "").trim();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!runId) {
    return new Response(JSON.stringify({ error: "run_id is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const work = runRetrieval(runId);

  // @ts-ignore — Deno/Supabase EdgeRuntime global
  if (typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }

  return new Response(JSON.stringify({ ok: true, run_id: runId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
