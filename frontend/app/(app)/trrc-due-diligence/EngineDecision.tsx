"use client";

/**
 * The decision workspace for a finished deal: each lease's assumptions,
 * editable, recalculated in the browser by the same EconomicsProvider and
 * decision layer the Decision Record uses, so what is on screen is what is
 * printed. "Generate Decision Record" sends only the fields the user changed.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Deal, DealLease } from "@/lib/trrc/deal/build";
import { assembleDecision, type LeaseDecisionRecord, type Finding } from "@/lib/trrc/deal/decision-layer";
import { validateAssumptions, type EconomicsAssumptions, type AssumptionBasis } from "@/lib/trrc/economics-provider";
import { economicsAssetFromLease } from "@/lib/trrc/deal/decision-layer";
import { oilSensitivity, costScenario, SENSITIVITY_DISCLOSURE } from "@/lib/trrc/deal/oil-sensitivity";
import { COLORS } from "./colors";

export interface EngineData { deal: Deal; starting: Record<string, { assumptions: EconomicsAssumptions; basis: AssumptionBasis }> }
type Edits = Record<string, Partial<EconomicsAssumptions>>;
type Field = keyof EconomicsAssumptions;

const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
const pct = (v: number | null) => v === null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
const mult = (v: number | null) => v === null ? "—" : `${v.toFixed(2)}x`;
const verdictColor = (v: string) => v === "BUY" ? COLORS.green : v === "PASS" ? COLORS.red : COLORS.yellow;
const verdictBg = (v: string) => v === "BUY" ? COLORS.greenDim : v === "PASS" ? COLORS.redDim : COLORS.yellowDim;
const sevColor = (s: 1 | 2 | 3) => s === 3 ? COLORS.red : s === 2 ? COLORS.yellow : COLORS.textMuted;
const label: React.CSSProperties = { fontSize: "0.66rem", color: COLORS.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" };
const card: React.CSSProperties = { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.1rem 1.25rem", marginBottom: "1rem" };
const primary = (enabled: boolean): React.CSSProperties => ({ background: COLORS.accent, color: "#fff", border: "none", borderRadius: 7, padding: "0.6rem 1.2rem", fontSize: "0.85rem", fontWeight: 600, cursor: enabled ? "pointer" : "default", opacity: enabled ? 1 : 0.5, whiteSpace: "nowrap" });
const quiet: React.CSSProperties = { background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 7, color: COLORS.textMuted, fontSize: "0.78rem", padding: "0.4rem 0.8rem", cursor: "pointer" };
const num: React.CSSProperties = { fontVariantNumeric: "tabular-nums", textAlign: "right" };
// The app's global table styles are for light pages; cells here set their own ground and rules.
const cell: React.CSSProperties = { background: "transparent", borderBottom: "none" };

/** Assumption groups as a buyer reads them. `scale` shows a fraction as a percent where that is how it is quoted. */
const GROUPS: { title: string; fields: { k: Field; label: string; unit: string; working?: boolean }[] }[] = [
  { title: "Prices", fields: [
    { k: "oilPriceUsdBbl", label: "Oil", unit: "$/bbl" }, { k: "gasPriceUsdMcf", label: "Gas", unit: "$/mcf" },
    { k: "gasDifferentialUsdMcf", label: "Gas differential", unit: "$/mcf" }, { k: "nglYieldBblPerMmcf", label: "NGL yield", unit: "bbl/MMcf" }, { k: "nglPriceUsdBbl", label: "NGL price", unit: "$/bbl" },
  ] },
  { title: "Interest", fields: [
    { k: "netRevenueInterest", label: "Net revenue interest", unit: "decimal" }, { k: "workingInterest", label: "Working interest", unit: "decimal", working: true },
    { k: "askingPriceUsd", label: "Asking price", unit: "$" }, { k: "holdYears", label: "Hold period", unit: "years" },
  ] },
  { title: "Discount and taxes", fields: [
    { k: "discountRatePct", label: "Discount rate", unit: "%" }, { k: "oilSeverancePct", label: "Oil severance", unit: "%" }, { k: "gasSeverancePct", label: "Gas severance", unit: "%" }, { k: "adValoremPct", label: "Ad valorem", unit: "%" },
  ] },
  { title: "Operating costs", fields: [
    { k: "loeUsdPerBoe", label: "Operating cost", unit: "$/BOE" }, { k: "fixedOpexUsdPerWellMonth", label: "Fixed per producing well", unit: "$/month" }, { k: "workoverUsdPerBoe", label: "Workover reserve", unit: "$/BOE" }, { k: "operatorNri", label: "Operator revenue share", unit: "decimal" },
  ] },
  { title: "Scenarios", fields: [{ k: "downsidePricePct", label: "Downside price change", unit: "%" }, { k: "upsidePricePct", label: "Upside price change", unit: "%" }] },
];

export function EngineDecision({ data, fetcher, onError }: { data: EngineData; fetcher: (url: string, init?: RequestInit) => Promise<Response>; onError: (m: string | null) => void }) {
  const { deal, starting } = data;
  const [edits, setEdits] = useState<Edits>({});
  const [generating, setGenerating] = useState(false);

  const assumptions = useMemo(() => Object.fromEntries(deal.leases.map(l => [l.key, { ...starting[l.key].assumptions, ...(edits[l.key] ?? {}) }])) as Record<string, EconomicsAssumptions>, [deal, starting, edits]);
  const record = useMemo(() => assembleDecision(deal, assumptions), [deal, assumptions]);

  const generate = async () => {
    setGenerating(true); onError(null);
    try {
      const res = await fetcher(`/api/trrc/due-diligence/packages/${deal.packageId}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assumptions: edits }) });
      if (!res.ok) { const b = await res.json().catch(() => null); throw Error(b?.error ?? "The Decision Record could not be built."); }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "MineralFlow-Decision-Record.pdf";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { onError(e instanceof Error ? e.message : "The Decision Record could not be built."); }
    finally { setGenerating(false); }
  };

  const invalid = deal.leases.some(l => validateAssumptions(assumptions[l.key]).length > 0);

  return (
    <>
      <div style={{ ...card, display: "flex", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
        <span style={{ background: verdictBg(record.verdict), color: verdictColor(record.verdict), fontWeight: 700, fontSize: "1rem", borderRadius: 6, padding: "0.35rem 0.8rem", letterSpacing: "0.04em" }}>{record.verdict}</span>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          {record.reasons.map((r, i) => <div key={i} style={{ color: i === 0 ? COLORS.text : COLORS.textMuted, fontSize: i === 0 ? "0.95rem" : "0.82rem", fontWeight: i === 0 ? 600 : 400, marginBottom: 4 }}>{r}</div>)}
          <div style={{ fontSize: "0.75rem", color: COLORS.textFaint, marginTop: 6 }}>{deal.submitted} APIs · {deal.leases.length} lease{deal.leases.length === 1 ? "" : "s"} · Economics: {record.leases[0]?.economics.provider.name ?? "—"}</div>
        </div>
        <button onClick={generate} disabled={generating || invalid} title={invalid ? "Correct the highlighted assumptions first." : undefined} style={primary(!generating && !invalid)}>{generating ? "Building Decision Record…" : "Generate Decision Record"}</button>
      </div>

      {deal.leases.map(l => {
        const r = record.leases.find(x => x.leaseKey === l.key)!;
        return <LeaseWorkspace key={l.key} lease={l} rec={r} start={starting[l.key]} edits={edits[l.key] ?? {}}
          onApply={next => setEdits(prev => ({ ...prev, [l.key]: next }))} />;
      })}

      {record.dealFindings.length > 0 && (
        <div style={card}>
          <div style={label}>Submitted APIs not in the valuation</div>
          {record.dealFindings.map((f, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.textMuted, marginTop: 4 }}>{f.text}</div>)}
        </div>
      )}
    </>
  );
}

function LeaseWorkspace({ lease: l, rec: r, start, edits, onApply }: {
  lease: DealLease; rec: LeaseDecisionRecord; start: EngineData["starting"][string]; edits: Partial<EconomicsAssumptions>; onApply: (e: Partial<EconomicsAssumptions>) => void;
}) {
  const current = { ...start.assumptions, ...edits };
  const text = (k: Field) => { const v = current[k]; return v === null ? "" : String(v); };
  const [draft, setDraft] = useState<Record<string, string>>({});
  const dirty = Object.keys(draft).length > 0;
  const problems = validateAssumptions(current);

  // Recalculate: parse every drafted field; anything unreadable stays in the draft and is flagged.
  const recalculate = (extra?: Partial<EconomicsAssumptions>) => {
    const next: Partial<EconomicsAssumptions> = { ...edits, ...(extra ?? {}) };
    const left: Record<string, string> = {};
    for (const [k, raw] of Object.entries(draft)) {
      const s = raw.replace(/[$,\s]/g, "");
      if (k === "askingPriceUsd" && s === "") { (next as Record<string, unknown>)[k] = null; continue; }
      const n = Number(s);
      if (s === "" || !Number.isFinite(n)) { left[k] = raw; continue; }
      (next as Record<string, unknown>)[k] = n;
    }
    // Keep only true edits, so the record marks exactly what the user changed.
    for (const k of Object.keys(next) as Field[]) if (next[k] === start.assumptions[k]) delete next[k];
    setDraft(left);
    onApply(next);
  };
  const reset = () => { setDraft({}); onApply({}); };

  const s = r.economics.scenarios;
  const a = r.economics.assumptions;
  const edited = new Set(Object.keys(edits));
  const sensitivity = useMemo(() => oilSensitivity(economicsAssetFromLease(l), r.economics.assumptions), [l, r.economics.assumptions]);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
        <span style={{ color: verdictColor(r.verdict), background: verdictBg(r.verdict), fontWeight: 700, fontSize: "0.75rem", borderRadius: 4, padding: "0.1rem 0.45rem" }}>{r.verdict}</span>
        <span style={{ color: COLORS.text, fontWeight: 600 }}>{l.leaseName ?? "Lease"}</span>
        <span style={{ color: COLORS.textFaint, fontSize: "0.8rem" }}>RRC {l.district}-{l.leaseNumber} · {l.county} County · {l.operator}</span>
      </div>
      {r.reasons.map((t, i) => <div key={i} style={{ fontSize: "0.85rem", color: i === 0 ? COLORS.text : COLORS.textMuted, marginBottom: 3 }}>{t}</div>)}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.6rem", margin: "0.8rem 0 1rem" }}>
        <Stat k="Wells" v={`${l.apis.length} submitted · ${l.producingWells} producing`} />
        <Stat k="Production" v={`${l.production.length} months to ${l.lastReportedMonth ?? "—"}`} />
        <Stat k="Owners of record" v={l.ownership.status === "matched" ? `${l.ownership.tracts.reduce((n, t) => n + t.owners.length, 0)} on the roll` : "Not established"} />
        <Stat k="Chain of title" v={l.title.analysis ? `${l.title.indexedInstruments} recordings · ${l.title.readInstruments} read` : "Not established"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1.25rem" }}>
        {/* Assumptions */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <div style={label}>Assumptions</div>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              {(edited.size > 0 || dirty) && <button onClick={reset} style={quiet}>Reset</button>}
              <button onClick={() => recalculate()} disabled={!dirty} style={{ ...quiet, color: dirty ? "#fff" : COLORS.textFaint, background: dirty ? COLORS.accent : "transparent", borderColor: dirty ? COLORS.accent : COLORS.border, fontWeight: 600 }}>Recalculate</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.6rem" }}>
            {(["royalty", "working"] as const).map(t => (
              <button key={t} onClick={() => recalculate(t === current.interestType ? {} : t === "royalty"
                ? { interestType: t, netRevenueInterest: start.assumptions.interestType === "royalty" ? start.assumptions.netRevenueInterest : 0.01 }
                // An example 1% working interest carrying the operator's revenue share, not the royalty decimal.
                : { interestType: t, workingInterest: 0.01, netRevenueInterest: Math.round(0.01 * current.operatorNri * 1e6) / 1e6 })} style={{ ...quiet, flex: 1, color: current.interestType === t ? COLORS.text : COLORS.textFaint, background: current.interestType === t ? COLORS.accentDim : "transparent", borderColor: current.interestType === t ? COLORS.accent : COLORS.border }}>
                {t === "royalty" ? "Royalty interest" : "Working interest"}
              </button>))}
          </div>
          <div style={{ fontSize: "0.75rem", color: COLORS.textMuted, marginBottom: 10 }}>
            <strong>Cost context: {l.operator ?? "Operator unavailable"} · {l.county ?? "County unavailable"}</strong>
            <div>{start.basis.loeUsdPerBoe}. Operator-specific actual costs are not established; select a sensitivity or enter supported costs below.</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {[["Lower cost (−20%)", 0.8], ["Location baseline", 1], ["Higher cost (+20%)", 1.2]].map(([name, factor]) =>
                <button key={name} style={quiet} onClick={() => {
                  // Record only values that differ from the start, so the baseline is not labeled "Entered by user".
                  const next: Partial<EconomicsAssumptions> = { ...edits, ...costScenario(start.assumptions, Number(factor)) };
                  for (const k of Object.keys(next) as Field[]) if (next[k] === start.assumptions[k]) delete next[k];
                  setDraft({}); onApply(next);
                }}>{name}</button>)}
            </div>
            <div>Multipliers are illustrative sensitivities, not measured differences between named operators. Royalty interests bear no direct operating costs; costs still affect economic life.</div>
          </div>
          {GROUPS.map(g => (
            <div key={g.title} style={{ marginBottom: "0.55rem" }}>
              <div style={{ ...label, fontSize: "0.6rem", color: COLORS.textFaint, margin: "0.3rem 0 0.25rem" }}>{g.title}</div>
              {g.fields.filter(f => !f.working || current.interestType === "working").map(f => {
                const shown = draft[f.k] ?? text(f.k);
                const isEdited = edited.has(f.k);
                const raw = draft[f.k]?.replace(/[$,\s]/g, "");
                const bad = raw !== undefined && !(f.k === "askingPriceUsd" && raw === "") && (raw === "" || !Number.isFinite(Number(raw)));
                return (
                  <label key={f.k} title={isEdited ? "Entered by you" : start.basis[f.k]} style={{ display: "grid", gridTemplateColumns: "1fr 110px 62px", alignItems: "center", gap: "0.5rem", padding: "0.12rem 0" }}>
                    <span style={{ fontSize: "0.8rem", color: isEdited ? COLORS.text : COLORS.textMuted }}>
                      {f.label}{isEdited && <span style={{ color: COLORS.accent }}> ●</span>}
                    </span>
                    <input value={shown} inputMode="decimal" placeholder={f.k === "askingPriceUsd" ? "none" : ""}
                      onChange={e => setDraft(d => ({ ...d, [f.k]: e.target.value }))}
                      onKeyDown={e => { if (e.key === "Enter") recalculate(); }}
                      style={{ background: COLORS.surfaceAlt, border: `1px solid ${bad ? COLORS.red : draft[f.k] !== undefined ? COLORS.accent : COLORS.border}`, borderRadius: 5, color: COLORS.text, fontSize: "0.8rem", padding: "0.28rem 0.45rem", textAlign: "right", fontVariantNumeric: "tabular-nums", width: "100%" }} />
                    <span style={{ fontSize: "0.7rem", color: COLORS.textFaint }}>{f.unit}</span>
                  </label>);
              })}
            </div>))}
          {problems.map((p, i) => <div key={i} style={{ fontSize: "0.75rem", color: COLORS.red, marginTop: 3 }}>{p}</div>)}
          <div style={{ fontSize: "0.7rem", color: COLORS.textFaint, marginTop: "0.4rem" }}>Hover a field for its source. ● marks your changes; the Decision Record labels them “Entered by user”.</div>
        </div>

        {/* Results */}
        <div style={{ minWidth: 0 }}>
          <div style={{ ...label, marginBottom: "0.5rem" }}>Scenarios</div>
          {s ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", marginBottom: "1rem" }}>
              <thead><tr>{["", "Downside", "Base", "Upside"].map((h, i) => <th key={i} style={{ ...label, ...cell, fontSize: "0.62rem", padding: "0.3rem 0", ...(i ? num : {}) }}>{h}</th>)}</tr></thead>
              <tbody>
                <Row k="Oil / gas" v={(["downside", "base", "upside"] as const).map(x => `$${s[x].oilPriceUsdBbl.toFixed(0)} / $${s[x].gasPriceUsdMcf.toFixed(2)}`)} />
                <Row k={`Value at ${a.discountRatePct}%`} v={(["downside", "base", "upside"] as const).map(x => usd(s[x].presentValue))} strong />
                <Row k="Undiscounted" v={(["downside", "base", "upside"] as const).map(x => usd(s[x].undiscountedNet))} />
                <Row k="Life, months" v={(["downside", "base", "upside"] as const).map(x => String(s[x].lifeMonths))} />
              </tbody>
            </table>
          ) : <div style={{ fontSize: "0.82rem", color: COLORS.yellow, marginBottom: "1rem" }}>Not calculated: {r.economics.reason}</div>}

          {r.entry && (
            <>
              <div style={{ ...label, marginBottom: "0.4rem" }}>MineralFlow entry</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "1rem" }}>
                <Stat k="Recommended range" v={`${usd(r.entry.rangeLow)} – ${usd(r.entry.rangeHigh)}`} />
                <Stat k="Walk-away ceiling" v={usd(r.entry.ceiling)} />
                <Stat k="Asking price" v={r.entry.askingPriceUsd ? `${usd(r.entry.askingPriceUsd)} · ${r.entry.position}` : "Not entered"} tone={r.entry.position === "above ceiling" ? COLORS.red : r.entry.position === "above range, under ceiling" ? COLORS.yellow : undefined} />
                <Stat k="At asking" v={r.entry.askingPriceUsd ? `IRR ${pct(r.entry.askingIrrPct)} · payout ${r.entry.askingPayoutMonths ? `${r.entry.askingPayoutMonths} mo` : "none"} · ${mult(r.entry.askingMultiple)}` : "—"} />
              </div>
            </>
          )}
          {r.exit && (
            <>
              <div style={{ ...label, marginBottom: "0.4rem" }}>MineralFlow exit · {r.exit.holdYears}-year hold from the {r.exit.entryBasisLabel}</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
                <tbody>
                  <Row k="Cash in the hold" v={(["downside", "base", "upside"] as const).map(x => usd(r.exit!.byScenario[x].holdCash))} />
                  <Row k="Exit value" v={(["downside", "base", "upside"] as const).map(x => usd(r.exit!.byScenario[x].exitValue))} />
                  <Row k="Multiple" v={(["downside", "base", "upside"] as const).map(x => mult(r.exit!.byScenario[x].multiple))} strong />
                  <Row k="IRR" v={(["downside", "base", "upside"] as const).map(x => pct(r.exit!.byScenario[x].irrPct))} strong />
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div style={{ marginTop: 18, overflowX: "auto" }}>
        <div style={label}>Oil price sensitivity · {a.holdYears}-year hold · {a.discountRatePct}% hurdle</div>
        <p style={{ fontSize: "0.75rem", color: COLORS.textMuted }}>{SENSITIVITY_DISCLOSURE}</p>
        <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
          <thead><tr>{["Oil $/bbl", "Year 1 net", "Entry ceiling", "Hold cash", "Exit value", "IRR at asking price"].map(h => <th key={h} style={{ ...cell, ...num, color: COLORS.textMuted, padding: 6 }}>{h}</th>)}</tr></thead>
          <tbody>{sensitivity.map(row => <tr key={row.oilPriceUsdBbl}>
            {[`$${row.oilPriceUsdBbl}`, ...[row.annualNet, row.ceiling, row.holdCash, row.exitValue].map(v => v === null ? "Unavailable" : usd(v)), a.askingPriceUsd ? pct(row.irrPct) : "Set an asking price"].map((v, i) => <td key={i} title={row.reason ?? undefined} style={{ ...cell, ...num, color: COLORS.text, padding: 6 }}>{v}</td>)}
          </tr>)}</tbody>
        </table>
        {sensitivity.find(row => row.reason)?.reason && <p style={{ color: COLORS.yellow }}>{sensitivity.find(row => row.reason)?.reason}</p>}
      </div>

      <FindingList title="Contradictions in the record" items={r.contradictions} />
      <FindingList title="Missing diligence" items={r.missing} />
      {r.conditions.length > 0 && (
        <div style={{ marginTop: "0.8rem" }}>
          <div style={{ ...label, marginBottom: "0.3rem" }}>Conditions</div>
          {r.conditions.map((c, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.textMuted, marginBottom: 3 }}>• {c}</div>)}
        </div>
      )}
      <details style={{ marginTop: "0.8rem" }}>
        <summary style={{ fontSize: "0.78rem", color: COLORS.accent, cursor: "pointer" }}>Well records ({l.members.length})</summary>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem", marginTop: "0.5rem" }}>
          {l.members.map(m => <Link key={m.runId} href={`/trrc-due-diligence/well?run=${m.runId}`} style={{ fontSize: "0.78rem", color: COLORS.accent, fontFamily: "ui-monospace, monospace", textDecoration: "none" }}>{m.input}</Link>)}
        </div>
      </details>
    </div>
  );
}

function FindingList({ title, items }: { title: string; items: Finding[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: "0.8rem" }}>
      <div style={{ ...label, marginBottom: "0.3rem" }}>{title} ({items.length})</div>
      {items.map((f, i) => <div key={i} style={{ fontSize: "0.8rem", color: sevColor(f.severity), marginBottom: 3 }}>• {f.text}</div>)}
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string[]; strong?: boolean }) {
  return (
    <tr style={{ borderTop: `1px solid ${COLORS.border}` }}>
      <td style={{ ...cell, color: COLORS.textMuted, fontSize: "0.8rem", padding: "0.35rem 0" }}>{k}</td>
      {v.map((x, i) => <td key={i} style={{ ...cell, ...num, fontSize: "0.8rem", color: strong ? COLORS.text : COLORS.textMuted, fontWeight: strong && i === 1 ? 600 : 400, padding: "0.35rem 0 0.35rem 0.5rem" }}>{x}</td>)}
    </tr>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div style={{ background: COLORS.surfaceAlt, borderRadius: 7, padding: "0.5rem 0.7rem", minWidth: 0 }}>
      <div style={{ ...label, fontSize: "0.6rem" }}>{k}</div>
      <div style={{ color: tone ?? COLORS.text, fontSize: "0.83rem", marginTop: 3 }}>{v}</div>
    </div>
  );
}
