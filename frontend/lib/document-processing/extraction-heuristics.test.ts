import { describe, expect, it } from "vitest";
import {
  classifyDocumentFromKeywords,
  extractHeuristicFields,
  inferCountyFromTxCityLine,
} from "./heuristic-field-extraction";

describe("classifyDocumentFromKeywords", () => {
  it("detects mineral deed", () => {
    expect(classifyDocumentFromKeywords("STATE OF TEXAS\nMINERAL DEED\n")).toBe("mineral_deed");
  });
  it("detects oil and gas lease", () => {
    expect(classifyDocumentFromKeywords("PAID-UP OIL AND GAS LEASE\nLessor:")).toBe("oil_and_gas_lease");
  });
  it("detects assignment", () => {
    expect(classifyDocumentFromKeywords("ASSIGNMENT OF OIL AND GAS LEASE")).toBe("assignment");
  });
  it("detects tax / ownership record", () => {
    expect(classifyDocumentFromKeywords("MINERAL OWNERSHIP RECORD\nTax Year")).toBe(
      "tax_mineral_ownership_record"
    );
  });
  it("detects operator / intel report", () => {
    expect(classifyDocumentFromKeywords("OPERATOR REPORT — Well Completion")).toBe("operator_intel_report");
  });
});

describe("extractHeuristicFields", () => {
  it("pulls grantor/grantee and Reeves County from mineral deed text", () => {
    const t = `MINERAL DEED

Grantor: Jane Q. Public
Grantee: ABC Minerals LLC

Being 40 acres in Reeves County, TX`;
    const h = extractHeuristicFields(t, {});
    expect(h.grantor).toMatch(/Jane/i);
    expect(h.grantee).toMatch(/ABC/i);
    expect(h.county).toMatch(/Reeves/i);
    expect(h.state).toBe("TX");
  });

  it("pulls lessor/lessee for lease", () => {
    const t = `OIL AND GAS LEASE
Lessor: John Smith
Lessee: Drilling Co LLC
Royalty: 1/8
Primary term: 3 years
Section 12, Block 4, T1N`;
    const h = extractHeuristicFields(t, {});
    expect(h.lessor).toMatch(/John/i);
    expect(h.lessee).toMatch(/Drilling/i);
    expect(h.royalty_rate).toMatch(/1\/8/);
    expect(h.detected_class).toBe("oil_and_gas_lease");
  });

  it("owner + mailing for tax-style doc", () => {
    const t = `MINERAL OWNERSHIP RECORD
Owner: Mary Johnson
Mailing Address:
123 Main St
Midland, TX 79701`;
    const h = extractHeuristicFields(t, {});
    expect(h.owner).toMatch(/Mary/i);
    expect(h.mailing_address).toMatch(/123 Main/i);
  });

  it("finds acreage with ac / acres", () => {
    const t = `TRACT containing 160.5 acres, more or less, in Ward County, Texas`;
    const h = extractHeuristicFields(t, {});
    expect(h.acreage).toBe(160.5);
  });

  it("uses OCR text in combined classification when normalized text is thin", () => {
    const ocr = "MINERAL DEED\nGrantor: X\nGrantee: Y\n";
    const h = extractHeuristicFields("x", { ocrText: ocr });
    expect(h.detected_class).toBe("mineral_deed");
  });

  it("infers county from city line when county phrase missing", () => {
    const t = `Property Owner\n123 Oak St\nMidland, TX 79705`;
    const h = extractHeuristicFields(t, {});
    expect(h.county).toBe("Midland");
  });
});

describe("inferCountyFromTxCityLine", () => {
  it("maps Odessa to Ector", () => {
    expect(inferCountyFromTxCityLine("Branch office\nOdessa, TX")).toBe("Ector");
  });
});
