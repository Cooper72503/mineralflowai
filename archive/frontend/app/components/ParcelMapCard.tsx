"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Leaflet must never render on the server — dynamic import with ssr: false
const ParcelMapInner = dynamic(() => import("./ParcelMapInner"), {
  ssr: false,
  loading: () => (
    <div style={{
      height: 360, borderRadius: 8,
      background: "#f3f4f6",
      display: "flex", alignItems: "center", justifyContent: "center",
      color: "#9ca3af", fontSize: "0.85rem",
    }}>
      Loading map…
    </div>
  ),
});

export type ParcelMapCardProps = {
  township?: string | null;
  range?: string | null;
  section?: string | null;
  state?: string | null;
  county?: string | null;
  label?: string | null;
};

type Centroid = { lat: number; lng: number; label: string; source: string };

export function ParcelMapCard({ township, range, section, state, county, label }: ParcelMapCardProps) {
  const [centroid, setCentroid] = useState<Centroid | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    if (!township || !range) return;
    let cancelled = false;

    async function resolve() {
      setLoading(true);
      setError(null);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const params = new URLSearchParams({ township: township!, range: range! });
      if (section) params.set("section", section);
      if (state)   params.set("state", state);

      try {
        const res = await fetch(`/api/plss-centroid?${params}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const body = await res.json();
        if (!cancelled) {
          if (body.error) setError(body.error);
          else setCentroid(body as Centroid);
        }
      } catch {
        if (!cancelled) setError("Map unavailable.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    resolve();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [township, range, section, state]);

  // Don't render card if no PLSS to resolve
  if (!township || !range) return null;

  const displayLabel = label ??
    [
      section ? `Section ${section}` : null,
      township ? `T${township}` : null,
      range    ? `R${range}` : null,
      county,
      state,
    ].filter(Boolean).join(", ");

  return (
    <div className="card" style={{ maxWidth: 720, marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>Parcel Location</h2>
        {centroid && (
          <span style={{ fontSize: "0.72rem", color: "#6b7280", background: "#f3f4f6", padding: "0.15rem 0.5rem", borderRadius: 4 }}>
            {centroid.source === "blm" ? "BLM PLSS" : "Estimated"}
          </span>
        )}
      </div>

      <p style={{ fontSize: "0.82rem", color: "#6b7280", marginBottom: "0.75rem", margin: "0 0 0.75rem" }}>
        {displayLabel}
      </p>

      {loading ? (
        <div style={{
          height: 360, borderRadius: 8,
          background: "#f3f4f6",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#9ca3af", fontSize: "0.85rem",
        }}>
          Resolving location…
        </div>
      ) : error ? (
        <div style={{
          padding: "1rem", borderRadius: 8,
          background: "#f9fafb", border: "1px solid #e5e7eb",
          color: "#9ca3af", fontSize: "0.85rem",
        }}>
          Location unavailable — PLSS coordinates could not be resolved.
        </div>
      ) : centroid ? (
        <ParcelMapInner
          lat={centroid.lat}
          lng={centroid.lng}
          label={centroid.label || displayLabel}
          source={centroid.source}
        />
      ) : null}
    </div>
  );
}
