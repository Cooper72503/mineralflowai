"use client";

import { useEffect, useRef } from "react";
import styles from "./landing.module.css";

function TradingViewWidget({ symbol }: { symbol: string }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Avoid injecting the script twice on React hot-reload
    if (!container.current || container.current.querySelector("script")) return;

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-single-quote.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol,
      width: "100%",
      colorTheme: "dark",
      isTransparent: true,
      locale: "en",
    });

    container.current.appendChild(script);
  }, [symbol]);

  return (
    <div
      ref={container}
      className={`tradingview-widget-container ${styles.tvWidget}`}
    >
      <div className="tradingview-widget-container__widget" />
    </div>
  );
}

export function LivePriceTicker() {
  return (
    <div className={styles.tickerRow}>
      <TradingViewWidget symbol="USOIL" />
      <TradingViewWidget symbol="NATGAS" />
    </div>
  );
}
