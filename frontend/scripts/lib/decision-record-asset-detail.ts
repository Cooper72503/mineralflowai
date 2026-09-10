/**
 * Supporting detail for the synthetic gold-standard asset.
 *
 * The DecisionRecord carries everything the decision depends on. It does not
 * carry the surrounding technical evidence a reader needs to believe it —
 * the production history behind the remaining volumes, the subsurface and
 * spacing behind the forecast, the regulatory standing behind the operator,
 * the instrument chain behind the ownership fractions.
 *
 * Those figures used to live inline in the long-form report's markup, which is
 * how the report ended up asserting numbers the engine disagreed with. They are
 * declared once here instead, so every page that draws them draws the same
 * values, and each carries the source that produced it.
 *
 * This is fixture data for the illustrative sample. Party names are invented.
 */

export type Src = "NOVI" | "TRRC" | "COUNTY" | "DERIVED";
export type Classification = "Observed" | "Calculated" | "Inferred";

export interface Measure {
  label: string;
  value: string;
  src: Src;
  cls: Classification;
  note?: string;
}

/** Annual oil volumes. `forecast` marks the vendor-modelled tail. */
export const PRODUCTION: Array<{ period: string; oilBbl: number; forecast: boolean }> = [
  { period: "2019", oilBbl: 48_600, forecast: false },
  { period: "2020", oilBbl: 62_300, forecast: false },
  { period: "2021", oilBbl: 47_400, forecast: false },
  { period: "2022", oilBbl: 38_900, forecast: false },
  { period: "2023", oilBbl: 33_100, forecast: false },
  { period: "2024", oilBbl: 29_600, forecast: false },
  { period: "2025", oilBbl: 27_400, forecast: false },
  { period: "TTM 26", oilBbl: 21_880, forecast: false },
  { period: "2027", oilBbl: 17_450, forecast: true },
  { period: "2028", oilBbl: 14_210, forecast: true },
];

export const PRODUCTION_KPIS: Measure[] = [
  { label: "Trailing 12-mo oil", value: "21,880 bbl", src: "NOVI", cls: "Observed" },
  { label: "Trailing 12-mo gas", value: "38,410 mcf", src: "NOVI", cls: "Observed" },
  { label: "Year-over-year decline", value: "−20.2%", src: "DERIVED", cls: "Calculated" },
  { label: "Forecast oil, next 12 mo", value: "17,450 bbl", src: "NOVI", cls: "Calculated" },
  { label: "Remaining EUR, oil", value: "84,300 bbl", src: "NOVI", cls: "Calculated" },
];

/** Vendor well-level allocation against the regulator's filed lease total. */
export const RECONCILIATION = {
  wells: [
    { label: "Subject well", detail: "42-317-00000", oilBbl: 21_880, subject: true },
    { label: "Wellbore 02", detail: "", oilBbl: 18_420, subject: false },
    { label: "Wellbore 03", detail: "", oilBbl: 24_115, subject: false },
    { label: "Wellbore 04", detail: "", oilBbl: 16_902, subject: false },
    { label: "Wellbores 05–12", detail: "8 wells", oilBbl: 110_223, subject: false },
  ],
  vendorSumBbl: 191_540,
  regulatorLeaseBbl: 184_206,
  varianceBbl: 7_334,
  variancePct: 3.98,
  thresholdPct: 2.0,
  window: "Trailing twelve months ending 2026-09-30",
};

export const COMPLETION: Measure[] = [
  { label: "Completion date", value: "2019-04-18", src: "NOVI", cls: "Observed" },
  { label: "Perforated lateral", value: "9,850 ft", src: "NOVI", cls: "Observed" },
  { label: "Stage count", value: "48", src: "NOVI", cls: "Observed" },
  { label: "Cluster spacing", value: "25 ft", src: "NOVI", cls: "Observed" },
  { label: "Proppant intensity", value: "1,780 lb/ft", src: "NOVI", cls: "Observed" },
  { label: "Total proppant", value: "17.5 MMlb", src: "NOVI", cls: "Observed" },
  { label: "Fluid intensity", value: "42 bbl/ft", src: "NOVI", cls: "Observed" },
  { label: "Frac design", value: "Slickwater hybrid", src: "NOVI", cls: "Observed" },
];

export const SUBSURFACE = {
  targetFormation: "Wolfcamp A",
  benchPosition: "Upper",
  tvdFt: 9_420,
  subseaDatumFt: -6_780,
  grossIntervalFt: 310,
  netPayFt: 186,
  porosityPct: 8.4,
  waterSaturationPct: 32,
  pressureGradientPsiFt: 0.62,
  stackedBelow: "Wolfcamp B",
};

export const SPACING = {
  lateralAzimuthDeg: 178,
  azimuthNote: "North–south, conventional for the block",
  sameBenchOffsetFt: 660,
  anyBenchOffsetFt: 480,
  anyBenchNote: "Wolfcamp B, stacked below",
  wellsPerSectionSameBench: 6,
  parentChildStatus: "Child",
  parentCompletionYear: 2016,
  subjectCompletionYear: 2019,
  depletionInterference: "Moderate",
  interferenceBasis: "Consistent with observed decline",
  coDeveloped: false,
};

export type RegStatus = "ok" | "warn" | "none";
export const REGULATORY: Array<{ record: string; finding: string; detail: string; status: RegStatus; src: Src }> = [
  { record: "Operator standing (P-5)", finding: "Active", detail: "Renewal due 2027-03-31", status: "ok", src: "TRRC" },
  { record: "Compliance violations", finding: "1 open", detail: "Mechanical integrity test overdue", status: "warn", src: "TRRC" },
  { record: "Severance orders", finding: "None", detail: "None of record", status: "ok", src: "TRRC" },
  { record: "Orphan well listing", finding: "Not listed", detail: "Not an orphan well", status: "ok", src: "TRRC" },
  { record: "Plugging records", finding: "Active producer", detail: "No plugging record", status: "ok", src: "TRRC" },
  { record: "Injection / UIC authority", finding: "1 active", detail: "1 permit, active", status: "ok", src: "TRRC" },
  { record: "Imaged well documents", finding: "14 / 14 read", detail: "Permits, completions, plats", status: "ok", src: "TRRC" },
  { record: "County clerk instruments", finding: "6 / 9 read", detail: "3 known from index only", status: "warn", src: "COUNTY" },
];

export const COSTS: Measure[] = [
  { label: "Drill & complete capital", value: "$7.40 MM", src: "NOVI", cls: "Observed", note: "Sunk; first sales 2019" },
  { label: "Fixed operating cost", value: "$8,400 /mo", src: "NOVI", cls: "Observed" },
  { label: "Variable operating cost", value: "$3.10 /bbl", src: "NOVI", cls: "Observed" },
  { label: "Produced water handling", value: "$0.85 /bbl", src: "NOVI", cls: "Observed" },
  { label: "Oil differential to WTI", value: "−$1.85 /bbl", src: "NOVI", cls: "Observed" },
  { label: "Gas differential to HH", value: "−$0.62 /mcf", src: "NOVI", cls: "Observed" },
  { label: "Severance tax, oil", value: "4.60%", src: "TRRC", cls: "Observed" },
  { label: "Severance tax, gas", value: "7.50%", src: "TRRC", cls: "Observed" },
  { label: "Ad valorem", value: "2.10%", src: "COUNTY", cls: "Observed" },
];

export type Support = "earliest" | "supported" | "unresolved" | "unsupported";
export const INSTRUMENTS: Array<{
  recorded: string; kind: string; from: string; to: string;
  interest: string; fraction: string; support: Support; supportLabel: string;
}> = [
  { recorded: "1962-04-11", kind: "Deed", from: "E. J. Caldwell", to: "Ruth A. Caldwell",
    interest: "Mineral", fraction: "all", support: "earliest", supportLabel: "Earliest evidenced" },
  { recorded: "1978-09-22", kind: "Warranty deed, mineral reservation", from: "Ruth A. Caldwell", to: "Marvin D. Prather",
    interest: "Mineral", fraction: "1/2 reserved", support: "supported", supportLabel: "Supported" },
  { recorded: "1991-06-14", kind: "Deed of trust", from: "Marvin D. Prather", to: "Community State Bank",
    interest: "Encumbrance", fraction: "—", support: "unresolved", supportLabel: "No release located" },
  { recorded: "2004-02-03", kind: "Mineral deed", from: "Marvin D. Prather", to: "Delia P. Ashford & Roy L. Ashford",
    interest: "Mineral", fraction: "1/2", support: "unresolved", supportLabel: "Allocation unstated" },
  { recorded: "2011-08-19", kind: "Affidavit of heirship", from: "Ruth A. Caldwell (dec.)", to: "Janet C. Boyd, Thomas E. Caldwell",
    interest: "Mineral", fraction: "1/4 each", support: "supported", supportLabel: "Succession evidence" },
  { recorded: "2016-05-30", kind: "Mineral deed", from: "H. W. Stiles", to: "Stiles Royalty Holdings, LLC",
    interest: "Mineral", fraction: "1/8", support: "unsupported", supportLabel: "Unsupported" },
];

export const RECONCILED_ESTATE: Array<{ holder: string; note: string; share: string; decimal: number; nma: number; evaluated: boolean }> = [
  { holder: "Delia P. Ashford & Roy L. Ashford", note: "collective, no stated split", share: "1/2", decimal: 0.5, nma: 80, evaluated: false },
  { holder: "Janet C. Boyd", note: "the evaluated position", share: "1/4", decimal: 0.25, nma: 40, evaluated: true },
  { holder: "Thomas E. Caldwell", note: "", share: "1/4", decimal: 0.25, nma: 40, evaluated: false },
];

export const COMPETING_CLAIM = {
  claimant: "H. W. Stiles",
  successor: "Stiles Royalty Holdings, LLC",
  instrument: "Inst. 2016-003201",
  recorded: "2016-05-30",
  fraction: "1/8",
  excludedAllocation: "1/1",
  includedAllocation: "9/8",
  includedPct: 112.5,
};
