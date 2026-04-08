import type { DealValuationInput } from "./types";
import type { DealValuationDealType } from "./types";
import type { DealValuationActivityLevel } from "./types";
import type { ValueEstimateResult } from "./value-estimator";

export function buildValuationNarrative(args: {
  input: DealValuationInput;
  dealType: DealValuationDealType;
  activity: DealValuationActivityLevel;
  value: ValueEstimateResult;
  nriLine: string | null;
}): { summary: string; reasoning: string[]; risks: string[]; missing_data: string[] } {
  const reasoning: string[] = [];
  const risks: string[] = [
    "Value range is directional screening only — validate with title, engineering, and commercial diligence.",
  ];
  const missing_data: string[] = [];

  if (args.input.county?.trim()) {
    reasoning.push(`County context: ${args.input.county.trim()}${args.input.state ? `, ${args.input.state}` : ""}.`);
  } else {
    missing_data.push("county");
  }

  if (!args.input.state?.trim()) {
    missing_data.push("state");
  }

  const lp = args.input.legal_description_parsed;
  if (lp && (lp.section || lp.block || lp.survey_name || lp.abstract_number)) {
    const bits: string[] = [];
    if (lp.abstract_number) bits.push(`abstract ${lp.abstract_number}`);
    if (lp.survey_name) bits.push(lp.survey_name);
    if (lp.block) bits.push(`block ${lp.block}`);
    if (lp.section) bits.push(`section ${lp.section}`);
    reasoning.push(`Legal description cues (parsed): ${bits.join(", ")}.`);
  }

  if (args.input.acreage != null && args.input.acreage > 0) {
    reasoning.push(`Acreage signal: ${args.input.acreage} acres (document-derived).`);
  } else {
    missing_data.push("acreage");
  }

  if (args.input.royalty_rate != null && args.input.royalty_rate > 0) {
    reasoning.push(`Royalty parsed as ${(args.input.royalty_rate * 100).toFixed(1)}% decimal for screening.`);
  } else {
    missing_data.push("royalty");
  }

  if (args.input.ownership_percent == null) {
    missing_data.push("ownership");
  }

  const hasEcon =
    (args.input.annual_revenue != null && args.input.annual_revenue > 0) ||
    (args.input.monthly_revenue != null && args.input.monthly_revenue > 0) ||
    (args.input.bopd != null && args.input.bopd > 0);
  if (!hasEcon) {
    missing_data.push("revenue or production indication");
  }

  if (args.activity === "high" || args.activity === "moderate") {
    reasoning.push("Location/activity context suggests meaningful regional development or drilling relevance.");
  } else if (args.activity === "low") {
    reasoning.push("Regional activity context appears limited from available document signals.");
  }

  if (args.dealType === "producing") {
    reasoning.push("Treated as producing: revenue or production cues present in the document.");
  }
  if (args.dealType === "undeveloped" || args.dealType === "lease") {
    reasoning.push("No reliable production economics in text — undeveloped / lease-style screening.");
  }
  if (args.dealType === "infrastructure" || args.dealType === "mixed") {
    reasoning.push("Infrastructure or mixed signals may shift economics away from simple acreage multiples.");
    risks.push("Infrastructure value is estimated from limited document cues — economics can diverge widely.");
  }

  if (args.nriLine) {
    reasoning.push(args.nriLine);
  }

  if (args.value.method.includes("BOPD")) {
    risks.push("Production-based value uses wide commodity and timing assumptions — treat as illustrative.");
  }

  const summaryParts: string[] = [];
  summaryParts.push(`Deal type: ${args.dealType.replace(/_/g, " ")}.`);
  summaryParts.push(`Activity tier: ${args.activity}.`);
  if (args.value.estimated_total_value_low != null && args.value.estimated_total_value_high != null) {
    summaryParts.push(
      `Directional total value band (screening): ${Math.round(args.value.estimated_total_value_low)}–${Math.round(args.value.estimated_total_value_high)} USD.`
    );
  } else {
    summaryParts.push("Insufficient numeric basis for a tight value band — rely on qualitative review.");
  }

  return {
    summary: summaryParts.join(" "),
    reasoning,
    risks: uniqCap(risks, 8),
    missing_data: uniqCap(missing_data, 12),
  };
}

function uniqCap(list: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
