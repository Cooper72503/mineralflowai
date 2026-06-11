/**
 * TRRC P-5 Organization Status Query (EWA)
 *
 * Source: TRRC EWA organizationQueryAction.do
 *   https://webapps2.rrc.texas.gov/EWA/organizationQueryAction.do
 *
 * Returns the operator's P-5 organization record: name, address, status, type,
 * TNR 91.114 flag (unsatisfied orders that block new permits), and mail hold.
 *
 * Column mapping (confirmed live 2026):
 *   0: Operator No.
 *   1: Operator Name
 *   2: Mailing Address
 *   3: Mailing City
 *   4: Mailing State
 *   5: Mailing Zip
 *   6: Organization Status  (Active | Active-Ext | Delinquent | Inactive | Cancelled)
 *   7: Organization Type
 *   8: *TNR 91.114          (Yes = unsatisfied orders exist → blocks new permits)
 *   9: Mail Hold
 *  10: Phone No.
 *
 * "Active-Ext" = operator is on extension (conditional active status, renewal pending).
 * Returns null when the operator number is not found or the query fails.
 */

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrrcP5Record = {
  operator_no: string;
  operator_name: string;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  /**
   * TRRC P-5 organization status.
   * Active          = current, compliant
   * Active-Ext      = active on extension (conditional — renewal pending)
   * Delinquent      = P-5 renewal overdue; may have permit restrictions
   * Inactive        = no active operations
   * Cancelled       = organization cancelled
   */
  org_status: "Active" | "Active-Ext" | "Delinquent" | "Inactive" | "Cancelled" | string;
  org_type: string | null;
  /**
   * Texas Natural Resources Code §91.114 flag.
   * true = unsatisfied final orders exist → TRRC will not issue new permits.
   */
  tnr_91114: boolean;
  /** Mail hold flag — correspondence held at TRRC office */
  mail_hold: boolean;
  phone: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseP5Html(html: string): TrrcP5Record[] {
  const results: TrrcP5Record[] = [];

  // EWA P-5 results are a flat table — no nested sub-tables.
  // Match all <tr> blocks and look for rows with ≥5 cells where cell[0] is numeric.
  const rowMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];

  for (const row of rowMatches) {
    const tdMatches = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? [];
    const vals = tdMatches.map(td => stripHtml(td));

    // Expect at least 10 columns; first column must be a numeric operator number
    if (vals.length < 10 || !/^\d+$/.test(vals[0])) continue;

    results.push({
      operator_no:     vals[0],
      operator_name:   vals[1] ?? "",
      mailing_address: vals[2] || null,
      mailing_city:    vals[3] || null,
      mailing_state:   vals[4] || null,
      mailing_zip:     vals[5] || null,
      org_status:      vals[6] ?? "Unknown",
      org_type:        vals[7] || null,
      tnr_91114:       (vals[8] ?? "").toLowerCase() === "yes",
      mail_hold:       (vals[9] ?? "").toLowerCase() === "yes",
      phone:           vals[10] || null,
    });
  }

  return results;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the TRRC P-5 organization record for a given operator number.
 *
 * Returns null if the operator is not found or if the query fails.
 * Never throws.
 */
export async function fetchTrrcP5ByOperatorNo(
  operatorNo: string,
): Promise<TrrcP5Record | null> {
  if (!operatorNo?.trim()) return null;

  try {
    const params = new URLSearchParams({
      methodToCall:                      "search",
      "searchArgs.operatorNumbersArg":   operatorNo.trim(),
    });

    const res = await fetch(`${EWA_BASE}/organizationQueryAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":       "text/html,application/xhtml+xml",
        "User-Agent":   "Mozilla/5.0",
      },
      body: params.toString(),
    });

    if (!res.ok) return null;

    const html = await res.text();
    const records = parseP5Html(html);
    return records[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch P-5 records for an operator by name.
 * Returns the best match (exact or first partial match) or null.
 * Never throws.
 */
export async function fetchTrrcP5ByOperatorName(
  operatorName: string,
): Promise<TrrcP5Record | null> {
  if (!operatorName?.trim()) return null;

  try {
    const params = new URLSearchParams({
      methodToCall:                      "search",
      "searchArgs.operatorNameArg":      operatorName.trim(),
    });

    const res = await fetch(`${EWA_BASE}/organizationQueryAction.do`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":       "text/html,application/xhtml+xml",
        "User-Agent":   "Mozilla/5.0",
      },
      body: params.toString(),
    });

    if (!res.ok) return null;

    const html = await res.text();
    const records = parseP5Html(html);

    if (records.length === 0) return null;

    // Prefer exact name match; fall back to first result
    const upper = operatorName.trim().toUpperCase();
    const exact = records.find(r => r.operator_name.toUpperCase() === upper);
    return exact ?? records[0];
  } catch {
    return null;
  }
}

/**
 * Derive a human-readable P-5 status flag for report display.
 *
 * Returns:
 *   "green"  — Active, no flags
 *   "yellow" — Active-Ext (extension) or minor flag
 *   "red"    — Delinquent, Cancelled, TNR 91.114 hold, or mail hold
 */
export function p5StatusFlag(rec: TrrcP5Record): "green" | "yellow" | "red" {
  if (rec.tnr_91114) return "red";
  if (rec.org_status === "Delinquent" || rec.org_status === "Cancelled") return "red";
  if (rec.org_status === "Active-Ext" || rec.mail_hold) return "yellow";
  if (rec.org_status === "Active") return "green";
  return "yellow"; // Unknown / Inactive → caution
}
