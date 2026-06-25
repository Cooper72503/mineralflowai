"use client";

import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Circle, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix Leaflet default icon broken by webpack asset hashing
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

type PeerWell = {
  api:              string;
  lat:              number;
  lng:              number;
  distance_mi:      number;
  direction:        string;
  peak_month_bbl:   number;
  eur_bbl:          number | null;
  decline_annual_pct: number | null;
  is_active:        boolean;
  first_prod_year:  number | null;
};

type Props = {
  subjectLat:   number;
  subjectLng:   number;
  subjectApi:   string;
  subjectEur:   number | null;
  subjectIp:    number | null;
  peerWells:    PeerWell[];
  radiusMiles:  number;
  p50Eur:       number | null;
};

// ── Custom SVG icons ──────────────────────────────────────────────────────────

function makeCircleIcon(color: string, size = 14): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2px solid rgba(255,255,255,0.8);
      box-shadow:0 1px 4px rgba(0,0,0,0.5);
    "></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

function makeStarIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="
      width:22px;height:22px;
      background:#f59e0b;
      border:2.5px solid #fff;
      border-radius:4px;
      box-shadow:0 2px 6px rgba(0,0,0,0.7);
      display:flex;align-items:center;justify-content:center;
      font-size:13px;line-height:1;
    ">★</div>`,
    iconSize:   [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -14],
  });
}

function peerColor(eur: number | null, p50: number | null): string {
  if (eur == null || p50 == null) return "#6b7280"; // gray — no DCA
  if (eur >= p50 * 1.25) return "#22c55e";           // green — top
  if (eur >= p50 * 0.75) return "#f59e0b";           // yellow — median band
  return "#ef4444";                                   // red — below median
}

function FitBounds({ lat, lng, radiusMiles }: { lat: number; lng: number; radiusMiles: number }) {
  const map = useMap();
  useEffect(() => {
    const radiusMeters = radiusMiles * 1609.34;
    const bounds = L.latLng(lat, lng).toBounds(radiusMeters * 2.4);
    map.fitBounds(bounds, { padding: [20, 20] });
  }, [lat, lng, radiusMiles, map]);
  return null;
}

export default function WellGisMapInner({
  subjectLat, subjectLng, subjectApi, subjectEur, subjectIp,
  peerWells, radiusMiles, p50Eur,
}: Props) {
  const starIcon   = useMemo(() => makeStarIcon(), []);
  const radiusMeters = radiusMiles * 1609.34;

  return (
    <div style={{ height: 420, borderRadius: 8, overflow: "hidden", position: "relative", border: "1px solid rgba(255,255,255,0.08)" }}>
      <MapContainer
        center={[subjectLat, subjectLng]}
        zoom={11}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* 5-mile search radius ring */}
        <Circle
          center={[subjectLat, subjectLng]}
          radius={radiusMeters}
          pathOptions={{ color: "#4f8ef7", weight: 1.5, fillOpacity: 0.04, dashArray: "6 4" }}
        />

        {/* Peer wells */}
        {peerWells.map(w => {
          const color = peerColor(w.eur_bbl, p50Eur);
          const icon  = makeCircleIcon(color);
          const bopdStr = w.peak_month_bbl > 0 ? `${Math.round(w.peak_month_bbl / 30)} BOPD` : "No rate";
          return (
            <Marker key={w.api} position={[w.lat, w.lng]} icon={icon}>
              <Popup>
                <div style={{ fontSize: "0.8rem", lineHeight: 1.5, minWidth: 170 }}>
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>API {w.api}</div>
                  <div style={{ color: "#6b7280" }}>{w.distance_mi} mi {w.direction}</div>
                  <div>Peak: {w.peak_month_bbl.toLocaleString()} BBL/mo ({bopdStr})</div>
                  {w.eur_bbl != null && <div>EUR: {w.eur_bbl.toLocaleString()} BBL</div>}
                  {w.decline_annual_pct != null && <div>Decline: {w.decline_annual_pct}%/yr</div>}
                  {w.first_prod_year && <div>First prod: {w.first_prod_year}</div>}
                  <div style={{ color: w.is_active ? "#16a34a" : "#9ca3af" }}>{w.is_active ? "Active" : "Inactive"}</div>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Subject well — rendered last so it's on top */}
        <Marker position={[subjectLat, subjectLng]} icon={starIcon}>
          <Popup>
            <div style={{ fontSize: "0.8rem", lineHeight: 1.5, minWidth: 170 }}>
              <div style={{ fontWeight: 700, color: "#d97706", marginBottom: 2 }}>SUBJECT WELL</div>
              <div style={{ fontFamily: "monospace" }}>API {subjectApi}</div>
              {subjectIp != null && <div>Peak: {subjectIp.toLocaleString()} BBL/mo</div>}
              {subjectEur != null && <div>EUR: {subjectEur.toLocaleString()} BBL</div>}
            </div>
          </Popup>
        </Marker>

        <FitBounds lat={subjectLat} lng={subjectLng} radiusMiles={radiusMiles} />
      </MapContainer>

      {/* Legend */}
      <div style={{
        position: "absolute", bottom: 10, right: 10, zIndex: 1000,
        background: "rgba(15,17,23,0.88)", backdropFilter: "blur(4px)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 6, padding: "0.5rem 0.65rem",
        fontSize: "0.7rem", color: "#e2e8f0", lineHeight: 1.8,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 2, color: "#8892a4" }}>LEGEND</div>
        <div><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#f59e0b", marginRight: 5, verticalAlign: "middle" }} />Subject well</div>
        <div><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#22c55e", marginRight: 5, verticalAlign: "middle" }} />Peer ≥ P50 EUR</div>
        <div><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#f59e0b", marginRight: 5, verticalAlign: "middle" }} />Peer near P50</div>
        <div><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#ef4444", marginRight: 5, verticalAlign: "middle" }} />Peer &lt; P50 EUR</div>
        <div><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#6b7280", marginRight: 5, verticalAlign: "middle" }} />No DCA data</div>
        <div style={{ color: "#4f8ef7", marginTop: 2 }}>--- {radiusMiles}-mile search radius</div>
      </div>
    </div>
  );
}
