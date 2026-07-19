/**
 * Anthropic tool definitions for the TRRC Public Records Investigator agent.
 *
 * 17 tools covering all TRRC/EWA sources, plus submit_report.
 */

import type Anthropic from "@anthropic-ai/sdk";

export const TRRC_AGENT_TOOLS: Anthropic.Tool[] = [
  // ── 1. Identity resolution ──────────────────────────────────────────────────

  {
    name: "search_by_api",
    description:
      "Look up a well by API number in the TRRC PDQ wellbore database. " +
      "Returns lease number, district code, county, and operator name/number. " +
      "Use this first whenever an API number is provided to confirm the well exists and get linked identifiers.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number in any format (e.g. '42-165-02733', '4216502733', or '42165027330000')",
        },
      },
      required: ["api_number"],
    },
  },

  {
    name: "search_by_lease",
    description:
      "Look up a lease by RRC lease number and district. " +
      "Returns the full well inventory: all API numbers on the lease, well statuses, and well types. " +
      "Use this when you have a lease number to enumerate every well on the lease.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: {
          type: "string",
          description: "RRC lease number (e.g. '10289', '60509')",
        },
        district: {
          type: "string",
          description: "TRRC district code (e.g. '8A', '01', '02', '03', '04', '05', '06', '07B', '07C', '08', '08A', '09', '10')",
        },
      },
      required: ["lease_number", "district"],
    },
  },

  {
    name: "search_by_operator",
    description:
      "Look up an operator by name or P5 number. " +
      "Returns operator_number, bond status, organizational status (active/inactive/revoked), and P5 record details. " +
      "Use this to establish operator identity before running compliance or production queries.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_name: {
          type: "string",
          description: "Operator name as it appears in documents or TRRC (partial match supported)",
        },
        operator_number: {
          type: "string",
          description: "TRRC operator number / P5 number if already known (e.g. '102004')",
        },
      },
      required: [],
    },
  },

  {
    name: "search_by_legal_description",
    description:
      "GIS lookup using abstract number, survey name, section, township, and/or range. " +
      "Returns matched API numbers whose surface locations fall within the described parcel. " +
      "Use this when the input is a legal description rather than an API or lease number.",
    input_schema: {
      type: "object" as const,
      properties: {
        abstract_number: {
          type: "string",
          description: "Texas abstract number (e.g. 'A-145')",
        },
        survey_name: {
          type: "string",
          description: "Survey name (e.g. 'JOHN SMITH SURVEY')",
        },
        county: {
          type: "string",
          description: "County name (e.g. 'Midland', 'Reeves')",
        },
        section: {
          type: "string",
          description: "Section number if applicable",
        },
        township: {
          type: "string",
          description: "Township if applicable",
        },
        range: {
          type: "string",
          description: "Range if applicable",
        },
      },
      required: [],
    },
  },

  // ── 2. Production ────────────────────────────────────────────────────────────

  {
    name: "fetch_production",
    description:
      "Fetch monthly production history (oil bbl, gas MCF, water bbl, condensate bbl) from TRRC. " +
      "Preferred method: provide lease_number + district for lease-level production. " +
      "Alternative: provide api_number for API-level production history. " +
      "This is the authoritative TRRC production record — use these figures, NOT any seller-provided numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: {
          type: "string",
          description: "RRC lease number (preferred for lease-level production)",
        },
        district: {
          type: "string",
          description: "TRRC district code — required when fetching by lease",
        },
        api_number: {
          type: "string",
          description: "API number — use when lease-level query fails or is not applicable",
        },
        months: {
          type: "number",
          description: "Number of months of history to fetch (default 36, max 120)",
        },
      },
      required: [],
    },
  },

  // ── 3. Well integrity ────────────────────────────────────────────────────────

  {
    name: "fetch_completion_records",
    description:
      "Fetch W-2 completion packets for one or more API numbers from TRRC. " +
      "Returns formation name, total depth (ft), completion date, wellbore profile (vertical/horizontal/directional), " +
      "and lease name. Helps confirm well design and target formation.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "List of API numbers to fetch completion records for",
        },
      },
      required: ["api_numbers"],
    },
  },

  {
    name: "fetch_inactive_well_status",
    description:
      "Check if a specific well is on the TRRC EWA (Electronic Well Activity) inactive well list. " +
      "Returns inactive status, reason, and any associated compliance flags. " +
      "Inactive wells represent potential plugging liability.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to check for inactive status",
        },
        operator_number: {
          type: "string",
          description: "Operator number — use to retrieve all inactive wells for an operator",
        },
        lease_type: {
          type: "string",
          enum: ["O", "G"],
          description: "Lease type: 'O' for oil, 'G' for gas (used with operator_number query)",
        },
      },
      required: [],
    },
  },

  {
    name: "fetch_plugging_records",
    description:
      "Fetch EWA plugging records by API number or lease. " +
      "Returns plugging date, plugging contractor, depth plugged, and regulatory status. " +
      "Critical for assessing well abandonment liability.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to check for plugging records",
        },
        lease_number: {
          type: "string",
          description: "Lease number to check for any plugged wells on the lease",
        },
        district: {
          type: "string",
          description: "District code (required when querying by lease)",
        },
      },
      required: [],
    },
  },

  {
    name: "fetch_p4_records",
    description:
      "Fetch EWA P-4 production test records by API number or lease. " +
      "Returns test date, allowable, tested rate, and gatherer information. " +
      "Useful for verifying production capability independent of reported production.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to fetch P-4 records for",
        },
        lease_number: {
          type: "string",
          description: "Lease number to fetch P-4 records for",
        },
        district: {
          type: "string",
          description: "District code (required when querying by lease)",
        },
      },
      required: [],
    },
  },

  {
    name: "fetch_well_status",
    description:
      "Fetch EWA well status (active/inactive/plugged) for a specific API or all wells on a lease. " +
      "Returns current status, status date, and any status change history.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to fetch status for",
        },
        lease_number: {
          type: "string",
          description: "Lease number to fetch status for all wells on the lease",
        },
        district: {
          type: "string",
          description: "District code (required when querying by lease)",
        },
      },
      required: [],
    },
  },

  {
    name: "fetch_orphan_well_status",
    description:
      "Fetch EWA orphan well records for a specific API number. " +
      "An orphan well is one whose operator has become insolvent or forfeited their license — " +
      "the state or a plugging trust typically assumes responsibility. " +
      "Critical liability flag — check this for any distressed operator situation.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to check for orphan well status",
        },
      },
      required: ["api_number"],
    },
  },

  // ── 4. Compliance ────────────────────────────────────────────────────────────

  {
    name: "fetch_severance_records",
    description:
      "Fetch EWA severance records by API number or operator number. " +
      "Severance records document wellbore interval severances — relevant for casing integrity and workover history.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to fetch severance records for",
        },
        operator_number: {
          type: "string",
          description: "Operator number to fetch all severance records for an operator",
        },
      },
      required: [],
    },
  },

  {
    name: "fetch_compliance_violations",
    description:
      "Fetch TRRC compliance violations and field inspection records for an operator. " +
      "Returns open violations, closed violations, penalty amounts, and inspection results. " +
      "IMPORTANT: An empty result does NOT guarantee a clean compliance record — " +
      "it may indicate a failed query or incorrect identifier. Document what identifier was used.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_number: {
          type: "string",
          description: "TRRC operator number (preferred) — e.g. '102004'",
        },
        operator_name: {
          type: "string",
          description: "Operator name (used if operator number is not known)",
        },
        county: {
          type: "string",
          description: "County to narrow the search scope (optional)",
        },
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "API numbers to fetch well-level inspection records for (up to 3)",
        },
      },
      required: [],
    },
  },

  // ── 5. Additional sources ────────────────────────────────────────────────────

  {
    name: "fetch_proration",
    description:
      "Fetch proration schedule records by lease number. " +
      "Proration schedules govern allowable production rates for oil leases. " +
      "Returns allowable, production type, and proration history.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: {
          type: "string",
          description: "RRC lease number to fetch proration schedule for",
        },
        lease_type: {
          type: "string",
          enum: ["oil", "gas"],
          description: "Lease type — 'oil' or 'gas'",
        },
        district: {
          type: "string",
          description: "District code (optional, improves query specificity)",
        },
      },
      required: ["lease_number"],
    },
  },

  {
    name: "fetch_injection_records",
    description:
      "Fetch UIC/injection well records by API number or operator. " +
      "Returns injection authorization, permitted volume, and injection zone. " +
      "Use this if the well may be a disposal or enhanced recovery injection well.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to fetch injection records for",
        },
        operator_number: {
          type: "string",
          description: "Operator number to fetch all injection records for an operator",
        },
      },
      required: [],
    },
  },

  {
    name: "fetch_imaged_records",
    description:
      "Fetch post-2009 CMPL (Completion) imaged document packets from TRRC for one or more API numbers. " +
      "Returns document type, filing date, and document URLs for scanned official filings. " +
      "Useful for retrieving original W-2 completion packets and other filed documents.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "List of API numbers to retrieve imaged records for",
        },
      },
      required: ["api_numbers"],
    },
  },

  // ── 6. Final report ──────────────────────────────────────────────────────────

  {
    name: "submit_report",
    description:
      "Submit the completed due diligence investigation findings. " +
      "Call this when you have finished retrieving and analyzing all applicable TRRC data. " +
      "The raw data you collected will be assembled automatically into the full PDF report — " +
      "this call provides your analytical synthesis, scorecard, and recommendation.",
    input_schema: {
      type: "object" as const,
      properties: {
        recommendation: {
          type: "string",
          enum: ["pursue", "review", "blocked", "pass"],
          description:
            "Investment recommendation: " +
            "'pursue' = verified production, clean operator, no major flags; " +
            "'review' = warrants deeper investigation; " +
            "'blocked' = critical gating issue (fake API, revoked operator, catastrophic liability); " +
            "'pass' = does not meet investment criteria",
        },
        recommendation_rationale: {
          type: "string",
          description: "1-2 sentence rationale for the recommendation based on verified TRRC findings",
        },
        executive_summary: {
          type: "array",
          items: { type: "string" },
          description: "3-5 narrative paragraphs covering: asset description, production findings, compliance, operator health, and recommendation rationale",
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: ["identity", "production", "compliance", "inactive_well", "plugging", "mechanical", "operator", "data_gap"],
                description: "Finding category",
              },
              severity: {
                type: "string",
                enum: ["critical", "warning", "info"],
                description: "Severity: critical = deal-breaker or immediate action required; warning = material concern; info = notable but not blocking",
              },
              title: {
                type: "string",
                description: "Concise finding title (under 80 characters)",
              },
              detail: {
                type: "string",
                description: "Full finding description with specific data points from TRRC queries",
              },
              source_ids: {
                type: "array",
                items: { type: "string" },
                description: "Tool names that produced the evidence for this finding (e.g. ['search_by_api', 'fetch_production'])",
              },
            },
            required: ["category", "severity", "title", "detail", "source_ids"],
          },
          description: "All findings from the investigation, ordered by severity (critical first)",
        },
        scorecard: {
          type: "object",
          properties: {
            overall_score: {
              type: "number",
              description: "Weighted overall score from 0-100 (higher = better asset quality)",
            },
            dimensions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "Dimension identifier (e.g. 'production_quality', 'regulatory_compliance')",
                  },
                  name: {
                    type: "string",
                    description: "Human-readable dimension name",
                  },
                  score: {
                    type: "number",
                    description: "Dimension score 0-100",
                  },
                  weight: {
                    type: "number",
                    description: "Dimension weight 0.0-1.0; all weights across all dimensions must sum to exactly 1.0",
                  },
                  key_finding: {
                    type: "string",
                    description: "One sentence describing the key evidence for this dimension's score",
                  },
                },
                required: ["id", "name", "score", "weight", "key_finding"],
              },
              description: "All 10 scorecard dimensions — weights must sum to 1.0",
            },
          },
          required: ["overall_score", "dimensions"],
          description: "10-dimension acquisition scorecard",
        },
        data_gaps: {
          type: "array",
          items: { type: "string" },
          description: "Items that could not be verified and why (e.g. 'P-4 records unavailable for this district', 'Compliance query returned no results — may indicate failed query rather than clean record')",
        },
      },
      required: ["recommendation", "recommendation_rationale", "executive_summary", "findings", "scorecard", "data_gaps"],
    },
  },
];
