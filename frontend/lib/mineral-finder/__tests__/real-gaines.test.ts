import { expect, it } from "vitest";
import fixture from "./fixtures/gaines-real.json";
import { screen } from "../screen";
import { parseFinderRequest } from "../criteria";
import { renderFinderReport } from "../report";
import type { FinderSnapshot, Production } from "../types";
import { createRequire } from "node:module";

const snapshot = fixture as unknown as FinderSnapshot;
it("keeps an actual historical Gaines well and same-field offsets traceable to source rows", () => {
  const result = screen(
    snapshot,
    parseFinderRequest("Gaines County before 1995"),
    "real captured Gaines evidence",
  );
  expect(result.prospects).toHaveLength(1);
  const p = result.prospects[0];
  expect(p.api).toBe("4216503252");
  expect(p.ageEvidence.date).toBe("1963-07-24");
  expect(p.well.association?.fieldName).toBe("MEANS  N. (QUEEN SAND)");
  expect(p.catalog.length).toBe(4);
  expect(p.offsets.map((o) => o.api)).toEqual(["4216532924", "4216532525"]);
  expect(p.geologicalConfidence).toBe("low");
  expect(p.economics.status).toBe("insufficient_data");
  expect(
    p.well.associations.every((a) => a.sourceRow && a.raw.length === 59),
  ).toBe(true);
});
it("renders the real evidence with explicit limitations, source references, and embedded fonts", async () => {
  const production = fixture.production as Production;
  const result = screen(
    snapshot,
    parseFinderRequest("Gaines County before 1995"),
    "Captured-source report regression",
    new Map([[production.key, production]]),
  );
  const parse = createRequire(import.meta.url)("pdf-parse/lib/pdf-parse.js");
  const pdf = await renderFinderReport(result, "4216503252");
  const doc = await parse(pdf);
  expect(doc.text).toContain("4216503252");
  expect(doc.text).toContain("Geological confidence: low");
  expect(doc.text).toContain("INSUFFICIENT DATA");
  expect(doc.text).toContain("approval required");
  expect(doc.text).toContain("rrc-wellbore");
  expect(doc.text).toContain("beg-catalog");
  expect(doc.text).toContain("49 returned monthly slots");
  expect(doc.text).toContain("47 contain reported volumes");
  expect(doc.text).not.toMatch(/NaN|undefined/);
  expect(pdf.length).toBeGreaterThan(15000);
  await expect(renderFinderReport(result, "4216500000")).rejects.toThrow(
    "not found",
  );
}, 20000);
