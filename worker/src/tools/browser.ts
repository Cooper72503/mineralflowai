/**
 * Browser Tools — Playwright
 * Handles TRRC sites that require a real browser session:
 *   S13 — ICE compliance violations (JSF/PrimeFaces)
 *   S12 — CODA imaged document list
 */

import { chromium, type Browser, type BrowserContext } from "playwright";

let _browser: Browser | null = null;

// Exported so other Playwright-based tools (e.g. county-records.ts) share
// this same browser instance instead of each launching their own Chromium.
export async function getBrowser(): Promise<Browser> {
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
  error?: string;
}> {
  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

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
    return { found: false, violations: [], open_count: 0, total_count: 0, searched_by: "", message: `ICE portal error: ${String(e)}`, error: String(e) };
  } finally {
    await context?.close();
  }
}

// ─── S3 — P-5 Operator Registration ──────────────────────────────────────────
//
// organizationQueryAction.do's own "operator name/number" fields
// (searchArgs.operatorNameArg / searchArgs.operatorNoArg, what ewa.ts's old
// searchOperator() sent) do not exist anywhere on the real form — confirmed
// live 2026-07-29. The actual operator name/number fields live on a
// SEPARATE page (operatorQueryAction.do), reached only via the "Search for
// Operator" button, and searching there is a dojo/JSF AJAX call
// (methodToCall=searchByName / searchByNumber) that a plain POST can't
// replicate — it returns a JSF partial-response XML error ("Please make a
// valid selection") instead of a real page. Confirmed the old fetcher was
// therefore never returning real P-5 data at all: it parsed the label text
// of an unrelated malformed table into garbage records like
// {"": "", "operator_s": "Organization Status:"}.
//
// Real flow (dual-listbox picker, same UI pattern TRRC uses elsewhere):
//   1. organizationQueryAction.do -> click "Search for Operator"
//   2. operatorQueryAction.do -> fill name or number, click ITS search
//      button (there are two "Search" buttons on this page — index 0 is
//      for operator number, index 1 is for operator name; picking the
//      wrong one silently searches for an empty number and finds nothing)
//   3. select the match in the "Search Result" listbox, click "Add" to
//      move it into "Operator Selection", click "Submit"
//   4. back on organizationQueryAction.do with the hidden
//      searchArgs.operatorNumbersArg now populated -> click the form's own
//      Submit to get the results list
//   5. click the operator-number drill-down link for the full detail page
//      (bond amount, agent, addresses) — the results list row only has
//      number/name/status.
//
// The detail page itself is NOT a uniform grid table (which is why the old
// generic findDataTable/rowsToObjects approach could never have worked even
// with the right search): most of it is two-column label/value rows
// ("Operator Number:" | "945936"), while Agent Information is a real
// 3-column grid (Name/Title/Mailing Address). Parsed accordingly below.

export interface P5OperatorRecord {
  operator_number:    string;
  operator_name:       string;
  organization_status: string;
  organization_type:   string;
  renewal_month:        string;
  location_address:    string;
  mailing_address:     string;
  bond_amount:          string;
  bond_type:            string;
  agent_name:           string;
  agent_title:          string;
  agent_address:        string;
}

export async function searchOperator(
  operatorName: string | null,
  operatorNumber: string | null,
): Promise<{
  found: boolean;
  record: P5OperatorRecord | null;
  p5_status: string | null;
  bond_amount: string | null;
  trrc_source_url: string | null;
  message: string;
  error?: string;
}> {
  if (!operatorName && !operatorNumber) {
    return { found: false, record: null, p5_status: null, bond_amount: null, trrc_source_url: null, message: "No operator name or number provided", error: "No operator name or number provided" };
  }

  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    await page.goto("https://webapps2.rrc.texas.gov/EWA/organizationQueryAction.do", { waitUntil: "networkidle", timeout: 30_000 });
    await page.click('input[value="Search for Operator"]');
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    if (operatorNumber) {
      await page.fill('input[name="operatorNumber"]', operatorNumber);
      await page.locator('input[value="Search"]').nth(0).click();
    } else {
      // TRRC truncates this field at 20 characters (confirmed on the live
      // form) — long operator names must be trimmed or the search silently
      // drops the tail. Critically, .trim() after slicing: TRRC's "Beginning
      // with these characters" search is a literal prefix match, and slicing
      // mid-word (e.g. "Southwest Royalties Inc" -> "Southwest Royalties ")
      // leaves a trailing space that doesn't match the comma actually
      // following the name in TRRC's registry ("SOUTHWEST ROYALTIES, INC.")
      // — confirmed live: the untrimmed string deterministically returned
      // zero results every time, while the same string trimmed found the
      // operator on the first try, every time. This looked like AJAX
      // flakiness (a retry with a shorter name coincidentally avoided the
      // bad trailing space) but was actually 100% reproducible.
      await page.fill('input[name="operatorName"]', String(operatorName).slice(0, 20).trim());
      await page.locator('input[value="Search"]').nth(1).click();
    }
    // The results <select> is populated by a dojo/AJAX call after the click
    // above, not a full navigation — waitForLoadState/networkidle doesn't
    // reliably cover it. A fixed waitForTimeout here raced the AJAX response
    // under load: confirmed live, the identical search returned "Operator
    // not found in P-5 registry" on one attempt and the correct record
    // moments later on an immediate retry. Wait for the option to actually
    // exist instead of guessing how long the AJAX call takes.
    await page.waitForSelector('select[name="resultSelection"] option', { timeout: 10_000 }).catch(() => null);

    const firstOption = await page.locator('select[name="resultSelection"] option').first();
    const optionValue = await firstOption.getAttribute("value").catch(() => null);
    if (!optionValue) {
      return { found: false, record: null, p5_status: null, bond_amount: null, trrc_source_url: null, message: "Operator not found in P-5 registry" };
    }

    await page.selectOption('select[name="resultSelection"]', optionValue);
    await page.locator('input[value="Add"]').click();
    await page.waitForTimeout(1_000);
    await page.locator('input[value="Submit"]').click();
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    // Back on organizationQueryAction.do with the operator now selected —
    // submit the main form to get the results list.
    await page.locator('input[type="submit"]').first().click();
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    const drillDownLink = page.locator('a[href*="organizationResultsDrillDownAction"]').first();
    if (!(await drillDownLink.count())) {
      return { found: false, record: null, p5_status: null, bond_amount: null, trrc_source_url: null, message: "No P-5 result row found after search" };
    }
    await drillDownLink.click();
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
    const trrcSourceUrl = page.url();

    // Label/value rows anywhere on the detail page (Organization Detail,
    // Assurance/Bond sections all use this same two-<td> pattern).
    const labelValuePairs = await page.locator("tr").evaluateAll((rows) =>
      rows
        .map((row) => {
          const cells = row.querySelectorAll(":scope > td");
          if (cells.length !== 2) return null;
          const label = (cells[0].textContent ?? "").trim();
          const value = (cells[1].textContent ?? "").replace(/\s+/g, " ").trim();
          if (!label.endsWith(":")) return null;
          return [label.slice(0, -1), value] as [string, string];
        })
        .filter((p): p is [string, string] => p !== null),
    );
    const lv: Record<string, string> = {};
    for (const [label, value] of labelValuePairs) {
      lv[label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "")] = value;
    }

    // Agent Information is a real 3-column grid (Name/Title/Mailing Address),
    // not label/value rows. Scoped from the "Agent Information" section
    // header specifically — an unscoped "Name:" match can land on the wrong
    // row elsewhere on the page and silently return empty cells.
    let agentName = "", agentTitle = "", agentAddress = "";
    const agentDataRow = page.locator(
      'xpath=//th[contains(text(),"Agent Information")]/ancestor::table[1]//th[normalize-space(text())="Name:"]/ancestor::tr[1]/following-sibling::tr[1]',
    ).first();
    if (await agentDataRow.count()) {
      const agentCells = await agentDataRow.locator("td").allTextContents();
      agentName = (agentCells[0] ?? "").trim();
      agentTitle = (agentCells[1] ?? "").trim();
      agentAddress = (agentCells[2] ?? "").replace(/\s+/g, " ").trim();
    }

    const record: P5OperatorRecord = {
      operator_number:     lv["operator_number"] || optionValue,
      operator_name:        lv["operator_name"] || String(operatorName ?? ""),
      organization_status: lv["organization_status"] || "",
      organization_type:   lv["organization_type"] || "",
      renewal_month:         lv["renewal_month"] || "",
      location_address:    lv["location_address"] || "",
      mailing_address:      lv["mailing_address"] || "",
      bond_amount:           lv["amount"] || "",
      bond_type:             lv["type"] || "",
      agent_name:            agentName,
      agent_title:           agentTitle,
      agent_address:         agentAddress,
    };

    return {
      found: true,
      record,
      p5_status:   record.organization_status || null,
      bond_amount: record.bond_amount || null,
      trrc_source_url: trrcSourceUrl,
      message:     `P-5 record found for operator ${record.operator_number} — ${record.operator_name} (${record.organization_status || "status unknown"})`,
    };
  } catch (e) {
    return { found: false, record: null, p5_status: null, bond_amount: null, trrc_source_url: null, message: `P-5 operator search failed: ${String(e).slice(0, 100)}`, error: String(e) };
  } finally {
    await context?.close();
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
  error?: string;
}> {
  const digits = apiNumber.replace(/\D/g, "");
  const prefix = digits.slice(2, 5);
  const suffix = digits.slice(5, 10);

  // CODA deep-link URL for this specific API
  const codaSearchUrl = `https://www.rrc.texas.gov/resource-center/research/oil-gas-data/public-gis-viewer/?api=${digits.slice(0, 10)}`;
  const codaDirectUrl = `https://webapps2.rrc.texas.gov/EWA/cogisQueryAction.do?searchArgs.apiNoPrefixArg=${prefix}&searchArgs.apiNoSuffixArg=${suffix}&methodToCall=search`;

  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

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
      error: String(e),
    };
  } finally {
    await context?.close();
  }
}
