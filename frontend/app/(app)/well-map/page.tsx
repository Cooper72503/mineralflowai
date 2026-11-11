"use client";

import dynamic from "next/dynamic";

// Leaflet touches `window` when it loads, so the map renders in the browser only.
const WellMap = dynamic(() => import("./WellMap"), { ssr: false, loading: () => <div style={{ height: "100vh", background: "#0f1117" }} /> });

export default function WellMapPage() {
  return <WellMap />;
}
