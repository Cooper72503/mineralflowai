/**
 * TRRC Agent tool handlers — maps each tool name to an async handler that
 * calls the real TRRC fetchers, accumulates results in TrrcAgentContext,
 * and returns a { summary, data, ok } result for Claude.
 */

import { lookupTrrcLeasesByApis } from "@/lib/wells/trrc-api";
import { fetchLeaseWellInventory } from "@/lib/underwriting/trrc-lease-inventory";
import { fetchTrrcProductionByLease, fetchTrrcProductionHistory } from "@/lib/wells/trrc-production";
import { fetchTrrcCompletionsForApis } from "@/lib/wells/trrc-completions";
import { fetchTrrcInactiveWellByApi, fetchTrrcInactiveWellsByOperator } from "@/lib/underwriting/trrc-inactive-wells";
import { fetchTrrcPluggingByApi, fetchTrrcPluggingByLease } from "@/lib/wells/trrc-plugging";
import { fetchTrrcP4ByApi, fetchTrrcP4ByLease } from "@/lib/wells/trrc-p4";
import { fetchTrrcWellStatus, fetchTrrcWellStatusByLease } from "@/lib/wells/trrc-well-status";
import { fetchTrrcOrphanWellByApi } from "@/lib/wells/trrc-orphan-wells";
import { fetchTrrcSeveranceByApi, fetchTrrcSeveranceByOperator } from "@/lib/wells/trrc-severance";
import { fetchTrrcP5ByOperatorName, fetchTrrcP5ByOperatorNo } from "@/lib/underwriting/trrc-p5";
import { fetchTrrcOperatorProfile } from "@/lib/wells/trrc-operator-profile";
import { fetchTrrcOilProration, fetchTrrcGasProration } from "@/lib/underwriting/trrc-proration";
import { fetchTrrcInjectionByApi, fetchTrrcInjectionByOperator } from "@/lib/underwriting/trrc-injection";
import { fetchTrrcImagedRecordsMulti } from "@/lib/wells/trrc-imaged-records";
import { lookupWellsByLegalDescription } from "@/lib/wells/trrc-abstract-lookup";
import { fetchTrrcViolations, fetchTrrcViolationsByOperator } from "@/lib/underwriting/trrc-compliance";
import { fetchTrrcInspectionsByApi } from "@/lib/wells/trrc-inspection";

// ─── Context types ────────────────────────────────────────────────────────────

export interface AgentFinding {
  category: string;
  severity: string;
  title: string;
  detail: string;
  source_ids: string[];
}

export interface AgentScorecardDimension {
  id: string;
  name: string;
  score: number;
  weight: number;
  key_finding: string;
}

export interface AgentScorecard {
  overall_score: number;
  dimensions: AgentScorecardDimension[];
}

export interface AgentReport {
  recommendation: string;
  recommendation_rationale: string;
  executive_summary: string[];
  findings: AgentFinding[];
  scorecard: AgentScorecard;
  data_gaps: string[];
}

export interface TrrcAgentContext {
  // Discovered identifiers
  api_numbers: string[];
  district: string | null;
  lease_number: string | null;
  operator_name: string | null;
  operator_number: string | null;
  county: string | null;

  // Raw collected data (for PDF report assembly)
  production: unknown[];
  completions: unknown[];
  inactive_wells: unknown[];
  plugging_records: unknown[];
  p4_records: unknown[];
  well_statuses: unknown[];
  orphan_records: unknown[];
  severance_records: unknown[];
  compliance_violations: unknown[];
  compliance_inspections: unknown[];
  proration_records: unknown[];
  injection_records: unknown[];
  imaged_records: unknown[];
  p5_record: unknown | null;
  operator_profile: unknown | null;

  // Final synthesis from submit_report
  agentReport: AgentReport | null;
}

export function makeEmptyTrrcAgentContext(): TrrcAgentContext {
  return {
    api_numbers: [],
    district: null,
    lease_number: null,
    operator_name: null,
    operator_number: null,
    county: null,

    production: [],
    completions: [],
    inactive_wells: [],
    plugging_records: [],
    p4_records: [],
    well_statuses: [],
    orphan_records: [],
    severance_records: [],
    compliance_violations: [],
    compliance_inspections: [],
    proration_records: [],
    injection_records: [],
    imaged_records: [],
    p5_record: null,
    operator_profile: null,

    agentReport: null,
  };
}

// ─── Tool result type ─────────────────────────────────────────────────────────

export type TrrcToolResult = {
  ok: boolean;
  data: unknown;
  summary: string;
};

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleTrrcToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  switch (toolName) {
    case "search_by_api":
      return handleSearchByApi(toolInput, ctx);
    case "search_by_lease":
      return handleSearchByLease(toolInput, ctx);
    case "search_by_operator":
      return handleSearchByOperator(toolInput, ctx);
    case "search_by_legal_description":
      return handleSearchByLegalDescription(toolInput, ctx);
    case "fetch_production":
      return handleFetchProduction(toolInput, ctx);
    case "fetch_completion_records":
      return handleFetchCompletionRecords(toolInput, ctx);
    case "fetch_inactive_well_status":
      return handleFetchInactiveWellStatus(toolInput, ctx);
    case "fetch_plugging_records":
      return handleFetchPluggingRecords(toolInput, ctx);
    case "fetch_p4_records":
      return handleFetchP4Records(toolInput, ctx);
    case "fetch_well_status":
      return handleFetchWellStatus(toolInput, ctx);
    case "fetch_orphan_well_status":
      return handleFetchOrphanWellStatus(toolInput, ctx);
    case "fetch_severance_records":
      return handleFetchSeveranceRecords(toolInput, ctx);
    case "fetch_compliance_violations":
      return handleFetchComplianceViolations(toolInput, ctx);
    case "fetch_proration":
      return handleFetchProration(toolInput, ctx);
    case "fetch_injection_records":
      return handleFetchInjectionRecords(toolInput, ctx);
    case "fetch_imaged_records":
      return handleFetchImagedRecords(toolInput, ctx);
    case "submit_report":
      return handleSubmitReport(toolInput, ctx);
    default:
      return { ok: false, data: { error: `Unknown tool: ${toolName}` }, summary: `Unknown tool: ${toolName}` };
  }
}

// ─── Individual handlers ──────────────────────────────────────────────────────

async function handleSearchByApi(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) {
    return { ok: false, data: { error: "api_number required" }, summary: "search_by_api: no input" };
  }

  try {
    const result = await lookupTrrcLeasesByApis(null, [apiRaw]);
    if (result.size === 0) {
      return {
        ok: true,
        data: {
          found: false,
          api_number: apiRaw,
          message: `API ${apiRaw} was NOT FOUND in the TRRC PDQ database. Verify the API number — this may indicate an incorrect or invalid API.`,
        },
        summary: `search_by_api: ${apiRaw} — NOT FOUND in TRRC`,
      };
    }

    const entries = Array.from(result.entries());
    const [key, val] = entries[0];

    // Update context identifiers
    if (!ctx.api_numbers.includes(key)) ctx.api_numbers.push(key);
    if (!ctx.district && val.distCode) ctx.district = val.distCode;
    if (!ctx.lease_number && val.leaseNo) ctx.lease_number = val.leaseNo;
    if (!ctx.operator_name && val.operator) ctx.operator_name = val.operator;

    return {
      ok: true,
      data: {
        found: true,
        api_number: key,
        lease_number: val.leaseNo,
        district: val.distCode,
        operator: val.operator,
      },
      summary: `search_by_api: ${apiRaw} → Lease ${val.leaseNo} / District ${val.distCode} / Operator: ${val.operator}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_api: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleSearchByLease(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const leaseNo = String(input.lease_number ?? "").trim();
  const distCode = String(input.district ?? "").trim();

  if (!leaseNo || !distCode) {
    return { ok: false, data: { error: "lease_number and district required" }, summary: "search_by_lease: missing inputs" };
  }

  try {
    const inv = await fetchLeaseWellInventory(distCode, leaseNo);

    if (!ctx.lease_number) ctx.lease_number = leaseNo;
    if (!ctx.district) ctx.district = distCode;

    if (!inv || inv.wells.length === 0) {
      return {
        ok: true,
        data: {
          found: false,
          lease_number: leaseNo,
          district: distCode,
          message: `No well inventory found for Lease ${leaseNo} / District ${distCode}. Verify district code.`,
        },
        summary: `search_by_lease: Lease ${leaseNo} / District ${distCode} — no inventory`,
      };
    }

    // Accumulate API numbers into context
    for (const w of inv.wells) {
      if (w.api10 && !ctx.api_numbers.includes(w.api10)) {
        ctx.api_numbers.push(w.api10);
      }
    }

    const active = inv.wells.filter((w) => w.status === "A" || w.status === "active").length;
    const inactive = inv.wells.length - active;

    return {
      ok: true,
      data: {
        found: true,
        lease_number: leaseNo,
        district: distCode,
        total_wells: inv.wells.length,
        active_wells: active,
        inactive_wells: inactive,
        wells: inv.wells.slice(0, 30).map((w) => ({
          api10: w.api10,
          well_number: w.well_number,
          well_type: w.well_type,
          status: w.status,
        })),
        note: inv.wells.length > 30 ? `Showing first 30 of ${inv.wells.length} wells` : undefined,
      },
      summary: `search_by_lease: Lease ${leaseNo} — ${inv.wells.length} wells (${active} active, ${inactive} inactive)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_lease: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleSearchByOperator(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const opName = input.operator_name ? String(input.operator_name).trim() : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    let p5 = null;
    let profile = null;

    if (opNo) {
      p5 = await fetchTrrcP5ByOperatorNo(opNo).catch(() => null);
    }
    if (!p5 && opName) {
      p5 = await fetchTrrcP5ByOperatorName(opName).catch(() => null);
    }
    if (opName) {
      profile = await fetchTrrcOperatorProfile(opName).catch(() => null);
    }

    if (p5) {
      ctx.p5_record = p5;
      if (!ctx.operator_number) ctx.operator_number = p5.operator_no;
      if (!ctx.operator_name) ctx.operator_name = p5.operator_name;
    }
    if (profile) {
      ctx.operator_profile = profile;
    }

    if (!p5 && !profile) {
      return {
        ok: true,
        data: { found: false, message: `No P-5 record found for operator "${opName ?? opNo}". Operator may be inactive or using a different name in TRRC.` },
        summary: `search_by_operator: "${opName ?? opNo}" — no record found`,
      };
    }

    return {
      ok: true,
      data: {
        found: true,
        operator_name: p5?.operator_name ?? opName,
        operator_no: p5?.operator_no,
        org_status: p5?.org_status,
        tnr_91114: p5?.tnr_91114 ?? false,
        mail_hold: p5?.mail_hold ?? false,
        bond_type: (profile as { bond_type?: string } | null)?.bond_type ?? null,
        bond_amount_usd: (profile as { bond_amount_usd?: number } | null)?.bond_amount_usd ?? null,
        p5_status: (profile as { p5_status?: string } | null)?.p5_status ?? null,
      },
      summary: `search_by_operator: "${p5?.operator_name ?? opName}" — org_status: ${p5?.org_status ?? "unknown"}${p5?.tnr_91114 ? " [TNR91114 FLAG]" : ""}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_operator: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleSearchByLegalDescription(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const county  = input.county        ? String(input.county)        : null;
  const section = input.section       ? String(input.section)       : null;

  const params: Parameters<typeof lookupWellsByLegalDescription>[0] = {
    abstract_number: input.abstract_number ? String(input.abstract_number) : null,
    survey_name:     input.survey_name     ? String(input.survey_name)     : null,
    county,
    state: "Texas",
    block: null,
    section,
  };

  if (!ctx.county && county) ctx.county = county;

  try {
    const result = await lookupWellsByLegalDescription(params);

    if (!result || !result.api_numbers || result.api_numbers.length === 0) {
      return {
        ok: true,
        data: { found: false, params, message: "No wells found within the described parcel via GIS lookup." },
        summary: "search_by_legal_description: no wells found in parcel",
      };
    }

    for (const api of result.api_numbers) {
      if (!ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
    }

    return {
      ok: true,
      data: {
        found: true,
        api_numbers: result.api_numbers,
        count: result.api_numbers.length,
        params,
      },
      summary: `search_by_legal_description: found ${result.api_numbers.length} API(s) in described parcel`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_by_legal_description: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchProduction(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const leaseNo  = input.lease_number ? String(input.lease_number).trim() : null;
  const distCode = input.district     ? String(input.district).trim()     : null;
  const apiNum   = input.api_number   ? String(input.api_number).trim()   : null;
  const months   = input.months       ? Number(input.months)               : 36;

  try {
    if (leaseNo && distCode) {
      const result = await fetchTrrcProductionByLease(distCode, leaseNo, months);
      if (!result || result.rows.length === 0) {
        return {
          ok: true,
          data: { found: false, lease_number: leaseNo, district: distCode, message: `No production data for Lease ${leaseNo} / District ${distCode}. Try a different district code.` },
          summary: `fetch_production: Lease ${leaseNo} / District ${distCode} — no data`,
        };
      }

      ctx.production = [...ctx.production, ...result.rows];
      if (!ctx.lease_number) ctx.lease_number = leaseNo;
      if (!ctx.district) ctx.district = distCode;

      const totalOil = result.rows.reduce((s, r) => s + (r.oil_bbl ?? 0), 0);
      const totalGas = result.rows.reduce((s, r) => s + (r.gas_mcf ?? 0), 0);
      const recent3  = result.rows.slice(-3);
      const avg3Oil  = recent3.length ? recent3.reduce((s, r) => s + (r.oil_bbl ?? 0), 0) / recent3.length : 0;

      return {
        ok: true,
        data: {
          found: true,
          source: "lease",
          lease_number: leaseNo,
          district: distCode,
          months_of_data: result.rows.length,
          total_oil_bbl: Math.round(totalOil),
          total_gas_mcf: Math.round(totalGas),
          three_month_avg_oil_bbl: Math.round(avg3Oil),
          monthly_rows: result.rows.slice(-24).map((r) => ({
            period: `${r.year}-${String(r.month).padStart(2, "0")}`,
            oil_bbl: r.oil_bbl ?? 0,
            gas_mcf: r.gas_mcf ?? 0,
          })),
        },
        summary: `fetch_production: Lease ${leaseNo} — ${Math.round(totalOil).toLocaleString()} BBL total, ${Math.round(avg3Oil)} BBL/mo (3-mo avg)`,
      };
    }

    if (apiNum) {
      const result = await fetchTrrcProductionHistory(apiNum, months);
      if (!result || result.rows.length === 0) {
        return {
          ok: true,
          data: { found: false, api_number: apiNum, message: "No production data found for this API" },
          summary: `fetch_production: API ${apiNum} — no data`,
        };
      }

      ctx.production = [...ctx.production, ...result.rows];
      if (!ctx.api_numbers.includes(apiNum)) ctx.api_numbers.push(apiNum);

      const totalOil = result.rows.reduce((s, r) => s + (r.oil_bbl ?? 0), 0);
      const avg3Oil  = result.rows.slice(-3).reduce((s, r) => s + (r.oil_bbl ?? 0), 0) / Math.min(result.rows.length, 3);

      return {
        ok: true,
        data: {
          found: true,
          source: "api",
          api_number: apiNum,
          months_of_data: result.rows.length,
          total_oil_bbl: Math.round(totalOil),
          three_month_avg_oil_bbl: Math.round(avg3Oil),
          monthly_rows: result.rows.slice(-24).map((r) => ({
            period: `${r.year}-${String(r.month).padStart(2, "0")}`,
            oil_bbl: r.oil_bbl ?? 0,
            gas_mcf: r.gas_mcf ?? 0,
          })),
        },
        summary: `fetch_production: API ${apiNum} — ${Math.round(totalOil).toLocaleString()} BBL total`,
      };
    }

    return {
      ok: false,
      data: { error: "Provide either (lease_number + district) or api_number" },
      summary: "fetch_production: missing required parameters",
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_production: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchCompletionRecords(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? [];
  if (apis.length === 0) {
    return { ok: false, data: { error: "api_numbers array required" }, summary: "fetch_completion_records: no APIs" };
  }

  try {
    const result = await fetchTrrcCompletionsForApis(apis);
    ctx.completions = [...ctx.completions, ...result];

    if (result.length === 0) {
      return {
        ok: true,
        data: { found: false, message: "No completion records found for provided APIs" },
        summary: "fetch_completion_records: no records found",
      };
    }

    return {
      ok: true,
      data: {
        found: true,
        count: result.length,
        completions: result.slice(0, 5).map((c) => ({
          api: c.api,
          formation: c.formation,
          total_depth_ft: c.total_depth_ft,
          completion_date: c.completion_date,
          wellbore_profile: c.wellbore_profile,
          lease_name: c.lease_name,
        })),
      },
      summary: `fetch_completion_records: ${result.length} record(s) — formation: ${result[0]?.formation ?? "unknown"}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_completion_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchInactiveWellStatus(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum  = input.api_number    ? String(input.api_number).trim()    : null;
  const opNo    = input.operator_number ? String(input.operator_number).trim() : null;
  const leaseType = (input.lease_type as "O" | "G" | undefined) ?? "O";

  try {
    if (apiNum) {
      const result = await fetchTrrcInactiveWellByApi(apiNum);
      ctx.inactive_wells = [...ctx.inactive_wells, result];
      // is_active_not_flagged = true means NOT on inactive list (i.e. still active)
      const isInactive = !result.is_active_not_flagged && result.records.length > 0;
      return {
        ok: true,
        data: { api_number: apiNum, is_inactive: isInactive, records: result.records },
        summary: `fetch_inactive_well_status: API ${apiNum} — ${isInactive ? "INACTIVE (on EWA list)" : "not on inactive list"}`,
      };
    }

    if (opNo) {
      const results = await fetchTrrcInactiveWellsByOperator(opNo, leaseType);
      ctx.inactive_wells = [...ctx.inactive_wells, ...results];
      return {
        ok: true,
        data: { operator_number: opNo, lease_type: leaseType, count: results.length, wells: results.slice(0, 20) },
        summary: `fetch_inactive_well_status: operator ${opNo} — ${results.length} inactive ${leaseType === "O" ? "oil" : "gas"} wells`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_inactive_well_status: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_inactive_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchPluggingRecords(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

  try {
    if (apiNum) {
      const result = await fetchTrrcPluggingByApi(apiNum);
      ctx.plugging_records = [...ctx.plugging_records, ...result];
      return {
        ok: true,
        data: { api_number: apiNum, count: result.length, records: result },
        summary: `fetch_plugging_records: API ${apiNum} — ${result.length} plugging record(s)`,
      };
    }

    if (leaseNo && dist) {
      const result = await fetchTrrcPluggingByLease(dist, leaseNo);
      ctx.plugging_records = [...ctx.plugging_records, ...result];
      return {
        ok: true,
        data: { lease_number: leaseNo, district: dist, count: result.length, records: result },
        summary: `fetch_plugging_records: Lease ${leaseNo} — ${result.length} plugging record(s)`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_plugging_records: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_plugging_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchP4Records(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

  try {
    if (apiNum) {
      const result = await fetchTrrcP4ByApi(apiNum);
      ctx.p4_records = [...ctx.p4_records, ...result];
      return {
        ok: true,
        data: { api_number: apiNum, count: result.length, records: result.slice(0, 5) },
        summary: `fetch_p4_records: API ${apiNum} — ${result.length} P-4 record(s)`,
      };
    }

    if (leaseNo && dist) {
      const result = await fetchTrrcP4ByLease(dist, leaseNo);
      ctx.p4_records = [...ctx.p4_records, ...result];
      return {
        ok: true,
        data: { lease_number: leaseNo, district: dist, count: result.length, records: result.slice(0, 10) },
        summary: `fetch_p4_records: Lease ${leaseNo} — ${result.length} P-4 record(s)`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_p4_records: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_p4_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchWellStatus(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum  = input.api_number   ? String(input.api_number).trim()   : null;
  const leaseNo = input.lease_number ? String(input.lease_number).trim() : null;
  const dist    = input.district     ? String(input.district).trim()     : null;

  try {
    if (apiNum) {
      const result = await fetchTrrcWellStatus(apiNum);
      ctx.well_statuses = [...ctx.well_statuses, ...result];
      const statuses = result.map((r) => r.current_status ?? "unknown").join(", ") || "no status records";
      return {
        ok: true,
        data: { api_number: apiNum, count: result.length, statuses: result },
        summary: `fetch_well_status: API ${apiNum} — ${statuses}`,
      };
    }

    if (leaseNo && dist) {
      const result = await fetchTrrcWellStatusByLease(dist, leaseNo);
      ctx.well_statuses = [...ctx.well_statuses, ...result];
      return {
        ok: true,
        data: { lease_number: leaseNo, district: dist, count: result.length, statuses: result.slice(0, 20) },
        summary: `fetch_well_status: Lease ${leaseNo} — ${result.length} well status record(s)`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or (lease_number + district)" }, summary: "fetch_well_status: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchOrphanWellStatus(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum = String(input.api_number ?? "").trim();
  if (!apiNum) {
    return { ok: false, data: { error: "api_number required" }, summary: "fetch_orphan_well_status: no input" };
  }

  try {
    const result = await fetchTrrcOrphanWellByApi(apiNum);
    ctx.orphan_records = [...ctx.orphan_records, ...result];
    const isOrphan = result.length > 0;

    return {
      ok: true,
      data: { api_number: apiNum, is_orphan: isOrphan, count: result.length, records: result },
      summary: `fetch_orphan_well_status: API ${apiNum} — ${isOrphan ? `ORPHAN (${result.length} records)` : "not on orphan list"}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_orphan_well_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchSeveranceRecords(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    if (apiNum) {
      const result = await fetchTrrcSeveranceByApi(apiNum);
      ctx.severance_records = [...ctx.severance_records, ...result];
      return {
        ok: true,
        data: { api_number: apiNum, count: result.length, records: result },
        summary: `fetch_severance_records: API ${apiNum} — ${result.length} severance record(s)`,
      };
    }

    if (opNo) {
      const result = await fetchTrrcSeveranceByOperator(opNo);
      ctx.severance_records = [...ctx.severance_records, ...result];
      return {
        ok: true,
        data: { operator_number: opNo, count: result.length, records: result.slice(0, 20) },
        summary: `fetch_severance_records: operator ${opNo} — ${result.length} severance record(s)`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_severance_records: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_severance_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchComplianceViolations(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const opNo      = input.operator_number ? String(input.operator_number).trim() : null;
  const opName    = input.operator_name   ? String(input.operator_name).trim()   : null;
  const county    = input.county          ? String(input.county).trim()          : null;
  const apiNums   = (input.api_numbers as string[] | undefined) ?? [];

  if (opNo && !ctx.operator_number) ctx.operator_number = opNo;

  try {
    let violations: unknown[] = [];
    let queryMethod = "";

    if (opNo) {
      violations = await fetchTrrcViolations(opNo, null, county);
      queryMethod = `operator number ${opNo}`;
    } else if (opName) {
      violations = await fetchTrrcViolationsByOperator(opName, county ?? undefined);
      queryMethod = `operator name "${opName}"`;
    } else {
      return {
        ok: false,
        data: { error: "Provide operator_number or operator_name" },
        summary: "fetch_compliance_violations: no operator identifier",
      };
    }

    ctx.compliance_violations = [...ctx.compliance_violations, ...violations];

    // Fetch inspection records for up to 3 APIs
    const inspections: unknown[] = [];
    for (const api of apiNums.slice(0, 3)) {
      const recs = await fetchTrrcInspectionsByApi(api).catch(() => []);
      inspections.push(...recs);
    }
    ctx.compliance_inspections = [...ctx.compliance_inspections, ...inspections];

    if (violations.length === 0) {
      return {
        ok: true,
        data: {
          found_violations: false,
          query_method: queryMethod,
          inspection_count: inspections.length,
          important_note:
            "Zero violations returned. This may mean a clean record OR an incorrect identifier / failed query. " +
            "Do NOT report as confirmed clean compliance without noting this uncertainty.",
        },
        summary: `fetch_compliance_violations: 0 violations via ${queryMethod} (unconfirmed — may be query miss)`,
      };
    }

    const open = (violations as Array<{ status?: string }>).filter((v) => v.status === "open");
    return {
      ok: true,
      data: {
        found_violations: true,
        query_method: queryMethod,
        total_violations: violations.length,
        open_violations: open.length,
        closed_violations: violations.length - open.length,
        inspection_count: inspections.length,
        violations: violations.slice(0, 10),
      },
      summary: `fetch_compliance_violations: ${open.length} open / ${violations.length} total violations via ${queryMethod}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_compliance_violations: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchProration(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  // fetchTrrcOilProration/fetchTrrcGasProration take api10 + distCode
  // Use the first known API number from context as the proration target
  const leaseNo   = String(input.lease_number ?? "").trim();
  const leaseType = (input.lease_type as "oil" | "gas" | undefined) ?? "oil";
  const distCode  = input.district ? String(input.district).trim() : (ctx.district ?? "");
  const api10     = ctx.api_numbers[0] ?? leaseNo;

  if (!api10) {
    return { ok: false, data: { error: "No api10 available for proration query. Search for a well first." }, summary: "fetch_proration: no api10 available" };
  }
  if (!distCode) {
    return { ok: false, data: { error: "district required for proration query" }, summary: "fetch_proration: missing district" };
  }

  try {
    const result =
      leaseType === "gas"
        ? await fetchTrrcGasProration(api10, distCode)
        : await fetchTrrcOilProration(api10, distCode);

    ctx.proration_records = [...ctx.proration_records, ...result];

    return {
      ok: true,
      data: { api10, district: distCode, lease_type: leaseType, count: result.length, records: result.slice(0, 10) },
      summary: `fetch_proration: API ${api10} (${leaseType}) — ${result.length} proration record(s)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_proration: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchInjectionRecords(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apiNum = input.api_number      ? String(input.api_number).trim()      : null;
  const opNo   = input.operator_number ? String(input.operator_number).trim() : null;

  try {
    if (apiNum) {
      const result = await fetchTrrcInjectionByApi(apiNum);
      ctx.injection_records = [...ctx.injection_records, ...result];
      return {
        ok: true,
        data: { api_number: apiNum, count: result.length, records: result },
        summary: `fetch_injection_records: API ${apiNum} — ${result.length} injection record(s)`,
      };
    }

    if (opNo) {
      // fetchTrrcInjectionByOperator takes operatorName (not number) — use name from context if available
      const opName = ctx.operator_name ?? opNo;
      const county = ctx.county ?? "";
      const result = await fetchTrrcInjectionByOperator(opName, county);
      ctx.injection_records = [...ctx.injection_records, ...result];
      return {
        ok: true,
        data: { operator_number: opNo, operator_name: opName, count: result.length, records: result.slice(0, 20) },
        summary: `fetch_injection_records: operator "${opName}" — ${result.length} injection record(s)`,
      };
    }

    return { ok: false, data: { error: "Provide api_number or operator_number" }, summary: "fetch_injection_records: missing input" };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_injection_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchImagedRecords(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? [];
  if (apis.length === 0) {
    return { ok: false, data: { error: "api_numbers array required" }, summary: "fetch_imaged_records: no APIs" };
  }

  try {
    const results = await fetchTrrcImagedRecordsMulti(apis);
    ctx.imaged_records = [...ctx.imaged_records, ...results];

    const totalDocs = results.reduce((s, r) => s + (r.records?.length ?? 0), 0);
    return {
      ok: true,
      data: { apis_queried: apis.length, total_documents: totalDocs, results },
      summary: `fetch_imaged_records: ${apis.length} API(s) — ${totalDocs} document(s) found`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_imaged_records: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleSubmitReport(
  input: Record<string, unknown>,
  ctx: TrrcAgentContext,
): Promise<TrrcToolResult> {
  ctx.agentReport = {
    recommendation:           String(input.recommendation ?? "review"),
    recommendation_rationale: String(input.recommendation_rationale ?? ""),
    executive_summary:        (input.executive_summary as string[]) ?? [],
    findings:                 (input.findings as AgentFinding[]) ?? [],
    scorecard:                (input.scorecard as AgentScorecard) ?? { overall_score: 0, dimensions: [] },
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
