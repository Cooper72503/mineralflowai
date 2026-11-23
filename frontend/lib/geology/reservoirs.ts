/**
 * Gaines County reservoirs with a volumetric study, and which RRC fields belong to them.
 *
 * East Seminole, West Seminole and Hanford are separate San Andres buildups from
 * the Seminole field (Kerans and others 1992, p. 112), so only the RRC field
 * "SEMINOLE (SAN ANDRES)" maps to the Seminole studies.
 */
import { parseFieldName } from "./san-andres-roz";
import type { SourceLocation } from "./evidence/types";

export interface ReservoirDef {
  id: string;
  name: string;
  county: "GAINES";
  field: string;
  /** Set when the study is scoped to a named unit rather than the whole field. */
  unit?: string;
  formation: "San Andres";
  interval: string;
  /** The DOE ROZ partition whose regional averages surround this reservoir (shown, never substituted). */
  regionalPartition: number | null;
  description: string;
  /** Facts about the reservoir's history that bear on which saturations are initial. */
  history: { text: string; source: SourceLocation }[];
}

const LUCIA_P2: SourceLocation = { documentId: "beg-1995-lucia-seminole", reportPage: "2", pdfPage: 6, locator: "Seminole Field and Geologic Setting" };

export const RESERVOIRS: readonly ReservoirDef[] = [
  { id: "seminole-upper-roz", name: "Seminole field — San Andres upper residual oil zone", county: "GAINES", field: "Seminole", formation: "San Andres",
    interval: "upper ROZ below the main pay zone", regionalPartition: 3,
    description: "The residual oil zone beneath the Seminole field's main pay: oil left behind by a natural waterflood, the target of CO2 flooding.",
    history: [{ text: "CO2 flooding of the Seminole San Andres Unit began in 1985.", source: LUCIA_P2 }] },
  { id: "seminole-sau-main-pay", name: "Seminole San Andres Unit — main pay zone", county: "GAINES", field: "Seminole", unit: "Seminole San Andres Unit", formation: "San Andres",
    interval: "main pay zone", regionalPartition: null,
    description: "The producing San Andres reservoir of the Seminole San Andres Unit, discovered in 1936.",
    history: [
      { text: "Discovered in 1936; a solution-gas reservoir with a small initial gas cap.", source: LUCIA_P2 },
      { text: "Waterflooding began in 1970, with infill drilling in 1976 and 1984–85, and CO2 flooding in 1985: saturations logged after 1970 are not initial.", source: LUCIA_P2 },
    ] },
  { id: "odc-san-andres", name: "ODC field — San Andres main pay zone", county: "GAINES", field: "ODC", formation: "San Andres",
    interval: "main pay zone", regionalPartition: 2,
    description: "The ODC field's producing San Andres reservoir (the ODC San Andres Unit).",
    history: [] },
];

export const reservoirById = (id: string) => RESERVOIRS.find(r => r.id === id) ?? null;

/** The studied reservoirs an RRC field belongs to; empty when none is registered. */
export function reservoirsForField(county: string | null | undefined, fieldName: string | null | undefined): ReservoirDef[] {
  if (!fieldName || !/^GAINES$/i.test((county ?? "").replace(/\s*COUNTY$/i, "").trim())) return [];
  const f = parseFieldName(fieldName);
  const sanAndres = !f.reservoir || /SAN[ -]?ANDRES/.test(f.reservoir);
  if (f.core === "SEMINOLE" && f.direction === null && sanAndres) return RESERVOIRS.filter(r => r.field === "Seminole") as ReservoirDef[];
  if (f.core === "ODC" && f.direction === null && sanAndres) return RESERVOIRS.filter(r => r.field === "ODC") as ReservoirDef[];
  return [];
}
