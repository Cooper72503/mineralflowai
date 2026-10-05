import { expect, it } from "vitest";
import { auditFixture } from "./report-audit-fixture";
import { renderDecisionRecordPdf, type DecisionRecordInput } from "../decision-record-pdf";
import { assembleDecision } from "../decision-layer";

async function pages(input: DecisionRecordInput) {
  const pdf = await renderDecisionRecordPdf(input);
  const parse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer, options: Record<string, unknown>) => Promise<{ text: string }>;
  const output: string[] = [];
  await parse(pdf, { pagerender: async (p: { getTextContent: () => Promise<{ items: { str: string }[] }> }) => {
    const text = (await p.getTextContent()).items.map(i => i.str).join(" ").replace(/\s+/g, " ");
    output.push(text); return text;
  } });
  return output;
}

it("keeps the complete executive memo on page one with actual 100% royalty input and return basis", async () => {
  const input = auditFixture();
  const l = input.deal.leases[0];
  const a = { ...input.record.leases[0].economics.assumptions, netRevenueInterest: 1 };
  input.record = assembleDecision(input.deal, { [l.key]: a });
  const recordBefore = JSON.stringify(input.record);
  const p = await pages(input);
  for (const label of ["THE ASSET", "CONDITIONAL ECONOMICS", "THREE MATERIAL FINDINGS", "NEXT ACTIONS", "100.00% of lease revenue", "top of the recommended range", "not supplied; IRR at asking unavailable"])
    expect(p[0]).toContain(label);
  expect(p[0]).toContain(input.record.verdict);
  expect(p[0]).not.toContain("Ownership-based valuation unavailable");
  expect(p[1]).toContain("2. ASSET AND API OVERVIEW");
  expect(p.join(" ")).toContain("Ownership-based valuation unavailable"); // detail retained
  expect(JSON.stringify(input.record)).toBe(recordBefore); // presentation cannot mutate decision
}, 30000);

it("states unavailable economics and title without substituting zero values or a clean title", async () => {
  const input = auditFixture();
  input.deal.leases[0].title = { status: "unavailable", reason: "Clerk request failed", analysis: null, indexedInstruments: 0, readInstruments: 0 };
  const r = input.record.leases[0];
  r.economics = { ...r.economics, status: "unavailable", reason: "Insufficient production", scenarios: null };
  r.entry = null; r.exit = null;
  const p = await pages(input);
  expect(p[0]).toContain("Insufficient production");
  expect(p[0]).toContain("Clerk request failed");
  expect(p[0]).not.toMatch(/Base value at|Walk-away ceiling|3-year base exit|undefined|NaN/);
  expect(p[1]).toContain("2. ASSET AND API OVERVIEW");
}, 30000);

it("separates multi-lease interests into executive pages and keeps excluded inputs visible", async () => {
  const input = auditFixture();
  const l = structuredClone(input.deal.leases[0]);
  l.key = "TX:8:O:2"; l.leaseName = "SECOND TEST LEASE"; l.leaseNumber = "2";
  input.deal.leases.push(l);
  const r = structuredClone(input.record.leases[0]); r.leaseKey = l.key; r.leaseName = l.leaseName;
  r.economics.assumptions.netRevenueInterest = 0.02;
  input.record.leases.push(r);
  input.deal.excluded.push({ api: null, input: "invalid", reason: "Invalid API" });
  const p = await pages(input);
  expect(p[0]).toContain("LEASE 1 OF 2");
  expect(p[0]).toContain("1 excluded input(s)");
  expect(p[0]).toContain("1.00% of lease revenue");
  expect(p[1]).toContain("LEASE 2 OF 2");
  expect(p[1]).toContain("SECOND TEST LEASE");
  expect(p[1]).toContain("2.00% of lease revenue");
  expect(p[2]).toContain("2. ASSET AND API OVERVIEW");
}, 30000);

it("handles a package with no resolved leases without inventing a value", async () => {
  const input = auditFixture(); input.deal.leases = []; input.record.leases = [];
  input.deal.excluded = [{ input: "4232900001", api: "4232900001", reason: "Unresolved" }];
  const p = await pages(input);
  expect(p[0]).toContain("0 resolved lease(s)");
  expect(p[0]).toContain("no matched lease decision");
  expect(p[0]).not.toMatch(/Base value at|undefined|NaN/);
}, 30000);
