import type { ProductionSnapshotInput } from "./types";
import type { ProductionSnapshotOutput } from "./types";

const FIRST_PROD_YEAR = /\b(?:first\s+production|initial\s+production|ip\s+date|producing\s+since)\b[^.]{0,80}\b(19\d{2}|20\d{2})\b/i;

const LEGACY_AGE =
  /\b(mature\s+field|legacy\s+well|stripper|decades?\s+of\s+production|producing\s+for\s+over\s+\d+\s+years?)\b/i;

const NEWER_CUES =
  /\b(new\s+completion|recent\s+refrac|first\s+sales\s+within|initial\s+production\s+test)\b/i;

function parseYearFromDates(input: ProductionSnapshotInput): number | null {
  const merged =
    typeof input.structured_source === "object" &&
    input.structured_source != null &&
    !Array.isArray(input.structured_source)
      ? (input.structured_source as Record<string, unknown>)
      : {};
  const dates = [merged.effective_date, merged.recording_date, merged.document_processed_at].filter(
    (d) => typeof d === "string" && d.trim(),
  ) as string[];
  let best: number | null = null;
  for (const d of dates) {
    const m = d.match(/\b(19\d{2}|20\d{2})\b/);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1950 && y <= new Date().getFullYear() + 1) {
        if (best == null || y > best) best = y;
      }
    }
  }
  return best;
}

export function estimateProducingAge(args: {
  input: ProductionSnapshotInput;
  textSample: string;
  productionStatus: ProductionSnapshotOutput["production_status"];
}): {
  producing_age_estimate: ProductionSnapshotOutput["producing_age_estimate"];
  estimated_first_production_year: number | null;
} {
  const { input, textSample, productionStatus } = args;
  const t = textSample.slice(0, 80_000);
  const fp = t.match(FIRST_PROD_YEAR);
  let estimatedYear: number | null = null;
  if (fp) {
    const y = parseInt(fp[1], 10);
    if (y >= 1950 && y <= new Date().getFullYear() + 1) estimatedYear = y;
  }
  if (estimatedYear == null) {
    const docYear = parseYearFromDates(input);
    if (docYear != null && productionStatus === "declining_or_legacy") {
      estimatedYear = docYear;
    }
  }

  if (NEWER_CUES.test(t.toLowerCase()) && productionStatus === "producing") {
    return { producing_age_estimate: "newer", estimated_first_production_year: estimatedYear };
  }

  if (LEGACY_AGE.test(t.toLowerCase()) || productionStatus === "declining_or_legacy") {
    return {
      producing_age_estimate: "legacy",
      estimated_first_production_year: estimatedYear,
    };
  }

  if (productionStatus === "likely_producing" || productionStatus === "producing") {
    return { producing_age_estimate: "mid_life", estimated_first_production_year: estimatedYear };
  }

  if (productionStatus === "undeveloped") {
    return { producing_age_estimate: "unknown", estimated_first_production_year: null };
  }

  return { producing_age_estimate: "unknown", estimated_first_production_year: estimatedYear };
}
