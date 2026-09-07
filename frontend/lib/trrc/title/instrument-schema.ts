/**
 * Validated extraction schema for a reviewed document.
 *
 * Both extractors (the deterministic parser and the Claude extractor)
 * produce this exact shape and it is validated with zod before anything
 * touches the database. Unknown values are null — never guessed. Where a
 * clause supports two readings the extractor records both under
 * `alternatives` instead of picking one. Verbatim text is preserved next
 * to every normalized field so a reviewer can check the interpretation
 * against the source language.
 *
 * The same zod schema is handed to the Claude structured-output call
 * (zodOutputFormat), so the model cannot return a shape this file does
 * not accept.
 */

import { z } from "zod";

const nullableStr = z.string().nullable();
const nullableNum = z.number().nullable();
const nullableInt = z.number().int().nullable();

export const ExtractedDateSchema = z.object({
  iso: nullableStr.describe("YYYY-MM-DD when the full date is legible; YYYY-MM or YYYY when only partially legible; null when absent"),
  verbatim: nullableStr,
});

export const ExtractedFractionSchema = z.object({
  numerator: nullableInt,
  denominator: nullableInt,
  verbatim: nullableStr,
  basis: z.enum(["of_entire_estate", "of_grantor_interest", "unknown"]),
});

export const ExtractedPartySchema = z.object({
  name: z.string().min(1),
  nameVerbatim: nullableStr,
  role: z.enum([
    "grantor", "grantee", "lessor", "lessee", "assignor", "assignee", "releasor", "releasee",
    "decedent", "heir", "devisee", "executor", "borrower", "lender", "trustee", "other",
  ]),
  capacity: z.enum([
    "individual", "trustee", "spouse", "entity", "executor_administrator", "heir_devisee",
    "attorney_in_fact", "successor", "unknown",
  ]),
  capacityDetail: nullableStr,
  page: nullableInt,
  excerpt: nullableStr,
});

export const ExtractedTractSchema = z.object({
  legalDescriptionVerbatim: nullableStr,
  county: nullableStr,
  abstractNumber: nullableStr,
  surveyName: nullableStr,
  blockNumber: nullableStr,
  sectionName: nullableStr,
  tractLabel: nullableStr,
  grossAcres: nullableNum,
  interestType: z.enum([
    "surface", "mineral", "royalty", "nonparticipating_royalty", "executive", "leasehold",
    "working_interest", "overriding_royalty", "unknown",
  ]),
  effect: z.enum(["conveyance", "reservation", "lease_grant", "assignment", "release", "encumbrance", "succession", "other"]),
  fraction: ExtractedFractionSchema.nullable(),
  reservationText: nullableStr,
  exceptionsText: nullableStr,
  depthOrFormationLimit: nullableStr,
  page: nullableInt,
  excerpt: nullableStr,
});

export const ExtractedReferenceSchema = z.object({
  description: z.string(),
  instrumentNumber: nullableStr,
  bookVolumePage: nullableStr,
  county: nullableStr,
  relation: z.enum(["predecessor", "prior_lease", "released_obligation", "corrected_instrument", "other"]),
  page: nullableInt,
});

export const SignatureObservationSchema = z.object({
  party: z.string(),
  observed: z.enum(["signed", "not_signed", "unclear"]),
  note: nullableStr,
  page: nullableInt,
});

export const AcknowledgmentObservationSchema = z.object({
  party: z.string(),
  notaryPresent: z.boolean().nullable(),
  date: nullableStr,
  note: nullableStr,
  page: nullableInt,
});

export const AlternativeSchema = z.object({
  field: z.string(),
  interpretations: z.array(z.string()).min(2),
  reason: z.string(),
});

export const ExtractedInstrumentSchema = z.object({
  instrumentType: z.enum([
    "deed", "mineral_deed", "royalty_deed", "lease", "assignment", "reservation", "probate",
    "affidavit_of_heirship", "release", "deed_of_trust", "lien", "correction_deed", "unit_agreement", "other",
  ]),
  instrumentTypeVerbatim: nullableStr,
  executionDate: ExtractedDateSchema,
  effectiveDate: ExtractedDateSchema,
  recordingDate: ExtractedDateSchema,
  county: nullableStr,
  instrumentNumber: nullableStr,
  bookVolumePage: nullableStr,
  parties: z.array(ExtractedPartySchema),
  tracts: z.array(ExtractedTractSchema),
  references: z.array(ExtractedReferenceSchema),
  signatureObservations: z.array(SignatureObservationSchema),
  acknowledgmentObservations: z.array(AcknowledgmentObservationSchema),
  alternatives: z.array(AlternativeSchema),
  confidence: z.number().min(0).max(1),
  verbatimExcerpts: z.array(z.object({ label: z.string(), page: nullableInt, text: z.string() })),
});

export const ExtractedDocumentSchema = z.object({
  documentKind: z.enum(["instrument", "w1_application", "location_plat", "completion_report", "lease_schedule", "index_listing", "other"]),
  instruments: z.array(ExtractedInstrumentSchema),
  /** Legal descriptions found in NON-instrument documents (a W-1, a plat) — candidate tract references, not conveyances. */
  legalDescriptions: z.array(ExtractedTractSchema),
  notes: z.array(z.string()),
});

export type ExtractedDate = z.infer<typeof ExtractedDateSchema>;
export type ExtractedFraction = z.infer<typeof ExtractedFractionSchema>;
export type ExtractedParty = z.infer<typeof ExtractedPartySchema>;
export type ExtractedTract = z.infer<typeof ExtractedTractSchema>;
export type ExtractedReference = z.infer<typeof ExtractedReferenceSchema>;
export type ExtractedInstrument = z.infer<typeof ExtractedInstrumentSchema>;
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

export function validateExtractedDocument(value: unknown): { ok: true; data: ExtractedDocument } | { ok: false; error: string } {
  const result = ExtractedDocumentSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

export function emptyExtractedDocument(kind: ExtractedDocument["documentKind"] = "other"): ExtractedDocument {
  return { documentKind: kind, instruments: [], legalDescriptions: [], notes: [] };
}
