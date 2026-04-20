"use client";

import type { NearbyWellIntelligence, NearbyWell } from "@/lib/wells/nearby-wells";

const EM_DASH = "—";

function fmt(n: number | null, decimals = 1): string {
  if (n == null) return EM_DASH;
  return n.toFixed(decimals);
}

function distLabel(miles: number | null): string {
  if (miles == null) return "—";
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

function activityBadge(level: NearbyWellIntelligence["inferred_activity_level"]): {
  bg: string; color: string; border: string; label: string;
} {
  switch (level) {
    case "high":     return { bg: "#dcfce7", color: "#166534", border: "#86efac", label: "High Activity" };
    case "moderate": return { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd", label: "Moderate Activity" };
    case "low":      return { bg: "#fef9c3", color: "#854d0e", border: "#fde047", label: "Low Activity" };
    case "none":     return { bg: "#f3f4f6", color: "#6b7280", border: "#e5e7eb", label: "No Activity Detected" };
  }
}

function confBadge(level: "high" | "medium" | "low"): { bg: string; color: string; border: string } {
  switch (level) {
    case "high":   return { bg: "#dcfce7", color: "#166534", border: "#86efac" };
    case "medium": return { bg: "#dbeafe", color: "#1e40af", border: "#93c5fd" };
    case "low":    return { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" };
  }
}

function statusColor(status: string | null): string {
  if (!status) return "#6b7280";
  const s = status.toLowerCase();
  if (s.includes("produc") || s.includes("active")) return "#16a34a";
  if (s.includes("plug") || s.includes("abandon")) return "#dc2626";
  if (s.includes("permit") || s.includes("drill")) return "#2563eb";
  return "#6b7280";
}

function WellRow({ well }: { well: NearbyWell }) {
  return (
    <tr style={{ borderTop: "1px solid #f3f4f6" }}>
      <td style={{ padding: "0.45rem 0.5rem", fontSize: "0.78rem", fontFamily: "monospace", color: "#374151" }}>
        {well.api}
      </td>
      <td style={{ padding: "0.45rem 0.5rem", fontSize: "0.78rem", color: "#374151", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {well.operator ?? EM_DASH}
      </td>
      <td style={{ padding: "0.45rem 0.5rem", fontSize: "0.78rem", color: "#374151", textAlign: "right" }}>
        {distLabel(well.distance_miles)}
      </td>
      <td style={{ padding: "0.45rem 0.5rem", fontSize: "0.78rem", textAlign: "center" }}>
        <span style={{ color: statusColor(well.status), fontWeight: 500 }}>
          {well.status ?? EM_DASH}
        </span>
      </td>
      <td style={{ padding: "0.45rem 0.5rem", fontSize: "0.78rem", color: "#374151", textAlign: "right" }}>
        {yearLabel(well.first_prod_year)}
      </td>
      <td style={{ padding: "0.45rem 0.5rem", fontSize: "0.78rem", color: "#374151", textAlign: "right", fontWeight: well.latest_bopd ? 600 : 400 }}>
        {bopdLabel(well.latest_bopd)}
      </td>
    </tr>
  );
}

export function NearbyWellsCard({ data }: { data: NearbyWellIntelligence }) {
  const ab = activityBadge(data.inferred_activity_level);
  const locConf = confBadge(data.confidence.location);
  const prodConf = confBadge(data.confidence.production);
  const ownConf = confBadge("low");

  const hasWells = data.wells.length > 0;
  const hasData  = data.data_source != null;
  const locationStr = data.geocode_source !== "none"
    ? `within ${data.radius_miles}-mile radius`
    : "in county";

  return (
    <div className="card" style={{ maxWidth: 680, marginBottom: "1.5rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "0.6rem", gap: "0.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>
          Nearby Well Intelligence
        </h2>
        {data.data_truncated && (
          <span style={{ fontSize: "0.7rem", color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 4, padding: "0.15rem 0.4rem", whiteSpace: "nowrap" }}>
            Data truncated
          </span>
        )}
      </div>

      <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0 0 0.75rem", lineHeight: 1.45 }}>
        Production figures below are inferred from nearby wells — <strong>not confirmed production on this tract</strong>.
        Ownership interest (NRI/WI) is unknown.
      </p>

      {/* Summary line */}
      <div style={{
        background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8,
        padding: "0.6rem 0.75rem", marginBottom: "0.75rem", fontSize: "0.88rem", color: "#111827", fontWeight: 500,
      }}>
        {data.summary}
      </div>

      {/* Badges row: activity + confidence levels */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginBottom: "0.75rem" }}>
        {/* Activity */}
        <span style={{
          fontSize: "0.75rem", fontWeight: 600, padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${ab.border}`, background: ab.bg, color: ab.color,
        }}>
          {ab.label}
        </span>
        {/* Location confidence */}
        <span style={{
          fontSize: "0.75rem", fontWeight: 500, padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${locConf.border}`, background: locConf.bg, color: locConf.color,
        }}>
          Location: {data.confidence.location === "high" ? "High (PLSS)" : "Low (county)"}
        </span>
        {/* Production confidence */}
        <span style={{
          fontSize: "0.75rem", fontWeight: 500, padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${prodConf.border}`, background: prodConf.bg, color: prodConf.color,
        }}>
          Production: {data.confidence.production.charAt(0).toUpperCase() + data.confidence.production.slice(1)}
        </span>
        {/* Ownership — always Low */}
        <span style={{
          fontSize: "0.75rem", fontWeight: 500, padding: "0.2rem 0.55rem", borderRadius: 6,
          border: `1px solid ${ownConf.border}`, background: ownConf.bg, color: ownConf.color,
        }}>
          Ownership: Low
        </span>
      </div>

      {/* Aggregates */}
      {hasWells && (
        <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0.5rem 1rem", marginBottom: "0.75rem" }}>
          {[
            { label: "Wells found", value: `${data.total_count}${locationStr ? ` (${locationStr})` : ""}` },
            { label: "Producing", value: String(data.producing_count) },
            { label: "Median BOPD", value: data.median_bopd != null ? fmt(data.median_bopd) : EM_DASH },
            { label: "Avg BOPD", value: data.avg_bopd != null ? fmt(data.avg_bopd) : EM_DASH },
            { label: "Oldest prod.", value: yearLabel(data.oldest_prod_year) },
            { label: "Newest prod.", value: yearLabel(data.newest_prod_year) },
          ].map(({ label, value }) => (
            <div key={label}>
              <dt style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "0.1rem" }}>{label}</dt>
              <dd style={{ fontSize: "0.9rem", fontWeight: 600, margin: 0 }}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Well table */}
      {hasWells && (
        <div style={{ overflowX: "auto", marginBottom: "0.65rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
                {["API #", "Operator", "Distance", "Status", "First Prod.", "BOPD"].map(h => (
                  <th key={h} style={{
                    padding: "0.3rem 0.5rem", fontSize: "0.72rem", fontWeight: 600,
                    color: "#6b7280", textAlign: h === "API #" || h === "Operator" ? "left" : "right",
                    whiteSpace: "nowrap",
                  }}>
                    {h === "Status" ? <span style={{ display: "block", textAlign: "center" }}>{h}</span> : h}
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

      {/* Unavailable / empty state */}
      {!hasData && (
        <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: "0.5rem 0 0", fontStyle: "italic" }}>
          {data.unavailable_note ?? "Well data not yet available for this state."}
        </p>
      )}
      {hasData && !hasWells && (
        <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: "0.5rem 0 0" }}>
          No wells found {locationStr}. Valuation uses county-level basin benchmarks only.
        </p>
      )}

      {/* Source attribution */}
      {data.data_source && (
        <p style={{ fontSize: "0.72rem", color: "#9ca3af", margin: "0.5rem 0 0" }}>
          Source: {data.data_source.toUpperCase()} well registry
          {data.geocode_source === "plss_blm" ? " · Location: BLM PLSS (authoritative)" : ""}
          {data.geocode_source === "plss_estimated" ? " · Location: PLSS estimate" : ""}
          {data.geocode_source === "none" ? " · Location: county-level only (no PLSS in description)" : ""}
        </p>
      )}
    </div>
  );
}
