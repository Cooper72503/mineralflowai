"use client";

import { useEffect, useState, useCallback } from "react";
import type { PriceData } from "@/app/api/prices/route";
import styles from "./landing.module.css";

const REFRESH_MS = 5 * 60 * 1000; // re-fetch every 5 minutes

function Arrow({ change }: { change: number }) {
  if (change === 0) return <span className={styles.tickerFlat}>—</span>;
  return change > 0
    ? <span className={styles.tickerUp}>▲</span>
    : <span className={styles.tickerDown}>▼</span>;
}

function ChangeLabel({ change, pct }: { change: number; pct: number }) {
  const sign   = change >= 0 ? "+" : "";
  const cls    = change > 0 ? styles.tickerUp : change < 0 ? styles.tickerDown : styles.tickerFlat;
  return (
    <span className={cls}>
      {sign}{change.toFixed(2)} ({sign}{pct.toFixed(2)}%)
    </span>
  );
}

export function LivePriceTicker() {
  const [data, setData]       = useState<PriceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash]     = useState(false);

  const fetchPrices = useCallback(async () => {
    try {
      const res = await fetch("/api/prices", { cache: "no-store" });
      if (!res.ok) return;
      const json: PriceData = await res.json();
      setData(json);
      setFlash(true);
      setTimeout(() => setFlash(false), 600);
    } catch {
      // silently keep stale data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrices();
    const id = setInterval(fetchPrices, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchPrices]);

  if (loading) {
    return (
      <div className={styles.ticker}>
        <span className={styles.tickerLiveDot} />
        <span className={styles.tickerLoading}>Loading prices…</span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className={`${styles.ticker} ${flash ? styles.tickerFlash : ""}`}>
      {/* Live indicator */}
      <span className={styles.tickerLiveDot} />
      <span className={styles.tickerLiveLabel}>LIVE</span>

      <span className={styles.tickerDivider}>|</span>

      {/* WTI Crude */}
      <span className={styles.tickerName}>WTI Crude</span>
      <span className={styles.tickerPrice}>${data.wti_usd.toFixed(2)}</span>
      <Arrow change={data.wti_change} />
      <ChangeLabel change={data.wti_change} pct={data.wti_change_pct} />

      <span className={styles.tickerDivider}>|</span>

      {/* Henry Hub */}
      <span className={styles.tickerName}>Nat Gas</span>
      <span className={styles.tickerPrice}>${data.hh_usd.toFixed(2)}</span>
      <Arrow change={data.hh_change} />
      <ChangeLabel change={data.hh_change} pct={data.hh_change_pct} />

      <span className={styles.tickerDivider}>|</span>

      {/* Source label */}
      <span className={styles.tickerSource}>
        {data.source === "eia" ? "EIA" : "est."} · wk of {data.period}
      </span>
    </div>
  );
}
