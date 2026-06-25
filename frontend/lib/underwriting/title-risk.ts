/**
 * Phase E — Automated Title / Mineral Ownership Risk Assessment
 *
 * Identifies risk signals from available diligence data.
 * CANNOT replace a title opinion or landman chain-of-title search.
 * All signals are preliminary flags for human follow-up.
 */

import type { OwnershipSection } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TitleRiskSeverity = "critical" | "warning" | "info";

export type TitleRiskSignal = {
  id: string;
  severity: TitleRiskSeverity;
  flag: string;       // short label for display, e.g. "NO DIVISION ORDER"
  detail: string;     // full explanation
  action: string;     // what the buyer must do
  data_basis: string; // what data triggered this signal
};

export type TitleDocumentRequest = {
  document: string;
  from: "title_attorney" | "seller" | "operator" | "state_agency";
  urgency: "critical" | "important" | "informational";
  reason: string;
};

export type TitleRiskResult = {
  api_number: string;
  state: string;
  overall_risk: "low" | "medium" | "high" | "critical";
  signals: TitleRiskSignal[];
  document_requests: TitleDocumentRequest[];
  // Derived facts used by the UI
  nri_decimal: number | null;
  nri_in_plausible_range: boolean | null;
  wi_decimal: number | null;
  lease_burden_pct: number | null;
  division_orders_on_file: boolean;
  multiple_owners: boolean;
  orri_detected: boolean;
  operator_name_trrc: string | null;
  operator_name_stated: string | null;
  operator_match: boolean | null;
  county_code: string | null;
  county_name: string | null;
  is_hbp: boolean;
  api_format_valid: boolean;
  disclaimer: string;
};

export type BuildTitleRiskArgs = {
  apiNumbers:      string[];
  state:           string | null;
  ownership:       OwnershipSection;
  statedOperator:  string | null;
  trrcOperator:    string | null;
  statedCounty:    string | null;
  trrcCounty:      string | null;
  hasProduction:   boolean;
  nriOverride:     number | null;
  wiOverride:      number | null;
};

// ─── TX county code map (42-state prefix → county name) ──────────────────────
// Format: TX API = "42" + COUNTY(3) + WELL(5). Extract chars [2..4].

const TX_COUNTY_CODES: Record<string, string> = {
  "001": "Anderson",       "003": "Andrews",        "005": "Angelina",
  "007": "Aransas",        "009": "Archer",          "011": "Armstrong",
  "013": "Atascosa",       "015": "Austin",          "017": "Bailey",
  "019": "Bandera",        "021": "Bastrop",         "023": "Baylor",
  "025": "Bee",            "027": "Bell",            "029": "Bexar",
  "031": "Blanco",         "033": "Borden",          "035": "Bosque",
  "037": "Bowie",          "039": "Brazoria",        "041": "Brazos",
  "043": "Brewster",       "045": "Briscoe",         "047": "Brooks",
  "049": "Brown",          "051": "Burleson",        "053": "Burnet",
  "055": "Caldwell",       "057": "Calhoun",         "059": "Callahan",
  "061": "Cameron",        "063": "Camp",            "065": "Carson",
  "067": "Cass",           "069": "Castro",          "071": "Chambers",
  "073": "Cherokee",       "075": "Childress",       "077": "Clay",
  "079": "Cochran",        "081": "Coke",            "083": "Coleman",
  "085": "Collin",         "087": "Collingsworth",   "089": "Colorado",
  "091": "Comal",          "093": "Comanche",        "095": "Concho",
  "097": "Cooke",          "099": "Coryell",         "101": "Cottle",
  "103": "Crane",          "105": "Crockett",        "107": "Crosby",
  "109": "Culberson",      "111": "Dallam",          "113": "Dallas",
  "115": "Dawson",         "117": "Deaf Smith",      "119": "Delta",
  "121": "Denton",         "123": "DeWitt",          "125": "Dickens",
  "127": "Dimmit",         "129": "Donley",          "131": "Duval",
  "133": "Eastland",       "135": "Ector",           "137": "Edwards",
  "139": "Ellis",          "141": "El Paso",         "143": "Erath",
  "145": "Falls",          "147": "Fannin",          "149": "Fayette",
  "151": "Fisher",         "153": "Floyd",           "155": "Foard",
  "157": "Fort Bend",      "159": "Franklin",        "161": "Freestone",
  "163": "Frio",           "165": "Gaines",          "167": "Galveston",
  "169": "Garza",          "171": "Gillespie",       "173": "Glasscock",
  "175": "Goliad",         "177": "Gonzales",        "179": "Gray",
  "181": "Grayson",        "183": "Gregg",           "185": "Grimes",
  "187": "Guadalupe",      "189": "Hale",            "191": "Hall",
  "193": "Hamilton",       "195": "Hansford",        "197": "Hardeman",
  "199": "Hardin",         "201": "Harris",          "203": "Harrison",
  "205": "Hartley",        "207": "Haskell",         "209": "Hays",
  "211": "Hemphill",       "213": "Henderson",       "215": "Hidalgo",
  "217": "Hill",           "219": "Hockley",         "221": "Hood",
  "223": "Hopkins",        "225": "Houston",         "227": "Howard",
  "229": "Hudspeth",       "231": "Hunt",            "233": "Hutchinson",
  "235": "Irion",          "237": "Jack",            "239": "Jackson",
  "241": "Jasper",         "243": "Jeff Davis",      "245": "Jefferson",
  "247": "Jim Hogg",       "249": "Jim Wells",       "251": "Johnson",
  "253": "Jones",          "255": "Karnes",          "257": "Kaufman",
  "259": "Kendall",        "261": "Kenedy",          "263": "Kent",
  "265": "Kerr",           "267": "Kimble",          "269": "King",
  "271": "Kinney",         "273": "Kleberg",         "275": "Knox",
  "277": "Lamar",          "279": "Lamb",            "281": "Lampasas",
  "283": "La Salle",       "285": "Lavaca",          "287": "Lee",
  "289": "Leon",           "291": "Liberty",         "293": "Limestone",
  "295": "Lipscomb",       "297": "Live Oak",        "299": "Llano",
  "301": "Loving",         "303": "Lubbock",         "305": "Lynn",
  "307": "McCulloch",      "309": "McLennan",        "311": "McMullen",
  "313": "Madison",        "315": "Marion",          "317": "Martin",
  "319": "Mason",          "321": "Matagorda",       "323": "Maverick",
  "325": "Medina",         "327": "Menard",          "329": "Midland",
  "331": "Milam",          "333": "Mills",           "335": "Mitchell",
  "337": "Montague",       "339": "Montgomery",      "341": "Moore",
  "343": "Morris",         "345": "Motley",          "347": "Nacogdoches",
  "349": "Navarro",        "351": "Newton",           "353": "Nolan",
  "355": "Nueces",         "357": "Ochiltree",       "359": "Oldham",
  "361": "Orange",         "363": "Palo Pinto",      "365": "Panola",
  "367": "Parker",         "369": "Parmer",          "371": "Pecos",
  "373": "Polk",           "375": "Potter",          "377": "Presidio",
  "379": "Rains",          "381": "Randall",         "383": "Reagan",
  "385": "Real",           "387": "Red River",       "389": "Reeves",
  "391": "Refugio",        "393": "Roberts",         "395": "Robertson",
  "397": "Rockwall",       "399": "Runnels",         "401": "Rusk",
  "403": "Sabine",         "405": "San Augustine",   "407": "San Jacinto",
  "409": "San Patricio",   "411": "San Saba",        "413": "Schleicher",
  "415": "Scurry",         "417": "Shackelford",     "419": "Shelby",
  "421": "Sherman",        "423": "Smith",           "425": "Somervell",
  "427": "Starr",          "429": "Stephens",        "431": "Sterling",
  "433": "Stonewall",      "435": "Sutton",          "437": "Swisher",
  "439": "Tarrant",        "441": "Taylor",          "443": "Terrell",
  "445": "Terry",          "447": "Throckmorton",    "449": "Titus",
  "451": "Tom Green",      "453": "Travis",          "455": "Trinity",
  "457": "Tyler",          "459": "Upshur",          "461": "Upton",
  "463": "Uvalde",         "465": "Val Verde",       "467": "Van Zandt",
  "469": "Victoria",       "471": "Walker",          "473": "Waller",
  "475": "Ward",           "477": "Washington",      "479": "Webb",
  "481": "Wharton",        "483": "Wheeler",         "485": "Wichita",
  "487": "Wilbarger",      "489": "Willacy",         "491": "Williamson",
  "493": "Wilson",         "495": "Winkler",         "497": "Wood",
  "499": "Yoakum",         "501": "Young",           "503": "Zapata",
  "505": "Zavala",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

function operatorsMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return true;
  // Accept if one contains the other (accounts for "XYZ LLC" vs "XYZ Operating LLC")
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

// ─── Main engine ─────────────────────────────────────────────────────────────

export function buildTitleRisk(args: BuildTitleRiskArgs): TitleRiskResult {
  const {
    apiNumbers, state, ownership, statedOperator, trrcOperator,
    statedCounty, trrcCounty, hasProduction, nriOverride, wiOverride,
  } = args;

  const signals: TitleRiskSignal[] = [];
  const docRequests: TitleDocumentRequest[] = [];

  // ── API number parsing ────────────────────────────────────────────────────
  const primaryApi = apiNumbers.length > 0 ? apiNumbers[0].replace(/\D/g, "") : null;
  const apiFormatValid = primaryApi != null
    && primaryApi.length >= 10
    && primaryApi.startsWith("42");

  if (!apiFormatValid && primaryApi != null) {
    signals.push({
      id: "api_format_invalid",
      severity: "warning",
      flag: "UNRECOGNIZED API FORMAT",
      detail: `API number "${primaryApi}" does not match the standard 10-digit TX format (42 + county[3] + well[5]). County and survey identification may be unreliable.`,
      action: "Verify API number against TRRC records before proceeding.",
      data_basis: `API: ${primaryApi}`,
    });
  }

  // ── County / survey identification ────────────────────────────────────────
  let countyCode: string | null = null;
  let countyName: string | null = null;

  if (primaryApi && primaryApi.startsWith("42") && primaryApi.length >= 5) {
    countyCode = primaryApi.slice(2, 5);
    countyName = TX_COUNTY_CODES[countyCode] ?? null;
  }

  // Use TRRC-resolved county as authoritative; stated county for mismatch detection
  const resolvedCounty = trrcCounty ?? countyName ?? statedCounty;

  if (trrcCounty && statedCounty) {
    const trrcNorm = normalizeName(trrcCounty);
    const statedNorm = normalizeName(statedCounty);
    if (!trrcNorm.includes(statedNorm) && !statedNorm.includes(trrcNorm)) {
      signals.push({
        id: "county_mismatch",
        severity: "warning",
        flag: "COUNTY MISMATCH",
        detail: `TRRC records show ${trrcCounty} County, but ${statedCounty} County was stated. This may indicate an incorrect API number was entered.`,
        action: "Verify the API number is correct and matches the subject property's county of record.",
        data_basis: `TRRC county: ${trrcCounty} | Stated county: ${statedCounty}`,
      });
    }
  }

  // ── Ownership / NRI data ──────────────────────────────────────────────────
  const nriRaw: number | null =
    nriOverride ??
    (ownership.nri_decimal.value ?? null) ??
    null;

  const wiRaw: number | null =
    wiOverride ??
    (ownership.working_interest_decimal.value ?? null) ??
    null;

  const divisionOrdersOnFile = ownership.records.length > 0;
  const ownerCount = new Set(ownership.records.map(r => r.owner_name.toLowerCase().trim())).size;
  const multipleOwners = ownerCount > 1;
  const orrRecords = ownership.records.filter(r =>
    r.interest_type.toUpperCase().includes("ORRI") ||
    r.interest_type.toLowerCase().includes("overriding")
  );
  const orriDetected = orrRecords.length > 0;

  // NRI plausibility range: 1/8 (0.125) to 1/4 (0.25) for typical mineral royalty owners
  const nriInPlausibleRange: boolean | null = nriRaw != null
    ? nriRaw >= 0.125 && nriRaw <= 0.25
    : null;

  // Lease burden = fraction of WI going to royalty; typical 12.5% to 25%
  const leaseBurdenPct: number | null = (wiRaw != null && nriRaw != null && wiRaw > 0)
    ? ((wiRaw - nriRaw) / wiRaw) * 100
    : null;

  // ── Signal: No division orders ────────────────────────────────────────────
  if (!divisionOrdersOnFile) {
    signals.push({
      id: "no_division_orders",
      severity: "critical",
      flag: "NO DIVISION ORDER ON FILE",
      detail: "No division orders or working interest / NRI schedules were found in the uploaded documents. Decimal interest cannot be confirmed without an executed division order.",
      action: "Request current executed division orders from the operator before making any offer.",
      data_basis: "No ownership records found in uploaded documents.",
    });
    docRequests.push({
      document: "Executed Division Order(s)",
      from: "operator",
      urgency: "critical",
      reason: "Required to confirm decimal interest (WI/NRI). Cannot price the asset without verified interest allocation.",
    });
  }

  // ── Signal: NRI out of plausible range ───────────────────────────────────
  if (nriRaw != null && nriInPlausibleRange === false) {
    if (nriRaw < 0.125) {
      signals.push({
        id: "nri_below_minimum",
        severity: "warning",
        flag: "NRI BELOW STATUTORY MINIMUM (1/8)",
        detail: `Stated NRI of ${(nriRaw * 100).toFixed(4)}% is below the Texas statutory minimum royalty of 12.5% (1/8). This may indicate deep ORRI stacking, a non-participating royalty, or an unusual lease structure.`,
        action: "Reconcile NRI calculation against the underlying lease royalty rate and all outstanding ORRI assignments.",
        data_basis: `NRI: ${(nriRaw * 100).toFixed(4)}% (< 12.5%)`,
      });
    } else if (nriRaw > 0.25) {
      signals.push({
        id: "nri_above_typical",
        severity: "warning",
        flag: "NRI ABOVE TYPICAL RANGE (> 1/4)",
        detail: `Stated NRI of ${(nriRaw * 100).toFixed(4)}% exceeds the typical 25% range. This warrants verification — confirm the lease royalty rate and that no arithmetic error occurred in the division order.`,
        action: "Confirm NRI with operator and verify underlying lease royalty rate.",
        data_basis: `NRI: ${(nriRaw * 100).toFixed(4)}% (> 25%)`,
      });
    }
  }

  // ── Signal: ORRI / royalty stacking ─────────────────────────────────────
  if (orriDetected) {
    signals.push({
      id: "orri_detected",
      severity: "warning",
      flag: "ORRI DETECTED — ROYALTY STACKING RISK",
      detail: `${orrRecords.length} overriding royalty interest(s) found in ownership schedule. ORRIs reduce NRI and represent a perpetual burden on gross revenue. They survive lease assignment and ownership transfer.`,
      action: "Obtain all ORRI assignment instruments. Verify total royalty burden (RI + all ORRIs) and confirm net revenue calculation.",
      data_basis: `ORRI records: ${orrRecords.map(r => `${r.owner_name} (${r.interest_type})`).join("; ")}`,
    });
    docRequests.push({
      document: "ORRI Assignment Instruments",
      from: "seller",
      urgency: "important",
      reason: "Overriding royalty interests were detected. All ORRI agreements must be reviewed to confirm total royalty burden.",
    });
  }

  // ── Signal: Multiple owners ───────────────────────────────────────────────
  if (multipleOwners) {
    signals.push({
      id: "multiple_owners",
      severity: ownerCount > 3 ? "warning" : "info",
      flag: `${ownerCount} INTEREST HOLDERS IDENTIFIED`,
      detail: `${ownerCount} distinct interest holders found in the ownership schedule. Complex ownership may indicate a divided mineral estate, fractional ownership, or heirship situation.`,
      action: "Confirm all interest holders have signed or are represented in current division orders. Request heirship affidavits or curative if any undivided interests exist.",
      data_basis: `Owners: ${ownership.records.map(r => r.owner_name).join("; ")}`,
    });
  }

  // ── Signal: Operator name mismatch ───────────────────────────────────────
  let operatorMatchResult: boolean | null = null;
  if (trrcOperator && statedOperator) {
    operatorMatchResult = operatorsMatch(trrcOperator, statedOperator);
    if (!operatorMatchResult) {
      signals.push({
        id: "operator_mismatch",
        severity: "warning",
        flag: "OPERATOR NAME MISMATCH",
        detail: `The stated operator "${statedOperator}" does not match the TRRC operator of record "${trrcOperator}". This may indicate a recent change of operatorship, a related-entity name difference, or an error.`,
        action: "Obtain TRRC T-4 transfer of operatorship documentation if there was a recent change. Confirm entity is the same as or successor to the TRRC operator.",
        data_basis: `Stated: "${statedOperator}" | TRRC: "${trrcOperator}"`,
      });
    }
  }

  // ── Signal: HBP confirmation ─────────────────────────────────────────────
  if (hasProduction) {
    signals.push({
      id: "hbp_lease_required",
      severity: "info",
      flag: "WELL IS HBP — LEASE COPY REQUIRED",
      detail: "Production confirms this well is Held by Production (HBP). However, HBP status does not eliminate lease review requirements: primary term provisions, pugh clauses, depth limitations, continuous development obligations, and royalty rate must all be confirmed from the signed lease.",
      action: "Obtain a fully executed copy of the underlying mineral lease(s) from the seller. Confirm there are no provisions that could terminate HBP status.",
      data_basis: "Production history found in TRRC or uploaded records.",
    });
  }

  // ── Signal: Title opinion — always required ───────────────────────────────
  signals.push({
    id: "title_opinion_required",
    severity: "critical",
    flag: "TITLE OPINION REQUIRED BEFORE CLOSING",
    detail: "No automated analysis substitutes for a formal title opinion. A licensed title attorney must examine county deed records to verify the chain of title from the original patent to present, confirm no adverse interests or encumbrances, and establish that the seller has marketable title.",
    action: "Engage a licensed title attorney for a full title examination of the mineral estate before closing.",
    data_basis: "Required for all mineral acquisitions.",
  });

  // ── Document requests — always generated ─────────────────────────────────
  docRequests.push(
    {
      document: "Title Opinion",
      from: "title_attorney",
      urgency: "critical",
      reason: "Required for all acquisitions. Must confirm marketable title and absence of encumbrances.",
    },
    {
      document: "Signed Mineral Lease",
      from: "seller",
      urgency: "critical",
      reason: "Required to confirm HBP status, royalty rate, depth limitations, and special provisions (pugh clause, continuous development, etc.).",
    },
    {
      document: "Chain of Title / Mineral Deed Chain",
      from: "title_attorney",
      urgency: "critical",
      reason: "County deed records establishing unbroken ownership from original patent to seller.",
    },
    {
      document: "Run Statement (12 months)",
      from: "operator",
      urgency: "important",
      reason: "Verifies NRI calculation against actual operator payments. Confirms correct decimal interest is being applied.",
    },
    {
      document: "Assignment and Bill of Sale",
      from: "seller",
      urgency: "critical",
      reason: "Transfers mineral interest from seller to buyer. Must be drafted and reviewed by title attorney.",
    },
  );

  if (hasProduction) {
    docRequests.push({
      document: "Wellbore Authorization / PROA",
      from: "seller",
      urgency: "important",
      reason: "Confirms seller's authority to convey and operate in the wellbore.",
    });
  }

  // ── Overall risk score ────────────────────────────────────────────────────
  const criticalCount = signals.filter(s => s.severity === "critical").length;
  const warningCount  = signals.filter(s => s.severity === "warning").length;

  // "Title opinion required" is always critical but expected — don't let it alone force "critical" overall
  const nonStandardCriticals = criticalCount - 1; // subtract the always-expected title opinion flag
  const overall: TitleRiskResult["overall_risk"] =
    (nonStandardCriticals > 0 || (warningCount >= 2 && !divisionOrdersOnFile))
      ? "critical"
      : warningCount >= 2
        ? "high"
        : warningCount === 1
          ? "medium"
          : "low";

  return {
    api_number:            primaryApi ?? apiNumbers[0] ?? "Unknown",
    state:                 state ?? "TX",
    overall_risk:          overall,
    signals,
    document_requests:     docRequests,
    nri_decimal:           nriRaw,
    nri_in_plausible_range: nriInPlausibleRange,
    wi_decimal:            wiRaw,
    lease_burden_pct:      leaseBurdenPct,
    division_orders_on_file: divisionOrdersOnFile,
    multiple_owners:       multipleOwners,
    orri_detected:         orriDetected,
    operator_name_trrc:    trrcOperator,
    operator_name_stated:  statedOperator,
    operator_match:        operatorMatchResult,
    county_code:           countyCode,
    county_name:           countyName ?? resolvedCounty ?? null,
    is_hbp:                hasProduction,
    api_format_valid:      apiFormatValid,
    disclaimer: "This automated title risk assessment identifies signals from available diligence data only. It is NOT a title opinion and CANNOT replace a review of county deed records by a licensed title attorney. These findings are preliminary and do not constitute legal advice. All mineral acquisitions require a formal title opinion from a licensed Texas title attorney before closing.",
  };
}
