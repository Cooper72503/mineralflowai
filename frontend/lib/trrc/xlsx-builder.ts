/**
 * Minimal OOXML (.xlsx) writer — no external dependency (no exceljs, no
 * xlsx/SheetJS). An .xlsx file IS a ZIP container of XML parts, so this
 * reuses the exact same from-scratch ZIP writer archive-builder.ts already
 * has (buildZipBuffer) rather than adding a whole new library for what's
 * structurally the same problem already solved once tonight.
 *
 * Deliberately minimal: inline strings (no sharedStrings.xml table to
 * index), one shared header style, no formulas, no merged cells. Enough
 * for a clean, readable multi-sheet workbook — not a general-purpose
 * spreadsheet engine.
 */

import type { ArchiveEntry } from "./archive-builder";
import { buildZipBuffer } from "./archive-builder";

export type XlsxSheet = {
  /** Max 31 chars; Excel disallows \ / ? * [ ] : in sheet names. */
  name: string;
  columns: { header: string; width?: number }[];
  rows: (string | number | null)[][];
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet";
}

/** 0-indexed column number -> spreadsheet column letters (0 -> A, 26 -> AA). */
function colLetters(n: number): string {
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

function cellXml(rowIdx: number, colIdx: number, value: string | number | null, styleIdx: number): string {
  const ref = `${colLetters(colIdx)}${rowIdx}`;
  const s = styleIdx ? ` s="${styleIdx}"` : "";
  if (value === null || value === undefined || value === "") return `<c r="${ref}"${s}/>`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function buildSheetXml(sheet: XlsxSheet): string {
  const headerRow = `<row r="1">${sheet.columns.map((c, i) => cellXml(1, i, c.header, 1)).join("")}</row>`;
  const dataRows = sheet.rows.map((row, ri) =>
    `<row r="${ri + 2}">${row.map((v, ci) => cellXml(ri + 2, ci, v, 0)).join("")}</row>`,
  ).join("");

  const cols = sheet.columns.some(c => c.width)
    ? `<cols>${sheet.columns.map((c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`,
      ).join("")}</cols>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${cols}<sheetData>${headerRow}${dataRows}</sheetData>
</worksheet>`;
}

const CONTENT_TYPES_XML = (sheetCount: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_XML = (sheets: XlsxSheet[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(sanitizeSheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`;

const WORKBOOK_RELS_XML = (sheetCount: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Style index 0 = default; style index 1 = bold header with a light navy
// fill, matching the report's own color scheme.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="10"/><name val="Calibri"/></font>
<font><sz val="10"/><name val="Calibri"/><b/><color rgb="FFFFFFFF"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0F2A47"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export async function buildXlsxWorkbook(sheets: XlsxSheet[]): Promise<Buffer> {
  const now = new Date();
  const entries: ArchiveEntry[] = [
    { path: "[Content_Types].xml", content: CONTENT_TYPES_XML(sheets.length) },
    { path: "_rels/.rels", content: ROOT_RELS_XML },
    { path: "xl/workbook.xml", content: WORKBOOK_XML(sheets) },
    { path: "xl/_rels/workbook.xml.rels", content: WORKBOOK_RELS_XML(sheets.length) },
    { path: "xl/styles.xml", content: STYLES_XML },
    ...sheets.map((sheet, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      content: buildSheetXml(sheet),
    })),
  ];

  return buildZipBuffer(entries, now);
}
