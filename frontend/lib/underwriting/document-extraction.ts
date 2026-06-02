/**
 * Underwriting — AI document extraction.
 *
 * Takes raw document texts (LOE statements, run tickets, workover reports,
 * equipment lists, purchaser statements, reserve reports, etc.) and extracts
 * every structured field needed for the DD report.
 *
 * One OpenAI call per document bundle (we concatenate up to ~8k tokens worth).
 * Returns null on failure — callers degrade gracefully to "Not provided."
 */

import OpenAI from "openai";
import type {
  DataSource,
  DataConfidence,
  LOEStatement,
  LOELineItem,
  WorkoverEvent,
  EquipmentItem,
  OwnershipRecord,
  InjectionWellRecord,
  DataPoint,
} from "./types";

// ─── Extraction output shape ──────────────────────────────────────────────────

export type DocumentExtractionResult = {
  // Subject fields
  operator_name: string | null;
  lease_name: string | null;
  county: string | null;
  state: string | null;
  api_numbers: string[];
  rrc_lease_numbers: string[];

  // Production (from run tickets / purchaser statements / production reports)
  production_months: {
    period: string;        // "YYYY-MM"
    oil_bbl: number | null;
    gas_mcf: number | null;
    water_bbl: number | null;
    oil_price_per_bbl: number | null;
    gross_revenue_usd: number | null;
    well_name?: string | null;
    source_detail: string;
  }[];

  // LOE statements
  loe_statements: {
    period: string;
    total_loe_usd: number | null;
    revenue_usd: number | null;
    net_income_usd: number | null;
    oil_price_per_bbl: number | null;
    gas_price_per_mcf: number | null;
    line_items: { category: string; amount_usd: number }[];
    source_detail: string;
    confidence: DataConfidence;
  }[];

  // Operating cost breakdown (aggregate if no monthly breakdown)
  electricity_cost_monthly: number | null;
  chemical_cost_monthly: number | null;
  labor_cost_monthly: number | null;
  disposal_cost_monthly: number | null;
  compression_cost_monthly: number | null;

  // Workover / maintenance
  workover_events: {
    date: string | null;
    well: string | null;
    type: string;
    cost_usd: number | null;
    result: string | null;
    source_detail: string;
  }[];

  // Equipment
  equipment_items: {
    type: string;
    quantity: number | null;
    condition: string | null;
    age_years: number | null;
    estimated_value_usd: number | null;
    notes: string | null;
    source_detail: string;
  }[];

  // Plugging
  inactive_well_mentions: {
    well_name: string | null;
    api: string | null;
    status: string;
    inactive_since: string | null;
    estimated_plug_cost: number | null;
  }[];

  // Bonding
  bond_amount_usd: number | null;
  bond_type: string | null;
  bond_number: string | null;
  bonding_company: string | null;

  // Compliance / violations mentioned in documents
  violation_mentions: {
    date: string | null;
    type: string;
    description: string;
    status: "open" | "closed" | "unknown";
    penalty_usd: number | null;
  }[];

  // Injection / SWD (from permit docs or operator summaries)
  injection_well_mentions: {
    api: string | null;
    well_name: string | null;
    well_type: string;
    injection_zone: string | null;
    depth_ft: number | null;
    permitted_max_volume_bwpd: number | null;
    permitted_max_pressure_psi: number | null;
    avg_daily_injection_bwpd: number | null;
    mit_status: string | null;
    last_mit_date: string | null;
  }[];

  // Ownership / interests
  ownership_records: {
    owner_name: string;
    interest_type: string;
    decimal_interest: number | null;
    nri_decimal: number | null;
    source_detail: string;
  }[];

  // Reserve report
  reserve_report_present: boolean;
  reserve_pv10: number | null;

  // Run tickets / purchaser statements detected
  run_tickets_present: boolean;
  purchaser_statements_present: boolean;

  // Water cut (from production summary docs)
  water_cut_pct: number | null;

  // Formation & completion data (from W-1/W-2, completion reports, well records)
  completion_data: {
    formation_name: string | null;
    total_depth_ft: number | null;
    completion_type: "vertical" | "horizontal" | "deviated" | null;
    completion_date: string | null;          // "YYYY-MM-DD" or "YYYY-MM" or "YYYY"
    artificial_lift_type: string | null;     // "Rod Pump" | "Gas Lift" | "ESP" | "Plunger" | "Flowing"
    producing_zone: string | null;
    injection_zone: string | null;
    perforations: {
      top_ft: number | null;
      bottom_ft: number | null;
      formation: string | null;
      status: string | null;
    }[];
    casing: {
      type: string;                          // "Surface" | "Intermediate" | "Production"
      size_inches: number | null;
      weight_lbs_ft: number | null;
      grade: string | null;
      depth_set_ft: number | null;
    }[];
    tubing: {
      size_inches: number | null;
      depth_ft: number | null;
      material: string | null;
    }[];
  } | null;

  // Operator notes / commentary extracted from documents
  operator_notes: string[];
};

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior petroleum engineer and mineral rights analyst with 25 years of experience in oil & gas due diligence. You are reading raw document text from an operator due diligence package.

Extract every structured field listed below. Be specific — pull exact dollar amounts, dates, API numbers, and volumes from the text. Do not fabricate values you cannot find. Return null for any field not present.

IMPORTANT RULES:
1. For LOE statements: extract EACH monthly period as a separate entry with ALL cost line items by category.
2. For production: extract each month separately. Include well-level data if available.
3. For API numbers: use 10-digit format (42-XXX-XXXXX). Include ALL you find.
4. For RRC lease numbers: format as "distCode:leaseNo" (e.g. "06:123456") if district is known.
5. For workover events: include every repair, recompletion, artificial lift change, stimulation, or intervention.
6. For equipment: be specific — "14 HP Rod Pump Unit on 2-3/8 tubing" not just "pump."
7. For ownership: extract decimals precisely (0.125000, not "1/8").
8. For plugging liability: flag ANY well described as inactive, shut-in, P&A candidate, or with a pending H-15.
9. For water cut: compute from oil_bbl and water_bbl if both present (water/(oil+water) × 100).
10. For completion data: extract from W-1, W-2, completion reports, or any well record showing formation, depth, perforations, casing, or tubing specs.
11. For operator notes: capture key qualitative statements operators made about production, workovers, equipment condition, or future plans.
12. Document types to look for: LOE Statement, Joint Interest Billing, Run Ticket, Division Order, Purchaser Statement, Workover AFE, Equipment List, Well Test, Completion Report, W-1, W-2, Reserve Summary, Compliance Notice, Bond Certificate, Injection Permit, MIT Test Report, H-15 Plugging Form, P&A Report, Well Log.

Return ONLY valid JSON with this exact structure (no markdown, no commentary):
{
  "operator_name": string | null,
  "lease_name": string | null,
  "county": string | null,
  "state": string | null,
  "api_numbers": string[],
  "rrc_lease_numbers": string[],
  "production_months": [{ "period": "YYYY-MM", "oil_bbl": number|null, "gas_mcf": number|null, "water_bbl": number|null, "oil_price_per_bbl": number|null, "gross_revenue_usd": number|null, "well_name": string|null, "source_detail": string }],
  "loe_statements": [{ "period": "YYYY-MM", "total_loe_usd": number|null, "revenue_usd": number|null, "net_income_usd": number|null, "oil_price_per_bbl": number|null, "gas_price_per_mcf": number|null, "line_items": [{"category": string, "amount_usd": number}], "source_detail": string, "confidence": "high"|"medium"|"low" }],
  "electricity_cost_monthly": number | null,
  "chemical_cost_monthly": number | null,
  "labor_cost_monthly": number | null,
  "disposal_cost_monthly": number | null,
  "compression_cost_monthly": number | null,
  "workover_events": [{ "date": string|null, "well": string|null, "type": string, "cost_usd": number|null, "result": string|null, "source_detail": string }],
  "equipment_items": [{ "type": string, "quantity": number|null, "condition": string|null, "age_years": number|null, "estimated_value_usd": number|null, "notes": string|null, "source_detail": string }],
  "inactive_well_mentions": [{ "well_name": string|null, "api": string|null, "status": string, "inactive_since": string|null, "estimated_plug_cost": number|null }],
  "bond_amount_usd": number | null,
  "bond_type": string | null,
  "bond_number": string | null,
  "bonding_company": string | null,
  "violation_mentions": [{ "date": string|null, "type": string, "description": string, "status": "open"|"closed"|"unknown", "penalty_usd": number|null }],
  "injection_well_mentions": [{ "api": string|null, "well_name": string|null, "well_type": string, "injection_zone": string|null, "depth_ft": number|null, "permitted_max_volume_bwpd": number|null, "permitted_max_pressure_psi": number|null, "avg_daily_injection_bwpd": number|null, "mit_status": string|null, "last_mit_date": string|null }],
  "ownership_records": [{ "owner_name": string, "interest_type": string, "decimal_interest": number|null, "nri_decimal": number|null, "source_detail": string }],
  "reserve_report_present": boolean,
  "reserve_pv10": number | null,
  "run_tickets_present": boolean,
  "purchaser_statements_present": boolean,
  "water_cut_pct": number | null,
  "completion_data": {
    "formation_name": string|null,
    "total_depth_ft": number|null,
    "completion_type": "vertical"|"horizontal"|"deviated"|null,
    "completion_date": string|null,
    "artificial_lift_type": string|null,
    "producing_zone": string|null,
    "injection_zone": string|null,
    "perforations": [{"top_ft": number|null, "bottom_ft": number|null, "formation": string|null, "status": string|null}],
    "casing": [{"type": string, "size_inches": number|null, "weight_lbs_ft": number|null, "grade": string|null, "depth_set_ft": number|null}],
    "tubing": [{"size_inches": number|null, "depth_ft": number|null, "material": string|null}]
  } | null,
  "operator_notes": string[]
}`;

// ─── Main extraction function ─────────────────────────────────────────────────

const MAX_CHARS_PER_DOC = 24_000;
const MAX_TOTAL_CHARS   = 96_000;

export async function extractUnderwritingDataFromDocuments(
  documents: { filename: string; text: string; doc_type?: string }[],
): Promise<DocumentExtractionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || documents.length === 0) return null;

  // Build the user message — concatenate docs up to token budget
  const parts: string[] = [];
  let totalChars = 0;
  for (const doc of documents) {
    if (totalChars >= MAX_TOTAL_CHARS) break;
    const trimmed = doc.text.slice(0, MAX_CHARS_PER_DOC);
    parts.push(`=== DOCUMENT: ${doc.filename}${doc.doc_type ? ` [${doc.doc_type}]` : ""} ===\n${trimmed}`);
    totalChars += trimmed.length;
  }
  const userMessage = parts.join("\n\n");

  try {
    const client = new OpenAI({ apiKey, timeout: 45_000 });
    const model = process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini";

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 8000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!raw) return null;

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned) as DocumentExtractionResult;

    // Normalize / sanitize
    return {
      operator_name: parsed.operator_name ?? null,
      lease_name: parsed.lease_name ?? null,
      county: parsed.county ?? null,
      state: parsed.state ?? null,
      api_numbers: Array.isArray(parsed.api_numbers) ? parsed.api_numbers : [],
      rrc_lease_numbers: Array.isArray(parsed.rrc_lease_numbers) ? parsed.rrc_lease_numbers : [],
      production_months: Array.isArray(parsed.production_months) ? parsed.production_months : [],
      loe_statements: Array.isArray(parsed.loe_statements) ? parsed.loe_statements : [],
      electricity_cost_monthly: parsed.electricity_cost_monthly ?? null,
      chemical_cost_monthly: parsed.chemical_cost_monthly ?? null,
      labor_cost_monthly: parsed.labor_cost_monthly ?? null,
      disposal_cost_monthly: parsed.disposal_cost_monthly ?? null,
      compression_cost_monthly: parsed.compression_cost_monthly ?? null,
      workover_events: Array.isArray(parsed.workover_events) ? parsed.workover_events : [],
      equipment_items: Array.isArray(parsed.equipment_items) ? parsed.equipment_items : [],
      inactive_well_mentions: Array.isArray(parsed.inactive_well_mentions) ? parsed.inactive_well_mentions : [],
      bond_amount_usd: parsed.bond_amount_usd ?? null,
      bond_type: parsed.bond_type ?? null,
      bond_number: parsed.bond_number ?? null,
      bonding_company: parsed.bonding_company ?? null,
      violation_mentions: Array.isArray(parsed.violation_mentions) ? parsed.violation_mentions : [],
      injection_well_mentions: Array.isArray(parsed.injection_well_mentions) ? parsed.injection_well_mentions : [],
      ownership_records: Array.isArray(parsed.ownership_records) ? parsed.ownership_records : [],
      reserve_report_present: !!parsed.reserve_report_present,
      reserve_pv10: parsed.reserve_pv10 ?? null,
      run_tickets_present: !!parsed.run_tickets_present,
      purchaser_statements_present: !!parsed.purchaser_statements_present,
      water_cut_pct: parsed.water_cut_pct ?? null,
      completion_data: parsed.completion_data ?? null,
      operator_notes: Array.isArray(parsed.operator_notes) ? parsed.operator_notes : [],
    };
  } catch (err) {
    console.warn("[underwriting-extraction] failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
