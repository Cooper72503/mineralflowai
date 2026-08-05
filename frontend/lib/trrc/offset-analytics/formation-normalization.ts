/**
 * Formation / landing-zone normalization and matching — the piece the
 * archived offset-intelligence-engine.ts never actually built (its
 * "formation" data was narrative-only, never a qualification filter; see
 * index.ts's Phase 0 audit notes). This is new, not a port.
 *
 * HONEST SCOPING NOTE: true landing-zone-level matching (bench, top/bottom
 * depth, TVD) requires per-well completion-report detail that isn't
 * bulk-available across many offset wells without a per-well TRRC
 * completion query each (and completionQueryAction.do has been unreliable
 * this session — see ewa.ts's own doc comments). This normalizer works
 * primarily from TRRC FIELD NAME text, the one signal reliably available
 * for both the subject well and offset wells without per-well enrichment
 * queries — the same signal basin-benchmarks.ts already uses for basin
 * classification. Field-name-level matching is coarser than true
 * landing-zone matching and the matching hierarchy below reflects that
 * honestly (field-name match caps out below a hypothetical true
 * landing-zone match, which this data source cannot support yet).
 *
 * Canonical formation aliases are built from real Texas field-name
 * variants — "SPRABERRY (TREND AREA)" and "NEWARK, EAST (BARNETT SHALE)"
 * are both real field names confirmed live this session (lease 52210
 * district 08, and lease 253905 district 09, respectively).
 */

import type { WarningEntry } from "./types";

export interface FormationProfile {
  rawFieldName: string;
  canonicalFormation: string;
  basin: string;
  stratigraphicGroup: string | null;
  confidence: number;
  source: "FIELD_NAME_MATCH" | "UNKNOWN";
}

interface FormationRule {
  canonicalFormation: string;
  basin: string;
  stratigraphicGroup: string | null;
  fieldNameKeywords: string[];
}

// Ordered most-specific first — "LOWER SPRABERRY" must be checked before
// the bare "SPRABERRY" catch-all, or every Spraberry variant would collapse
// to the same bucket the spec explicitly warns against.
const FORMATION_RULES: FormationRule[] = [
  { canonicalFormation: "WOLFCAMP A", basin: "Permian Basin", stratigraphicGroup: "Wolfcamp", fieldNameKeywords: ["WOLFCAMP A", "WOLFCAMP (A)"] },
  { canonicalFormation: "WOLFCAMP B", basin: "Permian Basin", stratigraphicGroup: "Wolfcamp", fieldNameKeywords: ["WOLFCAMP B", "WOLFCAMP (B)"] },
  { canonicalFormation: "WOLFCAMP", basin: "Permian Basin", stratigraphicGroup: "Wolfcamp", fieldNameKeywords: ["WOLFCAMP"] },
  { canonicalFormation: "LOWER SPRABERRY", basin: "Permian Basin", stratigraphicGroup: "Spraberry", fieldNameKeywords: ["LOWER SPRABERRY", "SPRABERRY (LOWER)"] },
  { canonicalFormation: "UPPER SPRABERRY", basin: "Permian Basin", stratigraphicGroup: "Spraberry", fieldNameKeywords: ["UPPER SPRABERRY", "SPRABERRY (UPPER)"] },
  { canonicalFormation: "SPRABERRY", basin: "Permian Basin", stratigraphicGroup: "Spraberry", fieldNameKeywords: ["SPRABERRY"] },
  { canonicalFormation: "BONE SPRING", basin: "Permian Basin", stratigraphicGroup: "Bone Spring", fieldNameKeywords: ["BONE SPRING", "BONE SPRG"] },
  { canonicalFormation: "AVALON", basin: "Permian Basin", stratigraphicGroup: "Bone Spring", fieldNameKeywords: ["AVALON"] },
  { canonicalFormation: "BARNETT SHALE", basin: "Fort Worth Basin", stratigraphicGroup: "Barnett", fieldNameKeywords: ["BARNETT SHALE", "BARNETT"] },
  { canonicalFormation: "EAGLE FORD", basin: "Eagle Ford", stratigraphicGroup: "Eagle Ford", fieldNameKeywords: ["EAGLE FORD", "EAGLEVILLE"] },
  { canonicalFormation: "AUSTIN CHALK", basin: "Gulf Coast", stratigraphicGroup: "Austin Chalk", fieldNameKeywords: ["AUSTIN CHALK"] },
  { canonicalFormation: "HAYNESVILLE", basin: "East Texas / Haynesville", stratigraphicGroup: "Haynesville", fieldNameKeywords: ["HAYNESVILLE"] },
  { canonicalFormation: "COTTON VALLEY", basin: "East Texas / Haynesville", stratigraphicGroup: "Cotton Valley", fieldNameKeywords: ["COTTON VALLEY"] },
  { canonicalFormation: "FRIO", basin: "Gulf Coast", stratigraphicGroup: null, fieldNameKeywords: ["FRIO"] },
  { canonicalFormation: "YEGUA", basin: "Gulf Coast", stratigraphicGroup: null, fieldNameKeywords: ["YEGUA"] },
];

/** Classifies a raw TRRC field name into a canonical formation profile. Returns an explicit UNKNOWN profile (never null) — Phase 6's filter and Phase 8's scoring both need a real value to reason about, not an absent one. */
export function normalizeFormation(rawFieldName: string): FormationProfile {
  const field = rawFieldName.toUpperCase();
  for (const rule of FORMATION_RULES) {
    if (rule.fieldNameKeywords.some(kw => field.includes(kw))) {
      return {
        rawFieldName,
        canonicalFormation: rule.canonicalFormation,
        basin: rule.basin,
        stratigraphicGroup: rule.stratigraphicGroup,
        confidence: 0.7, // field-name-level match, not a true landing-zone match — see file doc comment
        source: "FIELD_NAME_MATCH",
      };
    }
  }
  return { rawFieldName, canonicalFormation: "UNKNOWN", basin: "UNKNOWN", stratigraphicGroup: null, confidence: 0, source: "UNKNOWN" };
}

export type FormationMatchTier =
  | "EXACT_LANDING_ZONE"     // not reachable via this field-name-only data source — see file doc comment; reserved for a future per-well completion-detail enrichment
  | "SAME_FORMATION"
  | "SAME_GROUP_AND_BASIN"
  | "UNKNOWN_BUT_SIMILAR"
  | "INCOMPATIBLE";

export interface FormationMatchResult {
  tier: FormationMatchTier;
  accepted: boolean;
  explanation: string;
  warnings: WarningEntry[];
}

/**
 * Ranks an analog candidate's formation against the subject well's,
 * following the spec's explicit hierarchy. UNKNOWN_BUT_SIMILAR is only
 * ever reachable when BOTH sides are unknown (this engine has no
 * completion-design similarity signal to justify accepting an unknown
 * formation on distance/spatial grounds alone — see index.ts's Phase 0
 * notes on formation-intelligence.ts never having been a real filter) —
 * an unknown subject with a known candidate, or vice versa, is INCOMPATIBLE,
 * since there's nothing to actually compare.
 */
export function matchFormations(subject: FormationProfile, candidate: FormationProfile): FormationMatchResult {
  const warnings: WarningEntry[] = [];

  if (subject.canonicalFormation === "UNKNOWN" && candidate.canonicalFormation === "UNKNOWN") {
    warnings.push({ code: "BOTH_FORMATIONS_UNKNOWN", message: "Neither the subject nor the candidate's formation could be determined from field name — accepted only as a low-confidence, unknown-but-plausible analog", severity: "warning" });
    return { tier: "UNKNOWN_BUT_SIMILAR", accepted: true, explanation: "Both formations unknown from available field-name data", warnings };
  }
  if (subject.canonicalFormation === "UNKNOWN" || candidate.canonicalFormation === "UNKNOWN") {
    return { tier: "INCOMPATIBLE", accepted: false, explanation: "One side's formation is known and the other is not — nothing to compare, rejected rather than guessed", warnings };
  }
  if (subject.canonicalFormation === candidate.canonicalFormation) {
    return { tier: "SAME_FORMATION", accepted: true, explanation: `Both wells are in ${subject.canonicalFormation}`, warnings };
  }
  if (subject.basin === candidate.basin && subject.stratigraphicGroup !== null && subject.stratigraphicGroup === candidate.stratigraphicGroup) {
    return { tier: "SAME_GROUP_AND_BASIN", accepted: true, explanation: `Same basin (${subject.basin}) and stratigraphic group (${subject.stratigraphicGroup}), different bench (${subject.canonicalFormation} vs ${candidate.canonicalFormation})`, warnings };
  }
  return { tier: "INCOMPATIBLE", accepted: false, explanation: `${candidate.canonicalFormation} (${candidate.basin}) is not the same formation, group, or basin as the subject's ${subject.canonicalFormation} (${subject.basin})`, warnings };
}
