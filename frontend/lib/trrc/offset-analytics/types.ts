/**
 * Shared schemas for the Offset Analytics Engine. Built up incrementally as
 * each phase needs new shapes — see index.ts for the phase-by-phase module
 * layout. This file holds data shapes only; validation/parsing logic lives
 * in the phase-specific modules (legal-description.ts, geocoding.ts, etc.).
 */

// ─── Phase 2 — Legal description ────────────────────────────────────────────

/**
 * Aliquot subdivision, structured rather than stored as raw text — "S/2
 * NW/4" is [{type:"half",value:"S"}, {type:"quarter",value:"NW"}], read
 * outer-to-inner (largest subdivision first). "SE/4 SE/4" is
 * [{quarter,SE},{quarter,SE}]. A bare government lot has an empty parts
 * array and a non-null governmentLot.
 */
export type AliquotQuarter = "NE" | "NW" | "SE" | "SW";
export type AliquotHalf = "N" | "S" | "E" | "W";
export interface AliquotNode {
  kind: "quarter" | "half";
  value: AliquotQuarter | AliquotHalf;
}
export interface AliquotDescription {
  parts: AliquotNode[];
  governmentLot: number | null;
  raw: string;
}

export interface TexasLegalDescription {
  jurisdiction: "TX_LAND_GRID";
  county: string;
  /** Raw as extracted from source text — "A-123", "A123", "Abstract 123", whatever form appeared. */
  abstractNumber: string | null;
  /** Normalized to a canonical "A-NNN" form by legal-description.ts — do not hand-construct this. */
  canonicalAbstractNumber: string | null;
  surveyName: string | null;
  originalGrantee: string | null;
  block: string | null;
  section: string | null;
  subdivision: string | null;
  tractNumber: string | null;
  grossAcres: number | null;
  metesAndBounds: string | null;
  sourceDocumentId: string | null;
  sourcePage: number | null;
  extractionConfidence: number; // 0-1
  humanVerified: boolean;
}

export interface PlssLegalDescription {
  jurisdiction: "PLSS";
  state: string; // 2-letter USPS code
  principalMeridian: string;
  townshipNumber: number;
  townshipDirection: "N" | "S";
  rangeNumber: number;
  rangeDirection: "E" | "W";
  section: number; // 1-36
  aliquot: AliquotDescription | null;
  county: string | null;
  sourceDocumentId: string | null;
  sourcePage: number | null;
  extractionConfidence: number;
  humanVerified: boolean;
}

/**
 * Retained when the input couldn't be parsed into either structured form —
 * NOT silently discarded. Carries what the parser tried and where it gave
 * up, so a human reviewer (or a later, better parser) has something to
 * work from instead of just "parsing failed."
 */
export interface UnparsedLegalDescription {
  jurisdiction: "UNPARSED";
  rawText: string;
  normalizedText: string;
  parserWarnings: string[];
  unresolvedComponents: string[];
  parserConfidence: number; // always low/zero by construction — this IS the failure path
}

export type LegalDescription = TexasLegalDescription | PlssLegalDescription | UnparsedLegalDescription;

// ─── Shared: provenance, warnings, confidence classification ───────────────

export interface ProvenanceEntry {
  step: string;
  source: string;
  sourceUrlOrQueryId: string | null;
  retrievedAt: string; // ISO timestamp
  detail: string;
}

export interface WarningEntry {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export type ConfidenceClassification = "HIGH" | "MODERATE" | "LOW" | "INSUFFICIENT_DATA";

// ─── Phase 3 — Geocoding ─────────────────────────────────────────────────────

/**
 * How precisely the geometry represents the actual subject tract — never
 * conflate CENTROID_ONLY with an exact polygon. See index.ts's provider
 * priority notes for when each is produced.
 */
export type GeocodeMatchMethod =
  | "EXACT_PARCEL"
  | "EXACT_SURVEY"
  | "ABSTRACT_MATCH"
  | "SECTION_MATCH"
  | "ALIQUOT_DERIVED"
  | "CENTROID_ONLY"
  | "MANUAL_REVIEW_REQUIRED"
  | "UNMAPPABLE";

export type GeoJsonGeometryType = "Point" | "Polygon" | "MultiPolygon";

export interface GeoJsonGeometry {
  type: GeoJsonGeometryType;
  /** Point: [lng,lat]. Polygon: rings. MultiPolygon: array of ring-sets. Always [lng,lat] order (GeoJSON convention), always WGS84. */
  coordinates: number[] | number[][] | number[][][] | number[][][][];
}

export interface GeocodeResult {
  canonicalIdentifier: string | null;
  centroidLatitude: number | null;
  centroidLongitude: number | null;
  geometry: GeoJsonGeometry | null;
  geometryType: GeoJsonGeometryType | null;
  sourceProvider: string;
  sourceRecordId: string | null;
  sourceUrlOrQueryId: string | null;
  spatialReferenceSystem: "EPSG:4326";
  retrievedAt: string; // ISO timestamp
  matchMethod: GeocodeMatchMethod;
  confidence: number; // 0-1
  warnings: WarningEntry[];
}

export interface LegalDescriptionGeocoder {
  geocode(legalDescription: LegalDescription): Promise<GeocodeResult>;
}

// ─── Phase 17 — Output payload ──────────────────────────────────────────────

export type ValidationStatus = "VALID" | "PARTIAL" | "INVALID";

export interface OffsetAnalyticsSubjectAsset {
  legalDescription: LegalDescription;
  grossAcres: number | null;
  netMineralAcres: number | null;
  ownershipType: "ROYALTY_INTEREST" | "WORKING_INTEREST" | "UNKNOWN";
}

export interface OffsetAnalyticsSearchSummary {
  radiusMiles: number;
  distanceMode: "CENTROID_TO_WELL" | "TRACT_BOUNDARY_TO_WELL";
  candidatesFound: number;
  qualifiedAnalogs: number;
  removedForStatus: number;
  removedForInsufficientHistory: number;
  removedForFormationMismatch: number;
  removedForDuplicate: number;
}

export interface OffsetAnalyticsAnalogSummary {
  api: string;
  operator: string | null;
  distanceMiles: number;
  canonicalFormation: string;
  landingZone: string | null;
  analogScore: number;
  declineFit: { qiOilBblPerMonth: number; diNominalMonthly: number; bFactor: number; rSquared: number } | null;
}

export interface OffsetAnalyticsCompositeProfile {
  method: "MEDIAN_PARAMETER_AGGREGATION" | "NORMALIZED_TYPE_CURVE_P50";
  analogCount: number;
  oil: { qiBblPerMonth: number | null; diNominalMonthly: number | null; bFactor: number | null; technicalEurBbl: number | null };
}

export interface OffsetAnalyticsDevelopmentCaseSummary {
  caseType: "SINGLE_WELL_PROXY" | "MULTI_WELL_CONFIGURED";
  wellCount: number;
  probabilityOfDevelopment: number;
}

export interface OffsetAnalyticsEconomicsSummary {
  valuationType: string; // e.g. "ROYALTY_OWNER_PROXY_PV10" or "GROSS_TRACT_PROXY_PV10" — mirrors ownership.resultType
  unriskedPv10: number;
  riskedPv10: number;
  currency: "USD";
  annualDiscountRate: 0.10;
}

export interface OffsetAnalyticsPayload {
  schemaVersion: "1.0.0";
  analysisId: string;
  subjectAsset: OffsetAnalyticsSubjectAsset;
  geocode: GeocodeResult;
  search: OffsetAnalyticsSearchSummary;
  analogWells: OffsetAnalyticsAnalogSummary[];
  compositeProfile: OffsetAnalyticsCompositeProfile | null;
  developmentCase: OffsetAnalyticsDevelopmentCaseSummary;
  economics: OffsetAnalyticsEconomicsSummary | null;
  confidence: import("./confidence").ConfidenceResult;
  provenance: ProvenanceEntry[];
  warnings: WarningEntry[];
  validationStatus: ValidationStatus;
  durationMs: number;
}
