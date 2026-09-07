/**
 * Subject tract resolution for the Title Resolution engine.
 *
 * Deliberately does NOT re-resolve well/lease/operator identity — the
 * existing TRRC due-diligence run already did that (trrc_due_diligence_runs.
 * resolved_primary_api etc., migration 019). This module's only job is
 * assembling the subject TRACT context (county + legal description
 * components) that retrieval.ts and asset-matching.ts need — reusing
 * geology/context.ts's ResolvedRunIdentity shape rather than defining a
 * third copy of the same run-identity fields.
 *
 * There is no resolved legal-description column on trrc_due_diligence_runs
 * today (confirmed against migration 019) — county/legal-description
 * components come from `extras`, the same pattern geology/context.ts already
 * uses for county/formation fields the base run doesn't store.
 */

import type { ResolvedRunIdentity } from "../geology/context";
export type { ResolvedRunIdentity };

export interface TitleSubjectContext {
  apiNumber: string | null;
  leaseNumber: string | null;
  operatorName: string | null;
  county: string | null;
  legalDescription: string | null;
  abstractNumber: string | null;
  surveyName: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  retrievedAt: string;
}

export interface TitleSubjectExtras {
  county?: string | null;
  legalDescription?: string | null;
  abstractNumber?: string | null;
  surveyName?: string | null;
  blockNumber?: string | null;
  sectionName?: string | null;
}

export function resolveTitleSubjectContext(run: ResolvedRunIdentity, extras?: TitleSubjectExtras): TitleSubjectContext {
  return {
    apiNumber: run.resolved_primary_api ?? null,
    leaseNumber: run.resolved_lease_number ?? null,
    operatorName: run.resolved_operator_name ?? null,
    county: extras?.county ?? null,
    legalDescription: extras?.legalDescription ?? null,
    abstractNumber: extras?.abstractNumber ?? null,
    surveyName: extras?.surveyName ?? null,
    blockNumber: extras?.blockNumber ?? null,
    sectionName: extras?.sectionName ?? null,
    retrievedAt: new Date().toISOString(),
  };
}
