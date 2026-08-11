/**
 * Evidence ledger — builds the provenance record for every material fact
 * this engine cites. This is the one place classification ("observed" /
 * "calculated" / "inferred") gets assigned; every other module hands this
 * function raw facts and gets back a typed, timestamped, sourced entry —
 * never the other way around, so nothing downstream can accidentally
 * relabel an inference as a measured fact.
 */

import { randomUUID } from "crypto";
import type { EvidenceEntry, StatementClassification } from "./types";

export interface RecordEvidenceInput {
  fieldName: string;
  classification: StatementClassification;
  source: string;
  sourceUrlOrDocId?: string | null;
  retrievedAt?: string;
  rawValue?: string | null;
  normalizedValue?: string | null;
  confidence?: number | null;
  transformationMethod?: string | null;
}

export function recordEvidence(input: RecordEvidenceInput): EvidenceEntry {
  return {
    id: randomUUID(),
    fieldName: input.fieldName,
    classification: input.classification,
    source: input.source,
    sourceUrlOrDocId: input.sourceUrlOrDocId ?? null,
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    rawValue: input.rawValue ?? null,
    normalizedValue: input.normalizedValue ?? null,
    confidence: input.confidence ?? null,
    transformationMethod: input.transformationMethod ?? null,
  };
}

/** Calculated values must preserve the inputs and formula used — this is the one helper that enforces a non-empty transformationMethod for classification="calculated", since a calculated value with no stated formula is exactly the "hidden math" the spec prohibits. */
export function recordCalculatedEvidence(input: Omit<RecordEvidenceInput, "classification"> & { transformationMethod: string }): EvidenceEntry {
  if (!input.transformationMethod.trim()) {
    throw new Error(`recordCalculatedEvidence: transformationMethod is required and was empty for field "${input.fieldName}"`);
  }
  return recordEvidence({ ...input, classification: "calculated" });
}
