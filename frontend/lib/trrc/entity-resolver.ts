/**
 * TRRC Public Records Due Diligence — Entity Resolver
 *
 * Takes raw user input, detects type, normalizes, and returns resolved entities.
 * Never throws — returns errors in the result object.
 */

import { COUNTY_DISTRICTS } from "./county-districts";
import type {
  TrrcIdentifierType,
  ResolvedEntity,
  NormalizedApi,
} from "./types";
import {
  detectInputType,
  normalizeApiNumber,
  normalizeLeaseNumber,
  normalizeOperatorName,
  extractDistrictFromApi,
} from "./normalization";
// Legal description GIS resolution (V2 — archived); legal_description input is a documented gap

// ─── Public result type ───────────────────────────────────────────────────────

export type EntityResolutionResult = {
  input_type: TrrcIdentifierType;
  normalized_input: string;
  entities: ResolvedEntity[];
  /** true when top confidence < 0.85 or multiple similar candidates or legal_description */
  needs_user_selection: boolean;
  /** log of steps taken, in order */
  resolution_trace: string[];
  error: string | null;
};

// ─── County name → district lookup ───────────────────────────────────────────

/**
 * Maps lowercase county name → primary TRRC district code.
 * Partial map — only the most common counties are listed.
 * Counties not present here require manual district input.
 */
const COUNTY_NAME_TO_DISTRICT: Record<string, string> = Object.fromEntries(
  Object.values(COUNTY_DISTRICTS).map(({ county, district }) => [county.toLowerCase().replace(/\s/g, ""), district]),
);

/**
 * Legal description keywords and their specificity weight (higher = more specific).
 */
const LEGAL_KEYWORDS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\babstract\s+(?:no\.?\s*)?\d+/i, label: "abstract_number", weight: 0.25 },
  { pattern: /\babst\.?\s+\d+/i, label: "abstract_abbrev", weight: 0.20 },
  { pattern: /\babs\.?\s+\d+/i, label: "abstract_abbrev_short", weight: 0.18 },
  { pattern: /\bsurvey\b/i, label: "survey_keyword", weight: 0.10 },
  { pattern: /\bsection\s+\d+/i, label: "section_number", weight: 0.20 },
  { pattern: /\bsec\.?\s+\d+/i, label: "section_abbrev", weight: 0.18 },
  { pattern: /\bblock\s+[a-z0-9]+/i, label: "block", weight: 0.20 },
  { pattern: /\bblk\.?\s+[a-z0-9]+/i, label: "block_abbrev", weight: 0.18 },
  { pattern: /\btwp\.?\s*\d+[ns]/i, label: "township", weight: 0.20 },
  { pattern: /\btownship\s+\d+/i, label: "township_full", weight: 0.22 },
  { pattern: /\brange\s+\d+[ew]/i, label: "range", weight: 0.20 },
  { pattern: /\brng\.?\s*\d+/i, label: "range_abbrev", weight: 0.18 },
  { pattern: /\bleague\b/i, label: "league", weight: 0.12 },
  { pattern: /\blabor\b/i, label: "labor", weight: 0.12 },
  { pattern: /\btract\s+\d+/i, label: "tract_number", weight: 0.15 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Must be a real UUID: this id is inserted as the primary key of
// trrc_resolved_entities (a uuid column) — see POST /api/trrc/due-diligence.
// Confirmed live: the old Math.random()-based id let the client and DB
// disagree on every entity's id (DB generated its own via a UUID default),
// so selecting a candidate in an ambiguous-match run always 404'd with
// "Entity not found or does not belong to this run."
function makeId(): string {
  return crypto.randomUUID();
}

function inferDistrictFromCounty(county: string | null): string | null {
  if (!county) return null;
  return COUNTY_NAME_TO_DISTRICT[county.trim().toLowerCase().replace(/\s/g, "")] ?? null;
}

// ─── Per-type resolvers ───────────────────────────────────────────────────────

function resolveApiNumber(
  raw: string,
  normalized: NormalizedApi,
  district_override: string | null,
  county: string | null,
  trace: string[],
): ResolvedEntity[] {
  trace.push(`Parsing API number: digits=${normalized.api10}, county_code=${normalized.county_code}`);

  // Infer district from county code in API
  const district =
    district_override ??
    extractDistrictFromApi(normalized.api10) ??
    inferDistrictFromCounty(county);

  if (district) {
    trace.push(`District resolved: ${district}`);
  } else {
    trace.push("District could not be inferred from API county code — manual input needed");
  }

  const wellboreEntity: ResolvedEntity = {
    id: makeId(),
    entity_type: "wellbore",
    canonical_identifier: normalized.api10,
    display_name: `Well ${normalized.formatted}`,
    attributes: {
      api10: normalized.api10,
      api14: normalized.api14,
      formatted: normalized.formatted,
      state_code: normalized.state_code,
      county_code: normalized.county_code,
      well_code: normalized.well_code,
      district: district ?? null,
      raw_input: raw,
    },
    confidence: 0.99,
    resolution_method: "api_number_parse",
    is_user_selected: false,
  };

  trace.push(`Resolved wellbore entity: ${normalized.formatted} (confidence=0.99)`);

  const entities: ResolvedEntity[] = [wellboreEntity];

  // An API identifies a wellbore, not a lease. Lease identity requires
  // an actual regulator record; never manufacture an api_derived entity.

  return entities;
}

function resolveLeaseNumber(
  raw: string,
  district_override: string | null,
  county: string | null,
  trace: string[],
): ResolvedEntity[] {
  const normalized = normalizeLeaseNumber(raw);
  const district = district_override ?? inferDistrictFromCounty(county);
  const confidence = district ? 0.9 : 0.6;

  trace.push(
    `Normalized lease number: "${normalized}"; district=${district ?? "unknown"}; confidence=${confidence}`,
  );

  if (!district) {
    trace.push(
      "District not provided and cannot be inferred from county — lease number is ambiguous across districts",
    );
  }

  const entity: ResolvedEntity = {
    id: makeId(),
    entity_type: "lease",
    canonical_identifier: district ? `${district}:${normalized}` : normalized,
    display_name: district
      ? `Lease ${normalized} (District ${district})`
      : `Lease ${normalized} (district unknown)`,
    attributes: {
      lease_number: normalized,
      district: district ?? null,
      raw_input: raw,
    },
    confidence,
    resolution_method: "lease_number_parse",
    is_user_selected: false,
  };

  return [entity];
}

function resolveOperatorName(
  raw: string,
  trace: string[],
): ResolvedEntity[] {
  const normalized = normalizeOperatorName(raw);
  trace.push(`Normalized operator name: "${normalized}" (confidence=0.8)`);

  const entity: ResolvedEntity = {
    id: makeId(),
    entity_type: "operator",
    canonical_identifier: normalized,
    display_name: normalized,
    attributes: {
      normalized_name: normalized,
      raw_input: raw,
    },
    confidence: 0.8,
    resolution_method: "operator_name_normalize",
    is_user_selected: false,
  };

  return [entity];
}

function resolveP5Number(
  raw: string,
  trace: string[],
): ResolvedEntity[] {
  const p5 = raw.trim();
  trace.push(`Resolving P5 number: "${p5}" (confidence=0.95)`);

  const entity: ResolvedEntity = {
    id: makeId(),
    entity_type: "operator",
    canonical_identifier: p5,
    display_name: `Operator P5# ${p5}`,
    attributes: {
      p5_number: p5,
      raw_input: raw,
    },
    confidence: 0.95,
    resolution_method: "p5_number_parse",
    is_user_selected: false,
  };

  return [entity];
}

/**
 * Text-matching fallback: score the legal description against known keywords and
 * return a low-confidence lease entity (no GIS data available).
 */
function resolveLegalDescriptionFallback(
  raw: string,
  county: string | null,
  trace: string[],
): ResolvedEntity[] {
  // Score specificity based on matched keywords
  let specificity = 0;
  const matchedLabels: string[] = [];

  for (const kw of LEGAL_KEYWORDS) {
    if (kw.pattern.test(raw)) {
      specificity += kw.weight;
      matchedLabels.push(kw.label);
    }
  }

  // Clamp to [0.3, 0.7]
  const baseConfidence = Math.min(0.7, Math.max(0.3, 0.3 + specificity));

  trace.push(
    `Legal description text-match specificity: ${specificity.toFixed(3)}; ` +
    `matched: [${matchedLabels.join(", ")}]; fallback confidence: ${baseConfidence.toFixed(2)}`,
  );

  if (matchedLabels.length === 0) {
    trace.push("No legal keywords matched — returning single low-confidence candidate");
  }

  const district = inferDistrictFromCounty(county);

  const entity: ResolvedEntity = {
    id: makeId(),
    entity_type: "lease",
    canonical_identifier: `legal:${raw.slice(0, 80).replace(/\s+/g, "_")}`,
    display_name: `Legal Description Match (${county ?? "county unknown"})`,
    attributes: {
      legal_description: raw,
      matched_keywords: matchedLabels,
      county: county ?? null,
      district: district ?? null,
      specificity_score: specificity,
    },
    confidence: baseConfidence,
    resolution_method: "legal_description_parse",
    is_user_selected: false,
  };

  trace.push(
    "Legal description fallback entity generated; requires user confirmation before retrieval",
  );

  return [entity];
}

/**
 * GIS-backed legal description resolution.
 *
 * Flow:
 *   1. Parse the legal description for abstract/survey/block/section.
 *   2. Call lookupWellsByLegalDescription (OTLS ArcGIS polygon → statewide wells bbox).
 *   3. If API numbers found: return wellbore entities with calibrated confidence.
 *   4. If parsed but no GIS match: return a low-confidence lease entity with location context.
 *   5. If GIS call fails or state is non-Texas: fall back to text-matching.
 *
 * Confidence scale:
 *   - 1 API from GIS:  0.85
 *   - 2–3 APIs:        0.75
 *   - 4+ APIs:         0.65
 *   - Parsed only:     0.40
 *   - Text-match only: clamped [0.3, 0.7]
 */
async function resolveLegalDescription(
  raw: string,
  county: string | null,
  trace: string[],
): Promise<ResolvedEntity[]> {
  // GIS-backed resolution archived (V2). Legal description input is a documented gap —
  // the edge function returns data_gap: true for search_by_legal_description.
  trace.push("Legal description GIS resolution not available — using text-match fallback");
  return resolveLegalDescriptionFallback(raw, county, trace);
}

function resolveLeaseName(
  raw: string,
  county: string | null,
  operator_name: string | null,
  trace: string[],
): ResolvedEntity[] {
  trace.push(`Resolving lease name: "${raw}"`);

  const district = inferDistrictFromCounty(county);
  const normalizedOp = operator_name ? normalizeOperatorName(operator_name) : null;

  // Confidence is higher when county / operator context is provided
  const contextCount = (county ? 1 : 0) + (operator_name ? 1 : 0);
  const confidence = 0.45 + contextCount * 0.1; // 0.45, 0.55, or 0.65

  trace.push(
    `Lease name candidate confidence: ${confidence.toFixed(2)} ` +
    `(context: county=${county ?? "none"}, operator=${normalizedOp ?? "none"})`,
  );

  const entity: ResolvedEntity = {
    id: makeId(),
    entity_type: "lease",
    canonical_identifier: `lease_name:${raw.trim().toLowerCase().replace(/\s+/g, "_")}`,
    display_name: `Lease "${raw.trim()}"${county ? ` in ${county} County` : ""}`,
    attributes: {
      lease_name: raw.trim(),
      county: county ?? null,
      district: district ?? null,
      operator_filter: normalizedOp ?? null,
    },
    confidence,
    resolution_method: "lease_name_search",
    is_user_selected: false,
  };

  return [entity];
}

function resolveGasWellId(
  raw: string,
  district_override: string | null,
  county: string | null,
  trace: string[],
): ResolvedEntity[] {
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, "");
  const district = district_override ?? inferDistrictFromCounty(county);

  trace.push(`Resolving gas well ID: "${normalized}"; district=${district ?? "unknown"}`);

  const confidence = district ? 0.88 : 0.65;

  const entity: ResolvedEntity = {
    id: makeId(),
    entity_type: "wellbore",
    canonical_identifier: district ? `${district}:${normalized}` : normalized,
    display_name: district
      ? `Gas Well ${normalized} (District ${district})`
      : `Gas Well ${normalized} (district unknown)`,
    attributes: {
      gas_well_id: normalized,
      district: district ?? null,
      county: county ?? null,
      raw_input: raw,
    },
    confidence,
    resolution_method: "gas_well_id_parse",
    is_user_selected: false,
  };

  return [entity];
}

// ─── Unknown fallback ─────────────────────────────────────────────────────────

async function resolveUnknown(
  raw: string,
  county: string | null,
  district: string | null,
  operator_name: string | null,
  lease_name: string | null,
  trace: string[],
): Promise<{ type: TrrcIdentifierType; entities: ResolvedEntity[] }> {
  trace.push("Input type unknown — attempting API number parse first");

  // Try API number
  const apiAttempt = normalizeApiNumber(raw);
  if (apiAttempt) {
    trace.push("Fallback: detected as API number");
    return {
      type: "api_number",
      entities: resolveApiNumber(raw, apiAttempt, district, county, trace),
    };
  }
  trace.push("Not a valid API number");

  // Try lease number (purely numeric 4-6 digits)
  if (/^\d{4,6}$/.test(raw.trim())) {
    trace.push("Fallback: detected as RRC lease number (4-6 digit numeric)");
    return {
      type: "rrc_lease_number",
      entities: resolveLeaseNumber(raw, district, county, trace),
    };
  }
  trace.push("Not a lease number format");

  // Try operator name as last resort
  trace.push("Fallback: treating as operator name");
  return {
    type: "operator_name",
    entities: resolveOperatorName(raw, trace),
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Resolve raw user input into one or more typed entities.
 * Never throws — errors are returned in the result object.
 */
export async function resolveEntities(
  raw_input: string,
  override_type: TrrcIdentifierType | null,
  county: string | null,
  district: string | null,
  operator_name: string | null,
  lease_name: string | null,
): Promise<EntityResolutionResult> {
  const trace: string[] = [];

  if (!raw_input || raw_input.trim().length === 0) {
    return {
      input_type: "unknown",
      normalized_input: "",
      entities: [],
      needs_user_selection: true,
      resolution_trace: ["Input was empty — cannot resolve"],
      error: "Empty input",
    };
  }

  const trimmed = raw_input.trim();
  trace.push(`Raw input received: "${trimmed}"`);

  // Detect or use override type
  const detected = detectInputType(trimmed);
  const input_type: TrrcIdentifierType = override_type ?? detected;

  if (override_type && override_type !== detected) {
    trace.push(
      `Type override applied: user said "${override_type}", auto-detected "${detected}"`,
    );
  } else {
    trace.push(`Detected input type: "${input_type}"`);
  }

  let entities: ResolvedEntity[] = [];
  let resolvedType = input_type;

  try {
    switch (input_type) {
      case "api_number": {
        const normalized = normalizeApiNumber(trimmed);
        if (!normalized) {
          return {
            input_type,
            normalized_input: trimmed,
            entities: [],
            needs_user_selection: false,
            resolution_trace: [
              ...trace,
              `API number parse failed for: "${trimmed}"`,
            ],
            error: `Could not parse "${trimmed}" as a valid Texas API number`,
          };
        }
        entities = resolveApiNumber(trimmed, normalized, district, county, trace);
        break;
      }

      case "rrc_lease_number": {
        entities = resolveLeaseNumber(trimmed, district, county, trace);
        break;
      }

      case "operator_name": {
        entities = resolveOperatorName(trimmed, trace);
        break;
      }

      case "p5_number": {
        entities = resolveP5Number(trimmed, trace);
        break;
      }

      case "legal_description": {
        entities = await resolveLegalDescription(trimmed, county, trace);
        break;
      }

      case "lease_name": {
        entities = resolveLeaseName(trimmed, county, operator_name, trace);
        break;
      }

      case "gas_well_id": {
        entities = resolveGasWellId(trimmed, district, county, trace);
        break;
      }

      case "unknown": {
        trace.push("Entering unknown-type fallback resolution");
        const result = await resolveUnknown(
          trimmed,
          county,
          district,
          operator_name,
          lease_name,
          trace,
        );
        resolvedType = result.type;
        entities = result.entities;
        break;
      }

      default: {
        trace.push(`Unhandled input type: "${input_type as string}"`);
        entities = [];
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      input_type,
      normalized_input: trimmed,
      entities: [],
      needs_user_selection: true,
      resolution_trace: [...trace, `Resolution error: ${message}`],
      error: message,
    };
  }

  // Compute normalized_input from the primary entity's canonical_identifier if possible
  const normalized_input =
    entities[0]?.canonical_identifier ?? trimmed;

  // Determine whether user selection is needed
  const topConfidence = entities[0]?.confidence ?? 0;
  const hasMultipleSimilar =
    entities.length > 1 &&
    entities[1].confidence >= topConfidence - 0.1;

  const needs_user_selection =
    resolvedType === "legal_description" ||
    resolvedType === "lease_name" ||
    topConfidence < 0.85 ||
    hasMultipleSimilar;

  if (needs_user_selection) {
    trace.push(
      `User selection required: top_confidence=${topConfidence.toFixed(2)}, ` +
      `multiple_similar=${hasMultipleSimilar}, type=${resolvedType}`,
    );
  } else {
    trace.push("Resolution confidence sufficient — no user selection needed");
  }

  trace.push(
    `Resolution complete: ${entities.length} entit${entities.length === 1 ? "y" : "ies"} returned`,
  );

  return {
    input_type: resolvedType,
    normalized_input,
    entities,
    needs_user_selection,
    resolution_trace: trace,
    error: null,
  };
}
