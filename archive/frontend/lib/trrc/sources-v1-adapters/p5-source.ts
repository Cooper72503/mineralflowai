/**
 * TRRC Source Adapter — P-5 Operator Organization Query
 *
 * id: "p5_operator_query"
 * Queries TRRC EWA organizationQueryAction.do for operator P-5 status.
 * Returns: P-5 status (Active / Delinquent / Cancelled), address, TNR 91.114 flag, bond status.
 *
 * A Delinquent or Cancelled P-5 is a critical compliance red flag.
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
  fetchTrrcP5ByOperatorName,
  type TrrcP5Record,
} from "../../underwriting/trrc-p5";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

export const P5Source: TrrcSourceAdapter = {
  id: "p5_operator_query",
  name: "EWA P-5 Operator Organization Query",
  description:
    "TRRC EWA organization/P-5 query. Returns operator P-5 status (Active, Active-Ext, " +
    "Delinquent, Inactive, Cancelled), mailing address, organization type, §91.114 financial " +
    "assurance flag, and bond/financial security status.",
  base_url: EWA_BASE,
  supported_inputs: ["operator_name", "p5_number"],
  retrieval_strategy: "html_scrape",
  rate_limit_ms: 1500,
  max_retries: 3,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_P5_OPERATOR_QUERY_ENABLED"] !== "false",
  requires_browser: false,

  async search(
    ctx: ResolvedSearchContext,
    _opts: RetrievalOptions,
  ): Promise<SourceSearchResult> {
    if (!ctx.operator_name) {
      return {
        source_id: this.id,
        status: "not_applicable",
        records: [],
        result_count: 0,
        data: null,
        error: null,
        manual_action_url: null,
      };
    }

    try {
      const p5 = await fetchTrrcP5ByOperatorName(ctx.operator_name);

      if (!p5) {
        return {
          source_id: this.id,
          status: "no_results",
          records: [],
          result_count: 0,
          data: {
            note: "No P-5 record found for this operator name. Operator may not be registered with TRRC or name may differ from TRRC records.",
          },
          error: null,
          manual_action_url: `${EWA_BASE}/organizationQueryAction.do`,
        };
      }

      const record: SourceRecordRef = buildP5RecordRef(this.id, p5);

      return {
        source_id: this.id,
        status: "success",
        records: [record],
        result_count: 1,
        data: {
          operator_no: p5.operator_no,
          operator_name: p5.operator_name,
          org_status: p5.org_status,
          tnr_91114: p5.tnr_91114,
          mail_hold: p5.mail_hold,
          org_type: p5.org_type,
          is_compliance_flag: p5.tnr_91114 || ["Delinquent", "Cancelled"].includes(p5.org_status),
          note: p5.tnr_91114
            ? "CRITICAL: TNR §91.114 flag set — unsatisfied final orders exist. TRRC will not issue new permits."
            : p5.org_status === "Delinquent" || p5.org_status === "Cancelled"
              ? `COMPLIANCE ALERT: P-5 status is ${p5.org_status}. TRRC permit restrictions may apply.`
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
        error: err instanceof Error ? err.message : "Network error fetching P-5 record",
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
      const res = await fetch(`${EWA_BASE}/organizationQueryAction.do`, {
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

function buildP5RecordRef(sourceId: string, p5: TrrcP5Record): SourceRecordRef {
  return {
    source_id: sourceId,
    document_id: `p5_${p5.operator_no}`,
    title: `P-5 Organization Record — ${p5.operator_name} (${p5.org_status})`,
    category: "operator_p5",
    form_type: "P5_organization",
    url: `${EWA_BASE}/organizationQueryAction.do`,
    filing_date: null,
    is_downloadable: false,
  };
}
