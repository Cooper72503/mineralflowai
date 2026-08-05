/**
 * Candidate well filtering — applies configurable qualification rules to
 * the raw well-search.ts results and produces an explicit count at every
 * stage. Never silently discards: every rejected well is accounted for in
 * FilterCounts, and the specific rejection reason is attached to it.
 *
 * Status classification and history/formation checks are structured as one
 * function operating on an "enrichable" candidate shape — status is known
 * immediately from well-search.ts's GIS symbol, while production-history
 * and formation fields are populated by later phases (production-loader.ts
 * / Phase 10, formation-normalization.ts / Phase 7) before this filter's
 * later criteria can be meaningfully applied. Calling this function with
 * those fields still null is valid and simply defers that specific check
 * (documented per-field below), rather than requiring an artificial
 * ordering where Phase 6 blocks on data Phase 7/10 haven't produced yet.
 */

import type { OffsetWellCandidate } from "./well-search";

export type CandidateWellStatus =
  | "PRODUCING"
  | "RECENTLY_ACTIVE"
  | "SHUT_IN"
  | "PLUGGED"
  | "PERMITTED_NOT_DRILLED"
  | "DRY_HOLE"
  | "INJECTION_DISPOSAL"
  | "UNKNOWN";

/** Classifies TRRC's real GIS_SYMBOL_DESCRIPTION values (confirmed live earlier this session: "Oil Well", "Gas Well", "Plugged Oil Well", "Plugged Gas Well", "Permitted Location", "Observation Well", "Canceled / Abandoned Location") into this engine's coarser status taxonomy. */
export function classifyWellStatus(gisSymbolDescription: string): CandidateWellStatus {
  const s = gisSymbolDescription.toUpperCase();
  if (/^PLUGGED/.test(s)) return "PLUGGED";
  if (/PERMITTED/.test(s)) return "PERMITTED_NOT_DRILLED";
  if (/CANCELED|ABANDONED|DRY\s*HOLE/.test(s)) return "DRY_HOLE";
  if (/INJECTION|DISPOSAL|SWD/.test(s)) return "INJECTION_DISPOSAL";
  if (/^(OIL|GAS)\s*WELL$/.test(s)) return "PRODUCING";
  if (/OBSERVATION/.test(s)) return "SHUT_IN";
  return "UNKNOWN";
}

export interface EnrichableCandidate extends OffsetWellCandidate {
  status: CandidateWellStatus;
  /** null until production-loader.ts (Phase 10) has run for this candidate — that check is skipped, not failed, while null. */
  monthsOfProductionHistory: number | null;
  /** null until formation-normalization.ts (Phase 7) has run — that check is skipped, not failed, while null. */
  formationKnown: boolean | null;
  commodity: "OIL" | "GAS" | "UNKNOWN";
}

export interface CandidateFilterOptions {
  acceptableStatuses: CandidateWellStatus[];
  minProductionMonths: number; // only enforced once monthsOfProductionHistory is populated (non-null)
  requireKnownFormation: boolean; // only enforced once formationKnown is populated (non-null)
  supportedCommodities: Array<"OIL" | "GAS">;
}

export const DEFAULT_CANDIDATE_FILTER_OPTIONS: CandidateFilterOptions = {
  acceptableStatuses: ["PRODUCING", "RECENTLY_ACTIVE"],
  minProductionMonths: 6, // matches decline-curve.ts's own fitArpsDecline minimum
  requireKnownFormation: true,
  supportedCommodities: ["OIL", "GAS"],
};

export type RejectionReason =
  | "STATUS_NOT_ACCEPTABLE"
  | "INSUFFICIENT_PRODUCTION_HISTORY"
  | "FORMATION_UNKNOWN_OR_MISMATCH"
  | "UNSUPPORTED_COMMODITY"
  | "DUPLICATE_API";

export interface FilteredCandidate {
  candidate: EnrichableCandidate;
  accepted: boolean;
  rejectionReason: RejectionReason | null;
}

export interface FilterCounts {
  spatiallyFound: number;
  removedForDuplicate: number;
  removedForStatus: number;
  removedForInsufficientHistory: number;
  removedForFormationMismatch: number;
  removedForUnsupportedCommodity: number;
  accepted: number;
}

export interface CandidateFilterResult {
  results: FilteredCandidate[];
  counts: FilterCounts;
}

export function filterCandidates(
  candidates: EnrichableCandidate[],
  options: CandidateFilterOptions = DEFAULT_CANDIDATE_FILTER_OPTIONS,
): CandidateFilterResult {
  const counts: FilterCounts = {
    spatiallyFound: candidates.length,
    removedForDuplicate: 0, removedForStatus: 0, removedForInsufficientHistory: 0,
    removedForFormationMismatch: 0, removedForUnsupportedCommodity: 0, accepted: 0,
  };

  const seenApis = new Set<string>();
  const results: FilteredCandidate[] = [];

  for (const candidate of candidates) {
    if (seenApis.has(candidate.api)) {
      counts.removedForDuplicate++;
      results.push({ candidate, accepted: false, rejectionReason: "DUPLICATE_API" });
      continue;
    }
    seenApis.add(candidate.api);

    if (!options.acceptableStatuses.includes(candidate.status)) {
      counts.removedForStatus++;
      results.push({ candidate, accepted: false, rejectionReason: "STATUS_NOT_ACCEPTABLE" });
      continue;
    }

    if (candidate.commodity !== "UNKNOWN" && !options.supportedCommodities.includes(candidate.commodity)) {
      counts.removedForUnsupportedCommodity++;
      results.push({ candidate, accepted: false, rejectionReason: "UNSUPPORTED_COMMODITY" });
      continue;
    }

    if (candidate.monthsOfProductionHistory !== null && candidate.monthsOfProductionHistory < options.minProductionMonths) {
      counts.removedForInsufficientHistory++;
      results.push({ candidate, accepted: false, rejectionReason: "INSUFFICIENT_PRODUCTION_HISTORY" });
      continue;
    }

    if (options.requireKnownFormation && candidate.formationKnown === false) {
      counts.removedForFormationMismatch++;
      results.push({ candidate, accepted: false, rejectionReason: "FORMATION_UNKNOWN_OR_MISMATCH" });
      continue;
    }

    counts.accepted++;
    results.push({ candidate, accepted: true, rejectionReason: null });
  }

  return { results, counts };
}
