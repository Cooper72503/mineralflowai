/**
 * TRRC CMPL Completion Packets — Automated Source Adapter (Post-2009)
 *
 * This adapter handles post-2009 CMPL completion packets automatically via
 * `fetchTrrcImagedRecordsMulti`. It queries the TRRC CMPL portal for W-2/G-1
 * completion packets filed online from November 2, 2009 onward.
 *
 * Pre-2009 Neubus records remain in the manual fallback (imaged_records_query).
 * This adapter also appends a Neubus manual-link record for each API so analysts
 * know to check historical records too.
 */

import { fetchTrrcImagedRecordsMulti } from "../../wells/trrc-imaged-records";
import type {
  TrrcSourceAdapter,
  ResolvedSearchContext,
  RetrievalOptions,
  SourceSearchResult,
  SourceRecordRef,
  SourceHealthResult,
  TrrcRecordCategory,
} from "../types";

export const ImagedRecordsCmplSource: TrrcSourceAdapter = {
  id: "imaged_records_cmpl",
  name: "TRRC CMPL Completion Packets (Post-2009)",
  description:
    "Automated retrieval of W-2/G-1 completion packets from TRRC CMPL portal. " +
    "Covers completion packets filed online from November 2, 2009 onward. " +
    "Also appends Neubus manual-link records for pre-2009 historical coverage.",
  base_url: "https://webapps.rrc.texas.gov/CMPL",
  supported_inputs: ["api_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "1.0",
  is_enabled: process.env["TRRC_SOURCE_IMAGED_RECORDS_CMPL_ENABLED"] !== "false",
  requires_browser: false,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    if (ctx.api_numbers.length === 0) {
      return {
        source_id: "imaged_records_cmpl",
        status: "not_applicable",
        records: [],
        result_count: 0,
        data: null,
        error: null,
        manual_action_url: null,
      };
    }

    try {
      const apis = ctx.api_numbers.map((a) => a.api10);
      // Returns TrrcImagedRecordsResult[] — one entry per API
      const results = await fetchTrrcImagedRecordsMulti(apis);

      const records: SourceRecordRef[] = [];

      for (const result of results) {
        for (const rec of result.records) {
          records.push({
            source_id: "imaged_records_cmpl",
            document_id: rec.doc_id ?? `cmpl_${rec.api10}_${rec.filing_date ?? "unknown"}`,
            title: rec.doc_label,
            category: "completion" as TrrcRecordCategory,
            form_type: rec.doc_type,
            url: rec.viewer_url,
            filing_date: rec.filing_date ?? null,
            is_downloadable: true,
          });
        }
      }

      // Append a Neubus manual-link record for each API so analysts know to
      // check historical (pre-2009) imaged records in the Neubus system.
      for (const api of ctx.api_numbers) {
        const api8 = api.api10.substring(2, 10); // strip "42" state prefix → 8 digits
        records.push({
          source_id: "imaged_records_cmpl",
          document_id: `neubus_${api8}`,
          title: `Historical Well File (Pre-2009) — Neubus Imaged Records — API ${api.formatted}`,
          category: "imaged_records" as TrrcRecordCategory,
          form_type: "neubus_historical",
          url: `https://rrcsearch3.neubus.com/search-profile?profileId=17&search_fields-api_ft=${api8}`,
          filing_date: null,
          is_downloadable: false,
        });
      }

      const cmplCount = results.reduce((n, r) => n + r.records.length, 0);

      return {
        source_id: "imaged_records_cmpl",
        status: records.length > 0 ? "success" : "no_results",
        records,
        result_count: records.length,
        data: {
          cmpl_count: cmplCount,
          neubus_links: ctx.api_numbers.length,
        },
        error: null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id: "imaged_records_cmpl",
        status: "failed_transient",
        records: [],
        result_count: 0,
        data: null,
        error: err instanceof Error ? err.message : String(err),
        manual_action_url: null,
      };
    }
  },

  async healthCheck(): Promise<SourceHealthResult> {
    const start = Date.now();
    try {
      const res = await fetch("https://webapps.rrc.texas.gov/CMPL/publicHomeAction.do", {
        signal: AbortSignal.timeout(10_000),
        method: "HEAD",
      });
      return {
        healthy: res.ok || res.status < 500,
        latency_ms: Date.now() - start,
        error: null,
        last_checked: new Date().toISOString(),
      };
    } catch (err) {
      return {
        healthy: false,
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        last_checked: new Date().toISOString(),
      };
    }
  },
};
