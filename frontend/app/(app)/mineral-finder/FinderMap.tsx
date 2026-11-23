"use client";
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Prospect } from "@/lib/mineral-finder/types";
import { COLORS } from "../trrc-due-diligence/colors";

const ACCENT = COLORS.accent;

/** Same Leaflet/OSM stack as the existing Well Map; no invented geometry. */
export default function FinderMap({ prospects, selected, radius }: { prospects: Prospect[]; selected: string | null; radius: number }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const map = L.map(root.current).setView([32.76, -102.65], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors | Well locations: Texas RRC" }).addTo(map);
    const bounds: L.LatLngTuple[] = [];
    for (const p of prospects) {
      if (p.well.lat === null || p.well.lng === null) continue;
      const xy: L.LatLngTuple = [p.well.lat, p.well.lng]; bounds.push(xy);
      const popup = document.createElement("div"); popup.textContent = `${p.api} · ${p.well.status} · research score ${p.score}`;
      L.circleMarker(xy, { radius: p.api === selected ? 10 : 6, color: p.api === selected ? "#ffffff" : ACCENT, fillColor: ACCENT, fillOpacity: 0.9 }).addTo(map).bindPopup(popup);
      if (p.api === selected) L.circle(xy, { radius: radius * 1609.344, color: ACCENT, weight: 1, fillOpacity: 0.04 }).addTo(map);
    }
    if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 13 });
    return () => { map.remove(); };
  }, [prospects, selected, radius]);
  return <div ref={root} style={{ height: 390, borderRadius: 10, overflow: "hidden", border: `1px solid ${COLORS.border}`, background: COLORS.surfaceAlt, marginBottom: "1rem" }} aria-label="Map of real prospect well locations" />;
}
