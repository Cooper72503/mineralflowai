/**
 * TRRC Source Adapter — Completion Query (W-2 / Drilling Permit)
 *
 * id: "completion_query"
 * Queries TRRC EWA drilling permits and CMPL completions for each API number.
 * Returns W-2 packet presence, completion date, wellbore profile, and total depth.
 */

import type {
  TrrcSourceAdapter,
  ResolvedSearchContext,
  RetrievalOptions,
  SourceSearchResult,
  SourceRecordRef,
  SourceHealthResult,
  SourceRecordReference,
  RetrievedFile,
} from "../types";
import {
  fetchTrrcCompletionsForApis,
  type TrrcCompletionRecord,
} from "../../wells/trrc-completions";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const CompletionSource: TrrcSourceAdapter = {
  id: "completion_query",
  name: "EWA Completion Query",
  description:
    "TRRC EWA completion query (W-2 / Completion Report). Returns packet availability, " +
    "completion date, operator of record at completion, wellbore profile, and total depth. " +
    "Detailed formation and interval data requires imaged W-2 document.",
  base_url: EWA_BASE,
  supported_inputs: ["api_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_COMPLETION_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
    if (ctx.api_numbers.length === 0) {
      return {
        source_id: this.id,
        status: "manual_required",
        records: [
          {
            source_id: this.id,
            document_id: "completion_manual_fallback",
            title: "Completion Query — Manual Retrieval Required",
            category: "completion",
            form_type: "W2_G1_completion",
            url: `${EWA_BASE}/drillingPermitsQueryAction.do`,
            filing_date: null,
            is_downloadable: false,
          },
        ],
        result_count: 0,
        data: {
          note: "No API numbers available. Search TRRC EWA drilling permits manually using operator name or lease number.",
        },
        error: null,
        manual_action_url: `${EWA_BASE}/drillingPermitsQueryAction.do`,
      };
    }

    try {
      const apis = ctx.api_numbers.map(a => a.api10);
      const completions = await fetchTrrcCompletionsForApis(apis);

      const records: SourceRecordRef[] = completions.map(
        (c: TrrcCompletionRecord): SourceRecordRef => ({
          source_id: this.id,
          document_id: `completion_${c.api}`,
          title: `Completion — API ${c.api}${c.completion_date ? ` (${c.completion_date})` : ""}${c.packet_found ? "" : " [No packet found]"}`,
          category: "completion",
          form_type: "W2_G1_completion",
          url: c.source_url,
          filing_date: c.completion_date ?? c.permit_approved_date ?? null,
          is_downloadable: false,
        }),
      );

      const found = completions.filter(c => c.packet_found);
      const notFound = completions.filter(c => !c.packet_found);

      return {
        source_id: this.id,
        status: records.length > 0 ? "success" : "no_results",
        records,
        result_count: records.length,
        data: {
          packets_found: found.length,
          packets_not_found: notFound.length,
          no_packet_apis: notFound.map(c => c.api),
          note: notFound.length > 0
            ? `${notFound.length} well(s) have no online W-2 packet. Check imaged records for pre-digital completions.`
            : null,
        },
        error: null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id: this.id,
        status: "failed_transient",
        records: [],
        result_count: 0,
        data: null,
        error: err instanceof Error ? err.message : "Network error fetching completions",
        manual_action_url: null,
      };
    }
  },

  async fetchRecord(
    _ref: SourceRecordReference,
    _opts: RetrievalOptions,
  ): Promise<RetrievedFile | null> {
    return null;
  },

  async healthCheck(): Promise<SourceHealthResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${EWA_BASE}/drillingPermitsQueryAction.do`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      return {
        healthy: res.ok,
        latency_ms: Date.now() - start,
        error: res.ok ? null : `HTTP ${res.status}`,
        last_checked: new Date().toISOString(),
      };
    } catch (err) {
      return {
        healthy: false,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : "Unknown error",
        last_checked: new Date().toISOString(),
      };
    }
  },
};
