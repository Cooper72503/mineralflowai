/** Mineral Finder v1: research leads, never reserves or an acquisition approval. */
export type County = "GAINES" | "FISHER";
export type WellStatus =
  | "plugged"
  | "shut_in"
  | "producing"
  | "dry"
  | "unknown";
export interface Criteria {
  county: County;
  beforeYear: number;
  radiusMiles: number;
  limit: number;
  statuses: WellStatus[];
  marginalBopd: number | null;
}
export interface Source {
  id: string;
  provider: string;
  url: string;
  retrievedAt: string;
  status: "success" | "failed" | "not_enabled";
  count: number;
  complete: boolean;
  warnings: string[];
  sha256?: string;
}
export interface Association {
  district: string | null;
  lease: string | null;
  leaseType: string | null;
  fieldNumber: string | null;
  fieldName: string | null;
  operator: string | null;
  status: WellStatus;
  completionDate: string | null;
  plugDate: string | null;
  onSchedule: boolean;
  sourceRow: string;
  raw: string[];
}
export interface Well {
  api: string;
  county: County;
  lat: number | null;
  lng: number | null;
  locationDescription: string | null;
  status: WellStatus;
  wellNumber: string | null;
  associations: Association[];
  association: Association | null;
  identityConflict: boolean;
  sources: string[];
}
export interface CatalogItem {
  id: string;
  api: string | null;
  apiOriginal: string | null;
  county: string;
  collection: string;
  logTypes: string | null;
  material: string | null;
  formation: string | null;
  fieldName: string | null;
  leaseName: string | null;
  topFt: number | null;
  bottomFt: number | null;
  lat: number | null;
  lng: number | null;
  coordinatesUncertain: boolean;
  drillDate: string | null;
  accession: string | null;
  sourceId: string;
  url: string;
  raw: Record<string, unknown>;
}
export interface Production {
  retrievedAt: string;
  key: string;
  status: "success" | "empty" | "failed" | "not_requested";
  sourceId: string;
  rows: {
    month: string;
    oil: number | null;
    gas: number | null;
    water: number | null;
  }[];
  reason: string | null;
}
export interface Offset {
  api: string;
  distanceMiles: number;
  match: "field_reservoir_proxy";
  field: string;
  formation: string;
  productionKey: string | null;
  historicallyProductive: boolean | null;
  reason: string;
}
export interface Purchase {
  itemId: string;
  api: string | null;
  purpose: string;
  priority: number;
  estimatedUsd: number | null;
  pricingUrl: string;
  pricingCheckedAt: string | null;
  approval: "required";
  scope: string;
}
export interface Prospect {
  api: string;
  rank: number;
  score: number;
  label: "research_lead";
  well: Well;
  ageEvidence: {
    date: string;
    basis: "completion_upper_bound" | "catalog_drill_date";
    sourceId: string;
  };
  formation: string | null;
  formationBasis: string;
  offsets: Offset[];
  catalog: CatalogItem[];
  purchases: Purchase[];
  production: Production | null;
  decline: { annualPct: number; rSquared: number } | null;
  scoreExplanation: { criterion: string; points: number; evidence: string[] }[];
  gaps: string[];
  risks: string[];
  geologicalAssessment: string;
  geologicalConfidence: "low";
  economics: { status: "insufficient_data"; reason: string };
  sources: string[];
}
export interface FinderResult {
  version: "mineral-finder-v1";
  generatedAt: string;
  query: string;
  criteria: Criteria;
  sources: Source[];
  wells: number;
  eligible: number;
  excluded: Record<string, number>;
  prospects: Prospect[];
  purchases: Purchase[];
  warnings: string[];
  classification: "research_screening";
  countyCoverageComplete: boolean;
}
export interface FinderSnapshot {
  wells: Well[];
  catalog: CatalogItem[];
  sources: Source[];
}
