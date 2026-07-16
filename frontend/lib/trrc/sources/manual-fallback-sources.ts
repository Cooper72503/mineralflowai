/**
 * TRRC Manual Fallback Source Adapters
 *
 * Most adapters in this file have been upgraded to real automated implementations.
 * Only adapters that are genuinely CAPTCHA-gated or require browser sessions remain manual.
 *
 * Automated adapters (html_scrape, requires_browser: false):
 *   - plugging_records        → fetchTrrcPluggingByApi / fetchTrrcPluggingByLease
 *   - orphan_well_query       → fetchTrrcOrphanWellByApi
 *   - severance_query         → fetchTrrcSeveranceByApi / fetchTrrcSeveranceByOperator
 *   - p4_gatherer_query       → fetchTrrcP4ByApi / fetchTrrcP4ByLease
 *   - well_status_query       → fetchTrrcWellStatus / fetchTrrcWellStatusByLease
 *
 * Still manual (CAPTCHA / browser required):
 *   - imaged_records_query    (CAPTCHA-gated, OGIMS system)
 *   - drilling_permit_query   (browser rendering required for attachments)
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

import { fetchTrrcPluggingByApi, fetchTrrcPluggingByLease }   from "../../wells/trrc-plugging";
import { fetchTrrcOrphanWellByApi }                           from "../../wells/trrc-orphan-wells";
import { fetchTrrcSeveranceByApi, fetchTrrcSeveranceByOperator } from "../../wells/trrc-severance";
import { fetchTrrcP4ByApi, fetchTrrcP4ByLease }               from "../../wells/trrc-p4";
import { fetchTrrcWellStatus, fetchTrrcWellStatusByLease }    from "../../wells/trrc-well-status";

// ─── Shared helpers ───────────────────────────────────────────────────────────

function manualHealthCheck(url: string): () => Promise<SourceHealthResult> {
  return async () => {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      return {
        healthy: res.ok || res.status === 405, // 405 = HEAD not allowed but server reachable
        latency_ms: Date.now() - start,
        error: res.ok || res.status === 405 ? null : `HTTP ${res.status}`,
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
  };
}

function noopFetchRecord(
  _ref: SourceRecordReference,
  _opts: RetrievalOptions,
): Promise<RetrievedFile | null> {
  return Promise.resolve(null);
}

function buildManualResult(
  sourceId: string,
  manualUrl: string,
  title: string,
  formType: string,
  category: SourceRecordRef["category"],
  noteForAnalyst: string,
): SourceSearchResult {
  const record: SourceRecordRef = {
    source_id: sourceId,
    document_id: `manual_${sourceId}`,
    title,
    category,
    form_type: formType,
    url: manualUrl,
    filing_date: null,
    is_downloadable: false,
  };

  return {
    source_id: sourceId,
    status: "manual_required",
    records: [record],
    result_count: 0,
    data: {
      manual_action_required: true,
      note: noteForAnalyst,
    },
    error: null,
    manual_action_url: manualUrl,
  };
}

// ─── 1. Imaged Records Query ──────────────────────────────────────────────────

const OGIMS_URL = "https://www.rrc.texas.gov/resource-center/research/oil-gas-records/oil-gas-imaged-records-query/";

export const ImagedRecordsSource: TrrcSourceAdapter = {
  id: "imaged_records_query",
  name: "TRRC Oil & Gas Imaged Records System (Manual Fallback)",
  description:
    "TRRC Oil & Gas imaged records portal — scanned copies of all filed paper documents. " +
    "CAPTCHA blocks all headless/automated access. Engine generates a direct search URL for the analyst.",
  base_url: "https://ogims.rrc.texas.gov",
  supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
  retrieval_strategy: "manual",
  rate_limit_ms: 5000,
  max_retries: 1,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_IMAGED_RECORDS_QUERY_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    const primaryApi = ctx.api_numbers[0];
    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC Imaged Records (OGIMS) requires a browser session.",
      "CAPTCHA blocks automated access.",
      "",
      "What to search for:",
      primaryApi
        ? `  API Number: ${primaryApi.formatted} (or ${primaryApi.api10})`
        : ctx.lease_number
          ? `  Lease Number: ${ctx.lease_number}${ctx.district ? ` / District: ${ctx.district}` : ""}`
          : ctx.operator_name
            ? `  Operator Name: ${ctx.operator_name}`
            : "  Use available identifiers (API, lease number, or operator name)",
      "",
      "Key documents to retrieve:",
      "  • W-2 (Completion Report) — formation intervals, perforation depths",
      "  • W-1 (Drilling Permit) — original permit conditions",
      "  • W-14 (Plugging Report) — P&A cement intervals (if applicable)",
      "  • G-1 (Gas Well Deliverability Test) — absolute open flow potential",
      "  • Form P-4 (Purchaser/Transporter Authorization)",
      "",
      "Coverage: approximately 1993 onward. Pre-1993 records on microfiche at Austin TRRC office.",
    ];

    return buildManualResult(
      this.id,
      OGIMS_URL,
      "TRRC Imaged Records — Manual Retrieval Required",
      "imaged_document",
      "imaged_records",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(OGIMS_URL),
};

// ─── 2. Drilling Permit Query ─────────────────────────────────────────────────

const PERMIT_URL = "https://www.rrc.texas.gov/oil-gas/applications-and-permits/drilling-permits/online-permit-applications/";

export const DrillingPermitSource: TrrcSourceAdapter = {
  id: "drilling_permit_query",
  name: "EWA Drilling Permit Query (Manual Fallback)",
  description:
    "TRRC EWA drilling permit (W-1) query. Permit attachments and conditions require browser rendering. " +
    "Basic permit number and approval date are available from completion_query without manual intervention.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "operator_name"],
  retrieval_strategy: "manual",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_DRILLING_PERMIT_QUERY_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    const primaryApi = ctx.api_numbers[0];
    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC Drilling Permit detail requires browser session.",
      "",
      "What to search for:",
      primaryApi
        ? `  API Number: ${primaryApi.formatted} (enter as county-well: ${primaryApi.county_code}-${primaryApi.well_code})`
        : ctx.operator_name
          ? `  Operator Name: ${ctx.operator_name}`
          : "  Use API number or operator name",
      "",
      "What to retrieve:",
      "  • W-1 permit approval date and permit number",
      "  • Authorized well type (oil, gas, SWD, etc.)",
      "  • Surface location (survey, abstract, section)",
      "  • Any permit conditions or special requirements",
      "  • If amended, retrieve the latest amendment",
      "",
      "Note: Basic permit data (number, date, total depth) is often available from the",
      "completion_query source without manual retrieval.",
    ];

    return buildManualResult(
      this.id,
      PERMIT_URL,
      "Drilling Permit — Manual Retrieval Required",
      "W1_drilling_permit",
      "drilling_permit",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(PERMIT_URL),
};

// ─── 3. Plugging Records ──────────────────────────────────────────────────────

const PLUGGING_URL = "https://webapps2.rrc.texas.gov/EWA/pluggingQueryAction.do";

export const PluggingRecordsSource: TrrcSourceAdapter = {
  id: "plugging_records",
  name: "EWA Plugging Record Query",
  description:
    "TRRC EWA plugging record query. Plugged wells cannot return to production without TRRC re-entry permit. " +
    "Returns plugging method, depth, and status for each plugged well.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "2.0.0",
  is_enabled: process.env["TRRC_SOURCE_PLUGGING_RECORDS_ENABLED"] !== "false",
  requires_browser: false,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    try {
      const primaryApi = ctx.api_numbers[0];
      let records;

      if (primaryApi) {
        records = await fetchTrrcPluggingByApi(primaryApi.api10);
      } else if (ctx.lease_number && ctx.district) {
        records = await fetchTrrcPluggingByLease(ctx.district, ctx.lease_number);
      } else {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      if (records.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const refs: SourceRecordRef[] = records.map((r, i) => ({
        source_id:      this.id,
        document_id:    `plugging_${r.api8}_${i}`,
        title:          `Plugging Record — API ${r.api8}${r.status ? ` (${r.status})` : ""}`,
        category:       "plugging_inactive" as const,
        form_type:      "plugging_record",
        url:            `${PLUGGING_URL}?methodToCall=search&searchArgs.apiNoPrefixArg=${r.api8.slice(0, 3)}&searchArgs.apiNoSuffixArg=${r.api8.slice(3, 8)}`,
        filing_date:    r.plug_end_date ?? r.plug_start_date,
        is_downloadable: false,
      }));

      return {
        source_id:         this.id,
        status:            "success",
        records:           refs,
        result_count:      records.length,
        data:              { plugging_records: records },
        error:             null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id:         this.id,
        status:            "failed_transient",
        records:           [],
        result_count:      0,
        data:              null,
        error:             err instanceof Error ? err.message : "Unknown error",
        manual_action_url: null,
      };
    }
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(PLUGGING_URL),
};

// ─── 4. Orphan Well Query ─────────────────────────────────────────────────────

const ORPHAN_URL = "https://webapps2.rrc.texas.gov/EWA/orphanWellQueryAction.do";

export const OrphanWellSource: TrrcSourceAdapter = {
  id: "orphan_well_query",
  name: "EWA Orphan Well Program Query",
  description:
    "TRRC EWA Orphan Well Program query — wells where responsible operator is defunct or insolvent. " +
    "An orphan well in the subject asset's API range is a critical liability finding.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 3000,
  max_retries: 1,
  parser_version: "2.0.0",
  is_enabled: process.env["TRRC_SOURCE_ORPHAN_WELL_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    try {
      const primaryApi = ctx.api_numbers[0];
      if (!primaryApi) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const records = await fetchTrrcOrphanWellByApi(primaryApi.api10);

      if (records.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const refs: SourceRecordRef[] = records.map((r, i) => ({
        source_id:      this.id,
        document_id:    `orphan_${r.api8}_${i}`,
        title:          `Orphan Well — API ${r.api8}${r.last_operator_name ? ` (last op: ${r.last_operator_name})` : ""}`,
        category:       "plugging_inactive" as const,
        form_type:      "orphan_well_record",
        url:            `${ORPHAN_URL}?methodToCall=search&searchArgs.apiNoPrefixArg=${r.api8.slice(0, 3)}&searchArgs.apiNoSuffixArg=${r.api8.slice(3, 8)}`,
        filing_date:    r.date_added,
        is_downloadable: false,
      }));

      return {
        source_id:         this.id,
        status:            "success",
        records:           refs,
        result_count:      records.length,
        data:              { orphan_well_records: records },
        error:             null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id:         this.id,
        status:            "failed_transient",
        records:           [],
        result_count:      0,
        data:              null,
        error:             err instanceof Error ? err.message : "Unknown error",
        manual_action_url: null,
      };
    }
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(ORPHAN_URL),
};

// ─── 5. Severance Query ───────────────────────────────────────────────────────

const SEVERANCE_URL = "https://webapps2.rrc.texas.gov/EWA/severanceQueryAction.do";

export const SeveranceSource: TrrcSourceAdapter = {
  id: "severance_query",
  name: "EWA Severance / Seal Order Query",
  description:
    "TRRC EWA severance and seal order query. A severance order prohibits production pending compliance. " +
    "A seal order physically locks the wellhead. Either order is a critical diligence finding.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 3000,
  max_retries: 1,
  parser_version: "2.0.0",
  is_enabled: process.env["TRRC_SOURCE_SEVERANCE_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    try {
      const primaryApi = ctx.api_numbers[0];
      let records;

      if (primaryApi) {
        records = await fetchTrrcSeveranceByApi(primaryApi.api10);
      } else if (ctx.operator_number) {
        records = await fetchTrrcSeveranceByOperator(ctx.operator_number);
      } else {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      if (records.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const refs: SourceRecordRef[] = records.map((r, i) => ({
        source_id:      this.id,
        document_id:    `severance_${r.api8}_${i}`,
        title:          `Severance Order — API ${r.api8} (${r.status})${r.severance_reason ? `: ${r.severance_reason}` : ""}`,
        category:       "compliance" as const,
        form_type:      "severance_seal_order",
        url:            `${SEVERANCE_URL}?methodToCall=search&searchArgs.apiNoPrefixArg=${r.api8.slice(0, 3)}&searchArgs.apiNoSuffixArg=${r.api8.slice(3, 8)}`,
        filing_date:    r.severance_date,
        is_downloadable: false,
      }));

      return {
        source_id:         this.id,
        status:            "success",
        records:           refs,
        result_count:      records.length,
        data:              { severance_records: records },
        error:             null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id:         this.id,
        status:            "failed_transient",
        records:           [],
        result_count:      0,
        data:              null,
        error:             err instanceof Error ? err.message : "Unknown error",
        manual_action_url: null,
      };
    }
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(SEVERANCE_URL),
};

// ─── 6. P-4 Gatherer Query ────────────────────────────────────────────────────

const P4_URL = "https://webapps2.rrc.texas.gov/EWA/p4QueryAction.do";

export const P4GathererSource: TrrcSourceAdapter = {
  id: "p4_gatherer_query",
  name: "EWA P-4 Gatherer/Purchaser Query",
  description:
    "TRRC EWA P-4 purchaser/transporter authority query. Verifies which gathering companies are " +
    "authorized to purchase production from a well and whether their P-4 authority is current.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 3000,
  max_retries: 1,
  parser_version: "2.0.0",
  is_enabled: process.env["TRRC_SOURCE_P4_GATHERER_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    try {
      const primaryApi = ctx.api_numbers[0];
      let records;

      if (primaryApi) {
        records = await fetchTrrcP4ByApi(primaryApi.api10);
      } else if (ctx.lease_number && ctx.district) {
        records = await fetchTrrcP4ByLease(ctx.district, ctx.lease_number);
      } else {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      if (records.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const refs: SourceRecordRef[] = records.map((r, i) => ({
        source_id:      this.id,
        document_id:    `p4_${r.api8}_${i}`,
        title:          `P-4 Authority — API ${r.api8}${r.gatherer_purchaser_name ? ` / ${r.gatherer_purchaser_name}` : ""}${r.termination_date ? ` (terminated ${r.termination_date})` : " (current)"}`,
        category:       "p4_gatherer" as const,
        form_type:      "P4_transportation_authority",
        url:            `${P4_URL}?methodToCall=search&searchArgs.apiNoPrefixArg=${r.api8.slice(0, 3)}&searchArgs.apiNoSuffixArg=${r.api8.slice(3, 8)}&searchArgs.leaseTypeArg=O`,
        filing_date:    r.effective_date,
        is_downloadable: false,
      }));

      return {
        source_id:         this.id,
        status:            "success",
        records:           refs,
        result_count:      records.length,
        data:              { p4_records: records },
        error:             null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id:         this.id,
        status:            "failed_transient",
        records:           [],
        result_count:      0,
        data:              null,
        error:             err instanceof Error ? err.message : "Unknown error",
        manual_action_url: null,
      };
    }
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(P4_URL),
};

// ─── 7. Well Status Query ─────────────────────────────────────────────────────

const WELL_STATUS_URL = "https://webapps2.rrc.texas.gov/EWA/wellStatusQueryAction.do";

export const WellStatusSource: TrrcSourceAdapter = {
  id: "well_status_query",
  name: "EWA Well Status Query",
  description:
    "TRRC EWA well status query for current operating status, well type, and formation. " +
    "Provides finer-grained status (Active, Inactive, Shut-in, Plugged) with status date.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "2.0.0",
  is_enabled: process.env["TRRC_SOURCE_WELL_STATUS_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    try {
      const primaryApi = ctx.api_numbers[0];
      let records;

      if (primaryApi) {
        records = await fetchTrrcWellStatus(primaryApi.api10);
      } else if (ctx.lease_number && ctx.district) {
        records = await fetchTrrcWellStatusByLease(ctx.district, ctx.lease_number);
      } else {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      if (records.length === 0) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: null,
          error: null,
          manual_action_url: null,
        };
      }

      const refs: SourceRecordRef[] = records.map((r, i) => ({
        source_id:      this.id,
        document_id:    `well_status_${r.api8}_${i}`,
        title:          `Well Status — API ${r.api8}${r.current_status ? ` (${r.current_status})` : ""}${r.well_type ? ` / ${r.well_type}` : ""}`,
        category:       "well_status" as const,
        form_type:      "OG2_well_status",
        url:            `${WELL_STATUS_URL}?methodToCall=search&searchArgs.apiNoPrefixArg=${r.api8.slice(0, 3)}&searchArgs.apiNoSuffixArg=${r.api8.slice(3, 8)}`,
        filing_date:    r.status_date,
        is_downloadable: false,
      }));

      return {
        source_id:         this.id,
        status:            "success",
        records:           refs,
        result_count:      records.length,
        data:              { well_status_records: records },
        error:             null,
        manual_action_url: null,
      };
    } catch (err) {
      return {
        source_id:         this.id,
        status:            "failed_transient",
        records:           [],
        result_count:      0,
        data:              null,
        error:             err instanceof Error ? err.message : "Unknown error",
        manual_action_url: null,
      };
    }
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(WELL_STATUS_URL),
};
