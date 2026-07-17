// @ts-nocheck
/**
 * TRRC Public Records Due Diligence — Retrieval Orchestrator
 *
 * Coordinates all source adapters for a run.
 * Updates run progress in Supabase as it goes.
 * Handles retries, rate limiting, and concurrency.
 *
 * Never throws — always returns the result object.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ResolvedSearchContext,
  SourceAttempt,
  SourceAttemptStatus,
  TrrcDDProductionRow,
  SourceCoverageStatus,
  TrrcRecordCategory,
  TrrcSourceAdapter,
  RetrievalOptions,
  SourceSearchResult,
} from "./types";
import { getAllAdapters } from "./sources/index";

// ─── Public types ─────────────────────────────────────────────────────────────

export type OrchestratorOptions = {
  max_concurrent_sources: number;  // default 3
  timeout_per_source_ms: number;   // default 45000
  dry_run: boolean;
};

export type OrchestratorResult = {
  run_id: string;
  source_attempts: SourceAttempt[];
  production: TrrcDDProductionRow[];
  findings_raw: Record<string, unknown>[];
  coverage: SourceCoverageStatus[];
  total_records_found: number;
  manual_required_count: number;
  error: string | null;
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_OPTS: OrchestratorOptions = {
  max_concurrent_sources: 3,
  timeout_per_source_ms: 45_000,
  dry_run: false,
};

// ─── Domain extraction ────────────────────────────────────────────────────────

/** Extract base domain (hostname) from a URL string for rate-limit tracking */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── Supabase upserts ─────────────────────────────────────────────────────────

async function upsertSourceAttempt(
  supabase: SupabaseClient,
  run_id: string,
  attempt: SourceAttempt,
): Promise<void> {
  try {
    await supabase
      .from("trrc_source_attempts")
      .upsert({
        run_id,
        source_id: attempt.source_id,
        source_name: attempt.source_name,
        request_parameters: attempt.request_parameters,
        request_url: attempt.request_url,
        started_at: attempt.started_at,
        completed_at: attempt.completed_at,
        status: attempt.status,
        result_count: attempt.result_count,
        http_status: attempt.http_status,
        retry_count: attempt.retry_count,
        error_code: attempt.error_code,
        error_message: attempt.error_message,
        manual_action_url: attempt.manual_action_url,
        parser_version: attempt.parser_version,
      });
  } catch {
    // Non-fatal — orchestrator continues regardless of DB write failures
  }
}

async function updateRunProgress(
  supabase: SupabaseClient,
  run_id: string,
  progress_percent: number,
  status: string,
): Promise<void> {
  try {
    await supabase
      .from("trrc_due_diligence_runs")
      .update({ progress_percent, status, updated_at: new Date().toISOString() })
      .eq("id", run_id);
  } catch {
    // Non-fatal
  }
}

// ─── Production extraction ────────────────────────────────────────────────────

/**
 * Extract TrrcDDProductionRow records from a SourceSearchResult's data payload.
 * Adapters embed production rows in result.data under the key "production_rows".
 */
function extractProductionRows(
  result: SourceSearchResult,
  ctx: ResolvedSearchContext,
): TrrcDDProductionRow[] {
  if (!result.data || result.status !== "success") return [];

  const raw = result.data["production_rows"];
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r): TrrcDDProductionRow => ({
      entity_type: (r["entity_type"] as "lease" | "api") ?? "lease",
      api_number:
        typeof r["api_number"] === "string" ? r["api_number"] : (ctx.api_numbers[0]?.api10 ?? null),
      district:
        typeof r["district"] === "string" ? r["district"] : (ctx.district ?? ""),
      lease_number:
        typeof r["lease_number"] === "string" ? r["lease_number"] : (ctx.lease_number ?? null),
      gas_id:
        typeof r["gas_id"] === "string" ? r["gas_id"] : (ctx.gas_id ?? null),
      operator_number:
        typeof r["operator_number"] === "string" ? r["operator_number"] : (ctx.operator_number ?? null),
      production_month:
        typeof r["production_month"] === "string" ? r["production_month"] : "",
      oil_bbl: typeof r["oil_bbl"] === "number" ? r["oil_bbl"] : null,
      casinghead_gas_mcf:
        typeof r["casinghead_gas_mcf"] === "number" ? r["casinghead_gas_mcf"] : null,
      gas_mcf: typeof r["gas_mcf"] === "number" ? r["gas_mcf"] : null,
      condensate_bbl:
        typeof r["condensate_bbl"] === "number" ? r["condensate_bbl"] : null,
      water_bbl: typeof r["water_bbl"] === "number" ? r["water_bbl"] : null,
    }))
    .filter((row) => row.production_month.length > 0);
}

// ─── Coverage computation ─────────────────────────────────────────────────────

const COVERAGE_CATEGORIES: Array<{ category: TrrcRecordCategory; label: string }> = [
  { category: "identity", label: "Well Identity & Wellbore Profile" },
  { category: "production", label: "Monthly Production History" },
  { category: "compliance", label: "Inspections & Violations" },
  { category: "well_status", label: "Well Status (Active/Inactive/PA)" },
  { category: "plugging_inactive", label: "Plugging & Inactive Well Records" },
  { category: "operator_p5", label: "Operator P-5 Status" },
  { category: "completion", label: "Completion Report (W-2)" },
  { category: "drilling_permit", label: "Drilling Permit (W-1)" },
  { category: "injection_uic", label: "Injection / UIC Authority" },
  { category: "imaged_records", label: "Imaged Records (OGIMS)" },
  { category: "gis", label: "GIS Wellbore Location" },
  { category: "p4_gatherer", label: "P-4 Gatherer / Purchaser" },
];

function buildCoverage(
  attempts: SourceAttempt[],
  adapters: TrrcSourceAdapter[],
): SourceCoverageStatus[] {
  // Build a lookup: source_id → attempt
  const attemptBySource = new Map<string, SourceAttempt>();
  for (const a of attempts) {
    attemptBySource.set(a.source_id, a);
  }

  // Build a lookup: adapter_id → adapter (to get expected_record_types)
  // We rely on the source registry for category mappings
  const { SOURCE_REGISTRY } = require("./source-registry") as {
    SOURCE_REGISTRY: Record<string, { expected_record_types: TrrcRecordCategory[] }>;
  };

  const coverage: SourceCoverageStatus[] = [];

  for (const { category, label } of COVERAGE_CATEGORIES) {
    // Find all adapters that cover this category
    const coveringAdapters = adapters.filter((a) => {
      const def = SOURCE_REGISTRY[a.id];
      return def?.expected_record_types.includes(category);
    });

    const sourceIds = coveringAdapters.map((a) => a.id);
    const covAttempts = sourceIds
      .map((id) => attemptBySource.get(id))
      .filter((a): a is SourceAttempt => a !== undefined);

    const recordsFound = covAttempts.reduce((s, a) => s + (a.result_count ?? 0), 0);
    const hasManual = covAttempts.some((a) => a.status === "manual_required");
    const hasFailed = covAttempts.some(
      (a) => a.status === "failed_transient" || a.status === "failed_permanent",
    );
    const hasSuccess = covAttempts.some((a) => a.status === "success");
    const allNotApplicable =
      covAttempts.length > 0 &&
      covAttempts.every((a) => a.status === "not_applicable");
    const notChecked = covAttempts.length === 0;

    let status: SourceCoverageStatus["status"];
    if (notChecked) {
      status = "not_checked";
    } else if (allNotApplicable) {
      status = "no_applicable_record";
    } else if (hasManual && !hasSuccess) {
      status = "manual_required";
    } else if (hasSuccess && recordsFound > 0) {
      status = hasFailed ? "partial" : "complete";
    } else if (hasFailed && !hasSuccess) {
      status = "retrieval_failed";
    } else if (covAttempts.every((a) => a.status === "no_results")) {
      status = "complete"; // queried, confirmed no records exist
    } else {
      status = "partial";
    }

    coverage.push({
      category,
      label,
      status,
      data_current_through: null, // adapters may populate this in future
      sources_checked: sourceIds,
      records_found: recordsFound,
      notes: hasManual
        ? "Manual retrieval required for at least one source in this category"
        : null,
    });
  }

  return coverage;
}

// ─── Run a single adapter with timeout ───────────────────────────────────────

async function runAdapterWithTimeout(
  adapter: TrrcSourceAdapter,
  ctx: ResolvedSearchContext,
  opts: RetrievalOptions,
  timeout_ms: number,
): Promise<{ result: SourceSearchResult; duration_ms: number }> {
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  try {
    // Wrap the search in a Promise.race against a timeout promise
    const searchPromise = adapter.search(ctx, opts);
    const timeoutPromise = new Promise<never>((_res, rej) => {
      controller.signal.addEventListener("abort", () =>
        rej(new Error(`Source ${adapter.id} timed out after ${timeout_ms}ms`)),
      );
    });

    const result = await Promise.race([searchPromise, timeoutPromise]);
    return { result, duration_ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export async function runRetrievalOrchestrator(
  run_id: string,
  ctx: ResolvedSearchContext,
  supabase: SupabaseClient,
  opts?: Partial<OrchestratorOptions>,
): Promise<OrchestratorResult> {
  const options: OrchestratorOptions = { ...DEFAULT_OPTS, ...opts };

  const allAttempts: SourceAttempt[] = [];
  const allProduction: TrrcDDProductionRow[] = [];
  const findingsRaw: Record<string, unknown>[] = [];
  let totalRecords = 0;
  let manualRequired = 0;

  // 1. Load all adapters, filter to enabled + supporting this input type
  const allAdapters = getAllAdapters();
  const eligibleAdapters = allAdapters.filter(
    (a) => a.is_enabled && a.supported_inputs.includes(ctx.input_type),
  );

  await updateRunProgress(supabase, run_id, 5, "retrieving");

  if (eligibleAdapters.length === 0) {
    const coverage = buildCoverage([], allAdapters);
    return {
      run_id,
      source_attempts: [],
      production: [],
      findings_raw: [],
      coverage,
      total_records_found: 0,
      manual_required_count: 0,
      error: `No enabled adapters support input type "${ctx.input_type}"`,
    };
  }

  // 2. Track last-call-time per domain for rate limiting
  const domainLastCall = new Map<string, number>();

  // 3. Process adapters in batches
  const batches: TrrcSourceAdapter[][] = [];
  for (let i = 0; i < eligibleAdapters.length; i += options.max_concurrent_sources) {
    batches.push(eligibleAdapters.slice(i, i + options.max_concurrent_sources));
  }

  const totalBatches = batches.length;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    const batchPromises = batch.map(async (adapter): Promise<void> => {
      const domain = extractDomain(adapter.base_url);

      // Rate limiting: wait if we've called this domain recently
      const lastCall = domainLastCall.get(domain) ?? 0;
      const elapsed = Date.now() - lastCall;
      if (elapsed < adapter.rate_limit_ms) {
        await new Promise((r) => setTimeout(r, adapter.rate_limit_ms - elapsed));
      }
      domainLastCall.set(domain, Date.now());

      const startedAt = new Date().toISOString();

      // Dry-run: skip actual search
      if (options.dry_run) {
        const attempt: SourceAttempt = {
          source_id: adapter.id,
          source_name: adapter.name,
          request_parameters: { dry_run: "true" },
          request_url: adapter.base_url,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          status: "not_applicable",
          result_count: 0,
          http_status: null,
          retry_count: 0,
          error_code: null,
          error_message: null,
          manual_action_url: null,
          parser_version: adapter.parser_version,
        };
        allAttempts.push(attempt);
        await upsertSourceAttempt(supabase, run_id, attempt);
        return;
      }

      // Manual fallback sources: record the attempt but don't call search
      if (adapter.retrieval_strategy === "manual") {
        const attempt: SourceAttempt = {
          source_id: adapter.id,
          source_name: adapter.name,
          request_parameters: {
            input_type: ctx.input_type,
            normalized_input: ctx.normalized_input,
          },
          request_url: adapter.base_url,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          status: "manual_required",
          result_count: 0,
          http_status: null,
          retry_count: 0,
          error_code: null,
          error_message: null,
          manual_action_url: adapter.base_url,
          parser_version: adapter.parser_version,
        };
        allAttempts.push(attempt);
        manualRequired++;
        await upsertSourceAttempt(supabase, run_id, attempt);
        return;
      }

      // Automated sources: attempt with retries
      const retrivalOpts: RetrievalOptions = {
        timeout_ms: options.timeout_per_source_ms,
        max_retries: adapter.max_retries,
        dry_run: options.dry_run,
      };

      let lastError: string | null = null;
      let result: SourceSearchResult | null = null;
      let retryCount = 0;

      for (let attempt = 0; attempt <= adapter.max_retries; attempt++) {
        try {
          const { result: r } = await runAdapterWithTimeout(
            adapter,
            ctx,
            retrivalOpts,
            options.timeout_per_source_ms,
          );
          result = r;
          retryCount = attempt;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          retryCount = attempt;
          if (attempt < adapter.max_retries) {
            // Brief back-off before retry
            await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
          }
        }
      }

      const completedAt = new Date().toISOString();
      let finalStatus: SourceAttemptStatus;
      let resultCount = 0;
      let errorMessage: string | null = null;

      if (result) {
        finalStatus = result.status;
        resultCount = result.result_count;
        errorMessage = result.error;

        // Extract production rows if this source returned any
        const prodRows = extractProductionRows(result, ctx);
        if (prodRows.length > 0) {
          allProduction.push(...prodRows);
        }

        // Collect raw findings data
        if (result.data) {
          findingsRaw.push({
            source_id: adapter.id,
            ...result.data,
          });
        }

        totalRecords += resultCount;
      } else {
        finalStatus = "failed_transient";
        errorMessage = lastError ?? "Unknown error after all retries";
      }

      if (finalStatus === "manual_required") manualRequired++;

      const sourceAttempt: SourceAttempt = {
        source_id: adapter.id,
        source_name: adapter.name,
        request_parameters: {
          input_type: ctx.input_type,
          normalized_input: ctx.normalized_input,
          district: ctx.district ?? "",
          lease_number: ctx.lease_number ?? "",
        },
        request_url: adapter.base_url,
        started_at: startedAt,
        completed_at: completedAt,
        status: finalStatus,
        result_count: resultCount,
        http_status: null,
        retry_count: retryCount,
        error_code: finalStatus === "failed_transient" ? "TRANSIENT_ERROR" : null,
        error_message: errorMessage,
        manual_action_url: result?.manual_action_url ?? null,
        parser_version: adapter.parser_version,
      };

      allAttempts.push(sourceAttempt);
      await upsertSourceAttempt(supabase, run_id, sourceAttempt);
    });

    // Wait for the whole batch before proceeding
    await Promise.all(batchPromises);

    // Update progress after each batch
    const progressPercent =
      5 + Math.round(((batchIdx + 1) / totalBatches) * 85);
    await updateRunProgress(supabase, run_id, progressPercent, "retrieving");
  }

  // 4. Build coverage summary
  const coverage = buildCoverage(allAttempts, allAdapters);

  // 5. Final progress update
  await updateRunProgress(supabase, run_id, 90, "analyzing");

  return {
    run_id,
    source_attempts: allAttempts,
    production: allProduction,
    findings_raw: findingsRaw,
    coverage,
    total_records_found: totalRecords,
    manual_required_count: manualRequired,
    error: null,
  };
}
