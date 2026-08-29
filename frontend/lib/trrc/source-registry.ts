/**
 * TRRC Public Records Due Diligence — Authoritative source registry.
 *
 * This is the single source of truth for every TRRC public data source used
 * by the DD engine. No source URLs, rate limits, or capability claims should
 * live anywhere else in the codebase.
 *
 * is_enabled reads from process.env["TRRC_SOURCE_<ID_UPPER>_ENABLED"].
 * Default: enabled (true) unless the env var is explicitly set to "false".
 *
 * isTrrcDdEnabled() reads NEXT_PUBLIC_TRRC_DD_ENABLED. Default: true.
 */

import type { TrrcIdentifierType, TrrcRecordCategory } from "./types";

// ─── Source definition type ───────────────────────────────────────────────────

export type TrrcSourceDefinition = {
  /** Stable machine identifier, snake_case. Used as env var key suffix. */
  id: string;
  /** Human-readable name shown in UI */
  name: string;
  /** What this source provides and how retrieval works */
  description: string;
  /** Canonical base URL for the source system */
  official_base_url: string;
  /** Input identifier types this source can search by */
  supported_inputs: TrrcIdentifierType[];
  /** Record categories this source may return */
  expected_record_types: TrrcRecordCategory[];
  /** How the engine retrieves data from this source */
  retrieval_strategy: "api" | "html_scrape" | "dataset_download" | "manual";
  /** Minimum milliseconds to wait between requests to this source */
  rate_limit_ms: number;
  /** Maximum retry attempts on transient failures */
  max_retries: number;
  /** Known access barriers: CAPTCHAs, auth, session requirements, etc. */
  access_limitations: string;
  /** Notes on data currency, historical availability, or known gaps */
  date_range_notes: string;
  /** Semver string for the parser/adapter logic targeting this source */
  parser_version: string;
  /** Whether this source is currently enabled for automated retrieval */
  is_enabled: boolean;
};

// ─── Feature flag ─────────────────────────────────────────────────────────────

/**
 * Master feature flag for the entire TRRC DD system.
 * Reads NEXT_PUBLIC_TRRC_DD_ENABLED from the environment.
 * Defaults to true (enabled) unless explicitly set to "false".
 */
export function isTrrcDdEnabled(): boolean {
  const val = process.env["NEXT_PUBLIC_TRRC_DD_ENABLED"];
  return val !== "false";
}

// ─── Helper: resolve is_enabled from env ─────────────────────────────────────

function resolveEnabled(id: string): boolean {
  const envKey = `TRRC_SOURCE_${id.toUpperCase()}_ENABLED`;
  const val = process.env[envKey];
  return val !== "false";
}

// ─── Source registry ──────────────────────────────────────────────────────────

export const SOURCE_REGISTRY: Record<string, TrrcSourceDefinition> = {
  wellbore_query: {
    id: "wellbore_query",
    name: "EWA Wellbore Query",
    description:
      "TRRC Electronic Well Application (EWA) PDQ wellbore query. Primary source for well identity: " +
      "API number, operator, county, district, lease linkage, wellbore profile, and current well status. " +
      "Supports county scan and direct API-prefix lookup (apiNoPrefixArg + apiNoSuffixArg). " +
      "Returns HTML table parsed by structural cheerio traversal.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: [
      "api_number",
      "rrc_lease_number",
      "operator_name",
      "lease_name",
    ],
    expected_record_types: ["identity", "well_status"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Requires JSESSIONID session cookie established via GET to ewaPdqMain.do before POST queries. " +
      "No CAPTCHA as of 2026. County scan results paginated; large counties may require multiple pages.",
    date_range_notes:
      "Well identity records are current as of the most recent TRRC database update. " +
      "Historical operator-of-record changes are not surfaced in the query results.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("wellbore_query"),
  },

  production_by_lease: {
    id: "production_by_lease",
    name: "EWA Lease Production Query",
    description:
      "TRRC EWA specificLeaseQueryAction.do — monthly oil, casinghead gas, gas, condensate, and water " +
      "production by lease/district combination. Returns up to N months of production history. " +
      "CRITICAL: This is lease-level production only — it cannot be attributed to a single well " +
      "without per-well allocation evidence. canClaimSingleWellProduction is always false here.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["rrc_lease_number"],
    expected_record_types: ["production"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Requires active JSESSIONID session. District code (distCode) and lease number (leaseNo) " +
      "must both be known; lease number alone is insufficient without the district.",
    date_range_notes:
      "Production data is current through approximately 60–90 days prior to the query date " +
      "due to TRRC reporting lag. Reporting entities have 45 days after month-end to file.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("production_by_lease"),
  },

  production_by_api: {
    id: "production_by_api",
    name: "EWA API-Level Production",
    description:
      "TRRC EWA production query by API number. Returns monthly production history keyed to a " +
      "specific API/wellbore rather than a lease. Data availability depends on whether the operator " +
      "files per-well vs. per-lease production reports. Gas wells frequently report by API; oil wells " +
      "more commonly report by lease.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number"],
    expected_record_types: ["production"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Session cookie required. Many oil operators report at lease level only; per-API production " +
      "may return no results even for producing wells — absence of data here does not mean no production.",
    date_range_notes:
      "Same 60–90 day reporting lag as lease production. Historical data typically available for 24+ months.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("production_by_api"),
  },

  oil_proration: {
    id: "oil_proration",
    name: "EWA Oil Proration Query",
    description:
      "TRRC EWA oil proration allowable query. Returns current and historical proration allowables " +
      "for oil leases, including allowable volume, field rules, and any special conditions. " +
      "Useful for understanding regulatory production caps that may constrain actual output.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["rrc_lease_number", "api_number"],
    expected_record_types: ["production", "miscellaneous"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 2000,
    max_retries: 2,
    access_limitations:
      "Session cookie required. Proration data only exists for leases under proration field rules; " +
      "many fields are exempt (non-prorated). No CAPTCHA observed.",
    date_range_notes:
      "Current allowable is real-time; historical allowable records vary by field. " +
      "Exempt fields will return no proration data — expected behavior, not a retrieval failure.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("oil_proration"),
  },

  gas_proration: {
    id: "gas_proration",
    name: "EWA Gas Proration Query",
    description:
      "TRRC EWA gas proration allowable query. Analogous to oil_proration but for gas leases and " +
      "gas well IDs. Returns allowable MCF, field rules, and potential deliverability test data links. " +
      "Gas well deliverability tests (G-1, G-10) are referenced here but stored in imaged records.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["rrc_lease_number", "gas_well_id", "api_number"],
    expected_record_types: ["production", "miscellaneous"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 2000,
    max_retries: 2,
    access_limitations:
      "Session cookie required. Gas proration only applies to gas wells under field rules. " +
      "Most unconventional (shale) gas wells are exempt from proration and will return no data.",
    date_range_notes:
      "Current allowable is near-real-time. Historical gas proration data availability varies " +
      "by field vintage — older fields may have more complete records.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("gas_proration"),
  },

  completion_query: {
    id: "completion_query",
    name: "EWA Completion Query",
    description:
      "TRRC EWA completion query (W-2 / Completion Report). Returns packet availability, completion date, " +
      "operator of record at completion, wellbore profile (horizontal/vertical/directional), " +
      "total depth, and permit status. Detailed formation and interval data requires the imaged W-2 document.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number"],
    expected_record_types: ["completion", "drilling_permit"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Session cookie required. Batch mode supported: multiple APIs can be submitted in a single " +
      "session. Packet-not-found result (packet_found: false) is authoritative — no completion on record.",
    date_range_notes:
      "Completion records date back to the digitization era (approximately 1990s onward). " +
      "Pre-digital records exist only in imaged form and require manual retrieval.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("completion_query"),
  },

  inactive_well_query: {
    id: "inactive_well_query",
    name: "EWA Inactive Well Query",
    description:
      "TRRC EWA inactiveWellQueryAction.do. Identifies wells on the TRRC inactive/non-producing list " +
      "with estimated plugging costs, shut-in dates, inactivity duration, and extension status. " +
      "A well NOT appearing in results is actively producing or otherwise exempt — absence is a " +
      "positive signal. Results include P&A cost exposure and compliance due dates.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
    expected_record_types: ["plugging_inactive", "well_status"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Session cookie required. Query requires at least one of: API prefix, lease number, " +
      "county code, or operator number — blank search is rejected by TRRC.",
    date_range_notes:
      "Reflects current TRRC inactive well database. Status can change when a well returns to " +
      "production or is plugged — always query at time of diligence, do not rely on cached results.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("inactive_well_query"),
  },

  p5_operator_query: {
    id: "p5_operator_query",
    name: "EWA P-5 Operator Organization Query",
    description:
      "TRRC EWA organization/P-5 query. Returns operator P-5 status (Active, Active-Ext, Delinquent, " +
      "Inactive, Cancelled), mailing address, organization type, §91.114 financial assurance flag, " +
      "and bond/financial security status. A Delinquent or Cancelled P-5 is a significant compliance " +
      "red flag — TRRC will not issue new permits to delinquent operators.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["operator_name", "p5_number"],
    expected_record_types: ["operator_p5", "compliance"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Session cookie required. Operator name search uses fuzzy matching; multiple results may be " +
      "returned and require disambiguation. P-5 number search is exact.",
    date_range_notes:
      "P-5 status is current as of the TRRC database. Operators must renew P-5 annually; " +
      "lapsed renewal results in Delinquent status within 30 days of expiration.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("p5_operator_query"),
  },

  p4_gatherer_query: {
    id: "p4_gatherer_query",
    name: "EWA P-4 Gatherer/Purchaser Query (Manual Fallback)",
    description:
      "TRRC EWA P-4 purchaser/transporter query. Returns the list of companies authorized to " +
      "purchase or transport oil and gas in Texas, with P-4 permit status. Useful for verifying " +
      "whether the gathering company on a run statement is a registered TRRC purchaser. " +
      "Currently requires a browser session — automated scraping is unreliable due to dynamic JS rendering.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["operator_name"],
    expected_record_types: ["p4_gatherer"],
    retrieval_strategy: "manual",
    rate_limit_ms: 3000,
    max_retries: 1,
    access_limitations:
      "MANUAL FALLBACK — requires authenticated browser session. Dynamic JavaScript rendering " +
      "prevents reliable headless scraping. Engine generates a manual retrieval URL for the analyst.",
    date_range_notes:
      "P-4 permits are current as of the TRRC database. Annual renewal required. " +
      "Lapsed P-4 means the gatherer cannot legally purchase production in Texas.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("p4_gatherer_query"),
  },

  inspections_violations: {
    id: "inspections_violations",
    name: "EWA ICE Violations & Inspections Query",
    description:
      "TRRC PDA ICE (Inspection and Compliance Enforcement) portal. Returns field inspection records " +
      "and violations for a given API number or lease. Uses JSF/PrimeFaces AJAX protocol: " +
      "3-step session establishment → tab activation → search POST. " +
      "Violations data only available from August 1, 2015 onward via this search engine. " +
      "Full historical dataset available via separate downloadable dataset.",
    official_base_url: "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml",
    supported_inputs: ["api_number", "rrc_lease_number"],
    expected_record_types: ["compliance"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 2000,
    max_retries: 3,
    access_limitations:
      "JSF ViewState token must be refreshed per-session. Violations tab must be activated via " +
      "tabChange POST before search is available. No CAPTCHA as of 2026. " +
      "API must be in NNN-NNNNN InputMask format (no state prefix, with hyphen).",
    date_range_notes:
      "Online search covers violations from 2015-08-01 onward. Pre-2015 violations are not " +
      "surfaced in this interface — use the downloadable dataset for full historical coverage.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("inspections_violations"),
  },

  well_status_query: {
    id: "well_status_query",
    name: "EWA Well Status Query (Manual Fallback)",
    description:
      "TRRC EWA well status query for current operating status, work-over history, and shut-in reason. " +
      "Provides finer-grained status codes than the wellbore query: PA (plugged/abandoned), " +
      "SI (shut-in), AC (active), TA (temporarily abandoned), etc. " +
      "Manual fallback because the dedicated status endpoint requires a browser session for full output.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number", "rrc_lease_number"],
    expected_record_types: ["well_status"],
    retrieval_strategy: "manual",
    rate_limit_ms: 2000,
    max_retries: 2,
    access_limitations:
      "MANUAL FALLBACK — well status detail page requires browser-rendered JavaScript. " +
      "Basic status is available from the wellbore_query source without manual intervention.",
    date_range_notes:
      "Well status is current as of the TRRC database. Status changes are reflected within " +
      "approximately 30 days of the TRRC receiving a valid Form W-3/W-3C report.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("well_status_query"),
  },

  injection_uic_query: {
    id: "injection_uic_query",
    name: "EWA Injection/Disposal (UIC) Query",
    description:
      "TRRC EWA injection and disposal well query under Underground Injection Control (UIC) authority. " +
      "Returns injection permit status, authorized zones, maximum surface injection pressure (MSIP), " +
      "authorized injection volumes, and mechanical integrity test (MIT) history. " +
      "Critical for SWD (saltwater disposal) assets and any wellbore converted to injection use.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number", "rrc_lease_number"],
    expected_record_types: ["injection_uic", "compliance"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Session cookie required. Injection records only exist for wells that have filed UIC permits; " +
      "conventional producing wells will return no results — expected behavior.",
    date_range_notes:
      "Current permit terms and MIT history are current to the TRRC database. " +
      "MIT tests are required every 5 years; lapsed MITs are a compliance red flag.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("injection_uic_query"),
  },

  imaged_records_query: {
    id: "imaged_records_query",
    name: "TRRC Oil & Gas Imaged Records System (Manual Fallback)",
    description:
      "TRRC Oil & Gas imaged records portal — scanned copies of all filed paper documents: " +
      "W-1 (drilling permit), W-2 (completion report), W-3 (production log), W-14 (plugging report), " +
      "G-1 (gas well deliverability test), Form P-4, and all other filed forms. " +
      "This is the authoritative source for full formation/interval/perforation detail. " +
      "Requires a live browser session — headless access is blocked by CAPTCHA.",
    official_base_url: "https://ogims.rrc.texas.gov",
    supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
    expected_record_types: [
      "imaged_records",
      "drilling_permit",
      "completion",
      "plugging_inactive",
      "well_status",
      "identity",
    ],
    retrieval_strategy: "manual",
    rate_limit_ms: 5000,
    max_retries: 1,
    access_limitations:
      "MANUAL FALLBACK — CAPTCHA blocks all headless/automated access as of 2026. " +
      "Engine generates a direct search URL for the analyst; documents must be reviewed manually. " +
      "Free account registration may be required for bulk downloads.",
    date_range_notes:
      "Imaging coverage begins approximately 1993 for digitized records. Older records exist on microfiche " +
      "at the Austin TRRC office and are not available online. Recent filings are typically online within 30 days.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("imaged_records_query"),
  },

  imaged_records_cmpl: {
    id: "imaged_records_cmpl",
    name: "TRRC CMPL Completion Packets (Post-2009)",
    description:
      "Automated: W-2/G-1 completion packets filed online November 2009 onward. " +
      "Queries the TRRC CMPL portal (webapps.rrc.texas.gov/CMPL) for completion records. " +
      "Also surfaces Neubus manual-link records for pre-2009 historical coverage.",
    official_base_url: "https://webapps.rrc.texas.gov/CMPL",
    supported_inputs: ["api_number"],
    expected_record_types: ["completion"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 2000,
    max_retries: 2,
    access_limitations:
      "Covers CMPL filings from Nov 2009 onward. Pre-2009 records require Neubus browser access. " +
      "Requires JSESSIONID session cookie and Struts anti-CSRF token obtained from the CMPL home page.",
    date_range_notes:
      "Completion packets filed online from November 2, 2009 to present. " +
      "Earlier completions are only available via the Neubus imaged records system (manual fallback).",
    parser_version: "1.0",
    is_enabled: resolveEnabled("imaged_records_cmpl"),
  },

  drilling_permit_query: {
    id: "drilling_permit_query",
    name: "EWA Drilling Permit Query (Manual Fallback)",
    description:
      "TRRC EWA drilling permit (W-1) query. Returns permit approval date, permit number, well type " +
      "authorized, surface location, and permit conditions. Useful for understanding development pipeline " +
      "and confirming that wellbores were permitted before drilling. " +
      "Manual fallback because the dedicated permit detail requires a browser session for attachments.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number", "operator_name"],
    expected_record_types: ["drilling_permit"],
    retrieval_strategy: "manual",
    rate_limit_ms: 2000,
    max_retries: 2,
    access_limitations:
      "MANUAL FALLBACK — permit attachments and conditions require browser rendering. " +
      "Basic permit number and approval date are available from completion_query without manual intervention.",
    date_range_notes:
      "Drilling permit records are available from approximately 2000 onward in the EWA system. " +
      "Older permits exist in imaged_records_query only.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("drilling_permit_query"),
  },

  lease_index: {
    id: "lease_index",
    name: "TRRC Downloadable Lease Name Index",
    description:
      "TRRC downloadable lease name index dataset. Provides a mapping of lease name, district, " +
      "county, operator, and lease number for all registered oil and gas leases. " +
      "Used for lease name → lease number resolution when only a lease name is known. " +
      "Downloaded as a bulk CSV/TXT file and parsed in-memory.",
    official_base_url: "https://www.rrc.texas.gov/resource-center/research/oil-gas-data-research/",
    supported_inputs: ["lease_name", "rrc_lease_number"],
    expected_record_types: ["identity"],
    retrieval_strategy: "dataset_download",
    rate_limit_ms: 5000,
    max_retries: 2,
    access_limitations:
      "Bulk dataset; no per-request rate limiting but should not be downloaded more than once " +
      "per DD run. File size is typically several MB. No authentication required.",
    date_range_notes:
      "Updated quarterly by TRRC. Dataset reflects leases as of the last quarterly refresh. " +
      "Newly created leases may not appear for up to 90 days.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("lease_index"),
  },

  plugging_records: {
    id: "plugging_records",
    name: "EWA Plugging Record Query (Manual Fallback)",
    description:
      "TRRC EWA plugging record query. Returns P&A records for plugged wellbores: " +
      "plug date, plugging contractor, cement intervals, and regulatory sign-off. " +
      "A plugged well appearing in an asset package is a critical red flag — " +
      "plugged wells cannot be returned to production without TRRC approval of a re-entry permit. " +
      "Manual fallback because the plugging detail page requires a browser session.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
    expected_record_types: ["plugging_inactive"],
    retrieval_strategy: "manual",
    rate_limit_ms: 2000,
    max_retries: 2,
    access_limitations:
      "MANUAL FALLBACK — plugging detail pages require browser rendering. " +
      "Well status code 'PA' in wellbore_query results indicates plugging; this source provides the detail.",
    date_range_notes:
      "Plugging records are current to the TRRC database. Form W-14 filings are the authoritative " +
      "source; they must be filed within 30 days of plugging completion.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("plugging_records"),
  },

  orphan_well_query: {
    id: "orphan_well_query",
    name: "TRRC Orphan Well Program Query (Manual Fallback)",
    description:
      "TRRC Orphan Well Program database — wells where the responsible operator is defunct, " +
      "insolvent, or has forfeited their P-5. Orphan wells carry state liability for plugging costs " +
      "and can be acquired by third parties for the plug-and-abandon work. " +
      "A well appearing in the orphan well database in the same area as subject assets is a " +
      "significant environmental and reputational risk flag for the buyer. " +
      "Separate system from EWA; manual fallback required.",
    official_base_url: "https://www.rrc.texas.gov/oil-and-gas/environmental-cleanup-programs/oil-field-cleanup-program/orphan-wells/",
    supported_inputs: ["operator_name", "api_number"],
    expected_record_types: ["plugging_inactive", "compliance"],
    retrieval_strategy: "manual",
    rate_limit_ms: 3000,
    max_retries: 1,
    access_limitations:
      "MANUAL FALLBACK — separate TRRC system from EWA. Public web interface; no authentication required " +
      "but no machine-readable API. Engine generates a search URL; analyst must review results manually.",
    date_range_notes:
      "Orphan well list is updated as wells are added (operator default) or removed (plugged by state). " +
      "Currency is approximately 30 days behind current TRRC database state.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("orphan_well_query"),
  },

  severance_query: {
    id: "severance_query",
    name: "TRRC Severance / Seal Order Query (Manual Fallback)",
    description:
      "TRRC severance and seal order database. A severance order prohibits an operator from producing " +
      "from a well pending compliance with a TRRC directive. A seal order physically locks the wellhead. " +
      "Either order is a critical compliance finding that must be resolved before acquisition. " +
      "No automated scraping endpoint — manual fallback with generated search URL.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["api_number", "rrc_lease_number", "operator_name"],
    expected_record_types: ["compliance", "well_status"],
    retrieval_strategy: "manual",
    rate_limit_ms: 3000,
    max_retries: 1,
    access_limitations:
      "MANUAL FALLBACK — severance/seal order query requires browser session and is not reliably " +
      "accessible via headless scraping. Engine generates a manual retrieval URL.",
    date_range_notes:
      "Active orders are current to the TRRC database. Lifted orders remain in the record but " +
      "are flagged as inactive. Orders from 2015 onward are available online.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("severance_query"),
  },

  lease_inventory: {
    id: "lease_inventory",
    name: "TRRC Lease Well Inventory",
    description:
      "Queries TRRC EWA wellboreQueryAction.do by district + lease number to enumerate ALL wells " +
      "on the lease. Used to establish well count for production attribution. " +
      "CRITICAL: canClaimSingleWellProduction is always false. " +
      "For Lease 60509 / District 8A this must return ≥ 52 wells.",
    official_base_url: "https://webapps2.rrc.texas.gov/EWA",
    supported_inputs: ["rrc_lease_number"],
    expected_record_types: ["identity"],
    retrieval_strategy: "html_scrape",
    rate_limit_ms: 1500,
    max_retries: 3,
    access_limitations:
      "Requires JSESSIONID session cookie. Query requires both districtCodeArg and leaseNumberArg. " +
      "Results paginated; uses 2-request strategy (POST page 1 + GET with pageSize=500) for efficiency.",
    date_range_notes:
      "Well inventory reflects current TRRC registration. Newly drilled wells appear within " +
      "approximately 30 days of the TRRC receiving a valid permit filing.",
    parser_version: "1.0.0",
    is_enabled: resolveEnabled("lease_inventory"),
  },

  gis_wellbore: {
    id: "gis_wellbore",
    name: "TRRC GIS Well Locations",
    description:
      "ArcGIS public well location data — coordinates, status, operator. " +
      "Uses the Statewide Surface Wells ArcGIS REST service (Aug 2019 snapshot). " +
      "Supports API-number coordinate lookup, legal-description → OTLS abstract polygon → API " +
      "resolution, and offset well search by bounding box. No authentication required.",
    official_base_url:
      "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Statewide_Surface_Wells_Aug2019/FeatureServer/0",
    supported_inputs: [
      "api_number",
      "legal_description",
      "rrc_lease_number",
      "operator_name",
      "lease_name",
    ],
    expected_record_types: ["gis"],
    retrieval_strategy: "api",
    rate_limit_ms: 500,
    max_retries: 2,
    access_limitations: "Public ArcGIS REST API — no authentication required",
    date_range_notes:
      "Well location data as of August 2019 — coordinates may not reflect recent spuds",
    parser_version: "1.0",
    is_enabled: resolveEnabled("gis_wellbore"),
  },
};

// ─── Registry accessors ───────────────────────────────────────────────────────

/**
 * Returns all sources where is_enabled is true.
 * Respects environment variable overrides at call time.
 */
export function getEnabledSources(): TrrcSourceDefinition[] {
  return Object.values(SOURCE_REGISTRY).filter((s) => s.is_enabled);
}

/**
 * Look up a source by its stable id string.
 * Returns null when the id is not in the registry.
 */
export function getSourceById(id: string): TrrcSourceDefinition | null {
  return SOURCE_REGISTRY[id] ?? null;
}

/**
 * Returns all enabled sources that support a given input identifier type.
 * Includes both automated and manual-fallback sources.
 */
export function getSourcesForInput(inputType: TrrcIdentifierType): TrrcSourceDefinition[] {
  return Object.values(SOURCE_REGISTRY).filter(
    (s) => s.is_enabled && s.supported_inputs.includes(inputType),
  );
}

/**
 * Returns all enabled sources that are expected to return records for a given category.
 */
export function getSourcesForCategory(category: TrrcRecordCategory): TrrcSourceDefinition[] {
  return Object.values(SOURCE_REGISTRY).filter(
    (s) => s.is_enabled && s.expected_record_types.includes(category),
  );
}

/**
 * Returns all sources that require manual retrieval (retrieval_strategy === "manual").
 * These generate action URLs for the analyst rather than fetching automatically.
 */
export function getManualFallbackSources(): TrrcSourceDefinition[] {
  return Object.values(SOURCE_REGISTRY).filter(
    (s) => s.is_enabled && s.retrieval_strategy === "manual",
  );
}
