"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix Leaflet's default marker icon broken by webpack asset hashing
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function RecenterMap({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], 10);
  }, [lat, lng, map]);
  return null;
}

type Props = {
  lat: number;
  lng: number;
  label: string;
  source: string;
};

export default function ParcelMapInner({ lat, lng, label, source }: Props) {
  return (
    <div style={{ height: 360, borderRadius: 8, overflow: "hidden", position: "relative" }}>
      <MapContainer
        center={[lat, lng]}
        zoom={10}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[lat, lng]}>
          <Popup>{label}</Popup>
        </Marker>
        <RecenterMap lat={lat} lng={lng} />
      </MapContainer>
      {source === "estimated" && (
        <div style={{
          position: "absolute", bottom: 8, left: 8, zIndex: 1000,
          background: "rgba(255,255,255,0.9)",
          padding: "0.2rem 0.5rem",
          borderRadius: 4,
          fontSize: "0.7rem",
          color: "#92400e",
          border: "1px solid #fcd34d",
        }}>
          ⚠ Estimated location — verify against county GIS
        </div>
      )}
    </div>
  );
}
