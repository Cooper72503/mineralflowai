import type { ProductionSnapshotInput } from "./types";
import type { ProductionSnapshotOutput } from "./types";

const BASE_RISK =
  "Production snapshot is directional screening only — not well-level production history or state-reported volumes.";

export function buildProductionNarrative(args: {
  input: ProductionSnapshotInput;
  status: ProductionSnapshotOutput["production_status"];
  trend: ProductionSnapshotOutput["production_trend"];
  age: ProductionSnapshotOutput["producing_age_estimate"];
  firstYear: number | null;
  confidence: ProductionSnapshotOutput["production_confidence"];
}): Pick<ProductionSnapshotOutput, "summary" | "reasoning" | "risks" | "missing_data"> {
  const { input, status, trend, age, firstYear, confidence } = args;
  const reasoning: string[] = [];
  const missing: string[] = [];
  const risks: string[] = [BASE_RISK];

  if ((input.annual_revenue ?? 0) > 0 || (input.monthly_revenue ?? 0) > 0) {
    reasoning.push("Document-derived revenue band or financial summary supports an economic / cash-flow context.");
  }
  if (input.bopd != null && input.bopd > 0) {
    reasoning.push(`Oil rate indication (~${input.bopd} BOPD) was parsed or inferred from text — treat as approximate.`);
  }
  if (input.nearby_activity_signal && input.nearby_activity_signal !== "Unknown") {
    reasoning.push(
      `Regional activity signal (${input.nearby_activity_signal}) from location context supports development context — not lease-specific production.`,
    );
  }
  if (input.operator?.trim()) {
    reasoning.push(`Operator / counterparty name present (${input.operator.trim()}) — supports commercial context.`);
  }

  if (!input.county?.trim()) missing.push("county");
  if (!input.state?.trim()) missing.push("state");
  if (!((input.annual_revenue ?? 0) > 0) && !((input.monthly_revenue ?? 0) > 0) && !(input.bopd != null && input.bopd > 0)) {
    missing.push("direct production or revenue figures");
  }

  if (status === "undeveloped" || status === "unknown") {
    risks.push("No reliable producing evidence from this document — engineering review required before assuming activity.");
  }
  if (confidence === "low") {
    risks.push("Sparse or mostly inferred signals — do not rely on this snapshot for investment decisions alone.");
  }

  let summary = `Screening read: ${status.replace(/_/g, " ")}`;
  summary += ` · trend ${trend}`;
  summary += ` · age bucket ${age.replace(/_/g, " ")}`;
  if (firstYear != null) summary += ` · inferred reference year ${firstYear} (uncertain)`;
  summary += ` · confidence ${confidence}.`;
  summary += " This is pre-underwriting context only.";

  if (reasoning.length === 0) {
    reasoning.push(
      "Limited producing signals in available text and structured fields — classification stays conservative.",
    );
  }

  return { summary, reasoning, risks, missing_data: missing };
}
