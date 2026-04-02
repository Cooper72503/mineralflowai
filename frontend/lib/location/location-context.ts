/**
 * Assistive, document-derived location context — not GIS or a survey map.
 * Conservative: prefer "unknown" over implied precision.
 */

import type { DevelopmentSignalsSnapshot } from "@/lib/development/detect-development-signals";
import { hasRegionalDrillFromDealInput } from "@/lib/development/detect-development-signals";

export type LocationConfidence = "High" | "Medium" | "Low";
export type NearbyActivitySignal = "High" | "Moderate" | "Low" | "Unknown";

export type LocationContext = {
  approximate_area: string;
  parsed_legal_description: string;
  nearby_activity_signal: NearbyActivitySignal;
  confidence: LocationConfidence;
  summary: string;
  notes: string;
};

const NOTES =
  "Based on document-derived legal description. Approximate county-area placement only. Not a surveyed tract map or final title opinion.";

function normalizeCountyLabel(county: string | null | undefined): string | null {
  if (county == null) return null;
  const t = county.trim();
  if (!t) return null;
  if (/\bcounty\b/i.test(t)) return t;
  return `${t} County`;
}

/** Combined text for scanning (legal description primary). */
function scanText(
  legal_description: string | null | undefined,
  extracted_text: string | null | undefined
): string {
  const parts: string[] = [];
  if (legal_description?.trim()) parts.push(legal_description.trim());
  if (extracted_text?.trim()) {
    parts.push(extracted_text.trim().slice(0, 80_000));
  }
  return parts.join("\n\n");
}

export type ParsedLegalParts = {
  section: string | null;
  block: string | null;
  survey: string | null;
  abstract: string | null;
};

/**
 * Best-effort extraction of common Texas / mineral-deed style descriptors.
 */
export function parseLegalDescriptionParts(text: string): ParsedLegalParts {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) {
    return { section: null, block: null, survey: null, abstract: null };
  }

  let section: string | null = null;
  const secM =
    s.match(/\bSection\s+(\d+[A-Za-z]?(?:\s*\/\s*\d+)?)\b/i) ??
    s.match(/\bSec\.?\s+(\d+[A-Za-z]?(?:\s*\/\s*\d+)?)\b/i);
  if (secM) section = secM[1].trim();

  let block: string | null = null;
  const blockM = s.match(/\bBlock\s+(\d+[A-Za-z]?)\b/i);
  if (blockM) block = blockM[1].trim();

  let survey: string | null = null;
  const surveyM = s.match(
    /\b((?:[A-Z][A-Za-z0-9&'.\s-]{1,64}?)(?:Survey|Srvy|Surv)\.?)\b/i
  );
  if (surveyM) {
    survey = surveyM[1].replace(/\s+/g, " ").trim();
  }

  let abstract: string | null = null;
  const absM =
    s.match(/\bAbstract\s+(?:No\.?\s*)?([A-Z]?\d+[A-Za-z]?)\b/i) ??
    s.match(/\bA(?:bstract)?[- ](\d+[A-Za-z]?)\b/i);
  if (absM) abstract = absM[1].trim();

  return { section, block, survey, abstract };
}

function formatParsedLegalLine(parts: ParsedLegalParts): { line: string; tier: "structured" | "weak" } {
  const bits: string[] = [];
  if (parts.section) bits.push(`Section ${parts.section}`);
  if (parts.block) bits.push(`Block ${parts.block}`);
  if (parts.survey) bits.push(parts.survey);
  if (parts.abstract) bits.push(`Abstract ${parts.abstract}`);
  if (bits.length >= 1) return { line: bits.join(" · "), tier: "structured" };
  return { line: "", tier: "weak" };
}

/**
 * Directional / quadrant hints from text only — no coordinate inference.
 */
export function inferApproximateAreaDescriptor(scan: string): string | null {
  const t = scan.slice(0, 120_000);
  const lower = t.toLowerCase();

  const quadrantRules: Array<{ re: RegExp; label: string }> = [
    // Common shorthand: NE/4, NW/4 (quarter section)
    { re: /\bNE\s*\/\s*4\b/i, label: "Northeastern" },
    { re: /\bNW\s*\/\s*4\b/i, label: "Northwestern" },
    { re: /\bSE\s*\/\s*4\b/i, label: "Southeastern" },
    { re: /\bSW\s*\/\s*4\b/i, label: "Southwestern" },
    { re: /\b(?:ne|n\.?\s*e\.?)\s*[/]?\s*(?:1\s*[/]\s*4|quarter)\b/i, label: "Northeastern" },
    { re: /\b(?:nw|n\.?\s*w\.?)\s*[/]?\s*(?:1\s*[/]\s*4|quarter)\b/i, label: "Northwestern" },
    { re: /\b(?:se|s\.?\s*e\.?)\s*[/]?\s*(?:1\s*[/]\s*4|quarter)\b/i, label: "Southeastern" },
    { re: /\b(?:sw|s\.?\s*w\.?)\s*[/]?\s*(?:1\s*[/]\s*4|quarter)\b/i, label: "Southwestern" },
    { re: /\bnortheast(?:ern)?\b/i, label: "Northeastern" },
    { re: /\bnorthwest(?:ern)?\b/i, label: "Northwestern" },
    { re: /\bsoutheast(?:ern)?\b/i, label: "Southeastern" },
    { re: /\bsouthwest(?:ern)?\b/i, label: "Southwestern" },
  ];
  for (const { re, label } of quadrantRules) {
    re.lastIndex = 0;
    if (re.test(t)) return label;
  }

  const halfRules: Array<{ re: RegExp; label: string }> = [
    { re: /\b(?:north|n\.?)\s*[/]?\s*(?:1\s*[/]\s*2|half)\b/i, label: "Northern" },
    { re: /\b(?:south|s\.?)\s*[/]?\s*(?:1\s*[/]\s*2|half)\b/i, label: "Southern" },
    { re: /\b(?:east|e\.?)\s*[/]?\s*(?:1\s*[/]\s*2|half)\b/i, label: "Eastern" },
    { re: /\b(?:west|w\.?)\s*[/]?\s*(?:1\s*[/]\s*2|half)\b/i, label: "Western" },
  ];
  for (const { re, label } of halfRules) {
    re.lastIndex = 0;
    if (re.test(t)) return label;
  }

  const wordRules: Array<{ re: RegExp; label: string }> = [
    { re: /\b(?:northern|north\s+part|upper\s+county)\b/i, label: "Northern" },
    { re: /\b(?:southern|south\s+part|lower\s+county)\b/i, label: "Southern" },
    { re: /\b(?:eastern|east\s+part)\b/i, label: "Eastern" },
    { re: /\b(?:western|west\s+part)\b/i, label: "Western" },
  ];
  for (const { re, label } of wordRules) {
    if (re.test(lower)) return label;
  }

  return null;
}

function scoreStructureStrength(parts: ParsedLegalParts): number {
  let n = 0;
  if (parts.section) n += 2;
  if (parts.block) n += 1;
  if (parts.survey) n += 2;
  if (parts.abstract) n += 1;
  return n;
}

function deriveNearbyActivity(
  ds: DevelopmentSignalsSnapshot | null,
  merged: Record<string, unknown>
): NearbyActivitySignal {
  const regional = hasRegionalDrillFromDealInput(merged);
  if (ds == null) {
    return regional ? "Moderate" : "Unknown";
  }

  const wells = ds.referenced_wells?.length ?? 0;
  const infra = ds.has_infrastructure_language;
  const hasDev = ds.has_development_signals;
  const formation = ds.formation_text_mention != null;
  const depthDoc = ds.extracted_depth_limit_feet != null;

  if (regional && wells >= 2 && (infra || formation)) return "High";
  if (regional && wells >= 1 && (infra || formation || depthDoc)) return "High";
  if (regional && hasDev && (wells >= 1 || formation || depthDoc || infra)) return "Moderate";
  if (regional && hasDev) return "Moderate";
  if (hasDev && (wells >= 1 || formation || depthDoc || infra)) return "Moderate";
  if (hasDev && ds.has_legal_development_context) return "Low";
  if (regional) return "Moderate";
  return "Unknown";
}

function deriveLocationConfidence(
  countyLabel: string | null,
  descriptor: string | null,
  parts: ParsedLegalParts,
  parsedLineTier: "structured" | "weak",
  legalHasText: boolean
): LocationConfidence {
  const structureScore = scoreStructureStrength(parts);
  const hasCounty = countyLabel != null;

  if (hasCounty && descriptor && structureScore >= 3) return "High";
  if (hasCounty && descriptor && structureScore >= 1) return "High";
  if (hasCounty && structureScore >= 3) return "High";
  if (hasCounty && (descriptor || structureScore >= 2 || parsedLineTier === "structured"))
    return "Medium";
  if (hasCounty && legalHasText) return "Medium";
  if (hasCounty) return "Low";
  return "Low";
}

function buildSummary(params: {
  approximate_area: string;
  confidence: LocationConfidence;
  activity: NearbyActivitySignal;
  descriptor: string | null;
  countyBase: string | null;
}): string {
  const { approximate_area, confidence, activity, descriptor, countyBase } = params;

  if (approximate_area === "County area not confidently determined") {
    if (confidence === "Low" || !countyBase) {
      return "The legal description did not provide enough structure to confidently place the tract within the county.";
    }
    return `County is known (${countyBase}), but the description did not support a finer within-county placement.`;
  }

  if (descriptor && countyBase) {
    const act =
      activity === "High" || activity === "Moderate"
        ? "based on the legal description and regional development context"
        : "from the legal wording alone";
    return `This tract appears to sit in ${approximate_area.toLowerCase()}, ${act}.`;
  }

  if (confidence === "High" || confidence === "Medium") {
    return "Structured legal elements (section, survey, or similar) support a clearer read of where the interest is described, relative to county-level context.";
  }

  return "Location context is limited to county and fragmentary legal language; treat placement as indicative only.";
}

export type BuildLocationContextParams = {
  county: string | null;
  state: string | null;
  legal_description: string | null;
  extracted_text: string | null;
  merged: Record<string, unknown>;
  development_signals: DevelopmentSignalsSnapshot | null;
};

export function buildLocationContext(params: BuildLocationContextParams): LocationContext {
  const { county, legal_description, extracted_text, merged, development_signals } = params;
  const scan = scanText(legal_description, extracted_text);
  const parts = parseLegalDescriptionParts(scan);
  const { line: parsedLine, tier: parsedTier } = formatParsedLegalLine(parts);
  const legalHasText = Boolean(legal_description?.trim()) || Boolean(scan.trim());

  const countyLabel = normalizeCountyLabel(county);
  const descriptor = inferApproximateAreaDescriptor(scan);

  let approximate_area: string;
  if (countyLabel && descriptor) {
    approximate_area = `${descriptor} ${countyLabel}`;
  } else {
    approximate_area = "County area not confidently determined";
  }

  let parsed_legal_description: string;
  if (parsedTier === "structured" && parsedLine) {
    parsed_legal_description = parsedLine;
  } else if (legalHasText) {
    parsed_legal_description = "Partial match only";
  } else {
    parsed_legal_description = "Not clearly parsed";
  }

  const nearby_activity_signal = deriveNearbyActivity(development_signals, merged);

  const confidence = deriveLocationConfidence(
    countyLabel,
    descriptor,
    parts,
    parsedTier,
    legalHasText
  );

  const summary = buildSummary({
    approximate_area,
    confidence,
    activity: nearby_activity_signal,
    descriptor,
    countyBase: countyLabel,
  });

  return {
    approximate_area,
    parsed_legal_description,
    nearby_activity_signal,
    confidence,
    summary,
    notes: NOTES,
  };
}

export function isLocationContext(value: unknown): value is LocationContext {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.approximate_area === "string" &&
    typeof o.parsed_legal_description === "string" &&
    typeof o.nearby_activity_signal === "string" &&
    typeof o.confidence === "string" &&
    typeof o.summary === "string" &&
    typeof o.notes === "string"
  );
}
