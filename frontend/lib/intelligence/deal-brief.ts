/**
 * Deal Brief — AI interpretation layer.
 *
 * Takes all structured deal signals (valuation, production snapshot, location, extracted fields)
 * and returns a plain-English advisory: what this deal is, its biggest risk, what to do,
 * lease term grades, and negotiation flags.
 *
 * Uses the same OpenAI client already wired into the pipeline.
 */

import OpenAI from "openai";
import type { DealValuationOutput } from "@/lib/valuation/types";
import type { ProductionSnapshot } from "@/lib/production/production-snapshot";
import type { LocationContext } from "@/lib/location/location-context";

export type LeaseTermGrade = {
  term: string;
  value: string | null;
  grade: "A" | "B" | "C" | "D" | "F" | null;
  note: string;
};

export type DealBrief = {
  /** 2-3 sentence plain-English deal summary — what it is, where it sits, why it matters. */
  narrative: string;
  /** The single most important risk — specific, not generic. */
  primary_risk: string;
  /** Clear recommended action with one-sentence rationale. */
  recommendation: string;
  /** Lease term grades — royalty, primary term, key clauses vs market norms. */
  lease_term_grades: LeaseTermGrade[];
  /** 2-3 specific negotiation talking points framed for the buyer. */
  negotiation_flags: string[];
  /** Overall brief confidence tied to input data quality. */
  confidence: "low" | "medium" | "high";
};

export type DealBriefArgs = {
  county: string | null;
  state: string | null;
  acreage: number | null;
  royalty_rate?: string | null;
  producing_status?: "yes" | "no" | "unknown" | null;
  valuation: DealValuationOutput;
  production_snapshot: ProductionSnapshot | null;
  location_context: LocationContext | null;
  /** Additional extracted fields from document (parties, dates, term, etc.) */
  extracted?: {
    lessor?: string | null;
    lessee?: string | null;
    grantor?: string | null;
    grantee?: string | null;
    document_type?: string | null;
    effective_date?: string | null;
    term_length?: string | null;
    operator?: string | null;
    /** Royalty statement fields */
    operator_name?: string | null;
    statement_period?: string | null;
    net_revenue_interest?: string | null;
    net_payment_amount?: number | null;
    payment_date?: string | null;
  } | null;
};

const SYSTEM_PROMPT = `You are a senior mineral rights analyst with 20 years of experience evaluating oil and gas deals in the US.

You are given structured data about a mineral rights deal. Your job is to write a Deal Brief — a concise, plain-English interpretation that tells a buyer exactly what this deal is, what the main risk is, what to do, and what to push back on.

Rules:
- Be specific. "Royalty rate 12.5% is 33% below market for Utica core (avg 18-20%)" is good. "Low royalty rate" is not.
- Do not hedge everything. Make a call.
- The narrative should read like an experienced operator wrote it, not like software generated it.
- Lease term grades: compare against known basin/play market norms. Grade A = at or above market, B = slightly below, C = materially below, D = well below, F = unacceptable.
- Negotiation flags should be specific talking points the buyer can use in a conversation, not generic advice.
- If data is thin (missing acreage, royalty rate, county, etc.), say so in the narrative and lower confidence accordingly — but still produce a useful brief.

ROYALTY STATEMENT GUIDANCE: When the document is a royalty/revenue statement:
- The narrative must lead with the monthly income figure and annualized income (monthly × 12).
- Calculate market value using the provided value range. Explain it as: "At a [X]x–[Y]x market multiple on $[annual] annual income, this interest is worth approximately $[low]–$[high]."
- The primary risk is usually production decline, single-well concentration, or operator-driven curtailment.
- Lease term grades should grade the NRI decimal (is it market rate for the royalty fraction?), operator quality, and production trend if data allows.
- Negotiation flags: price per NMA implied by the offer price, whether income has been stable, whether there are undisclosed deductions.
- Set document_type to "Royalty Statement" in your reasoning.

Return ONLY valid JSON matching this exact structure, no markdown, no extra text:
{
  "narrative": "string (2-3 sentences)",
  "primary_risk": "string (1-2 sentences, specific)",
  "recommendation": "string (1-2 sentences)",
  "lease_term_grades": [
    { "term": "string", "value": "string or null", "grade": "A|B|C|D|F or null", "note": "string" }
  ],
  "negotiation_flags": ["string", "string"],
  "confidence": "low|medium|high"
}`;

function buildUserMessage(args: DealBriefArgs): string {
  const v = args.valuation;
  const snap = args.production_snapshot;
  const loc = args.location_context;
  const ext = args.extracted ?? {};

  const lines: string[] = [
    `LOCATION: ${args.county ?? "Unknown county"}, ${args.state ?? "Unknown state"}`,
    `ACREAGE: ${args.acreage != null ? `${args.acreage} NMA` : "Not provided"}`,
    `ROYALTY RATE: ${args.royalty_rate ?? "Not provided"}`,
    `PRODUCING STATUS: ${args.producing_status ?? "unknown"}`,
    "",
    `DEAL TYPE: ${v.deal_type}`,
    `ACTIVITY LEVEL: ${v.activity_level}`,
    `RECOMMENDATION: ${v.recommendation}`,
    `CONFIDENCE: ${v.confidence}`,
    `VALUE RANGE: ${v.estimated_total_value_low != null ? `$${v.estimated_total_value_low.toLocaleString()}–$${v.estimated_total_value_high?.toLocaleString()}` : "Not estimated"}`,
    `VALUE PER ACRE: ${v.value_per_acre_low != null ? `$${v.value_per_acre_low.toLocaleString()}–$${v.value_per_acre_high?.toLocaleString()}/NMA` : "Not estimated"}`,
    `NRI PROXY: ${v.nri != null ? v.nri : "Not estimated"}`,
  ];

  if (v.summary) lines.push(`\nVALUATION SUMMARY: ${v.summary}`);

  if (v.reasoning?.length) {
    lines.push(`\nVALUATION REASONING:`);
    v.reasoning.forEach((r) => lines.push(`  - ${r}`));
  }

  if (v.risks?.length) {
    lines.push(`\nIDENTIFIED RISKS:`);
    v.risks.forEach((r) => lines.push(`  - ${r}`));
  }

  if (v.missing_data?.length) {
    lines.push(`\nMISSING DATA:`);
    v.missing_data.forEach((m) => lines.push(`  - ${m}`));
  }

  if (snap) {
    lines.push(`\nPRODUCTION SNAPSHOT:`);
    lines.push(`  Status: ${snap.status}, Trend: ${snap.trend}`);
    if (snap.bopd_low != null) lines.push(`  BOPD estimate: ${snap.bopd_low}–${snap.bopd_high}`);
    if (snap.monthly_royalty_low != null) lines.push(`  Monthly royalty estimate: $${snap.monthly_royalty_low.toLocaleString()}–$${snap.monthly_royalty_high?.toLocaleString()}`);
    lines.push(`  Confidence: ${snap.confidence}`);
  }

  if (loc) {
    lines.push(`\nLOCATION CONTEXT:`);
    lines.push(`  Area: ${loc.approximate_area}`);
    lines.push(`  Nearby activity: ${loc.nearby_activity_signal}`);
    if (loc.summary) lines.push(`  Summary: ${loc.summary}`);
  }

  if (ext.document_type) lines.push(`\nDOCUMENT TYPE: ${ext.document_type}`);
  if (ext.lessor) lines.push(`LESSOR: ${ext.lessor}`);
  if (ext.lessee || ext.grantee) lines.push(`LESSEE/GRANTEE: ${ext.lessee ?? ext.grantee}`);
  if (ext.effective_date) lines.push(`EFFECTIVE DATE: ${ext.effective_date}`);
  if (ext.term_length) lines.push(`PRIMARY TERM: ${ext.term_length}`);
  if (ext.operator || ext.operator_name) lines.push(`OPERATOR: ${ext.operator ?? ext.operator_name}`);

  // Royalty statement fields
  if (ext.operator_name) lines.push(`OPERATOR/PAYOR: ${ext.operator_name}`);
  if (ext.statement_period) lines.push(`STATEMENT PERIOD: ${ext.statement_period}`);
  if (ext.net_revenue_interest) lines.push(`NET REVENUE INTEREST (NRI): ${ext.net_revenue_interest}`);
  if (ext.net_payment_amount != null) {
    lines.push(`NET PAYMENT THIS PERIOD: $${ext.net_payment_amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    const annualized = ext.net_payment_amount * 12;
    lines.push(`ANNUALIZED INCOME (est.): $${annualized.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/yr`);
  }
  if (ext.payment_date) lines.push(`PAYMENT DATE: ${ext.payment_date}`);

  return lines.join("\n");
}

function fallbackBrief(args: DealBriefArgs): DealBrief {
  const v = args.valuation;
  return {
    narrative: `${args.county ?? "Unknown location"}, ${args.state ?? ""} — ${v.deal_type} mineral interest. ${v.summary ?? ""}`.trim(),
    primary_risk: v.risks?.[0] ?? "Insufficient data to identify primary risk.",
    recommendation: `System recommendation: ${v.recommendation}. ${v.confidence === "low" ? "Data quality is thin — verify inputs before committing." : ""}`,
    lease_term_grades: args.royalty_rate
      ? [{ term: "Royalty Rate", value: args.royalty_rate, grade: null, note: "Unable to grade — AI brief unavailable." }]
      : [],
    negotiation_flags: [],
    confidence: "low",
  };
}

/**
 * Generate a Deal Brief using OpenAI. Falls back to a structured summary on error.
 * Never throws.
 */
export async function generateDealBrief(args: DealBriefArgs): Promise<DealBrief> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fallbackBrief(args);

  try {
    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_BRIEF_MODEL ?? process.env.OPENAI_OCR_MODEL ?? "gpt-4o-mini";

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.3,
      max_tokens: 900,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(args) },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!raw) return fallbackBrief(args);

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as DealBrief;

    // Basic validation
    if (!parsed.narrative || !parsed.primary_risk || !parsed.recommendation) {
      return fallbackBrief(args);
    }

    return {
      narrative: String(parsed.narrative),
      primary_risk: String(parsed.primary_risk),
      recommendation: String(parsed.recommendation),
      lease_term_grades: Array.isArray(parsed.lease_term_grades) ? parsed.lease_term_grades : [],
      negotiation_flags: Array.isArray(parsed.negotiation_flags) ? parsed.negotiation_flags : [],
      confidence: (["low", "medium", "high"] as const).includes(parsed.confidence as "low" | "medium" | "high")
        ? parsed.confidence
        : "low",
    };
  } catch (err) {
    console.warn("[deal-brief] generation failed:", err instanceof Error ? err.message : err);
    return fallbackBrief(args);
  }
}
