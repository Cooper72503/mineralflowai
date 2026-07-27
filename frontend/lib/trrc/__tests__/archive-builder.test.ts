/**
 * Tests for buildTrrcZipArchive's category-folder population.
 *
 * Before this fix, every folder except Production/Compliance-findings/Misc
 * always shipped the same generic "No records were downloaded automatically"
 * README, regardless of whether trrc_source_attempts actually had real,
 * successful data for that category — e.g. a run with a fully populated
 * drilling-permit record still showed Drilling_Permits as empty.
 *
 * These tests actually decompress the returned ZIP buffer (rather than just
 * checking it doesn't throw) to prove real retrieved data ends up in the
 * right folder, a confirmed-empty source gets an accurate "no records found"
 * note instead of the generic placeholder, and a category with no automated
 * source at all still gets the honest "nothing attempted" placeholder.
 */

import { describe, it, expect } from "vitest";
import * as zlib from "zlib";
import { buildTrrcZipArchive } from "../archive-builder";
import type { LiteSourceAttempt } from "../coverage";
import type { TrrcDueDiligenceRun } from "../types";
import type { TrrcManifest } from "../manifest-builder";

// Minimal ZIP reader matching exactly what buildZipFileRecord writes: no data
// descriptors, general-purpose flag always 0, so every entry's compressed
// size/method live in the 30-byte local file header itself.
function readZipEntries(zip: Buffer): Record<string, Buffer> {
  const entries: Record<string, Buffer> = {};
  let offset = 0;
  while (offset < zip.length) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // stop at first central-directory entry
    const compressionMethod = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zip.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    entries[name] = compressionMethod === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    offset = dataStart + compressedSize;
  }
  return entries;
}

const baseRun = {
  id: "run-1",
  normalized_input: "4232946771",
} as unknown as TrrcDueDiligenceRun;

const baseManifest = {
  missing_items: [],
  manual_retrieval_required: [],
} as unknown as TrrcManifest;

function attempt(overrides: Partial<LiteSourceAttempt>): LiteSourceAttempt {
  return {
    source_id: "x_0",
    source_name: "x",
    status: "success",
    result_count: 0,
    error_message: null,
    attempted_at: "2026-07-27T19:33:41.000Z",
    result_data_json: null,
    ...overrides,
  };
}

describe("buildTrrcZipArchive — category folder population", () => {
  it("writes real retrieved JSON into the matching folder for a populated source", async () => {
    const permits = {
      found: true,
      permits: [{ api_no: "32946771", status: "APPROVED", amend: "N" }],
    };
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_drilling_permits", result_count: 2, result_data_json: permits }),
    ];

    const zip = await buildTrrcZipArchive(baseRun, baseManifest, Buffer.from("fake pdf"), [], [], [], attempts);
    const files = readZipEntries(zip);

    const jsonPath = Object.keys(files).find(p => p.endsWith("02_Drilling_Permits/fetch_drilling_permits.json"));
    expect(jsonPath, `expected a fetch_drilling_permits.json entry, got: ${Object.keys(files).join(", ")}`).toBeDefined();
    expect(JSON.parse(files[jsonPath!].toString("utf8"))).toEqual(permits);

    const readmePath = Object.keys(files).find(p => p.endsWith("02_Drilling_Permits/README.txt"));
    const readme = files[readmePath!].toString("utf8");
    expect(readme).toMatch(/retrieved on/i);
    expect(readme).not.toMatch(/No automated source/i);
  });

  it("reports a confirmed-empty source accurately instead of the generic placeholder", async () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_injection_records", status: "success", result_count: 0, result_data_json: { found: false } }),
    ];

    const zip = await buildTrrcZipArchive(baseRun, baseManifest, Buffer.from("fake pdf"), [], [], [], attempts);
    const files = readZipEntries(zip);
    const readmePath = Object.keys(files).find(p => p.endsWith("06_Injection_and_MIT/README.txt"));
    const readme = files[readmePath!].toString("utf8");

    expect(readme).toMatch(/no records/i);
    expect(readme).toMatch(/confirmed absence/i);
    expect(readme).not.toMatch(/No automated source/i);
  });

  it("reports a real retrieval failure distinctly, not as a confirmed absence", async () => {
    const attempts: LiteSourceAttempt[] = [
      attempt({ source_name: "fetch_well_status", status: "failed_transient", error_message: "EWA wellStatusQueryAction.do session GET returned HTTP 500" }),
    ];

    const zip = await buildTrrcZipArchive(baseRun, baseManifest, Buffer.from("fake pdf"), [], [], [], attempts);
    const files = readZipEntries(zip);
    const readmePath = Object.keys(files).find(p => p.endsWith("05_Well_Status_Tests/README.txt"));
    const readme = files[readmePath!].toString("utf8");

    expect(readme).toMatch(/RETRIEVAL FAILED/);
    expect(readme).toMatch(/HTTP 500/);
    expect(readme).not.toMatch(/confirmed absence/i);
  });

  it("keeps the honest 'nothing attempted' placeholder for a category with no automated source", async () => {
    const zip = await buildTrrcZipArchive(baseRun, baseManifest, Buffer.from("fake pdf"), [], [], [], []);
    const files = readZipEntries(zip);
    const readmePath = Object.keys(files).find(p => p.endsWith("09_P4_Gatherer_Purchaser/README.txt"));
    expect(files[readmePath!].toString("utf8")).toMatch(/No automated source in this pipeline/);
  });

  it("includes the actual PDF bytes passed in, not an empty buffer", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4 fake report content for test");
    const zip = await buildTrrcZipArchive(baseRun, baseManifest, pdfBytes, [], [], [], []);
    const files = readZipEntries(zip);
    const pdfPath = Object.keys(files).find(p => p.endsWith(".pdf"));
    expect(pdfPath).toBeDefined();
    expect(files[pdfPath!].equals(pdfBytes)).toBe(true);
  });
});
