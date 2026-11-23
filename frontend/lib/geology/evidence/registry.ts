/**
 * Registered source documents and the values extracted from them, page by page.
 *
 * Extraction record (2026-11-23): the DOE report has a text layer, and each of
 * its values carries the exact words on the cited PDF page (re-checked by
 * scripts/verify-geology-sources.mts). The Lucia (1995) and Kerans (1992) reports
 * are scanned images without a text layer; their values were transcribed from the
 * page images at the cited PDF pages. Values shown only in graphs were not
 * digitized (see REVIEWED). BEG reports are copyrighted: facts and equations are
 * cited, text and figures are not reproduced.
 */
import type { Calibration, Measurement, ReviewedItem, SourceDocument } from "./types";

export const EVIDENCE_VERSION = "gaines-evidence-2026-11-23";

const BEG_RIGHTS = "Copyright Bureau of Economic Geology, The University of Texas at Austin. Facts and equations are cited with page references; text and figures are not reproduced.";

export const DOCUMENTS: readonly SourceDocument[] = [
  { id: "doe-netl-2020-2627", title: "A Four-County Appraisal of the San Andres Residual Oil Zone (ROZ) “Fairway” of the Permian Basin",
    authors: "V. A. Kuuskraa, R. Petrusak and M. Wallace (Advanced Resources International)", publisher: "U.S. DOE National Energy Technology Laboratory",
    reportNumber: "DOE/NETL-2020/2627", published: "2020-09-01", fileName: "AFourCountyAppraisaloftheSanAndresResidualOilZoneFairwayofthePermianBasin_090120.pdf",
    sha256: "54f0c225442083431843286f1e2daa4ef977b7d03e6b0364fdf1a660c989fa7c", pdfPages: 129, textLayer: true,
    rights: "U.S. Government-sponsored report. Its opening map (Exhibit ES-1) is AAPG material that needs AAPG permission to reuse; it is not reproduced." },
  { id: "beg-1995-lucia-seminole", title: "Rock-Fabric Approach to Reservoir Characterization: Seminole San Andres Unit, Gaines County, Texas",
    authors: "F. Jerry Lucia, Fred P. Wang and Charles Kerans", publisher: "Bureau of Economic Geology, The University of Texas at Austin — Reservoir Characterization Research Laboratory technical report",
    reportNumber: null, published: "1995-10", fileName: "CR1995-Lucia-1.pdf",
    sha256: "f01e8af016dbea7b9744a4cd322ae55dfc99d484b32a77e9cfa321132d99d086", pdfPages: 44, textLayer: false, rights: BEG_RIGHTS },
  { id: "beg-1992-kerans-outcrop", title: "Characterization of Facies and Permeability Patterns in Carbonate Reservoirs Based on Outcrop Analogs",
    authors: "Charles Kerans, F. J. Lucia, R. K. Senger, G. E. Fogg, H. S. Nance and S. D. Hovorka", publisher: "Bureau of Economic Geology, The University of Texas at Austin, for the U.S. DOE (Contract DE-AC22-89BC14470)",
    reportNumber: null, published: "1992-03", fileName: "CR1992-Kerans-1.pdf",
    sha256: "ba48e336980c8b104fc81ae7749d36c25a1a00e7f7d577c9d86d784684f323c9", pdfPages: 169, textLayer: false, rights: BEG_RIGHTS },
  { id: "beg-ri-116", title: "Genesis and Emplacement of Oil in the San Andres Formation, Northern Shelf of the Midland Basin, Texas",
    authors: "Paul J. Ramondetta", publisher: "Bureau of Economic Geology, The University of Texas at Austin (Report of Investigations No. 116)",
    reportNumber: "RI 116", published: "1982", fileName: "BEG-RI0116D.pdf",
    sha256: "e7b853e5ec909c71d8196c357bff648b3b63958040e8a580ddac0f5327fbf856", pdfPages: 45, textLayer: true, rights: BEG_RIGHTS },
  { id: "beg-ri-128", title: "Facies and Stratigraphy of the San Andres Formation, Northern and Northwestern Shelves of the Midland Basin, Texas and New Mexico",
    authors: "Paul J. Ramondetta", publisher: "Bureau of Economic Geology, The University of Texas at Austin (Report of Investigations No. 128)",
    reportNumber: "RI 128", published: null, fileName: "BEG-RI0128D.pdf",
    sha256: "b79bb60258a4560e8240e92ff7461fb2237d39b6c38a00789f83f06677bf7a78", pdfPages: 61, textLayer: true, rights: BEG_RIGHTS },
];

const DOE = "doe-netl-2020-2627", LUCIA = "beg-1995-lucia-seminole", KERANS = "beg-1992-kerans-outcrop";
const ROZ_INTERVAL = "upper ROZ below the main pay zone";
const SEMINOLE_ROZ_SOURCE = { documentId: DOE, reportPage: "16", pdfPage: 32, locator: "Exhibit 1-10 (Seminole Oil Field ROZ column)", citesFurther: "the appraisal's references 8 and 13" };
const SEMINOLE_ROZ_LIMIT = "The appraisal cites these values from its references 8 and 13 and presents them as the Seminole field's ROZ; the wells, dates and method behind them are not stated in this document.";

export const MEASUREMENTS: readonly Measurement[] = [
  // ── Field areas (DOE, section 2.2, printed page 29) ─────────────────────────
  { id: "doe-seminole-field-area", quantity: "area", value: 23_700, unit: "acres", valueBasis: "as_printed",
    applicability: { level: "field", county: "GAINES", field: "Seminole", reservoir: "San Andres" },
    source: { documentId: DOE, reportPage: "29", pdfPage: 45, locator: "Section 2.2, Partition #3" },
    method: "Area of the Seminole oil field's structural closure, excluded by the appraisal from its ROZ fairway assessment.",
    limitations: ["A field area. The registered sources do not map the areal extent of individual intervals (main pay or ROZ) inside it.", "Excludes the Seminole field extensions (13,200 acres), which the appraisal lists separately."],
    extraction: { method: "text_layer", verifyText: ["The Seminole oil field (23,700 acres)"], checkedOn: "2026-11-23" } },
  { id: "doe-odc-field-area", quantity: "area", value: 2_800, unit: "acres", valueBasis: "as_printed",
    applicability: { level: "field", county: "GAINES", field: "ODC", reservoir: "San Andres" },
    source: { documentId: DOE, reportPage: "29", pdfPage: 45, locator: "Section 2.2, Partition #2" },
    method: "Area of the ODC oil field excluded by the appraisal from its ROZ fairway assessment.",
    limitations: ["A field area. The registered sources do not map the areal extent of individual intervals inside it."],
    extraction: { method: "text_layer", verifyText: ["ODC (2,800 acres)"], checkedOn: "2026-11-23" } },

  // ── Seminole field, upper ROZ below the main pay zone (DOE Exhibit 1-10, printed page 16) ──
  { id: "doe-seminole-roz-gross", quantity: "gross_thickness", value: 246, unit: "ft", valueBasis: "as_printed",
    applicability: { level: "field", county: "GAINES", field: "Seminole", reservoir: "San Andres", interval: ROZ_INTERVAL },
    source: SEMINOLE_ROZ_SOURCE, method: "Gross pay of the upper ROZ.", limitations: [SEMINOLE_ROZ_LIMIT],
    extraction: { method: "text_layer", verifyText: ["Seminole Oil Field ROZ [8, 13]", "Gross Pay (ft) 246"], checkedOn: "2026-11-23" } },
  { id: "doe-seminole-roz-net-pay", quantity: "net_pay", value: 197, unit: "ft", valueBasis: "as_printed",
    applicability: { level: "field", county: "GAINES", field: "Seminole", reservoir: "San Andres", interval: ROZ_INTERVAL },
    source: SEMINOLE_ROZ_SOURCE, method: "Net pay of the upper ROZ.", limitations: [SEMINOLE_ROZ_LIMIT, "The net-pay cutoffs behind this value are not stated in this document."],
    extraction: { method: "text_layer", verifyText: ["Net Pay (ft) 197"], checkedOn: "2026-11-23" } },
  { id: "doe-seminole-roz-porosity", quantity: "porosity", value: 14, low: 13, high: 15, unit: "percent", valueBasis: "range_midpoint",
    applicability: { level: "field", county: "GAINES", field: "Seminole", reservoir: "San Andres", interval: ROZ_INTERVAL },
    source: SEMINOLE_ROZ_SOURCE, method: "Porosity of the upper ROZ, printed as a range.", limitations: [SEMINOLE_ROZ_LIMIT, "Printed as 13% to 15% with no central value; 14% is the midpoint of that range."],
    extraction: { method: "text_layer", verifyText: ["13% to 15%"], checkedOn: "2026-11-23" } },
  { id: "doe-seminole-roz-oil-saturation", quantity: "oil_saturation", value: 32, unit: "percent", valueBasis: "as_printed", saturationBasis: "present",
    applicability: { level: "field", county: "GAINES", field: "Seminole", reservoir: "San Andres", interval: ROZ_INTERVAL },
    source: SEMINOLE_ROZ_SOURCE, method: "Oil saturation of the upper ROZ.", limitations: [SEMINOLE_ROZ_LIMIT, "Residual oil left by a natural (Tertiary) waterflood: a present-day saturation, not an initial main-pay saturation. Not mobile under conventional production."],
    extraction: { method: "text_layer", verifyText: ["Oil Saturation (%) 32%"], checkedOn: "2026-11-23" } },

  // ── Seminole San Andres Unit (Lucia, Wang and Kerans 1995, printed page 2) ───
  { id: "lucia-ssau-area", quantity: "area", value: 23, unit: "mi2", valueBasis: "as_printed",
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    source: { documentId: LUCIA, reportPage: "2", pdfPage: 6, locator: "Seminole Field and Geologic Setting" },
    method: "Unit area, stated as approximately 23 square miles.", limitations: ["Stated as approximate.", "A unit area. The areal extent of the main pay zone inside it is not mapped in the registered sources."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
  { id: "lucia-ssau-ooip-as-printed", quantity: "original_oil_in_place", value: 1_100, unit: "Mstb", valueBasis: "as_printed", saturationBasis: "initial",
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    source: { documentId: LUCIA, reportPage: "2", pdfPage: 6, locator: "Seminole Field and Geologic Setting", citesFurther: "Galloway and others (1983), Atlas of major Texas oil reservoirs" },
    method: "Published estimate of original oil in place, cited from Galloway and others (1983).",
    limitations: ["Printed as 1,100 MSTB (1.1 million stock-tank barrels). The same paragraph describes a 23-square-mile unit with over 600 wells, so the unit is probably MMSTB (1.1 billion). Recorded exactly as printed and used only as a published comparison, never as an input."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
];

export const CALIBRATIONS: readonly Calibration[] = [
  { id: "kerans-seminole-log-matrix-values", name: "Porosity-log matrix values, Seminole San Andres Unit",
    expression: "Matrix values for porosity-log calculation (dolomite / anhydrite / pore fluid)",
    parameters: [
      { name: "density, dolomite", value: 2.87, unit: "g/cm3" }, { name: "density, anhydrite", value: 2.95, unit: "g/cm3" }, { name: "density, pore fluid", value: 1.0, unit: "g/cm3" },
      { name: "acoustic, dolomite", value: 43.5, unit: "us/ft" }, { name: "acoustic, anhydrite", value: 50.0, unit: "us/ft" }, { name: "acoustic, pore fluid", value: 150, unit: "us/ft" },
      { name: "CNL, dolomite", value: 4, unit: "pu" }, { name: "CNL, anhydrite", value: -0.2, unit: "pu" }, { name: "CNL, pore fluid", value: 100, unit: "pu" },
    ],
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    sources: [{ documentId: KERANS, reportPage: "140", pdfPage: 149, locator: "Table 9" }, { documentId: KERANS, reportPage: "139", pdfPage: 148, locator: "text above Table 9" }],
    limitations: ["The values that best fit log analysis to anhydrite and corrected core porosity in the study wells (p. 139).", "The CNL dolomite value was reduced from 7.5 to 4 because true porosity is 4 porosity percent lower than CNL limestone porosity (p. 139).", "Log-calculated porosity may still be low by 1 to 2 porosity percent (p. 148)."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
  { id: "seminole-archie-parameters", name: "Archie parameters, Seminole San Andres Unit",
    expression: "Sw = (Rw / (φ^m · Rt))^(1/n), with m = 2.14·(φsv/φt) + 1.76",
    parameters: [{ name: "Rw (original connate water)", value: 0.2, unit: "ohm-m" }, { name: "n", value: 2, unit: "dimensionless", note: "stated as assumed (Kerans p. 143)" }, { name: "m intercept", value: 1.76, unit: "dimensionless" }, { name: "m slope on φsv/φt", value: 2.14, unit: "dimensionless" }],
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    sources: [{ documentId: LUCIA, reportPage: "26", pdfPage: 29, locator: "Water Saturation, equation (2)" }, { documentId: KERANS, reportPage: "143", pdfPage: 152, locator: "Calculation of rock fabric, equation (11)" }],
    limitations: ["Rw is the original connate water; it does not apply to waterflooded intervals (waterflooding began in 1970; CO2 flooding in 1985 — Lucia p. 2).", "Lucia (p. 28) used log saturations only in wells completed water-free, taken to hold original saturations."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
  { id: "seminole-separate-vug-porosity", name: "Separate-vug porosity from transit time, Seminole field",
    expression: "φsv = (2.766 × 10^-4) · 10^[-0.1526·(Δt − 141.5·φ)]   (φ, φsv fractions; Δt in µs/ft)",
    parameters: [{ name: "coefficient", value: 2.766e-4, unit: "dimensionless" }, { name: "exponent slope", value: -0.1526, unit: "dimensionless" }, { name: "porosity factor", value: 141.5, unit: "dimensionless" }],
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    sources: [{ documentId: LUCIA, reportPage: "24", pdfPage: 27, locator: "equation (1)" }, { documentId: KERANS, reportPage: "143", pdfPage: 152, locator: "equation (10)" }],
    limitations: ["Applies to anhydritic dolomites only (Kerans p. 139).", "Calculated and core-described separate-vug profiles do not match well (Kerans p. 143)."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
  { id: "seminole-saturation-class-boundaries", name: "Porosity–saturation rock-fabric class boundaries, Seminole field",
    expression: "class 1/2: Sw = (6.522 × 10^-3)·φ^-1.401;   class 2/3: Sw = (3.05 × 10^-2)·φ^-0.981   (Kerans prints the second exponent as -0.9813)",
    parameters: [{ name: "class 1/2 coefficient", value: 6.522e-3, unit: "dimensionless" }, { name: "class 1/2 exponent", value: -1.401, unit: "dimensionless" }, { name: "class 2/3 coefficient", value: 3.05e-2, unit: "dimensionless" }, { name: "class 2/3 exponent", value: -0.981, unit: "dimensionless" }],
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    sources: [{ documentId: LUCIA, reportPage: "28", pdfPage: 31, locator: "equations (3) and (4)" }, { documentId: KERANS, reportPage: "146", pdfPage: 155, locator: "equations (12) and (13)" }],
    limitations: ["Does not work in 100 percent water-saturated intervals, near the zero-capillary-pressure elevation, or in waterflooded zones (Lucia p. 28)."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
  { id: "seminole-permeability-transforms", name: "Rock-fabric permeability transforms, Seminole field",
    expression: "class 1: k = 7.9432e9·(φ−φsv)^8.75;  class 2: k = 6.6069e9·(φ−φsv)^8.85;  class 3: k = 1.2303e6·(φ−φsv)^5.90   (k in md, porosities fractions)",
    parameters: [{ name: "class 1 coefficient", value: 7.9432e9, unit: "dimensionless" }, { name: "class 1 exponent", value: 8.75, unit: "dimensionless" }, { name: "class 2 coefficient", value: 6.6069e9, unit: "dimensionless" }, { name: "class 2 exponent", value: 8.85, unit: "dimensionless" }, { name: "class 3 coefficient", value: 1.2303e6, unit: "dimensionless" }, { name: "class 3 exponent", value: 5.9, unit: "dimensionless" }],
    applicability: { level: "unit", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", reservoir: "San Andres" },
    sources: [{ documentId: LUCIA, reportPage: "32", pdfPage: 35, locator: "equations (5)–(7)" }, { documentId: KERANS, reportPage: "146", pdfPage: 155, locator: "equations (14)–(16)" }],
    limitations: ["Calibrated with log-calculated interparticle porosity against core permeability; considerable scatter (Lucia p. 31).", "Not used in volumetrics; held for recovery work."],
    extraction: { method: "page_image_transcription", checkedOn: "2026-11-23" } },
];

/** Porosity measurement limitations that apply to any Seminole core or log porosity. */
export const SEMINOLE_POROSITY_NOTES = [
  { text: "Whole-core porosity in the study area is too low by 0 to 4 porosity percent (about 2 on average) because the core was improperly cleaned.", source: { documentId: LUCIA, reportPage: "8–9", pdfPage: 12, locator: "Core Data; Figure 5" } },
  { text: "Log-calculated porosity may still be low by 1 to 2 porosity percent, or separate-vug porosity too high by the same amount.", source: { documentId: KERANS, reportPage: "148", pdfPage: 157, locator: "Porosity, permeability, and rock-fabric transforms" } },
] as const;

export const REVIEWED: readonly ReviewedItem[] = [
  { documentId: LUCIA, locator: "Figures 3, 5, 8, 9, 12–18 (SSAU 2505, 2309, 2504, 2709, 2714)", reportPage: "5–35", decision: "graphical_only", reason: "Well logs and cross plots for individual SSAU wells are shown as graphs only. They are not digitized, because reading values off a graph adds error the source does not carry." },
  { documentId: KERANS, locator: "Tables 1–8", reportPage: "9–134", decision: "not_applicable", reason: "Outcrop (Algerita Escarpment, Lawyer Canyon, Irabarne Tank, New Mexico) and outcrop-simulation tables; Table 8 is slab-core permeameter data. None is a porosity, saturation, net-pay, area or FVF value for a Gaines reservoir." },
  { documentId: KERANS, locator: "Figures 63–88 (Seminole San Andres Unit)", reportPage: "110–150", decision: "graphical_only", reason: "Seminole core and log data are presented as plots; the numerical results are the equations and Table 9, stored as calibrations." },
  { documentId: "beg-ri-116", locator: "Table 7 and oil-characteristics tables", reportPage: "—", decision: "no_volumetric_inputs", reason: "Oil geochemistry (composition, gravity, depth) by field; no porosity, saturation, net pay, area or formation volume factor." },
  { documentId: "beg-ri-128", locator: "Production data and facies sections", reportPage: "43–", decision: "no_volumetric_inputs", reason: "Northern and northwestern shelf facies and production; Seminole appears only in a reference and ODC not at all." },
];
