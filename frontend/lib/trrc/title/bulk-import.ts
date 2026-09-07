/**
 * Bulk-import ingestion for user-supplied mineral-ownership files (e.g.
 * Cooper's real Martin County file). Martin County has no automated county-
 * records connector — for that county, this is the ONLY Phase 1 source of
 * title data.
 *
 * Two real, different kinds of file this module must distinguish
 * (`fileKind` on title_bulk_imports), because they support different
 * claims:
 *   - "instrument_history": one row per conveyance/instrument — can seed
 *     real title_instruments/title_instrument_parties/title_instrument_tracts
 *     rows, the same as the county-clerk-index path.
 *   - "current_owner_list": one row per owner as of some snapshot date, no
 *     instrument-level history — this can seed title_canonical_parties and
 *     title_canonical_tracts (real, useful identity data) but must NEVER be
 *     written as if it were a chain of title. There is no instrument to
 *     cite, so no title_instruments/title_claims rows get created from a
 *     pure owner-list file — only canonical-identity seed rows, explicitly
 *     tagged as such.
 * Which kind a given file is CANNOT be assumed — it is determined by
 * inspecting the file's real columns (does it have grantor/grantee/
 * instrument-date/doc-number columns, or only current-owner/interest
 * columns?) before any mapping is written. See martinCountyColumnMapping()
 * below, intentionally left unimplemented until that inspection happens.
 *
 * Scale note: a 150MB+ file must never be loaded into memory whole and must
 * never be re-inserted wholesale on a rerun. This module is written against
 * an async row STREAM (batches), not an in-memory array, specifically so a
 * real streaming CSV/XLSX reader can be plugged in without a redesign; each
 * batch is deduped against both itself and title_bulk_imports' recorded
 * progress before writing, and title_bulk_imports.source_file_hash makes a
 * rerun of the identical file idempotent (see importClaimsFromRowStream's
 * caller in a future upload route, which should check for an existing
 * completed title_bulk_imports row with the same hash before reprocessing).
 * Rows failing validation are recorded with a reason, never silently
 * dropped — an import's true coverage must always be visible.
 */

import type { InstrumentType, PartyCapacity } from "./types";

export type ParsedRow = Record<string, string | number | null | undefined>;
export type FileKind = "instrument_history" | "current_owner_list" | "unknown";

/**
 * Maps a source file's own column headers onto instrument/tract fields.
 * Every key here is a real header string from the actual file — not
 * assumed. Only meaningful for fileKind='instrument_history'; a
 * current_owner_list file uses OwnerListColumnMapping instead.
 */
export interface InstrumentColumnMapping {
  grantorNameColumn: string;
  granteeNameColumn: string;
  instrumentTypeColumn?: string;
  instrumentDateColumn?: string;
  recordedDateColumn?: string;
  countyColumn?: string;
  legalDescriptionColumn?: string;
  abstractNumberColumn?: string;
  surveyNameColumn?: string;
  blockNumberColumn?: string;
  sectionNameColumn?: string;
  grossAcresColumn?: string;
  interestTypeColumn?: string;
  interestConveyedFractionColumn?: string;
  interestReservedFractionColumn?: string;
  royaltyFractionColumn?: string;
  docNumberColumn?: string;
  bookVolumePageColumn?: string;
}

/** For a current-owner-list file — seeds canonical parties/tracts only, never fabricates instrument history. */
export interface OwnerListColumnMapping {
  ownerNameColumn: string;
  countyColumn?: string;
  legalDescriptionColumn?: string;
  abstractNumberColumn?: string;
  surveyNameColumn?: string;
  blockNumberColumn?: string;
  sectionNameColumn?: string;
  interestFractionColumn?: string;
}

/**
 * Not yet defined — the file's real column headers and fileKind are unknown
 * until it has been inspected (it was still syncing from OneDrive as of
 * this engine's build). Do not guess. Read the actual file's headers and
 * a sample of rows first, determine whether it's instrument-level history
 * or a current-owner snapshot, then replace this function with the real
 * mapping for whichever shape it turns out to be.
 */
export function martinCountyColumnMapping(): InstrumentColumnMapping | OwnerListColumnMapping {
  throw new Error(
    "martinCountyColumnMapping() is not yet defined — inspect the real Martin County file's headers and determine its fileKind before writing this mapping. See title/bulk-import.ts's header comment.",
  );
}

export interface InstrumentImportCandidate {
  grantorName: string;
  granteeName: string;
  grantorCapacity: PartyCapacity;
  granteeCapacity: PartyCapacity;
  instrumentType: InstrumentType;
  instrumentDate: string | null;
  recordedDate: string | null;
  county: string | null;
  legalDescription: string | null;
  abstractNumber: string | null;
  surveyName: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  grossAcres: number | null;
  interestType: string | null;
  interestConveyedFraction: number | null;
  interestReservedFraction: number | null;
  royaltyFraction: number | null;
  docNumber: string | null;
  bookVolumePage: string | null;
}

export interface OwnerSeedCandidate {
  ownerName: string;
  county: string | null;
  legalDescription: string | null;
  abstractNumber: string | null;
  surveyName: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  interestFraction: number | null;
}

export interface BatchImportResult {
  instrumentCandidates: InstrumentImportCandidate[];
  ownerSeedCandidates: OwnerSeedCandidate[];
  rejectedRows: { row: ParsedRow; reason: string }[];
  duplicateCount: number;
}

function cellToString(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function cellToNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,$%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Processes ONE BATCH of already-parsed rows (never the whole file) for an instrument_history-kind file. Caller is responsible for streaming the source file in batches and calling this per batch, tracking cumulative dedupe state via `seenKeys` across calls. */
export function importInstrumentBatch(
  rows: ParsedRow[],
  mapping: InstrumentColumnMapping,
  seenKeys: Set<string>,
): BatchImportResult {
  const instrumentCandidates: InstrumentImportCandidate[] = [];
  const rejectedRows: { row: ParsedRow; reason: string }[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    const grantorRaw = cellToString(row[mapping.grantorNameColumn]);
    const granteeRaw = cellToString(row[mapping.granteeNameColumn]);
    if (!grantorRaw || !granteeRaw) {
      rejectedRows.push({ row, reason: "Missing required grantor or grantee name" });
      continue;
    }

    const instrumentDate = mapping.instrumentDateColumn ? cellToString(row[mapping.instrumentDateColumn]) : null;
    const recordedDate = mapping.recordedDateColumn ? cellToString(row[mapping.recordedDateColumn]) : null;
    const docNumber = mapping.docNumberColumn ? cellToString(row[mapping.docNumberColumn]) : null;
    if (!instrumentDate && !recordedDate && !docNumber) {
      rejectedRows.push({ row, reason: "No date or instrument identifier present — cannot place this claim on a timeline" });
      continue;
    }

    const dedupeKey = [grantorRaw.toLowerCase(), granteeRaw.toLowerCase(), instrumentDate ?? "", docNumber ?? ""].join("|");
    if (seenKeys.has(dedupeKey)) { duplicateCount += 1; continue; }
    seenKeys.add(dedupeKey);

    instrumentCandidates.push({
      grantorName: grantorRaw,
      granteeName: granteeRaw,
      grantorCapacity: "unknown",
      granteeCapacity: "unknown",
      instrumentType: (mapping.instrumentTypeColumn ? cellToString(row[mapping.instrumentTypeColumn]) as InstrumentType | null : null) ?? "other",
      instrumentDate,
      recordedDate,
      county: mapping.countyColumn ? cellToString(row[mapping.countyColumn]) : null,
      legalDescription: mapping.legalDescriptionColumn ? cellToString(row[mapping.legalDescriptionColumn]) : null,
      abstractNumber: mapping.abstractNumberColumn ? cellToString(row[mapping.abstractNumberColumn]) : null,
      surveyName: mapping.surveyNameColumn ? cellToString(row[mapping.surveyNameColumn]) : null,
      blockNumber: mapping.blockNumberColumn ? cellToString(row[mapping.blockNumberColumn]) : null,
      sectionName: mapping.sectionNameColumn ? cellToString(row[mapping.sectionNameColumn]) : null,
      grossAcres: mapping.grossAcresColumn ? cellToNumber(row[mapping.grossAcresColumn]) : null,
      interestType: mapping.interestTypeColumn ? cellToString(row[mapping.interestTypeColumn]) : null,
      interestConveyedFraction: mapping.interestConveyedFractionColumn ? cellToNumber(row[mapping.interestConveyedFractionColumn]) : null,
      interestReservedFraction: mapping.interestReservedFractionColumn ? cellToNumber(row[mapping.interestReservedFractionColumn]) : null,
      royaltyFraction: mapping.royaltyFractionColumn ? cellToNumber(row[mapping.royaltyFractionColumn]) : null,
      docNumber,
      bookVolumePage: mapping.bookVolumePageColumn ? cellToString(row[mapping.bookVolumePageColumn]) : null,
    });
  }

  return { instrumentCandidates, ownerSeedCandidates: [], rejectedRows, duplicateCount };
}

/** Processes ONE BATCH of rows for a current_owner_list-kind file — produces ONLY canonical-identity seed candidates, never instrument/claim rows, since a snapshot owner list carries no instrument to cite. */
export function importOwnerListBatch(
  rows: ParsedRow[],
  mapping: OwnerListColumnMapping,
  seenKeys: Set<string>,
): BatchImportResult {
  const ownerSeedCandidates: OwnerSeedCandidate[] = [];
  const rejectedRows: { row: ParsedRow; reason: string }[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    const ownerName = cellToString(row[mapping.ownerNameColumn]);
    if (!ownerName) { rejectedRows.push({ row, reason: "Missing required owner name" }); continue; }

    const legalDescription = mapping.legalDescriptionColumn ? cellToString(row[mapping.legalDescriptionColumn]) : null;
    const dedupeKey = [ownerName.toLowerCase(), legalDescription ?? ""].join("|");
    if (seenKeys.has(dedupeKey)) { duplicateCount += 1; continue; }
    seenKeys.add(dedupeKey);

    ownerSeedCandidates.push({
      ownerName,
      county: mapping.countyColumn ? cellToString(row[mapping.countyColumn]) : null,
      legalDescription,
      abstractNumber: mapping.abstractNumberColumn ? cellToString(row[mapping.abstractNumberColumn]) : null,
      surveyName: mapping.surveyNameColumn ? cellToString(row[mapping.surveyNameColumn]) : null,
      blockNumber: mapping.blockNumberColumn ? cellToString(row[mapping.blockNumberColumn]) : null,
      sectionName: mapping.sectionNameColumn ? cellToString(row[mapping.sectionNameColumn]) : null,
      interestFraction: mapping.interestFractionColumn ? cellToNumber(row[mapping.interestFractionColumn]) : null,
    });
  }

  return { instrumentCandidates: [], ownerSeedCandidates, rejectedRows, duplicateCount };
}
