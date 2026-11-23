"use client";
import Link from "next/link";
import { buildReservoirStudy } from "@/lib/geology/reservoir-study";
import { reservoirById } from "@/lib/geology/reservoirs";
import ReservoirStudyCard from "../../ReservoirStudyCard";
import styles from "../../finder.module.css";

export default function ReservoirStudyPage({ params }: { params: { id: string } }) {
  const r = reservoirById(params.id);
  return <div className={styles.page}><div className={styles.root}>
    <div className={styles.heading}>
      <div><h1>Reservoir volumetric study</h1><p>Oil in place from measurements published for this reservoir, each traced to its page. Regional averages are never substituted for a reservoir&apos;s own measurements.</p></div>
      <Link href="/mineral-finder" className={styles.button}>Mineral Finder</Link>
    </div>
    {r ? <>
      <div className={styles.actions}><a className={styles.primary} href={`/api/mineral-finder/reservoir/${r.id}/report`}>Download study PDF</a></div>
      <ReservoirStudyCard study={buildReservoirStudy(r)} />
    </> : <div role="alert" className={styles.error}>No reservoir study is registered under this name.</div>}
  </div></div>;
}
