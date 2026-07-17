/**
 * Supabase Edge Function: trrc-dd-execute
 *
 * Pure retrieval orchestrator — queries every TRRC EWA source in sequence
 * and writes structured results to trrc_source_attempts. No LLM required.
 *
 * POST body: { run_id: string }
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentContext {
  api_numbers: string[];
  district: string | null;
  lease_number: string | null;
  operator_name: string | null;
  operator_number: string | null;
  county: string | null;
  production: ProductionRow[];
  agentReport: null;  // kept for compatibility with tool handlers that set it
}

interface ProductionRow {
  year?: number;
  month?: number;
  oil_bbl?: number | null;
  gas_mcf?: number | null;
  water_bbl?: number | null;
  [key: string]: unknown;
}

interface ToolResult {
  ok: boolean;
  data: unknown;
  summary: string;
}



// ─── HTML text extractor ──────────────────────────────────────────────────────

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

// EWA pages include navigation menus, form labels, JS artifacts, and error messages
// as <tr> elements. These must be excluded before interpreting table data.
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

// Returns true only if the row looks like a real data-table header:
// must have ≥minCols cells, ≥2 short keyword-like cells (≤50 chars each).
function isHeaderRow(
  row: string[],
  minCols = 3,
  kw: RegExp = /API|District|Lease|Operator|Aging|Inactive|Field|Depth|Potential|Allowable|Orphan|Severance|Formation|County/i,
): boolean {
  if (row.length < minCols) return false;
  const matches = row.filter(c => c.length > 0 && c.length <= 50 && kw.test(c));
  return matches.length >= 2;
}

// ─── TRRC fetch helpers ───────────────────────────────────────────────────────

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// Split a 10-digit Texas API number into county prefix and well suffix
// Format: 42-CCC-WWWWW → prefix=CCC (3 digits), suffix=WWWWW (5 digits)
function splitApi(apiRaw: string): { prefix: string; suffix: string } | null {
  const digits = apiRaw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return { prefix: digits.slice(2, 5), suffix: digits.slice(5, 10) };
}

// EWA Proxy: Supabase/Deno (rustls) cannot connect to webapps2.rrc.texas.gov
// because that server uses RSA key exchange without forward secrecy, which
// rustls rejects. We route EWA requests through a Vercel proxy that uses
// Node.js/OpenSSL, which supports those cipher suites.
const EWA_PROXY_URL = `${Deno.env.get("APP_URL") ?? ""}/api/trrc/ewa-proxy`;
const EWA_PROXY_SECRET = Deno.env.get("TRRC_EWA_PROXY_SECRET") ?? "";

async function fetchHtmlViaProxy(url: string, method = "GET", body?: string): Promise<string> {
  if (!EWA_PROXY_URL.startsWith("http")) {
    throw new Error("APP_URL env var not set — cannot proxy EWA requests");
  }
  const res = await fetch(EWA_PROXY_URL, {
    method: "POST",
    signal: AbortSignal.timeout(35_000),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EWA_PROXY_SECRET}`,
    },
    body: JSON.stringify({ url, method, body }),
  });
  if (!res.ok) throw new Error(`EWA proxy returned HTTP ${res.status}`);
  const json = await res.json() as { html?: string; error?: string; status?: number };
  if (json.error) throw new Error(`EWA proxy error: ${json.error}`);
  if (!json.html) throw new Error("EWA proxy returned no HTML");
  if ((json.status ?? 200) >= 400) throw new Error(`EWA returned HTTP ${json.status}`);
  return json.html;
}

// For non-EWA JSON endpoints (future use)
async function fetchJson(url: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Accept": "application/json",
      "User-Agent": "MineralFlow-AI-TRRC-DD/1.0",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// Compatibility shim so existing tool handlers don't need to change
async function fetchHtml(url: string, opts: RequestInit = {}): Promise<string> {
  const method = (opts.method ?? "GET").toUpperCase();
  const body = opts.body ? String(opts.body) : undefined;
  return fetchHtmlViaProxy(url, method, body);
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function toolSearchByApi(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) return { ok: false, data: { error: "api_number required" }, summary: "search_by_api: no input" };

  const digits = apiRaw.replace(/\D/g, "");
  const api10 = digits.slice(0, 10);
  const split = splitApi(api10);

  if (!split) {
    return { ok: false, data: { error: "API number must be at least 10 digits" }, summary: `search_by_api: invalid API ${apiRaw}` };
  }

  // EWA wellboreQueryAction.do — uses county prefix (3 digits) + well suffix (5 digits)
  // Texas API: 42-CCC-WWWWW → prefix=CCC, suffix=WWWWW
  try {
    const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
      method: "POST",
      body: formBody({
        "searchArgs.apiNoPrefixArg": split.prefix,
        "searchArgs.apiNoSuffixArg": split.suffix,
        "searchArgs.scheduleTypeArg": "Both",
        "methodToCall": "search",
      }),
    });

    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|District|Lease|Operator/i));
    if (headerIdx < 0 || cleanRows.length <= headerIdx + 1) {
      return {
        ok: true,
        data: { found: false, api_number: api10, message: `API 42-${split.prefix}-${split.suffix} NOT FOUND in TRRC. Verify the API number.` },
        summary: `search_by_api: 42-${split.prefix}-${split.suffix} — NOT FOUND in TRRC`,
      };
    }

    const header = cleanRows[headerIdx] ?? [];
    const dataRows = cleanRows.slice(headerIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r));

    // Parse all matching wells
    const wells = dataRows.map(row => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
      return obj;
    });

    // Seed context from first well
    const first = wells[0] ?? {};
    const leaseNo  = first["lease_no_"] ?? first["lease_no"] ?? first["lease_number"] ?? "";
    const distCode = first["district"] ?? "";
    const operator = first["operator_name"] ?? first["operator"] ?? "";
    const county   = first["county"] ?? "";

    if (!ctx.api_numbers.includes(api10)) ctx.api_numbers.push(api10);
    if (!ctx.district && distCode)      ctx.district      = distCode;
    if (!ctx.lease_number && leaseNo)   ctx.lease_number  = leaseNo;
    if (!ctx.operator_name && operator) ctx.operator_name = operator;
    if (!ctx.county && county)          ctx.county        = county;

    return {
      ok: true,
      data: {
        found: true,
        api_number: api10,
        formatted_api: `42-${split.prefix}-${split.suffix}`,
        lease_number: leaseNo,
        district: distCode,
        operator,
        county,
        total_wellbores: wells.length,
        wellbores: wells.slice(0, 10),
        source: "ewa-wellbore",
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
  const distCode = String(input.district ?? "").trim();
  if (!leaseNo) {
    return { ok: false, data: { error: "lease_number required" }, summary: "search_by_lease: missing lease_number" };
  }

  // wellboreQueryAction.do supports searching by lease number + district
  const tryDistrict = async (dist: string, leaseType: string): Promise<ToolResult | null> => {
    try {
      const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.leaseTypeArg": leaseType,
          "searchArgs.districtCodeArg": dist,
          "searchArgs.leaseNumberArg": leaseNo,
          "searchArgs.scheduleTypeArg": "Both",
          "methodToCall": "search",
        }),
      });

      const rows = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|District|Lease|Operator/i));
      if (headerIdx < 0 || cleanRows.length <= headerIdx + 1) return null;

      const header = cleanRows[headerIdx] ?? [];
      const wells = cleanRows.slice(headerIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r)).map(row => {
        const obj: Record<string, string> = {};
        header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
        return obj;
      });

      if (wells.length === 0) return null;

      if (!ctx.lease_number) ctx.lease_number = leaseNo;
      if (!ctx.district)     ctx.district     = dist;

      for (const w of wells) {
        const api = (w["api_no_"] ?? w["api_no"] ?? w["api"] ?? "").replace(/\D/g, "").slice(0, 10);
        if (api.length === 10 && !ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
        if (!ctx.operator_name && w["operator_name"]) ctx.operator_name = w["operator_name"];
        if (!ctx.county && w["county"]) ctx.county = w["county"];
      }

      const onSchedule = wells.filter(w => (w["on_schedule"] ?? "").toUpperCase() === "Y").length;
      return {
        ok: true,
        data: {
          found: true,
          lease_number: leaseNo,
          district: dist,
          lease_type: leaseType === "O" ? "OIL" : leaseType === "G" ? "GAS" : "BOTH",
          total_wellbores: wells.length,
          on_schedule: onSchedule,
          off_schedule: wells.length - onSchedule,
          wellbores: wells.slice(0, 30),
          source: "ewa-wellbore",
          trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.leaseNumberArg=${leaseNo}&searchArgs.districtCodeArg=${dist}&searchArgs.scheduleTypeArg=Both&methodToCall=search`,
        },
        summary: `search_by_lease: Lease ${leaseNo} / District ${dist} — ${wells.length} wellbore(s), ${onSchedule} on-schedule`,
      };
    } catch {
      return null;
    }
  };

  const ALL_DISTRICTS = ["01", "02", "03", "04", "05", "06", "6E", "7B", "7C", "08", "8A", "09", "10"];
  // Try the provided district first; if not found, scan all districts
  const districtsToTry = distCode
    ? [distCode, ...ALL_DISTRICTS.filter(d => d !== distCode)]
    : ALL_DISTRICTS;

  for (const dist of districtsToTry) {
    for (const lt of ["O", "G", ""]) {
      const result = await tryDistrict(dist, lt);
      if (result) return result;
    }
  }

  return {
    ok: false,
    data: { error: `Lease ${leaseNo} not found in ${distCode ? `district ${distCode}` : "any district"}` },
    summary: `search_by_lease: Lease ${leaseNo} — NOT FOUND`,
  };
}

async function toolSearchByOperator(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const opName = input.operator_name ? String(input.operator_name).trim() : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  if (!opName && !opNo) {
    return { ok: false, data: { error: "operator_name or operator_number required" }, summary: "search_by_operator: no input" };
  }

  try {
    // organizationQueryAction.do — uses operatorNumbersArg (plural) or orgStatus filter
    // Operator search is by number or name via the "Operator(s)" picker which passes numbers
    const params: Record<string, string> = { "methodToCall": "search" };
    if (opNo) params["searchArgs.operatorNumbersArg"] = opNo;
    // Note: name-based search requires going through a separate picker; we skip that path
    // and fall through to org status search if only name is provided

    const html = await fetchHtml(`${EWA_BASE}/organizationQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));

    // Find the actual data rows (header row contains "Operator No." etc.)
    const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, /Operator No|Operator Name|Organization/i));
    if (headerIdx < 0 || cleanRows.length <= headerIdx + 1) {
      return {
        ok: true,
        data: { found: false, message: `No organization record found for operator "${opName ?? opNo}".` },
        summary: `search_by_operator: "${opName ?? opNo}" — not found in organization query`,
      };
    }

    const header = cleanRows[headerIdx] ?? [];
    const dataRows = cleanRows.slice(headerIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r));

    if (dataRows.length === 0) {
      return {
        ok: true,
        data: { found: false, message: `No organization record found for operator "${opName ?? opNo}".` },
        summary: `search_by_operator: "${opName ?? opNo}" — no results`,
      };
    }

    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = dataRows[0][i] ?? ""; });

    // IMPORTANT: only use what the TRRC EWA returned — never fall back to the
    // raw input `opNo` for setting ctx.operator_number.  The county code in an
    // API number (e.g. "165" from 42-165-02733) is NOT a TRRC operator number.
    // Real TRRC operator numbers are 5-6 numeric digits; reject anything shorter.
    const resolvedOpNo  = rec["operator_no_"] ?? rec["operator_no"] ?? "";
    const resolvedName  = rec["operator_name"] ?? opName ?? "";
    const orgStatus     = rec["organization_status"] ?? rec["org_status"] ?? rec["status"] ?? "";
    const orgType       = rec["organization_type"] ?? rec["org_type"] ?? "";
    const tnrFlag       = (rec["_tnr_91_114"] ?? rec["tnr_91114"] ?? "").toUpperCase() === "YES" ||
                          (rec["_tnr_91_114"] ?? rec["tnr_91114"] ?? "").toUpperCase() === "Y";

    // Only set if the HTML-parsed value looks like a real operator number (≥5 digits)
    if (!ctx.operator_number && resolvedOpNo && /^\d{5,}$/.test(resolvedOpNo.replace(/\D/g, ""))) {
      ctx.operator_number = resolvedOpNo;
    }
    if (!ctx.operator_name  && resolvedName)  ctx.operator_name   = resolvedName;

    return {
      ok: true,
      data: {
        found: true,
        operator_name: resolvedName,
        operator_no: resolvedOpNo,
        org_status: orgStatus,
        org_type: orgType,
        tnr_91114_flag: tnrFlag,
        mailing_address: [rec["mailing_address"], rec["mailing_city"], rec["mailing_state"], rec["mailing_zip"]].filter(Boolean).join(", "),
        phone: rec["phone_no_"] ?? rec["phone_no"] ?? "",
        raw: rec,
        trrc_source_url: resolvedOpNo
          ? `https://webapps2.rrc.texas.gov/EWA/p5QueryAction.do?searchArgs.operatorNumbersArg=${resolvedOpNo}&methodToCall=search`
          : opName
          ? `https://webapps2.rrc.texas.gov/EWA/p5QueryAction.do?searchArgs.operatorNameArg=${encodeURIComponent(opName)}&methodToCall=search`
          : "https://webapps2.rrc.texas.gov/EWA/p5QueryAction.do",
      },
      summary: `search_by_operator: "${resolvedName}" (${resolvedOpNo}) — ${orgStatus}${tnrFlag ? " [⚠ TNR §91.114 FLAG]" : ""}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_operator: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolSearchByLegalDescription(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const county   = input.county ? String(input.county) : null;
  const abstract = input.abstract_number ? String(input.abstract_number) : null;
  const survey   = input.survey_name ? String(input.survey_name) : null;
  const section  = input.section ? String(input.section) : null;

  if (!ctx.county && county) ctx.county = county;

  // The TRRC EWA does not expose a stateless GIS/legal description search endpoint.
  // Record all provided identifiers and note as a data gap for follow-up.
  return {
    ok: true,
    data: {
      found: false,
      query_params: { county, abstract, survey, section },
      message: "TRRC EWA does not provide a stateless GIS/legal description API. " +
        "To look up wells by legal description, use the TRRC GIS viewer at https://gis.rrc.texas.gov/ directly. " +
        "If you already have an API number or lease number from search_by_api or search_by_lease, proceed with those.",
      data_gap: true,
      trrc_source_url: "https://gis.rrc.texas.gov/",
    },
    summary: `search_by_legal_description: no stateless endpoint available — noted as data gap (county: ${county ?? "unspecified"})`,
  };
}

async function toolFetchProduction(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo  = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number;
  const distCode = input.district     ? String(input.district).trim()     : ctx.district;
  const apiRaw   = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;

  // The EWA specificLeaseQueryAction.do requires server-side session state and cannot be
  // called statlessly. Instead, we query the OIL and GAS PRORATION schedules
  // (oilProQueryAction.do and gasProQueryAction.do), which provide the current
  // production allowable, potential (BBL/MCFD), and well status.
  //
  // IMPORTANT: This is PRORATION data (current allowable), NOT monthly production history.
  // Monthly production history requires direct EWA browser session access.

  const results: Record<string, unknown>[] = [];

  // Helper: parse result table from proration query
  const parsePro = (html: string, leaseType: string) => {
    // EWA returns a "Please Correct the Errors" form page when params are invalid
    if (/Please\s+[Cc]orrect/i.test(html) || /errors?\s+list/i.test(html)) return null;
    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|District|Lease|Operator|Potential|Allowable/i));
    if (headerIdx < 0 || cleanRows.length <= headerIdx + 1) return null;
    const header = cleanRows[headerIdx] ?? [];
    const dataRows = cleanRows.slice(headerIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r)).map(row => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
      return obj;
    });
    if (dataRows.length === 0) return null;
    return { lease_type: leaseType, proration_records: dataRows };
  };

  // Try by API number first (most specific)
  if (apiRaw) {
    const split = splitApi(apiRaw);
    if (split) {
      const dist = distCode ?? "";
      for (const [endpoint, lt] of [
        [`${EWA_BASE}/oilProQueryAction.do`, "OIL"],
        [`${EWA_BASE}/gasProQueryAction.do`, "GAS"],
      ] as [string, string][]) {
        try {
          const params: Record<string, string> = {
            "searchArgs.apiPrefixArg": split.prefix,
            "searchArgs.apiSuffixArg": split.suffix,
            "methodToCall": "search",
          };
          if (dist) params["searchArgs.districtCodeArg"] = dist;
          const html = await fetchHtml(endpoint, { method: "POST", body: formBody(params) });
          const parsed = parsePro(html, lt);
          if (parsed) results.push(parsed);
        } catch { /* continue */ }
      }
    }
  }

  // Also try by lease + district if we have both
  if (leaseNo && distCode && results.length === 0) {
    for (const [endpoint, lt] of [
      [`${EWA_BASE}/oilProQueryAction.do`, "OIL"],
      [`${EWA_BASE}/gasProQueryAction.do`, "GAS"],
    ] as [string, string][]) {
      try {
        const html = await fetchHtml(endpoint, {
          method: "POST",
          body: formBody({
            "searchArgs.leaseNumberArg": leaseNo,
            "searchArgs.districtCodeArg": distCode,
            "methodToCall": "search",
          }),
        });
        const parsed = parsePro(html, lt);
        if (parsed) results.push(parsed);
      } catch { /* continue */ }
    }
  }

  if (results.length === 0) {
    return {
      ok: true,
      data: {
        found: false,
        note: "PRORATION DATA: No proration/allowable records found for this well. Monthly production history requires direct EWA browser session — mark as data gap.",
        lease_number: leaseNo,
        district: distCode,
        trrc_source_url: "https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/production-data/",
      },
      summary: `fetch_production: ${leaseNo ?? apiRaw ?? "?"} — no proration records (monthly history requires EWA session)`,
    };
  }

  // Summarize what we found
  const allRecs = results.flatMap(r => (r["proration_records"] as Record<string, string>[]) ?? []);
  const firstRec = allRecs[0] ?? {};
  const potential = firstRec["potential_bbl_"] ?? firstRec["potential"] ?? "N/A";
  const allowable = firstRec["daily_allowable"] ?? firstRec["allowable"] ?? "N/A";
  const wellType  = firstRec["unit_or_well_type"] ?? firstRec["oil_gas"] ?? "N/A";

  return {
    ok: true,
    data: {
      found: true,
      data_note: "PRORATION DATA (current allowable), NOT monthly production history. Monthly history requires EWA browser session — list as data gap.",
      lease_number: leaseNo,
      district: distCode,
      proration_results: results,
      summary_first_well: { potential_bbl: potential, daily_allowable: allowable, well_type: wellType },
      trrc_source_url: "https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/production-data/",
    },
    summary: `fetch_production: proration data retrieved — Potential: ${potential} BBL, Daily Allowable: ${allowable}, Type: ${wellType} (note: monthly history not available statlessly)`,
  };
}

async function toolFetchCompletionRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? ctx.api_numbers.slice(0, 5);
  if (apis.length === 0) return { ok: false, data: { error: "api_numbers required" }, summary: "fetch_completion_records: no APIs" };

  // The EWA CMPL (completionQueryAction.do) endpoint is not accessible statlessly.
  // We retrieve wellbore data from wellboreQueryAction.do which includes formation name,
  // API depth, well type, and on-schedule status — the core completion identifiers.
  try {
    const results: Record<string, unknown>[] = [];
    for (const api of apis.slice(0, 5)) {
      const split = splitApi(api);
      if (!split) { results.push({ api, error: "invalid API format" }); continue; }
      try {
        const html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
          method: "POST",
          body: formBody({
            "searchArgs.apiNoPrefixArg": split.prefix,
            "searchArgs.apiNoSuffixArg": split.suffix,
            "searchArgs.scheduleTypeArg": "Both",
            "methodToCall": "search",
          }),
        });
        const rows = extractTableRows(html);
        const cleanRows = rows.filter(r => !isNoiseRow(r));
        const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|District|Lease|Operator|Field|Depth/i));
        if (headerIdx >= 0 && cleanRows.length > headerIdx + 1) {
          const header = cleanRows[headerIdx] ?? [];
          const dataRows = cleanRows.slice(headerIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r)).map(row => {
            const obj: Record<string, string> = {};
            header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
            return obj;
          });
          results.push({
            api: `42-${split.prefix}-${split.suffix}`,
            source: "ewa-wellbore",
            wellbores: dataRows.slice(0, 5),
            note: "Completion data from wellbore query. W-2 completion documents require direct EWA CMPL access.",
          });
        } else {
          results.push({ api: `42-${split.prefix}-${split.suffix}`, message: "No wellbore data found for this API." });
        }
      } catch (e) {
        results.push({ api, error: String(e).slice(0, 80) });
      }
    }

    const firstApiSplit = splitApi(apis[0] ?? "");
    return {
      ok: true,
      data: {
        apis_queried: apis.length,
        results,
        note: "Full W-2 completion packets (CMPL system) are not accessible via stateless EWA queries. Formation, depth, and well type retrieved from wellbore query.",
        trrc_source_url: firstApiSplit
          ? `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${firstApiSplit.prefix}&searchArgs.apiNoSuffixArg=${firstApiSplit.suffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`
          : "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do",
      },
      summary: `fetch_completion_records: wellbore data retrieved for ${results.filter(r => r["wellbores"]).length}/${apis.length} APIs (W-2 docs require CMPL session)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_completion_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchInactiveWellStatus(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw = input.api_number      ? String(input.api_number).trim()      : ctx.api_numbers[0] ?? null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : ctx.operator_number ?? null;
  const leaseType = (input.lease_type as string | undefined) ?? "O";

  try {
    if (apiRaw) {
      const split = splitApi(apiRaw);
      if (!split) return { ok: false, data: { error: "Invalid API format" }, summary: "fetch_inactive_well_status: invalid API" };

      const html = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.apiNoPrefixArg": split.prefix,
          "searchArgs.apiNoSuffixArg": split.suffix,
          "methodToCall": "search",
        }),
      });

      const text = extractText(html, 1000);
      const hasError = text.includes("No results found") || text.includes("Ewa_117");
      const rows = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|Inactive|Lease|Operator|Aging/i));
      const dataRows = headerIdx >= 0 ? cleanRows.slice(headerIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r)) : [];
      const isInactive = dataRows.length > 0 && !hasError;

      return {
        ok: true,
        data: {
          api_number: `42-${split.prefix}-${split.suffix}`,
          is_inactive: isInactive,
          inactive_record_count: dataRows.length,
          records: dataRows.slice(0, 5),
          interpretation: isInactive
            ? "Well appears on the TRRC Inactive Well Aging Report (IWAR). Plugging liability risk."
            : "Well is NOT on the IWAR inactive well list.",
          trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do?searchArgs.apiNoPrefixArg=${split.prefix}&searchArgs.apiNoSuffixArg=${split.suffix}&methodToCall=search`,
        },
        summary: `fetch_inactive_well_status: API 42-${split.prefix}-${split.suffix} — ${isInactive ? `INACTIVE (${dataRows.length} record(s))` : "not on inactive list"}`,
      };
    }

    if (opNo) {
      const html = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.operatorNumbersArg": opNo,
          "searchArgs.leaseTypeArg": leaseType,
          "methodToCall": "search",
        }),
      });
      const rows = extractTableRows(html);
      const cleanRows = rows.filter(r => !isNoiseRow(r));
      const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|Lease|Operator|Aging/i));
      const dataRows = headerIdx >= 0 ? cleanRows.slice(headerIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r)) : [];
      return {
        ok: true,
        data: {
          operator_number: opNo,
          lease_type: leaseType,
          inactive_well_count: dataRows.length,
          wells: dataRows.slice(0, 20),
          trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/inactiveWellQueryAction.do?searchArgs.operatorNumbersArg=${opNo}&methodToCall=search`,
        },
        summary: `fetch_inactive_well_status: operator ${opNo} — ${dataRows.length} inactive well(s)`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_inactive_well_status: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_inactive_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchPluggingRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;

  // The EWA pluggingQueryAction.do endpoint returns HTTP 500 (not publicly accessible).
  // Plugging status can be inferred from:
  //   1. The wellbore status — if well_type is "AB" (Abandoned) or "PP" (Partial Plug), it's plugged.
  //   2. The inactive well query — P5 renewal status includes plugging liability.
  // Note these identifiers for the report.
  return {
    ok: true,
    data: {
      api_number: apiRaw,
      lease_number: leaseNo,
      endpoint_available: false,
      message: "TRRC EWA pluggingQueryAction.do is not publicly accessible. " +
        "Plugging status should be inferred from the well type in the wellbore query " +
        "(well_type AB = Abandoned, PP = Partial Plug) and from the inactive well aging report. " +
        "For verified plugging records, review the W-3C plugging report at https://www.rrc.texas.gov directly.",
      data_gap: true,
      trrc_source_url: "https://www.rrc.texas.gov/oil-and-gas/applications-and-permits/drilling-permits/plugging-records/",
    },
    summary: `fetch_plugging_records: endpoint not accessible — infer from wellbore well_type and IWAR records`,
  };
}

async function toolFetchP4Records(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;
  const dist    = input.district     ? String(input.district).trim()     : ctx.district ?? null;

  // The EWA p4QueryAction.do endpoint returns HTTP 500 (not publicly accessible).
  // P-4 production test data (tested rate, allowable, gatherer) is not available statlessly.
  // The oil proration query (oilProQueryAction.do) provides the current ALLOWABLE which is
  // related to P-4 test data. Use that as the best available proxy.
  return {
    ok: true,
    data: {
      api_number: apiRaw,
      lease_number: leaseNo,
      district: dist,
      endpoint_available: false,
      message: "TRRC EWA p4QueryAction.do is not publicly accessible statlessly. " +
        "P-4 production test records (tested rate, allowable) are reflected in the oil proration " +
        "schedule retrieved by fetch_proration. Use that data to assess production test results. " +
        "For full P-4 records, access the TRRC EWA directly with a browser session.",
      data_gap: true,
      trrc_source_url: "https://www.rrc.texas.gov/oil-and-gas/research-and-statistics/",
    },
    summary: `fetch_p4_records: endpoint not accessible — use proration data as proxy for P-4 tested rates`,
  };
}

async function toolFetchWellStatus(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : ctx.api_numbers[0] ?? null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : ctx.lease_number ?? null;
  const dist    = input.district     ? String(input.district).trim()     : ctx.district ?? null;

  // wellStatusQueryAction.do returns HTTP 500 (not publicly accessible).
  // Use wellboreQueryAction.do instead — it returns on_schedule and well_type fields
  // which encode the same well status information.
  try {
    let html: string;
    let label: string;
    if (apiNum) {
      const split = splitApi(apiNum);
      if (!split) return { ok: false, data: { error: "Invalid API number format" }, summary: "fetch_well_status: invalid API" };
      html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.apiNoPrefixArg": split.prefix,
          "searchArgs.apiNoSuffixArg": split.suffix,
          "searchArgs.scheduleTypeArg": "Both",
          "methodToCall": "search",
        }),
      });
      label = apiNum;
    } else if (leaseNo && dist) {
      html = await fetchHtml(`${EWA_BASE}/wellboreQueryAction.do`, {
        method: "POST",
        body: formBody({
          "searchArgs.leaseNumberArg": leaseNo,
          "searchArgs.districtCodeArg": dist,
          "searchArgs.scheduleTypeArg": "Both",
          "methodToCall": "search",
        }),
      });
      label = `Lease ${leaseNo} District ${dist}`;
    } else {
      return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_well_status: missing input" };
    }

    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const hIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, /API|District|Lease|Operator/i));
    const header = hIdx >= 0 ? cleanRows[hIdx] : null;
    const dataRows = hIdx >= 0
      ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r))
      : [];
    const wellbores = header
      ? dataRows.map(row => {
          const obj: Record<string, string> = {};
          header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
          return obj;
        }).slice(0, 21)
      : [];
    const wellStatusSplit = apiNum ? splitApi(apiNum) : null;
    const wellStatusUrl = wellStatusSplit
      ? `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.apiNoPrefixArg=${wellStatusSplit.prefix}&searchArgs.apiNoSuffixArg=${wellStatusSplit.suffix}&searchArgs.scheduleTypeArg=Both&methodToCall=search`
      : leaseNo && dist
      ? `https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do?searchArgs.leaseNumberArg=${leaseNo}&searchArgs.districtCodeArg=${dist}&searchArgs.scheduleTypeArg=Both&methodToCall=search`
      : "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do";
    return {
      ok: true,
      data: {
        identifier: label,
        count: dataRows.length,
        wellbores,
        note: "Well status derived from wellbore query (on_schedule, well_type columns). wellStatusQueryAction.do is not publicly accessible.",
        trrc_source_url: wellStatusUrl,
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
    const split = splitApi(apiNum);
    if (!split) return { ok: false, data: { error: "Invalid API number format" }, summary: "fetch_orphan_well: invalid API" };
    const digits = apiNum.replace(/\D/g, "").slice(0, 10);
    const html = await fetchHtml(`${EWA_BASE}/orphanWellQueryAction.do`, {
      method: "POST",
      body: formBody({
        "searchArgs.apiNoPrefixArg": split.prefix,
        "searchArgs.apiNoSuffixArg": split.suffix,
        "methodToCall": "search",
      }),
    });
    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const headerIdx = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|Orphan|Operator|District|Lease|County/i));
    const dataRows = headerIdx >= 0
      ? cleanRows.slice(headerIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r))
      : [];
    // Only flag orphan if data rows contain actual records (first cell resembles an API number or operator number)
    const isOrphan = dataRows.some(r => /^\d{2,}/.test((r[0] ?? "").trim()));

    return {
      ok: true,
      data: {
        api_number: digits,
        is_orphan: isOrphan,
        count: dataRows.length,
        records: dataRows.slice(0, 6),
      },
      summary: `fetch_orphan_well: API ${digits} — ${isOrphan ? `ORPHAN (${dataRows.length} record(s))` : "not on orphan list"}`,
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

  // severanceQueryAction.do uses lease/district identifiers, not raw API number
  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    let label: string;
    if (leaseNo && dist) {
      params["searchArgs.leaseNumberArg"] = leaseNo;
      params["searchArgs.districtCodeArg"] = dist;
      params["searchArgs.leaseTypeArg"] = leaseType.toUpperCase() === "G" ? "G" : "O";
      label = `Lease ${leaseNo} District ${dist}`;
    } else if (opNo) {
      params["searchArgs.operatorNumbersArg"] = opNo;
      label = `Operator ${opNo}`;
    } else {
      return { ok: false, data: { error: "Provide (lease_number + district) or operator_number" }, summary: "fetch_severance_records: missing input" };
    }

    const html = await fetchHtml(`${EWA_BASE}/severanceQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const hIdx = cleanRows.findIndex(r => isHeaderRow(r, 2, /API|District|Lease|Operator|Severance|County/i));
    const header = hIdx >= 0 ? cleanRows[hIdx] : null;
    const dataRows = hIdx >= 0
      ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r))
      : [];
    const records = header
      ? dataRows.map(row => {
          const obj: Record<string, string> = {};
          header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
          return obj;
        }).slice(0, 11)
      : dataRows.slice(0, 11);

    const severanceUrl = leaseNo && dist
      ? `https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do?searchArgs.leaseNumberArg=${leaseNo}&searchArgs.districtCodeArg=${dist}&searchArgs.leaseTypeArg=${(leaseType.toUpperCase() === "G" ? "G" : "O")}&methodToCall=search`
      : opNo
      ? `https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do?searchArgs.operatorNumbersArg=${opNo}&methodToCall=search`
      : "https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do";
    return {
      ok: true,
      data: { identifier: label, count: dataRows.length, records, trrc_source_url: severanceUrl },
      summary: `fetch_severance_records: ${label} — ${dataRows.length} record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_severance_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchComplianceViolations(_input: Record<string, unknown>, _ctx: AgentContext): Promise<ToolResult> {
  // violationQueryAction.do returns HTTP 500 (not publicly accessible statlessly).
  // Compliance violations must be looked up directly in the TRRC EWA with a browser session.
  return {
    ok: true,
    data: {
      endpoint_available: false,
      message: "TRRC EWA violationQueryAction.do is not publicly accessible statlessly (returns HTTP 500). " +
        "Compliance violation history cannot be retrieved programmatically. " +
        "For operator compliance records, visit https://www.rrc.texas.gov/compliance-enforcement/ directly " +
        "or use the TRRC EWA with a browser session. Note this as a data gap in your report.",
      data_gap: true,
      trrc_source_url: "https://www.rrc.texas.gov/compliance-enforcement/",
    },
    summary: "fetch_compliance_violations: endpoint not accessible — manual review required via TRRC EWA browser session",
  };
}

async function toolFetchProration(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw    = input.api_number   ? String(input.api_number).trim()   : (ctx.api_numbers[0] ?? null);
  const leaseNo   = input.lease_number ? String(input.lease_number).trim() : (ctx.lease_number ?? null);
  const leaseType = (input.lease_type as string | undefined) ?? "oil";
  const distCode  = input.district     ? String(input.district).trim()     : (ctx.district ?? "");

  // prorationQueryAction.do does not exist. Use oilProQueryAction.do (oil) or gasProQueryAction.do (gas).
  // These endpoints use apiPrefixArg/apiSuffixArg (NOT apiNoPrefixArg/apiNoSuffixArg).
  // They return proration ALLOWABLE schedules, not monthly production history.
  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    let label: string;

    if (apiRaw) {
      const split = splitApi(apiRaw);
      if (!split) return { ok: false, data: { error: "Invalid API number format" }, summary: "fetch_proration: invalid API" };
      params["searchArgs.apiPrefixArg"]  = split.prefix;
      params["searchArgs.apiSuffixArg"]  = split.suffix;
      if (distCode) params["searchArgs.districtCodeArg"] = distCode;
      label = apiRaw;
    } else if (leaseNo && distCode) {
      params["searchArgs.leaseNumberArg"] = leaseNo;
      params["searchArgs.districtCodeArg"] = distCode;
      params["searchArgs.leaseTypeArg"]    = leaseType === "gas" ? "G" : "O";
      label = `Lease ${leaseNo} District ${distCode}`;
    } else {
      return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_proration: missing input" };
    }

    const endpoint = leaseType === "gas" ? "gasProQueryAction.do" : "oilProQueryAction.do";
    const html = await fetchHtml(`${EWA_BASE}/${endpoint}`, { method: "POST", body: formBody(params) });

    // Build a deep-link URL using the same params we sent
    const proEndpointName = leaseType === "gas" ? "gasProQueryAction.do" : "oilProQueryAction.do";
    const proQueryString = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const prorationSourceUrl = `https://webapps2.rrc.texas.gov/EWA/${proEndpointName}?${proQueryString}`;

    // Detect error page — EWA returns form validation page when params are invalid
    if (/Please\s+[Cc]orrect/i.test(html) || /errors?\s+list/i.test(html)) {
      return {
        ok: true,
        data: {
          identifier: label,
          lease_type: leaseType,
          found: false,
          count: 0,
          records: [],
          important_note: "No proration records found. EWA returned form validation page — search criteria did not match any records.",
          trrc_source_url: prorationSourceUrl,
        },
        summary: `fetch_proration: ${label} (${leaseType}) — 0 proration record(s) (no match)`,
      };
    }

    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    const proKw = /API|District|Lease|Operator|Potential|Allowable|Daily|Schedule/i;
    const hIdx = cleanRows.findIndex(r => isHeaderRow(r, 3, proKw));
    const header = hIdx >= 0 ? cleanRows[hIdx] : null;
    const dataRows = hIdx >= 0
      ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 3 && !isNoiseRow(r))
      : [];
    const records = header
      ? dataRows.map(row => {
          const obj: Record<string, string> = {};
          header.forEach((h, i) => { obj[h.toLowerCase().replace(/[^a-z0-9]+/g, "_")] = row[i] ?? ""; });
          return obj;
        }).slice(0, 11)
      : [];

    return {
      ok: true,
      data: {
        identifier: label,
        lease_type: leaseType,
        district: distCode,
        count: records.length,
        records,
        important_note: "This is PRORATION ALLOWABLE data (permitted schedule), not monthly production history. Monthly production history is not accessible via stateless EWA queries.",
        trrc_source_url: prorationSourceUrl,
      },
      summary: `fetch_proration: ${label} (${leaseType}) — ${records.length} proration record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_proration: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchInjectionRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : (ctx.api_numbers[0] ?? null);
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  // injectionQueryAction.do does not exist. Use uicQueryAction.do for UIC/injection well records.
  // Field names: apiNoPrefixArg / apiNoSuffixArg (same as wellbore query)
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
    const rows = extractTableRows(html);
    const cleanRows = rows.filter(r => !isNoiseRow(r));
    // UIC table header contains "UIC No." and "API No."
    const uicKw = /UIC|API|Lease|Operator|County|District|Permit|Well\s+No/i;
    const hIdx = cleanRows.findIndex(r => isHeaderRow(r, 2, uicKw));
    const header = hIdx >= 0 ? cleanRows[hIdx] : null;
    const dataRows = hIdx >= 0
      ? cleanRows.slice(hIdx + 1).filter(r => r.length >= 2 && !isNoiseRow(r) && !/^Links\s+Images/i.test(r.join(" ")))
      : [];

    // UIC records often span two <tr> rows: row1 = UIC permit + API, row2 = lease number + nav links
    // Merge continuation rows (rows where col 0 looks like a lease number, not a UIC permit number)
    const mergedRows: Array<Record<string, string>> = [];
    if (header) {
      for (const row of dataRows) {
        const cell0 = (row[0] ?? "").trim();
        // A UIC permit number is a long zero-padded number like "000042442"
        // A lease number is a shorter number like "10289"
        // If cell0 is a short number (≤6 digits) and we already have a merged record, attach as lease
        const isLeaseContinuation = /^\d{1,6}$/.test(cell0) && mergedRows.length > 0 &&
          !mergedRows[mergedRows.length - 1]["lease_no"];
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

    // Seed context with lease number from UIC data (injection wells often have lease # here)
    if (records.length > 0) {
      const firstRec = records[0];
      const uicLease = firstRec["lease_no"] ?? firstRec["lease_no_"] ?? firstRec["lease"] ?? "";
      if (!ctx.lease_number && uicLease && /^\d+$/.test(uicLease.trim())) {
        ctx.lease_number = uicLease.trim();
      }
      const uicCounty = firstRec["county"] ?? "";
      if (!ctx.county && uicCounty) ctx.county = uicCounty;
    }

    const uicQueryString = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return {
      ok: true,
      data: {
        identifier: label,
        count: records.length,
        records,
        note: records.length === 0 ? "No UIC/injection records found for this API." : undefined,
        trrc_source_url: `https://webapps2.rrc.texas.gov/EWA/uicQueryAction.do?${uicQueryString}`,
      },
      summary: `fetch_injection_records: ${label} — ${records.length} UIC injection record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_injection_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchImagedRecords(_input: Record<string, unknown>, _ctx: AgentContext): Promise<ToolResult> {
  // The TRRC CMPL system (publicCmplQueryAction.do) returns HTTP 404.
  // Imaged scanned records (W-2, G-1, P-12, etc.) are not accessible via stateless HTTP.
  // They require a direct browser session at https://www.rrc.texas.gov/resource-center/research/online-research-queries/
  return {
    ok: true,
    data: {
      endpoint_available: false,
      message: "TRRC CMPL imaged document system (publicCmplQueryAction.do) is not publicly accessible (returns HTTP 404). " +
        "Scanned well records (W-2 completions, G-1 gas well completions, P-12 plugging, etc.) require " +
        "direct access at https://www.rrc.texas.gov/resource-center/research/online-research-queries/ " +
        "Note this as a data gap. Key document types to flag for manual review: W-2 completion report, G-1 completion report.",
      data_gap: true,
      trrc_source_url: "https://www.rrc.texas.gov/resource-center/research/online-research-queries/",
    },
    summary: "fetch_imaged_records: CMPL endpoint not accessible — manual document retrieval required",
  };
}

function toolSubmitReport(_input: Record<string, unknown>, _ctx: AgentContext): ToolResult {
  // Not used in the direct orchestrator — kept for dispatchTool compatibility
  return { ok: true, data: { submitted: true }, summary: "submit_report: not used in direct orchestration mode" };
}

// ─── Tool dispatcher ─────────────────────────────────────────────────────────

async function dispatchTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  switch (toolName) {
    case "search_by_api":             return toolSearchByApi(toolInput, ctx);
    case "search_by_lease":           return toolSearchByLease(toolInput, ctx);
    case "search_by_operator":        return toolSearchByOperator(toolInput, ctx);
    case "search_by_legal_description": return toolSearchByLegalDescription(toolInput, ctx);
    case "fetch_production":          return toolFetchProduction(toolInput, ctx);
    case "fetch_completion_records":  return toolFetchCompletionRecords(toolInput, ctx);
    case "fetch_inactive_well_status": return toolFetchInactiveWellStatus(toolInput, ctx);
    case "fetch_plugging_records":    return toolFetchPluggingRecords(toolInput, ctx);
    case "fetch_p4_records":          return toolFetchP4Records(toolInput, ctx);
    case "fetch_well_status":         return toolFetchWellStatus(toolInput, ctx);
    case "fetch_orphan_well":         return toolFetchOrphanWell(toolInput, ctx);
    case "fetch_severance_records":   return toolFetchSeveranceRecords(toolInput, ctx);
    case "fetch_compliance_violations": return toolFetchComplianceViolations(toolInput, ctx);
    case "fetch_proration":           return toolFetchProration(toolInput, ctx);
    case "fetch_injection_records":   return toolFetchInjectionRecords(toolInput, ctx);
    case "fetch_imaged_records":      return toolFetchImagedRecords(toolInput, ctx);
    case "submit_report":             return toolSubmitReport(toolInput, ctx);
    default:
      return { ok: false, data: { error: `Unknown tool: ${toolName}` }, summary: `Unknown tool: ${toolName}` };
  }
}


// ─── Coverage builder ─────────────────────────────────────────────────────────

interface CoverageEntry {
  category: string;
  label: string;
  status: "complete" | "partial" | "retrieval_failed" | "manual_required" | "no_applicable_record" | "not_checked";
  records_found: number;
  data_current_through: string | null;
  sources_checked: string[];
  notes: string | null;
}

const TOOL_COVERAGE_MAP: Record<string, { category: string; label: string }> = {
  search_by_api:             { category: "wellbore_identity",  label: "Well Identity (API Lookup)" },
  search_by_lease:           { category: "lease_inventory",    label: "Lease Inventory" },
  search_by_operator:        { category: "operator_p5",        label: "Operator / P5 Organization" },
  search_by_legal_description:{ category: "legal_description", label: "Legal Description (GIS)" },
  fetch_production:          { category: "production",         label: "Production History (Proration Proxy)" },
  fetch_completion_records:  { category: "completion",         label: "Completion Records (W-2)" },
  fetch_well_status:         { category: "well_status",        label: "Well Status (Active/Inactive/Plugged)" },
  fetch_inactive_well_status:{ category: "inactive_well",      label: "Inactive Well Aging Report (IWAR)" },
  fetch_orphan_well:         { category: "orphan_well",        label: "Orphan Well / P5 Insolvent Operator" },
  fetch_plugging_records:    { category: "plugging",           label: "Plugging Records (W-3C)" },
  fetch_compliance_violations:{ category: "compliance",        label: "Compliance Violations" },
  fetch_p4_records:          { category: "p4_records",         label: "P-4 Production Test Records" },
  fetch_proration:           { category: "proration",          label: "Proration Schedule / Daily Allowable" },
  fetch_injection_records:   { category: "injection",          label: "UIC / Injection Well Records" },
  fetch_severance_records:   { category: "severance",          label: "Wellbore Severance Records" },
  fetch_imaged_records:      { category: "imaged_records",     label: "Imaged Document Packets (CMPL)" },
};

function buildCoverageFromAttempts(
  attempts: Array<{ source_name: string; status: string; result_count: number; result_data_json?: unknown }>,
): CoverageEntry[] {
  const coverage: CoverageEntry[] = [];
  const seen = new Set<string>();

  for (const attempt of attempts) {
    const toolName = attempt.source_name;
    if (toolName === "submit_report") continue;
    const meta = TOOL_COVERAGE_MAP[toolName];
    if (!meta) continue;
    if (seen.has(meta.category)) continue; // first call per category wins
    seen.add(meta.category);

    const data = (attempt.result_data_json ?? {}) as Record<string, unknown>;
    const isDataGap = data["data_gap"] === true || data["endpoint_available"] === false;
    const found = data["found"];
    const recordCount = attempt.result_count;

    let status: CoverageEntry["status"];
    let notes: string | null = null;

    if (attempt.status === "failed_transient" || attempt.status === "failed_permanent") {
      status = "retrieval_failed";
      notes = (data["error"] ? String(data["error"]).slice(0, 120) : "Query failed.");
    } else if (isDataGap) {
      status = "manual_required";
      notes = "Automated access unavailable — manual review required via TRRC EWA.";
    } else if (found === false) {
      status = "no_applicable_record";
      notes = String(data["message"] ?? "No records found for this query.").slice(0, 120);
    } else {
      status = recordCount > 0 ? "complete" : "partial";
      notes = recordCount > 0 ? `${recordCount} record(s) retrieved.` : "Query succeeded but returned 0 rows.";
    }

    coverage.push({
      category: meta.category,
      label: meta.label,
      status,
      records_found: recordCount,
      data_current_through: new Date().toISOString().slice(0, 10),
      sources_checked: [toolName],
      notes,
    });
  }

  // Add "not_checked" entries for any tool in the map that was never called
  for (const [toolName, meta] of Object.entries(TOOL_COVERAGE_MAP)) {
    if (!seen.has(meta.category)) {
      coverage.push({
        category: meta.category,
        label: meta.label,
        status: "not_checked",
        records_found: 0,
        data_current_through: null,
        sources_checked: [],
        notes: `Tool ${toolName} was not called during this run.`,
      });
    }
  }

  return coverage;
}

// ─── Retrieval orchestrator ───────────────────────────────────────────────────

async function runRetrieval(runId: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // 1. Load run row
  const { data: runRaw, error: runErr } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (runErr || !runRaw) {
    console.error(`[trrc-dd-execute] run not found: ${runId}`, runErr);
    return;
  }

  // 2. Build initial context from run row and resolved entities
  const ctx: AgentContext = {
    api_numbers: [],
    district: null,
    lease_number: null,
    operator_name: null,
    operator_number: null,
    county: null,
    production: [],
    agentReport: null,
  };

  const resolvedApi = String(runRaw["resolved_primary_api"] ?? "").replace(/\D/g, "").slice(0, 10);
  if (resolvedApi.length >= 10) ctx.api_numbers.push(resolvedApi);
  if (runRaw["resolved_lease_number"]) ctx.lease_number = String(runRaw["resolved_lease_number"]);
  if (runRaw["resolved_district"]) ctx.district = String(runRaw["resolved_district"]);

  const { data: entityRows } = await supabase
    .from("trrc_resolved_entities")
    .select("*")
    .eq("run_id", runId);

  for (const e of (entityRows ?? [])) {
    if (e["entity_type"] === "wellbore") {
      const api = String(e["canonical_identifier"] ?? "");
      if (api && !ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
      if (!ctx.district && e["attributes_json"]?.["district"]) ctx.district = String(e["attributes_json"]["district"]);
    } else if (e["entity_type"] === "lease") {
      if (!ctx.lease_number && e["attributes_json"]?.["lease_number"]) ctx.lease_number = String(e["attributes_json"]["lease_number"]);
      if (!ctx.district && e["attributes_json"]?.["district"]) ctx.district = String(e["attributes_json"]["district"]);
    } else if (e["entity_type"] === "operator") {
      if (!ctx.operator_name && e["attributes_json"]?.["normalized_name"]) ctx.operator_name = String(e["attributes_json"]["normalized_name"]);
      if (!ctx.operator_number && e["attributes_json"]?.["operator_number"]) ctx.operator_number = String(e["attributes_json"]["operator_number"]);
    }
  }

  // 3. Retrieval plan — executed sequentially, each step seeds ctx for the next
  type ToolStep = { name: string; input: () => Record<string, unknown> };

  const steps: ToolStep[] = [
    { name: "search_by_api",              input: () => ({ api_number: ctx.api_numbers[0] ?? resolvedApi }) },
    { name: "search_by_lease",            input: () => ({ lease_number: ctx.lease_number ?? "", district: ctx.district ?? "" }) },
    { name: "search_by_operator",         input: () => ({ operator_name: ctx.operator_name ?? null, operator_number: ctx.operator_number ?? null }) },
    { name: "search_by_legal_description",input: () => ({ county: ctx.county }) },
    { name: "fetch_production",           input: () => ({}) },
    { name: "fetch_completion_records",   input: () => ({}) },
    { name: "fetch_well_status",          input: () => ({ api_number: ctx.api_numbers[0] ?? null, lease_number: ctx.lease_number, district: ctx.district }) },
    { name: "fetch_inactive_well_status", input: () => ({ api_number: ctx.api_numbers[0] ?? null }) },
    { name: "fetch_orphan_well",          input: () => ({ api_number: ctx.api_numbers[0] ?? null }) },
    { name: "fetch_plugging_records",     input: () => ({}) },
    { name: "fetch_compliance_violations",input: () => ({}) },
    { name: "fetch_p4_records",           input: () => ({}) },
    { name: "fetch_proration",            input: () => ({}) },
    { name: "fetch_injection_records",    input: () => ({}) },
    { name: "fetch_severance_records",    input: () => ({}) },
    { name: "fetch_imaged_records",       input: () => ({}) },
  ];

  const allAttempts: Array<{ source_name: string; status: string; result_count: number; result_data_json: unknown }> = [];

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Skip steps that can't produce useful results
      if (step.name === "search_by_api" && !ctx.api_numbers[0] && !resolvedApi) continue;
      if (step.name === "search_by_lease" && !ctx.lease_number) continue;
      if (step.name === "search_by_operator" && !ctx.operator_name && !ctx.operator_number) continue;

      const result = await dispatchTool(step.name, step.input(), ctx);
      console.log(`[trrc-dd-execute] [${runId}] ${step.name}: ${result.summary}`);

      const resultData = result.data as Record<string, unknown>;
      const resultCount = Array.isArray(resultData?.["wellbores"])
        ? (resultData["wellbores"] as unknown[]).length
        : Array.isArray(resultData?.["records"])
        ? (resultData["records"] as unknown[]).length
        : resultData?.["found"] === true ? 1 : 0;

      await supabase.from("trrc_source_attempts").upsert({
        run_id: runId,
        source_id: `${step.name}_1`,
        source_name: step.name,
        status: result.ok ? "success" : "failed_transient",
        result_count: resultCount,
        error_message: result.ok ? null : String(resultData?.["error"] ?? ""),
        attempted_at: new Date().toISOString(),
        result_data_json: result.data,
      }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).then(null, () => {});

      allAttempts.push({ source_name: step.name, status: result.ok ? "success" : "failed_transient", result_count: resultCount, result_data_json: result.data });

      const progress = Math.min(90, 5 + Math.round((i + 1) / steps.length * 85));
      await supabase.from("trrc_due_diligence_runs")
        .update({ progress_percent: progress, updated_at: new Date().toISOString() })
        .eq("id", runId);
    }
  } catch (err) {
    console.error(`[trrc-dd-execute] [${runId}] retrieval error:`, err);
    await supabase.from("trrc_due_diligence_runs").update({
      status: "failed",
      error_summary: err instanceof Error ? err.message : String(err),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", runId);
    return;
  }

  // 4. Persist production rows collected by toolFetchProduction
  if (ctx.production.length > 0) {
    const seen = new Set<string>();
    const prodRows = ctx.production
      .filter(raw => {
        const year = Number(raw["year"]);
        const month = Number(raw["month"]);
        if (!year || !month) return false;
        const key = `${ctx.lease_number ?? ""}:${ctx.district ?? ""}:${year}-${String(month).padStart(2, "0")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(raw => ({
        run_id: runId,
        entity_type: "lease",
        api_number: ctx.api_numbers[0] ?? null,
        district: ctx.district ?? "",
        lease_number: ctx.lease_number ?? null,
        gas_id: null,
        operator_number: ctx.operator_number ?? null,
        production_month: `${Number(raw["year"])}-${String(Number(raw["month"])).padStart(2, "0")}`,
        oil_bbl: typeof raw["oil_bbl"] === "number" ? raw["oil_bbl"] : null,
        casinghead_gas_mcf: null,
        gas_mcf: typeof raw["gas_mcf"] === "number" ? raw["gas_mcf"] : null,
        condensate_bbl: null,
        water_bbl: typeof raw["water_bbl"] === "number" ? raw["water_bbl"] : null,
      }));

    if (prodRows.length > 0) {
      await supabase.from("trrc_production_monthly").upsert(prodRows, {
        onConflict: "run_id,entity_type,api_number,lease_number,production_month",
        ignoreDuplicates: true,
      }).then(null, () => {});
    }
  }

  // 5. Build coverage summary
  const coverageJson = buildCoverageFromAttempts(allAttempts);

  // 6. Mark run complete
  const successCount = allAttempts.filter(a => a.status === "success").length;
  const { error: updateErr } = await supabase.from("trrc_due_diligence_runs").update({
    status: "complete",
    progress_percent: 100,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    resolved_primary_api: ctx.api_numbers[0] ?? null,
    resolved_district: ctx.district,
    resolved_lease_number: ctx.lease_number,
    resolved_operator_number: ctx.operator_number,
    coverage_json: coverageJson,
    result_summary: `${successCount} of ${steps.length} sources retrieved successfully.`,
  }).eq("id", runId);

  if (updateErr) {
    console.error("[trrc-dd-execute] final update error:", updateErr);
  } else {
    console.log(`[trrc-dd-execute] [${runId}] complete — ${successCount}/${steps.length} sources`);
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
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

  // Fire and forget via EdgeRuntime.waitUntil (keeps function alive after response)
  const work = runRetrieval(runId);

  // @ts-ignore - Deno/Supabase EdgeRuntime global
  if (typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  } else {
    // Local dev — await inline
    await work;
  }

  return new Response(JSON.stringify({ ok: true, run_id: runId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
