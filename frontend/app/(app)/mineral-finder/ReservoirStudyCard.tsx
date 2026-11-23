"use client";
import Link from "next/link";
import type { ReservoirStudy } from "@/lib/geology/reservoir-study";
import { bigNumber, studyText } from "@/lib/geology/study-text";
import styles from "./finder.module.css";

const TONE = { green: "var(--green)", yellow: "var(--yellow)", red: "var(--red)" } as const;
const cell = { color: "var(--muted)", width: "24%", verticalAlign: "top" as const };

/** One reservoir's volumetric study: the result or the exact measurements that are missing. */
export default function ReservoirStudyCard({ study, compact = false }: { study: ReservoirStudy; compact?: boolean }) {
  const t = studyText(study);
  const id = study.reservoir.id;
  return <div className={styles.card}>
    <h2>Reservoir volumetric study</h2>
    <div className={styles.stage}>{study.reservoir.name}</div>
    <div className={styles.label} style={{ color: TONE[t.status.tone], margin: "0 0 0.8rem" }}>{t.status.label}</div>

    {t.results.length > 0 && <div className={styles.table}><table><thead><tr><th>Result</th><th>Low</th><th>Central</th><th>High</th></tr></thead><tbody>
      {t.results.map(r => <tr key={r.label}><td>{r.label}<small>{r.unit}</small></td><td>{r.low === null ? "—" : bigNumber(r.low)}</td><td><strong>{bigNumber(r.central)}</strong></td><td>{r.high === null ? "—" : bigNumber(r.high)}</td></tr>)}
    </tbody></table></div>}
    {t.perAcre && <p style={{ marginTop: "0.5rem" }}>{t.perAcre}</p>}
    {t.stopped.map((x, i) => <p key={i} style={{ color: "var(--red)" }}>{x}</p>)}
    <p className={styles.note} style={{ fontFamily: "ui-monospace, monospace" }}>{t.equations.join("   ·   ")}</p>
    {t.flags.map((f, i) => <p key={i} className={styles.note}>{f}</p>)}

    <h3>Measurements used</h3>
    {t.inputs.length ? <div className={styles.table}><table><tbody>{t.inputs.map(x => <tr key={x.label}>
      <td style={cell}>{x.label}</td>
      <td><strong>{x.value}</strong><small>{x.applies}</small><small>{x.source}</small>{x.notes.map((n, i) => <small key={i} style={{ color: "var(--faint)" }}>{n}</small>)}</td>
    </tr>)}</tbody></table></div> : <p>No measurement in the registered sources applies to this reservoir at its own scope.</p>}

    {t.missing.length > 0 && <>
      <h3 style={{ color: "var(--red)" }}>Missing measurements</h3>
      {t.missing.map(m => <div key={m.label} className={styles.source}><strong>{m.label}</strong><p>{m.detail}</p><small>Needed: {m.needed}.</small></div>)}
    </>}

    {compact
      ? <div className={styles.actions}><Link className={styles.button} href={`/mineral-finder/reservoir/${id}`}>Open the full study</Link><a className={styles.button} href={`/api/mineral-finder/reservoir/${id}/report`}>Download study PDF</a></div>
      : <>
        {t.notUsed.length > 0 && <><h3>Found but not used</h3>{t.notUsed.map((x, i) => <div key={i} className={styles.source}><strong>{x.label}: {x.value}</strong><p>{x.reason}</p><small>{x.applies} · {x.source}</small></div>)}</>}
        {t.comparisons.length > 0 && <><h3>Published comparison</h3>{t.comparisons.map((c, i) => <div key={i} className={styles.source}><strong>{c.label}: {c.value}</strong><p>{c.note}</p><small>{c.source}</small></div>)}</>}
        {t.calibrations.length > 0 && <><h3>Calibrations held for this reservoir&apos;s log analysis</h3>{t.calibrations.map(c => <div key={c.name} className={styles.source}><strong>{c.name}</strong><p style={{ fontFamily: "ui-monospace, monospace" }}>{c.expression}</p><small>{c.sources}</small>{c.limitations.map((l, i) => <small key={i} style={{ color: "var(--faint)" }}>{l}</small>)}</div>)}</>}
        {t.context.length > 0 && <><h3>Reservoir context</h3>{t.context.map((c, i) => <p key={i}>{c.text} <span style={{ color: "var(--faint)" }}>({c.source})</span></p>)}</>}
        <p className={styles.note}>{t.reproducibility}</p>
      </>}
  </div>;
}
