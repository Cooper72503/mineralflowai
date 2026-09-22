import { describe, it, expect } from "vitest";
import React from "react";
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { TitleChainPage, TitleEvidenceDetailPage } from "../report-builder";
import type { TitleReportInput } from "../title/report-input";

const run = { id: "11111111-2222-3333-4444-555555555555", original_input: "42-165-02733" } as never;
const id = { apiNumber: "42-165-02733", wellName: "MASK HZ UNIT", county: "GAINES" } as never;

const analyzed: TitleReportInput = {
  status: "analyzed",
  headline: "Title analysis published (version 2).",
  jobId: "f4edca51-9721-4b87-970b-e60660255f01",
  stageDetail: "analysis complete",
  subjectMatchedCount: 2,
  subjectLeads: [
    { instrumentType: "mineral_deed", instrumentNumber: "39265019", recordedDate: "1998-04-02", grantor: "SMITH, J R; SMITH, M A", grantee: "MASK ROYALTY PARTNERS LP", legalDescription: "MASK HZ UNIT, SEC 12 BLK A-21 PSL SURVEY", contentVerified: true },
    { instrumentType: "assignment", instrumentNumber: "40113887", recordedDate: "2004-11-18", grantor: "MASK ROYALTY PARTNERS LP", grantee: "PERMIAN MIDLAND MINERALS LLC", legalDescription: "MASK HZ UNIT, SEC 12 BLK A-21 PSL SURVEY", contentVerified: false },
    { instrumentType: "oil_and_gas_lease", instrumentNumber: "41200544", recordedDate: "2012-06-05", grantor: "PERMIAN MIDLAND MINERALS LLC", grantee: "OPERATOR RESOURCES INC", legalDescription: "SEC 7 BLK A-22 PSL SURVEY", contentVerified: false },
  ],
  totalIndexRows: 123,
  verifiedInstrumentCount: 1,
  documents: [
    { fileName: "39265019_mineral_royalty_deed.pdf", pages: 3, ocrStatus: "done", extractionStatus: "done", sourceUrl: null },
    { fileName: "40113887_assignment.pdf", pages: 5, ocrStatus: "done", extractionStatus: "pending", sourceUrl: null },
  ],
  tracts: [{ label: "SEC 12 BLK A-21 PSL SURVEY, A-482, GAINES", confidence: 0.82, matchStatus: "needs_confirmation", associationType: null }],
  openReviewItems: [{ title: "County records must be supplied manually", detail: "Gaines County uses LGS Online Solutions; no automated connector exists." }],
  countyCoverage: [{ provider: "publicsearch", county: "GAINES", queryType: "legal_description", queryValue: "SEC 12 BLK A-21 PSL", status: "ok", resultCount: 123 }],
  analysis: { classification: "POTENTIAL_GAPS_DETECTED", version: 2, findings: 4 },
  ownership: null,
  ownershipReason: "Ownership is not established: no reviewed mineral position has been selected against the current title analysis.",
};

const none: TitleReportInput = {
  status: "no_job", headline: "No title research has been run for this well.", jobId: null, stageDetail: null,
  subjectLeads: [], subjectMatchedCount: 0, totalIndexRows: 0, verifiedInstrumentCount: 0, documents: [], tracts: [],
  openReviewItems: [], countyCoverage: [], analysis: null, ownership: null,
  ownershipReason: "Ownership is not established: no title research scope is linked to this run.",
};

describe("title pages", () => {
  it("renders both states", async () => {
    for (const title of [analyzed, none]) {
      const doc = React.createElement(Document, {},
        React.createElement(TitleChainPage, { run, id, title, generatedAt: "2026-09-22T00:00:00Z" }),
        React.createElement(TitleEvidenceDetailPage, { run, id, title, generatedAt: "2026-09-22T00:00:00Z" }),
      );
      const buf = await renderToBuffer(doc as never);
      expect(buf.length).toBeGreaterThan(1000);
    }
  }, 60000);
});
