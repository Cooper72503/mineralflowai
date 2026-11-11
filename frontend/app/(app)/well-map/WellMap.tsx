"use client";

/**
 * Well map: TRRC's own well, lateral and survey layers over a base map.
 * Click a well (or search an API) to see its lease, operator, field and
 * the lease's monthly production since 1993.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import Link from "next/link";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import { exportImageUrl, formatApi, metresPerPixel, wellsNear, wellByApi, api8From, MIN_WELL_ZOOM, type GisWell } from "@/lib/trrc/well-map/gis";
import { COLORS } from "../trrc-due-diligence/colors";

// One constant to swap for a licensed tile service before customer use.
const BASEMAP = { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors" };
const START = { lat: 31.95, lng: -102.1, zoom: 10 }; // Midland Basin

interface ProductionRow { productionMonth: string; oilBbl: number | null; gasMcf: number | null; casingheadGasMcf: number | null; condensateBbl: number | null }
interface WellDetail {
  api8: string;
  lease: { leaseNumber: string; district: string; fieldName: string | null; operatorName: string | null; leaseName?: string | null; wellNumber?: string | null } | null;
  production: { found: boolean; leaseType: "oil" | "gas"; rows: ProductionRow[]; warnings: string[] } | null;
  note: string;
}

/** TRRC's layers as one image of the view, replaced after each pan or zoom; the old image stays until the new one has loaded. */
function attachTrrcOverlay(m: L.Map): () => void {
  let current: L.ImageOverlay | null = null, seq = 0;
  const refresh = () => {
    if (m.getZoom() < 8) { current?.remove(); current = null; return; }
    const b = m.getBounds(), size = m.getSize(), crs = L.CRS.EPSG3857;
    const sw = crs.project(b.getSouthWest()), ne = crs.project(b.getNorthEast());
    const url = exportImageUrl([sw.x, sw.y, ne.x, ne.y], size.x, size.y);
    const mine = ++seq;
    const next = L.imageOverlay(url, b, { opacity: 0, interactive: false, attribution: "Wells and surveys: Railroad Commission of Texas" }).addTo(m);
    next.once("load", () => { if (mine !== seq) { next.remove(); return; } next.setOpacity(0.95); current?.remove(); current = next; });
    next.once("error", () => next.remove());
  };
  m.on("moveend", refresh);
  refresh();
  return () => { m.off("moveend", refresh); current?.remove(); };
}

const oilOf = (r: ProductionRow) => (r.oilBbl ?? 0) + (r.condensateBbl ?? 0);
const gasOf = (r: ProductionRow) => (r.gasMcf ?? 0) + (r.casingheadGasMcf ?? 0);
const reported = (r: ProductionRow) => [r.oilBbl, r.gasMcf, r.casingheadGasMcf, r.condensateBbl].some(v => v !== null);
const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTH[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export default function WellMap() {
  const apiFetch = useApiFetch();
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const [zoom, setZoom] = useState(START.zoom);
  const [candidates, setCandidates] = useState<GisWell[]>([]);
  const [selected, setSelected] = useState<GisWell | null>(null);
  const [detail, setDetail] = useState<WellDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const select = useCallback(async (w: GisWell, fly = false) => {
    setSelected(w); setCandidates([]); setDetail(null); setError(null); setLoading("Reading TRRC's records for this well…");
    const m = map.current;
    if (m) {
      marker.current?.remove();
      marker.current = L.circleMarker([w.lat, w.lng], { radius: 11, color: COLORS.accent, weight: 3, fill: false }).addTo(m);
      if (fly) m.flyTo([w.lat, w.lng], Math.max(m.getZoom(), 15), { duration: 0.8 });
    }
    try {
      const res = await apiFetch(`/api/trrc/well-map/well?api=${w.api8}`);
      const body = await res.json();
      if (!body.ok) throw Error(body.error ?? "The well could not be loaded.");
      setDetail(body.data);
    } catch (e) { setError(e instanceof Error ? e.message : "The well could not be loaded."); }
    finally { setLoading(null); }
  }, [apiFetch]);

  // The map, once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, preferCanvas: true }).setView([START.lat, START.lng], START.zoom);
    L.tileLayer(BASEMAP.url, { attribution: BASEMAP.attribution, maxZoom: 19 }).addTo(m);
    const detach = attachTrrcOverlay(m);
    m.on("zoomend", () => setZoom(m.getZoom()));
    map.current = m;
    return () => { detach(); m.remove(); map.current = null; };
  }, []);

  // Clicks: the wells under the pointer.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const onClick = async (e: L.LeafletMouseEvent) => {
      if (m.getZoom() < MIN_WELL_ZOOM) { setError("Zoom in to pick a well."); return; }
      setError(null); setLoading("Finding wells here…");
      try {
        const radius = Math.max(15, metresPerPixel(e.latlng.lat, m.getZoom()) * 10);
        const found = await wellsNear(e.latlng.lat, e.latlng.lng, radius);
        if (!found.length) { setError("No well at that spot. Click a well symbol."); setCandidates([]); return; }
        if (found.length === 1 || found[0].distanceM! < radius / 4) await select(found[0]);
        else setCandidates(found.slice(0, 8));
      } catch (err) { setError(err instanceof Error ? err.message : "TRRC's map service did not answer."); }
      finally { setLoading(l => l === "Finding wells here…" ? null : l); }
    };
    m.on("click", onClick);
    return () => { m.off("click", onClick); };
  }, [select]);

  const search = async () => {
    const q = query.trim();
    const coords = /^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{2,3}\.\d+)$/.exec(q);
    if (coords) { map.current?.flyTo([Number(coords[1]), Number(coords[2])], 16, { duration: 0.8 }); return; }
    const api8 = api8From(q);
    if (!api8) { setError("Enter a Texas API number (42-165-02084) or a latitude, longitude."); return; }
    setError(null); setLoading("Finding the well…");
    try {
      const w = await wellByApi(api8);
      if (!w) { setLoading(null); setError(`TRRC's map has no location for ${formatApi(api8)}.`); return; }
      await select(w, true);
    } catch (e) { setLoading(null); setError(e instanceof Error ? e.message : "TRRC's map service did not answer."); }
  };

  return (
    <div style={{ display: "flex", height: "100vh", background: COLORS.bg, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <div ref={el} style={{ position: "absolute", inset: 0 }} />
        <form onSubmit={e => { e.preventDefault(); void search(); }}
          style={{ position: "absolute", top: 12, left: 56, zIndex: 1000, display: "flex", gap: 6, background: COLORS.surface, border: `1px solid ${COLORS.borderStrong}`, borderRadius: 8, padding: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.35)" }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="API number or lat, long" aria-label="Find a well by API number or coordinates"
            style={{ width: 230, background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.text, padding: "0.4rem 0.6rem", fontSize: "0.85rem" }} />
          <button type="submit" style={{ background: COLORS.accent, color: "#fff", border: "none", borderRadius: 6, padding: "0.4rem 0.8rem", fontWeight: 600, fontSize: "0.82rem", cursor: "pointer" }}>Find</button>
        </form>
        {zoom < MIN_WELL_ZOOM && (
          <div style={{ position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: COLORS.surface, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: "0.35rem 0.9rem", fontSize: "0.8rem" }}>
            Zoom in to see and pick individual wells
          </div>
        )}
      </div>

      <aside style={{ width: 400, flex: "none", overflowY: "auto", borderLeft: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.text, padding: "1.1rem 1.2rem" }}>
        <h1 style={{ fontSize: "1.15rem", fontWeight: 700, margin: "0 0 0.25rem" }}>Well Map</h1>
        <p style={{ fontSize: "0.78rem", color: COLORS.textMuted, margin: "0 0 1rem" }}>Wells, laterals and surveys from the Railroad Commission of Texas. Click a well, or find one by API number.</p>
        {error && <div style={{ background: COLORS.yellowDim, color: COLORS.yellow, borderRadius: 7, padding: "0.5rem 0.7rem", fontSize: "0.8rem", marginBottom: "0.8rem" }}>{error}</div>}
        {loading && <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", marginBottom: "0.8rem" }}>{loading}</div>}

        {candidates.length > 0 && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={label}>Wells here</div>
            {candidates.map(w => (
              <button key={w.api8} onClick={() => void select(w)} style={{ display: "flex", justifyContent: "space-between", width: "100%", textAlign: "left", background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 6, color: COLORS.text, padding: "0.45rem 0.6rem", marginTop: 6, cursor: "pointer", fontSize: "0.8rem" }}>
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{formatApi(w.api8)}{w.wellNumber ? ` · #${w.wellNumber}` : ""}</span>
                <span style={{ color: COLORS.textMuted }}>{w.status}</span>
              </button>))}
          </div>
        )}

        {selected && <WellPanel well={selected} detail={detail} />}
        {!selected && !candidates.length && !loading && (
          <div style={{ fontSize: "0.8rem", color: COLORS.textFaint, lineHeight: 1.5 }}>
            Production shown is TRRC&apos;s monthly report. Oil is reported by lease, so a well on a multi-well lease shows the whole lease&apos;s oil; gas wells are reported individually.
          </div>
        )}
      </aside>
    </div>
  );
}

const label: React.CSSProperties = { fontSize: "0.66rem", color: COLORS.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" };

function WellPanel({ well, detail }: { well: GisWell; detail: WellDetail | null }) {
  const l = detail?.lease;
  const rows = (detail?.production?.rows ?? []).filter(reported);
  const producing = rows.filter(r => oilOf(r) + gasOf(r) > 0);
  const last12 = rows.slice(-12);
  const kv = (k: string, v: string | null | undefined) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "0.28rem 0", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8rem" }}>
      <span style={{ color: COLORS.textMuted }}>{k}</span><span style={{ textAlign: "right" }}>{v ?? "—"}</span>
    </div>);
  return (
    <div>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "1.05rem", fontWeight: 700 }}>{formatApi(well.api8)}</div>
      <div style={{ color: COLORS.textMuted, fontSize: "0.82rem", margin: "0.15rem 0 0.8rem" }}>{[l?.wellNumber ?? well.wellNumber ? `Well #${l?.wellNumber ?? well.wellNumber}` : null, well.status].filter(Boolean).join(" · ")}</div>
      {kv("Operator", l?.operatorName)}
      {kv("Lease", l ? `${l.leaseName ?? "—"} (${l.district}-${l.leaseNumber})` : detail ? "Not found in TRRC's wellbore query" : null)}
      {kv("Field", l?.fieldName)}
      {kv("Location", `${well.lat.toFixed(5)}, ${well.lng.toFixed(5)}`)}

      {detail && !l && <p style={{ fontSize: "0.78rem", color: COLORS.textMuted }}>{detail.note}</p>}
      {detail?.production && (
        <div style={{ marginTop: "1rem" }}>
          <div style={label}>{detail.production.leaseType === "gas" ? "Gas well production" : "Lease production"} · TRRC</div>
          {!producing.length ? <p style={{ fontSize: "0.8rem", color: COLORS.textMuted }}>No production reported since 1993.</p> : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "0.6rem 0" }}>
                <Stat k="Cumulative oil" v={`${n0(rows.reduce((s, r) => s + oilOf(r), 0))} bbl`} />
                <Stat k="Cumulative gas" v={`${n0(rows.reduce((s, r) => s + gasOf(r), 0))} mcf`} />
                <Stat k="Last 12 months, oil" v={`${n0(last12.reduce((s, r) => s + oilOf(r), 0) / Math.max(1, last12.length))} bbl/mo`} />
                <Stat k="Last producing month" v={monthLabel(producing[producing.length - 1].productionMonth)} />
              </div>
              <Chart rows={rows} pick={oilOf} unit="bbl/month" title="Oil and condensate" color={COLORS.accent} />
              <Chart rows={rows} pick={gasOf} unit="mcf/month" title="Gas and casinghead" color={COLORS.green} />
              <p style={{ fontSize: "0.72rem", color: COLORS.textFaint, lineHeight: 1.45 }}>
                {rows.length} reported months, {monthLabel(rows[0].productionMonth)} to {monthLabel(rows[rows.length - 1].productionMonth)}. {detail.note}
              </p>
              <details style={{ marginTop: 6 }}>
                <summary style={{ fontSize: "0.78rem", color: COLORS.accent, cursor: "pointer" }}>Monthly table</summary>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem", marginTop: 6 }}>
                  <thead><tr>{["Month", "Oil, bbl", "Gas, mcf"].map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left", color: COLORS.textMuted, fontWeight: 600, padding: "0.2rem 0", background: "transparent", borderBottom: `1px solid ${COLORS.border}` }}>{h}</th>)}</tr></thead>
                  <tbody>{[...rows].reverse().map(r => (
                    <tr key={r.productionMonth}>
                      <td style={{ padding: "0.15rem 0", background: "transparent", borderBottom: "none", color: COLORS.text }}>{r.productionMonth}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", background: "transparent", borderBottom: "none", color: COLORS.text }}>{n0(oilOf(r))}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", background: "transparent", borderBottom: "none", color: COLORS.text }}>{n0(gasOf(r))}</td>
                    </tr>))}</tbody>
                </table>
              </details>
            </>
          )}
          {detail.production.warnings.map((w, i) => <p key={i} style={{ fontSize: "0.74rem", color: COLORS.yellow }}>{w}</p>)}
        </div>
      )}

      <Link href={`/trrc-due-diligence?apis=${formatApi(well.api8)}`} style={{ display: "block", textAlign: "center", marginTop: "1rem", background: COLORS.accent, color: "#fff", borderRadius: 7, padding: "0.55rem", fontSize: "0.85rem", fontWeight: 600, textDecoration: "none" }}>
        Run due diligence on this well
      </Link>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ background: COLORS.surfaceAlt, borderRadius: 7, padding: "0.45rem 0.6rem" }}>
      <div style={{ ...label, fontSize: "0.6rem" }}>{k}</div>
      <div style={{ fontSize: "0.85rem", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>{v}</div>
    </div>);
}

/** Monthly volumes as an area line, with the peak and the span labeled. */
function Chart({ rows, pick, unit, title, color }: { rows: ProductionRow[]; pick: (r: ProductionRow) => number; unit: string; title: string; color: string }) {
  const values = rows.map(pick);
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  const W = 356, H = 92, step = W / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 6)).toFixed(1)}`);
  return (
    <figure style={{ margin: "0.6rem 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: COLORS.textMuted }}><span>{title}</span><span>peak {n0(max)} {unit}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, monthly, peak ${n0(max)} ${unit}`} style={{ width: "100%", height: "auto", display: "block", marginTop: 4 }}>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke={COLORS.borderStrong} />
        <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill={color} opacity="0.15" />
        <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: COLORS.textFaint }}><span>{monthLabel(rows[0].productionMonth)}</span><span>{monthLabel(rows[rows.length - 1].productionMonth)}</span></div>
    </figure>);
}
