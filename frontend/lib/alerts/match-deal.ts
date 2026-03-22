export type UserAlertPrefs = {
  min_score: number;
  county: string | null;
  acreage_min: number | null;
};

export type DealAlertContext = {
  score: number;
  county: string | null | undefined;
  acreage: number | null | undefined;
};

/** True when alert county filter is non-empty and equals deal county (trimmed, case-insensitive). */
function countiesMatchCaseInsensitive(filter: string, dealCounty: string | null | undefined): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const d = (dealCounty ?? "").trim().toLowerCase();
  if (!d) return false;
  return d === f;
}

/**
 * Returns true when the processed deal satisfies all configured (non-empty) alert criteria.
 */
export function dealMatchesUserAlertPrefs(prefs: UserAlertPrefs, deal: DealAlertContext): boolean {
  if (!Number.isFinite(deal.score) || deal.score < prefs.min_score) return false;

  const countyFilter = typeof prefs.county === "string" ? prefs.county : "";
  if (countyFilter.trim() && !countiesMatchCaseInsensitive(countyFilter, deal.county)) return false;

  if (prefs.acreage_min != null && Number.isFinite(prefs.acreage_min)) {
    const a = deal.acreage;
    if (a == null || !Number.isFinite(a) || a < prefs.acreage_min) return false;
  }

  return true;
}
