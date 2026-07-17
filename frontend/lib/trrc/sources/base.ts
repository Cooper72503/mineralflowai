import type { RecordCategory, RecordStatus, TrrcRecord, SourceResult } from '../types';

export interface WellInput {
  api10: string;        // 10-digit, no dashes: "4216502733"
  apiPrefix: string;    // county digits: "165"
  apiSuffix: string;    // well digits: "02733"
  district: string | null;
  leaseNumber: string | null;
  operatorNumber: string | null;
  operatorName: string | null;
  runId?: string;
}

export interface SourceAdapter {
  /** Unique machine-readable ID */
  readonly id: string;
  /** Human label shown in UI */
  readonly name: string;
  readonly category: RecordCategory;
  /** Which source system this queries */
  readonly sourceSystem: string;
  /**
   * Retrieve records for this well.
   * Each adapter is responsible for:
   *   1. Querying its TRRC endpoint
   *   2. Parsing the response
   *   3. Attempting to fetch/store documents when a stable URL exists
   *   4. Returning TrrcRecord[] with correct retrievalMethod
   *
   * Never throws — return status:'failed' on error.
   */
  retrieve(input: WellInput): Promise<SourceResult>;
}

/** Build a WellInput from a normalized API number */
export function buildWellInput(api10: string, extra?: {
  district?: string | null;
  leaseNumber?: string | null;
  operatorNumber?: string | null;
  operatorName?: string | null;
  runId?: string;
}): WellInput {
  const digits = api10.replace(/\D/g, '');
  return {
    api10: digits.slice(0, 10),
    apiPrefix: digits.slice(2, 5),
    apiSuffix: digits.slice(5, 10),
    district: extra?.district ?? null,
    leaseNumber: extra?.leaseNumber ?? null,
    operatorNumber: extra?.operatorNumber ?? null,
    operatorName: extra?.operatorName ?? null,
    runId: extra?.runId,
  };
}

/** Construct a base TrrcRecord — fill in the fields specific to this record */
export function makeRecord(
  runId: string,
  adapter: SourceAdapter,
  input: WellInput,
  overrides: Partial<TrrcRecord>,
): TrrcRecord {
  return {
    id: crypto.randomUUID(),
    runId,
    documentName: adapter.name,
    category: adapter.category,
    recordType: adapter.name,
    filingDate: null,
    retrievedAt: new Date().toISOString(),
    sourceSystem: adapter.sourceSystem,
    sourceUrl: '',
    retrievalMethod: 'link_only',
    downloadUrl: null,
    storagePath: null,
    fileType: null,
    fileSize: null,
    sha256: null,
    apiNumber: input.api10,
    leaseNumber: input.leaseNumber,
    operatorNumber: input.operatorNumber,
    district: input.district,
    structuredData: {},
    manualRetrievalUrl: null,
    manualRetrievalNote: null,
    ...overrides,
  };
}

export function makeResult(
  adapter: SourceAdapter,
  status: RecordStatus,
  records: TrrcRecord[],
  startedAt: Date,
  error?: string,
): SourceResult {
  return {
    sourceId: adapter.id,
    sourceName: adapter.name,
    status,
    records,
    error: error ?? null,
    queriedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
}
