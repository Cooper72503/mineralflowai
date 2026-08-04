/**
 * Claude tool definitions for the TRRC landman agent.
 * Each tool maps to a TRRC data source.
 */

import Anthropic from "@anthropic-ai/sdk";

export const TRRC_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_wellbore",
    description: "Search TRRC wellbore PDQ by API number. Returns lease number, district, operator, county. Always try this first when you have an API number. If it returns not found, don't give up — try get_well_status which uses a different database.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number — 10 or 11 digits, with or without dashes. e.g. 42-165-50208 or 4216550208" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "search_lease_wells",
    description: "Get all wells on a lease from TRRC lease inventory. Use this once you have a lease number and district. Returns every API on the lease.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "TRRC oil/gas lease number" },
        district:     { type: "string", description: "TRRC district code e.g. 01, 04, 7B" },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "search_operator",
    description: "Look up operator P-5 registration from TRRC. Returns bond amount, P-5 status, registered agent. Use operator number if you have it — more reliable than name.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_name:   { type: "string", description: "Operator company name" },
        operator_number: { type: "string", description: "5-digit TRRC operator number (more reliable)" },
      },
    },
  },
  {
    name: "get_well_status",
    description: "Get official well status (Active, Inactive, Shut-In, Plugged) from TRRC. Also returns lease number and district — use this to backfill context when search_wellbore fails. Try by API first, then by lease+district.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number:   { type: "string", description: "API number" },
        lease_number: { type: "string", description: "Lease number — used as fallback if API not found" },
        district:     { type: "string", description: "District code — required with lease_number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_production",
    description: "Get monthly production history (oil BBL, gas MCF, water BBL) from TRRC. REQUIRES lease_number AND district — you must have these from a prior tool call before this will work. Returns up to 10 years of monthly data.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "TRRC oil/gas lease number — REQUIRED" },
        district:     { type: "string", description: "TRRC district code — REQUIRED" },
        lease_type:   { type: "string", enum: ["O", "G", "C"], description: "O=oil, G=gas, C=condensate. Leave blank to try all." },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "get_p4_gatherer_purchaser",
    description: "Get the P-4 (Certificate of Compliance and Transportation Authority) gatherer/purchaser designation for a lease — the company authorized to take production from this lease. REQUIRES lease_number AND district. A lease with no gatherer/purchaser on file cannot legally sell or transport its production, which is a material finding.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "TRRC oil/gas lease number — REQUIRED" },
        district:     { type: "string", description: "TRRC district code — REQUIRED" },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "get_completion_records",
    description: "Get W-2 completion records — formation, perforation intervals, stimulation method, casing program. Essential for understanding what zone the well is producing from.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_plugging_records",
    description: "Check if well has been plugged (W-3C certificate). If well shows plugged status but no W-3C exists, that is a critical finding — possible abandonment without proper documentation.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_inactive_well_status",
    description: "Check TRRC inactive well aging report (IWAR). Returns plugging deadline date if well is on the inactive list. A deadline within 12 months is a material liability.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number:      { type: "string", description: "API number" },
        operator_number: { type: "string", description: "Operator number (used as fallback)" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_orphan_well",
    description: "Check if well is in TRRC orphan well program — means operator forfeited bond and there is no responsible party. This is a deal-killer. Do not proceed without legal counsel.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_compliance_violations",
    description: "Get compliance violation history from TRRC ICE portal. Returns all violations, open/closed status, penalty amounts. Open violations transfer with the asset — material liability.",
    input_schema: {
      type: "object" as const,
      properties: {
        operator_number: { type: "string", description: "TRRC operator number — preferred, covers all wells for the operator" },
        api_number:      { type: "string", description: "API number — use if no operator number" },
      },
    },
  },
  {
    name: "get_severance_records",
    description: "Get severance tax exemption records. Some wells have EOR, high-cost, or other exemptions that affect economics.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "Lease number" },
        district:     { type: "string", description: "District code" },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "get_injection_records",
    description: "Get UIC/injection well records. Important if well is an injector or has associated SWD wells.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number:      { type: "string", description: "API number" },
        operator_number: { type: "string", description: "Operator number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_drilling_permits",
    description: "Get W-1 drilling permit records from TRRC — permit approval/submission dates, filing purpose (New Drill, Recompletion, etc.), wellbore profile, amendments, and permit status. Useful for confirming a well was permitted before drilling and understanding its development timeline.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_oil_proration",
    description: "Get TRRC's Oil Proration Query records for a lease — per-well status (PRODUCING/SHUT IN), tested potential (BBL), gas/oil ratio, acreage, and daily allowable. The daily_allowable field reads 'FORMS LACKING' instead of a number when the operator has NOT filed the required potential/allowable test paperwork for that wellbore — a real regulatory-compliance gap worth flagging, distinct from a normal shut-in well. Do not compare the allowable value itself against actual production as a compliance check — Texas has not enforced binding market-demand allowables since the 1970s, so for a normally producing well this figure is set non-restrictively and would not indicate anything meaningful.",
    input_schema: {
      type: "object" as const,
      properties: {
        lease_number: { type: "string", description: "Lease number" },
        district:     { type: "string", description: "District code" },
      },
      required: ["lease_number", "district"],
    },
  },
  {
    name: "get_county_records",
    description: "Search county clerk real property records (deeds, mineral deeds, leases, assignments, releases, liens) by grantor/grantee name — typically the operator name or a mineral owner name. This is COUNTY data, not TRRC data, and is only automated for a small set of counties so far (Midland, Reeves, Reagan, Live Oak) — for any other county this returns a manual-search link instead of records, which is expected and should be reported as such, not treated as a failure. Use the well's resolved county and the operator name as the search value.",
    input_schema: {
      type: "object" as const,
      properties: {
        county: { type: "string", description: "Texas county name, e.g. 'Midland' (no need to include the word 'County')" },
        search_value: { type: "string", description: "Grantor or grantee name to search for — typically the operator name" },
      },
      required: ["county", "search_value"],
    },
  },
  {
    name: "get_coda_documents",
    description: "Get list of imaged documents available in TRRC CODA system — W-2 originals, sundry notices, G-1, H-15, W-3C. Returns document list with direct download URLs where available.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "get_gis_location",
    description: "Get well surface location coordinates, abstract/survey/block/section, and alert areas from RRC GIS database.",
    input_schema: {
      type: "object" as const,
      properties: {
        api_number: { type: "string", description: "API number" },
      },
      required: ["api_number"],
    },
  },
  {
    name: "submit_report",
    description: "Submit your final structured findings. Call this when you have completed your research — you have checked all applicable sources, noted what was found and not found, and identified material flags. Do not call this until you have attempted production history.",
    input_schema: {
      type: "object" as const,
      properties: {
        well_identity: {
          type: "object",
          description: "Well identification data",
          properties: {
            well_name:       { type: "string" },
            api_number:      { type: "string" },
            lease_number:    { type: "string" },
            district:        { type: "string" },
            operator:        { type: "string" },
            operator_number: { type: "string" },
            county:          { type: "string" },
            field:           { type: "string" },
            formation:       { type: "string" },
            well_type:       { type: "string" },
          },
        },
        production_summary: {
          type: "object",
          description: "Production analytics",
          properties: {
            months_of_history:    { type: "number" },
            recent_12mo_avg_oil:  { type: "number" },
            prior_12mo_avg_oil:   { type: "number" },
            yoy_decline_pct:      { type: "number" },
            recent_12mo_avg_gas:  { type: "number" },
            cumulative_oil_bbl:   { type: "number" },
            cumulative_gas_mcf:   { type: "number" },
            current_wor:          { type: "number" },
            wor_trend:            { type: "string", enum: ["Stable", "Rising", "Declining", "N/A"] },
            zero_production_months: { type: "number" },
          },
        },
        critical_flags:  { type: "array", items: { type: "string" }, description: "Deal-breakers — orphan well, revoked P-5, >30% YoY decline, open violations, etc." },
        important_flags: { type: "array", items: { type: "string" }, description: "Material issues that need follow-up but are not deal-killers" },
        sources_checked: { type: "array", items: { type: "string" }, description: "List of every TRRC source checked" },
        sources_with_data: { type: "array", items: { type: "string" }, description: "Sources that returned substantive data" },
        sources_not_found: { type: "array", items: { type: "string" }, description: "Sources checked but no records found (legitimate absence)" },
        sources_failed:  { type: "array", items: { type: "string" }, description: "Sources that returned errors" },
        narrative:       { type: "string", description: "2-3 paragraph professional summary a mineral buyer would read. Cover production trend, compliance standing, and your overall assessment." },
      },
      required: ["critical_flags", "important_flags", "sources_checked", "narrative"],
    },
  },
];
