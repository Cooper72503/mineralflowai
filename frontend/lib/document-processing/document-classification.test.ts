import { describe, expect, it } from "vitest";
import {
  classifyDocumentCategory,
  mapExtractionClassToCategory,
  resolveDocumentCategory,
} from "./document-classification";

describe("classifyDocumentCategory", () => {
  it("classifies division order", () => {
    const r = classifyDocumentCategory("STATE OF TEXAS\nDIVISION ORDER\nPayee:");
    expect(r.category).toBe("division_order");
    expect(r.score).toBeGreaterThan(0.8);
  });

  it("classifies mineral deed", () => {
    expect(classifyDocumentCategory("MINERAL DEED\nGrantor:").category).toBe("mineral_deed");
  });

  it("classifies oil and gas lease", () => {
    expect(classifyDocumentCategory("PAID-UP OIL AND GAS LEASE\nLessor:").category).toBe("oil_gas_lease");
  });

  it("classifies assignment", () => {
    expect(classifyDocumentCategory("ASSIGNMENT OF OIL AND GAS LEASE").category).toBe("assignment");
  });

  it("maps operator intel to other", () => {
    const r = classifyDocumentCategory("OPERATOR REPORT — Well Completion");
    expect(r.category).toBe("other");
  });
});

describe("resolveDocumentCategory", () => {
  it("prefers strong early classification", () => {
    const early = { category: "division_order" as const, score: 0.88 };
    expect(resolveDocumentCategory(early, "oil_and_gas_lease")).toBe("division_order");
  });

  it("falls back to heuristic when early is weak", () => {
    const early = { category: "other" as const, score: 0.42 };
    expect(resolveDocumentCategory(early, "mineral_deed")).toBe("mineral_deed");
  });
});

describe("mapExtractionClassToCategory", () => {
  it("maps oil_and_gas_lease to oil_gas_lease", () => {
    expect(mapExtractionClassToCategory("oil_and_gas_lease")).toBe("oil_gas_lease");
  });

  it("maps royalty_deed to mineral_deed", () => {
    expect(mapExtractionClassToCategory("royalty_deed")).toBe("mineral_deed");
  });
});
