/**
 * The county clerk's document type, mapped to an instrument type.
 *
 * Mirrors worker/src/title-sequencer.ts#normalizeDocType (which types index
 * rows as they are stored); change both together. Clerks abbreviate:
 * Midland indexes a release of oil and gas lease as "REL OIL&GAS LS", which
 * the earlier mapping fell through to "other".
 */
export type ClerkInstrumentType =
  | "mineral_deed" | "royalty_deed" | "deed_of_trust" | "release" | "assignment" | "lease"
  | "affidavit_of_heirship" | "probate" | "lien" | "deed" | "other";

export function clerkInstrumentType(docType: string | null | undefined): ClerkInstrumentType | null {
  if (!docType?.trim()) return null;
  const t = docType.toLowerCase();
  if (/mineral deed/.test(t)) return "mineral_deed";
  if (/royalty/.test(t)) return "royalty_deed";
  if (/deed of trust/.test(t)) return "deed_of_trust";
  if (/release|\brel\b/.test(t)) return "release";
  if (/assign/.test(t)) return "assignment";
  if (/lease|\bo\s*&\s*g\s+ls\b|\bls\b/.test(t)) return "lease";
  if (/heirship/.test(t)) return "affidavit_of_heirship";
  if (/probate|\bwill\b|letters/.test(t)) return "probate";
  if (/lien|judgment/.test(t)) return "lien";
  if (/deed/.test(t)) return "deed";
  return "other";
}

/** Instrument types that transfer or create an interest in the minerals or leasehold. */
export const CONVEYANCE_TYPES = new Set(["deed", "mineral_deed", "royalty_deed", "correction_deed", "assignment", "lease"]);

export function effectForInstrumentType(type: string): string {
  switch (type) {
    case "lease": return "lease_grant";
    case "assignment": return "assignment";
    case "release": return "release";
    case "deed_of_trust": case "lien": return "encumbrance";
    case "probate": case "affidavit_of_heirship": return "succession";
    case "other": return "other";
    default: return "conveyance";
  }
}
