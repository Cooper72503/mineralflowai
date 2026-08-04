/**
 * Commodity price deck for the Economic Evaluation report section — feeds
 * NPV/PV-10/PV-15 scenario math in economics.ts.
 *
 * Live path (EIA_API_KEY set): pulls WTI Cushing spot (series RWTC,
 * petroleum/pri/spt) and Henry Hub spot (series RNGWHHD, natural-gas/pri/fut)
 * from EIA's free API v2 (api.eia.gov). NOT live-verified against a real key
 * yet — Cooper needs to register a free key at eia.gov/opendata and provide
 * it before this path can be confirmed end-to-end; the route/series IDs
 * here are based on EIA's own published API v2 documentation, not a live
 * capture, unlike every scraper elsewhere in this codebase. Verify this
 * comment can be removed once a real key confirms it live.
 *
 * Fallback path (no key, or the live call fails for any reason): a small,
 * clearly-dated static price row. `source: "static_fallback"` propagates
 * into the report so a reader always knows which basis was used — this is
 * never silently presented as live data.
 */

export interface ScenarioPrice {
  oilUsdBbl: number;
  gasUsdMcf: number;
}

export interface PriceDeck {
  source: "eia_live" | "static_fallback";
  asOf: string; // date (or period label) the price basis reflects
  wtiSpotUsdBbl: number;
  henryHubUsdMcf: number;
  scenarios: {
    stress: ScenarioPrice;
    base: ScenarioPrice;
    strip: ScenarioPrice;
    upside: ScenarioPrice;
  };
}

// Placeholder static deck — set 2026-08-04, needs manual refreshing until a
// live EIA_API_KEY is wired in. Deliberately conservative round numbers,
// not a fabricated precise quote.
const STATIC_AS_OF = "2026-08-04";
const STATIC_WTI_USD_BBL = 70;
const STATIC_HH_USD_MCF = 3.0;

const STRESS_FACTOR = 0.75;
const UPSIDE_FACTOR = 1.25;

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function buildDeck(source: PriceDeck["source"], asOf: string, wtiSpot: number, hhSpot: number, wtiStrip: number, hhStrip: number): PriceDeck {
  return {
    source,
    asOf,
    wtiSpotUsdBbl: wtiSpot,
    henryHubUsdMcf: hhSpot,
    scenarios: {
      stress: { oilUsdBbl: wtiSpot * STRESS_FACTOR, gasUsdMcf: hhSpot * STRESS_FACTOR },
      base: { oilUsdBbl: wtiSpot, gasUsdMcf: hhSpot },
      // "Strip" here is a trailing-12-month EIA average, NOT a NYMEX futures
      // forward curve — EIA's free API doesn't expose futures data. Reported
      // as such in the UI; never presented as a real forward strip price.
      strip: { oilUsdBbl: wtiStrip, gasUsdMcf: hhStrip },
      upside: { oilUsdBbl: wtiSpot * UPSIDE_FACTOR, gasUsdMcf: hhSpot * UPSIDE_FACTOR },
    },
  };
}

async function fetchEiaSeries(route: string, seriesId: string, apiKey: string, points: number): Promise<{ period: string; value: number }[]> {
  const url = `https://api.eia.gov/v2/${route}/data/?api_key=${encodeURIComponent(apiKey)}&frequency=monthly&data[0]=value&facets[series][]=${seriesId}&sort[0][column]=period&sort[0][direction]=desc&length=${points}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`EIA API ${route} returned HTTP ${res.status}`);
  const json = await res.json() as { response?: { data?: Array<{ period?: string; value?: number | string }> } };
  const rows = json.response?.data ?? [];
  return rows
    .map(r => ({ period: String(r.period ?? ""), value: Number(r.value) }))
    .filter(r => r.period && isFinite(r.value));
}

export async function getPriceDeck(): Promise<PriceDeck> {
  const apiKey = process.env.EIA_API_KEY;
  if (apiKey) {
    try {
      const [wtiRows, hhRows] = await Promise.all([
        fetchEiaSeries("petroleum/pri/spt", "RWTC", apiKey, 12),
        fetchEiaSeries("natural-gas/pri/fut", "RNGWHHD", apiKey, 12),
      ]);
      if (wtiRows.length > 0 && hhRows.length > 0) {
        return buildDeck(
          "eia_live",
          wtiRows[0].period,
          wtiRows[0].value,
          hhRows[0].value,
          average(wtiRows.map(r => r.value)),
          average(hhRows.map(r => r.value)),
        );
      }
    } catch {
      // Falls through to the static deck below — a live-fetch failure must
      // never surface as a crash or a silently-wrong price, only a clearly
      // labeled fallback.
    }
  }
  return buildDeck("static_fallback", STATIC_AS_OF, STATIC_WTI_USD_BBL, STATIC_HH_USD_MCF, STATIC_WTI_USD_BBL, STATIC_HH_USD_MCF);
}
