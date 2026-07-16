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

const MAX_TOOL_CALLS = 50;

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
You are an expert TRRC (Texas Railroad Commission) Public Records Investigator with 20 years of experience
conducting oil and gas due diligence in Texas. You have direct, programmatic access to TRRC public databases
through the tools provided.

## Your role
You receive raw user input — which may be an API number, RRC lease number/ID, operator name, P5 number,
or a legal description (abstract/survey/section/township/range) — along with any pre-resolved entity data.
Your job is to:

1. Determine what the input refers to (well, lease, operator, or land parcel)
2. Search all relevant TRRC sources to build a complete picture of the asset
3. Produce structured findings, a 10-dimension scorecard, and a recommendation

## Investigation protocol

### Step 1 — Establish identity
- If you have an API number, call \`search_by_api\` to confirm the well exists and get lease/district/county/operator.
- If you have a lease number, call \`search_by_lease\` to enumerate all wells on the lease.
- If you have an operator name or P5 number, call \`search_by_operator\` first to establish operator identity and bond status.
- If you have a legal description, call \`search_by_legal_description\` to find matched API numbers via GIS.
- Do NOT skip identity resolution — every downstream query depends on correct identifiers.

### Step 2 — Production
- Always fetch production via \`fetch_production\` using the lease number + district (preferred) or API number.
- Production is lease-level. You cannot attribute it to a single well without per-well allocation evidence.
- Check for production gaps, decline trends, and zero-production months.

### Step 3 — Well integrity and status
- Call \`fetch_well_status\` for every API number found. Active vs. inactive vs. plugged matters.
- Call \`fetch_inactive_well_status\` to check EWA inactive well records.
- Call \`fetch_plugging_records\` — plugged wells have liability implications for mineral owners.
- Call \`fetch_orphan_well\` if the operator appears financially distressed.
- Call \`fetch_completion_records\` to understand formation, depth, and mechanical design.

### Step 4 — Compliance and operator
- Call \`fetch_compliance_violations\` for the operator. Document the result even if empty.
  An empty compliance result may mean a clean record OR a failed query — distinguish these.
- Fetch \`fetch_p4_records\` for production test data by lease or API.
- Check \`fetch_severance_records\` if there is evidence of wellbore severance.

### Step 5 — Additional data
- Call \`fetch_proration\` to check proration schedule constraints on production.
- Call \`fetch_injection_records\` if this may be a disposal or injection well.
- Call \`fetch_imaged_records\` for post-2009 CMPL imaged document packets if APIs are known.

### Step 6 — Submit report
- Once you have completed your investigation, call \`submit_report\` with your full synthesis.
- Your report must include findings, a 10-dimension scorecard (all weights summing to 1.0), and a recommendation.

## Critical rules

- **Empty result ≠ clean.** A zero-violation compliance query may be a query failure. Note this explicitly.
- **canClaimSingleWellProduction is always false for lease-level production.** Never attribute lease production to a specific well.
- **Verified data only.** Do not invent numbers. If you cannot retrieve data, note it as a data gap.
- **Try multiple query paths.** If lease-level production fails, try by API. If operator by name fails, try by operator number.
- **Do not reveal internal tool names** in your narrative summary (use plain English descriptions instead).
- **Cover all 17 tools where applicable.** Do not skip sources without documenting why they were not applicable.

## Recommendation criteria
- **pursue** — asset has verified production, clean compliance, active operator, no major liability flags
- **review** — asset warrants deeper investigation (gaps in data, minor compliance issues, aging wells)
- **blocked** — critical gating issue: fake API, operator in violation/revoked, catastrophic plugging liability
- **pass** — asset does not meet investment criteria (no production, inactive, excessive risk)

## Scorecard dimensions (weights must sum to 1.0)
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

When submitting the scorecard, use these exact dimension IDs and ensure weights sum to 1.0.
`.trim();

// ─── Tool definitions ─────────────────────────────────────────────────────────

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_by_api",
    description:
      "Look up a well by API number in the TRRC PDQ wellbore database. " +
      "Returns lease number, district code, county, and operator name/number.",
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
      "Look up a lease by RRC lease number and district. " +
      "Returns the full well inventory: all API numbers on the lease, well statuses, and well types.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "RRC lease number (e.g. '10289', '60509')" },
        district: { type: "string", description: "TRRC district code (e.g. '01', '08', '8A')" },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "search_by_operator",
    description:
      "Look up an operator by name or P5 number. " +
      "Returns operator_number, bond status, organizational status, and P5 record details.",
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
      "Returns matched API numbers whose surface locations fall within the described parcel.",
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
      "Preferred: provide lease_number + district. Alternative: provide api_number.",
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
      "Returns formation name, total depth, completion date, and wellbore profile.",
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
      "Inactive wells represent potential plugging liability.",
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
      "Returns plugging date, contractor, depth, and regulatory status.",
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
      "Returns test date, allowable, tested rate, and gatherer information.",
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
      "Fetch EWA well status (active/inactive/plugged) for an API or all wells on a lease.",
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
      "An orphan well is one whose operator has become insolvent — critical liability flag.",
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
      "Documents wellbore interval severances — relevant for casing integrity.",
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
      "IMPORTANT: empty result does NOT guarantee clean compliance — it may be a failed query.",
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
      "Proration schedules govern allowable production rates for oil leases.",
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
      "Use if the well may be a disposal or enhanced recovery injection well.",
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
      "Returns document type, filing date, and document URLs.",
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
      "Submit the completed due diligence investigation findings. " +
      "Call this when you have finished retrieving and analyzing all applicable TRRC data.",
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

// ─── TRRC fetch helpers ───────────────────────────────────────────────────────

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";
const PROD_API = "https://www.rrc.texas.gov/api/production-query";
const CMPL_BASE = "https://webapps2.rrc.texas.gov/CMPL";

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

async function fetchHtml(url: string, opts: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "MineralFlow-AI-TRRC-DD/1.0",
      "Content-Type": opts.method === "POST" ? "application/x-www-form-urlencoded" : undefined,
      ...(opts.headers ?? {}),
    } as HeadersInit,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function formBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function toolSearchByApi(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) return { ok: false, data: { error: "api_number required" }, summary: "search_by_api: no input" };

  // Normalize: strip non-digits, take first 10
  const digits = apiRaw.replace(/\D/g, "");
  const api10 = digits.slice(0, 10);

  try {
    const html = await fetchHtml(
      `${EWA_BASE}/wellboreQueryAction.do`,
      {
        method: "POST",
        body: formBody({
          "searchArgs.apiNumber": api10,
          "methodToCall": "search",
        }),
      },
    );

    const rows = extractTableRows(html);
    if (rows.length < 2) {
      // Try PDQ endpoint
      const pdqUrl = `https://www.rrc.texas.gov/api/well-information/wellbore-information?api=${api10}`;
      let pdqData: Record<string, unknown> | null = null;
      try {
        pdqData = await fetchJson(pdqUrl) as Record<string, unknown>;
      } catch {
        // ignore
      }

      if (pdqData && pdqData["leaseNumber"]) {
        const leaseNo = String(pdqData["leaseNumber"] ?? "");
        const distCode = String(pdqData["districtCode"] ?? "");
        const operator = String(pdqData["operatorName"] ?? "");
        if (!ctx.api_numbers.includes(api10)) ctx.api_numbers.push(api10);
        if (!ctx.district && distCode) ctx.district = distCode;
        if (!ctx.lease_number && leaseNo) ctx.lease_number = leaseNo;
        if (!ctx.operator_name && operator) ctx.operator_name = operator;
        return {
          ok: true,
          data: { found: true, api_number: api10, lease_number: leaseNo, district: distCode, operator },
          summary: `search_by_api: ${api10} → Lease ${leaseNo} / District ${distCode} / Operator: ${operator}`,
        };
      }

      return {
        ok: true,
        data: {
          found: false,
          api_number: api10,
          raw_text: extractText(html, 500),
          message: `API ${api10} NOT FOUND in TRRC EWA database. Verify the API number.`,
        },
        summary: `search_by_api: ${api10} — NOT FOUND in TRRC`,
      };
    }

    // Parse first data row (index 1 = header skipped)
    const header = rows[0] ?? [];
    const dataRow = rows[1] ?? [];
    const rowData: Record<string, string> = {};
    header.forEach((h, i) => { rowData[h.toLowerCase().replace(/\s+/g, "_")] = dataRow[i] ?? ""; });

    const leaseNo = rowData["lease_no"] ?? rowData["lease_number"] ?? "";
    const distCode = rowData["district"] ?? rowData["dist"] ?? "";
    const operator = rowData["operator"] ?? rowData["operator_name"] ?? "";
    const county   = rowData["county"] ?? "";

    if (!ctx.api_numbers.includes(api10)) ctx.api_numbers.push(api10);
    if (!ctx.district && distCode) ctx.district = distCode;
    if (!ctx.lease_number && leaseNo) ctx.lease_number = leaseNo;
    if (!ctx.operator_name && operator) ctx.operator_name = operator;
    if (!ctx.county && county) ctx.county = county;

    return {
      ok: true,
      data: { found: true, api_number: api10, lease_number: leaseNo, district: distCode, operator, county, raw_row: rowData },
      summary: `search_by_api: ${api10} → Lease ${leaseNo} / District ${distCode} / Operator: ${operator}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_api: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolSearchByLease(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo = String(input.lease_number ?? "").trim();
  const distCode = String(input.district ?? "").trim();
  if (!leaseNo || !distCode) {
    return { ok: false, data: { error: "lease_number and district required" }, summary: "search_by_lease: missing inputs" };
  }

  try {
    const html = await fetchHtml(
      `${EWA_BASE}/leaseWellQueryAction.do`,
      {
        method: "POST",
        body: formBody({
          "searchArgs.leaseTypeArg": "O",
          "searchArgs.districtArg": distCode,
          "searchArgs.leaseNumberArg": leaseNo,
          "methodToCall": "search",
        }),
      },
    );

    if (!ctx.lease_number) ctx.lease_number = leaseNo;
    if (!ctx.district) ctx.district = distCode;

    const rows = extractTableRows(html);
    if (rows.length < 2) {
      return {
        ok: true,
        data: { found: false, lease_number: leaseNo, district: distCode, text: extractText(html, 500) },
        summary: `search_by_lease: Lease ${leaseNo} / District ${distCode} — no inventory found`,
      };
    }

    const header = rows[0] ?? [];
    const wells = rows.slice(1).map(row => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h.toLowerCase().replace(/\s+/g, "_")] = row[i] ?? ""; });
      return obj;
    });

    // Extract API numbers
    for (const w of wells) {
      const api = w["api"] ?? w["api_no"] ?? w["api_number"] ?? "";
      if (api && !ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
    }

    const active = wells.filter(w => (w["status"] ?? "").toUpperCase() === "A").length;
    return {
      ok: true,
      data: {
        found: true,
        lease_number: leaseNo,
        district: distCode,
        total_wells: wells.length,
        active_wells: active,
        inactive_wells: wells.length - active,
        wells: wells.slice(0, 30),
      },
      summary: `search_by_lease: Lease ${leaseNo} — ${wells.length} wells (${active} active)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_lease: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolSearchByOperator(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const opName = input.operator_name ? String(input.operator_name).trim() : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    // Try P5 lookup
    const params: Record<string, string> = { "methodToCall": "search" };
    if (opNo) params["searchArgs.operatorNo"] = opNo;
    else if (opName) params["searchArgs.operatorName"] = opName;
    else return { ok: false, data: { error: "operator_name or operator_number required" }, summary: "search_by_operator: no input" };

    const html = await fetchHtml(`${EWA_BASE}/p5QueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);

    if (rows.length < 2) {
      return {
        ok: true,
        data: { found: false, message: `No P-5 record found for operator "${opName ?? opNo}". May be inactive or wrong name.` },
        summary: `search_by_operator: "${opName ?? opNo}" — no P5 found`,
      };
    }

    const header = rows[0] ?? [];
    const dataRow = rows[1] ?? [];
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h.toLowerCase().replace(/\s+/g, "_")] = dataRow[i] ?? ""; });

    const resolvedOpNo = rec["operator_no"] ?? rec["p5_no"] ?? opNo ?? "";
    const resolvedName = rec["operator_name"] ?? rec["name"] ?? opName ?? "";
    const orgStatus = rec["org_status"] ?? rec["status"] ?? "";
    const tnrFlag = (rec["tnr_91114"] ?? "").toUpperCase() === "Y";

    if (!ctx.operator_number && resolvedOpNo) ctx.operator_number = resolvedOpNo;
    if (!ctx.operator_name && resolvedName) ctx.operator_name = resolvedName;

    return {
      ok: true,
      data: { found: true, operator_name: resolvedName, operator_no: resolvedOpNo, org_status: orgStatus, tnr_91114: tnrFlag, raw: rec },
      summary: `search_by_operator: "${resolvedName}" — org_status: ${orgStatus}${tnrFlag ? " [TNR91114 FLAG]" : ""}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_operator: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolSearchByLegalDescription(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const county  = input.county ? String(input.county) : null;
  const abstract = input.abstract_number ? String(input.abstract_number) : null;
  const survey  = input.survey_name ? String(input.survey_name) : null;

  if (!ctx.county && county) ctx.county = county;

  try {
    // Use TRRC GIS API
    const params = new URLSearchParams();
    if (abstract) params.set("abstractNumber", abstract);
    if (survey)   params.set("surveyName", survey);
    if (county)   params.set("county", county);

    const url = `https://www.rrc.texas.gov/api/well-information/gis-search?${params.toString()}`;
    let data: Record<string, unknown>;
    try {
      data = await fetchJson(url) as Record<string, unknown>;
    } catch {
      // Fallback: return a helpful message
      return {
        ok: true,
        data: { found: false, params: { abstract, survey, county }, message: "GIS lookup unavailable or returned no results." },
        summary: "search_by_legal_description: GIS lookup failed or returned empty",
      };
    }

    const wells = (data["wells"] ?? data["features"] ?? []) as Array<Record<string, unknown>>;
    const apiNumbers: string[] = wells
      .map(w => String(w["api"] ?? w["apiNumber"] ?? w["api_number"] ?? ""))
      .filter(a => a.length >= 10);

    for (const api of apiNumbers) {
      if (!ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
    }

    return {
      ok: true,
      data: { found: apiNumbers.length > 0, api_numbers: apiNumbers, count: apiNumbers.length },
      summary: `search_by_legal_description: found ${apiNumbers.length} API(s) in described parcel`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_legal_description: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchProduction(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo  = input.lease_number ? String(input.lease_number).trim() : null;
  const distCode = input.district     ? String(input.district).trim()     : null;
  const apiNum   = input.api_number   ? String(input.api_number).trim()   : null;
  const months   = input.months       ? Number(input.months)               : 36;

  try {
    if (leaseNo && distCode) {
      const url = `${PROD_API}/production-by-lease?district=${encodeURIComponent(distCode)}&lease_number=${encodeURIComponent(leaseNo)}&lease_type=OIL&months=${months}`;
      let data: Record<string, unknown>;
      try {
        data = await fetchJson(url) as Record<string, unknown>;
      } catch {
        // Try gas
        const urlGas = `${PROD_API}/production-by-lease?district=${encodeURIComponent(distCode)}&lease_number=${encodeURIComponent(leaseNo)}&lease_type=GAS&months=${months}`;
        data = await fetchJson(urlGas) as Record<string, unknown>;
      }

      const rows = (data["production"] ?? data["data"] ?? data["rows"] ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        return {
          ok: true,
          data: { found: false, lease_number: leaseNo, district: distCode, message: "No production data. Try a different district code." },
          summary: `fetch_production: Lease ${leaseNo} / District ${distCode} — no data`,
        };
      }

      ctx.production = [...ctx.production, ...rows as ProductionRow[]];
      if (!ctx.lease_number) ctx.lease_number = leaseNo;
      if (!ctx.district) ctx.district = distCode;

      const totalOil = rows.reduce((s, r) => s + (Number(r["oil_bbl"] ?? r["oil"] ?? 0)), 0);
      const totalGas = rows.reduce((s, r) => s + (Number(r["gas_mcf"] ?? r["gas"] ?? 0)), 0);
      const recent3  = rows.slice(-3);
      const avg3Oil  = recent3.length ? recent3.reduce((s, r) => s + (Number(r["oil_bbl"] ?? 0)), 0) / recent3.length : 0;

      return {
        ok: true,
        data: {
          found: true,
          source: "lease",
          lease_number: leaseNo,
          district: distCode,
          months_of_data: rows.length,
          total_oil_bbl: Math.round(totalOil),
          total_gas_mcf: Math.round(totalGas),
          three_month_avg_oil_bbl: Math.round(avg3Oil),
          monthly_rows: rows.slice(-24),
        },
        summary: `fetch_production: Lease ${leaseNo} — ${Math.round(totalOil).toLocaleString()} BBL total, ${Math.round(avg3Oil)} BBL/mo (3-mo avg)`,
      };
    }

    if (apiNum) {
      const url = `${PROD_API}/production-by-well?api=${encodeURIComponent(apiNum)}&months=${months}`;
      const data = await fetchJson(url) as Record<string, unknown>;
      const rows = (data["production"] ?? data["data"] ?? data["rows"] ?? []) as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        return {
          ok: true,
          data: { found: false, api_number: apiNum, message: "No production data for this API" },
          summary: `fetch_production: API ${apiNum} — no data`,
        };
      }

      ctx.production = [...ctx.production, ...rows as ProductionRow[]];
      if (!ctx.api_numbers.includes(apiNum)) ctx.api_numbers.push(apiNum);

      const totalOil = rows.reduce((s, r) => s + (Number(r["oil_bbl"] ?? 0)), 0);
      return {
        ok: true,
        data: { found: true, source: "api", api_number: apiNum, months_of_data: rows.length, total_oil_bbl: Math.round(totalOil), monthly_rows: rows.slice(-24) },
        summary: `fetch_production: API ${apiNum} — ${Math.round(totalOil).toLocaleString()} BBL total`,
      };
    }

    return { ok: false, data: { error: "Provide (lease_number + district) or api_number" }, summary: "fetch_production: missing parameters" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_production: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchCompletionRecords(input: Record<string, unknown>): Promise<ToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? [];
  if (apis.length === 0) return { ok: false, data: { error: "api_numbers required" }, summary: "fetch_completion_records: no APIs" };

  try {
    const results: Record<string, unknown>[] = [];
    for (const api of apis.slice(0, 5)) {
      try {
        const digits = api.replace(/\D/g, "").slice(0, 10);
        const url = `https://www.rrc.texas.gov/api/well-information/completion-information?api=${digits}`;
        const data = await fetchJson(url) as Record<string, unknown>;
        results.push({ api: digits, ...data });
      } catch {
        // Try EWA fallback
        try {
          const digits = api.replace(/\D/g, "").slice(0, 10);
          const html = await fetchHtml(`${EWA_BASE}/completionQueryAction.do`, {
            method: "POST",
            body: formBody({ "searchArgs.apiNumber": digits, "methodToCall": "search" }),
          });
          const rows = extractTableRows(html);
          if (rows.length > 1) results.push({ api: digits, raw_table: rows.slice(0, 3) });
        } catch {
          results.push({ api, error: "retrieval failed" });
        }
      }
    }

    const found = results.filter(r => !r["error"]);
    return {
      ok: true,
      data: { count: found.length, completions: found },
      summary: `fetch_completion_records: ${found.length} record(s) for ${apis.length} API(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_completion_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchInactiveWellStatus(input: Record<string, unknown>): Promise<ToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;
  const leaseType = (input.lease_type as string | undefined) ?? "O";

  try {
    if (apiNum) {
      const digits = apiNum.replace(/\D/g, "").slice(0, 10);
      const html = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
        method: "POST",
        body: formBody({ "searchArgs.apiNumber": digits, "methodToCall": "search" }),
      });
      const rows = extractTableRows(html);
      const isInactive = rows.length > 1;
      return {
        ok: true,
        data: { api_number: digits, is_inactive: isInactive, records: rows.slice(1, 6), text: extractText(html, 500) },
        summary: `fetch_inactive_well_status: API ${digits} — ${isInactive ? "INACTIVE (on EWA list)" : "not on inactive list"}`,
      };
    }

    if (opNo) {
      const html = await fetchHtml(`${EWA_BASE}/inactiveWellQueryAction.do`, {
        method: "POST",
        body: formBody({ "searchArgs.operatorNo": opNo, "searchArgs.leaseTypeArg": leaseType, "methodToCall": "search" }),
      });
      const rows = extractTableRows(html);
      return {
        ok: true,
        data: { operator_number: opNo, lease_type: leaseType, count: Math.max(0, rows.length - 1), wells: rows.slice(1, 21) },
        summary: `fetch_inactive_well_status: operator ${opNo} — ${Math.max(0, rows.length - 1)} inactive wells`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_inactive_well_status: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_inactive_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchPluggingRecords(input: Record<string, unknown>): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    if (apiNum) {
      params["searchArgs.apiNumber"] = apiNum.replace(/\D/g, "").slice(0, 10);
    } else if (leaseNo && dist) {
      params["searchArgs.leaseNumberArg"] = leaseNo;
      params["searchArgs.districtArg"] = dist;
    } else {
      return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_plugging_records: missing input" };
    }

    const html = await fetchHtml(`${EWA_BASE}/pluggingQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const label = apiNum ?? `Lease ${leaseNo}`;

    return {
      ok: true,
      data: { identifier: label, count: Math.max(0, rows.length - 1), records: rows.slice(1, 11) },
      summary: `fetch_plugging_records: ${label} — ${Math.max(0, rows.length - 1)} plugging record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_plugging_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchP4Records(input: Record<string, unknown>): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    if (apiNum) {
      params["searchArgs.apiNumber"] = apiNum.replace(/\D/g, "").slice(0, 10);
    } else if (leaseNo && dist) {
      params["searchArgs.leaseNumberArg"] = leaseNo;
      params["searchArgs.districtArg"] = dist;
    } else {
      return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_p4_records: missing input" };
    }

    const html = await fetchHtml(`${EWA_BASE}/p4QueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const label = apiNum ?? `Lease ${leaseNo}`;

    return {
      ok: true,
      data: { identifier: label, count: Math.max(0, rows.length - 1), records: rows.slice(1, 11) },
      summary: `fetch_p4_records: ${label} — ${Math.max(0, rows.length - 1)} P-4 record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_p4_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchWellStatus(input: Record<string, unknown>): Promise<ToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    if (apiNum) {
      params["searchArgs.apiNumber"] = apiNum.replace(/\D/g, "").slice(0, 10);
    } else if (leaseNo && dist) {
      params["searchArgs.leaseNumberArg"] = leaseNo;
      params["searchArgs.districtArg"] = dist;
    } else {
      return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_well_status: missing input" };
    }

    const html = await fetchHtml(`${EWA_BASE}/wellStatusQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const label = apiNum ?? `Lease ${leaseNo}`;

    return {
      ok: true,
      data: { identifier: label, count: Math.max(0, rows.length - 1), statuses: rows.slice(1, 21) },
      summary: `fetch_well_status: ${label} — ${Math.max(0, rows.length - 1)} status record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchOrphanWell(input: Record<string, unknown>): Promise<ToolResult> {
  const apiNum = String(input.api_number ?? "").trim();
  if (!apiNum) return { ok: false, data: { error: "api_number required" }, summary: "fetch_orphan_well: no input" };

  try {
    const digits = apiNum.replace(/\D/g, "").slice(0, 10);
    const html = await fetchHtml(`${EWA_BASE}/orphanWellQueryAction.do`, {
      method: "POST",
      body: formBody({ "searchArgs.apiNumber": digits, "methodToCall": "search" }),
    });
    const rows = extractTableRows(html);
    const isOrphan = rows.length > 1;

    return {
      ok: true,
      data: { api_number: digits, is_orphan: isOrphan, count: Math.max(0, rows.length - 1), records: rows.slice(1, 6) },
      summary: `fetch_orphan_well: API ${digits} — ${isOrphan ? `ORPHAN (${rows.length - 1} record(s))` : "not on orphan list"}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_orphan_well: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchSeveranceRecords(input: Record<string, unknown>): Promise<ToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    if (apiNum) params["searchArgs.apiNumber"] = apiNum.replace(/\D/g, "").slice(0, 10);
    else if (opNo) params["searchArgs.operatorNo"] = opNo;
    else return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_severance_records: missing input" };

    const html = await fetchHtml(`${EWA_BASE}/severanceQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const label = apiNum ?? `Operator ${opNo}`;

    return {
      ok: true,
      data: { identifier: label, count: Math.max(0, rows.length - 1), records: rows.slice(1, 11) },
      summary: `fetch_severance_records: ${label} — ${Math.max(0, rows.length - 1)} record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_severance_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchComplianceViolations(input: Record<string, unknown>): Promise<ToolResult> {
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;
  const opName = input.operator_name   ? String(input.operator_name).trim()   : null;
  const county = input.county          ? String(input.county).trim()          : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    let queryMethod = "";

    if (opNo) {
      params["searchArgs.operatorNo"] = opNo;
      queryMethod = `operator number ${opNo}`;
    } else if (opName) {
      params["searchArgs.operatorName"] = opName;
      queryMethod = `operator name "${opName}"`;
    } else {
      return { ok: false, data: { error: "Provide operator_number or operator_name" }, summary: "fetch_compliance_violations: no operator identifier" };
    }
    if (county) params["searchArgs.county"] = county;

    const html = await fetchHtml(`${EWA_BASE}/violationQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const violationCount = Math.max(0, rows.length - 1);

    if (violationCount === 0) {
      return {
        ok: true,
        data: {
          found_violations: false,
          query_method: queryMethod,
          important_note: "Zero violations returned. This may mean clean record OR incorrect identifier / failed query. Do NOT report as confirmed clean without noting this uncertainty.",
        },
        summary: `fetch_compliance_violations: 0 violations via ${queryMethod} (unconfirmed — may be query miss)`,
      };
    }

    return {
      ok: true,
      data: { found_violations: true, query_method: queryMethod, total_violations: violationCount, violations: rows.slice(1, 11) },
      summary: `fetch_compliance_violations: ${violationCount} violations via ${queryMethod}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_compliance_violations: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchProration(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const leaseNo   = String(input.lease_number ?? "").trim();
  const leaseType = (input.lease_type as string | undefined) ?? "oil";
  const distCode  = input.district ? String(input.district).trim() : (ctx.district ?? "");
  const api10     = ctx.api_numbers[0] ?? leaseNo;

  if (!api10) return { ok: false, data: { error: "No api10 available. Search for a well first." }, summary: "fetch_proration: no api10" };
  if (!distCode) return { ok: false, data: { error: "district required for proration" }, summary: "fetch_proration: missing district" };

  try {
    const params: Record<string, string> = {
      "searchArgs.apiNumber": api10.replace(/\D/g, "").slice(0, 10),
      "searchArgs.districtArg": distCode,
      "searchArgs.leaseTypeArg": leaseType === "gas" ? "G" : "O",
      "methodToCall": "search",
    };

    const html = await fetchHtml(`${EWA_BASE}/prorationQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);

    return {
      ok: true,
      data: { api10, district: distCode, lease_type: leaseType, count: Math.max(0, rows.length - 1), records: rows.slice(1, 11) },
      summary: `fetch_proration: API ${api10} (${leaseType}) — ${Math.max(0, rows.length - 1)} proration record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_proration: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchInjectionRecords(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    const params: Record<string, string> = { "methodToCall": "search" };
    if (apiNum) params["searchArgs.apiNumber"] = apiNum.replace(/\D/g, "").slice(0, 10);
    else if (opNo) params["searchArgs.operatorNo"] = opNo;
    else return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_injection_records: missing input" };

    const html = await fetchHtml(`${EWA_BASE}/injectionQueryAction.do`, { method: "POST", body: formBody(params) });
    const rows = extractTableRows(html);
    const label = apiNum ?? `Operator ${opNo ?? ctx.operator_number}`;

    return {
      ok: true,
      data: { identifier: label, count: Math.max(0, rows.length - 1), records: rows.slice(1, 11) },
      summary: `fetch_injection_records: ${label} — ${Math.max(0, rows.length - 1)} injection record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_injection_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function toolFetchImagedRecords(input: Record<string, unknown>): Promise<ToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? [];
  if (apis.length === 0) return { ok: false, data: { error: "api_numbers required" }, summary: "fetch_imaged_records: no APIs" };

  try {
    const results: Record<string, unknown>[] = [];
    for (const api of apis.slice(0, 5)) {
      try {
        const digits = api.replace(/\D/g, "").slice(0, 10);
        const html = await fetchHtml(`${CMPL_BASE}/publicCmplQueryAction.do`, {
          method: "POST",
          body: formBody({ "searchArgs.apiNumber": digits, "methodToCall": "search" }),
        });
        const rows = extractTableRows(html);
        results.push({ api: digits, document_count: Math.max(0, rows.length - 1), documents: rows.slice(1, 6) });
      } catch {
        results.push({ api, error: "retrieval failed" });
      }
    }

    const totalDocs = results.reduce((s, r) => s + (Number(r["document_count"] ?? 0)), 0);
    return {
      ok: true,
      data: { apis_queried: apis.length, total_documents: totalDocs, results },
      summary: `fetch_imaged_records: ${apis.length} API(s) — ${totalDocs} document(s) found`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_imaged_records: failed — ${String(e).slice(0, 80)}` };
  }
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
    case "fetch_completion_records":  return toolFetchCompletionRecords(toolInput);
    case "fetch_inactive_well_status": return toolFetchInactiveWellStatus(toolInput);
    case "fetch_plugging_records":    return toolFetchPluggingRecords(toolInput);
    case "fetch_p4_records":          return toolFetchP4Records(toolInput);
    case "fetch_well_status":         return toolFetchWellStatus(toolInput);
    case "fetch_orphan_well":         return toolFetchOrphanWell(toolInput);
    case "fetch_severance_records":   return toolFetchSeveranceRecords(toolInput);
    case "fetch_compliance_violations": return toolFetchComplianceViolations(toolInput);
    case "fetch_proration":           return toolFetchProration(toolInput, ctx);
    case "fetch_injection_records":   return toolFetchInjectionRecords(toolInput, ctx);
    case "fetch_imaged_records":      return toolFetchImagedRecords(toolInput);
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
    "1. Begin by confirming the identity of this asset using the appropriate search tool.",
    "2. Fetch production data from TRRC directly — do NOT rely on any pre-stated production figures.",
    "3. Check well status, plugging records, and inactive well lists for liability exposure.",
    "4. Fetch compliance violations and inspection records for the operator.",
    "5. Cover all applicable data sources — document any you cannot query and why.",
    "6. When your investigation is complete, call submit_report with your full synthesis.",
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
        thinking: { type: "adaptive" },
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
          block.input as Record<string, unknown>,
          ctx,
        );

        console.log(`[trrc-dd-execute] [${runId}] tool=${block.name}: ${result.summary}`);

        // Upsert source attempt
        await supabase.from("trrc_source_attempts").upsert({
          run_id: runId,
          source_id: `${block.name}_${toolCallCount}`,
          source_name: block.name,
          status: result.ok ? "success" : "failed_transient",
          result_count: 0,
          error_message: result.ok ? null : String((result.data as Record<string, unknown>)?.["error"] ?? ""),
          attempted_at: new Date().toISOString(),
        }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).catch(() => {});

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
      await supabase.from("trrc_resolved_entities").insert(newEntityRows).catch(err => {
        console.error("[trrc-dd-execute] entity insert error:", err);
      });
    }
  }

  // ── 8. Build scorecard and result_summary ─────────────────────────────────

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

  // ── 9. Update run to complete ─────────────────────────────────────────────

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
