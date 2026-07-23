/**
 * Browser Tools — Playwright
 * Handles TRRC sites that require a real browser session:
 *   S13 — ICE compliance violations (JSF/PrimeFaces)
 *   S12 — CODA imaged document list
 */

import { chromium, type Browser, type BrowserContext } from "playwright";

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

// ─── S13 — Compliance Violations (ICE Portal) ────────────────────────────────

export interface Violation {
  violation_discovery_date: string;
  violated_rule:            string;
  violated_rule_description:string;
  major_violation:          string;
  last_enforcement_action:  string;
  compliant_on_reinspection:string;
  penalty:                  string;
}

export async function getComplianceViolations(
  operatorNumber: string | null,
  apiNumber: string | null,
): Promise<{
  found: boolean;
  violations: Violation[];
  open_count: number;
  total_count: number;
  searched_by: string;
  message: string;
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto("https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml", {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Try by operator number first (more complete — gets all violations for the operator)
    if (operatorNumber) {
      const opInput = page.locator('input[id*="operatorNo"], input[name*="operatorNo"]').first();
      if (await opInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await opInput.fill(operatorNumber);
        await page.locator('input[type="submit"], button[type="submit"]').first().click();
        await page.waitForLoadState("networkidle", { timeout: 20_000 });
      }
    } else if (apiNumber) {
      // Try by API number
      const digits = apiNumber.replace(/\D/g, "");
      const prefix = digits.slice(2, 5);
      const suffix = digits.slice(5, 10);
      const prefixInput = page.locator('input[id*="apiPrefix"], input[name*="apiPrefix"], input[id*="apiNoPrefixArg"]').first();
      if (await prefixInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await prefixInput.fill(prefix);
        const suffixInput = page.locator('input[id*="apiSuffix"], input[name*="apiSuffix"], input[id*="apiNoSuffixArg"]').first();
        await suffixInput.fill(suffix);
        await page.locator('input[type="submit"], button[type="submit"]').first().click();
        await page.waitForLoadState("networkidle", { timeout: 20_000 });
      }
    }

    // Wait for results table
    await page.waitForSelector('table', { timeout: 15_000 }).catch(() => null);

    // Extract violation rows from all tables
    const violations: Violation[] = [];
    const tables = await page.locator("table").all();

    for (const table of tables) {
      const rows = await table.locator("tr").all();
      if (rows.length < 2) continue;

      const headerCells = await rows[0].locator("th, td").allTextContents();
      const headerStr = headerCells.join(" ").toLowerCase();
      if (!headerStr.includes("violation") && !headerStr.includes("rule") && !headerStr.includes("date")) continue;

      const keys = headerCells.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, ""));

      for (const row of rows.slice(1)) {
        const cells = await row.locator("td").allTextContents();
        if (cells.length < 3) continue;
        const obj: Record<string, string> = {};
        keys.forEach((k, i) => { obj[k] = (cells[i] ?? "").trim(); });

        violations.push({
          violation_discovery_date:  obj["date"] || obj["discovery_date"] || obj["violation_date"] || "",
          violated_rule:             obj["rule"] || obj["violated_rule"] || "",
          violated_rule_description: obj["description"] || obj["rule_description"] || obj["violated_rule_description"] || "",
          major_violation:           obj["major"] || obj["major_violation"] || "",
          last_enforcement_action:   obj["last_action"] || obj["enforcement_action"] || obj["last_enforcement_action"] || "",
          compliant_on_reinspection: obj["compliant"] || obj["compliant_on_reinspection"] || "",
          penalty:                   obj["penalty"] || obj["penalty_amount"] || "",
        });
      }
    }

    const openCount = violations.filter(v =>
      v.compliant_on_reinspection === "N" ||
      /open|unresolved/i.test(v.last_enforcement_action)
    ).length;

    if (violations.length === 0) {
      return { found: false, violations: [], open_count: 0, total_count: 0, searched_by: operatorNumber ? "operator_number" : "api_number", message: "No violations found" };
    }

    return {
      found: true,
      violations,
      open_count:  openCount,
      total_count: violations.length,
      searched_by: operatorNumber ? "operator_number" : "api_number",
      message:     `${violations.length} violation(s) found, ${openCount} open`,
    };
  } catch (e) {
    return { found: false, violations: [], open_count: 0, total_count: 0, searched_by: "", message: `ICE portal error: ${String(e)}` };
  } finally {
    await context.close();
  }
}

// ─── S12 — CODA Imaged Documents ─────────────────────────────────────────────

export interface CodaDocument {
  document_type:  string;
  document_date:  string;
  pages:          string;
  document_id:    string;
  direct_url:     string;
}

export async function getCodaDocuments(apiNumber: string): Promise<{
  found: boolean;
  documents: CodaDocument[];
  document_types_present: string[];
  coda_search_url: string;
  message: string;
}> {
  const digits = apiNumber.replace(/\D/g, "");
  const prefix = digits.slice(2, 5);
  const suffix = digits.slice(5, 10);

  // CODA deep-link URL for this specific API
  const codaSearchUrl = `https://www.rrc.texas.gov/resource-center/research/oil-gas-data/public-gis-viewer/?api=${digits.slice(0, 10)}`;
  const codaDirectUrl = `https://webapps2.rrc.texas.gov/EWA/cogisQueryAction.do?searchArgs.apiNoPrefixArg=${prefix}&searchArgs.apiNoSuffixArg=${suffix}&methodToCall=search`;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(codaDirectUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForSelector("table", { timeout: 10_000 }).catch(() => null);

    const documents: CodaDocument[] = [];
    const tables = await page.locator("table").all();

    for (const table of tables) {
      const rows = await table.locator("tr").all();
      if (rows.length < 2) continue;
      const headers = await rows[0].locator("th, td").allTextContents();
      const headerStr = headers.join(" ").toLowerCase();
      if (!headerStr.includes("doc") && !headerStr.includes("type") && !headerStr.includes("date")) continue;

      const keys = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, ""));

      for (const row of rows.slice(1)) {
        const cells = await row.locator("td").allTextContents();
        const linkHref = await row.locator("a").first().getAttribute("href").catch(() => "");
        if (cells.length < 2) continue;
        const obj: Record<string, string> = {};
        keys.forEach((k, i) => { obj[k] = (cells[i] ?? "").trim(); });
        documents.push({
          document_type: obj["document_type"] || obj["type"] || obj["doc_type"] || "",
          document_date: obj["date"] || obj["document_date"] || obj["doc_date"] || "",
          pages:         obj["pages"] || "",
          document_id:   obj["document_id"] || obj["doc_id"] || "",
          direct_url:    linkHref ? `https://webapps2.rrc.texas.gov${linkHref}` : "",
        });
      }
    }

    const docTypes = [...new Set(documents.map(d => d.document_type).filter(Boolean))];

    return {
      found: documents.length > 0,
      documents,
      document_types_present: docTypes,
      coda_search_url:        codaDirectUrl,
      message: documents.length > 0
        ? `${documents.length} imaged document(s): ${docTypes.join(", ")}`
        : `No imaged documents found. Direct link: ${codaDirectUrl}`,
    };
  } catch (e) {
    // Even if scraping fails, return the deep-link URL — still useful
    return {
      found: false,
      documents: [],
      document_types_present: [],
      coda_search_url: codaDirectUrl,
      message: `CODA search failed (${String(e).slice(0, 60)}). Manual link: ${codaDirectUrl}`,
    };
  } finally {
    await context.close();
  }
}
