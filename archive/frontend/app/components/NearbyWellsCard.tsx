"use client";

import type { NearbyWellIntelligence, NearbyWell } from "@/lib/wells/nearby-wells";

const EM_DASH = "—";

function fmt(n: number | null, decimals = 1): string {
  if (n == null) return EM_DASH;
  return n.toFixed(decimals);
}

function distLabel(miles: number | null): string {
  if (miles == null) return EM_DASH;
  return `${miles.toFixed(1)} mi`;
}

function bopdLabel(bopd: number | null): string {
  if (bopd == null || bopd === 0) return EM_DASH;
  return `${bopd.toFixed(1)} BOPD`;
}

function yearLabel(year: number | null): string {
  if (year == null) return EM_DASH;
  return String(year);
}

function statusColor(status: string | null): string {
  if (!status) return "#6b7280";
  const s = status.toLowerCase();
  if (s.includes("produc") || s.includes("active")) return "#16a34a";
  if (s.includes("plug") || s.includes("abandon")) return "#dc2626";
  if (s.includes("permit") || s.includes("drill")) return "#2563eb";
  return "#6b7280";
}

function dataSourceLabel(source: string | null): string {
  switch (source) {
    case "ndic":  return "North Dakota NDIC geospatial well registry";
    case "trrc":  return "Texas RRC geospatial screening";
    case "occ":   return "Oklahoma Corporation Commission well registry";
    case "wvdep": return "West Virginia DEP well registry";
    case "odnr":  return "Ohio DNR well registry";
    case "cogcc": return "Colorado COGCC well registry";
    default:      return source ? `${source.toUpperCase()} well registry` : "State well registry";
  }
}

function activityBadge(
  level: NearbyWellIntelligence["inferred_activity_level"],
  producingCount: number,
  total: number,
): { bg: string; color: string; border: string; label: string } {
  switch (level) {
    case "high":
      return { bg: "#dcfce7", color: "#166534", border: "#86efac",
        label: `High Activity · ${producingCount} producing wells` };
    case "moderate":
      return { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd",
        label: `Moderate Activity · ${producingCount} producing` };
    case "low":
      return { bg: "#fef9c3", color: "#854d0e", border: "#fde047",
        label: total > 0
          ? `Low Activity · ${producingCount} of ${total} producing`
          : "Low Activity · No producers detected" };
    case "none":
      return { bg: "#f3f4f6", color: "#6b7280", border: "#e5e7eb",
        label: "No Nearby Activity Detected" };
  }
}

function prodConfLabel(level: "high" | "medium" | "low", bopdCount: number, wellCount: number): string {
  if (level === "high")   return `Production: ${bopdCount}+ wells with rate data`;
  if (level === "medium") return `Production: ${bopdCount} wells with rate data`;
  if (wellCount > 0)      return "Production: wells located, rates limited";
  return "Production: no nearby wells";
}

function confBadge(level: "high" | "medium" | "low"): { bg: string; color: string; border: string } {
  switch (level) {
    case "high":   return { bg: "#dcfce7", color: "#166534", border: "#86efac" };
    case "medium": return { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" };
    case "low":    return { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" };
  }
}

function MetricCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ minWidth: 95 }}>
      <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.1rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: "0.92rem", fontWeight: 700, color: "#111827" }}>{value}</div>
      {sub && <div style={{ fontSize: "0.68rem", color: "#6b7280", marginTop: "0.08rem" }}>{sub}</div>}
    </div>
  );
}

function WellRow({ well }: { well: NearbyWell }) {
  return (
    <tr style={{ borderTop: "1px solid #f3f4f6" }}>
      <td style={{ padding: "0.4rem 0.5rem", fontSize: "0.74rem", fontFamily: "monospace", color: "#374151" }}>
        {well.api}
      </td>
      <td style={{ padding: "0.4rem 0.5rem", fontSize: "0.74rem", color: "#374151", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {well.operator ?? EM_DASH}
      </td>
      <td style={{ padding: "0.4rem 0.5rem", fontSize: "0.74rem", color: "#374151", textAlign: "right" }}>
        {distLabel(well.distance_miles)}
      </td>
      <td style={{ padding: "0.4rem 0.5rem", fontSize: "0.74rem", textAlign: "center" }}>
        <span style={{ color: statusColor(well.status), fontWeight: 500 }}>
          {well.status ?? EM_DASH}
        </span>
      </td>
      <td style={{ padding: "0.4rem 0.5rem", fontSize: "0.74rem", color: "#374151", textAlign: "right" }}>
        {yearLabel(well.first_prod_year)}
      </td>
      <td style={{ padding: "0.4rem 0.5rem", fontSize: "0.74rem", textAlign: "right",
        fontWeight: well.latest_bopd ? 600 : 400, color: well.latest_bopd ? "#111827" : "#9ca3af" }}>
        {bopdLabel(well.latest_bopd)}
      </td>
    </tr>
  );
}

export function NearbyWellsCard({ data }: { data: NearbyWellIntelligence }) {
  const hasWells  = data.wells.length > 0;
  const hasData   = data.data_source != null;
  const bopdCount = data.wells.filter(w => w.latest_bopd != null && w.latest_bopd > 0).length;
  const ab        = activityBadge(data.inferred_activity_level, data.producing_count, data.total_count);
  const prodConf  = confBadge(data.confidence.production);
  const locConf   = confBadge(data.confidence.location);

  const locationLabel = data.geocode_source !== "none"
    ? `${data.radius_miles}-mile radius`
    : "county-level";

  const bopdRangeStr = (() => {
    if (data.min_bopd == null) return null;
    if (data.max_bopd != null && Math.abs(data.max_bopd - data.min_bopd) > 0.5) {
      return `${fmt(data.min_bopd)}–${fmt(data.max_bopd)} BOPD`;
    }
    return `${fmt(data.median_bopd ?? data.avg_bopd)} BOPD`;
  })();

  return (
    <div className="card" style={{ maxWidth: 700, marginBottom: "1.5rem" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "0.5rem", gap: "0.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>
          Nearby Well Intelligence
        </h2>
        {data.data_truncated && (
          <span style={{ fontSize: "0.7rem", color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 4, padding: "0.15rem 0.4rem", whiteSpace: "nowrap" }}>
            Results truncated
          </span>
        )}
      </div>

      {/* Disclaimer — always visible */}
      <p style={{ fontSize: "0.78rem", color: "#6b7280", margin: "0 0 0.85rem", lineHeight: 1.45 }}>
        Production figures are <strong>inferred from nearby wells</strong> and are{" "}
        <strong>not confirmed production on this tract</strong>.
        Ownership interest (NRI/WI) and exact tract production are unknown.
      </p>

      {/* ── EVIDENCE FIRST: metrics grid ── */}
      {hasWells && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
          gap: "0.7rem 1.1rem",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: "0.7rem 0.9rem",
          marginBottom: "0.8rem",
        }}>
          <MetricCell label="Wells found" value={String(data.total_count)} sub={locationLabel} />
          <MetricCell label="Producing" value={`${data.producing_count} of ${data.total_count}`} />
          {data.nearest_well_miles != null && (
            <MetricCell
              label="Closest well"
              value={`${data.nearest_well_miles.toFixed(1)} mi`}
              sub={data.operators[0] ?? undefined}
            />
          )}
          {bopdRangeStr && (
            <MetricCell
              label="BOPD range"
              value={bopdRangeStr}
              sub={data.median_bopd != null ? `median ${fmt(data.median_bopd)}` : undefined}
            />
          )}
          {data.oldest_prod_year != null && (
            <MetricCell
              label="Active since"
              value={String(data.oldest_prod_year)}
              sub={data.newest_prod_year != null && data.newest_prod_year !== data.oldest_prod_year
                ? `latest: ${data.newest_prod_year}` : undefined}
            />
          )}
          {data.operators.length > 0 && data.nearest_well_miles == null && (
            <MetricCell
              label="Operators"
              value={data.operators[0]}
              sub={data.operators.length > 1 ? `+${data.operators.length - 1} more` : undefined}
            />
          )}
        </div>
      )}

      {/* No wells but nearest found outside radius */}
      {!hasWells && data.nearest_outside_miles != null && (
        <div style={{
          background: "#fef9c3", border: "1px solid #fde047", borderRadius: 8,
          padding: "0.55rem 0.8rem", marginBottom: "0.75rem",
          fontSize: "0.82rem", color: "#854d0e", lineHeight: 1.45,
        }}>
          <strong>No wells within {data.radius_miles}-mile search radius.</strong>
          {" "}Nearest detected activity: <strong>{data.nearest_outside_miles.toFixed(1)} mi</strong>
          {data.nearest_outside_bopd != null
            ? ` (${data.nearest_outside_bopd.toFixed(1)} BOPD)`
            : " (production data unavailable)"}
          {" "}— low nearby production potential.
        </div>
      )}

      {/* ── INTERPRETATION: summary sentence ── */}
      <div style={{
        background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8,
        padding: "0.55rem 0.75rem", marginBottom: "0.75rem",
        fontSize: "0.86rem", color: "#111827", lineHeight: 1.5,
      }}>
        {data.summary}
      </div>

      {/* Confidence + activity badges */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
        <span style={{
          fontSize: "0.71rem", fontWeight: 600, padding: "0.17rem 0.5rem", borderRadius: 6,
          border: `1px solid ${ab.border}`, background: ab.bg, color: ab.color,
        }}>
          {ab.label}
        </span>
        <span style={{
          fontSize: "0.71rem", fontWeight: 500, padding: "0.17rem 0.5rem", borderRadius: 6,
          border: `1px solid ${locConf.border}`, background: locConf.bg, color: locConf.color,
        }}>
          Location: {data.confidence.location === "high" ? "High — PLSS geocoded" : "Low — county-level only"}
        </span>
        <span style={{
          fontSize: "0.71rem", fontWeight: 500, padding: "0.17rem 0.5rem", borderRadius: 6,
          border: `1px solid ${prodConf.border}`, background: prodConf.bg, color: prodConf.color,
        }}>
          {prodConfLabel(data.confidence.production, bopdCount, data.total_count)}
        </span>
        <span style={{
          fontSize: "0.71rem", fontWeight: 500, padding: "0.17rem 0.5rem", borderRadius: 6,
          border: "1px solid #fcd34d", background: "#fef3c7", color: "#92400e",
        }}>
          NRI/WI: Not confirmed
        </span>
      </div>

      {/* Well table */}
      {hasWells && (
        <div style={{ overflowX: "auto", marginBottom: "0.65rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
                {[
                  { h: "API #",       align: "left"   },
                  { h: "Operator",    align: "left"   },
                  { h: "Distance",    align: "right"  },
                  { h: "Status",      align: "center" },
                  { h: "First Prod.", align: "right"  },
                  { h: "BOPD",        align: "right"  },
                ].map(({ h, align }) => (
                  <th key={h} style={{
                    padding: "0.28rem 0.5rem",
                    fontSize: "0.68rem", fontWeight: 600, color: "#6b7280",
                    textAlign: align as "left" | "right" | "center",
                    whiteSpace: "nowrap",
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.wells.map(w => <WellRow key={w.api} well={w} />)}
            </tbody>
          </table>
        </div>
      )}

      {/* No data / empty states */}
      {!hasData && (
        <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: "0.5rem 0 0", fontStyle: "italic" }}>
          {data.unavailable_note ?? "Well data not yet available for this state."}
        </p>
      )}
      {hasData && !hasWells && data.nearest_outside_miles == null && (
        <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: "0.5rem 0 0" }}>
          No wells found {data.geocode_source !== "none"
            ? `within ${data.radius_miles}-mile search radius`
            : "in county well registry"}.
          Valuation uses county-level basin benchmarks only.
        </p>
      )}

      {/* BOPD estimation disclosure */}
      {data.data_source && data.data_source !== "trrc" && hasWells && data.avg_bopd != null && (
        <p style={{ fontSize: "0.69rem", color: "#9ca3af", margin: "0.4rem 0 0", lineHeight: 1.4 }}>
          BOPD values derived from cumulative production ÷ age-adjusted decline model — directional estimate only.
        </p>
      )}

      {/* Data source — confident phrasing */}
      {data.data_source && (
        <p style={{ fontSize: "0.69rem", color: "#9ca3af", margin: "0.3rem 0 0" }}>
          Data source: {dataSourceLabel(data.data_source)}
          {data.geocode_source === "plss_blm"       ? " · Location: BLM PLSS (authoritative)" : ""}
          {data.geocode_source === "plss_estimated"  ? " · Location: PLSS estimate (±1–2 mi)" : ""}
          {data.geocode_source === "none"            ? " · Search: county-level (no PLSS coordinates)" : ""}
        </p>
      )}
    </div>
  );
}
