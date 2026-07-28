// @ts-nocheck
/**
 * TRRC Public Records Due Diligence — ZIP Archive Builder
 *
 * Produces a valid ZIP file using only Node.js built-in modules (zlib + manual ZIP format construction).
 * No external dependencies (no jszip, no archiver).
 *
 * ZIP specification references:
 *   - Local file header signature: 0x04034b50
 *   - Central directory entry signature: 0x02014b50
 *   - End of central directory signature: 0x06054b50
 *   - Compression method 0 = stored, 8 = deflated
 */

import * as zlib from "zlib";
import { promisify } from "util";
import type { TrrcDueDiligenceRun, TrrcFinding, TrrcDDProductionRow, SourceCoverageStatus } from "./types";
import type { TrrcManifest } from "./manifest-builder";
import type { LiteSourceAttempt } from "./coverage";
import { buildEvidenceIndex } from "./evidence-index";
import { buildTimeline } from "./timeline-builder";

const deflateRaw = promisify(zlib.deflateRaw);

// ─── Public types ─────────────────────────────────────────────────────────────

export type ArchiveEntry = {
  path: string;           // path inside ZIP, e.g. "01_Identity_and_Wellbore/wellbore_master.json"
  content: Buffer | string;
  comment?: string;
};

// ─── CRC-32 implementation ────────────────────────────────────────────────────

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Low-level ZIP field writers ──────────────────────────────────────────────

function writeUint16LE(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt16LE(val >>> 0, offset);
}

function writeUint32LE(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt32LE(val >>> 0, offset);
}

// ─── DOS date/time encoding ───────────────────────────────────────────────────

function toDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

// ─── Single file entry builder ────────────────────────────────────────────────

type ZipFileRecord = {
  localHeaderOffset: number;
  localHeader: Buffer;
  compressedData: Buffer;
  centralDirEntry: Buffer;
};

async function buildZipFileRecord(
  entry: ArchiveEntry,
  offset: number,
  modDate: Date,
): Promise<ZipFileRecord> {
  const contentBuf =
    typeof entry.content === "string"
      ? Buffer.from(entry.content, "utf8")
      : entry.content;

  const pathBuf = Buffer.from(entry.path, "utf8");
  const crc = crc32(contentBuf);
  const uncompressedSize = contentBuf.length;
  const { dosDate, dosTime } = toDosDateTime(modDate);

  // Attempt deflate; use stored if deflated is larger or content is trivially small
  let compressedData: Buffer;
  let compressionMethod: number;

  if (contentBuf.length <= 8) {
    compressedData = contentBuf;
    compressionMethod = 0; // stored
  } else {
    const deflated = await deflateRaw(contentBuf);
    if (deflated.length < contentBuf.length) {
      compressedData = deflated;
      compressionMethod = 8; // deflated
    } else {
      compressedData = contentBuf;
      compressionMethod = 0; // stored — deflated is larger
    }
  }

  const compressedSize = compressedData.length;

  // ── Local file header (30 bytes + filename)
  // Signature (4) + version needed (2) + flags (2) + compression (2) + mod time (2) + mod date (2)
  // + crc32 (4) + compressed size (4) + uncompressed size (4) + filename len (2) + extra len (2)
  // = 30 bytes fixed + variable filename
  const localHeader = Buffer.alloc(30 + pathBuf.length);
  writeUint32LE(localHeader, 0,  0x04034b50); // local file header signature
  writeUint16LE(localHeader, 4,  20);         // version needed to extract (2.0)
  writeUint16LE(localHeader, 6,  0x0000);     // general purpose bit flag (UTF-8 filenames)
  writeUint16LE(localHeader, 8,  compressionMethod);
  writeUint16LE(localHeader, 10, dosTime);
  writeUint16LE(localHeader, 12, dosDate);
  writeUint32LE(localHeader, 14, crc);
  writeUint32LE(localHeader, 18, compressedSize);
  writeUint32LE(localHeader, 22, uncompressedSize);
  writeUint16LE(localHeader, 26, pathBuf.length);
  writeUint16LE(localHeader, 28, 0); // extra field length
  pathBuf.copy(localHeader, 30);

  // ── Central directory entry (46 bytes + filename)
  // Signature (4) + version made (2) + version needed (2) + flags (2) + compression (2)
  // + mod time (2) + mod date (2) + crc32 (4) + compressed size (4) + uncompressed size (4)
  // + filename len (2) + extra len (2) + comment len (2) + disk start (2)
  // + int file attrs (2) + ext file attrs (4) + local header offset (4)
  // = 46 bytes fixed + variable filename
  const commentBuf = entry.comment ? Buffer.from(entry.comment, "utf8") : Buffer.alloc(0);
  const centralDir = Buffer.alloc(46 + pathBuf.length + commentBuf.length);
  writeUint32LE(centralDir, 0,  0x02014b50); // central directory signature
  writeUint16LE(centralDir, 4,  0x0314);     // version made by (Unix, spec 2.0)
  writeUint16LE(centralDir, 6,  20);         // version needed
  writeUint16LE(centralDir, 8,  0x0000);     // flags
  writeUint16LE(centralDir, 10, compressionMethod);
  writeUint16LE(centralDir, 12, dosTime);
  writeUint16LE(centralDir, 14, dosDate);
  writeUint32LE(centralDir, 16, crc);
  writeUint32LE(centralDir, 20, compressedSize);
  writeUint32LE(centralDir, 24, uncompressedSize);
  writeUint16LE(centralDir, 28, pathBuf.length);
  writeUint16LE(centralDir, 30, 0);              // extra field length
  writeUint16LE(centralDir, 32, commentBuf.length);
  writeUint16LE(centralDir, 34, 0);              // disk number start
  writeUint16LE(centralDir, 36, 0);              // internal file attributes
  writeUint32LE(centralDir, 38, 0o100644 << 16); // external file attributes (Unix perms)
  writeUint32LE(centralDir, 42, offset);          // relative offset of local header
  pathBuf.copy(centralDir, 46);
  if (commentBuf.length > 0) {
    commentBuf.copy(centralDir, 46 + pathBuf.length);
  }

  return {
    localHeaderOffset: offset,
    localHeader,
    compressedData,
    centralDirEntry: centralDir,
  };
}

// ─── End of central directory record ─────────────────────────────────────────

function buildEndOfCentralDirectory(
  entryCount: number,
  centralDirSize: number,
  centralDirOffset: number,
): Buffer {
  // End of central directory record: 22 bytes fixed
  // Signature (4) + disk number (2) + disk with start of CD (2) + entries on disk (2)
  // + total entries (2) + CD size (4) + CD offset (4) + comment length (2)
  const eocd = Buffer.alloc(22);
  writeUint32LE(eocd, 0,  0x06054b50); // end of central directory signature
  writeUint16LE(eocd, 4,  0);          // disk number
  writeUint16LE(eocd, 6,  0);          // disk with start of central directory
  writeUint16LE(eocd, 8,  entryCount); // entries on this disk
  writeUint16LE(eocd, 10, entryCount); // total entries
  writeUint32LE(eocd, 12, centralDirSize);
  writeUint32LE(eocd, 16, centralDirOffset);
  writeUint16LE(eocd, 20, 0);          // comment length
  return eocd;
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function csvEscape(val: string | number | null | undefined): string {
  const s = val == null ? "" : String(val);
  // Wrap in quotes if contains comma, double-quote, or newline
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: (string | number | null | undefined)[]): string {
  return fields.map(csvEscape).join(",") + "\r\n";
}

export function buildProductionCsv(production: TrrcDDProductionRow[]): string {
  const header = csvRow([
    "entity_type", "api_number", "district", "lease_number", "gas_id",
    "operator_number", "production_month", "oil_bbl", "casinghead_gas_mcf",
    "gas_mcf", "condensate_bbl", "water_bbl",
  ]);
  const rows = production.map((r) =>
    csvRow([
      r.entity_type, r.api_number, r.district, r.lease_number, r.gas_id,
      r.operator_number, r.production_month, r.oil_bbl, r.casinghead_gas_mcf,
      r.gas_mcf, r.condensate_bbl, r.water_bbl,
    ]),
  );
  return header + rows.join("");
}

export function buildCoverageCsv(coverage: SourceCoverageStatus[]): string {
  const header = csvRow([
    "category", "label", "status", "records_found", "data_current_through",
    "sources_checked", "notes",
  ]);
  const rows = coverage.map((c) =>
    csvRow([
      c.category, c.label, c.status, c.records_found,
      c.data_current_through ?? "", c.sources_checked.join("; "), c.notes ?? "",
    ]),
  );
  return header + rows.join("");
}

function buildMissingRecordsCsv(manifest: TrrcManifest): string {
  const header = csvRow([
    "id", "category", "expected_record_type", "status", "explanation",
    "source_checked", "manual_retrieval_url", "recommended_action",
  ]);
  const rows = manifest.missing_items.map((item) =>
    csvRow([
      item.id, item.category, item.expected_record_type, item.status,
      item.explanation, item.source_checked,
      item.manual_retrieval_url ?? "", item.recommended_action,
    ]),
  );
  return header + rows.join("");
}

export function buildTimelineCsv(sourceAttempts: LiteSourceAttempt[], production: TrrcDDProductionRow[]): string {
  const header = csvRow(["date", "category", "label"]);
  const rows = buildTimeline(sourceAttempts, production).map((e) => csvRow([e.date, e.category, e.label]));
  return header + rows.join("");
}

export function buildEvidenceIndexCsv(run: TrrcDueDiligenceRun, sourceAttempts: LiteSourceAttempt[]): string {
  const header = csvRow([
    "source", "portal", "portal_url", "query_criteria", "status",
    "status_note", "record_count", "retrieved_at_utc",
  ]);
  const rows = buildEvidenceIndex(sourceAttempts, run).map((e) =>
    csvRow([
      e.label, e.portal, e.portal_url, e.query_criteria, e.status,
      e.status_note, e.record_count, e.retrieved_at ?? "",
    ]),
  );
  return header + rows.join("");
}

function buildManualLinksCsv(manifest: TrrcManifest): string {
  const header = csvRow(["source", "category", "url", "description"]);
  const rows = manifest.manual_retrieval_required.map((mr) =>
    csvRow([mr.source, "manual_required", mr.url, mr.description]),
  );
  return header + rows.join("");
}

// ─── README placeholder text ──────────────────────────────────────────────────

const PLACEHOLDER_README =
  "No automated source in this pipeline queries this category — nothing was attempted.\n\n" +
  "See manual retrieval URLs in Source_Manifest.json (manual_retrieval_required array)\n" +
  "and the Missing_Records_Checklist.csv for recommended follow-up actions.\n\n" +
  "IMPORTANT: The absence of a result from a query does not confirm the absence of a record.\n" +
  "TRRC records may be delayed, incorrectly indexed, or available only through manual retrieval.\n";

// ─── Category folder population from real source attempts ───────────────────
//
// Previously every non-production folder shipped the same generic
// "No records were downloaded automatically" README regardless of whether
// the corresponding source actually ran and returned real data — e.g.
// Drilling_Permits and Well_Status_Tests always looked empty even when
// trrc_source_attempts had successful, populated results for them. This
// maps each folder to the source_name(s) that actually feed it and writes
// the real retrieved JSON plus an accurate per-source status README instead.

const FOLDER_SOURCES: Record<string, string[]> = {
  "01_Identity_and_Wellbore":            ["search_by_api", "search_by_lease"],
  "02_Drilling_Permits":                 ["fetch_drilling_permits"],
  "03_Completions_and_Cementing":        ["fetch_completion_records"],
  "05_Well_Status_Tests":                ["fetch_well_status", "fetch_p4_records", "fetch_inactive_well_status"],
  "06_Injection_and_MIT":                ["fetch_injection_records"],
  "07_Plugging_and_Inactive_Well":       ["fetch_plugging_records", "fetch_orphan_well"],
  "08_Operator_and_P5":                  ["search_by_operator"],
  "10_Inspections_Violations_Severance": ["fetch_compliance_violations", "fetch_severance_records"],
  "11_GIS_Maps_and_Plats":               ["fetch_gis_plat"],
  "12_Well_File_Correspondence":         ["fetch_coda_records"],
};

function findAttempt(attempts: LiteSourceAttempt[], sourceName: string): LiteSourceAttempt | null {
  return attempts.find((a) => a.source_name === sourceName) ?? null;
}

function isPopulated(a: LiteSourceAttempt): boolean {
  if (a.status !== "success") return false;
  if (a.result_count > 0) return true;
  const d = a.result_data_json;
  return d != null && d["found"] === true;
}

function buildCategoryEntries(
  folderPath: string,
  sourceNames: string[],
  attempts: LiteSourceAttempt[],
): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const statusLines: string[] = [];
  let anyAttempted = false;

  for (const sourceName of sourceNames) {
    const attempt = findAttempt(attempts, sourceName);
    if (!attempt) {
      statusLines.push(`${sourceName}: not attempted for this run.`);
      continue;
    }
    anyAttempted = true;
    const when = attempt.attempted_at;

    if (attempt.status !== "success") {
      statusLines.push(
        `${sourceName}: RETRIEVAL FAILED on ${when} — ${attempt.error_message ?? "unknown error"}. ` +
        `This does NOT confirm absence of records — see Missing_Records_Checklist.csv.`,
      );
      continue;
    }

    if (!isPopulated(attempt)) {
      statusLines.push(`${sourceName}: queried on ${when} — TRRC returned no records. Confirmed absence, not a retrieval failure.`);
      continue;
    }

    statusLines.push(`${sourceName}: retrieved on ${when} — see ${sourceName}.json in this folder.`);
    entries.push({
      path: `${folderPath}${sourceName}.json`,
      content: JSON.stringify(attempt.result_data_json, null, 2),
    });
  }

  if (!anyAttempted) {
    entries.push({ path: `${folderPath}README.txt`, content: PLACEHOLDER_README });
    return entries;
  }

  entries.push({
    path: `${folderPath}README.txt`,
    content: statusLines.join("\n\n") + "\n",
  });
  return entries;
}

// ─── Generic ZIP assembly (shared with xlsx-builder.ts — XLSX is itself a ─────
// ZIP container of XML parts, so the same from-scratch writer applies) ────────

export async function buildZipBuffer(entries: ArchiveEntry[], modDate: Date = new Date()): Promise<Buffer> {
  const records: ZipFileRecord[] = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const record = await buildZipFileRecord(entry, currentOffset, modDate);
    records.push(record);
    currentOffset += record.localHeader.length + record.compressedData.length;
  }

  const centralDirOffset = currentOffset;
  const centralDirBuffers = records.map((r) => r.centralDirEntry);
  const centralDirSize = centralDirBuffers.reduce((sum, b) => sum + b.length, 0);
  const eocd = buildEndOfCentralDirectory(records.length, centralDirSize, centralDirOffset);

  return Buffer.concat([
    ...records.flatMap((r) => [r.localHeader, r.compressedData]),
    ...centralDirBuffers,
    eocd,
  ]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function buildTrrcZipArchive(
  run: TrrcDueDiligenceRun,
  manifest: TrrcManifest,
  pdf_buffer: Buffer,
  production: TrrcDDProductionRow[],
  findings: TrrcFinding[],
  coverage: SourceCoverageStatus[],
  sourceAttempts: LiteSourceAttempt[] = [],
): Promise<Buffer> {
  const now = new Date();

  // Build a safe identifier: strip non-alphanumeric except underscores/hyphens
  const identifier = run.normalized_input.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rootDir = `MineralFlowAI_TRRC_DD_${identifier}_${dateStr}/`;

  // Compliance findings (category = "compliance")
  const complianceFindings = findings.filter((f) => f.category === "compliance");

  const entries: ArchiveEntry[] = [
    // 00_Report
    {
      path: `${rootDir}00_Report/MineralFlowAI_TRRC_Due_Diligence_Report.pdf`,
      content: pdf_buffer,
    },
    {
      path: `${rootDir}00_Report/Source_Manifest.json`,
      content: JSON.stringify(manifest, null, 2),
    },
    {
      path: `${rootDir}00_Report/Source_Coverage.csv`,
      content: buildCoverageCsv(coverage),
    },
    {
      path: `${rootDir}00_Report/Missing_Records_Checklist.csv`,
      content: buildMissingRecordsCsv(manifest),
    },
    {
      path: `${rootDir}00_Report/Evidence_Index.csv`,
      content: buildEvidenceIndexCsv(run, sourceAttempts),
    },
    {
      path: `${rootDir}00_Report/Timeline.csv`,
      content: buildTimelineCsv(sourceAttempts, production),
    },

    // 01_Identity_and_Wellbore
    ...buildCategoryEntries(`${rootDir}01_Identity_and_Wellbore/`, FOLDER_SOURCES["01_Identity_and_Wellbore"], sourceAttempts),

    // 02_Drilling_Permits
    ...buildCategoryEntries(`${rootDir}02_Drilling_Permits/`, FOLDER_SOURCES["02_Drilling_Permits"], sourceAttempts),

    // 03_Completions_and_Cementing
    ...buildCategoryEntries(`${rootDir}03_Completions_and_Cementing/`, FOLDER_SOURCES["03_Completions_and_Cementing"], sourceAttempts),

    // 04_Production
    {
      path: `${rootDir}04_Production/production_monthly.csv`,
      content: buildProductionCsv(production),
    },
    {
      path: `${rootDir}04_Production/production_monthly.json`,
      content: JSON.stringify(production, null, 2),
    },

    // 05_Well_Status_Tests
    ...buildCategoryEntries(`${rootDir}05_Well_Status_Tests/`, FOLDER_SOURCES["05_Well_Status_Tests"], sourceAttempts),

    // 06_Injection_and_MIT
    ...buildCategoryEntries(`${rootDir}06_Injection_and_MIT/`, FOLDER_SOURCES["06_Injection_and_MIT"], sourceAttempts),

    // 07_Plugging_and_Inactive_Well
    ...buildCategoryEntries(`${rootDir}07_Plugging_and_Inactive_Well/`, FOLDER_SOURCES["07_Plugging_and_Inactive_Well"], sourceAttempts),

    // 08_Operator_and_P5
    ...buildCategoryEntries(`${rootDir}08_Operator_and_P5/`, FOLDER_SOURCES["08_Operator_and_P5"], sourceAttempts),

    // 09_P4_Gatherer_Purchaser
    {
      path: `${rootDir}09_P4_Gatherer_Purchaser/README.txt`,
      content: PLACEHOLDER_README,
    },

    // 10_Inspections_Violations_Severance
    {
      path: `${rootDir}10_Inspections_Violations_Severance/findings_compliance.json`,
      content: JSON.stringify(complianceFindings, null, 2),
    },
    ...buildCategoryEntries(`${rootDir}10_Inspections_Violations_Severance/`, FOLDER_SOURCES["10_Inspections_Violations_Severance"], sourceAttempts),

    // 11_GIS_Maps_and_Plats
    ...buildCategoryEntries(`${rootDir}11_GIS_Maps_and_Plats/`, FOLDER_SOURCES["11_GIS_Maps_and_Plats"], sourceAttempts),

    // 12_Well_File_Correspondence
    ...buildCategoryEntries(`${rootDir}12_Well_File_Correspondence/`, FOLDER_SOURCES["12_Well_File_Correspondence"], sourceAttempts),

    // 13_Logs_and_Surveys
    {
      path: `${rootDir}13_Logs_and_Surveys/README.txt`,
      content: PLACEHOLDER_README,
    },

    // 14_Miscellaneous
    {
      path: `${rootDir}14_Miscellaneous/findings_all.json`,
      content: JSON.stringify(findings, null, 2),
    },

    // 15_Unavailable_Record_Links
    {
      path: `${rootDir}15_Unavailable_Record_Links/manual_retrieval_links.csv`,
      content: buildManualLinksCsv(manifest),
    },
  ];

  return buildZipBuffer(entries, now);
}
