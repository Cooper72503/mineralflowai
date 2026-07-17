/**
 * Supabase Edge Function: trrc-dd-execute
 *
 * Runs the full TRRC Fable-5 agent investigation as a background job,
 * eliminating the Vercel 300s timeout constraint.
 *
 * POST body: { run_id: string }
 *
 * The function immediately returns HTTP 200 and runs the agent via
 * EdgeRuntime.waitUntil(), so the HTTP response is sent before the work begins.
 */

import Anthropic from "npm:@anthropic-ai/sdk@latest";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─── Deno serve shim ─────────────────────────────────────────────────────────

// Supabase Edge Functions use Deno.serve under the hood.
// The npm:serve package is not needed — just export a handler via Deno.serve.

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_CALLS = 120;
const WRAP_UP_THRESHOLD = 90; // warn agent to submit_report after this many tool calls

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentFinding {
  category: string;
  severity: string;
  title: string;
  detail: string;
  source_ids: string[];
}

interface AgentScorecardDimension {
  id: string;
  name: string;
  score: number;
  weight: number;
  key_finding: string;
}

interface AgentScorecard {
  overall_score: number;
  dimensions: AgentScorecardDimension[];
}

interface AgentReport {
  recommendation: string;
  recommendation_rationale: string;
  executive_summary: string[];
  findings: AgentFinding[];
  scorecard: AgentScorecard;
  production_summary: {
    total_months: number;
    avg_monthly_oil_bbl: number;
    avg_monthly_gas_mcf: number;
    last_production_date: string | null;
    trend: "declining" | "flat" | "increasing" | "insufficient_data";
  } | null;
  data_gaps: string[];
}

interface AgentContext {
  api_numbers: string[];
  district: string | null;
  lease_number: string | null;
  operator_name: string | null;
  operator_number: string | null;
  county: string | null;
  production: ProductionRow[];
  agentReport: AgentReport | null;
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

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are the MineralFlowAI RRC Due Diligence Agent. Your sole job is to execute a structured due diligence data pull from the Texas Railroad Commission (TRRC) for an oil or gas well asset. You have access to 17 tools. You MUST call all 16 data-pull tools before calling submit_report. You MUST NOT call submit_report until every prior tool has returned a result.

---

STEP 1 — RESOLVE IDENTIFIERS

The user will provide one of the following: an API number, an operator name, or a lease number. Your first action depends on what was provided:

- If given an API number → call search_by_api first. Extract: API number, district, lease number, operator name, operator number, well type.
- If given a lease number → call search_by_lease first. Extract: all API numbers on the lease, district, operator name, operator number.
- If given an operator name → call search_by_operator first. Extract: operator number, then call search_by_lease to get all associated leases and API numbers.

After Step 1, you must have: API number(s), district, lease number, operator number.
Do NOT proceed to Step 2 until all four identifiers are confirmed.

---

STEP 2 — EXECUTE ALL 16 DATA-PULL TOOLS IN ORDER

Call every tool below in sequence. Do NOT skip any tool. Do NOT call submit_report yet.

For each tool, if the result is empty or the well type makes the query not applicable (e.g., injection query on a non-injection well), record the result as "Not Applicable — [reason]" and immediately proceed to the next tool. An empty result is NOT an error. Do not retry. Continue to the next tool.

Tool execution order:
1. search_by_api — Identity, district, lease, operator, well type
2. search_by_lease — All wells on the lease, co-mingled production flag
3. search_by_operator — Operator organization record, bond status, P5
4. search_by_legal_description — Legal description, survey, abstract, section
5. fetch_production — Full monthly oil/gas/water production history
6. fetch_completion_records — W-2 completion record: formation, depth, casing
7. fetch_well_status — Current status: active / inactive / plugged
8. fetch_inactive_well_status — Inactive well list entry (if applicable)
9. fetch_orphan_well — Orphan well / state-plugging liability (if applicable)
10. fetch_plugging_records — Plugging records (if plugged or partially plugged)
11. fetch_compliance_violations — All open and historical compliance violations
12. fetch_p4_records — P-4 production test records
13. fetch_proration — Proration schedule and allowable constraints
14. fetch_injection_records — UIC / SWD / injection permit (if applicable)
15. fetch_severance_records — Wellbore severance records (if applicable)
16. fetch_imaged_records — Post-2009 imaged completion document packets

---

STEP 3 — COMPILE AND SUBMIT

Only after ALL 16 tools above have returned a result (even if "Not Applicable") compile the full report and call submit_report.

The report must include a result entry for every one of the 16 tools above.
Any tool that returned data must include the key data points extracted.
Any tool that returned empty must be listed as "Not Applicable — [reason]".

The report structure must follow this order:
1. Asset Identification (from tools 1–4)
2. Production History (from tool 5)
3. Well Construction & Completion (from tools 6–10)
4. Compliance & Regulatory (from tools 11–12)
5. Operations (from tools 13–15)
6. Imaged Documents Retrieved (from tool 16)
7. Missing Documents Flag (list any data points that could not be confirmed from any tool)
8. Confidence Score (0–100, based on data completeness and consistency)
9. Recommendation (pursue / review / pass / blocked)

DO NOT call submit_report before this point. DO NOT omit any section.

---

CRITICAL RULES:

- canClaimSingleWellProduction is always false for lease-level production. Never attribute lease production to a single well.
- Empty result ≠ clean record. A zero-violation compliance query may be a failed query — note this explicitly.
- Do not invent or estimate any numbers. Record "Not Applicable" or "Query Failed" for any data you could not retrieve.
- Do not reveal internal tool names in your narrative summary. Use plain English descriptions.
- Scorecard weights must sum to 1.0 exactly.

SCORECARD DIMENSIONS (weights must sum to 1.0):
1. identity_confidence (0.12) — Were identifiers verified in TRRC?
2. production_quality (0.15) — Is there verifiable, recent production?
3. production_consistency (0.13) — Is production trending stable or declining?
4. mechanical_integrity (0.08) — Completion records, wellbore design, depths
5. plugging_exposure (0.10) — Inactive, orphan, or unaddressed plugging liability
6. regulatory_compliance (0.12) — Violations, inspections, enforcement actions
7. operator_profile (0.08) — P5 status, bond, organizational health
8. development_activity (0.07) — Recent completions, permits, injection activity
9. data_confidence (0.05) — Were all queries successful or are there gaps?
10. record_completeness (0.10) — Did we successfully retrieve all relevant record types?
`.trim();

// ─── Tool definitions ─────────────────────────────────────────────────────────

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_by_api",
    description:
      "Look up a well by API number in the TRRC PDQ wellbore database. " +
      "Returns lease number, district code, county, and operator name/number. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number in any format (e.g. '42-165-02733', '4216502733', or '42165027330000')",
        },
      },
      required: ["api_number"],
    },
  },
  {
    name: "search_by_lease",
    description:
      "Look up a lease by RRC lease number. If district is unknown, omit it — the tool will automatically " +
      "search all 12 TRRC districts to discover which one the lease belongs to. " +
      "Returns the lease's district, well inventory (API numbers, statuses), and operator. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "RRC lease number (e.g. '10289', '60509')" },
        district: { type: "string", description: "TRRC district code if known (e.g. '01', '08', '8A'). Omit to auto-discover." },
      },
      required: ["lease_number"],
    },
  },
  {
    name: "search_by_operator",
    description:
      "Look up an operator by name or P5 number. " +
      "Returns operator_number, bond status, organizational status, and P5 record details. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_name: { type: "string", description: "Operator name (partial match supported)" },
        operator_number: { type: "string", description: "TRRC operator number / P5 number if known" },
      },
      required: [],
    },
  },
  {
    name: "search_by_legal_description",
    description:
      "GIS lookup using abstract number, survey name, section, township, and/or range. " +
      "Returns matched API numbers whose surface locations fall within the described parcel. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        abstract_number: { type: "string", description: "Texas abstract number (e.g. 'A-145')" },
        survey_name: { type: "string", description: "Survey name (e.g. 'JOHN SMITH SURVEY')" },
        county: { type: "string", description: "County name (e.g. 'Midland', 'Reeves')" },
        section: { type: "string", description: "Section number if applicable" },
      },
      required: [],
    },
  },
  {
    name: "fetch_production",
    description:
      "Fetch monthly production history (oil bbl, gas MCF, water bbl) from TRRC. " +
      "Preferred: provide lease_number + district. Alternative: provide api_number. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "RRC lease number" },
        district: { type: "string", description: "TRRC district code" },
        api_number: { type: "string", description: "API number (fallback)" },
        months: { type: "number", description: "Months of history (default 36, max 120)" },
      },
      required: [],
    },
  },
  {
    name: "fetch_completion_records",
    description:
      "Fetch W-2 completion packets for one or more API numbers. " +
      "Returns formation name, total depth, completion date, and wellbore profile. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "List of API numbers",
        },
      },
      required: ["api_numbers"],
    },
  },
  {
    name: "fetch_inactive_well_status",
    description:
      "Check if a well is on the TRRC EWA inactive well list. " +
      "Inactive wells represent potential plugging liability. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number to check" },
        operator_number: { type: "string", description: "Operator number — returns all inactive wells for operator" },
        lease_type: { type: "string", enum: ["O", "G"], description: "'O' for oil, 'G' for gas" },
      },
      required: [],
    },
  },
  {
    name: "fetch_plugging_records",
    description:
      "Fetch EWA plugging records by API number or lease. " +
      "Returns plugging date, contractor, depth, and regulatory status. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
        lease_number: { type: "string", description: "Lease number" },
        district: { type: "string", description: "District code (required with lease_number)" },
      },
      required: [],
    },
  },
  {
    name: "fetch_p4_records",
    description:
      "Fetch EWA P-4 production test records by API number or lease. " +
      "Returns test date, allowable, tested rate, and gatherer information. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
        lease_number: { type: "string", description: "Lease number" },
        district: { type: "string", description: "District code (required with lease_number)" },
      },
      required: [],
    },
  },
  {
    name: "fetch_well_status",
    description:
      "Fetch EWA well status (active/inactive/plugged) for an API or all wells on a lease. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
        lease_number: { type: "string", description: "Lease number" },
        district: { type: "string", description: "District code (required with lease_number)" },
      },
      required: [],
    },
  },
  {
    name: "fetch_orphan_well",
    description:
      "Fetch EWA orphan well records for an API number. " +
      "An orphan well is one whose operator has become insolvent — critical liability flag. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number to check for orphan status" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "fetch_severance_records",
    description:
      "Fetch EWA severance records by API number or operator. " +
      "Documents wellbore interval severances — relevant for casing integrity. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
        operator_number: { type: "string", description: "Operator number" },
      },
      required: [],
    },
  },
  {
    name: "fetch_compliance_violations",
    description:
      "Fetch TRRC compliance violations and field inspection records for an operator. " +
      "IMPORTANT: empty result does NOT guarantee clean compliance — it may be a failed query. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_number: { type: "string", description: "TRRC operator number (preferred)" },
        operator_name: { type: "string", description: "Operator name (fallback)" },
        county: { type: "string", description: "County to narrow scope (optional)" },
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "API numbers for well-level inspection records (up to 3)",
        },
      },
      required: [],
    },
  },
  {
    name: "fetch_proration",
    description:
      "Fetch proration schedule records by lease number. " +
      "Proration schedules govern allowable production rates for oil leases. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "RRC lease number" },
        lease_type: { type: "string", enum: ["oil", "gas"], description: "Lease type" },
        district: { type: "string", description: "District code (optional)" },
      },
      required: ["lease_number"],
    },
  },
  {
    name: "fetch_injection_records",
    description:
      "Fetch UIC/injection well records by API number or operator. " +
      "Use if the well may be a disposal or enhanced recovery injection well. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
        operator_number: { type: "string", description: "Operator number" },
      },
      required: [],
    },
  },
  {
    name: "fetch_imaged_records",
    description:
      "Fetch post-2009 CMPL imaged document packets from TRRC for one or more API numbers. " +
      "Returns document type, filing date, and document URLs. " +
      "This tool call is REQUIRED for every report. Do not skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "List of API numbers",
        },
      },
      required: ["api_numbers"],
    },
  },
  {
    name: "submit_report",
    description:
      "Call this tool ONLY after all 16 data-pull tools have been called and returned results. " +
      "Calling this tool early will produce an incomplete report and is not permitted. " +
      "You must have called search_by_api, search_by_lease, search_by_operator, search_by_legal_description, " +
      "fetch_production, fetch_completion_records, fetch_well_status, fetch_inactive_well_status, " +
      "fetch_orphan_well, fetch_plugging_records, fetch_compliance_violations, fetch_p4_records, " +
      "fetch_proration, fetch_injection_records, fetch_severance_records, and fetch_imaged_records " +
      "before calling this tool. Each must have returned a result, even if that result is empty or Not Applicable.",
    input_schema: {
      type: "object" as const,
      properties: {
        recommendation: {
          type: "string",
          enum: ["pursue", "review", "blocked", "pass"],
          description: "Investment recommendation",
        },
        recommendation_rationale: {
          type: "string",
          description: "1-2 sentence rationale based on verified TRRC findings",
        },
        executive_summary: {
          type: "array",
          items: { type: "string" },
          description: "3-5 narrative paragraphs covering the investigation",
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: ["identity", "production", "compliance", "inactive_well", "plugging", "mechanical", "operator", "data_gap"],
              },
              severity: { type: "string", enum: ["critical", "warning", "info"] },
              title: { type: "string" },
              detail: { type: "string" },
              source_ids: { type: "array", items: { type: "string" } },
            },
            required: ["category", "severity", "title", "detail", "source_ids"],
          },
          description: "All findings, ordered by severity (critical first)",
        },
        scorecard: {
          type: "object",
          properties: {
            overall_score: { type: "number", description: "Weighted overall score 0-100" },
            dimensions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  score: { type: "number" },
                  weight: { type: "number" },
                  key_finding: { type: "string" },
                },
                required: ["id", "name", "score", "weight", "key_finding"],
              },
            },
          },
          required: ["overall_score", "dimensions"],
        },
        production_summary: {
          type: "object",
          properties: {
            total_months: { type: "number" },
            avg_monthly_oil_bbl: { type: "number" },
            avg_monthly_gas_mcf: { type: "number" },
            last_production_date: { type: "string" },
            trend: { type: "string", enum: ["declining", "flat", "increasing", "insufficient_data"] },
          },
          required: ["total_months", "avg_monthly_oil_bbl", "avg_monthly_gas_mcf", "last_production_date", "trend"],
        },
        data_gaps: {
          type: "array",
          items: { type: "string" },
          description: "Items that could not be verified and why",
        },
      },
      required: ["recommendation", "recommendation_rationale", "executive_summary", "findings", "scorecard", "data_gaps"],
    },
  },
];

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

  const districtsToTry = distCode
    ? [distCode]
    : ["01", "02", "03", "04", "05", "06", "6E", "7B", "7C", "08", "8A", "09", "10"];

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

async function toolFetchWellStatus(input: Record<string, unknown>, _ctx: AgentContext): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

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

async function toolFetchOrphanWell(input: Record<string, unknown>, _ctx: AgentContext): Promise<ToolResult> {
  const apiNum = String(input.api_number ?? "").trim();
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

function toolSubmitReport(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  ctx.agentReport = {
    recommendation:           String(input.recommendation ?? "review"),
    recommendation_rationale: String(input.recommendation_rationale ?? ""),
    executive_summary:        (input.executive_summary as string[]) ?? [],
    findings:                 (input.findings as AgentFinding[]) ?? [],
    scorecard:                (input.scorecard as AgentScorecard) ?? { overall_score: 0, dimensions: [] },
    production_summary:       (input.production_summary as AgentReport["production_summary"]) ?? null,
    data_gaps:                (input.data_gaps as string[]) ?? [],
  };

  const rec = ctx.agentReport.recommendation.toUpperCase();
  const rationale = ctx.agentReport.recommendation_rationale.slice(0, 80);

  return {
    ok: true,
    data: { submitted: true },
    summary: `submit_report: ${rec} — ${rationale}`,
  };
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

// ─── Initial message builder ──────────────────────────────────────────────────

function buildInitialMessage(
  rawInput: string,
  inputType: string,
  resolvedEntities: Array<{
    entity_type: string;
    canonical_identifier: string;
    display_name: string;
    attributes: Record<string, unknown>;
  }>,
): string {
  const parts: string[] = [
    "Please conduct a complete TRRC public records due diligence investigation on the following input.",
    "",
    "## Raw Input",
    `"${rawInput}"`,
    `Input Type: ${inputType.replace(/_/g, " ").toUpperCase()}`,
    "",
  ];

  if (resolvedEntities.length > 0) {
    parts.push("## Pre-Resolved Entities");
    parts.push("The entity resolver has already identified the following candidates:");
    parts.push("");
    for (const entity of resolvedEntities) {
      parts.push(`- **${entity.display_name}** (${entity.entity_type})`);
      parts.push(`  Canonical ID: ${entity.canonical_identifier}`);
      const attrs = Object.entries(entity.attributes)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      if (attrs) parts.push(`  Attributes: ${attrs}`);
    }
    parts.push("");
  }

  parts.push(
    "## Investigation instructions",
    "1. Confirm identity: use the appropriate search tool to get the canonical API/lease/operator identifiers.",
    "2. Fetch production history directly from TRRC (do not rely on any pre-stated figures).",
    "3. Check well status and plugging records for all API numbers found.",
    "4. Fetch compliance violations for the operator.",
    "5. Note any sources that fail or return no data as explicit data gaps.",
    "6. **STOP and call submit_report.** Once you have completed steps 1–4, you are done gathering data.",
    "   Do not continue fetching more sources. Synthesize what you have and submit immediately.",
    "",
    "Target: 15–35 tool calls total. Call submit_report when you can write a recommendation.",
    "",
    "Begin your investigation now.",
  );

  return parts.join("\n");
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

function mapRecommendation(rec: string): "PURSUE" | "REVIEW" | "PASS" | "BLOCKED" {
  switch (rec.toLowerCase()) {
    case "pursue":  return "PURSUE";
    case "blocked": return "BLOCKED";
    case "pass":    return "PASS";
    default:        return "REVIEW";
  }
}

function mapSeverity(sev: string): "critical" | "high" | "medium" | "low" | "info" {
  switch (sev.toLowerCase()) {
    case "critical": return "critical";
    case "warning":  return "medium";
    case "info":     return "info";
    default:         return "info";
  }
}

function mapCategory(cat: string): string {
  switch (cat.toLowerCase()) {
    case "identity":       return "identity";
    case "production":     return "production";
    case "compliance":     return "compliance";
    case "inactive_well":  return "plugging_inactive";
    case "plugging":       return "plugging_inactive";
    case "mechanical":     return "completion";
    case "operator":       return "operator_p5";
    case "data_gap":       return "miscellaneous";
    default:               return "miscellaneous";
  }
}

function makeId(): string {
  return `finding_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

// ─── Score builder ────────────────────────────────────────────────────────────

function buildScorecard(
  agentScorecard: AgentScorecard,
  recommendation: ReturnType<typeof mapRecommendation>,
  findings: Array<{ severity: string; title: string }>,
  dataGaps: string[],
): Record<string, unknown> {
  const DEFAULT_DIMS = [
    { id: "record_completeness",    name: "Record Completeness",    weight: 0.10 },
    { id: "identity_confidence",    name: "Identity Confidence",    weight: 0.12 },
    { id: "production_quality",     name: "Production Quality",     weight: 0.15 },
    { id: "production_consistency", name: "Production Consistency", weight: 0.13 },
    { id: "mechanical_integrity",   name: "Mechanical Integrity",   weight: 0.08 },
    { id: "plugging_exposure",      name: "Plugging Exposure",      weight: 0.10 },
    { id: "regulatory_compliance",  name: "Regulatory Compliance",  weight: 0.12 },
    { id: "operator_profile",       name: "Operator Profile",       weight: 0.08 },
    { id: "development_activity",   name: "Development Activity",   weight: 0.07 },
    { id: "data_confidence",        name: "Data Confidence",        weight: 0.05 },
  ];

  const dimMap = new Map(agentScorecard.dimensions.map(d => [d.id, d]));
  const dimensions: Record<string, unknown> = {};
  for (const d of DEFAULT_DIMS) {
    const agentDim = dimMap.get(d.id);
    dimensions[d.id] = {
      label: d.name,
      score: agentDim?.score ?? 50,
      weight: d.weight,
      rationale: agentDim?.key_finding ?? "Not assessed.",
      data_points: [],
    };
  }

  const overallScore = Math.round(agentScorecard.overall_score ?? 50);
  const criticals = findings.filter(f => f.severity === "critical");

  return {
    dimensions,
    opportunity_score: Math.max(0, Math.min(100, overallScore)),
    risk_score: Math.max(0, Math.min(100, 100 - overallScore + criticals.length * 5)),
    overall_confidence: Math.max(0, Math.min(100, overallScore)),
    recommendation,
    gating_conditions: criticals.map(f => f.title),
    missing_critical_evidence: dataGaps.slice(0, 5),
    reasons_for: findings.filter(f => f.severity === "info").slice(0, 3).map(f => f.title),
    reasons_against: criticals.slice(0, 3).map(f => f.title),
  };
}

// ─── Main agent runner ────────────────────────────────────────────────────────

async function runAgent(runId: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  // Use service role so we can read+write without RLS
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // ── 1. Load run row ───────────────────────────────────────────────────────

  const { data: runRaw, error: runErr } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (runErr || !runRaw) {
    console.error(`[trrc-dd-execute] run not found: ${runId}`, runErr);
    return;
  }

  // ── 2. Load resolved entities ─────────────────────────────────────────────

  const { data: entityRows } = await supabase
    .from("trrc_resolved_entities")
    .select("*")
    .eq("run_id", runId)
    .order("confidence", { ascending: false });

  const resolvedEntities = (entityRows ?? []).map((e: Record<string, unknown>) => ({
    entity_type: String(e["entity_type"] ?? ""),
    canonical_identifier: String(e["canonical_identifier"] ?? ""),
    display_name: String(e["display_name"] ?? ""),
    attributes: (e["attributes_json"] ?? {}) as Record<string, unknown>,
  }));

  // ── 3. Build initial agent context ────────────────────────────────────────

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

  // Pre-seed context from resolved entities
  for (const entity of resolvedEntities) {
    if (entity.entity_type === "wellbore") {
      const api = entity.canonical_identifier;
      if (api && !ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
      if (!ctx.district && entity.attributes["district"]) ctx.district = String(entity.attributes["district"]);
    } else if (entity.entity_type === "lease") {
      if (!ctx.lease_number && entity.attributes["lease_number"]) ctx.lease_number = String(entity.attributes["lease_number"]);
      if (!ctx.district && entity.attributes["district"]) ctx.district = String(entity.attributes["district"]);
    } else if (entity.entity_type === "operator") {
      if (!ctx.operator_name && entity.attributes["normalized_name"]) ctx.operator_name = String(entity.attributes["normalized_name"]);
      if (!ctx.operator_number && entity.attributes["operator_number"]) ctx.operator_number = String(entity.attributes["operator_number"]);
    }
  }

  // ── 4. Run agent loop ─────────────────────────────────────────────────────

  const userMessage = buildInitialMessage(
    String(runRaw["original_input"] ?? ""),
    String(runRaw["selected_input_type"] ?? "unknown"),
    resolvedEntities,
  );

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let toolCallCount = 0;

  try {
    while (toolCallCount < MAX_TOOL_CALLS) {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 16000,
        
        system: SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0) break;

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        toolCallCount++;

        const result = await dispatchTool(
          block.name,
          ((block.input ?? {}) as Record<string, unknown>),
          ctx,
        );

        console.log(`[trrc-dd-execute] [${runId}] tool=${block.name}: ${result.summary}`);

        // Upsert source attempt (including raw result data for PDF exhibits)
        const resultData = result.data as Record<string, unknown>;
        const resultCount = Array.isArray(resultData?.["wellbores"])
          ? (resultData["wellbores"] as unknown[]).length
          : Array.isArray(resultData?.["records"])
          ? (resultData["records"] as unknown[]).length
          : resultData?.["found"] === true ? 1
          : 0;
        await supabase.from("trrc_source_attempts").upsert({
          run_id: runId,
          source_id: `${block.name}_${toolCallCount}`,
          source_name: block.name,
          status: result.ok ? "success" : "failed_transient",
          result_count: resultCount,
          error_message: result.ok ? null : String(resultData?.["error"] ?? ""),
          attempted_at: new Date().toISOString(),
          result_data_json: result.data,
        }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).then(null, () => {});

        // Update progress (scale 5% → 90% over MAX_TOOL_CALLS)
        const progressPct = Math.min(90, 5 + toolCallCount * 1.7);
        await supabase
          .from("trrc_due_diligence_runs")
          .update({ progress_percent: Math.round(progressPct), updated_at: new Date().toISOString() })
          .eq("id", runId);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result.data),
        });

        // submit_report terminates the loop
        if (block.name === "submit_report" && result.ok) {
          messages.push({ role: "user", content: toolResults });
          break;
        }
      }

      // Check if submit_report was called (ctx.agentReport set)
      if (ctx.agentReport) {
        // Make sure we sent the tool result before breaking
        if (toolResults.length > 0 && messages[messages.length - 1].role !== "user") {
          messages.push({ role: "user", content: toolResults });
        }
        break;
      }

      messages.push({ role: "user", content: toolResults });

      // After delivering tool results, inject a wrap-up reminder as a standalone user message
      if (toolCallCount >= WRAP_UP_THRESHOLD && !ctx.agentReport) {
        messages.push({
          role: "user",
          content: `[SYSTEM NOTICE] You have made ${toolCallCount} tool calls. ` +
            `You MUST call submit_report as your very next action. ` +
            `Synthesize all data gathered so far into findings, a scorecard, and a recommendation. ` +
            `Do NOT call any other data-fetching tools. Call submit_report NOW.`,
        });
      }

      if (response.stop_reason === "end_turn") break;
    }
  } catch (agentErr) {
    console.error(`[trrc-dd-execute] [${runId}] agent loop error:`, agentErr);
    await supabase.from("trrc_due_diligence_runs").update({
      status: "failed",
      error_summary: agentErr instanceof Error ? agentErr.message : String(agentErr),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", runId);
    return;
  }

  if (!ctx.agentReport) {
    console.warn(`[trrc-dd-execute] [${runId}] agent completed ${toolCallCount} tool calls without submitting report`);
    await supabase.from("trrc_due_diligence_runs").update({
      status: "failed",
      error_summary: `Agent completed ${toolCallCount} tool calls but did not submit a report.`,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", runId);
    return;
  }

  // ── 5. Persist findings ───────────────────────────────────────────────────

  const agentFindings = ctx.agentReport.findings ?? [];
  const recommendation = mapRecommendation(ctx.agentReport.recommendation);

  if (agentFindings.length > 0) {
    const findingRows = agentFindings.map(f => ({
      run_id: runId,
      finding_id: makeId(),
      category: mapCategory(f.category),
      severity: mapSeverity(f.severity),
      finding_type: `agent_${f.category}`,
      title: f.title,
      description: f.detail,
      evidence_json: { source_ids: f.source_ids, agent_category: f.category },
      source_record_ids: f.source_ids,
      analytical_method: "agent_synthesis",
      confidence: 0.85,
      recommended_action: "Review finding and cross-check with primary TRRC records.",
      is_directly_reported: true,
    }));

    const { error: findingsErr } = await supabase
      .from("trrc_due_diligence_findings")
      .insert(findingRows);
    if (findingsErr) console.error("[trrc-dd-execute] findings insert error:", findingsErr);
  }

  // ── 6. Persist production rows ────────────────────────────────────────────

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
      .map(raw => {
        const year = Number(raw["year"]);
        const month = Number(raw["month"]);
        return {
          run_id: runId,
          entity_type: "lease",
          api_number: ctx.api_numbers[0] ?? null,
          district: ctx.district ?? "",
          lease_number: ctx.lease_number ?? null,
          gas_id: null,
          operator_number: ctx.operator_number ?? null,
          production_month: `${year}-${String(month).padStart(2, "0")}`,
          oil_bbl: typeof raw["oil_bbl"] === "number" ? raw["oil_bbl"] : null,
          casinghead_gas_mcf: null,
          gas_mcf: typeof raw["gas_mcf"] === "number" ? raw["gas_mcf"] : null,
          condensate_bbl: null,
          water_bbl: typeof raw["water_bbl"] === "number" ? raw["water_bbl"] : null,
        };
      });

    if (prodRows.length > 0) {
      const { error: prodErr } = await supabase
        .from("trrc_production_monthly")
        .upsert(prodRows, {
          onConflict: "run_id,entity_type,api_number,lease_number,production_month",
          ignoreDuplicates: true,
        });
      if (prodErr) console.error("[trrc-dd-execute] production upsert error:", prodErr);
    }
  }

  // ── 7. Upsert agent-discovered entities ──────────────────────────────────

  if (ctx.api_numbers.length > 0) {
    const existingIds = new Set(resolvedEntities.map(e => e.canonical_identifier));
    const newEntityRows = ctx.api_numbers
      .filter(api => !existingIds.has(api))
      .map(api => ({
        run_id: runId,
        entity_type: "wellbore",
        canonical_identifier: api,
        display_name: `API ${api}`,
        attributes_json: { discovered_by: "trrc_agent" },
        confidence: 0.9,
        resolution_method: "agent_discovery",
        is_user_selected: false,
      }));

    if (newEntityRows.length > 0) {
      await supabase.from("trrc_resolved_entities").insert(newEntityRows).then(null, err => {
        console.error("[trrc-dd-execute] entity insert error:", err);
      });
    }
  }

  // ── 8. Load source attempts and build coverage_json ──────────────────────

  const { data: attemptRows } = await supabase
    .from("trrc_source_attempts")
    .select("source_name, status, result_count, result_data_json")
    .eq("run_id", runId)
    .order("attempted_at", { ascending: true });

  const coverageJson = buildCoverageFromAttempts(
    (attemptRows ?? []).map((a: Record<string, unknown>) => ({
      source_name: String(a["source_name"] ?? ""),
      status:      String(a["status"] ?? ""),
      result_count: Number(a["result_count"] ?? 0),
      result_data_json: a["result_data_json"] ?? {},
    })),
  );

  // ── 9. Build scorecard and result_summary ─────────────────────────────────

  const scorecardJson = buildScorecard(
    ctx.agentReport.scorecard,
    recommendation,
    agentFindings.map(f => ({ severity: mapSeverity(f.severity), title: f.title })),
    ctx.agentReport.data_gaps ?? [],
  );

  const resultSummary = JSON.stringify({
    recommendation,
    overall_score: ctx.agentReport.scorecard.overall_score,
    opportunity_score: (scorecardJson as Record<string, number>)["opportunity_score"],
    risk_score: (scorecardJson as Record<string, number>)["risk_score"],
    executive_summary_preview: (ctx.agentReport.executive_summary ?? [])[0]?.slice(0, 200) ?? "",
  });

  // ── 10. Update run to complete ────────────────────────────────────────────

  const { error: updateErr } = await supabase
    .from("trrc_due_diligence_runs")
    .update({
      status: "complete",
      progress_percent: 100,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolved_primary_api: ctx.api_numbers[0] ?? null,
      resolved_district: ctx.district,
      resolved_lease_number: ctx.lease_number,
      resolved_operator_number: ctx.operator_number,
      scorecard_json: scorecardJson,
      coverage_json: coverageJson,
      result_summary: resultSummary,
    })
    .eq("id", runId);

  if (updateErr) {
    console.error("[trrc-dd-execute] run update error:", updateErr);
  } else {
    console.log(`[trrc-dd-execute] [${runId}] complete — recommendation: ${recommendation}`);
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
  const work = runAgent(runId);

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
