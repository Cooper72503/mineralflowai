import { normalizeFormation } from "../trrc/offset-analytics/formation-normalization";
import { fitArpsDecline } from "../trrc/decline-curve";
import { BEG_PRICES } from "./ingestion";
import { sanAndresRozContext } from "../geology/san-andres-roz";
import type {
  CatalogItem,
  Criteria,
  FinderResult,
  FinderSnapshot,
  Offset,
  Production,
  Prospect,
  Purchase,
  Well,
} from "./types";

export const leaseKey = (w: Well): string | null => {
  const a = w.association;
  return a?.district && a.lease && a.leaseType
    ? `${a.district.replace(/^0(?=\d)/, "")}|${a.leaseType}|${a.lease}`
    : null;
};
export function distanceMiles(a: Well, b: Well): number | null {
  if ([a.lat, a.lng, b.lat, b.lng].some((v) => v === null)) return null;
  const r = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat! - a.lat!) / 2) ** 2 +
    Math.cos(r(a.lat!)) *
      Math.cos(r(b.lat!)) *
      Math.sin(r(b.lng! - a.lng!) / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function ageEvidence(
  well: Well,
  catalog: CatalogItem[],
  year: number,
): Prospect["ageEvidence"] | null {
  const dates = well.associations
    .map((a) => a.completionDate)
    .filter((d): d is string => !!d && d < `${year}-01-01`)
    .sort();
  if (dates.length)
    return {
      date: dates[0],
      basis: "completion_upper_bound",
      sourceId: "rrc-wellbore",
    };
  const drill = catalog
    .filter((c) => c.drillDate && c.drillDate < `${year}-01-01`)
    .sort((a, b) => a.drillDate!.localeCompare(b.drillDate!))[0];
  return drill?.drillDate
    ? {
        date: drill.drillDate,
        basis: "catalog_drill_date",
        sourceId: drill.sourceId,
      }
    : null;
}

/** Field-number identity is a reservoir proxy. Never equated with a verified interval. */
export function matchingOffsets(
  w: Well,
  wells: Well[],
  criteria: Criteria,
  production: Map<string, Production>,
): Offset[] {
  const a = w.association;
  const f = a?.fieldName
    ? normalizeFormation(a.fieldName).canonicalFormation
    : "UNKNOWN";
  if (!a?.fieldNumber || /^0+$/.test(a.fieldNumber) || f === "UNKNOWN")
    return [];
  return wells
    .flatMap((other) => {
      if (
        other.api === w.api ||
        other.identityConflict ||
        other.status !== "producing" ||
        !other.association
      )
        return [];
      const b = other.association;
      const distance = distanceMiles(w, other);
      if (
        distance === null ||
        distance > criteria.radiusMiles ||
        a.fieldNumber !== b.fieldNumber ||
        a.district !== b.district
      )
        return [];
      const otherFormation = b.fieldName
        ? normalizeFormation(b.fieldName).canonicalFormation
        : "UNKNOWN";
      if (otherFormation !== f) return [];
      const key = leaseKey(other);
      const p = key ? production.get(key) : null;
      return [
        {
          api: other.api,
          distanceMiles: Math.round(distance * 1000) / 1000,
          match: "field_reservoir_proxy" as const,
          field: a.fieldName!,
          formation: f,
          productionKey: key,
          historicallyProductive:
            p?.status === "success"
              ? p.rows.some((r) => (r.oil ?? 0) > 0 || (r.gas ?? 0) > 0)
              : null,
          reason:
            "Same RRC field number/district and named formation; producing classification. Completion interval, pressure continuity and well-level production allocation remain unverified.",
        },
      ];
    })
    .sort(
      (a, b) => a.distanceMiles - b.distanceMiles || a.api.localeCompare(b.api),
    )
    .slice(0, 10);
}

/** Select one useful subject log; no claim to mathematical VOI or complete coverage. */
export function recommendPurchase(
  items: CatalogItem[],
  pricing: { usd: number | null; checkedAt: string | null },
): Purchase[] {
  const ranked = items
    .filter(
      (c) => c.collection === "GLF" && c.material?.toUpperCase() === "LOG",
    )
    .map((c) => ({
      c,
      utility: /RESIST|INDUCT|DENS|NEUT|SONIC|SPONT|ELECTRIC/i.test(
        c.logTypes ?? "",
      )
        ? 3
        : /GR|GAMMA/i.test(c.logTypes ?? "")
          ? 2
          : 0,
    }))
    .filter(
      (x) =>
        x.utility > 0 &&
        x.c.topFt !== null &&
        x.c.bottomFt !== null &&
        x.c.bottomFt > x.c.topFt,
    )
    .sort(
      (a, b) =>
        b.utility - a.utility ||
        b.c.bottomFt! - b.c.topFt! - (a.c.bottomFt! - a.c.topFt!) ||
        a.c.id.localeCompare(b.c.id),
    );
  const best = ranked[0]?.c;
  if (!best) return [];
  return [
    {
      itemId: best.id,
      api: best.api,
      purpose:
        "Inspect subject-well log to correlate intervals and assess whether further petrophysical work is warranted. The catalog alone does not establish pay.",
      priority: ranked[0].utility,
      estimatedUsd: pricing.usd,
      pricingUrl: BEG_PRICES,
      pricingCheckedAt: pricing.checkedAt,
      approval: "required",
      scope:
        "One preliminary log per subject; verify exact coverage, licensing and availability with BEG before ordering. Core analysis and additional logs are not priced.",
    },
  ];
}

export function screen(
  snapshot: FinderSnapshot,
  criteria: Criteria,
  query: string,
  production = new Map<string, Production>(),
  pricing = { usd: null as number | null, checkedAt: null as string | null },
): FinderResult {
  const catalogByApi = new Map<string, CatalogItem[]>();
  for (const item of snapshot.catalog)
    if (item.api)
      catalogByApi.set(item.api, [...(catalogByApi.get(item.api) ?? []), item]);
  const excluded: Record<string, number> = {};
  const skip = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const prospects: Prospect[] = [];
  for (const w of snapshot.wells) {
    if (w.identityConflict || !w.association) {
      skip("ambiguous_or_missing_association");
      continue;
    }
    const p = production.get(leaseKey(w) ?? "") ?? null;
    const marginal = criteria.marginalBopd !== null && w.status === "producing";
    if (!criteria.statuses.includes(w.status) && !marginal) {
      skip("status_not_selected");
      continue;
    }
    const cat = catalogByApi.get(w.api) ?? [];
    const age = ageEvidence(w, cat, criteria.beforeYear);
    if (!age) {
      skip("age_not_established_before_cutoff");
      continue;
    }
    if (w.lat === null || w.lng === null) {
      skip("location_unavailable");
      continue;
    }
    if (marginal) {
      // Shared lease production cannot establish a particular well is marginal.
      const sameLease = snapshot.wells.filter(
        (other) => leaseKey(other) === leaseKey(w),
      );
      const latest = p?.status === "success" ? p.rows[p.rows.length - 1] : null;
      const days = latest
        ? new Date(
            +latest.month.slice(0, 4),
            +latest.month.slice(5, 7),
            0,
          ).getDate()
        : 0;
      if (
        sameLease.length !== 1 ||
        latest?.oil === null ||
        !latest ||
        latest.oil / days >= criteria.marginalBopd!
      ) {
        skip("marginal_well_rate_not_established");
        continue;
      }
    }
    const formation = normalizeFormation(
      w.association.fieldName ?? "",
    ).canonicalFormation;
    const offsets = matchingOffsets(w, snapshot.wells, criteria, production);
    const purchases = recommendPurchase(cat, pricing);
    const sourceIds = [
      ...w.sources,
      ...(cat.length ? ["beg-catalog"] : []),
      ...(p ? [p.sourceId] : []),
    ];
    const explanation = [
      {
        criterion:
          "Dated evidence establishes the well existed before the cutoff",
        points: 15,
        evidence: [age.sourceId],
      },
      {
        criterion:
          "Requested operating status recorded in the monthly wellbore snapshot",
        points: 10,
        evidence: ["rrc-wellbore"],
      },
      {
        criterion:
          "Nearby producing classifications share RRC field and named formation (proxy)",
        points: offsets.length ? 15 : 0,
        evidence: offsets.length ? ["rrc-wellbore", "rrc-gis"] : [],
      },
      {
        criterion: "Subject geological catalog records available",
        points: cat.length ? 15 : 0,
        evidence: cat.length ? ["beg-catalog"] : [],
      },
      {
        criterion: "Potentially useful subject log identified",
        points: purchases.length ? 10 : 0,
        evidence: purchases.length ? ["beg-catalog"] : [],
      },
      {
        criterion:
          "Reported subject lease production has positive hydrocarbon volumes",
        points:
          p?.status === "success" &&
          p.rows.some((r) => (r.oil ?? 0) > 0 || (r.gas ?? 0) > 0)
            ? 15
            : 0,
        evidence: p ? [p.sourceId] : [],
      },
      {
        criterion: "Positive reported production on at least one offset lease",
        points: offsets.some((o) => o.historicallyProductive) ? 10 : 0,
        evidence: offsets
          .filter((o) => o.historicallyProductive)
          .map((o) => `production:${o.productionKey}`),
      },
    ];
    const gaps = [
      "Producing completion interval and reservoir continuity are unverified.",
      "Porosity, permeability, saturation, pressure and remaining hydrocarbons are unavailable without interpreted geological evidence.",
      "Acquisition price, rights, mechanical integrity, reentry feasibility, workover/capital, plugging liability and operating costs require evidence.",
      ...(cat.length
        ? ["Catalog records have not been read or petrophysically interpreted."]
        : [
            "No matching catalog items in this snapshot; BEG inventory is incomplete.",
          ]),
      ...(p?.status !== "success"
        ? [
            `Lease production unavailable: ${p?.reason ?? "not requested within this pass"}.`,
          ]
        : [
            "Public production is lease level; historical production does not establish recoverable remaining oil.",
          ]),
      ...(!offsets.length
        ? [
            "No compatible field/formation proxy offsets established in the available county snapshot.",
          ]
        : []),
    ];
    let decline: Prospect["decline"] = null;
    // Do not bridge unreported months or fit a stopped lease's restart rate.
    if (
      p?.status === "success" &&
      p.rows.length >= 6 &&
      p.rows.every(
        (r, i, arr) =>
          r.oil !== null &&
          (i === 0 || monthIndex(r.month) === monthIndex(arr[i - 1].month) + 1),
      ) &&
      (p.rows.at(-1)?.oil ?? 0) > 0
    ) {
      const fit = fitArpsDecline(p.rows.map((r) => r.oil!));
      if (fit)
        decline = {
          annualPct: fit.currentAnnualDeclinePct,
          rSquared: fit.rSquared,
        };
    }
    prospects.push({
      api: w.api,
      rank: 0,
      score: explanation.reduce((s, e) => s + e.points, 0),
      label: "research_lead",
      well: w,
      ageEvidence: age,
      formation: formation === "UNKNOWN" ? null : formation,
      formationBasis:
        "Named RRC field text; not a verified producing interval.",
      offsets,
      catalog: cat,
      purchases,
      production: p,
      decline,
      // Published ROZ context for the well's field; it informs review and never enters the score.
      roz: sanAndresRozContext(w.county, w.association?.fieldName ?? null),
      scoreExplanation: explanation,
      gaps,
      risks: [
        "Petroleum geologist review required before any subsurface conclusion.",
        "Plugging, inactivity or lease expiry does not establish mineral, wellbore or operating rights are available.",
        "Title, ownership, surface access, permits and liabilities require independent diligence. Individual plugging filings, compliance history and mechanical integrity are not verified by this bulk-data screen.",
        ...(w.status === "plugged"
          ? [
              "Plugged well: physical reentry may be impossible or uneconomic; plugging records and a mechanical review are required.",
            ]
          : []),
      ],
      geologicalConfidence: "low",
      geologicalAssessment: offsets.length
        ? "A dated historical well has nearby producing classifications in the same RRC field and named formation. This supports targeted research only; bypassed pay and redevelopment potential are not established."
        : "Available evidence supports a historical research lead; geological redevelopment potential is insufficiently established.",
      economics: {
        status: "insufficient_data",
        reason:
          "No supported redevelopment rate, recoverable volume, evaluated ownership interest or complete cost set. Existing production economics must not be applied as a restart forecast.",
      },
      sources: [...new Set(sourceIds)],
    });
  }
  prospects.sort((a, b) => b.score - a.score || a.api.localeCompare(b.api));
  const selected = prospects
    .slice(0, criteria.limit)
    .map((p, i) => ({ ...p, rank: i + 1 }));
  return {
    version: "mineral-finder-v1",
    generatedAt: new Date().toISOString(),
    query,
    criteria,
    sources: snapshot.sources,
    wells: snapshot.wells.length,
    eligible: prospects.length,
    excluded,
    prospects: selected,
    purchases: [
      ...new Map(
        selected.flatMap((p) => p.purchases).map((p) => [p.itemId, p]),
      ).values(),
    ],
    classification: "research_screening",
    countyCoverageComplete: false,
    warnings: [
      "Research priority score measures evidence for follow-up, not probability of commercial success or expected investment return. Maximum reachable score is 90; verified reservoir and commercial evidence are intentionally not scored.",
      "County snapshots do not include all offset wells across county boundaries, every completion, pre-1993 production, or uncataloged BEG holdings.",
      "A completion before the cutoff proves earlier existence; it does not supply an exact drilling date. Later completion dates cannot prove a well was drilled later.",
      "Source record counts are not prospect counts. No discoveries, reserves, title clearance, buy recommendation or acquisition rights are asserted.",
      ...snapshot.sources.flatMap((s) =>
        s.status !== "success"
          ? [`${s.provider}: ${s.warnings.join(" ")}`]
          : [],
      ),
      ...(criteria.marginalBopd !== null
        ? [
            "Marginal classification requires positive current well evidence and a single-well production association; shared lease volumes cannot qualify individual marginal wells.",
          ]
        : []),
    ],
  };
}
function monthIndex(m: string) {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
}
