/**
 * Geological evidence store: source documents, the measurements and
 * calibrations extracted from them, and the tables reviewed but not used.
 *
 * The same record shape serves every source — a published study, a core
 * analysis, a well log — so measurements from new documents enter the same way:
 * register the document (hash, pages), extract each value with its page and
 * locator, state where it applies, and run the validator.
 */
import type { Unit } from "../../engineering/evidence";

export interface SourceDocument {
  id: string;
  title: string;
  authors: string;
  publisher: string;
  reportNumber: string | null;
  /** Publication date as printed (YYYY, YYYY-MM or YYYY-MM-DD); null when not printed. */
  published: string | null;
  fileName: string;
  /** SHA-256 of the exact PDF the values were read from. */
  sha256: string;
  pdfPages: number;
  /** True when the PDF carries a text layer that can be re-checked by machine. */
  textLayer: boolean;
  /** How the content may be used. */
  rights: string;
}

/** Where a measurement applies. A reservoir-wide calculation only uses field-, unit- or reservoir-interval-level values for that reservoir. */
export type ApplicabilityLevel = "well" | "interval" | "field" | "unit" | "regional";

export interface Applicability {
  level: ApplicabilityLevel;
  county: "GAINES";
  /** Canonical field name ("Seminole", "ODC"). */
  field?: string;
  /** Named unit ("Seminole San Andres Unit"), when the value is for a unit. */
  unit?: string;
  /** Formation, e.g. "San Andres". */
  reservoir?: string;
  /** Reservoir interval, e.g. "upper ROZ below the main pay zone". Absent = the whole field or unit (used for areas). */
  interval?: string;
  /** Well-level values: the well and depths. */
  api10?: string; wellName?: string; depthTopFt?: number; depthBaseFt?: number;
  /** Regional values: the named area (e.g. "DOE ROZ Partition #3"). */
  region?: string;
}

export interface SourceLocation {
  documentId: string;
  /** Page number as printed on the page. */
  reportPage: string;
  /** Page of the PDF file (1-based). */
  pdfPage: number;
  /** Table, exhibit, figure, equation or section. */
  locator: string;
  /** When the document is itself citing another source for the value. */
  citesFurther?: string;
}

export interface Extraction {
  method: "text_layer" | "page_image_transcription";
  /** Exact words on the cited PDF page that carry the value (text-layer documents); re-checked by scripts/verify-geology-sources.mts. */
  verifyText?: string[];
  checkedOn: string;
}

export type Quantity =
  | "area" | "net_pay" | "gross_thickness" | "porosity" | "oil_saturation" | "water_saturation"
  | "formation_volume_factor" | "original_oil_in_place"
  | "cumulative_oil" | "oil_gravity" | "depth";

export interface Measurement {
  id: string;
  quantity: Quantity;
  value: number; low?: number; high?: number; unit: Unit;
  /** How `value` relates to what is printed. */
  valueBasis: "as_printed" | "range_midpoint";
  applicability: Applicability;
  source: SourceLocation;
  /** Saturations: initial (before production) or present (when measured). */
  saturationBasis?: "initial" | "present";
  /** When the measurement was made, if stated; otherwise the publication date applies. */
  measured?: string;
  /** Production volumes: the date the cumulative is stated as of, and whether it runs from first production. */
  asOf?: string;
  coverage?: "since_first_production" | "partial";
  /** Set when a published value may only be shown as a comparison, never used as a calculation input. */
  comparisonOnly?: string;
  /** A reading of an ambiguous printed value, used only for clearly labelled engineering interpretation. */
  alternativeReading?: { value: number; unit: Unit; reason: string };
  method: string;
  limitations: string[];
  extraction: Extraction;
}

/** A field- or unit-specific method calibration (equation or parameter set) used to interpret logs or core. */
export interface Calibration {
  id: string;
  name: string;
  /** The relation as printed, with symbols defined. */
  expression: string;
  parameters: { name: string; value: number; unit: Unit | "dimensionless"; note?: string }[];
  applicability: Applicability;
  sources: SourceLocation[];
  limitations: string[];
  extraction: Extraction;
}

/** A table or figure examined and deliberately not stored as a reservoir input. */
export interface ReviewedItem {
  documentId: string;
  locator: string;
  reportPage: string;
  decision: "not_applicable" | "graphical_only" | "no_volumetric_inputs";
  reason: string;
}
