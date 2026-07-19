import type { DealScoreResult } from "@/lib/document-processing/deal-score";

/** Same sentinel as dashboard-normalize; kept local so this module stays importable from deal-score without cycles. */
const EM_DASH = "—";

const CLOSING_LONG = "— strong acquisition opportunity";
const CLOSING_SHORT = "— strong opportunity";

function wordCount(s: string): number {
  return s
    .trim()
    .replace(/—/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .length;
}

function titleCaseCounty(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 2 && /^[a-z]{2}$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

function locationPhrase(county: string | null, state: string | null): string | null {
  const c = county?.trim();
  const st = state?.trim();
  if (!c && !st) return null;
  let loc = "";
  if (c) {
    const hasCounty = /\bcounty\b/i.test(c);
    loc = hasCounty ? titleCaseCounty(c) : `${titleCaseCounty(c)} County`;
  }
  if (st) {
    const stDisp = st.length === 2 ? st.toUpperCase() : titleCaseCounty(st);
    loc = loc ? `${loc}, ${stDisp}` : stDisp;
  }
  return loc;
}

function acreagePhrase(acresDisplay: string): string {
  const t = acresDisplay.trim();
  if (!t || t === EM_DASH) return "Undisclosed acres";
  const n = parseFloat(t.replace(/,/g, ""));
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    const rounded = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
    return `${rounded} acres`;
  }
  return `${t} acres`;
}

type LeaseProblemTier = "none" | "expired" | "expiring_soon" | "unknown";

const LEASE_PROBLEM_RANK: Record<LeaseProblemTier, number> = {
  none: 4,
  expired: 3,
  expiring_soon: 2,
  unknown: 1,
};

function phraseForLeaseProblem(tier: LeaseProblemTier): string {
  switch (tier) {
    case "none":
      return "with no lease";
    case "expired":
      return "with expired lease";
    case "expiring_soon":
      return "with lease expiring soon";
    case "unknown":
      return "with lease unknown";
  }
}

/** Parses structured lease_status for summary; aligns with deal-score normalization. */
function parseLeaseStatusDisplay(leaseStatus: string):
  | { kind: "problem"; tier: LeaseProblemTier }
  | { kind: "active" }
  | { kind: "custom"; raw: string } {
  const raw = leaseStatus.trim();
  if (!raw || raw === EM_DASH) return { kind: "problem", tier: "unknown" };
  const s = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  // No lease: structured `none` or human/legacy strings — never treat as custom "unclear …".
  if (s === "none" || s === "no lease" || s === "no lease found" || /\bno lease found\b/.test(s)) {
    return { kind: "problem", tier: "none" };
  }
  if (s === "expired") return { kind: "problem", tier: "expired" };
  if (s === "active") return { kind: "active" };
  if (s === "expiring soon") return { kind: "problem", tier: "expiring_soon" };
  if (s === "unknown" || /\bunclear\b/.test(s)) return { kind: "problem", tier: "unknown" };
  return { kind: "custom", raw };
}

/**
 * Strongest lease signal for the one-line summary: deal reasons (persisted score) plus structured status.
 * Priority: no lease > expired > expiring soon > unknown; active only when no stronger problem tier wins.
 */
function leaseTierFromReasons(reasons: string[]): LeaseProblemTier | null {
  let best: LeaseProblemTier | null = null;
  let bestRank = 0;
  for (const reason of reasons) {
    const l = reason.toLowerCase();
    let tier: LeaseProblemTier | null = null;
    if (/\bno lease found\b/.test(l)) tier = "none";
    else if (l.includes("lease expired")) tier = "expired";
    else if (l.includes("lease expiring soon")) tier = "expiring_soon";
    if (!tier) continue;
    const r = LEASE_PROBLEM_RANK[tier];
    if (r > bestRank) {
      best = tier;
      bestRank = r;
    }
  }
  return best;
}

function leasePhraseForSummary(leaseStatus: string, reasons: string[]): string {
  const status = parseLeaseStatusDisplay(leaseStatus);
  const fromReasons = leaseTierFromReasons(reasons);

  let winner: LeaseProblemTier | null = null;
  let winnerRank = 0;

  if (status.kind === "problem") {
    winner = status.tier;
    winnerRank = LEASE_PROBLEM_RANK[status.tier];
  }

  if (fromReasons) {
    const r = LEASE_PROBLEM_RANK[fromReasons];
    if (r > winnerRank) {
      winner = fromReasons;
      winnerRank = r;
    }
  }

  if (winner !== null && winner !== "unknown") {
    return phraseForLeaseProblem(winner);
  }

  if (winner === "unknown") {
    return phraseForLeaseProblem("unknown");
  }

  if (status.kind === "active") {
    return "with active lease";
  }
  if (status.kind === "custom") {
    return `with ${status.raw} lease`;
  }

  return phraseForLeaseProblem("unknown");
}

/** Short drilling clause when present in deal score reasons or structured proximity. */
function drillingClause(reasons: string[]): string | null {
  for (const reason of reasons) {
    const lower = reason.toLowerCase();
    if (!lower.includes("drill")) continue;
    if (lower.includes("within 1 mile")) return "near active drilling";
    if (lower.includes("within 3 mile")) return "near active drilling";
    if (lower.includes("within 5 mile")) return "near active drilling";
    if (lower.includes("drilling")) return "near active drilling";
  }
  return null;
}

/** Fields used to render the one-line Leads summary (subset of {@link ProcessedDealRow}). */
export type LeadDealSummaryInput = {
  acres: string;
  county: string | null;
  state: string | null;
  dealScore: DealScoreResult | null;
  leaseStatus: string;
  drillingProximityPhrase: string | null;
};

/**
 * One-line investment-style summary for Leads cards; target ≤20 words.
 */
export function buildLeadDealSummary(row: LeadDealSummaryInput): string {
  const acre = acreagePhrase(row.acres);
  const locFull = locationPhrase(row.county, row.state);
  const locCountyOnly = row.county?.trim()
    ? locationPhrase(row.county, null)
    : null;
  const reasons = row.dealScore?.reasons ?? [];
  const lease = leasePhraseForSummary(row.leaseStatus, reasons);
  const drill = row.drillingProximityPhrase ?? drillingClause(reasons);

  function compose(loc: string | null, includeDrill: boolean, closing: string): string {
    const locSeg = loc ? ` in ${loc}` : "";
    const drillSeg = includeDrill && drill ? ` ${drill}` : "";
    const body = `${acre}${locSeg} ${lease}${drillSeg}`.replace(/\s+/g, " ").trim();
    return `${body} ${closing}`.replace(/\s+/g, " ").trim();
  }

  const attempts: Array<{ loc: string | null; drill: boolean; closing: string }> = [
    { loc: locFull, drill: true, closing: CLOSING_LONG },
    { loc: locFull, drill: false, closing: CLOSING_LONG },
    { loc: locFull, drill: true, closing: CLOSING_SHORT },
    { loc: locFull, drill: false, closing: CLOSING_SHORT },
    { loc: locCountyOnly ?? locFull, drill: false, closing: CLOSING_SHORT },
    { loc: null, drill: false, closing: CLOSING_SHORT },
  ];

  for (const a of attempts) {
    const full = compose(a.loc, a.drill, a.closing);
    if (wordCount(full) <= 20) return full;
  }

  return compose(null, false, CLOSING_SHORT);
}
