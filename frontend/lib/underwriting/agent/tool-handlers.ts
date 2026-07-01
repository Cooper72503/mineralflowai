/**
 * Agent tool handlers — maps each tool name to a function that queries TRRC
 * and returns a result for Claude plus side-effects on the AgentContext.
 */

import { lookupTrrcLeasesByApis }                        from "@/lib/wells/trrc-api";
import { fetchTrrcProductionByLease, fetchTrrcProductionHistory } from "@/lib/wells/trrc-production";
import { fetchTrrcViolations, fetchTrrcViolationsByOperator }    from "@/lib/underwriting/trrc-compliance";
import { fetchTrrcInspectionsByApi }                     from "@/lib/wells/trrc-inspection";
import { fetchTrrcCompletionsForApis }                   from "@/lib/wells/trrc-completions";
import { fetchTrrcP5ByOperatorNo, fetchTrrcP5ByOperatorName }   from "@/lib/underwriting/trrc-p5";
import { fetchLeaseWellInventory }                        from "@/lib/underwriting/trrc-lease-inventory";
import { fetchTrrcOperatorProfile }                       from "@/lib/wells/trrc-operator-profile";
import type { TrrcMonthlyRow }                            from "@/lib/wells/trrc-production";
import type { TrrcViolation }                             from "@/lib/underwriting/trrc-compliance";
import type { TrrcInspectionRecord }                      from "@/lib/wells/trrc-inspection";
import type { TrrcP5Record }                              from "@/lib/underwriting/trrc-p5";
import type { LeaseWellInventoryResult }                  from "@/lib/underwriting/trrc-lease-inventory";
import type { TrrcOperatorProfile }                       from "@/lib/wells/trrc-operator-profile";
import type { TrrcCompletionRecord }                      from "@/lib/wells/trrc-completions";

// ── Accumulated TRRC data from all tool calls ─────────────────────────────────

export interface AgentContext {
  // Production
  trrcProductionRows:    TrrcMonthlyRow[];
  trrcDistCode:          string | null;
  trrcLeaseNo:           string | null;

  // Wells
  leaseWellInventory:    LeaseWellInventoryResult | null;
  verifiedApis:          string[];   // APIs confirmed to exist in TRRC
  invalidApis:           string[];   // APIs seller provided that don't exist

  // Compliance
  trrcViolations:        TrrcViolation[];
  trrcInspections:       TrrcInspectionRecord[];
  complianceQueried:     boolean;    // whether a compliance query was actually attempted

  // Operator
  trrcOperatorProfile:   TrrcOperatorProfile | null;
  trrcP5Status:          TrrcP5Record | null;
  operatorNumber:        string | null;

  // Completions
  trrcCompletions:       TrrcCompletionRecord[];

  // Agent's final assessment (set when submit_report is called)
  agentAssessment:       AgentAssessment | null;
}

export interface AgentAssessment {
  recommendation:           "pursue" | "review" | "pass";
  recommendation_rationale: string;
  risk_score:               number;
  ic_memo_paragraphs:       string[];
  seller_claim_crosschecks: Array<{
    claim:        string;
    trrc_finding: string;
    verdict:      "confirmed" | "contradicted" | "unverified" | "misleading";
    severity:     "critical" | "warning" | "info";
  }>;
  top_risks:    string[];
  value_drivers: string[];
  red_flags:    string[];
  data_gaps:    string[];
}

export function makeEmptyContext(): AgentContext {
  return {
    trrcProductionRows:  [],
    trrcDistCode:        null,
    trrcLeaseNo:         null,
    leaseWellInventory:  null,
    verifiedApis:        [],
    invalidApis:         [],
    trrcViolations:      [],
    trrcInspections:     [],
    complianceQueried:   false,
    trrcOperatorProfile: null,
    trrcP5Status:        null,
    operatorNumber:      null,
    trrcCompletions:     [],
    agentAssessment:     null,
  };
}

// ── Tool handler map ──────────────────────────────────────────────────────────

export type ToolResult = {
  ok: boolean;
  data: unknown;
  summary: string; // one-line for SSE progress display
};

export async function handleToolCall(
  toolName:  string,
  toolInput: Record<string, unknown>,
  ctx:       AgentContext,
): Promise<ToolResult> {
  switch (toolName) {
    case "verify_api":
      return handleVerifyApi(toolInput, ctx);
    case "fetch_production_by_lease":
      return handleFetchProductionByLease(toolInput, ctx);
    case "fetch_wellbore_count":
      return handleFetchWellboreCount(toolInput, ctx);
    case "fetch_operator_compliance":
      return handleFetchCompliance(toolInput, ctx);
    case "fetch_p5_status":
      return handleFetchP5(toolInput, ctx);
    case "fetch_completions":
      return handleFetchCompletions(toolInput, ctx);
    case "fetch_production_by_api":
      return handleFetchProductionByApi(toolInput, ctx);
    case "search_operator_leases":
      return handleSearchOperatorLeases(toolInput, ctx);
    case "submit_report":
      return handleSubmitReport(toolInput, ctx);
    default:
      return { ok: false, data: null, summary: `Unknown tool: ${toolName}` };
  }
}

// ── Individual handlers ────────────────────────────────────────────────────────

async function handleVerifyApi(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) return { ok: false, data: { found: false, error: "No API number provided" }, summary: "verify_api: no input" };

  try {
    const result = await lookupTrrcLeasesByApis(null, [apiRaw]);
    if (result.size === 0) {
      ctx.invalidApis.push(apiRaw);
      return {
        ok: true,
        data: {
          found: false,
          api_number: apiRaw,
          message: `API ${apiRaw} was NOT FOUND in the TRRC database. This is a red flag — the seller may have provided an incorrect or fabricated API number.`,
        },
        summary: `verify_api: ${apiRaw} — NOT FOUND in TRRC (red flag)`,
      };
    }
    const entries = Array.from(result.entries());
    const [key, val] = entries[0];
    ctx.verifiedApis.push(key);
    return {
      ok: true,
      data: {
        found: true,
        api_number: apiRaw,
        trrc_api: key,
        lease_number: val.leaseNo,
        district: val.distCode,
        operator: val.operator,
        message: `API ${apiRaw} confirmed in TRRC. Lease ${val.leaseNo}, District ${val.distCode}, Operator: ${val.operator}`,
      },
      summary: `verify_api: ${apiRaw} → Lease ${val.leaseNo} / District ${val.distCode}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `verify_api: query failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchProductionByLease(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const leaseNo = String(input.lease_number ?? "").trim();
  const distCode = String(input.district ?? "").trim();
  if (!leaseNo || !distCode) {
    return { ok: false, data: { error: "lease_number and district required" }, summary: "fetch_production_by_lease: missing inputs" };
  }

  try {
    const result = await fetchTrrcProductionByLease(distCode, leaseNo, 36);
    if (!result || result.rows.length === 0) {
      return {
        ok: true,
        data: {
          found: false,
          lease_number: leaseNo,
          district: distCode,
          message: `No production data returned from TRRC for Lease ${leaseNo} / District ${distCode}. The lease may not exist under this district code, or may have no recorded production. Try a different district code.`,
        },
        summary: `fetch_production_by_lease: Lease ${leaseNo} / District ${distCode} — no data`,
      };
    }

    // Accumulate into context
    ctx.trrcProductionRows = result.rows;
    ctx.trrcDistCode = result.distCode;
    ctx.trrcLeaseNo  = result.leaseNo;

    const totalOil  = result.rows.reduce((s, r) => s + (r.oil_bbl ?? 0), 0);
    const totalGas  = result.rows.reduce((s, r) => s + (r.gas_mcf ?? 0), 0);
    const recent3   = result.rows.slice(-3);
    const avg3Oil   = recent3.length ? recent3.reduce((s, r) => s + (r.oil_bbl ?? 0), 0) / recent3.length : 0;
    const recent12  = result.rows.slice(-12);
    const avg12Oil  = recent12.length ? recent12.reduce((s, r) => s + (r.oil_bbl ?? 0), 0) / recent12.length : 0;

    return {
      ok: true,
      data: {
        found: true,
        lease_number: leaseNo,
        district: distCode,
        months_of_data: result.rows.length,
        total_oil_bbl: Math.round(totalOil),
        total_gas_mcf: Math.round(totalGas),
        three_month_avg_oil_bbl: Math.round(avg3Oil),
        twelve_month_avg_oil_bbl: Math.round(avg12Oil),
        monthly_rows: result.rows.slice(-24).map(r => ({
          period: `${r.year}-${String(r.month).padStart(2, "0")}`,
          oil_bbl: r.oil_bbl ?? 0,
          gas_mcf: r.gas_mcf ?? 0,
        })),
      },
      summary: `fetch_production_by_lease: Lease ${leaseNo} — ${Math.round(totalOil).toLocaleString()} BBL total, ${Math.round(avg3Oil)} BBL/mo (3-mo avg)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_production_by_lease: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchWellboreCount(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const leaseNo  = String(input.lease_number ?? "").trim();
  const distCode = String(input.district ?? "").trim();

  try {
    const inv = await fetchLeaseWellInventory(distCode, leaseNo);
    ctx.leaseWellInventory = inv;

    if (!inv || inv.wells.length === 0) {
      return {
        ok: true,
        data: {
          found: false,
          message: `No well inventory found for Lease ${leaseNo} / District ${distCode}. Verify the lease number and district code.`,
        },
        summary: `fetch_wellbore_count: Lease ${leaseNo} — no inventory found`,
      };
    }

    const activeWells   = inv.wells.filter(w => w.status === "A" || w.status === "active");
    const inactiveWells = inv.wells.filter(w => w.status !== "A" && w.status !== "active");

    return {
      ok: true,
      data: {
        found: true,
        lease_number: leaseNo,
        district: distCode,
        total_well_count: inv.wells.length,
        active_wells:   activeWells.length,
        inactive_wells: inactiveWells.length,
        wells: inv.wells.slice(0, 20).map(w => ({
          api:    w.api10,
          number: w.well_number,
          type:   w.well_type,
          status: w.status,
        })),
        note: inv.wells.length > 20 ? `Showing first 20 of ${inv.wells.length} wells` : undefined,
      },
      summary: `fetch_wellbore_count: Lease ${leaseNo} — ${inv.wells.length} wells (${activeWells.length} active)`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_wellbore_count: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchCompliance(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const operatorName   = input.operator_name   ? String(input.operator_name).trim()   : null;
  const operatorNumber = input.operator_number ? String(input.operator_number).trim() : null;
  const county         = input.county          ? String(input.county).trim()          : null;

  ctx.complianceQueried = true;
  if (operatorNumber) ctx.operatorNumber = operatorNumber;

  try {
    let violations: TrrcViolation[] = [];
    const inspections: TrrcInspectionRecord[] = [];
    let queryMethod = "";

    if (operatorNumber) {
      violations = await fetchTrrcViolations(operatorNumber, null, county);
      queryMethod = `operator number ${operatorNumber}`;
    } else if (operatorName) {
      violations = await fetchTrrcViolationsByOperator(operatorName, county ?? undefined);
      queryMethod = `operator name "${operatorName}"`;
    } else {
      return {
        ok: false,
        data: { error: "Must provide operator_name or operator_number" },
        summary: "fetch_operator_compliance: no operator identifier provided",
      };
    }

    // Also fetch inspections if we have verified APIs
    if (ctx.verifiedApis.length > 0) {
      for (const api of ctx.verifiedApis.slice(0, 3)) {
        const recs = await fetchTrrcInspectionsByApi(api).catch(() => []);
        inspections.push(...recs);
      }
    }

    ctx.trrcViolations  = violations;
    ctx.trrcInspections = inspections;

    const openViolations   = violations.filter(v => v.status === "open");
    const closedViolations = violations.filter(v => v.status !== "open");

    if (violations.length === 0) {
      return {
        ok: true,
        data: {
          found_violations: false,
          query_method: queryMethod,
          important_note: "The query returned zero violations. This may mean the operator has a clean record, OR it may mean the query used an incorrect identifier and returned no results. Do NOT report this as 'clean compliance' without noting this uncertainty.",
          inspection_count: inspections.length,
        },
        summary: `fetch_operator_compliance: 0 violations via ${queryMethod} (unconfirmed — may be query miss)`,
      };
    }

    return {
      ok: true,
      data: {
        found_violations: true,
        query_method: queryMethod,
        open_violations:   openViolations.length,
        closed_violations: closedViolations.length,
        total_violations:  violations.length,
        inspection_count:  inspections.length,
        recent_violations: violations.slice(0, 10).map(v => ({
          id:          v.violation_id,
          date:        v.date,
          type:        v.type,
          description: v.description,
          status:      v.status,
          penalty_usd: v.penalty_usd,
        })),
        non_compliant_inspections: inspections.filter(i => i.result === "non_compliant").length,
      },
      summary: `fetch_operator_compliance: ${openViolations.length} open violations, ${violations.length} total — via ${queryMethod}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_operator_compliance: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchP5(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const opNum  = input.operator_number ? String(input.operator_number).trim() : null;
  const opName = input.operator_name   ? String(input.operator_name).trim()   : null;

  try {
    let p5: TrrcP5Record | null = null;
    if (opNum)  p5 = await fetchTrrcP5ByOperatorNo(opNum).catch(() => null);
    if (!p5 && opName) p5 = await fetchTrrcP5ByOperatorName(opName).catch(() => null);

    if (!p5) {
      return {
        ok: true,
        data: { found: false, message: "No P-5 record found. Operator may be inactive or using a different name in TRRC." },
        summary: "fetch_p5_status: no record found",
      };
    }
    ctx.trrcP5Status = p5;
    return {
      ok: true,
      data: {
        found:          true,
        operator_name:  p5.operator_name,
        operator_no:    p5.operator_no,
        org_status:     p5.org_status,
        tnr_91114:      p5.tnr_91114,
        mail_hold:      p5.mail_hold,
        mailing_state:  p5.mailing_state,
      },
      summary: `fetch_p5_status: ${p5.operator_name} — org_status: ${p5.org_status}${p5.tnr_91114 ? " ⚠️ TNR91114 FLAG" : ""}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_p5_status: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchCompletions(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const apis = (input.api_numbers as string[] | undefined) ?? [];
  if (apis.length === 0) {
    return { ok: false, data: { error: "api_numbers array required" }, summary: "fetch_completions: no APIs provided" };
  }

  try {
    const result = await fetchTrrcCompletionsForApis(apis);
    ctx.trrcCompletions = result;

    if (result.length === 0) {
      return {
        ok: true,
        data: { found: false, message: "No completion records found for provided APIs" },
        summary: "fetch_completions: no records found",
      };
    }

    return {
      ok: true,
      data: {
        found:      true,
        count:      result.length,
        completions: result.slice(0, 5).map(c => ({
          api:             c.api,
          formation:       c.formation,
          total_depth_ft:  c.total_depth_ft,
          completion_date: c.completion_date,
          wellbore_profile: c.wellbore_profile,
          lease_name:      c.lease_name,
        })),
      },
      summary: `fetch_completions: ${result.length} completion record(s) — formation: ${result[0]?.formation ?? "unknown"}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_completions: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleFetchProductionByApi(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const apiRaw = String(input.api_number ?? "").trim();
  if (!apiRaw) return { ok: false, data: { error: "api_number required" }, summary: "fetch_production_by_api: no input" };

  try {
    const result = await fetchTrrcProductionHistory(apiRaw, 36);
    if (!result || result.rows.length === 0) {
      return {
        ok: true,
        data: { found: false, api_number: apiRaw, message: "No production data found for this API" },
        summary: `fetch_production_by_api: ${apiRaw} — no data`,
      };
    }

    const totalOil = result.rows.reduce((s, r) => s + (r.oil_bbl ?? 0), 0);
    const avg3Oil  = result.rows.slice(-3).reduce((s, r) => s + (r.oil_bbl ?? 0), 0) / Math.min(result.rows.length, 3);

    // Merge into context if we don't already have lease-level data
    if (ctx.trrcProductionRows.length === 0) {
      ctx.trrcProductionRows = result.rows;
    }

    return {
      ok: true,
      data: {
        found:                    true,
        api_number:               apiRaw,
        months_of_data:           result.rows.length,
        total_oil_bbl:            Math.round(totalOil),
        three_month_avg_oil_bbl:  Math.round(avg3Oil),
        monthly_rows: result.rows.slice(-12).map(r => ({
          period:  `${r.year}-${String(r.month).padStart(2, "0")}`,
          oil_bbl: r.oil_bbl ?? 0,
          gas_mcf: r.gas_mcf ?? 0,
        })),
      },
      summary: `fetch_production_by_api: ${apiRaw} — ${Math.round(totalOil).toLocaleString()} BBL total`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `fetch_production_by_api: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleSearchOperatorLeases(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  const operatorName = String(input.operator_name ?? "").trim();

  try {
    const profile = await fetchTrrcOperatorProfile(operatorName);
    ctx.trrcOperatorProfile = profile;

    if (!profile) {
      return {
        ok: true,
        data: { found: false, message: `No P-5 profile found for operator "${operatorName}"` },
        summary: `search_operator_leases: "${operatorName}" — no profile found`,
      };
    }

    return {
      ok: true,
      data: {
        found:          true,
        operator_name:  profile.operator_name,
        p5_number:      profile.p5_number,
        p5_status:      profile.p5_status,
        bond_type:      profile.bond_type,
        bond_amount_usd: profile.bond_amount_usd,
        last_filed_date: profile.last_filed_date,
        note: "TrrcOperatorProfile contains P-5 organizational data only. To find specific leases, use the RRC lease search with operator name and county.",
      },
      summary: `search_operator_leases: "${operatorName}" — P-5 status: ${profile.p5_status ?? "unknown"}, bond: $${(profile.bond_amount_usd ?? 0).toLocaleString()}`,
    };
  } catch (e) {
    return { ok: false, data: { error: String(e) }, summary: `search_operator_leases: failed — ${String(e).slice(0, 80)}` };
  }
}

async function handleSubmitReport(
  input: Record<string, unknown>,
  ctx:   AgentContext,
): Promise<ToolResult> {
  // Validate and store the assessment — actual report assembly happens in the route handler
  ctx.agentAssessment = {
    recommendation:           (input.recommendation as "pursue" | "review" | "pass") ?? "review",
    recommendation_rationale: String(input.recommendation_rationale ?? ""),
    risk_score:               Number(input.risk_score ?? 5),
    ic_memo_paragraphs:       (input.ic_memo_paragraphs as string[]) ?? [],
    seller_claim_crosschecks: (input.seller_claim_crosschecks as AgentAssessment["seller_claim_crosschecks"]) ?? [],
    top_risks:                (input.top_risks as string[]) ?? [],
    value_drivers:            (input.value_drivers as string[]) ?? [],
    red_flags:                (input.red_flags as string[]) ?? [],
    data_gaps:                (input.data_gaps as string[]) ?? [],
  };

  return {
    ok: true,
    data: { submitted: true },
    summary: `submit_report: ${ctx.agentAssessment.recommendation.toUpperCase()} — ${ctx.agentAssessment.recommendation_rationale.slice(0, 80)}`,
  };
}
