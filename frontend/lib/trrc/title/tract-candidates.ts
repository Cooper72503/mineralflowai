/**
 * Candidate tract identification from resolved well data and supporting
 * documents. Produces CandidateTract proposals plus WellTractAssociation
 * proposals, each with association type, evidence, confidence, and a
 * review status of "proposed" — nothing here confirms a title tract.
 *
 * The five concepts stay separate (association types):
 *   surface_location    — GIS surface hole survey/abstract
 *   bottomhole_location — bottomhole survey when a permit/completion states it
 *   well_path           — lateral geometry (recorded, not used for title)
 *   permit_acreage      — W-1 permit/proration acreage description
 *   lease_unit_boundary — lease/unit name or unit description
 *   legal_tract         — a legal description from an instrument or plat
 * A coordinate, survey match, lease name, or operator match alone is a
 * proposal for the user to confirm, never an assertion of the title tract.
 */

import { randomUUID } from "crypto";
import { normalizeAbstractNumber } from "../offset-analytics/legal-description";
import type { CandidateTract, Citation, JobWell, WellTractAssociation, WellTractAssociationType } from "./chain-types";
import type { ExtractedTract } from "./instrument-schema";

export interface TractProposalInput {
  wells: JobWell[];
  /** Legal descriptions extracted from non-instrument documents (W-1, plats), keyed by well. */
  documentLegals: Array<{ wellId: string | null; documentId: string; sourceUrl: string | null; tract: ExtractedTract; category: string }>;
  existingTracts: CandidateTract[];
}

export interface TractProposalOutput {
  tracts: CandidateTract[];               // includes existing + new
  associations: Array<Omit<WellTractAssociation, "id">>;
  reviewNeeded: boolean;
}

export function tractKey(t: { county: string | null; abstractNumber: string | null; surveyName: string | null; blockNumber: string | null; sectionName: string | null; legalDescription: string | null }): string | null {
  const abs = normalizeAbstractNumber(t.abstractNumber) ?? (t.abstractNumber ? `A-${t.abstractNumber.replace(/\D/g, "")}` : null);
  const parts = [t.county?.trim().toLowerCase(), abs?.toLowerCase(), t.surveyName?.trim().toLowerCase().replace(/\s+survey$/, ""), t.blockNumber?.trim().toLowerCase(), t.sectionName?.trim().toLowerCase()].filter(Boolean);
  if (parts.length >= 2) return `components:${parts.join("|")}`;
  if (t.legalDescription) return `legal:${t.legalDescription.trim().toLowerCase().replace(/\s+/g, " ")}`;
  return null;
}

export function tractLabelFor(t: { county: string | null; abstractNumber: string | null; surveyName: string | null; blockNumber: string | null; sectionName: string | null; legalDescription: string | null }): string {
  const abs = normalizeAbstractNumber(t.abstractNumber) ?? t.abstractNumber;
  const bits = [
    t.surveyName ? `${t.surveyName.replace(/\s+survey$/i, "")} Survey` : null,
    abs,
    t.blockNumber ? `Blk ${t.blockNumber}` : null,
    t.sectionName ? `Sec ${t.sectionName}` : null,
    t.county ? `${t.county} County` : null,
  ].filter(Boolean);
  if (bits.length > 0) return bits.join(", ");
  return t.legalDescription ? t.legalDescription.slice(0, 90) : "Unidentified tract";
}

export function proposeTracts(input: TractProposalInput): TractProposalOutput {
  const tracts: CandidateTract[] = [...input.existingTracts];
  const byKey = new Map<string, CandidateTract>();
  for (const t of tracts) { const k = tractKey(t); if (k) byKey.set(k, t); }
  const associations: Array<Omit<WellTractAssociation, "id">> = [];
  const assocKeys = new Set<string>();

  const upsertTract = (fields: Pick<CandidateTract, "county" | "abstractNumber" | "surveyName" | "blockNumber" | "sectionName" | "legalDescription" | "grossAcres">, method: string, confidence: number, trace: string): CandidateTract | null => {
    const key = tractKey(fields);
    if (!key) return null;
    const existing = byKey.get(key);
    if (existing) {
      existing.resolutionTrace.push(trace);
      existing.confidence = Math.max(existing.confidence, confidence);
      if (!existing.grossAcres && fields.grossAcres) existing.grossAcres = fields.grossAcres;
      return existing;
    }
    const t: CandidateTract = {
      id: randomUUID(),
      tractLabel: tractLabelFor(fields),
      county: fields.county, abstractNumber: normalizeAbstractNumber(fields.abstractNumber) ?? fields.abstractNumber,
      surveyName: fields.surveyName, blockNumber: fields.blockNumber, sectionName: fields.sectionName,
      legalDescription: fields.legalDescription, grossAcres: fields.grossAcres,
      confidence, resolutionMethod: method, resolutionTrace: [trace], needsUserSelection: true, matchStatus: "proposed",
    };
    tracts.push(t);
    byKey.set(key, t);
    return t;
  };

  const associate = (wellId: string, tract: CandidateTract, type: WellTractAssociationType, confidence: number, evidence: Citation[]) => {
    const k = `${wellId}|${tract.id}|${type}`;
    if (assocKeys.has(k)) return;
    assocKeys.add(k);
    associations.push({ wellId, canonicalTractId: tract.id, associationType: type, confidence, evidence, reviewStatus: "proposed" });
  };

  for (const well of input.wells) {
    if (well.resolutionStatus !== "resolved") continue;
    const gisUrl = well.sourceUrls.find(s => s.source === "trrc_gis")?.url ?? null;

    // Surface location from the GIS survey polygon the well point falls in.
    if (well.surveyName || well.abstractNumber) {
      const t = upsertTract({ county: well.countyName, abstractNumber: well.abstractNumber, surveyName: well.surveyName, blockNumber: well.blockNumber, sectionName: well.sectionName, legalDescription: null, grossAcres: null },
        "gis_surface_location_survey", 0.55, `Surface hole of ${well.api14 ?? well.api10} falls within this survey polygon (TRRC GIS)`);
      if (t) associate(well.id, t, "surface_location", 0.55, [{ documentId: null, instrumentId: null, page: null, excerpt: `GIS point ${well.latitude ?? "?"}, ${well.longitude ?? "?"} intersects ${t.tractLabel}`, sourceUrl: gisUrl, label: "TRRC GIS well location" }]);
      if (t && well.wellPath) associate(well.id, t, "well_path", 0.3, [{ documentId: null, instrumentId: null, page: null, excerpt: "Well-path geometry retrieved; lateral extent may cross other tracts", sourceUrl: gisUrl, label: "TRRC GIS well path" }]);
    }

    // Permit / lease references (W-1 rows carry lease name, acreage, survey text when TRRC publishes them).
    for (const p of well.permitRefs) {
      const legal = String(p["survey"] ?? p["legal_description"] ?? "");
      const abs = String(p["abstract"] ?? p["abstract_no"] ?? "");
      const acres = Number(p["acres"] ?? p["total_acres"] ?? p["permit_acreage"] ?? NaN);
      if (legal || abs) {
        const t = upsertTract({ county: well.countyName, abstractNumber: abs || null, surveyName: legal || null, blockNumber: null, sectionName: null, legalDescription: legal || null, grossAcres: Number.isFinite(acres) ? acres : null },
          "permit_acreage_description", 0.45, `Drilling permit ${p["status_no"] ?? p["permit_no"] ?? ""} for ${well.api14 ?? well.api10} lists this description`);
        if (t) associate(well.id, t, "permit_acreage", 0.45, [{ documentId: null, instrumentId: null, page: null, excerpt: JSON.stringify(p).slice(0, 300), sourceUrl: well.sourceUrls.find(s => s.source === "trrc_permits")?.url ?? null, label: "TRRC W-1 permit query" }]);
      }
    }
    if (well.leaseName) {
      const t = upsertTract({ county: well.countyName, abstractNumber: null, surveyName: null, blockNumber: null, sectionName: null, legalDescription: `Lease/unit: ${well.leaseName}${well.leaseNumber ? ` (RRC lease ${well.leaseNumber})` : ""}`, grossAcres: null },
        "lease_unit_name", 0.25, `TRRC lease/unit name for ${well.api14 ?? well.api10}; a lease name is not a legal tract`);
      if (t) associate(well.id, t, "lease_unit_boundary", 0.25, [{ documentId: null, instrumentId: null, page: null, excerpt: `Lease ${well.leaseName}`, sourceUrl: well.sourceUrls.find(s => s.source === "trrc_ewa")?.url ?? null, label: "TRRC wellbore query" }]);
    }
  }

  // Legal descriptions from W-1 / plat / completion documents.
  for (const d of input.documentLegals) {
    const t = upsertTract({ county: d.tract.county, abstractNumber: d.tract.abstractNumber, surveyName: d.tract.surveyName, blockNumber: d.tract.blockNumber, sectionName: d.tract.sectionName, legalDescription: d.tract.legalDescriptionVerbatim, grossAcres: d.tract.grossAcres },
      `document_${d.category}`, 0.5, `Legal description found in ${d.category.replace(/_/g, " ")} document`);
    if (t && d.wellId) {
      const type: WellTractAssociationType = d.category === "w1_application" ? "permit_acreage" : d.category === "location_plat" ? "surface_location" : "legal_tract";
      associate(d.wellId, t, type, 0.5, [{ documentId: d.documentId, instrumentId: null, page: d.tract.page, excerpt: d.tract.excerpt, sourceUrl: d.sourceUrl, label: d.category.replace(/_/g, " ") }]);
    }
  }

  // Bottomhole: recorded when a permit row states one distinct from the surface survey.
  for (const well of input.wells) {
    for (const p of well.permitRefs) {
      const bh = String(p["bottom_hole_survey"] ?? p["bh_survey"] ?? "");
      if (!bh) continue;
      const t = upsertTract({ county: well.countyName, abstractNumber: null, surveyName: bh, blockNumber: null, sectionName: null, legalDescription: bh, grossAcres: null }, "permit_bottomhole", 0.4, "Bottomhole survey stated on drilling permit");
      if (t) associate(well.id, t, "bottomhole_location", 0.4, [{ documentId: null, instrumentId: null, page: null, excerpt: bh, sourceUrl: null, label: "TRRC W-1 permit query" }]);
    }
  }

  const reviewNeeded = tracts.some(t => t.matchStatus === "proposed");
  return { tracts, associations, reviewNeeded };
}
