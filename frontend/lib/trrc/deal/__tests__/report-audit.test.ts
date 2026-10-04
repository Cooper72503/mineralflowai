import { expect, it } from "vitest";
import { auditFixture } from "./report-audit-fixture";
import { renderDecisionRecordPdf } from "../decision-record-pdf";

it("renders conditional values, distinct title branches, and all oil cases without contradictory exclusions", async () => {
  const input = auditFixture();
  const pdf = await renderDecisionRecordPdf(input);
  const parse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer, options: Record<string, unknown>) => Promise<{ text: string }>;
  const pages: string[] = [];
  const result = await parse(pdf, { pagerender: async (p: { getTextContent: () => Promise<{ items: { str: string }[] }> }) => {
    const text = (await p.getTextContent()).items.map(i => i.str).join(" "); pages.push(text); return text;
  } });
  const text = result.text.replace(/\s+/g, " ");
  for (const phrase of ["Conditional lease scenario", "Ownership-based valuation unavailable", "Tract / interest branches", "unsupported", "1.000 MMBtu/Mcf", "not verified operator expenses", "PACKAGE EVIDENCE AND EXCLUDED INPUTS", "Scope is the submitted API list", "1.00% of lease revenue"])
    expect(text).toContain(phrase);
  expect(text).not.toMatch(/Not valued:|SUBMITTED APIS NOT IN THE VALUATION|undefined|NaN|\[object/);
  expect(pages.some(p => p.replace(/\s+/g, "").includes("10.MINERALFLOWENTRY") && p.replace(/\s+/g, "").includes("11.MINERALFLOWEXIT"))).toBe(true);
  const sensitivity = pages.find(p => p.includes("OIL PRICE SENSITIVITY"))!;
  for (let price = 40; price <= 100; price += 5) expect(sensitivity).toMatch(new RegExp(`\\b${price}\\b`));
  expect(pages.every(p => p.length > 200)).toBe(true);
}, 30000);

it("keeps actual inventory discrepancies without requiring an unrequested count", async () => {
  const { inventoryDecisionBlockers } = await import("../report-scope");
  const failures = ["Claimed 13 wells differs from 12 distinct valid submitted APIs.", "API 4232946216: unresolved identity", "Conflicting production volumes", "Entry 1: invalid API"];
  expect(inventoryDecisionBlockers(["Offered well count has not been supplied; package inventory completeness is unverified.", ...failures])).toEqual(failures);
});
