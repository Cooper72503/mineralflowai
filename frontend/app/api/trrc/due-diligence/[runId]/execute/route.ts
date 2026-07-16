/**
 * POST /api/trrc/due-diligence/[runId]/execute
 *
 * Workhorse route: runs the full TRRC retrieval pipeline for an existing run.
 * Called separately from the initial POST so that initial POST returns fast.
 *
 * Flow:
 *   1. Auth + ownership check
 *   2. Load run, verify status is "retrieving" or "pending"
 *   3. Build ResolvedSearchContext from run + entities
 *   4. expandSearchContext → populates api_numbers from lease/operator/GIS data
 *   5. runRetrievalOrchestrator  → source_attempts, production, coverage
 *   6. runFindingEngine          → findings
 *   7. computeAcquisitionScorecard → scorecard
 *   8. Persist findings, missing items, production rows
 *   9. Update run: status="complete", scorecard_json, coverage_json
 *  10. Build manifest → upload to Supabase Storage
 *  11. Return { ok: true, data: { status: "complete", run_id } }
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { runRetrievalOrchestrator } from "@/lib/trrc/retrieval-orchestrator";
import { runFindingEngine } from "@/lib/trrc/finding-engine";
import { computeAcquisitionScorecard } from "@/lib/trrc/scoring-engine";
import { buildManifest } from "@/lib/trrc/manifest-builder";
import { fetchLeaseWellInventory } from "@/lib/underwriting/trrc-lease-inventory";
import { fetchTrrcP5ByOperatorName } from "@/lib/underwriting/trrc-p5";
import { fetchTrrcInactiveWellsByOperator } from "@/lib/underwriting/trrc-inactive-wells";
import { lookupTrrcLeasesByApis } from "@/lib/wells/trrc-api";
import { normalizeApiNumber } from "@/lib/trrc/normalization";
import type {
  ResolvedSearchContext,
  TrrcDueDiligenceRun,
  ResolvedEntity,
  NormalizedApi,
  SourceSearchResult,
} from "@/lib/trrc/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Status guard ─────────────────────────────────────────────────────────────

/**
 * These statuses mean the run is already complete or actively running.
 * Re-executing a run in any of these states is an error.
 */
const TERMINAL_OR_RUNNING = [
  "complete",
  "failed",
  "cancelled",
  "analyzing",
  "generating",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a NormalizedApi from a 10-digit api10 string. */
function buildNormalizedApi(api10: string): NormalizedApi {
  const state_code = api10.slice(0, 2);
  const county_code = api10.slice(2, 5);
  const well_code = api10.slice(5, 10);
  return {
    raw: api10,
    api10,
    api14: `${api10}0000`,
    formatted: `${state_code}-${county_code}-${well_code}-00-00`,
    state_code,
    county_code,
    well_code,
    is_texas: state_code === "42",
  };
}

/** Build a NormalizedApi from any raw string via normalizeApiNumber, falling back to buildNormalizedApi. */
function buildNormalizedApiFromRaw(raw: string): NormalizedApi | null {
  const norm = normalizeApiNumber(raw);
  if (norm) return norm;
  // Last-ditch: if it's exactly 10 digits, build directly
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("42")) {
    return buildNormalizedApi(digits);
  }
  return null;
}

/** Build ResolvedSearchContext from DB run + entity rows (initial pass — no API expansion yet). */
function buildSearchContext(
  run: Record<string, unknown>,
  entities: ResolvedEntity[],
  defaultProductionMonths = 36,
): ResolvedSearchContext {
  // Collect API numbers from wellbore entities
  const api_numbers: NormalizedApi[] = entities
    .filter((e) => e.entity_type === "wellbore" && typeof e.canonical_identifier === "string")
    .map((e) => buildNormalizedApi(e.canonical_identifier))
    .filter((a) => a.api10.length === 10);

  // If run has a resolved_primary_api, ensure it is included
  const primaryApi = typeof run["resolved_primary_api"] === "string" ? run["resolved_primary_api"] : null;
  if (primaryApi && !api_numbers.find((a) => a.api10 === primaryApi)) {
    api_numbers.unshift(buildNormalizedApi(primaryApi));
  }

  // Derive district from entities or run
  const district =
    (typeof run["resolved_district"] === "string" ? run["resolved_district"] : null) ??
    (() => {
      const wellboreAttrs = entities.find((e) => e.entity_type === "wellbore")?.attributes;
      return typeof wellboreAttrs?.["district"] === "string" ? wellboreAttrs["district"] : null;
    })();

  // Operator name from operator entities
  const operatorEntity = entities.find((e) => e.entity_type === "operator");
  const operator_name =
    typeof operatorEntity?.attributes["normalized_name"] === "string"
      ? operatorEntity.attributes["normalized_name"]
      : typeof run["original_input"] === "string" &&
        (run["selected_input_type"] === "operator_name" || run["selected_input_type"] === "p5_number")
        ? (run["original_input"] as string)
        : null;

  // Lease number
  const leaseEntity = entities.find((e) => e.entity_type === "lease");
  const lease_number =
    (typeof run["resolved_lease_number"] === "string" ? run["resolved_lease_number"] : null) ??
    (typeof leaseEntity?.attributes["lease_number"] === "string" ? leaseEntity.attributes["lease_number"] : null);

  // Gas ID
  const gas_id =
    (typeof run["resolved_gas_id"] === "string" ? run["resolved_gas_id"] : null) ??
    (() => {
      const gwEntity = entities.find((e) => e.entity_type === "wellbore" && typeof e.attributes["gas_well_id"] === "string");
      return gwEntity ? (gwEntity.attributes["gas_well_id"] as string) : null;
    })();

  return {
    run_id: run["id"] as string,
    input_type: run["selected_input_type"] as ResolvedSearchContext["input_type"],
    raw_input: run["original_input"] as string,
    normalized_input: run["normalized_input"] as string,
    api_numbers,
    district,
    lease_number,
    gas_id,
    operator_name,
    operator_number:
      typeof run["resolved_operator_number"] === "string" ? run["resolved_operator_number"] : null,
    county: null,
    lease_name: null,
    legal_description: null,
    search_historical: false,
    include_offset_wells: false,
    production_months: defaultProductionMonths,
  };
}

// ─── Context expansion ────────────────────────────────────────────────────────

/**
 * Expand the ResolvedSearchContext by discovering additional API numbers,
 * district codes, and lease numbers based on the input type.
 *
 * Mutates ctx in place. Returns newly discovered NormalizedApi[] so the caller
 * can upsert wellbore entities for each.
 */
async function expandSearchContext(
  ctx: ResolvedSearchContext,
  runRaw: Record<string, unknown>,
  entities: ResolvedEntity[],
  supabase: Awaited<ReturnType<typeof createSupabaseFromRouteRequest>>,
  runId: string,
  expansion_trace: string[],
): Promise<NormalizedApi[]> {
  const inputType = ctx.input_type;
  let expandedApis: NormalizedApi[] = [];
  let expansionSource = "entity_resolution";

  // ── api_number ────────────────────────────────────────────────────────────
  if (inputType === "api_number") {
    // APIs already populated from entity resolver. Fill in district + lease_number
    // if missing by looking up the APIs in the TRRC PDQ wellbore query.
    if (ctx.api_numbers.length > 0 && (!ctx.district || !ctx.lease_number)) {
      expansion_trace.push(`api_number: looking up lease/district for ${ctx.api_numbers.length} API(s) via PDQ`);
      try {
        const leaseMap = await lookupTrrcLeasesByApis(
          null,
          ctx.api_numbers.map((a) => a.api10),
        );
        const firstMatch = leaseMap.get(ctx.api_numbers[0].api10);
        if (firstMatch) {
          if (!ctx.district) {
            ctx.district = firstMatch.distCode;
            expansion_trace.push(`api_number: district resolved to "${firstMatch.distCode}" from PDQ`);
          }
          if (!ctx.lease_number) {
            ctx.lease_number = firstMatch.leaseNo;
            expansion_trace.push(`api_number: lease_number resolved to "${firstMatch.leaseNo}" from PDQ`);
          }
        }
      } catch (err) {
        expansion_trace.push(`api_number: PDQ lookup failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      expansion_trace.push(`api_number: ${ctx.api_numbers.length} API(s) already present from entity resolver — no expansion needed`);
    }
    expandedApis = [];
  }

  // ── rrc_lease_number ─────────────────────────────────────────────────────
  else if (inputType === "rrc_lease_number") {
    if (!ctx.lease_number) {
      expansion_trace.push(`rrc_lease_number: no lease_number in context — cannot expand`);
    } else if (!ctx.district) {
      // Can't call lease inventory without a district
      expansion_trace.push(
        `rrc_lease_number: district unknown for lease ${ctx.lease_number} — API expansion skipped. Results will be lease-level only.`,
      );
    } else {
      expansion_trace.push(`rrc_lease_number: fetching well inventory for lease ${ctx.lease_number} / district ${ctx.district}`);
      try {
        const inv = await fetchLeaseWellInventory(ctx.district, ctx.lease_number);
        if (!inv.query_failed && inv.wells.length > 0) {
          const newApis = inv.wells
            .map((w) => buildNormalizedApiFromRaw(w.api10))
            .filter((a): a is NormalizedApi => a !== null);

          // Deduplicate against existing
          const existingSet = new Set(ctx.api_numbers.map((a) => a.api10));
          const fresh = newApis.filter((a) => !existingSet.has(a.api10));

          ctx.api_numbers = [...ctx.api_numbers, ...fresh];
          expandedApis = fresh;
          expansionSource = "lease_inventory";
          expansion_trace.push(
            `rrc_lease_number: expanded lease ${ctx.lease_number} to ${ctx.api_numbers.length} API(s) via lease inventory (${fresh.length} new)`,
          );
        } else {
          expansion_trace.push(
            `rrc_lease_number: lease inventory ${inv.query_failed ? "query failed" : "returned 0 wells"} for lease ${ctx.lease_number} / district ${ctx.district}`,
          );
        }
      } catch (err) {
        expansion_trace.push(`rrc_lease_number: lease inventory error — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── operator_name / p5_number ─────────────────────────────────────────────
  else if (inputType === "operator_name" || inputType === "p5_number") {
    const operatorName = ctx.operator_name ?? ctx.raw_input;
    if (!operatorName) {
      expansion_trace.push(`${inputType}: no operator_name in context — cannot expand`);
    } else {
      // Step 1: resolve operator number via P-5 if not already known
      if (!ctx.operator_number) {
        expansion_trace.push(`${inputType}: looking up P-5 record for operator "${operatorName}"`);
        try {
          const p5 = await fetchTrrcP5ByOperatorName(operatorName);
          if (p5) {
            ctx.operator_number = p5.operator_no;
            expansion_trace.push(`${inputType}: P-5 resolved operator_no="${p5.operator_no}" (status: ${p5.org_status})`);

            // Persist operator number to DB
            await supabase
              .from("trrc_due_diligence_runs")
              .update({
                resolved_operator_number: p5.operator_no,
                updated_at: new Date().toISOString(),
              })
              .eq("id", runId);
          } else {
            expansion_trace.push(`${inputType}: P-5 lookup returned no record for "${operatorName}"`);
          }
        } catch (err) {
          expansion_trace.push(`${inputType}: P-5 lookup error — ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        expansion_trace.push(`${inputType}: operator_number already known: "${ctx.operator_number}"`);
      }

      // Step 2: fetch inactive wells by operator to discover API numbers
      if (ctx.operator_number) {
        expansion_trace.push(`${inputType}: fetching inactive well roster for operator ${ctx.operator_number} (O + G leases in parallel)`);
        try {
          const [oilWells, gasWells] = await Promise.all([
            fetchTrrcInactiveWellsByOperator(ctx.operator_number, "O"),
            fetchTrrcInactiveWellsByOperator(ctx.operator_number, "G"),
          ]);

          const allWells = [...oilWells, ...gasWells];
          expansion_trace.push(`${inputType}: inactive well roster returned ${allWells.length} records (${oilWells.length} oil, ${gasWells.length} gas)`);

          // Convert api8 → api10 by prepending "42"
          const seenApi10 = new Set<string>();
          const wellApis: NormalizedApi[] = [];
          for (const w of allWells) {
            const api10 = `42${w.api8}`;
            if (seenApi10.has(api10)) continue;
            seenApi10.add(api10);
            const norm = buildNormalizedApiFromRaw(api10);
            if (norm) wellApis.push(norm);
          }

          // Cap to first 50 to keep pipeline fast
          const capped = wellApis.slice(0, 50);

          // Merge with any existing APIs
          const existingSet = new Set(ctx.api_numbers.map((a) => a.api10));
          const fresh = capped.filter((a) => !existingSet.has(a.api10));
          ctx.api_numbers = [...ctx.api_numbers, ...fresh];
          expandedApis = fresh;
          expansionSource = "inactive_well_roster";

          expansion_trace.push(
            `${inputType}: expanded operator "${operatorName}" to ${ctx.api_numbers.length} API(s) via inactive well roster (${fresh.length} new, capped at 50)`,
          );
        } catch (err) {
          expansion_trace.push(`${inputType}: inactive well roster error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // ── legal_description ─────────────────────────────────────────────────────
  else if (inputType === "legal_description") {
    // GIS resolution should have stored resolved APIs in wellbore entities.
    // Gather from entities with resolution_method = "gis_abstract_polygon" or from attributes.resolved_apis.
    const gisEntities = entities.filter(
      (e) =>
        e.entity_type === "wellbore" &&
        (e.resolution_method === "gis_abstract_polygon" ||
          (e.attributes["resolved_apis"] && Array.isArray(e.attributes["resolved_apis"]))),
    );

    const gisApis: NormalizedApi[] = [];
    const seenGis = new Set<string>();

    for (const e of gisEntities) {
      // From canonical_identifier
      const ci = e.canonical_identifier;
      if (ci && !seenGis.has(ci)) {
        const norm = buildNormalizedApiFromRaw(ci);
        if (norm) { seenGis.add(ci); gisApis.push(norm); }
      }
      // From attributes.resolved_apis
      const resolvedApis = e.attributes["resolved_apis"];
      if (Array.isArray(resolvedApis)) {
        for (const ra of resolvedApis) {
          if (typeof ra === "string" && !seenGis.has(ra)) {
            const norm = buildNormalizedApiFromRaw(ra);
            if (norm) { seenGis.add(ra); gisApis.push(norm); }
          }
        }
      }
    }

    if (gisApis.length > 0) {
      const existingSet = new Set(ctx.api_numbers.map((a) => a.api10));
      const fresh = gisApis.filter((a) => !existingSet.has(a.api10));
      ctx.api_numbers = [...ctx.api_numbers, ...fresh];
      expandedApis = fresh;
      expansionSource = "gis_abstract_polygon";
      expansion_trace.push(`legal_description: found ${gisApis.length} API(s) from GIS entities (${fresh.length} new)`);

      // Fill in lease/district from PDQ
      if (ctx.api_numbers.length > 0 && (!ctx.district || !ctx.lease_number)) {
        try {
          const leaseMap = await lookupTrrcLeasesByApis(null, ctx.api_numbers.map((a) => a.api10));
          const firstMatch = leaseMap.get(ctx.api_numbers[0].api10);
          if (firstMatch) {
            if (!ctx.district) {
              ctx.district = firstMatch.distCode;
              expansion_trace.push(`legal_description: district resolved to "${firstMatch.distCode}" from PDQ`);
            }
            if (!ctx.lease_number) {
              ctx.lease_number = firstMatch.leaseNo;
              expansion_trace.push(`legal_description: lease_number resolved to "${firstMatch.leaseNo}" from PDQ`);
            }
          }
        } catch (err) {
          expansion_trace.push(`legal_description: PDQ lookup failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      expansion_trace.push(
        `legal_description: no GIS-resolved APIs found in entities — api_numbers remains empty. Finding engine will emit a critical finding.`,
      );
    }
  }

  // ── gas_well_id ───────────────────────────────────────────────────────────
  else if (inputType === "gas_well_id") {
    // gas_id is already set as the canonical identifier.
    // Gas production source handles gas_id directly — no API expansion needed.
    expansion_trace.push(`gas_well_id: gas_id="${ctx.gas_id ?? "unknown"}" — no API expansion needed, gas production source handles gas_id`);
  }

  // ── unknown / lease_name / other ──────────────────────────────────────────
  else {
    expansion_trace.push(`${inputType}: no expansion strategy defined for this input type`);
  }

  return expandedApis;
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  // 1. Auth
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "runId is required." }, { status: 400 });
  }

  // 2. Load run + verify ownership and status
  const { data: runRaw, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !runRaw) {
    return NextResponse.json(
      { ok: false, error: "Run not found or access denied." },
      { status: 404 },
    );
  }

  const runStatus = runRaw["status"] as string;
  if (TERMINAL_OR_RUNNING.includes(runStatus)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  if (runStatus !== "retrieving" && runStatus !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  // Wrap entire pipeline in try/catch to never leave run stuck in "retrieving"
  try {
    // 3. Load entities
    const { data: entityRows } = await supabase
      .from("trrc_resolved_entities")
      .select("*")
      .eq("run_id", runId)
      .order("confidence", { ascending: false });

    const entities: ResolvedEntity[] = (entityRows ?? []).map((e) => ({
      id: e["id"] as string,
      entity_type: e["entity_type"] as ResolvedEntity["entity_type"],
      canonical_identifier: e["canonical_identifier"] as string,
      display_name: e["display_name"] as string,
      // DB column is attributes_json
      attributes: (e["attributes_json"] ?? {}) as Record<string, unknown>,
      confidence: e["confidence"] as number,
      resolution_method: e["resolution_method"] as string,
      is_user_selected: e["is_user_selected"] as boolean,
    }));

    // 4. Build initial search context
    const ctx = buildSearchContext(runRaw, entities);

    // 5. Expand search context — discover API numbers from lease/operator/GIS
    const expansion_trace: string[] = [];
    const newlyDiscoveredApis = await expandSearchContext(
      ctx,
      runRaw,
      entities,
      supabase,
      runId,
      expansion_trace,
    );

    // 6. Persist expanded identifiers back to the run
    await supabase
      .from("trrc_due_diligence_runs")
      .update({
        resolved_primary_api: ctx.api_numbers[0]?.api10 ?? (runRaw["resolved_primary_api"] as string | null) ?? null,
        resolved_district: ctx.district,
        resolved_lease_number: ctx.lease_number,
        resolved_gas_id: ctx.gas_id,
        resolved_operator_number: ctx.operator_number,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);

    // 7. Upsert newly discovered wellbore entities
    if (newlyDiscoveredApis.length > 0) {
      const existingIdentifiers = new Set(entities.map((e) => e.canonical_identifier));
      const newEntityRows = newlyDiscoveredApis
        .filter((a) => !existingIdentifiers.has(a.api10))
        .map((a) => ({
          run_id: runId,
          entity_type: "wellbore",
          canonical_identifier: a.api10,
          display_name: `API ${a.formatted}`,
          attributes_json: { expansion_source: ctx.input_type },
          confidence: 0.8,
          resolution_method: ctx.input_type,
          is_user_selected: false,
        }));

      if (newEntityRows.length > 0) {
        const { error: entityInsertError } = await supabase
          .from("trrc_resolved_entities")
          .insert(newEntityRows);

        if (entityInsertError) {
          console.error("[execute] entity insert error:", entityInsertError);
        } else {
          console.log(`[execute] inserted ${newEntityRows.length} new wellbore entities from expansion`);
        }
      }
    }

    // 8. Run retrieval orchestrator — pass expansion_trace in findings_raw context
    const orchestratorResult = await runRetrievalOrchestrator(runId, ctx, supabase);

    // Inject expansion_trace into findings_raw so the finding engine can reference it
    orchestratorResult.findings_raw = [
      ...(orchestratorResult.findings_raw ?? []),
      {
        source_id: "__expansion__",
        expansion_trace,
        api_numbers_count: ctx.api_numbers.length,
        input_type: ctx.input_type,
      },
    ];

    // Build a source_data map for the finding engine from findings_raw
    const source_data: Record<string, SourceSearchResult> = {};
    for (const raw of orchestratorResult.findings_raw) {
      const sid = typeof raw["source_id"] === "string" ? raw["source_id"] : "";
      if (sid && sid !== "__expansion__") {
        source_data[sid] = {
          source_id: sid,
          status: "success",
          records: [],
          manual_action_url: null,
          error: null,
          result_count: 0,
          data: raw as Record<string, unknown>,
        };
      }
    }

    // Mark run as analyzing
    await supabase
      .from("trrc_due_diligence_runs")
      .update({ status: "analyzing", progress_percent: 90, updated_at: new Date().toISOString() })
      .eq("id", runId);

    // 9. Run finding engine
    const findings = await runFindingEngine(runId, ctx, orchestratorResult, source_data);

    // 10. Compute scorecard
    const scorecard = computeAcquisitionScorecard(
      runId,
      ctx,
      findings,
      orchestratorResult.coverage,
      orchestratorResult,
    );

    // 11. Persist findings — DB column is evidence_json (not evidence)
    if (findings.length > 0) {
      const findingRows = findings.map((f) => ({
        run_id: runId,
        finding_id: f.id,
        category: f.category,
        severity: f.severity,
        finding_type: f.finding_type,
        title: f.title,
        description: f.description,
        evidence_json: f.evidence,           // DB col: evidence_json
        source_record_ids: f.source_record_ids, // DB col: source_record_ids (TEXT[])
        analytical_method: f.analytical_method,
        confidence: f.confidence,
        recommended_action: f.recommended_action,
        is_directly_reported: f.is_directly_reported,
      }));

      const { error: findingsInsertError } = await supabase
        .from("trrc_due_diligence_findings")
        .insert(findingRows);

      if (findingsInsertError) {
        console.error("[execute] findings insert error:", findingsInsertError);
      }
    }

    // 12. Persist production rows — upsert to avoid duplicates on retry
    if (orchestratorResult.production.length > 0) {
      const prodRows = orchestratorResult.production.map((p) => ({
        run_id: runId,
        entity_type: p.entity_type,
        api_number: p.api_number,
        district: p.district,
        lease_number: p.lease_number,
        gas_id: p.gas_id,
        operator_number: p.operator_number,
        production_month: p.production_month,
        oil_bbl: p.oil_bbl,
        casinghead_gas_mcf: p.casinghead_gas_mcf,
        gas_mcf: p.gas_mcf,
        condensate_bbl: p.condensate_bbl,
        water_bbl: p.water_bbl,
      }));

      // Unique constraint: (run_id, entity_type, coalesce(api_number,''), coalesce(lease_number,''), production_month)
      const { error: prodInsertError } = await supabase
        .from("trrc_production_monthly")
        .upsert(prodRows, {
          onConflict: "run_id,entity_type,api_number,lease_number,production_month",
          ignoreDuplicates: true,
        });

      if (prodInsertError) {
        console.error("[execute] production upsert error:", prodInsertError);
      }
    }

    // Mark run as generating
    await supabase
      .from("trrc_due_diligence_runs")
      .update({ status: "generating", progress_percent: 95, updated_at: new Date().toISOString() })
      .eq("id", runId);

    // 13. Build manifest
    const runForManifest: TrrcDueDiligenceRun = {
      id: runId,
      user_id: user.id,
      original_input: runRaw["original_input"] as string,
      detected_input_type: runRaw["detected_input_type"] as TrrcDueDiligenceRun["detected_input_type"],
      selected_input_type: runRaw["selected_input_type"] as TrrcDueDiligenceRun["selected_input_type"],
      normalized_input: runRaw["normalized_input"] as string,
      status: "complete",
      started_at: runRaw["started_at"] as string,
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      result_summary: null,
      error_summary: orchestratorResult.error,
      resolved_primary_api: ctx.api_numbers[0]?.api10 ?? null,
      resolved_district: ctx.district,
      resolved_lease_number: ctx.lease_number,
      resolved_gas_id: ctx.gas_id,
      resolved_operator_number: ctx.operator_number,
      report_storage_path: null,
      archive_storage_path: null,
      manifest_storage_path: null,
      created_at: runRaw["created_at"] as string,
      updated_at: new Date().toISOString(),
      entities,
    };

    const manifest = buildManifest(
      runForManifest,
      ctx,
      orchestratorResult,
      findings,
      scorecard,
      process.env["npm_package_version"] ?? "1.0.0",
    );

    // 14. Upload manifest to Supabase Storage (use service role to bypass RLS on storage)
    let manifest_storage_path: string | null = null;
    const adminClient = createServiceRoleClient();

    if (adminClient) {
      const storagePath = `trrc-due-diligence/${user.id}/${runId}/manifest.json`;
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));

      const { error: uploadError } = await adminClient.storage
        .from("trrc-due-diligence")
        .upload(storagePath, manifestBytes, {
          contentType: "application/json",
          upsert: true,
        });

      if (uploadError) {
        console.error("[execute] manifest upload error:", uploadError);
      } else {
        manifest_storage_path = storagePath;
      }
    }

    // 15. Update run to complete
    const { error: updateError } = await supabase
      .from("trrc_due_diligence_runs")
      .update({
        status: "complete",
        progress_percent: 100,
        completed_at: new Date().toISOString(),
        resolved_primary_api: ctx.api_numbers[0]?.api10 ?? null,
        resolved_district: ctx.district,
        resolved_lease_number: ctx.lease_number,
        resolved_gas_id: ctx.gas_id,
        resolved_operator_number: ctx.operator_number,
        scorecard_json: scorecard as unknown as Record<string, unknown>,
        coverage_json: orchestratorResult.coverage as unknown as Record<string, unknown>[],
        manifest_storage_path,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);

    if (updateError) {
      console.error("[execute] run update error:", updateError);
      return NextResponse.json(
        { ok: false, error: "Pipeline completed but failed to update run status." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: { status: "complete", run_id: runId },
    });
  } catch (err) {
    // Error recovery — never leave run stuck in "retrieving"
    console.error("[execute] unhandled pipeline error:", err);

    try {
      await supabase
        .from("trrc_due_diligence_runs")
        .update({
          status: "failed",
          error_summary: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    } catch (updateErr) {
      console.error("[execute] failed to update run status to failed:", updateErr);
    }

    return NextResponse.json({ ok: false, error: "Pipeline failed." }, { status: 500 });
  }
}
