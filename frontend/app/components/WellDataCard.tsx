"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { WellSummary, WellLookupResult } from "@/lib/wells/well-types";

type Props = {
  county: string | null;
  state: string | null;
  township?: string | null;
  range?: string | null;
};

function fmt(n: number | null): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: "#9ca3af" }}>—</span>;
  const s = status.toLowerCase();
  const isActive = s.includes("active") || s.includes("producing") || s.includes("prod");
  const isClosed = s.includes("abandon") || s.includes("plugged") || s.includes("inactive");
  return (
    <span style={{
      display: "inline-block",
      fontSize: "0.72rem",
      fontWeight: 600,
      padding: "0.1rem 0.4rem",
      borderRadius: 4,
      background: isActive ? "#dcfce7" : isClosed ? "#fee2e2" : "#f3f4f6",
      color: isActive ? "#14532d" : isClosed ? "#7f1d1d" : "#374151",
    }}>
      {status}
    </span>
  );
}

export function WellDataCard({ county, state, township, range }: Props) {
  const [result, setResult] = useState<WellLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    if (!county || !state) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const params = new URLSearchParams({ county: county ?? "", state: state ?? "" });
      if (township) params.set("township", township);
      if (range)    params.set("range", range);

      try {
        const res = await fetch(`/api/wells/lookup?${params}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!cancelled) {
          const body = await res.json();
          setResult(body);
        }
      } catch {
        // silently fail — well data is supplementary
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [county, state, township, range]);

  // Don't render anything until we have a county/state to query
  if (!county || !state) return null;

  if (loading) {
    return (
      <div className="card" style={{ maxWidth: 720, marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          Well Data
        </h2>
        <p style={{ fontSize: "0.85rem", color: "#9ca3af" }}>Fetching well data…</p>
      </div>
    );
  }

  if (!result) return null;

  const isUnavailable = result.source === "unavailable";
  const wells: WellSummary[] = result.wells ?? [];

  return (
    <div className="card" style={{ maxWidth: 720, marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.6rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>Well Data</h2>
        {!isUnavailable && (
          <span style={{ fontSize: "0.72rem", color: "#6b7280", background: "#f3f4f6", padding: "0.15rem 0.5rem", borderRadius: 4, fontWeight: 600 }}>
            {result.source.toUpperCase()} · {result.query_description}
          </span>
        )}
      </div>

      {isUnavailable ? (
        <p style={{ fontSize: "0.85rem", color: "#9ca3af", margin: 0 }}>
          {result.note ?? "Well data unavailable for this location."}
        </p>
      ) : wells.length === 0 ? (
        <p style={{ fontSize: "0.85rem", color: "#9ca3af", margin: 0 }}>
          No wells found in county via public records.
        </p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: "0.8rem", width: "100%" }}>
              <thead>
                <tr>
                  {["Well Name", "Operator", "Status", "Formation", "Spud Date", "Cum Oil (BBL)"].map((h) => (
                    <th key={h} style={{
                      padding: "0.3rem 0.5rem", textAlign: "left",
                      fontSize: "0.72rem", color: "#6b7280", fontWeight: 500,
                      borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wells.slice(0, 15).map((w) => (
                  <tr key={w.api} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "0.3rem 0.5rem", fontWeight: 500, color: "#111827", whiteSpace: "nowrap" }}>
                      {w.well_name}
                    </td>
                    <td style={{ padding: "0.3rem 0.5rem", color: "#374151", whiteSpace: "nowrap" }}>
                      {w.operator ?? "—"}
                    </td>
                    <td style={{ padding: "0.3rem 0.5rem" }}>
                      <StatusBadge status={w.status} />
                    </td>
                    <td style={{ padding: "0.3rem 0.5rem", color: "#374151" }}>
                      {w.formation ?? "—"}
                    </td>
                    <td style={{ padding: "0.3rem 0.5rem", color: "#374151", whiteSpace: "nowrap" }}>
                      {w.spud_date ?? "—"}
                    </td>
                    <td style={{ padding: "0.3rem 0.5rem", color: "#374151", textAlign: "right" }}>
                      {fmt(w.cum_oil_bbl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: "0.73rem", color: "#9ca3af", marginTop: "0.5rem", marginBottom: 0 }}>
            Showing up to 15 wells in county. Data from {result.source.toUpperCase()} public records.
            Monthly production data and proximity filtering coming soon.
          </p>
        </>
      )}
    </div>
  );
}
