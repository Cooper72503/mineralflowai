/**
 * TRRC Operator Profile — P-5 Organization Report + H-15 Annual Production.
 *
 * These two TRRC EWA endpoints return everything available about an operator
 * and the annual production history for a well, given only a lease ID or
 * API number.  They are queried after the main wellbore + lease lookups so
 * that operator contact, bond status, and full-year production totals are
 * always present in the report.
 *
 * P-5 Org Report:  https://webapps2.rrc.texas.gov/EWA/p5OrgQueryAction.do
 *   — current operator name, P-5 number, bond info, active/inactive status,
 *     mailing address, and phone number on file with TRRC.
 *
 * H-15 Annual:     https://webapps2.rrc.texas.gov/EWA/h15ReportQueryAction.do
 *   — cumulative annual oil (BBL), gas (MCF), and water (BBL) by calendar year
 *     for a specific lease, going back as far as TRRC has digitized records.
 */

import * as cheerio from "cheerio";
import { withTrrcRetry } from "../underwriting/trrc-utils";

const EWA_BASE = "https://webapps2.rrc.texas.gov/EWA";

// ─── P-5 Operator Organization ────────────────────────────────────────────────

export type TrrcOperatorProfile = {
  /** TRRC-assigned P-5 operator number */
  p5_number: string | null;
  /** Operator name exactly as filed with TRRC */
  operator_name: string | null;
  /** "Active" | "Inactive" | "Terminated" | unknown */
  p5_status: string | null;
  /** Primary mailing address on file */
  mailing_address: string | null;
  /** Phone number on file */
  phone: string | null;
  /** Bond type ("Individual", "Blanket", etc.) */
  bond_type: string | null;
  /** Bond amount in USD */
  bond_amount_usd: number | null;
  /** Bonding company name */
  bonding_company: string | null;
  /** Bond number */
  bond_number: string | null;
  /** Date the P-5 was last filed or renewed */
  last_filed_date: string | null;
};

async function _fetchTrrcOperatorProfile(operatorName: string, _signal: AbortSignal): Promise<TrrcOperatorProfile | null> {
  const params = new URLSearchParams({
    "searchArgs.operatorNameArg": operatorName.trim(),
    "pager.offset": "0",
    "pager.pageSize": "5",
  });
  const res = await fetch(`${EWA_BASE}/p5OrgQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)" },
    body: params.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  return parseP5Html(await res.text());
}

/**
 * Fetch TRRC P-5 operator organization record by operator name.
 * Returns null when no record is found or the request fails.
 */
export async function fetchTrrcOperatorProfile(operatorName: string): Promise<TrrcOperatorProfile | null> {
  if (!operatorName.trim()) return null;
  // Single attempt — internal retries here, stacked with fetchTrrcAnnualProductionBestOf's
  // own sequential oil+gas calls, could push pull_inspections past Vercel's 300s maxDuration.
  return withTrrcRetry(sig => _fetchTrrcOperatorProfile(operatorName, sig), null, { retries: 0 });
}

function parseP5Html(html: string): TrrcOperatorProfile | null {
  const $ = cheerio.load(html);

  // TRRC P-5 result pages list operators in a data table.
  // Each row has: P-5 No | Operator Name | Status | Address | Phone
  // We take the first (best-match) row.
  const rows: string[][] = [];
  $("table tr").each((_i, tr) => {
    const cells: string[] = [];
    $(tr).find("td").each((_j, td) => {
      cells.push($(td).text().replace(/\s+/g, " ").trim());
    });
    if (cells.length >= 3) rows.push(cells);
  });

  if (rows.length === 0) return null;

  const row = rows[0];
  const p5No      = row[0] ?? null;
  const name      = row[1] ?? null;
  const status    = row[2] ?? null;
  const address   = row[3] ?? null;
  const phone     = row[4] ?? null;

  // Bond detail is typically on a follow-up detail page linked from the P-5 number.
  // We parse whatever is visible in the summary table.
  const bondMatch = html.match(/bond[^:]*:\s*([^\n<]{3,80})/i);
  const bondAmtMatch = html.match(/\$\s*([\d,]+(?:\.\d+)?)/);

  return {
    p5_number:       p5No && p5No.match(/\d/) ? p5No : null,
    operator_name:   name || null,
    p5_status:       status || null,
    mailing_address: address || null,
    phone:           phone || null,
    bond_type:       bondMatch ? bondMatch[1].trim() : null,
    bond_amount_usd: bondAmtMatch ? parseFloat(bondAmtMatch[1].replace(/,/g, "")) : null,
    bonding_company: null,
    bond_number:     null,
    last_filed_date: null,
  };
}

// ─── H-15 Annual Production ───────────────────────────────────────────────────

export type TrrcAnnualProductionRow = {
  year: number;
  oil_bbl: number;
  gas_mcf: number;
  water_bbl: number | null;
  condensate_bbl: number | null;
};

export type TrrcAnnualProduction = {
  lease_number: string;
  district_code: string;
  rows: TrrcAnnualProductionRow[];
  /** Calendar year of the most recent row */
  latest_year: number | null;
  /** Cumulative oil over all reported years */
  cum_oil_bbl: number;
  /** Cumulative gas over all reported years */
  cum_gas_mcf: number;
};

async function _fetchTrrcAnnualProduction(distCode: string, leaseNo: string, reportType: "O" | "G", _signal: AbortSignal): Promise<TrrcAnnualProduction | null> {
  const params = new URLSearchParams({
    "searchArgs.districtCodeArg": distCode,
    "searchArgs.leaseNumberArg":  leaseNo,
    "searchArgs.reportTypeArg":   reportType,
    "pager.offset":   "0",
    "pager.pageSize": "50",
  });
  const res = await fetch(`${EWA_BASE}/h15ReportQueryAction.do`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; MineralFlow-Diligence/1.0)" },
    body: params.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  return parseH15Html(await res.text(), distCode, leaseNo);
}

/**
 * Fetch H-15 annual production report for a specific lease (distCode + leaseNo).
 * Returns null when no data is found or the request fails.
 */
export async function fetchTrrcAnnualProduction(
  distCode: string,
  leaseNo:  string,
  reportType: "O" | "G" = "O",
): Promise<TrrcAnnualProduction | null> {
  if (!distCode || !leaseNo) return null;
  return withTrrcRetry(sig => _fetchTrrcAnnualProduction(distCode, leaseNo, reportType, sig), null, { retries: 0 });
}

/**
 * Fetch H-15 for a lease, trying oil first then gas if oil returns nothing.
 */
export async function fetchTrrcAnnualProductionBestOf(
  distCode: string,
  leaseNo:  string,
): Promise<TrrcAnnualProduction | null> {
  const oil = await fetchTrrcAnnualProduction(distCode, leaseNo, "O");
  if (oil && oil.rows.length > 0) return oil;
  return fetchTrrcAnnualProduction(distCode, leaseNo, "G");
}

function parseH15Html(
  html: string,
  distCode: string,
  leaseNo:  string,
): TrrcAnnualProduction | null {
  const $ = cheerio.load(html);

  // H-15 result table columns (oil report):
  //   Year | District | Lease No | Oil (BBL) | Gas (MCF) | Water (BBL) | Condensate (BBL)
  const rows: TrrcAnnualProductionRow[] = [];

  $("table tr").each((_i, tr) => {
    const cells: string[] = [];
    $(tr).find("td").each((_j, td) => {
      cells.push($(td).text().replace(/[ \s]+/g, " ").trim());
    });
    if (cells.length < 4) return;

    // First cell should be a 4-digit year
    const yearStr = cells[0].replace(/\D/g, "");
    if (yearStr.length !== 4) return;
    const year = parseInt(yearStr, 10);
    if (year < 1900 || year > 2100) return;

    const parseN = (s: string) => {
      const n = parseFloat((s ?? "").replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    rows.push({
      year,
      oil_bbl:        parseN(cells[3] ?? ""),
      gas_mcf:        parseN(cells[4] ?? ""),
      water_bbl:      cells[5] ? parseN(cells[5]) : null,
      condensate_bbl: cells[6] ? parseN(cells[6]) : null,
    });
  });

  if (rows.length === 0) return null;

  rows.sort((a, b) => a.year - b.year);

  return {
    lease_number:  leaseNo,
    district_code: distCode,
    rows,
    latest_year:  rows[rows.length - 1]?.year ?? null,
    cum_oil_bbl:  rows.reduce((s, r) => s + r.oil_bbl, 0),
    cum_gas_mcf:  rows.reduce((s, r) => s + r.gas_mcf, 0),
  };
}
