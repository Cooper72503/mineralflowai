/**
 * TRRC injection / SWD well data lookup.
 *
 * TRRC maintains a Disposal / Injection Well database.
 * We query the EWA wellbore query filtered to injection/SWD well types
 * to find permitted injection volumes, pressure limits, and MIT status.
 *
 * TRRC Well Types for injection: "SWD" (Salt Water Disposal), "UIC" (Underground Injection Control)
 * Query: https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do
 *
 * Returns [] on failure — never throws.
 */

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";
const DEFAULT_TIMEOUT_MS = 12_000;

export type TrrcInjectionRecord = {
  api10: string;
  well_name: string | null;
  permit_number: string | null;
  well_type: string;
  county: string | null;
  operator: string | null;
  dist_code: string | null;
  lease_no: string | null;
  injection_zone: string | null;
  depth_ft: number | null;
  permitted_max_volume_bwpd: number | null;
  permitted_max_pressure_psi: number | null;
  mit_status: string | null;
  last_mit_date: string | null;
  permit_status: string | null;
};

/**
 * Look up SWD / injection wells by API number.
 * Returns [] on timeout or parse error.
 */
export async function fetchTrrcInjectionByApi(
  api10: string,
): Promise<TrrcInjectionRecord[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    // Strip prefix/dashes to get bare 10-digit form
    const bare = api10.replace(/[^0-9]/g, "").slice(-10);
    const prefix = bare.slice(0, 2);
    const suffix = bare.slice(2);

    const params = new URLSearchParams({
      "searchArgs.apiNoPrefixArg": prefix,
      "searchArgs.apiNoSuffixArg": suffix,
      "searchArgs.wellTypeCodeArg": "D",  // D = Disposal
      "pager.offset": "0",
      "pager.pageSize": "25",
    });

    const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const html = await res.text();

    return parseInjectionHtml(html, api10);
  } catch {
    return [];
  }
}

/**
 * Look up SWD / injection wells by operator + county.
 */
export async function fetchTrrcInjectionByOperator(
  operatorName: string,
  county: string,
): Promise<TrrcInjectionRecord[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const params = new URLSearchParams({
      "searchArgs.operatorNameArg": operatorName,
      "searchArgs.countyNameArg": county,
      "searchArgs.wellTypeCodeArg": "D",  // D = Disposal
      "pager.offset": "0",
      "pager.pageSize": "50",
    });

    const res = await fetch(`${EWA_BASE}/wellboreQueryAction.do`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const html = await res.text();

    return parseInjectionHtml(html, null);
  } catch {
    return [];
  }
}

// ─── HTML parser ──────────────────────────────────────────────────────────────

function parseInjectionHtml(html: string, targetApi: string | null): TrrcInjectionRecord[] {
  const results: TrrcInjectionRecord[] = [];

  // Extract apiNo=XXXXXXXX&distCode=XX&leaseNo=XXXXXX links (same pattern as wellbore query)
  const linkPattern = /apiNo=(\d{8})&distCode=(\w+)&leaseNo=(\d+)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = linkPattern.exec(html)) !== null) {
    const apiNo8 = m[1];
    const distCode = m[2];
    const leaseNo = m[3];
    const key = `${apiNo8}:${distCode}:${leaseNo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Reconstruct 10-digit API (TX prefix 42 + 3-digit county from apiNo8 + remaining)
    const api10 = `42${apiNo8}`;

    // If we have a target API, only include if it matches
    if (targetApi) {
      const targetBare = targetApi.replace(/[^0-9]/g, "").slice(-10);
      if (!api10.endsWith(targetBare.slice(2))) continue;
    }

    // Extract operator name from surrounding context
    const operatorMatch = html.slice(
      Math.max(0, m.index - 300),
      m.index + 300
    ).match(/operatorName=([^&"]+)/);
    const operator = operatorMatch ? decodeURIComponent(operatorMatch[1]) : null;

    results.push({
      api10,
      well_name: null,
      permit_number: null,
      well_type: "SWD",
      county: null,
      operator: operator?.replace(/\+/g, " ") ?? null,
      dist_code: distCode,
      lease_no: leaseNo,
      injection_zone: null,
      depth_ft: null,
      permitted_max_volume_bwpd: null,
      permitted_max_pressure_psi: null,
      mit_status: null,
      last_mit_date: null,
      permit_status: null,
    });
  }

  return results;
}
