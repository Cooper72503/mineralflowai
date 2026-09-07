/**
 * Canonical identity — proposes CanonicalTract and CanonicalParty groupings
 * over raw title_instrument_tracts / title_instrument_parties rows. Each
 * proposal carries confidence + resolution_method + resolution_trace +
 * needs_user_selection, matching entity-resolver.ts's output contract — but
 * these proposals get PERSISTED (title_canonical_tracts/
 * title_canonical_parties, matchStatus starting at 'proposed'), not just
 * returned as an in-memory grouping for one report render. A confirmed/
 * rejected match_status is what Phase 2's ledger will actually build on.
 *
 * Tract matching: deterministic, strongest-signal-first — exact legal
 * description first, then county+abstract+survey+block+section. Party
 * matching stays intentionally simple in Phase 1 — case/whitespace/suffix
 * normalization and exact/near-exact matching only, no fuzzy/ML-grade
 * entity resolution yet. Spatial-intersection tract matching is deferred —
 * it needs geocoded legal descriptions, not justified until this flat
 * ingestion is proven against real data.
 */

import { randomUUID } from "crypto";
import type { TitleInstrumentTract, TitleInstrumentParty, CanonicalTract, CanonicalParty, AssetMatchingResult, TitleWarning } from "./types";

/** Normalizes a party name for exact/near-exact comparison only — not a fuzzy matcher. */
export function normalizeOwnerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(et al|et ux|et vir|trustee|trust|llc|inc|lp|ltd)\b/g, "")
    .trim();
}

function legalDescriptionKey(tract: TitleInstrumentTract): string | null {
  if (tract.legalDescription) return `legal:${tract.legalDescription.trim().toLowerCase()}`;
  const parts = [tract.county, tract.abstractNumber, tract.surveyName, tract.blockNumber, tract.sectionName].filter(Boolean);
  if (parts.length >= 2) return `components:${parts.map(p => String(p).trim().toLowerCase()).join("|")}`;
  return null;
}

export function matchTracts(instrumentTracts: TitleInstrumentTract[]): { tracts: CanonicalTract[]; tractIdByInstrumentTractId: Record<string, string>; unmatched: string[] } {
  const groups = new Map<string, TitleInstrumentTract[]>();
  const unmatched: string[] = [];

  for (const t of instrumentTracts) {
    const key = legalDescriptionKey(t);
    if (!key) { unmatched.push(t.id); continue; }
    const existing = groups.get(key);
    if (existing) existing.push(t); else groups.set(key, [t]);
  }

  const tracts: CanonicalTract[] = [];
  const tractIdByInstrumentTractId: Record<string, string> = {};

  for (const [key, members] of Array.from(groups)) {
    const isExactLegal = key.startsWith("legal:");
    const resolutionMethod = isExactLegal ? "exact_legal_description_match" : "county_abstract_survey_block_section_match";
    const confidence = isExactLegal ? 0.9 : 0.65;
    const representative = members[0];
    const id = randomUUID();

    tracts.push({
      id,
      county: representative.county,
      abstractNumber: representative.abstractNumber,
      surveyName: representative.surveyName,
      blockNumber: representative.blockNumber,
      sectionName: representative.sectionName,
      legalDescription: representative.legalDescription,
      confidence,
      resolutionMethod,
      resolutionTrace: [
        `Grouped ${members.length} instrument-tract row(s) via ${resolutionMethod}`,
        isExactLegal ? "Exact legal-description string match — strongest available signal in Phase 1" : "Matched on 2+ of county/abstract/survey/block/section — no exact legal description available",
      ],
      needsUserSelection: !isExactLegal && members.length > 3,
      matchStatus: "proposed",
    });
    for (const m of members) tractIdByInstrumentTractId[m.id] = id;
  }

  return { tracts, tractIdByInstrumentTractId, unmatched };
}

export function matchParties(instrumentParties: TitleInstrumentParty[]): { parties: CanonicalParty[]; partyIdByInstrumentPartyId: Record<string, string> } {
  const groups = new Map<string, TitleInstrumentParty[]>();
  for (const p of instrumentParties) {
    const key = normalizeOwnerName(p.partyName);
    const existing = groups.get(key);
    if (existing) existing.push(p); else groups.set(key, [p]);
  }

  const parties: CanonicalParty[] = [];
  const partyIdByInstrumentPartyId: Record<string, string> = {};

  for (const [normalized, members] of Array.from(groups)) {
    const id = randomUUID();
    parties.push({
      id,
      displayName: members[0].partyName,
      normalizedName: normalized,
      confidence: members.length > 1 ? 0.8 : 0.6, // a name that recurs across instruments is somewhat more likely to be a real recurring party than a one-off appearance, but this is a normalized-string match only — not verified identity
      resolutionMethod: "normalized_exact_name_match",
      resolutionTrace: [`Grouped ${members.length} instrument-party row(s) by normalized name "${normalized}"`],
      needsUserSelection: false, // exact-normalized-match groups don't need a human pass in Phase 1; ambiguity would come from a fuzzier matcher this phase doesn't implement
      matchStatus: "proposed",
    });
    for (const m of members) partyIdByInstrumentPartyId[m.id] = id;
  }

  return { parties, partyIdByInstrumentPartyId };
}

export function matchTitleIdentities(instrumentTracts: TitleInstrumentTract[], instrumentParties: TitleInstrumentParty[]): AssetMatchingResult {
  const warnings: TitleWarning[] = [];
  const tractResult = matchTracts(instrumentTracts);
  const partyResult = matchParties(instrumentParties);

  if (tractResult.unmatched.length > 0) {
    warnings.push({
      code: "TRACTS_WITHOUT_MATCH_SIGNAL",
      message: `${tractResult.unmatched.length} instrument-tract row(s) had no legal description and fewer than two of county/abstract/survey/block/section — not enough signal to assign a canonical tract`,
      severity: "warning",
    });
  }

  return {
    tracts: tractResult.tracts,
    parties: partyResult.parties,
    tractIdByInstrumentTractId: tractResult.tractIdByInstrumentTractId,
    partyIdByInstrumentPartyId: partyResult.partyIdByInstrumentPartyId,
    warnings,
  };
}
