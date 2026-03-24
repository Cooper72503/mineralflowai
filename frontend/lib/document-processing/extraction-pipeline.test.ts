import { describe, expect, it } from "vitest";
import { runStructuredExtraction } from "./extraction-pipeline";

describe("runStructuredExtraction", () => {
  it("fills grantor/grantee from OCR when normalized text is empty (image PDF path)", async () => {
    const ocr = `MINERAL DEED

Grantor: JANE DOE
Grantee: ACME MINERALS LLC

Being 40 acres in REEVES COUNTY, Texas`;
    const { parsed, artifacts } = await runStructuredExtraction({
      normalizedText: "",
      rawPdfText: "",
      ocrText: ocr,
      pdfNumPages: 1,
      skipOpenAi: true,
    });
    expect(parsed.grantor).toMatch(/Jane/i);
    expect(parsed.grantee).toMatch(/Acme|ACME/i);
    expect(parsed.state).toBe("TX");
    expect(artifacts.combined_text.length).toBeGreaterThan(10);
    expect(artifacts.extraction_confidence).toBeGreaterThan(0);
    expect(artifacts.extraction_status).not.toBe("failed");
  });

  it("pulls lessor/lessee from lease text", async () => {
    const t = `OIL AND GAS LEASE
Lessor: Pat Owner
Lessee: Drill Bit LLC
Section 5, Block 22, H&GN RR Co Survey, Reeves County, TX`;
    const { parsed } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(parsed.lessor).toMatch(/Pat/i);
    expect(parsed.lessee).toMatch(/Drill/i);
    expect(parsed.parties?.length).toBeGreaterThanOrEqual(2);
    expect(parsed.parties?.[0]?.kind).toBeDefined();
  });

  it("extracts tax / ownership style owner and mailing address", async () => {
    const t = `MINERAL OWNERSHIP RECORD
Owner: Terry Taxpayer
Mailing Address:
500 Elm Rd
Midland, TX 79701`;
    const { parsed } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(parsed.owner).toMatch(/Terry/i);
    expect(parsed.mailing_address).toMatch(/500 Elm/i);
    expect(parsed.county).toBe("Midland");
  });

  it("classifies operator / intel document and keeps non-zero confidence", async () => {
    const t = `CONFIDENTIAL FIELD SUMMARY
Operator Report — Well Completion
Permian Basin`;
    const { parsed, artifacts } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(parsed.document_type).toMatch(/Operator|Intel/i);
    expect(artifacts.extraction_confidence).toBeGreaterThan(0);
  });

  it("final failsafe runs when emergency is skipped but owner/geo/type stayed empty", async () => {
    const t = `Grantee: Random Holdco LLC

Section 5, Block 22, H&GN RR Co Survey, abstract tract narrative with no two-letter state tokens or city comma state zip lines
additional filler so combined text clearly exceeds the minimum length threshold`;
    const { parsed, artifacts } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(artifacts.inferred_fields.final_failsafe).toBeDefined();
    expect(artifacts.fallback_extracted_fields.final).toBeDefined();
    expect(parsed.document_type).toBeTruthy();
    expect(parsed.extraction_status).toBe("low_confidence");
  });

  it("runs emergency pass when no headings match but text is long enough", async () => {
    const t =
      "abcdefghijklmnopqrstuvwxyz unlabeled narrative filler text repeated for minimum length " +
      "abcdefghijklmnopqrstuvwxyz more filler without state names or grantor labels here end";
    const { artifacts } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(Object.keys(artifacts.fallback_extracted_fields.emergency as object).length).toBeGreaterThan(0);
    expect(artifacts.inferred_fields.emergency).toBeDefined();
  });

  it("emergency fallback fills structure when primary merge was empty but combined text exists", async () => {
    const t = `Some header noise
STATE OF TEXAS
Unknown instrument reference

JOHN PUBLIC
123 OAK LANE
ODESSA, TX 79761

Section 12 Abstract 450 in Ector area minerals discussed`;
    const { parsed, artifacts } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(parsed.state).toBe("TX");
    expect(parsed.owner || parsed.grantor).toBeTruthy();
    expect(parsed.legal_description || parsed.county).toBeTruthy();
    expect(artifacts.final_extracted_fields).toBeDefined();
    expect(artifacts.fallback_extracted_fields.emergency).toBeDefined();
    expect(artifacts.raw_pdf_text).toBe("");
    expect(artifacts.combined_text.length).toBeGreaterThan(0);
  });

  it("maps owner-side display from grantor for deed when owner empty", async () => {
    const t = `MINERAL DEED
Grantor: Seller Person
Grantee: Buyer LLC`;
    const { parsed } = await runStructuredExtraction({
      normalizedText: t,
      skipOpenAi: true,
    });
    expect(parsed.owner).toMatch(/Seller/i);
    expect(parsed.buyer).toMatch(/Buyer/i);
  });
});
