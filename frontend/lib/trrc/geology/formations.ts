/**
 * Formation / depth context — wraps formation-normalization.ts for the one
 * signal that's actually available (canonical formation from TRRC field
 * name text) and explicitly, permanently discloses what isn't.
 *
 * HARD DATA GAP, confirmed live during this engine's design (not assumed):
 * TRRC's public ArcGIS well-locations layer carries no depth/formation-top
 * attribute (queried live: GIS_SYMBOL_DESCRIPTION is a map-symbol category
 * like "Oil Well", nothing stratigraphic). The "survey" layers are
 * land-grid/legal-description polygons, not structural surfaces. There is
 * no free, bulk-queryable public source of Texas formation top/depth data.
 * formation_tops and geology_surfaces (migration 023) exist as schemas for
 * when a real source is connected — this module never populates them with
 * an estimate standing in for real data.
 *
 * TVDSS = TVD - reference elevation, per spec. This engine has no bulk
 * elevation-reference dataset either, so TVDSS is only ever computed when
 * BOTH a real TVD and a real elevation value are independently supplied —
 * never inferred from one alone.
 */

import { normalizeFormation, matchFormations } from "../offset-analytics/formation-normalization";
import type { FormationDepthContext } from "./types";

export interface FormationContextInputs {
  subjectFieldName: string | null;
  permittedFormationRaw: string | null;
  subjectTvdFt: number | null;
  subjectTvdSource: string | null;
  referenceElevationFt: number | null;
  referenceElevationSource: string | null;
}

export function resolveFormationDepthContext(inputs: FormationContextInputs): FormationDepthContext {
  const subject = inputs.subjectFieldName ? normalizeFormation(inputs.subjectFieldName) : null;
  const permitted = inputs.permittedFormationRaw ? normalizeFormation(inputs.permittedFormationRaw) : null;

  let subjectTvdssFt: number | null = null;
  let tvdssMethodology: string | null = null;
  if (inputs.subjectTvdFt !== null && inputs.referenceElevationFt !== null) {
    subjectTvdssFt = Math.round((inputs.subjectTvdFt - inputs.referenceElevationFt) * 10) / 10;
    tvdssMethodology = `TVDSS = TVD (${inputs.subjectTvdFt} ft, source: ${inputs.subjectTvdSource ?? "unknown"}) - reference elevation (${inputs.referenceElevationFt} ft, source: ${inputs.referenceElevationSource ?? "unknown"})`;
  }

  return {
    subjectFormation: subject?.canonicalFormation ?? null,
    producingFormation: subject?.canonicalFormation ?? null,
    permittedFormation: permitted?.canonicalFormation ?? null,
    subjectTvdFt: inputs.subjectTvdFt,
    subjectTvdSource: inputs.subjectTvdSource,
    subjectTvdssFt,
    tvdssElevationSource: inputs.referenceElevationFt !== null ? inputs.referenceElevationSource : null,
    tvdssMethodology,
    formationTopsAvailable: false,
    dataGapNote: "Formation tops and structural depth surfaces are not available from any free public Texas data source and were not part of this assessment. Formation identity above is derived from TRRC field-name text only, not a measured stratigraphic top/base depth.",
  };
}

export { normalizeFormation, matchFormations };
