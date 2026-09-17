/**
 * Shared "create one due diligence run" logic — extracted from
 * POST /api/trrc/due-diligence so the new bulk endpoint (portfolio upload)
 * can create N runs without duplicating the resolve/validate/insert
 * sequence. Behavior is unchanged from the original single-run route;
 * this is a pure refactor, not a rewrite.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectInputType, normalizeApiNumber } from "./normalization";
import { resolveEntities } from "./entity-resolver";
import { ensureTitleJobForApi } from "./title/ensure-job";
import type { TrrcIdentifierType, ResolvedEntity } from "./types";

export interface CreateRunInput {
  input?: string;
  input_type_override?: TrrcIdentifierType;
  county?: string;
  district?: string;
  operator_name?: string;
  lease_number?: string;
  lease_name?: string;
  purchase_price?: number;
}

export type CreateRunResult =
  | {
      ok: true;
      id: string;
      status: string;
      needs_user_selection: boolean;
      normalized_input: string;
      input_type: TrrcIdentifierType;
      entities: ResolvedEntity[];
      original_input: string;
      title_link_warning?: string;
    }
  | { ok: false; error: string; original_input: string };

export async function createDueDiligenceRun(
  supabase: SupabaseClient,
  userId: string,
  body: CreateRunInput,
): Promise<CreateRunResult> {
  if (!body || typeof body.input !== "string") return {ok: false, error: "input must be a string.", original_input: ""};
  const rawInput = body.input.trim();
  if (!rawInput) return { ok: false, error: "input is required.", original_input: rawInput };
  if (rawInput.length > 500) return { ok: false, error: "input must be 500 characters or fewer.", original_input: rawInput };
  if (body.purchase_price !== undefined && (typeof body.purchase_price !== "number" || !Number.isFinite(body.purchase_price) || body.purchase_price <= 0)) {
    return { ok: false, error: "purchase_price must be a positive number.", original_input: rawInput };
  }

  const detected_input_type = body.input_type_override ?? detectInputType(rawInput);
  const normalizedApi = detected_input_type === "api_number" ? normalizeApiNumber(rawInput) : null;
  if (detected_input_type === "api_number" && !normalizedApi) return { ok: false, error: "Invalid Texas API number.", original_input: rawInput };
  const normalized_input = normalizedApi?.api10 ?? rawInput;

  const resolution = await resolveEntities(
    rawInput,
    body.input_type_override ?? null,
    body.county ?? null,
    body.district ?? null,
    body.operator_name ?? null,
    body.lease_name ?? null,
  );

  if (resolution.error && resolution.entities.length === 0) {
    return { ok: false, error: `Could not resolve input: ${resolution.error}`, original_input: rawInput };
  }

  const needs_user_selection = resolution.needs_user_selection;
  const status = needs_user_selection ? "awaiting_selection" : "pending";

  // Resolve the title scope before publishing a runnable row. Its optional
  // failure is retained on the run; workers must never see a half-created input.
  let titleLinkWarning: string | undefined;
  let titleJobId: string | null = null;
  if (resolution.input_type === "api_number" && !needs_user_selection) {
    try {
      const title = await ensureTitleJobForApi(supabase, userId, rawInput);
      if (title.ok && title.jobId) titleJobId = title.jobId;
      else titleLinkWarning = title.reason ?? "Title research could not be started.";
    } catch (err) {
      titleLinkWarning = "Title research setup failed; retry title linking from this run.";
      console.error("[createDueDiligenceRun] title job creation threw:", err);
    }
  }

  // One transaction commits the run, candidate entities, and title association.
  // No non-atomic fallback: failed persistence must not queue incomplete work.
  const { data: runRow, error: runInsertError } = await supabase.rpc("create_due_diligence_run", {
    p_run: {
      original_input: rawInput,
      detected_input_type,
      selected_input_type: resolution.input_type,
      normalized_input: resolution.normalized_input ?? normalized_input,
      status,
      resolved_primary_api: normalizedApi?.api10 ?? null,
      resolved_district: body.district ?? null,
      resolved_lease_number: body.lease_number?.trim() ?? null,
      operator_name: body.operator_name?.trim() ?? null,
      purchase_price: body.purchase_price ?? null,
      title_research_job_id: titleJobId,
      title_setup_warning: titleLinkWarning ?? null,
    },
    p_entities: resolution.entities.map(e => ({
      id: e.id,
      entity_type: e.entity_type,
      canonical_identifier: e.canonical_identifier,
      display_name: e.display_name,
      attributes_json: e.attributes,
      confidence: e.confidence,
      resolution_method: e.resolution_method,
      is_user_selected: e.is_user_selected,
    })),
  });
  if (runInsertError || !runRow?.id) {
    console.error("[createDueDiligenceRun] atomic run creation failed:", runInsertError);
    return { ok: false, error: "Failed to create due diligence run.", original_input: rawInput };
  }
  const run_id = runRow.id as string;

  return {
    ok: true,
    id: run_id,
    status,
    needs_user_selection,
    normalized_input: resolution.normalized_input,
    input_type: resolution.input_type,
    entities: resolution.entities,
    original_input: rawInput,
    ...(titleLinkWarning ? {title_link_warning: titleLinkWarning} : {}),
  };
}
