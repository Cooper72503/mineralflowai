/**
 * Supabase Edge Function: trrc-dd-execute
 *
 * 16-source TRRC Due Diligence Research Protocol
 * S1  Wellbore Identity         — wellboreQueryAction.do
 * S2  Lease Well Inventory      — leaseWellQueryAction.do
 * S3  P-5 Operator              — organizationQueryAction.do / p5QueryAction.do
 * S4  Well Status               — wellStatusQueryAction.do
 * S5  Inactive Well (IWAR)      — inactiveWellQueryAction.do
 * S6  Orphan Well               — orphanWellQueryAction.do
 * S7  Severance Records         — severanceQueryAction.do
 * S8  Monthly Production        — productionQueryAction.do (3-step session)
 * S9  P-4 Production Tests      — p4QueryAction.do (session)
 * S10 Completion Records (W-2)  — completionQueryAction.do (session)
 * S11 Plugging Records (W-3C)   — pluggingQueryAction.do
 * S12 CODA Imaged Documents     — manual_required (Neubus Vue.js + reCAPTCHA)
 * S13 Compliance Violations     — webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml (JSF AJAX)
 * S14 UIC / Injection           — uicQueryAction.do
 * S15 Texas GLO Survey          — glo.texas.gov (manual_required — Drupal session-bound form)
 * S16 RRC GIS Plat              — gis.rrc.texas.gov/server/rest/services (ArcGIS REST API)
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
 */
function parseSpecificLeaseMonthly(html: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  const clean = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<select[^>]*>[\s\S]*?<\/select>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ");

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
 * Each field sourced from URL params and titled anchors due to nested table structure.
 */
function parseWellboreHtml(html: string): Array<Record<string, string>> {
  const apiLinks: Array<{ apiNo: string; distCode: string; leaseNo: string }> = [];
  const apiLinkRe = /href=["']leaseDetailAction\.do[^?"']*\?([^"']+)["'][^>]*title=["']Lease detail for API/gi;
  let m: RegExpExecArray | null;
  while ((m = apiLinkRe.exec(html)) !== null) {
    try {
      const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
      const distCode = params.get("distCode") ?? "";
      const leaseNo  = params.get("leaseNo")  ?? "";
      const apiNo    = params.get("apiNo")     ?? "";
      if (distCode && leaseNo) apiLinks.push({ apiNo, distCode, leaseNo });
    } catch { /* skip */ }
  }

  if (apiLinks.length === 0) {
    const fallbackRe = /href=["']leaseDetailAction\.do[^?"']*\?([^"']*searchType=apiNo[^"']*)["']/gi;
    while ((m = fallbackRe.exec(html)) !== null) {
      try {
        const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
        const distCode = params.get("distCode") ?? "";
        const leaseNo  = params.get("leaseNo")  ?? "";
        const apiNo    = params.get("apiNo")     ?? "";
        if (distCode && leaseNo) apiLinks.push({ apiNo, distCode, leaseNo });
      } catch { /* skip */ }
    }
  }

  if (apiLinks.length === 0) {
    const genericRe = /href=["']leaseDetailAction\.do[^?"']*\?([^"']+)["']/gi;
    const seen = new Set<string>();
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

  const operators: Array<{ name: string; no: string }> = [];
  const opRe = /<a[^>]*title=["']Operator\s*#\s*(\d+)[^"']*["'][^>]*>([^<]+)<\/a>/gi;
  while ((m = opRe.exec(html)) !== null) {
    operators.push({ no: m[1].trim(), name: m[2].trim() });
  }

  const counties: string[] = [];
  const countyRe = /<a[^>]*title=["']County\s*#[^"']*["'][^>]*>([^<]+)<\/a>/gi;
  while ((m = countyRe.exec(html)) !== null) {
    counties.push(m[1].trim());
  }

  return apiLinks.map((link, i) => ({
    api_no:        link.apiNo,
    dist_code:     link.distCode,
    lease_no:      link.leaseNo,
    operator_name: operators[i]?.name ?? "",
    operator_no:   operators[i]?.no   ?? "",
    county:        counties[i]        ?? "",
  }));
}

function extractSetCookieValue(setCookies: string[], name: string): string | null {
  for (const cookie of setCookies) {
    const m = cookie.match(new RegExp(`${name}=([^;,\\s]+)`, "i"));
    if (m) return m[1];
  }
  return null;
}

// ─── TRRC fetch helpers ───────────────────────────────────────────────────────

const EWA_BASE         = "https://webapps2.rrc.texas.gov/EWA";
const EWA_PROXY_URL    = `${Deno.env.get("APP_URL") ?? ""}/api/trrc/ewa-proxy`;
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

// S1 — Wellbore Identity
async function toolSearchByApi(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) return { ok: false, data: { error: "api_number required" }, summary: "search_by_api: no input" };

  const digits = apiRaw.replace(/\D/g, "");
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

    const wells = parseWellboreHtml(html);

    if (wells.length === 0) {
      const bodyText = extractText(html, 500);
      return {
        ok: true,
        data: {
          found:         false,
          api_number:    api10,
          input_warning: extraDigits ? `Input had ${digits.length} digits; only 10 used.` : null,
          message:       `API 42-${split.prefix}-${split.suffix} NOT FOUND in TRRC wellbore PDQ.`,
          body_text:     bodyText,
        },
        summary: `search_by_api: 42-${split.prefix}-${split.suffix} — NOT FOUND`,
      };
    }

    const first    = wells[0];
    const leaseNo  = first["lease_no"]      ?? "";
    const distCode = first["dist_code"]     ?? "";
    const operator = first["operator_name"] ?? "";
    const county   = first["county"]        ?? "";
    const operatorNo = first["operator_no"] ?? "";

    if (!ctx.api_numbers.includes(api10))       ctx.api_numbers.push(api10);
    if (distCode)                               ctx.district         = distCode;
    if (!ctx.lease_number     && leaseNo)       ctx.lease_number     = leaseNo;
    if (!ctx.operator_name    && operator)      ctx.operator_name    = operator;
    if (!ctx.operator_number  && operatorNo)    ctx.operator_number  = operatorNo;
    if (!ctx.county           && county)        ctx.county           = county;

    return {
      ok: true,
      data: {
        found:           true,
        api_number:      api10,
        formatted_api:   `42-${split.prefix}-${split.suffix}`,
        input_warning:   extraDigits ? `Input had ${digits.length} digits; only 10 used.` : null,
        lease_number:    leaseNo,
        district:        distCode,
        operator,
        operator_no:     operatorNo,
        county,
        total_wellbores: wells.length,
        wellbores:       wells.slice(0, 10),
        source:          "ewa-wellbore",
        trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`,
      },
      summary: `search_by_api: 42-${split.prefix}-${split.suffix} → Lease ${leaseNo} / District ${distCode} / ${wells.length} wellbore(s) / ${operator}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_api: failed — ${String(e).slice(0, 80)}` };
  }
}

// S2 — Lease Well Inventory (leaseWellQueryAction.do)
async function toolSearchByLease(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo  = String(input.lease_number ?? "").trim();
  const distHint = String(input.district ?? "").trim();
  if (!leaseNo) {
    return { ok: false, data: { error: "lease_number required" }, summary: "search_by_lease: missing lease_number" };
  }

  const tryLeaseWell = async (dist: string, leaseType: string): Promise<Array<Record<string,string>> | null> => {
    try {
      const html = await fetchHtml(`${EWA_BASE}/leaseWellQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.leaseNumberArg":  leaseNo,
          "searchArgs.districtCodeArg": dist,
          "searchArgs.leaseTypeArg":    leaseType,
          "methodToCall":               "search",
        }),
      });
      if (/No results found/i.test(html)) return null;
      // Try parseWellboreHtml first (handles nested table structure)
      let wells = parseWellboreHtml(html);
      if (wells.length > 0) return wells;
      // Fall back to extractTableRows for flat table structure
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|Lease|District|Operator|Well/i));
      if (hIdx < 0) return null;
      const header   = cleanRows[hIdx];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r));
      if (dataRows.length === 0) return null;
      wells = dataRows.map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => {
          obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? "";
        });
        return obj;
      });
      return wells.length > 0 ? wells : null;
    } catch {
      return null;
    }
  };

  const districtsToTry = distHint
    ? [distHint, ...ALL_DISTRICTS.filter(d => d !== distHint)]
    : ALL_DISTRICTS;

  for (const dist of districtsToTry) {
    for (const lt of ["O", "G"]) {
      const wells = await tryLeaseWell(dist, lt);
      if (wells && wells.length > 0) {
        const first    = wells[0];
        const distCode = first["dist_code"] || first["district"] || dist;
        const api      = first["api_no"] ?? first["api_number"] ?? "";
        const operator = first["operator_name"] ?? first["operator"] ?? "";
        const opNo     = first["operator_no"] ?? first["operator_no_"] ?? "";
        const county   = first["county"] ?? "";

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
            total_wells:  wells.length,
            wells:        wells.slice(0, 20),
            trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/leaseWellQueryAction.do?searchArgs.leaseNumberArg=${leaseNo}&searchArgs.districtCodeArg=${dist}&searchArgs.leaseTypeArg=${lt}&methodToCall=search`,
          },
          summary: `search_by_lease: Lease ${leaseNo} / District ${distCode} (${lt}) — ${wells.length} well(s)`,
        };
      }
    }
  }

  return {
    ok: true,
    data: { found: false, lease_number: leaseNo, error: `Lease ${leaseNo} not found in any TRRC district` },
    summary: `search_by_lease: Lease ${leaseNo} — NOT FOUND in any district`,
  };
}

// S3 — P-5 Operator
async function toolSearchByOperator(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const opName = input.operator_name   ? String(input.operator_name).trim()   : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  if (!opName && !opNo) {
    return { ok: false, data: { error: "operator_name or operator_number required" }, summary: "search_by_operator: no input" };
  }

  const tryOrgQuery = async (params: Record<string, string>): Promise<Record<string, string> | null> => {
    try {
      const html      = await fetchHtml(`${EWA_BASE}/organizationQueryAction.do`, { method: "POST", body: formBody(params) });
      if (/No results found/i.test(html)) return null;
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

  let rec: Record<string, string> | null = null;

  if (opNo) {
    rec = await tryOrgQuery({ "methodToCall": "search", "searchArgs.operatorNumbersArg": opNo });
  }

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
            note:            `Found ${wells.length} wellbore(s) for operator "${opName}" — number resolved from first result.`,
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

// S4 — Well Status (wellStatusQueryAction.do)
async function toolFetchWellStatus(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;
  const dist    = input.district     ? String(input.district).trim()     : ctx.district ?? null;

  const queryStatus = async (params: Record<string, string>): Promise<{ records: Record<string,string>[]; url: string } | null> => {
    try {
      const html = await fetchHtml(`${EWA_BASE}/wellStatusQueryAction.do`, {
        method: "POST",
        body: formBody({ ...params, "methodToCall": "search" }),
      });
      if (/No results found/i.test(html)) return null;
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|Lease|District|Status|Operator|Well/i));
      if (hIdx < 0) {
        // No header found — try to extract text for any status info
        const txt = extractText(html, 2000);
        if (/active|inactive|shut.in|plugged|abandoned/i.test(txt)) {
          return {
            records: [{ raw_text: txt.slice(0, 500) }],
            url: `https://webapps2.rrc.texas.gov/EWA/wellStatusQueryAction.do`,
          };
        }
        return null;
      }
      const header   = cleanRows[hIdx];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]));
      if (dataRows.length === 0) return null;
      const records = dataRows.slice(0, 20).map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
        return obj;
      });
      const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return { records, url: `https://webapps2.rrc.texas.gov/EWA/wellStatusQueryAction.do?${qs}&methodToCall=search` };
    } catch {
      return null;
    }
  };

  const results: Record<string, unknown>[] = [];
  let primaryStatus: string | null = null;

  // Try by API first
  if (apiNum) {
    const split = splitApi(apiNum);
    if (split) {
      const res = await queryStatus({
        "searchArgs.apiNoPrefixArg": split.prefix,
        "searchArgs.apiNoSuffixArg": split.suffix,
      });
      if (res) {
        const statusVal = res.records[0]?.["well_status"] ?? res.records[0]?.["status"] ?? res.records[0]?.["well_status_code"] ?? "";
        primaryStatus = statusVal || null;
        // Enrich context from well status result
        const rec = res.records[0] ?? {};
        if (!ctx.district     && rec["dist_code"])                                     ctx.district        = String(rec["dist_code"]);
        if (!ctx.district     && rec["district"])                                      ctx.district        = String(rec["district"]);
        if (!ctx.lease_number && rec["lease_no"])                                      ctx.lease_number    = String(rec["lease_no"]);
        if (!ctx.operator_number && rec["operator_no"] && /^\d{5,}$/.test(String(rec["operator_no"])))
                                                                                        ctx.operator_number = String(rec["operator_no"]);
        results.push({
          query:    "by_api",
          api:      `42-${split.prefix}-${split.suffix}`,
          count:    res.records.length,
          records:  res.records,
          trrc_source_url: res.url,
        });
      } else {
        results.push({ query: "by_api", api: `42-${split.prefix}-${split.suffix}`, found: false });
      }
    }
  }

  // Also try by lease+district for completeness
  if (leaseNo && dist && results.every(r => !r["count"])) {
    for (const lt of ["O", "G"]) {
      const res = await queryStatus({
        "searchArgs.leaseNumberArg":  leaseNo,
        "searchArgs.districtCodeArg": dist,
        "searchArgs.leaseTypeArg":    lt,
      });
      if (res) {
        if (!primaryStatus) {
          const statusVal = res.records[0]?.["well_status"] ?? res.records[0]?.["status"] ?? "";
          primaryStatus = statusVal || null;
        }
        results.push({
          query:    `by_lease_${lt}`,
          lease_no: leaseNo,
          district: dist,
          count:    res.records.length,
          records:  res.records,
          trrc_source_url: res.url,
        });
        break;
      }
    }
  }

  if (results.length === 0) {
    return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_well_status: missing input" };
  }

  const totalRecords = results.reduce((sum, r) => sum + (typeof r["count"] === "number" ? r["count"] : 0), 0);
  return {
    ok:   true,
    data: { primary_status: primaryStatus, results, source: "ewa-wellStatusQueryAction" },
    summary: `fetch_well_status: ${primaryStatus ?? "status unknown"} — ${totalRecords} record(s) from wellStatusQueryAction.do`,
  };
}

// S5 — Inactive Well (IWAR)
async function toolFetchInactiveWellStatus(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw = input.api_number      ? String(input.api_number).trim()      : ctx.api_numbers[0] ?? null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : ctx.operator_number ?? null;

  const results: Record<string, unknown>[] = [];

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
        const noResults  = /No results found/i.test(html);
        const rows      = extractTableRows(html);
        const cleanRows = rows.filter(r => !isNoiseRow(r));
        const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 4, /API|Inactive|Lease|Operator|Aging/i));
        const dataRows  = (!noResults && hIdx >= 0)
          ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]))
          : [];
        const isInactive = dataRows.length > 0;
        results.push({
          query:            "by_api",
          api_number:       `42-${split.prefix}-${split.suffix}`,
          is_inactive:      isInactive,
          inactive_records: dataRows.length,
          records:          dataRows.slice(0, 5),
          interpretation:   isInactive
            ? "Well appears on TRRC IWAR. Plugging liability risk present."
            : "Well NOT on inactive list — no plugging liability flagged.",
          trrc_source_url:  `https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&methodToCall=search`,
        });
      } catch (e) {
        results.push({ query: "by_api", error: String(e).slice(0, 80) });
      }
    }
  }

  if (opNo) {
    try {
      const html      = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.operatorNumbersArg": opNo,
          "methodToCall":                  "search",
        }),
      });
      const noResultsOp = /No results found/i.test(html);
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 4, /API|Lease|Operator|Aging/i));
      const dataRows  = (!noResultsOp && hIdx >= 0)
        ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]))
        : [];
      results.push({
        query:               "by_operator",
        operator_number:     opNo,
        inactive_well_count: dataRows.length,
        wells:               dataRows.slice(0, 20),
        trrc_source_url:     `https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do?searchArgs.operatorNumbersArg=${opNo}&methodToCall=search`,
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

// S6 — Orphan Well
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
    if (/No results found/i.test(html)) {
      return {
        ok:   true,
        data: { api_number: digits, is_orphan: false, count: 0, records: [], interpretation: "Well NOT on TRRC orphan list." },
        summary: `fetch_orphan_well: ${digits} — not on orphan list`,
      };
    }
    const rows      = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 4, /API|Orphan|Operator|District|Lease|County/i));
    const dataRows  = hIdx >= 0 ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0])) : [];
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

// S7 — Severance Records
async function toolFetchSeveranceRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo   = input.lease_number    ? String(input.lease_number).trim()    : (ctx.lease_number ?? null);
  const dist      = input.district        ? String(input.district).trim()        : (ctx.district ?? null);
  const opNo      = input.operator_number ? String(input.operator_number).trim() : (ctx.operator_number ?? null);
  const apiRaw    = input.api_number      ? String(input.api_number).trim()      : ctx.api_numbers[0] ?? null;

  const querySeverance = async (params: Record<string, string>): Promise<{ records: Record<string,string>[]; url: string } | null> => {
    try {
      const html      = await fetchHtml(`${EWA_BASE}/severanceQueryAction.do`, { method: "POST", body: formBody(params) });
      if (/No results found/i.test(html)) return null;
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 4, /\bAPI\b|\bCounty\b|\bLease\b|\bOperator\b|\bDistrict\b/i));
      if (hIdx < 0) return null;
      const header   = cleanRows[hIdx] ?? [];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]));
      if (dataRows.length === 0) return null;
      const records  = dataRows.map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => {
          const key = h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
          const val = (row[i] ?? "").replace(/\bLinks\b.*$/i, "").replace(/\bGIS\b.*$/i, "").trim();
          if (key) obj[key] = val;
        });
        return obj;
      }).slice(0, 20);
      const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return { records, url: `https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do?${qs}` };
    } catch {
      return null;
    }
  };

  let result: { records: Record<string,string>[]; url: string } | null = null;

  if (leaseNo && dist) {
    result = await querySeverance({ "methodToCall": "search", "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": dist, "searchArgs.leaseTypeArg": "O" });
  }
  if (!result && apiRaw) {
    const split = splitApi(apiRaw);
    if (split) result = await querySeverance({ "methodToCall": "search", "searchArgs.apiNoPrefixArg": split.prefix, "searchArgs.apiNoSuffixArg": split.suffix });
  }
  if (!result && opNo) {
    result = await querySeverance({ "methodToCall": "search", "searchArgs.operatorNumbersArg": opNo });
  }
  if (!result && leaseNo && dist) {
    result = await querySeverance({ "methodToCall": "search", "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": dist, "searchArgs.leaseTypeArg": "G" });
  }

  if (!result) {
    return {
      ok: true,
      data: { found: false, note: "No severance, seal certificate, or reconnect records found." },
      summary: "fetch_severance_records: no records found",
    };
  }

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

// S8 — Monthly Production (3-step EWA session)
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
  const opNo   = ctx.operator_number ?? null;
  const endYear = String(new Date().getFullYear());

  const leaseNoStripped = leaseNo ? leaseNo.replace(/^0+/, "") : "";
  const specificLinkRe  = leaseNoStripped
    ? new RegExp(`href=["'](specificLeaseQueryAction\\.do[^"']*(?:&amp;|&)leaseNo=0*${leaseNoStripped}[^"']*)["']`, "i")
    : /href=["'](specificLeaseQueryAction\.do[^"']+)["']/i;

  const trySpecificLease = async (searchHtml: string, sessionCookie: string | undefined): Promise<boolean> => {
    const linkMatch = searchHtml.match(specificLinkRe);
    if (!linkMatch) return false;
    const specificPath = linkMatch[1].replace(/&amp;/g, "&");
    const specificUrl  = `${EWA_BASE}/${specificPath}`;
    const leaseHtml    = (await callProxy(specificUrl, "GET", undefined, sessionCookie)).html;
    const parsed       = parseSpecificLeaseMonthly(leaseHtml);
    if (parsed.length === 0) return false;
    monthlyRecords.push(...parsed.slice(0, 60));
    const distM = specificPath.match(/[?&]distCode=([^&]+)/i);
    confirmedDistrict = distM ? distM[1] : distHint;
    if (!ctx.district && confirmedDistrict) ctx.district = confirmedDistrict;
    trrcUrl = specificUrl;
    return true;
  };

  // Attempt 1: lease-number + district
  if (leaseNo && distHint) {
    try {
      const sessionResp  = await callProxy(`${EWA_BASE}/productionQueryAction.do`, "GET");
      const jsessionId   = extractSetCookieValue(sessionResp.set_cookie, "JSESSIONID");
      const hiddenFields = extractHiddenInputs(sessionResp.html);
      const cookie       = jsessionId ? `JSESSIONID=${jsessionId}` : undefined;
      const prodUrl      = jsessionId
        ? `${EWA_BASE}/productionQueryAction.do;jsessionid=${jsessionId}`
        : `${EWA_BASE}/productionQueryAction.do`;

      for (const lt of ["O", "G"]) {
        if (monthlyRecords.length > 0) break;
        for (const leaseField of ["searchArgs.leaseNumbersArg", "searchArgs.leaseNumberArg"]) {
          if (monthlyRecords.length > 0) break;
          try {
            const leaseFields: Record<string, string> = {
              ...hiddenFields,
              "methodToCall":               "search",
              [leaseField]:                 leaseNo,
              "searchArgs.districtCodeArg": distHint,
              "searchArgs.leaseTypeArg":    lt,
              "searchArgs.initialViewArg":  "Lease",
              "searchArgs.startMonthArg":   "01",
              "searchArgs.startYearArg":    "1993",
              "searchArgs.endMonthArg":     "12",
              "searchArgs.endYearArg":      endYear,
            };
            const searchHtml = (await callProxy(prodUrl, "POST", formBody(leaseFields), cookie)).html;
            await trySpecificLease(searchHtml, cookie);
          } catch { /* continue */ }
        }
        if (monthlyRecords.length === 0) {
          try {
            const districtFields: Record<string, string> = {
              ...hiddenFields,
              "methodToCall":               "search",
              "searchArgs.districtCodeArg": distHint,
              "searchArgs.leaseTypeArg":    lt,
              "searchArgs.initialViewArg":  "Lease",
              "searchArgs.startMonthArg":   "01",
              "searchArgs.startYearArg":    "1993",
              "searchArgs.endMonthArg":     "12",
              "searchArgs.endYearArg":      endYear,
            };
            const searchHtml = (await callProxy(prodUrl, "POST", formBody(districtFields), cookie)).html;
            await trySpecificLease(searchHtml, cookie);
          } catch { /* continue */ }
        }
      }
    } catch { /* fall through */ }
  }

  // Attempt 2: operator-based fallback
  if (monthlyRecords.length === 0 && leaseNo && opNo) {
    const districtsToTry = distHint
      ? [distHint, ...ALL_DISTRICTS.filter(d => d !== distHint)]
      : ALL_DISTRICTS;
    try {
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
            const operatorFields: Record<string, string> = {
              ...hiddenFields,
              "methodToCall":                  "search",
              "searchArgs.operatorNumbersArg": opNo,
              "searchArgs.districtCodeArg":    dist,
              "searchArgs.leaseTypeArg":       lt,
              "searchArgs.initialViewArg":     "Lease",
              "searchArgs.startMonthArg":      "01",
              "searchArgs.startYearArg":       "1993",
              "searchArgs.endMonthArg":        "12",
              "searchArgs.endYearArg":         endYear,
            };
            const operatorHtml = (await callProxy(prodUrl, "POST", formBody(operatorFields), cookie)).html;
            await trySpecificLease(operatorHtml, cookie);
          } catch { /* continue */ }
        }
      }
    } catch { /* session failed */ }
  }

  // Proration records (embedded in production fetch)
  const tryProration = async (params: Record<string, string>) => {
    for (const [ep, lt] of [[`${EWA_BASE}/oilProQueryAction.do`, "OIL"], [`${EWA_BASE}/gasProQueryAction.do`, "GAS"]] as [string,string][]) {
      try {
        const html   = await fetchHtml(ep, { method: "POST", body: formBody({ ...params, "methodToCall": "search" }) });
        const parsed = parseTable(html, /API|District|Lease|Potential|Allowable/i);
        if (parsed) prorationRecords.push(...parsed.dataRows.map(r => ({ ...r, _lease_type: lt })));
      } catch { /* continue */ }
    }
  };

  if (apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      await tryProration({ "searchArgs.apiPrefixArg": split.prefix, "searchArgs.apiSuffixArg": split.suffix });
    }
  }
  if (leaseNo && confirmedDistrict && prorationRecords.length === 0) {
    await tryProration({ "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": confirmedDistrict });
  }

  if (monthlyRecords.length === 0 && prorationRecords.length === 0) {
    return {
      ok: true,
      data: {
        found:        false,
        lease_number: leaseNo,
        district:     distHint,
        note:         !leaseNo
          ? "No lease number resolved — well may not appear in any TRRC EWA database."
          : !opNo
          ? `Lease ${leaseNo} found but no operator number resolved. TRRC production requires operator number for 3-step EWA session.`
          : `No production records found for Lease ${leaseNo} in any district. Well may be injection-only or unitized under a larger lease.`,
        trrc_source_url: trrcUrl,
      },
      summary: `fetch_production: no records — Lease ${leaseNo ?? "?"} scanned all districts`,
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
      found:              true,
      lease_number:       leaseNo,
      district:           confirmedDistrict ?? distHint,
      monthly_production: {
        record_count: monthlyRecords.length,
        records:      monthlyRecords.slice(0, 60),
        note:         "Monthly lease production volumes from TRRC specificLeaseQueryAction.do",
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

// S9 — P-4 Production Test Records (p4QueryAction.do with JS session)
async function toolFetchP4Records(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo  = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number;
  const distHint = input.district     ? String(input.district).trim()     : ctx.district;
  const apiRaw   = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;

  const tryP4Session = async (postParams: Record<string, string>, sessionSuffix: string): Promise<{ records: Record<string,string>[]; url: string } | null> => {
    try {
      const sessionResp  = await callProxy(`${EWA_BASE}/p4QueryAction.do`, "GET");
      const jsessionId   = extractSetCookieValue(sessionResp.set_cookie, "JSESSIONID");
      const hiddenFields = extractHiddenInputs(sessionResp.html);
      const cookie       = jsessionId ? `JSESSIONID=${jsessionId}` : undefined;
      const p4Url        = jsessionId
        ? `${EWA_BASE}/p4QueryAction.do;jsessionid=${jsessionId}`
        : `${EWA_BASE}/p4QueryAction.do`;

      const fields: Record<string, string> = {
        ...hiddenFields,
        "methodToCall": "search",
        ...postParams,
      };
      const searchHtml = (await callProxy(p4Url, "POST", formBody(fields), cookie)).html;
      if (/No results found/i.test(searchHtml)) return null;

      const rows      = extractTableRows(searchHtml);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|Lease|District|Test|Formation|Rate|Pressure|Date/i));
      if (hIdx < 0) {
        // Try to extract anything useful from text
        const txt = extractText(searchHtml, 2000);
        if (txt.length > 100 && !/error/i.test(txt.slice(0, 200))) {
          return { records: [{ raw_text: txt.slice(0, 800) }], url: `${EWA_BASE}/p4QueryAction.do?${sessionSuffix}` };
        }
        return null;
      }
      const header   = cleanRows[hIdx];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]));
      if (dataRows.length === 0) return null;
      const records = dataRows.slice(0, 20).map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
        return obj;
      });
      return { records, url: `${EWA_BASE}/p4QueryAction.do?${sessionSuffix}` };
    } catch {
      return null;
    }
  };

  let result: { records: Record<string,string>[]; url: string } | null = null;

  // Try by API first
  if (apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      result = await tryP4Session(
        { "searchArgs.apiNoPrefixArg": split.prefix, "searchArgs.apiNoSuffixArg": split.suffix },
        `apiPrefix=${split.prefix}&apiSuffix=${split.suffix}`,
      );
    }
  }

  // Try by lease + district
  if (!result && leaseNo && distHint) {
    for (const lt of ["O", "G"]) {
      if (result) break;
      result = await tryP4Session(
        { "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": distHint, "searchArgs.leaseTypeArg": lt },
        `leaseNo=${leaseNo}&distCode=${distHint}&lt=${lt}`,
      );
    }
  }

  // Try scanning districts
  if (!result && leaseNo) {
    for (const dist of (distHint ? [distHint, ...ALL_DISTRICTS.filter(d => d !== distHint)] : ALL_DISTRICTS)) {
      if (result) break;
      for (const lt of ["O", "G"]) {
        if (result) break;
        result = await tryP4Session(
          { "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": dist, "searchArgs.leaseTypeArg": lt },
          `leaseNo=${leaseNo}&distCode=${dist}&lt=${lt}`,
        );
      }
    }
  }

  if (!result) {
    return {
      ok:   true,
      data: {
        found:           false,
        note:            "No P-4 production test records found via p4QueryAction.do. Records may require direct TRRC access.",
        manual_required: false,
        trrc_source_url: "https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/",
      },
      summary: "fetch_p4_records: no P-4 test records found",
    };
  }

  return {
    ok:   true,
    data: {
      found:           true,
      count:           result.records.length,
      records:         result.records,
      note:            "P-4 production test records (test rate, shut-in pressure, formation)",
      trrc_source_url: result.url,
    },
    summary: `fetch_p4_records: ${result.records.length} P-4 test record(s) from p4QueryAction.do`,
  };
}

// S10 — Completion Records W-2 (completionQueryAction.do with JS session)
async function toolFetchCompletionRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? ctx.api_numbers.slice(0, 3);
  if (apis.length === 0) return { ok: false, data: { error: "api_numbers required" }, summary: "fetch_completion_records: no APIs" };

  const results: Record<string, unknown>[] = [];

  for (const api of apis.slice(0, 3)) {
    const split = splitApi(api);
    if (!split) { results.push({ api, error: "invalid API format" }); continue; }
    const formatted = `42-${split.prefix}-${split.suffix}`;

    try {
      // Step 1: GET session
      const sessionResp  = await callProxy(`${EWA_BASE}/completionQueryAction.do`, "GET");
      const jsessionId   = extractSetCookieValue(sessionResp.set_cookie, "JSESSIONID");
      const hiddenFields = extractHiddenInputs(sessionResp.html);
      const cookie       = jsessionId ? `JSESSIONID=${jsessionId}` : undefined;
      const compUrl      = jsessionId
        ? `${EWA_BASE}/completionQueryAction.do;jsessionid=${jsessionId}`
        : `${EWA_BASE}/completionQueryAction.do`;

      // Step 2: POST with API number
      const fields: Record<string, string> = {
        ...hiddenFields,
        "methodToCall":               "search",
        "searchArgs.apiNoPrefixArg":  split.prefix,
        "searchArgs.apiNoSuffixArg":  split.suffix,
      };
      const searchHtml = (await callProxy(compUrl, "POST", formBody(fields), cookie)).html;

      if (/No results found/i.test(searchHtml)) {
        results.push({ api: formatted, found: false, source: "completionQueryAction" });
        continue;
      }

      const rows      = extractTableRows(searchHtml);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|Lease|Formation|Completion|Depth|Casing|Perfor|Date|District|Status/i));

      if (hIdx >= 0) {
        const header   = cleanRows[hIdx];
        const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]));
        const records  = dataRows.slice(0, 10).map(row => {
          const obj: Record<string, string> = {};
          header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
          return obj;
        });

        // Enrich context
        const firstRec = records[0] ?? {};
        const foundLease = firstRec["lease_no"] ?? firstRec["lease_number"] ?? "";
        const foundDist  = firstRec["dist_code"] ?? firstRec["district"] ?? "";
        const foundOpNo  = firstRec["operator_no"] ?? firstRec["operator_number"] ?? "";
        const foundOp    = firstRec["operator_name"] ?? firstRec["operator"] ?? "";
        if (!ctx.lease_number    && foundLease)                              ctx.lease_number    = foundLease;
        if (!ctx.district        && foundDist)                               ctx.district        = foundDist;
        if (!ctx.operator_number && foundOpNo && /^\d{5,}$/.test(foundOpNo)) ctx.operator_number = foundOpNo;
        if (!ctx.operator_name   && foundOp)                                 ctx.operator_name   = foundOp;

        results.push({
          api:     formatted,
          found:   true,
          source:  "completionQueryAction",
          count:   records.length,
          records,
          trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/completionQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&methodToCall=search`,
        });
      } else {
        // No structured table — try text extraction for any completion data
        const txt = extractText(searchHtml, 1500);
        results.push({
          api:    formatted,
          found:  /formation|completion|casing|perfor/i.test(txt),
          source: "completionQueryAction",
          raw_text: txt.slice(0, 600),
        });
      }
    } catch (e) {
      // Fall back to direct POST without session
      try {
        const html = await fetchHtml(`${EWA_BASE}/completionQueryAction.do`, {
          method: "POST",
          body: formBody({
            "searchArgs.apiNoPrefixArg":  split.prefix,
            "searchArgs.apiNoSuffixArg":  split.suffix,
            "methodToCall":               "search",
          }),
        });
        const rows      = extractTableRows(html);
        const cleanRows = rows.filter(r => !isNoiseRow(r));
        const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|Lease|Formation|Completion|Depth|Date/i));
        if (hIdx >= 0) {
          const header   = cleanRows[hIdx];
          const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r));
          const records  = dataRows.slice(0, 10).map(row => {
            const obj: Record<string, string> = {};
            header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
            return obj;
          });
          results.push({ api: formatted, found: records.length > 0, source: "completionQueryAction-direct", count: records.length, records });
        } else {
          results.push({ api: formatted, error: String(e).slice(0, 80), source: "completionQueryAction", found: false });
        }
      } catch {
        results.push({ api: formatted, error: String(e).slice(0, 80) });
      }
    }
  }

  const firstApiSplit = splitApi(apis[0] ?? "");
  const totalFound = results.filter(r => r["found"] === true).length;
  return {
    ok: true,
    data: {
      apis_queried: apis.length,
      results,
      note: "W-2 completion records: formation, depth, perforations, casing program",
      trrc_source_url: firstApiSplit
        ? `https://webapps2.rrc.texas.gov/EWA/completionQueryAction.do?searchArgs.apiNoPrefixArg=${firstApiSplit.prefix}&searchArgs.apiNoSuffixArg=${firstApiSplit.suffix}&methodToCall=search`
        : "https://webapps2.rrc.texas.gov/EWA/completionQueryAction.do",
    },
    summary: `fetch_completion_records: W-2 completion data for ${totalFound}/${apis.length} API(s) via completionQueryAction.do`,
  };
}

// S11 — Plugging Records W-3C (pluggingQueryAction.do)
async function toolFetchPluggingRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;
  const dist    = input.district     ? String(input.district).trim()     : ctx.district ?? null;

  const queryPlugging = async (params: Record<string, string>): Promise<{ records: Record<string,string>[]; url: string } | null> => {
    try {
      const html = await fetchHtml(`${EWA_BASE}/pluggingQueryAction.do`, {
        method: "POST",
        body: formBody({ ...params, "methodToCall": "search" }),
      });
      if (/No results found/i.test(html)) return null;
      const rows      = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const hIdx      = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|Lease|Plug|District|Date|Formation|Depth|Operator/i));
      if (hIdx < 0) {
        const txt = extractText(html, 1500);
        if (/plug/i.test(txt) && txt.length > 200) {
          return { records: [{ raw_text: txt.slice(0, 600) }], url: `${EWA_BASE}/pluggingQueryAction.do` };
        }
        return null;
      }
      const header   = cleanRows[hIdx];
      const dataRows = cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/:\s*$/.test(r[0]));
      if (dataRows.length === 0) return null;
      const records = dataRows.slice(0, 20).map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = row[i] ?? ""; });
        return obj;
      });
      const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return { records, url: `https://webapps2.rrc.texas.gov/EWA/pluggingQueryAction.do?${qs}&methodToCall=search` };
    } catch {
      return null;
    }
  };

  let result: { records: Record<string,string>[]; url: string } | null = null;

  if (apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      result = await queryPlugging({ "searchArgs.apiNoPrefixArg": split.prefix, "searchArgs.apiNoSuffixArg": split.suffix });
    }
  }

  if (!result && leaseNo && dist) {
    result = await queryPlugging({ "searchArgs.leaseNumberArg": leaseNo, "searchArgs.districtCodeArg": dist });
  }

  if (!result) {
    return {
      ok:   true,
      data: {
        found:           false,
        api_number:      ctx.api_numbers[0] ?? null,
        note:            "No plugging records found via pluggingQueryAction.do. If well is plugged, check wellbore status (AB = Abandoned, PP = Partial Plug) and IWAR.",
        trrc_source_url: "https://www.rrc.texas.gov/oil-and-gas/applications-and-permits/drilling-permits/plugging-records/",
      },
      summary: "fetch_plugging_records: no W-3C plugging records found",
    };
  }

  return {
    ok:   true,
    data: {
      found:           true,
      count:           result.records.length,
      records:         result.records,
      note:            "W-3C plugging records from pluggingQueryAction.do",
      trrc_source_url: result.url,
    },
    summary: `fetch_plugging_records: ${result.records.length} W-3C plugging record(s)`,
  };
}

// S12 — CODA Imaged Documents
function toolFetchCodaRecords(_input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const apiNum = ctx.api_numbers[0] ?? null;
  return {
    ok:   true,
    data: {
      manual_required:  true,
      api_number:       apiNum,
      documents_to_check: ["W-2 Completion Report", "G-1 Gas Well Completion", "W-3C Plugging Record", "H-15 Crude Oil Transportation", "Sundry Notices"],
      instructions:     "Navigate to TRRC Imaged Records (powered by Neubus). Search Oil & Gas Well Records by API number or operator name to retrieve scanned paper documents.",
      trrc_source_url:  "https://www.rrc.texas.gov/resource-center/research/research-queries/imaged-records/",
      imaged_records_menu: "https://www.rrc.texas.gov/resource-center/research/research-queries/imaged-records/imaged-records-menu/",
      neubus_well_records: "https://rrcsearch3.neubus.com/esd3-rrc/index.php?_module_=esd&_action_=keysearch&profile=9",
      note:             "Neubus imaged records use Vue.js + reCAPTCHA and cannot be automated. Manual browser access required.",
    },
    summary: "fetch_coda_records: manual_required — CODA/Neubus document image system requires browser access",
  };
}

// S13 — Compliance Violations (RRC OIL / ICE portal — JSF/PrimeFaces AJAX)
async function toolFetchComplianceViolations(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw  = input.api_number      ? String(input.api_number).trim()      : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number    ? String(input.lease_number).trim()    : ctx.lease_number ?? null;
  const opNoRaw = input.operator_number ? String(input.operator_number).trim() : ctx.operator_number ?? null;

  const ICE_URL = "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml";

  // ICE portal requires exactly 6-digit operator numbers
  const padOpNo = (n: string | null): string | null => {
    if (!n) return null;
    const digits = n.replace(/\D/g, "");
    if (!digits) return null;
    return digits.padStart(6, "0").slice(-6);
  };
  const opNo6 = padOpNo(opNoRaw);

  // Column names for the 17-column violations table
  const VIOL_COLS = [
    "violation_discovery_date", "district", "operator_name", "operator_no",
    "lease_no", "lease_facility_name", "api_no", "county", "well_no",
    "drilling_permit_no", "field_name", "violated_rule", "violated_rule_description",
    "major_violation", "compliant_on_reinspection", "last_enforcement_action",
    "last_enforcement_action_date",
  ];

  const parseViolations = (xml: string): { violations: Record<string, string>[]; totalCount: number } => {
    const updateMatch = xml.match(/<update id="IceQueryForm:j_idt39:violResults"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/);
    if (!updateMatch) return { violations: [], totalCount: 0 };

    const html       = updateMatch[1];
    const countMatch = html.match(/Showing\s+\d+-\d+\s+out\s+of\s+(\d+)\s+violation/i);
    const totalCount = countMatch ? parseInt(countMatch[1], 10) : 0;

    const violations: Record<string, string>[] = [];
    const rowMatches = html.matchAll(/<tr[^>]*data-ri=["']\d+["'][^>]*>([\s\S]*?)<\/tr>/gi);
    for (const rowMatch of rowMatches) {
      const cells: string[] = [];
      for (const cell of rowMatch[1].matchAll(/<td[^>]*role=["']gridcell["'][^>]*>([\s\S]*?)<\/td>/gi)) {
        cells.push(cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      }
      if (cells.length >= 1) {
        const obj: Record<string, string> = {};
        VIOL_COLS.forEach((col, i) => { obj[col] = cells[i] ?? ""; });
        violations.push(obj);
      }
    }

    return { violations, totalCount };
  };

  // Returns parsed result (even if 0 violations) on successful AJAX response.
  // Returns null only on session/network failure — callers use null to detect errors.
  const runSearch = async (overrides: Record<string, string>): Promise<{ violations: Record<string, string>[]; totalCount: number } | null> => {
    try {
      // Step 1: GET page for JSESSIONID + ViewState
      const getRes    = await callProxy(ICE_URL, "GET");
      const jsession  = extractSetCookieValue(getRes.set_cookie, "JSESSIONID");
      const viewState = extractHiddenInputs(getRes.html)["javax.faces.ViewState"] ?? "";
      if (!viewState) return null;

      // Step 2: POST violations AJAX search
      const fields: Record<string, string> = {
        "javax.faces.partial.ajax":              "true",
        "javax.faces.source":                    "IceQueryForm:j_idt39:j_idt181",
        "javax.faces.partial.execute":           "IceQueryForm",
        "javax.faces.partial.render":            "IceQueryForm:j_idt39:violResults IceQueryForm:messages",
        "IceQueryForm":                          "IceQueryForm",
        "IceQueryForm:j_idt39_activeIndex":      "1",
        // Inspections tab fields (empty)
        "IceQueryForm:j_idt39:qopnm":            "",
        "IceQueryForm:j_idt39:qopno":            "",
        "IceQueryForm:j_idt39:qcnty_focus":      "",
        "IceQueryForm:j_idt39:qcnty_input":      "",
        "IceQueryForm:j_idt39:qlsnm":            "",
        "IceQueryForm:j_idt39:qlsno":            "",
        "IceQueryForm:j_idt39:qdis_focus":       "",
        "IceQueryForm:j_idt39:qdis_input":       "",
        "IceQueryForm:j_idt39:qapino":           "",
        "IceQueryForm:j_idt39:qdpno":            "",
        "IceQueryForm:j_idt39:qindtf_input":     "",
        "IceQueryForm:j_idt39:qindtt_input":     "",
        "IceQueryForm:j_idt39:qiRle_focus":      "",
        "IceQueryForm:j_idt39:qiRle_input":      "",
        // Violations tab fields (empty base; overrides applied below)
        "IceQueryForm:j_idt39:qvopnm":           "",
        "IceQueryForm:j_idt39:qvopno":           "",
        "IceQueryForm:j_idt39:qvcnty_focus":     "",
        "IceQueryForm:j_idt39:qvcnty_input":     "",
        "IceQueryForm:j_idt39:qvlsnm":           "",
        "IceQueryForm:j_idt39:qvlsno":           "",
        "IceQueryForm:j_idt39:qvdis_focus":      "",
        "IceQueryForm:j_idt39:qvdis_input":      "",
        "IceQueryForm:j_idt39:qvapino":          "",
        "IceQueryForm:j_idt39:qvdpno":           "",
        "IceQueryForm:j_idt39:qvindtf_input":    "",
        "IceQueryForm:j_idt39:qvindtt_input":    "",
        "IceQueryForm:j_idt39:qviRle_focus":     "",
        "IceQueryForm:j_idt39:qviRle_input":     "",
        // Violations search button (self-submit)
        "IceQueryForm:j_idt39:j_idt181":         "IceQueryForm:j_idt39:j_idt181",
        "javax.faces.ViewState":                 viewState,
        ...overrides,
      };

      const postRes = await callProxy(
        ICE_URL, "POST",
        formBody(fields),
        jsession ? `JSESSIONID=${jsession}` : undefined,
        { "Faces-Request": "partial/ajax", "Content-Type": "application/x-www-form-urlencoded" },
      );

      // If the response doesn't contain the violations update panel, the AJAX
      // session failed (e.g., stale ViewState or server error).
      if (!postRes.html.includes("IceQueryForm:j_idt39:violResults")) return null;
      return parseViolations(postRes.html);
    } catch {
      return null;
    }
  };

  // Search order: operator number (most comprehensive) → lease number → 8-digit API
  let result: { violations: Record<string, string>[]; totalCount: number } | null = null;
  let searchedBy = "";

  if (opNo6) {
    result = await runSearch({ "IceQueryForm:j_idt39:qvopno": opNo6 });
    if (result) searchedBy = `operator_no:${opNo6}`;
  }

  if (!result && leaseNo) {
    result = await runSearch({ "IceQueryForm:j_idt39:qvlsno": leaseNo });
    if (result) searchedBy = `lease_no:${leaseNo}`;
  }

  if (!result && apiRaw) {
    // ICE stores API without state code (8 digits: county+prefix+suffix)
    const api8 = apiRaw.replace(/\D/g, "").slice(2, 10);
    if (api8.length === 8) {
      result = await runSearch({ "IceQueryForm:j_idt39:qvapino": api8 });
      if (result) searchedBy = `api_no:${api8}`;
    }
  }

  // If all searches returned null (session/network error, not zero results)
  if (!result) {
    if (!opNo6 && !leaseNo && !apiRaw) {
      return {
        ok:   false,
        data: { error: "No operator number, lease number, or API number available to search ICE portal" },
        summary: "fetch_compliance_violations: no search identifiers available",
      };
    }
    return {
      ok:   false,
      data: {
        error:           "ICE portal AJAX session failed — could not retrieve violations",
        trrc_source_url: ICE_URL,
      },
      summary: "fetch_compliance_violations: ICE portal session error",
    };
  }

  if (result.totalCount === 0) {
    return {
      ok:   true,
      data: {
        found:           false,
        violation_count: 0,
        searched_by:     searchedBy,
        note:            "No violations found in RRC OIL (ICE portal) for this operator/lease.",
        trrc_source_url: ICE_URL,
      },
      summary: `fetch_compliance_violations: 0 violations found (${searchedBy})`,
    };
  }

  const openViolations = result.violations.filter(v =>
    (v["compliant_on_reinspection"] ?? "").toUpperCase() !== "Y"
  );
  const closedViolations = result.violations.length - openViolations.length;
  const truncated = result.totalCount > result.violations.length;

  return {
    ok:   true,
    data: {
      found:               true,
      violation_count:     result.totalCount,
      violations_fetched:  result.violations.length,
      open_count:          openViolations.length,
      closed_count:        closedViolations,
      violations:          result.violations,
      searched_by:         searchedBy,
      note:                truncated
        ? `Showing first ${result.violations.length} of ${result.totalCount} total violations. Navigate to RRC OIL for complete list.`
        : null,
      trrc_source_url:     ICE_URL,
    },
    summary: `fetch_compliance_violations: ${result.totalCount} violation(s) found — ${openViolations.length} open, ${closedViolations} closed (${searchedBy})`,
  };
}

// S14 — UIC / Injection Records
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

    const html = await fetchHtml(`${EWA_BASE}/uicQueryAction.do`, { method: "POST", body: formBody(params) });

    // UIC results page uses nested tables — extract from href URL params instead of table rows
    const uicLinkM = html.match(/uicResultsDrillDownQueryAction\.do[^"']*[?&]uic=(\d+)/i);
    const uicNo    = uicLinkM ? uicLinkM[1] : "";

    const leaseHrefM = html.match(/leaseDetailAction\.do[^"']*[?&]distCode=([^&"'\s]+)[^"']*[?&]leaseNo=(\d+)/i);
    const distCode   = leaseHrefM ? leaseHrefM[1] : "";
    const leaseNo    = leaseHrefM ? leaseHrefM[2] : "";

    const apiHrefM = html.match(/leaseDetailAction\.do[^"']*[?&]apiNo=(\d+)/i);
    const apiNoVal = apiHrefM ? apiHrefM[1] : "";

    const found = !!(uicNo || leaseNo || distCode);
    const records = found ? [{
      uic_no:        uicNo,
      api_no:        apiNoVal,
      district:      distCode,
      lease_no:      leaseNo,
      lease_name:    "",
      operator_name: "",
      county:        "",
    }] : [];

    if (found) {
      if (!ctx.lease_number && leaseNo && /^\d+$/.test(leaseNo)) ctx.lease_number = leaseNo;
      if (!ctx.district     && distCode)                          ctx.district     = distCode;
    }

    const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return {
      ok:   true,
      data: { identifier: label, count: records.length, records, uic_no: uicNo, trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/uicQueryAction.do?${qs}` },
      summary: `fetch_injection_records: ${label} — ${records.length} UIC injection record(s)${uicNo ? ` (UIC ${uicNo})` : ""}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_injection_records: failed — ${String(e).slice(0, 80)}` };
  }
}

// S15 — Texas GLO Survey / Abstract Data
function toolFetchGloSurvey(_input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  return {
    ok:   true,
    data: {
      manual_required:  true,
      county:           ctx.county,
      lease_number:     ctx.lease_number,
      instructions:     "Search Texas General Land Office (GLO) Land Grant Database by county + abstract number or survey name to determine state land status and original grantee.",
      search_fields:    ["County", "Abstract Number", "Original Grantee", "Survey/Block/Township"],
      trrc_source_url:  "https://www.glo.texas.gov/archives-heritage/search-our-collections/land-grant-search",
      note:             "GLO data is relevant for wells on state land (riverbeds, tidewater, school lands). Private land wells will not appear. Abstract number from S1 wellbore data can be used to cross-reference.",
    },
    summary: "fetch_glo_survey: manual_required — Texas GLO land grant search at glo.texas.gov",
  };
}

// S16 — RRC GIS Plat Map (ArcGIS REST API)
async function toolFetchGisPlat(_input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum = ctx.api_numbers[0] ?? null;
  const GIS_BASE = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer";

  if (!apiNum) {
    return {
      ok:   true,
      data: {
        manual_required: true,
        note:            "No API number available for GIS query.",
        trrc_source_url: "https://gis.rrc.texas.gov/GISViewer/",
      },
      summary: "fetch_gis_plat: no API number — manual GIS lookup required",
    };
  }

  // GIS stores 8-digit API: county(3) + prefix(3) + suffix(5) minus leading "42" state code
  const api8 = apiNum.replace(/\D/g, "").slice(2, 10);
  const split = splitApi(apiNum);
  const viewerUrl = split
    ? `https://gis.rrc.texas.gov/GISViewer/?api=${split.prefix}-${split.suffix}`
    : "https://gis.rrc.texas.gov/GISViewer/";

  try {
    // GIS REST API is a public ArcGIS endpoint with standard TLS — use direct fetch,
    // not the EWA proxy (which exists only for webapps2.rrc.texas.gov's broken TLS).
    const gisGet = async (url: string): Promise<unknown> => {
      const res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GIS returned HTTP ${res.status}`);
      return res.json();
    };

    // Step 1: Query Layer 1 (Well Locations) by API
    const wellsJson = await gisGet(
      `${GIS_BASE}/1/query?where=${encodeURIComponent(`API='${api8}'`)}&outFields=API,GIS_WELL_NUMBER,GIS_SYMBOL_DESCRIPTION,GIS_LAT83,GIS_LONG83,GIS_LOCATION_SOURCE,RELIAB&f=json`,
    ) as { features?: Array<{ attributes: Record<string, unknown> }> };
    const features  = wellsJson.features ?? [];

    if (features.length === 0) {
      return {
        ok:   true,
        data: {
          found:           false,
          api_number:      apiNum,
          note:            "Well not found in RRC GIS well locations database.",
          trrc_source_url: viewerUrl,
        },
        summary: `fetch_gis_plat: API ${apiNum} not in GIS well locations`,
      };
    }

    const attrs = features[0].attributes;
    const lat   = typeof attrs["GIS_LAT83"]  === "number" ? attrs["GIS_LAT83"]  : null;
    const lng   = typeof attrs["GIS_LONG83"] === "number" ? attrs["GIS_LONG83"] : null;

    // Step 2: Spatial query Layer 24 (Surveys) using well coordinates
    let survey: Record<string, unknown> | null = null;
    if (lat !== null && lng !== null) {
      try {
        const geomParam  = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
        const surveyJson = await gisGet(
          `${GIS_BASE}/24/query?geometry=${geomParam}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelWithin&outFields=ABSTRACT_NUMBER,LEVEL1_SURVEY_NAME,LEVEL2_BLOCK_NUMBER,LEVEL4_SURVEY_NAME,ABSTRACT_LABEL&inSR=4326&f=json`,
        ) as { features?: Array<{ attributes: Record<string, unknown> }> };
        if (surveyJson.features && surveyJson.features.length > 0) {
          survey = surveyJson.features[0].attributes;
        }
      } catch { /* survey lookup is best-effort */ }
    }

    // Step 3: Check alert areas (Layer 26) for environmental/cleanup designations
    let alertAreas: string[] = [];
    if (lat !== null && lng !== null) {
      try {
        const geomParam  = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
        const alertJson  = await gisGet(
          `${GIS_BASE}/26/query?geometry=${geomParam}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelWithin&outFields=*&inSR=4326&f=json`,
        ) as { features?: Array<{ attributes: Record<string, unknown> }> };
        if (alertJson.features) {
          alertAreas = alertJson.features.map((f: { attributes: Record<string, unknown> }) =>
            String(f.attributes["NAME"] ?? f.attributes["AREANAME"] ?? f.attributes["OBJECTID"] ?? ""),
          ).filter(Boolean);
        }
      } catch { /* alert area lookup is best-effort */ }
    }

    return {
      ok:   true,
      data: {
        found:                true,
        api_number:           apiNum,
        well_number:          attrs["GIS_WELL_NUMBER"],
        well_type:            attrs["GIS_SYMBOL_DESCRIPTION"],
        latitude_nad83:       lat,
        longitude_nad83:      lng,
        location_source:      attrs["GIS_LOCATION_SOURCE"],
        location_reliability: attrs["RELIAB"],
        survey:               survey ? {
          abstract_number:  survey["ABSTRACT_NUMBER"],
          survey_name:      survey["LEVEL1_SURVEY_NAME"],
          block_number:     survey["LEVEL2_BLOCK_NUMBER"],
          section_name:     survey["LEVEL4_SURVEY_NAME"],
          abstract_label:   survey["ABSTRACT_LABEL"],
        } : null,
        alert_areas:          alertAreas.length > 0 ? alertAreas : null,
        trrc_source_url:      viewerUrl,
      },
      summary: `fetch_gis_plat: ${attrs["GIS_SYMBOL_DESCRIPTION"] ?? "well"} at ${typeof lat === "number" ? lat.toFixed(4) : "?"},${typeof lng === "number" ? lng.toFixed(4) : "?"}${survey ? ` — ${survey["ABSTRACT_LABEL"] ?? survey["LEVEL1_SURVEY_NAME"]}` : ""}`,
    };
  } catch (e) {
    return {
      ok:   false,
      data: { error: String(e), trrc_source_url: viewerUrl },
      summary: `fetch_gis_plat: failed — ${String(e).slice(0, 80)}`,
    };
  }
}

// ─── Tool dispatcher ─────────────────────────────────────────────────────────

async function dispatchTool(name: string, toolInput: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  switch (name) {
    case "search_by_api":              return toolSearchByApi(toolInput, ctx);
    case "search_by_lease":            return toolSearchByLease(toolInput, ctx);
    case "search_by_operator":         return toolSearchByOperator(toolInput, ctx);
    case "fetch_well_status":          return toolFetchWellStatus(toolInput, ctx);
    case "fetch_inactive_well_status": return toolFetchInactiveWellStatus(toolInput, ctx);
    case "fetch_orphan_well":          return toolFetchOrphanWell(toolInput, ctx);
    case "fetch_severance_records":    return toolFetchSeveranceRecords(toolInput, ctx);
    case "fetch_production":           return toolFetchProduction(toolInput, ctx);
    case "fetch_p4_records":           return toolFetchP4Records(toolInput, ctx);
    case "fetch_completion_records":   return toolFetchCompletionRecords(toolInput, ctx);
    case "fetch_plugging_records":     return toolFetchPluggingRecords(toolInput, ctx);
    case "fetch_coda_records":         return toolFetchCodaRecords(toolInput, ctx);
    case "fetch_compliance_violations":return toolFetchComplianceViolations(toolInput, ctx);
    case "fetch_injection_records":    return toolFetchInjectionRecords(toolInput, ctx);
    case "fetch_glo_survey":           return toolFetchGloSurvey(toolInput, ctx);
    case "fetch_gis_plat":             return await toolFetchGisPlat(toolInput, ctx);
    default:
      return { ok: false, data: { error: `Unknown tool: ${name}` }, summary: `Unknown tool: ${name}` };
  }
}

// ─── Coverage builder ─────────────────────────────────────────────────────────

interface CoverageEntry {
  category: string;
  label:    string;
  status:   "complete" | "partial" | "retrieval_failed" | "manual_required" | "no_applicable_record" | "not_checked";
  records_found:        number;
  data_current_through: string | null;
  sources_checked:      string[];
  notes:                string | null;
}

const TOOL_COVERAGE_MAP: Record<string, { category: string; label: string }> = {
  search_by_api:              { category: "wellbore_identity",  label: "S1 — Wellbore Identity (API Lookup)" },
  search_by_lease:            { category: "lease_inventory",    label: "S2 — Lease Well Inventory" },
  search_by_operator:         { category: "operator_p5",        label: "S3 — Operator / P-5 Organization" },
  fetch_well_status:          { category: "well_status",        label: "S4 — Well Status" },
  fetch_inactive_well_status: { category: "inactive_well",      label: "S5 — Inactive Well (IWAR)" },
  fetch_orphan_well:          { category: "orphan_well",        label: "S6 — Orphan Well Check" },
  fetch_severance_records:    { category: "severance",          label: "S7 — Severance Records" },
  fetch_production:           { category: "production",         label: "S8 — Monthly Production" },
  fetch_p4_records:           { category: "p4_records",         label: "S9 — P-4 Production Tests" },
  fetch_completion_records:   { category: "completion",         label: "S10 — Completion Records (W-2)" },
  fetch_plugging_records:     { category: "plugging",           label: "S11 — Plugging Records (W-3C)" },
  fetch_coda_records:         { category: "imaged_records",     label: "S12 — CODA Imaged Documents" },
  fetch_compliance_violations:{ category: "compliance",         label: "S13 — Compliance Violations" },
  fetch_injection_records:    { category: "injection",          label: "S14 — UIC / Injection Records" },
  fetch_glo_survey:           { category: "glo_survey",         label: "S15 — Texas GLO Survey" },
  fetch_gis_plat:             { category: "gis_plat",           label: "S16 — RRC GIS Plat Map" },
};

function buildCoverageFromAttempts(
  attempts: Array<{ source_name: string; status: string; result_count: number; result_data_json: unknown }>,
): CoverageEntry[] {
  return Object.entries(TOOL_COVERAGE_MAP).map(([toolName, { category, label }]) => {
    const attempt = attempts.findLast(a => a.source_name === toolName);
    if (!attempt) return { category, label, status: "not_checked", records_found: 0, data_current_through: null, sources_checked: [], notes: null };

    const data            = attempt.result_data_json as Record<string, unknown> ?? {};
    const found           = data["found"] === true;
    const manualRequired  = data["manual_required"] === true;
    const dataGap         = data["data_gap"] === true;
    const isSuccess       = attempt.status === "success";
    const count           = attempt.result_count ?? 0;

    let status: CoverageEntry["status"];
    if (manualRequired || dataGap) status = "manual_required";
    else if (!isSuccess)           status = "retrieval_failed";
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
  const totalSteps = 18; // 16 sources + up to 2 Phase 3 rescue runs

  const run = async (name: string, inputFn: () => Record<string, unknown>): Promise<ToolResult> => {
    const result = await dispatchTool(name, inputFn(), ctx);
    const data   = result.data as Record<string, unknown>;
    const count  = Array.isArray(data?.["wellbores"])   ? (data["wellbores"]  as unknown[]).length
                 : Array.isArray(data?.["wells"])        ? (data["wells"]      as unknown[]).length
                 : Array.isArray(data?.["records"])      ? (data["records"]    as unknown[]).length
                 : Array.isArray(data?.["violations"])   ? (data["violations"] as unknown[]).length
                 : Array.isArray(data?.["results"])      ? (data["results"]    as unknown[]).length
                 : data?.["found"] === true ? 1 : 0;

    console.log(`[trrc-dd-execute] [${runId}] ${name}: ${result.summary}`);

    await supabase.from("trrc_source_attempts").upsert({
      run_id:           runId,
      source_id:        `${name}_1`,
      source_name:      name,
      status:           result.ok ? "success" : "failed_transient",
      result_count:     count,
      error_message:    result.ok ? null : String(data?.["error"] ?? ""),
      attempted_at:     new Date().toISOString(),
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
    // PHASE 1 — ENTITY RESOLUTION  (S1, S2, S3)
    // Build context: API → lease+district, lease → wells, operator
    // ══════════════════════════════════════════════════════════════

    if (ctx.api_numbers.length > 0) {
      await run("search_by_api", () => ({ api_number: ctx.api_numbers[0] }));
    }

    if (ctx.lease_number) {
      await run("search_by_lease", () => ({ lease_number: ctx.lease_number!, district: ctx.district ?? "" }));
    }

    if (ctx.operator_name || ctx.operator_number) {
      await run("search_by_operator", () => ({ operator_name: ctx.operator_name, operator_number: ctx.operator_number }));
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE 2 — EARLY DATA  (S10, S14, S7)
    // Run completion, injection, and severance BEFORE production —
    // they may yield lease+district that unlocks the production query.
    // ══════════════════════════════════════════════════════════════

    if (ctx.api_numbers.length > 0) {
      await run("fetch_completion_records", () => ({ api_numbers: ctx.api_numbers }));
    }

    if (ctx.api_numbers.length > 0 || ctx.operator_number) {
      await run("fetch_injection_records", () => ({ api_number: ctx.api_numbers[0] ?? null, operator_number: ctx.operator_number }));
    }

    await run("fetch_severance_records", () => ({
      lease_number:    ctx.lease_number,
      district:        ctx.district,
      api_number:      ctx.api_numbers[0] ?? null,
      operator_number: ctx.operator_number,
    }));

    // ══════════════════════════════════════════════════════════════
    // PHASE 3 — CONTEXT ENRICHMENT  (rescue runs)
    // After early data pass, resolve still-missing lease or operator.
    // ══════════════════════════════════════════════════════════════

    if (ctx.lease_number && !ctx.district) {
      await run("search_by_lease", () => ({ lease_number: ctx.lease_number!, district: "" }));
    }

    if (!ctx.operator_number && ctx.operator_name) {
      await run("search_by_operator", () => ({ operator_name: ctx.operator_name, operator_number: null }));
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE 4 — FULL DATA  (S4, S5, S6, S7, S8, S9, S11, S13)
    // Pull all remaining TRRC record types with the best context.
    // ══════════════════════════════════════════════════════════════

    // S4 — Well Status
    await run("fetch_well_status", () => ({
      api_number:   ctx.api_numbers[0] ?? null,
      lease_number: ctx.lease_number,
      district:     ctx.district,
    }));

    // S5 — IWAR
    await run("fetch_inactive_well_status", () => ({
      api_number:      ctx.api_numbers[0] ?? null,
      operator_number: ctx.operator_number,
    }));

    // S6 — Orphan
    if (ctx.api_numbers.length > 0) {
      await run("fetch_orphan_well", () => ({ api_number: ctx.api_numbers[0] }));
    }

    // S7 — Severance (second pass — runs again with enriched context if we gained lease/district in Phase 3)
    if (ctx.lease_number && ctx.district) {
      await run("fetch_severance_records", () => ({
        lease_number:    ctx.lease_number,
        district:        ctx.district,
        api_number:      ctx.api_numbers[0] ?? null,
        operator_number: ctx.operator_number,
      }));
    }

    // S8 — Monthly Production
    await run("fetch_production", () => ({
      lease_number: ctx.lease_number,
      district:     ctx.district,
      api_number:   ctx.api_numbers[0] ?? null,
    }));

    // S9 — P-4 Production Tests
    await run("fetch_p4_records", () => ({
      api_number:   ctx.api_numbers[0] ?? null,
      lease_number: ctx.lease_number,
      district:     ctx.district,
    }));

    // S11 — Plugging Records
    await run("fetch_plugging_records", () => ({
      api_number:   ctx.api_numbers[0] ?? null,
      lease_number: ctx.lease_number,
      district:     ctx.district,
    }));

    // S13 — Compliance Violations
    await run("fetch_compliance_violations", () => ({
      api_number:      ctx.api_numbers[0] ?? null,
      lease_number:    ctx.lease_number,
      operator_number: ctx.operator_number,
      operator_name:   ctx.operator_name,
    }));

    // ══════════════════════════════════════════════════════════════
    // PHASE 5 — SUPPLEMENTAL  (S12, S15, S16)
    // Manual-required sources that provide reference URLs.
    // ══════════════════════════════════════════════════════════════

    await run("fetch_coda_records", () => ({}));
    await run("fetch_glo_survey",   () => ({}));
    await run("fetch_gis_plat",     () => ({}));

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

  // Persist monthly production rows
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
        onConflict:       "run_id,entity_type,api_number,lease_number,production_month",
        ignoreDuplicates: true,
      }).then(null, () => {});
    }
  }

  // Build coverage and mark complete
  const coverageJson = buildCoverageFromAttempts(allAttempts);
  const successCount = allAttempts.filter(a => a.status === "success").length;

  const { error: updateErr } = await supabase.from("trrc_due_diligence_runs").update({
    status:                   "complete",
    progress_percent:         100,
    completed_at:             new Date().toISOString(),
    updated_at:               new Date().toISOString(),
    resolved_primary_api:     ctx.api_numbers[0] ?? null,
    resolved_district:        ctx.district,
    resolved_lease_number:    ctx.lease_number,
    resolved_operator_number: ctx.operator_number,
    coverage_json:            coverageJson,
    result_summary:           `${successCount} of ${allAttempts.length} sources retrieved. ${ctx.production.length} production months found.`,
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
