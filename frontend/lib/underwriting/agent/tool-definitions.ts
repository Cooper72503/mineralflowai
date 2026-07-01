import type Anthropic from "@anthropic-ai/sdk";

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "verify_api",
    description:
      "Verify whether an API number exists in the TRRC database and retrieve the associated lease number, district, operator, and county. Always call this before using any API number provided by the seller.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "API number to verify (e.g. '42-165-02733' or '4216502733')",
        },
      },
      required: ["api_number"],
    },
  },
  {
    name: "fetch_production_by_lease",
    description:
      "Fetch the full monthly oil and gas production history from TRRC for a specific lease. This is the authoritative TRRC production record — use these figures in the report, NOT the seller's stated production.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: {
          type: "string",
          description: "RRC lease number (e.g. '10289' or '60509')",
        },
        district: {
          type: "string",
          description: "TRRC district code (e.g. '8A', '01', '06', '02', '03', '04', '05', '07C', '07B', '08', '08A', '09', '10')",
        },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "fetch_wellbore_count",
    description:
      "Query TRRC for the actual number of wells on a lease. Never trust a seller's description of well count — always verify independently. A 'single-well lease' claim must be confirmed here.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: {
          type: "string",
          description: "RRC lease number",
        },
        district: {
          type: "string",
          description: "TRRC district code",
        },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "fetch_operator_compliance",
    description:
      "Fetch violation history and inspection records for an operator from TRRC. If the result is empty, document that — do NOT assume clean compliance from an empty result.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_name: {
          type: "string",
          description: "Operator name as it appears in documents or TRRC",
        },
        operator_number: {
          type: "string",
          description: "TRRC operator number if known (e.g. '102004'). Preferred over name when available.",
        },
        county: {
          type: "string",
          description: "County name to narrow the search (optional)",
        },
      },
      required: [],
    },
  },
  {
    name: "fetch_p5_status",
    description:
      "Fetch the TRRC P-5 organizational record for an operator — includes bond status, active/inactive standing, and organizational history.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_number: {
          type: "string",
          description: "TRRC operator number (e.g. '102004')",
        },
        operator_name: {
          type: "string",
          description: "Operator name — used if operator number is not known",
        },
      },
      required: [],
    },
  },
  {
    name: "fetch_completions",
    description:
      "Fetch completion records (W-1 drilling permits, W-2 completion packets) for wells by API number. Returns formation name, total depth, completion type, and field information.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_numbers: {
          type: "array",
          items: { type: "string" },
          description: "List of TRRC-verified API numbers (only use APIs confirmed by verify_api)",
        },
      },
      required: ["api_numbers"],
    },
  },
  {
    name: "fetch_production_by_api",
    description:
      "Fetch production history for a specific well by API number. Use this when you have a TRRC-verified API but not a lease number, or to cross-check lease-level totals.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: {
          type: "string",
          description: "TRRC-verified API number",
        },
      },
      required: ["api_number"],
    },
  },
  {
    name: "search_operator_leases",
    description:
      "Search TRRC for all leases operated by a given operator in a county. Useful when you only have an operator name and county — returns lease numbers you can then query for production.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_name: {
          type: "string",
          description: "Operator name to search",
        },
        county: {
          type: "string",
          description: "Texas county name",
        },
      },
      required: ["operator_name", "county"],
    },
  },
  {
    name: "submit_report",
    description:
      "Submit your completed due diligence findings. Call this when you have finished your investigation and cross-checked all available data. The raw TRRC data you fetched will be assembled into the full report automatically.",
    input_schema: {
      type: "object" as const,
      properties: {
        recommendation: {
          type: "string",
          enum: ["pursue", "review", "pass"],
          description: "Investment recommendation based on verified findings",
        },
        recommendation_rationale: {
          type: "string",
          description: "One to two sentence rationale for the recommendation",
        },
        risk_score: {
          type: "number",
          description: "Overall risk score from 1 (very low) to 10 (very high)",
        },
        ic_memo_paragraphs: {
          type: "array",
          items: { type: "string" },
          description: "Investment Committee memo — 3 to 5 paragraphs covering asset description, production findings, compliance findings, economics, and recommendation",
        },
        seller_claim_crosschecks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string", description: "What the seller stated" },
              trrc_finding: { type: "string", description: "What TRRC actually shows" },
              verdict: {
                type: "string",
                enum: ["confirmed", "contradicted", "unverified", "misleading"],
              },
              severity: {
                type: "string",
                enum: ["critical", "warning", "info"],
              },
            },
            required: ["claim", "trrc_finding", "verdict", "severity"],
          },
          description: "Point-by-point cross-check of every seller claim against TRRC data",
        },
        top_risks: {
          type: "array",
          items: { type: "string" },
          description: "Top 3-5 investment risks identified from TRRC data and claim analysis",
        },
        value_drivers: {
          type: "array",
          items: { type: "string" },
          description: "Positive factors confirmed by TRRC data",
        },
        red_flags: {
          type: "array",
          items: { type: "string" },
          description: "Critical issues: fake API numbers, inflated production, hidden violations, missing data the seller should have provided",
        },
        data_gaps: {
          type: "array",
          items: { type: "string" },
          description: "Information that could not be verified and why",
        },
      },
      required: [
        "recommendation",
        "recommendation_rationale",
        "risk_score",
        "ic_memo_paragraphs",
        "seller_claim_crosschecks",
        "top_risks",
        "value_drivers",
      ],
    },
  },
];
