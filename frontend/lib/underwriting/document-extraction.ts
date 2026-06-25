/**
 * Underwriting — AI document extraction.
 *
 * Takes raw document texts (LOE statements, run tickets, workover reports,
 * equipment lists, purchaser statements, reserve reports, etc.) and extracts
 * every structured field needed for the DD report.
 *
 * Pass 1 — Extraction: claude-sonnet-4-6 with 180k-char context window
 *   (Claude's 200k-token context eliminates chunking for virtually all O&G packages)
 * Pass 2 — Verification: targeted re-read of raw text to confirm financial
 *   figures (net_revenue_usd, gross_revenue_usd, severance_tax_usd) before
 *   they flow into economics. Catches hallucination and magnitude errors.
 *
 * Returns null on failure — callers degrade gracefully to "Not provided."
 */

import Anthropic from "@anthropic-ai/sdk";
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
    period: string;               // "YYYY-MM" — use SALES DATE / billing period, not ticket date
    oil_bbl: number | null;
    gas_mcf: number | null;
    water_bbl: number | null;
    oil_price_per_bbl: number | null;
    gross_revenue_usd: number | null;
    net_revenue_usd: number | null;   // after severance/production taxes
    severance_tax_usd: number | null; // state taxes withheld
    api_gravity: number | null;       // corrected API gravity (CORR GRAV column)
    rrc_lease_number: string | null;  // STATE LEASE number from document header (e.g. "001973")
    well_name?: string | null;        // PROPERTY NAME from document header
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
2. For production (run statements / purchaser statements): create ONE entry PER PROPERTY PER SALES PERIOD. Use the SALES DATE (billing period) as the period field, not the individual ticket dates. If multiple run tickets exist for the same property and sales period, SUM their NET BARRELS into a single entry. Each property in the document has its own header showing PROPERTY NAME and STATE LEASE number — keep them separate; never merge production across different properties.
3. For run statement fields: capture rrc_lease_number from the "STATE LEASE" field in the property header, well_name from "PROPERTY NAME", api_gravity from the "CORR GRAV" column (weighted average if multiple tickets), net_revenue_usd from "NET VALUE" total, severance_tax_usd from "STATE TAXES" total, gross_revenue_usd from "GROSS VALUE" total, oil_price_per_bbl from "AVG PRICE".
4. For API numbers: use 10-digit format (42-XXX-XXXXX). Include ALL you find.
5. For RRC lease numbers (top-level array): include ALL STATE LEASE numbers found in the document. Format as "distCode:leaseNo" if district is known, otherwise just the lease number.
6. For workover events: include every repair, recompletion, artificial lift change, stimulation, or intervention.
7. For equipment: be specific — "14 HP Rod Pump Unit on 2-3/8 tubing" not just "pump."
8. For ownership: extract decimals precisely (0.125000, not "1/8").
9. For plugging liability: flag ANY well described as inactive, shut-in, P&A candidate, or with a pending H-15.
10. For water cut: compute from oil_bbl and water_bbl if both present (water/(oil+water) × 100).
11. For completion data: extract from W-1, W-2, completion reports, or any well record showing formation, depth, perforations, casing, or tubing specs.
12. For operator notes: capture key qualitative statements operators made about production, workovers, equipment condition, or future plans.
13. Document types to look for: LOE Statement, Joint Interest Billing, Run Ticket, Division Order, Purchaser Statement, Workover AFE, Equipment List, Well Test, Completion Report, W-1, W-2, Reserve Summary, Compliance Notice, Bond Certificate, Injection Permit, MIT Test Report, H-15 Plugging Form, P&A Report, Well Log.

Return ONLY valid JSON with this exact structure (no markdown, no commentary):
{
  "operator_name": string | null,
  "lease_name": string | null,
  "county": string | null,
  "state": string | null,
  "api_numbers": string[],
  "rrc_lease_numbers": string[],
  "production_months": [{ "period": "YYYY-MM", "oil_bbl": number|null, "gas_mcf": number|null, "water_bbl": number|null, "oil_price_per_bbl": number|null, "gross_revenue_usd": number|null, "net_revenue_usd": number|null, "severance_tax_usd": number|null, "api_gravity": number|null, "rrc_lease_number": string|null, "well_name": string|null, "source_detail": string }],
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

// Claude Sonnet 4.6 has a 200k-token context window (~800k chars).
// We use 180k chars per chunk to leave headroom for the system prompt + output.
// For typical O&G document packages this means a single call — no chunking.
const CHUNK_SIZE    = 180_000;
const CHUNK_OVERLAP = 2_000;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

function normalizeExtraction(parsed: DocumentExtractionResult): DocumentExtractionResult {
  return {
    operator_name: parsed.operator_name ?? null,
    lease_name: parsed.lease_name ?? null,
    county: parsed.county ?? null,
    state: parsed.state ?? null,
    api_numbers: Array.isArray(parsed.api_numbers) ? parsed.api_numbers : [],
    rrc_lease_numbers: Array.isArray(parsed.rrc_lease_numbers) ? parsed.rrc_lease_numbers : [],
    production_months: Array.isArray(parsed.production_months)
      ? parsed.production_months.map(pm => ({
          ...pm,
          net_revenue_usd:   pm.net_revenue_usd   ?? null,
          severance_tax_usd: pm.severance_tax_usd ?? null,
          api_gravity:       pm.api_gravity       ?? null,
          rrc_lease_number:  pm.rrc_lease_number  ?? null,
        }))
      : [],
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
}

// Merge multiple extraction results (from chunks of the same doc, or across docs).
// Strategy: deduplicate arrays by key, OR booleans, first-non-null for scalars.
function mergeExtractionResults(results: DocumentExtractionResult[]): DocumentExtractionResult | null {
  const valid = results.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  function firstNonNull<T>(...vals: (T | null | undefined)[]): T | null {
    for (const v of vals) if (v != null) return v;
    return null;
  }

  // Merge production_months — deduplicate by period, prefer entry with more non-null fields
  const prodMap = new Map<string, DocumentExtractionResult["production_months"][0]>();
  for (const r of valid) {
    for (const pm of r.production_months) {
      const key = `${pm.period}|${pm.rrc_lease_number ?? pm.well_name ?? ""}`;
      const existing = prodMap.get(key);
      if (!existing) { prodMap.set(key, pm); continue; }
      const score = (p: typeof pm) => [p.oil_bbl, p.gas_mcf, p.water_bbl, p.gross_revenue_usd].filter(v => v != null).length;
      if (score(pm) > score(existing)) prodMap.set(key, pm);
    }
  }

  // Merge loe_statements — deduplicate by period
  const loeMap = new Map<string, DocumentExtractionResult["loe_statements"][0]>();
  for (const r of valid) {
    for (const stmt of r.loe_statements) {
      if (!loeMap.has(stmt.period)) loeMap.set(stmt.period, stmt);
    }
  }

  // Deduplicate simple string arrays
  const mergeStrArr = (...arrs: string[][]): string[] => Array.from(new Set(arrs.flat()));

  // Merge other arrays (concat, no deduplication — duplicates handled downstream)
  const concat = <T>(key: keyof DocumentExtractionResult): T[] =>
    valid.flatMap(r => (r[key] as T[]) ?? []);

  const merged: DocumentExtractionResult = {
    operator_name:              firstNonNull(...valid.map(r => r.operator_name)),
    lease_name:                 firstNonNull(...valid.map(r => r.lease_name)),
    county:                     firstNonNull(...valid.map(r => r.county)),
    state:                      firstNonNull(...valid.map(r => r.state)),
    api_numbers:                mergeStrArr(...valid.map(r => r.api_numbers)),
    rrc_lease_numbers:          mergeStrArr(...valid.map(r => r.rrc_lease_numbers)),
    production_months:          Array.from(prodMap.values()),
    loe_statements:             Array.from(loeMap.values()),
    electricity_cost_monthly:   firstNonNull(...valid.map(r => r.electricity_cost_monthly)),
    chemical_cost_monthly:      firstNonNull(...valid.map(r => r.chemical_cost_monthly)),
    labor_cost_monthly:         firstNonNull(...valid.map(r => r.labor_cost_monthly)),
    disposal_cost_monthly:      firstNonNull(...valid.map(r => r.disposal_cost_monthly)),
    compression_cost_monthly:   firstNonNull(...valid.map(r => r.compression_cost_monthly)),
    workover_events:            concat("workover_events"),
    equipment_items:            concat("equipment_items"),
    inactive_well_mentions:     concat("inactive_well_mentions"),
    bond_amount_usd:            firstNonNull(...valid.map(r => r.bond_amount_usd)),
    bond_type:                  firstNonNull(...valid.map(r => r.bond_type)),
    bond_number:                firstNonNull(...valid.map(r => r.bond_number)),
    bonding_company:            firstNonNull(...valid.map(r => r.bonding_company)),
    violation_mentions:         concat("violation_mentions"),
    injection_well_mentions:    concat("injection_well_mentions"),
    ownership_records:          concat("ownership_records"),
    reserve_report_present:     valid.some(r => r.reserve_report_present),
    reserve_pv10:               firstNonNull(...valid.map(r => r.reserve_pv10)),
    run_tickets_present:        valid.some(r => r.run_tickets_present),
    purchaser_statements_present: valid.some(r => r.purchaser_statements_present),
    water_cut_pct:              firstNonNull(...valid.map(r => r.water_cut_pct)),
    completion_data:            firstNonNull(...valid.map(r => r.completion_data)),
    operator_notes:             Array.from(new Set(valid.flatMap(r => r.operator_notes))),
  };
  return merged;
}

async function extractOneChunk(
  client: Anthropic,
  model: string,
  label: string,
  text: string,
): Promise<DocumentExtractionResult | null> {
  try {
    const message = await client.messages.create({
      model,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `=== DOCUMENT: ${label} ===\n${text}` },
      ],
    });

    const raw = message.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("")
      .trim();

    if (!raw) {
      console.error(`[underwriting-extraction] empty response for "${label}"`);
      return null;
    }

    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as DocumentExtractionResult;
    return validateAndSanitizeExtraction(normalizeExtraction(parsed));
  } catch (err) {
    console.error(`[underwriting-extraction] chunk "${label}" failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Pass 2: Financial field verification ─────────────────────────────────────
//
// For each production_month that has financial figures, ask Claude to locate
// those exact numbers in the raw source text and confirm or correct them.
// This catches hallucination (model invents a number not in the document) and
// magnitude errors (off by 10×, decimal shift, etc.).
//
// Returns the extraction with any corrected values applied.

const VERIFY_SYSTEM = `You are verifying financial figures extracted from an oil & gas run statement or purchaser statement. You will be given the raw document text and a list of extracted entries. For each entry, locate the EXACT numbers in the source text. Return ONLY valid JSON — no commentary, no markdown.`;

type VerifyEntry = {
  period: string;
  rrc_lease_number: string | null;
  well_name: string | null;
  extracted_gross: number | null;
  extracted_net: number | null;
  extracted_sev_tax: number | null;
};

type VerifyResult = {
  period: string;
  rrc_lease_number: string | null;
  gross_revenue_usd: number | null;       // confirmed or corrected value; null if not found in text
  net_revenue_usd: number | null;
  severance_tax_usd: number | null;
  status: "confirmed" | "corrected" | "not_found";
  note?: string;
};

async function verifyFinancialFields(
  client: Anthropic,
  model: string,
  documents: { filename: string; text: string; doc_type?: string }[],
  extracted: DocumentExtractionResult,
): Promise<DocumentExtractionResult> {
  const toVerify: VerifyEntry[] = extracted.production_months
    .filter(pm => pm.gross_revenue_usd != null || pm.net_revenue_usd != null || pm.severance_tax_usd != null)
    .map(pm => ({
      period:             pm.period,
      rrc_lease_number:   pm.rrc_lease_number ?? null,
      well_name:          pm.well_name ?? null,
      extracted_gross:    pm.gross_revenue_usd,
      extracted_net:      pm.net_revenue_usd,
      extracted_sev_tax:  pm.severance_tax_usd,
    }));

  if (toVerify.length === 0) return extracted;

  // Verify each document independently — eliminates the 60k combined-text cap.
  // Run statement / purchaser statement docs are typically 10–80k chars each; we
  // allow 150k per document so even large multi-month statements are fully covered.
  // Prefer docs typed as financial; fall back to all docs if none are typed that way.
  const financialDocs = documents.filter(d =>
    /run.?ticket|run.?statement|purchaser.?statement/i.test(`${d.filename} ${d.doc_type ?? ""}`)
  );
  const docsToSearch = financialDocs.length > 0 ? financialDocs : documents;
  const MAX_DOC_CHARS = 150_000;

  const entriesJson = JSON.stringify(toVerify, null, 2);
  const verifyBase =
    `For each entry, find the property section in the raw text identified by rrc_lease_number (STATE LEASE field) ` +
    `and the matching billing period. Locate GROSS VALUE, NET VALUE, and STATE TAXES for that period. ` +
    `If the extracted value matches the document exactly, set status="confirmed". ` +
    `If you find a different value in the text, set status="corrected" and return the correct value. ` +
    `If you cannot locate the entry in this document, set status="not_found" and return null for that field. ` +
    `Return a JSON array matching this type exactly:\n` +
    `[{ "period": string, "rrc_lease_number": string|null, "gross_revenue_usd": number|null, ` +
    `"net_revenue_usd": number|null, "severance_tax_usd": number|null, ` +
    `"status": "confirmed"|"corrected"|"not_found", "note": string|undefined }]`;

  // Run one verification call per document in parallel
  const docResults = await Promise.allSettled(
    docsToSearch.map(async (doc) => {
      const verifyPrompt =
        `Raw document text:\n${doc.text.slice(0, MAX_DOC_CHARS)}\n\n` +
        `Extracted financial entries to verify:\n${entriesJson}\n\n${verifyBase}`;
      const message = await client.messages.create({
        model,
        max_tokens: 4_000,
        system: VERIFY_SYSTEM,
        messages: [{ role: "user", content: verifyPrompt }],
      });
      const raw = message.content
        .filter(b => b.type === "text")
        .map(b => (b as { type: "text"; text: string }).text)
        .join("")
        .trim();
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      return JSON.parse(cleaned) as VerifyResult[];
    })
  );

  // Merge across documents: "confirmed"/"corrected" from any doc wins over "not_found".
  // A period is only nulled if every document says "not_found".
  const verifyMap = new Map<string, VerifyResult>();
  for (const settled of docResults) {
    if (settled.status !== "fulfilled") continue;
    for (const vr of settled.value) {
      const key = `${vr.period}|${vr.rrc_lease_number ?? ""}`;
      const existing = verifyMap.get(key);
      if (!existing || (existing.status === "not_found" && vr.status !== "not_found")) {
        verifyMap.set(key, vr);
      }
    }
  }

  if (verifyMap.size === 0) {
    console.error("[underwriting-verification] all per-document calls failed — using unverified extraction");
    return extracted;
  }

  // Apply corrections to production_months
  const correctedMonths = extracted.production_months.map(pm => {
    const key = `${pm.period}|${pm.rrc_lease_number ?? ""}`;
    const vr = verifyMap.get(key);
    if (!vr) return pm;

    if (vr.status === "corrected") {
      console.warn(
        `[underwriting-verification] corrected ${pm.period} lease=${pm.rrc_lease_number ?? "?"}: ` +
        `gross ${pm.gross_revenue_usd}→${vr.gross_revenue_usd}, ` +
        `net ${pm.net_revenue_usd}→${vr.net_revenue_usd}, ` +
        `sev_tax ${pm.severance_tax_usd}→${vr.severance_tax_usd}` +
        (vr.note ? ` (${vr.note})` : ""),
      );
      return {
        ...pm,
        gross_revenue_usd:  vr.gross_revenue_usd,
        net_revenue_usd:    vr.net_revenue_usd,
        severance_tax_usd:  vr.severance_tax_usd,
      };
    }

    if (vr.status === "not_found") {
      console.warn(
        `[underwriting-verification] ${pm.period} lease=${pm.rrc_lease_number ?? "?"} ` +
        `NOT FOUND in any source document — nulling financial fields to prevent hallucination`,
      );
      return { ...pm, gross_revenue_usd: null, net_revenue_usd: null, severance_tax_usd: null };
    }

    return pm; // "confirmed" — no change needed
  });

  return { ...extracted, production_months: correctedMonths };
}

export async function extractUnderwritingDataFromDocuments(
  documents: { filename: string; text: string; doc_type?: string }[],
): Promise<DocumentExtractionResult | null> {
  if (documents.length === 0) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Throw so the calling pipeline step surfaces this as a visible failure
    // rather than silently returning null and hiding the config gap.
    throw new Error(
      "ANTHROPIC_API_KEY is not configured — AI document extraction is disabled. " +
      "Add the key to .env.local to enable run statement and LOE extraction."
    );
  }

  const client = new Anthropic({ apiKey, timeout: 120_000 });
  const model  = process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6";

  // Pass 1 — Extract each document independently, chunking only if > 180k chars.
  // With Claude's 200k-token context, virtually all O&G packages fit in one call.
  const chunkPromises: Promise<DocumentExtractionResult | null>[] = [];

  for (const doc of documents) {
    const chunks = chunkText(doc.text);
    const baseLabel = `${doc.filename}${doc.doc_type ? ` [${doc.doc_type}]` : ""}`;
    chunks.forEach((chunk, i) => {
      const label = chunks.length > 1 ? `${baseLabel} — Part ${i + 1}/${chunks.length}` : baseLabel;
      chunkPromises.push(extractOneChunk(client, model, label, chunk));
    });
  }

  console.log(`[underwriting-extraction] pass 1: ${chunkPromises.length} call(s) across ${documents.length} document(s) (model: ${model})`);

  const settled = await Promise.allSettled(chunkPromises);
  const results: DocumentExtractionResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value != null) results.push(r.value);
  }

  if (results.length === 0) {
    console.error("[underwriting-extraction] all extraction calls failed — returning null");
    return null;
  }

  const merged = mergeExtractionResults(results);
  if (!merged) return null;

  // Pass 2 — Verify financial fields against raw text.
  // Use the combined raw text of all documents (first 60k chars used inside the verifier).
  const hasFinancialData = merged.production_months.some(
    pm => pm.gross_revenue_usd != null || pm.net_revenue_usd != null || pm.severance_tax_usd != null,
  );

  if (hasFinancialData) {
    const periodCount = merged.production_months.filter(pm => pm.net_revenue_usd != null || pm.gross_revenue_usd != null).length;
    console.log(`[underwriting-extraction] pass 2: verifying financial fields for ${periodCount} period(s) across ${documents.length} document(s)`);
    return verifyFinancialFields(client, model, documents, merged);
  }

  return merged;
}

// ─── Post-extraction sanitisation ────────────────────────────────────────────
//
// AI models occasionally hallucinate numeric values or misplace decimal points.
// This function applies hard physical bounds and business-rule checks AFTER the
// AI parse, before the result is consumed by the underwriting engine.
//
// Policy:
//  • Clamp NRI / WI to (0, 1] — decimals outside this range are parse errors
//  • Reject negative production volumes — physically impossible
//  • Flag per-month production > 50 000 BBL for conventional wells (warn only)
//  • Reject LOE of $0 for a month with production (likely a parse miss)
//  • Reject LOE > $500 000/month for a conventional lease (physically implausible)
//  • Sanitize oil prices outside [$10, $250]/BBL — replace with null
//
// The function is a pure transform — it NEVER sets values to fabricated numbers.
// Out-of-range values are either clamped (interests) or nulled (prices, volumes).

const MAX_CONVENTIONAL_OIL_BBL_PER_MONTH = 50_000;
const MAX_CONVENTIONAL_LOE_PER_MONTH     = 500_000;
const MIN_OIL_PRICE_PER_BBL              = 10;
const MAX_OIL_PRICE_PER_BBL              = 250;

export function validateAndSanitizeExtraction(
  raw: DocumentExtractionResult,
): DocumentExtractionResult {
  // ── Ownership interests ───────────────────────────────────────────────────
  const ownership_records = raw.ownership_records.map(r => {
    let nri_decimal = r.nri_decimal;
    let decimal_interest = r.decimal_interest;

    if (nri_decimal != null) {
      if (nri_decimal <= 0 || nri_decimal > 1) {
        console.warn(`[extraction-sanitize] NRI out of range (${nri_decimal}) for "${r.owner_name}" — clamped`);
        nri_decimal = Math.min(Math.max(nri_decimal, 0.001), 1.0);
      }
    }
    if (decimal_interest != null) {
      if (decimal_interest <= 0 || decimal_interest > 1) {
        console.warn(`[extraction-sanitize] decimal_interest out of range (${decimal_interest}) for "${r.owner_name}" — clamped`);
        decimal_interest = Math.min(Math.max(decimal_interest, 0.001), 1.0);
      }
    }
    return { ...r, nri_decimal, decimal_interest };
  });

  // ── Production months ─────────────────────────────────────────────────────
  const production_months = raw.production_months.map(pm => {
    let oil_bbl  = pm.oil_bbl;
    let gas_mcf  = pm.gas_mcf;
    let water_bbl = pm.water_bbl;
    let oil_price_per_bbl = pm.oil_price_per_bbl;

    if (oil_bbl != null && oil_bbl < 0) {
      console.warn(`[extraction-sanitize] Negative oil_bbl (${oil_bbl}) in period ${pm.period} — rejected`);
      oil_bbl = null;
    }
    if (gas_mcf != null && gas_mcf < 0) {
      console.warn(`[extraction-sanitize] Negative gas_mcf (${gas_mcf}) in period ${pm.period} — rejected`);
      gas_mcf = null;
    }
    if (water_bbl != null && water_bbl < 0) {
      console.warn(`[extraction-sanitize] Negative water_bbl (${water_bbl}) in period ${pm.period} — rejected`);
      water_bbl = null;
    }
    if (oil_bbl != null && oil_bbl > MAX_CONVENTIONAL_OIL_BBL_PER_MONTH) {
      console.warn(`[extraction-sanitize] Implausibly high oil_bbl (${oil_bbl}) in period ${pm.period} — flagged (not removed)`);
      // We warn but do NOT null-out — a high-volume multi-well lease package is possible.
      // The production engine applies its own plausibility check.
    }
    if (oil_price_per_bbl != null &&
        (oil_price_per_bbl < MIN_OIL_PRICE_PER_BBL || oil_price_per_bbl > MAX_OIL_PRICE_PER_BBL)) {
      console.warn(`[extraction-sanitize] Oil price out of range ($${oil_price_per_bbl}/BBL) in period ${pm.period} — nulled`);
      oil_price_per_bbl = null;
    }
    return { ...pm, oil_bbl, gas_mcf, water_bbl, oil_price_per_bbl };
  });

  // ── LOE statements ────────────────────────────────────────────────────────
  const loe_statements = raw.loe_statements.map(stmt => {
    let total_loe_usd = stmt.total_loe_usd;

    if (total_loe_usd != null && total_loe_usd < 0) {
      console.warn(`[extraction-sanitize] Negative total_loe_usd (${total_loe_usd}) in period ${stmt.period} — rejected`);
      total_loe_usd = null;
    }
    if (total_loe_usd === 0) {
      // $0 LOE with production is almost certainly a parse miss (field absent, not a true $0 cost)
      const hasProduction = raw.production_months.some(pm => pm.period === stmt.period && (pm.oil_bbl ?? 0) > 0);
      if (hasProduction) {
        console.warn(`[extraction-sanitize] $0 LOE in period ${stmt.period} despite reported production — nulled (likely parse miss)`);
        total_loe_usd = null;
      }
    }
    if (total_loe_usd != null && total_loe_usd > MAX_CONVENTIONAL_LOE_PER_MONTH) {
      console.warn(`[extraction-sanitize] Implausibly high LOE ($${total_loe_usd}) in period ${stmt.period} — nulled`);
      total_loe_usd = null;
    }

    // Sanitize gas price if present
    let gas_price_per_mcf = stmt.gas_price_per_mcf;
    if (gas_price_per_mcf != null && (gas_price_per_mcf < 0.10 || gas_price_per_mcf > 30)) {
      console.warn(`[extraction-sanitize] Gas price out of range ($${gas_price_per_mcf}/MCF) in period ${stmt.period} — nulled`);
      gas_price_per_mcf = null;
    }

    return { ...stmt, total_loe_usd, gas_price_per_mcf };
  });

  // ── Water cut ─────────────────────────────────────────────────────────────
  let water_cut_pct = raw.water_cut_pct;
  if (water_cut_pct != null && (water_cut_pct < 0 || water_cut_pct > 100)) {
    console.warn(`[extraction-sanitize] water_cut_pct out of range (${water_cut_pct}) — nulled`);
    water_cut_pct = null;
  }

  return {
    ...raw,
    ownership_records,
    production_months,
    loe_statements,
    water_cut_pct,
  };
}
