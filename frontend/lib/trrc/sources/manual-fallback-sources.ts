/**
 * TRRC Manual Fallback Source Adapters
 *
 * These sources require browser sessions, have CAPTCHAs, or are otherwise not automatable.
 * Each adapter:
 *   - Returns status: "manual_required" always
 *   - Generates a pre-filled official TRRC URL for the analyst
 *   - Does NOT claim success
 *   - Records a detailed note explaining exactly what to search for manually
 *
 * Adapters in this file:
 *   - imaged_records_query    (CAPTCHA-gated, OGIMS system)
 *   - drilling_permit_query   (browser rendering required for attachments)
 *   - plugging_records        (browser rendering required for plugging detail)
 *   - orphan_well_query       (separate TRRC system, no machine-readable API)
 *   - severance_query         (browser session required)
 *   - p4_gatherer_query       (dynamic JS rendering, unreliable headless access)
 *   - well_status_query       (browser-rendered JS for full status output)
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
  name: "EWA Plugging Record Query (Manual Fallback)",
  description:
    "TRRC EWA plugging record query. Plugged wells cannot return to production without TRRC re-entry permit. " +
    "Plugging detail page requires browser session for full record access.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
  retrieval_strategy: "manual",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_PLUGGING_RECORDS_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    const primaryApi = ctx.api_numbers[0];
    // Pre-fill URL with API number if available
    let actionUrl = PLUGGING_URL;
    if (primaryApi) {
      const params = new URLSearchParams({
        "methodToCall": "search",
        "searchArgs.apiNoPrefixArg": primaryApi.county_code,
        "searchArgs.apiNoSuffixArg": primaryApi.well_code,
      });
      actionUrl = `${PLUGGING_URL}?${params.toString()}`;
    } else if (ctx.lease_number && ctx.district) {
      const params = new URLSearchParams({
        "methodToCall": "search",
        "searchArgs.leaseNumberArg": ctx.lease_number,
        "searchArgs.districtCodeArg": ctx.district,
      });
      actionUrl = `${PLUGGING_URL}?${params.toString()}`;
    }

    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC Plugging Record detail requires browser session.",
      "",
      "What to search for:",
      primaryApi
        ? `  API County Prefix: ${primaryApi.county_code}  |  API Well Suffix: ${primaryApi.well_code}`
        : ctx.lease_number
          ? `  Lease Number: ${ctx.lease_number}${ctx.district ? `  |  District: ${ctx.district}` : ""}`
          : "  Use API number or lease number",
      "",
      "What to retrieve:",
      "  • Plug date and plugging contractor",
      "  • Cement intervals (top, bottom of cement for each plug)",
      "  • TRRC regulatory sign-off / W-14 filing date",
      "  • Any open plugging orders or compliance issues",
      "",
      "CRITICAL: A plugged well (W-14 filed) appearing in an asset package is a red flag.",
      "Plugged wells cannot be returned to production without TRRC re-entry permit approval.",
      "Well status code 'PA' in wellbore_query indicates plugging — this source provides detail.",
    ];

    return buildManualResult(
      this.id,
      actionUrl,
      "Plugging Records — Manual Retrieval Required",
      "W14_plugging_report",
      "plugging_inactive",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(PLUGGING_URL),
};

// ─── 4. Orphan Well Query ─────────────────────────────────────────────────────

const ORPHAN_URL = "https://www.rrc.texas.gov/oil-gas/publications-and-data/data-sets-available-for-download/";

export const OrphanWellSource: TrrcSourceAdapter = {
  id: "orphan_well_query",
  name: "TRRC Orphan Well Program Query (Manual Fallback)",
  description:
    "TRRC Orphan Well Program database — wells where responsible operator is defunct or insolvent. " +
    "Orphan wells in the same area as subject assets represent environmental and reputational risk. " +
    "No machine-readable API; manual review of downloadable dataset required.",
  base_url: "https://www.rrc.texas.gov/oil-and-gas/environmental-cleanup-programs/oil-field-cleanup-program/orphan-wells/",
  supported_inputs: ["operator_name", "api_number"],
  retrieval_strategy: "manual",
  rate_limit_ms: 3000,
  max_retries: 1,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_ORPHAN_WELL_QUERY_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    const primaryApi = ctx.api_numbers[0];
    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC Orphan Well dataset requires manual download and review.",
      "",
      "What to check:",
      primaryApi
        ? `  Search for API: ${primaryApi.api10} in the orphan well dataset`
        : ctx.operator_name
          ? `  Search for operator: ${ctx.operator_name}`
          : "  Download and search the full orphan well dataset",
      ctx.county
        ? `  County context: ${ctx.county} County, TX`
        : "",
      "",
      "Download orphan well list from:",
      "  https://www.rrc.texas.gov/oil-gas/publications-and-data/data-sets-available-for-download/",
      "  (Look for 'Orphan Well' or 'Oil Field Cleanup Program' dataset)",
      "",
      "What this tells you:",
      "  • Whether nearby orphan wells create environmental liability exposure for the buyer",
      "  • Whether the selling operator has abandoned wells in the same county",
      "  • Orphan well plugging is funded by the TRRC OFC bond pool — not the buyer",
      "    but reputational risk and community opposition can complicate operations.",
      "",
      "Note: list is approximately 30 days behind current TRRC database.",
    ].filter(Boolean);

    return buildManualResult(
      this.id,
      ORPHAN_URL,
      "Orphan Well Program — Manual Dataset Review Required",
      "orphan_well_record",
      "plugging_inactive",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(ORPHAN_URL),
};

// ─── 5. Severance Query ───────────────────────────────────────────────────────

const SEVERANCE_URL = "https://www.rrc.texas.gov/oil-gas/publications-and-data/data-sets-available-for-download/";

export const SeveranceSource: TrrcSourceAdapter = {
  id: "severance_query",
  name: "TRRC Severance / Seal Order Query (Manual Fallback)",
  description:
    "TRRC severance and seal order database. A severance order prohibits production pending compliance. " +
    "A seal order physically locks the wellhead. Either order is a critical finding. " +
    "Requires browser session; not reliably accessible via headless scraping.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
  retrieval_strategy: "manual",
  rate_limit_ms: 3000,
  max_retries: 1,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_SEVERANCE_QUERY_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    const primaryApi = ctx.api_numbers[0];
    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC Severance/Seal Order query requires browser session.",
      "",
      "What to search for:",
      primaryApi
        ? `  API Number: ${primaryApi.formatted}`
        : ctx.lease_number
          ? `  Lease Number: ${ctx.lease_number}${ctx.district ? ` / District: ${ctx.district}` : ""}`
          : ctx.operator_name
            ? `  Operator: ${ctx.operator_name}`
            : "  Use available identifiers",
      "",
      "Why this matters:",
      "  SEVERANCE ORDER — prohibits production from a well until TRRC directive is complied with.",
      "  SEAL ORDER — TRRC physically locks the wellhead; no production is physically possible.",
      "  Either order must be resolved before acquisition closes.",
      "  Active orders block production and prevent permit issuance.",
      "",
      "Data coverage: Online orders from 2015 onward.",
      "Downloadable severance data available at the TRRC publications page.",
      "",
      "CRITICAL FINDING if discovered: buyer must obtain written confirmation of order resolution",
      "from TRRC before proceeding with acquisition.",
    ];

    return buildManualResult(
      this.id,
      SEVERANCE_URL,
      "Severance / Seal Orders — Manual Retrieval Required",
      "severance_order",
      "compliance",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(SEVERANCE_URL),
};

// ─── 6. P-4 Gatherer Query ────────────────────────────────────────────────────

const P4_URL = "https://webapps2.rrc.texas.gov/EWA/p4QueryAction.do";

export const P4GathererSource: TrrcSourceAdapter = {
  id: "p4_gatherer_query",
  name: "EWA P-4 Gatherer/Purchaser Query (Manual Fallback)",
  description:
    "TRRC EWA P-4 purchaser/transporter query. Verifies whether the gathering company is a " +
    "registered TRRC purchaser. Dynamic JS rendering prevents reliable headless scraping.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["operator_name"],
  retrieval_strategy: "manual",
  rate_limit_ms: 3000,
  max_retries: 1,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_P4_GATHERER_QUERY_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    // Build pre-filled URL with operator name if available
    let actionUrl = P4_URL;
    if (ctx.operator_name) {
      const params = new URLSearchParams({
        "methodToCall": "search",
        "searchArgs.purchaserNameArg": ctx.operator_name,
      });
      actionUrl = `${P4_URL}?${params.toString()}`;
    }

    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC P-4 Gatherer/Purchaser query requires browser session.",
      "Dynamic JavaScript rendering prevents reliable automated access.",
      "",
      "What to search for:",
      ctx.operator_name
        ? `  Gatherer/Purchaser Name: ${ctx.operator_name}`
        : "  Name of the gathering company or purchaser listed on the run statement",
      "",
      "What to verify:",
      "  • P-4 permit status (Current | Expired | Cancelled)",
      "  • Authorization date and expiration date",
      "  • Types of commodities authorized (oil, gas, condensate)",
      "",
      "Why this matters:",
      "  A lapsed P-4 means the gatherer cannot legally purchase production in Texas.",
      "  Verify the gathering company on any run statement or JIB is an active P-4 holder.",
      "  If the gatherer is unlicensed, revenue may be at risk and TRRC can seize production.",
      "",
      "P-4 permits require annual renewal. A lapsed P-4 is an immediate operational risk.",
    ];

    return buildManualResult(
      this.id,
      actionUrl,
      "P-4 Gatherer/Purchaser — Manual Retrieval Required",
      "P4_gatherer_permit",
      "p4_gatherer",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(P4_URL),
};

// ─── 7. Well Status Query ─────────────────────────────────────────────────────

const WELL_STATUS_URL = "https://webapps2.rrc.texas.gov/EWA/wellStatusQueryAction.do";

export const WellStatusSource: TrrcSourceAdapter = {
  id: "well_status_query",
  name: "EWA Well Status Query (Manual Fallback)",
  description:
    "TRRC EWA well status query for current operating status, work-over history, and shut-in reason. " +
    "Provides finer-grained status codes (PA, SI, AC, TA, etc.) than the wellbore query. " +
    "Full status detail page requires browser-rendered JavaScript.",
  base_url: "https://webapps2.rrc.texas.gov/EWA",
  supported_inputs: ["api_number", "rrc_lease_number"],
  retrieval_strategy: "manual",
  rate_limit_ms: 2000,
  max_retries: 2,
  parser_version: "1.0.0",
  is_enabled: process.env["TRRC_SOURCE_WELL_STATUS_QUERY_ENABLED"] !== "false",
  requires_browser: true,

  async search(ctx: ResolvedSearchContext, _opts: RetrievalOptions): Promise<SourceSearchResult> {
    const primaryApi = ctx.api_numbers[0];
    // Build pre-filled URL
    let actionUrl = WELL_STATUS_URL;
    if (primaryApi) {
      const params = new URLSearchParams({
        "methodToCall": "search",
        "searchArgs.apiNoPrefixArg": primaryApi.county_code,
        "searchArgs.apiNoSuffixArg": primaryApi.well_code,
      });
      actionUrl = `${WELL_STATUS_URL}?${params.toString()}`;
    } else if (ctx.lease_number && ctx.district) {
      const params = new URLSearchParams({
        "methodToCall": "search",
        "searchArgs.leaseNumberArg": ctx.lease_number,
        "searchArgs.districtCodeArg": ctx.district,
      });
      actionUrl = `${WELL_STATUS_URL}?${params.toString()}`;
    }

    const noteLines = [
      "MANUAL ACTION REQUIRED — TRRC Well Status detail requires browser-rendered JavaScript.",
      "",
      "Note: Basic well status (AC/PA/SI/TA) is often available from the wellbore_query source.",
      "This source provides finer-grained status detail, work-over history, and shut-in reason.",
      "",
      "What to search for:",
      primaryApi
        ? `  API County Code: ${primaryApi.county_code}  |  API Well Suffix: ${primaryApi.well_code}`
        : ctx.lease_number
          ? `  Lease Number: ${ctx.lease_number}${ctx.district ? `  |  District: ${ctx.district}` : ""}`
          : "  Use API number or lease number",
      "",
      "Status codes to look for:",
      "  AC = Active / Producing",
      "  SI = Shut-in (not producing, reasons vary)",
      "  TA = Temporarily Abandoned",
      "  PA = Plugged and Abandoned (critical — see plugging_records source)",
      "",
      "Status changes are typically reflected within 30 days of a valid W-3/W-3C filing.",
    ];

    return buildManualResult(
      this.id,
      actionUrl,
      "Well Status — Manual Retrieval Required",
      "well_status_record",
      "well_status",
      noteLines.join("\n"),
    );
  },

  fetchRecord: noopFetchRecord,
  healthCheck: manualHealthCheck(WELL_STATUS_URL),
};
