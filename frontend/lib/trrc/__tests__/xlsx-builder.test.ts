/**
 * Tests for buildXlsxWorkbook — the hand-rolled OOXML writer.
 *
 * These decompress the actual returned buffer and inspect the raw XML
 * parts (same technique as archive-builder.test.ts), rather than just
 * checking it doesn't throw. The file has also been round-tripped through
 * openpyxl (a real, independent OOXML parser, not this codebase's own
 * code) during manual verification against real production data — these
 * tests lock in that same structural contract so it can't silently regress.
 */

import { describe, it, expect } from "vitest";
import * as zlib from "zlib";
import { buildXlsxWorkbook } from "../xlsx-builder";

function readZipEntries(zip: Buffer): Record<string, Buffer> {
  const entries: Record<string, Buffer> = {};
  let offset = 0;
  while (offset < zip.length) {
    const sig = zip.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
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

describe("buildXlsxWorkbook", () => {
  it("emits all required OOXML parts for a valid workbook", async () => {
    const buf = await buildXlsxWorkbook([
      { name: "Sheet1", columns: [{ header: "A" }], rows: [["x"]] },
    ]);
    const files = readZipEntries(buf);
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml",
    ]));
  });

  it("writes numbers as real numeric cells and text as inline strings", async () => {
    const buf = await buildXlsxWorkbook([
      { name: "Data", columns: [{ header: "Label" }, { header: "Value" }], rows: [["Oil", 1200], ["Empty", null]] },
    ]);
    const files = readZipEntries(buf);
    const xml = files["xl/worksheets/sheet1.xml"].toString("utf8");

    expect(xml).toMatch(/<c r="B2"><v>1200<\/v><\/c>/);
    expect(xml).toMatch(/<c r="A2"[^>]* t="inlineStr"><is><t[^>]*>Oil<\/t><\/is><\/c>/);
    expect(xml).toMatch(/<c r="B3"\/>/); // null renders as an empty cell, not "null" or 0
  });

  it("escapes XML special characters and preserves unicode", async () => {
    const buf = await buildXlsxWorkbook([
      { name: "Sheet1", columns: [{ header: "Note" }], rows: [['Tests: & < > " \' café']] },
    ]);
    const xml = readZipEntries(buf)["xl/worksheets/sheet1.xml"].toString("utf8");
    expect(xml).toContain("Tests: &amp; &lt; &gt; &quot; &apos; café");
  });

  it("sanitizes sheet names TRRC/Excel would otherwise reject", async () => {
    const buf = await buildXlsxWorkbook([
      { name: "Weird:Name/Test?", columns: [{ header: "X" }], rows: [] },
    ]);
    const workbookXml = readZipEntries(buf)["xl/workbook.xml"].toString("utf8");
    const nameAttr = workbookXml.match(/<sheet name="([^"]*)"/)?.[1] ?? "";
    expect(nameAttr).toBe("Weird_Name_Test_");
    expect(nameAttr).not.toMatch(/[:/?]/); // colon/slash/question-mark stripped from the sheet name itself
  });

  it("produces one worksheet + rels entry per sheet, correctly wired", async () => {
    const buf = await buildXlsxWorkbook([
      { name: "One", columns: [{ header: "A" }], rows: [] },
      { name: "Two", columns: [{ header: "B" }], rows: [] },
    ]);
    const files = readZipEntries(buf);
    expect(files["xl/worksheets/sheet1.xml"]).toBeDefined();
    expect(files["xl/worksheets/sheet2.xml"]).toBeDefined();
    const rels = files["xl/_rels/workbook.xml.rels"].toString("utf8");
    expect(rels).toContain('Target="worksheets/sheet1.xml"');
    expect(rels).toContain('Target="worksheets/sheet2.xml"');
    expect(rels).toContain('Target="styles.xml"');
  });
});
