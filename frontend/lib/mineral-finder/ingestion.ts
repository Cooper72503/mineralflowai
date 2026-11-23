import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { parseApiInput } from "../trrc/title/api-input";
import { TRRC_GIS } from "../trrc/well-map/gis";
import { arcgisRows, request } from "./http";
import type {
  Association,
  CatalogItem,
  County,
  Source,
  Well,
  WellStatus,
} from "./types";

export const COUNTIES = { GAINES: "165", FISHER: "151" } as const;
export const BEG =
  "https://coastal.beg.utexas.edu/arcgis/rest/services/continuum/continuumsearch/MapServer/1";
export const WELLBORE_BULK =
  "https://mft.rrc.texas.gov/link/650649b7-e019-4d77-a8e0-d118d6455381";
export const WELLBORE_MANUAL =
  "https://www.rrc.texas.gov/media/di1mm5or/og_wellbore_ewadefinitionmanual2013-10-30_subscription.pdf";
export const BEG_PRICES =
  "https://www.beg.utexas.edu/about/facilities/geophysical-log-facility";
export const str = (x: unknown): string | null =>
  typeof x === "string" && x.trim() ? x.trim() : null;
export const num = (x: unknown): number | null =>
  x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x))
    ? Number(x)
    : null;
export function api10(value: unknown): string | null {
  const parsed = parseApiInput(String(value ?? ""));
  return parsed.ok ? parsed.api10 : null;
}
export function ymd(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(iso);
  return !Number.isNaN(+d) &&
    d.toISOString().slice(0, 10) === iso &&
    +s.slice(0, 4) >= 1850
    ? iso
    : null;
}
export function wellStatus(raw: unknown): WellStatus {
  const s = String(raw ?? "").toUpperCase();
  if (/PLUG/.test(s)) return "plugged";
  if (/DRY/.test(s)) return "dry";
  if (/SHUT|INACTIVE|ABANDON/.test(s)) return "shut_in";
  if (/PRODUCING/.test(s)) return "producing";
  return "unknown"; // A map symbol "Oil Well" does not establish current production.
}

/** Streaming RFC4180 parser, including quoted newlines and quotes across chunks. */
export async function* csvRows(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string[]> {
  let row: string[] = [],
    field = "",
    quoted = false,
    quotePending = false,
    afterCR = false;
  for await (const chunk of chunks) {
    for (const c of chunk) {
      if (afterCR) {
        afterCR = false;
        if (c === "\n") continue;
      }
      if (quotePending) {
        quotePending = false;
        if (c === '"') {
          field += '"';
          continue;
        }
        quoted = false;
        if (c !== "," && c !== "\n" && c !== "\r")
          throw Error(
            `Unexpected character after CSV quote: ${JSON.stringify(c)} following ${JSON.stringify(field.slice(-60))}.`,
          );
      }
      if (quoted) {
        if (c === '"') quotePending = true;
        else field += c;
      } else if (c === '"' && field.length === 0) quoted = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        row.push(field);
        field = "";
        yield row;
        row = [];
        afterCR = c === "\r";
      } else field += c;
      if (field.length > 100_000 || row.length > 200)
        throw Error("Invalid or oversized CSV record.");
    }
  }
  if (quoted && !quotePending) throw Error("Truncated quoted CSV record.");
  if (field || row.length) {
    row.push(field);
    yield row;
  }
}

/** RRC manual fields 1–59. Extra published trailing fields are retained, never guessed. */
export function bulkAssociation(
  row: string[],
  rowNumber: number,
): { api: string; association: Association } {
  const api = api10(row[2]);
  if (row.length !== 59 || !api || row[1].trim() !== api.slice(2, 5))
    throw Error(
      `Wellbore CSV schema/identity mismatch at record ${rowNumber}.`,
    );
  return {
    api,
    association: {
      district: str(row[0]),
      lease: str(row[8]),
      leaseType: str(row[4]),
      fieldNumber: str(row[6]),
      fieldName: str(row[7]),
      operator: str(row[11]),
      status:
        wellStatus(row[18]) === "unknown" && ymd(row[20])
          ? "plugged"
          : wellStatus(row[18]),
      completionDate: ymd(row[30]),
      plugDate: ymd(row[20]),
      onSchedule: row[26].trim() === "Y",
      sourceRow: String(rowNumber),
      raw: row,
    },
  };
}

export async function ingestWellbore(
  county: County,
  signal?: AbortSignal,
): Promise<{
  records: { api: string; association: Association }[];
  source: Source;
}> {
  const page = await request(WELLBORE_BULK, { signal });
  const html = await page.text();
  const $ = cheerio.load(html);
  const links = $("#fileList a")
    .toArray()
    .map((a) => ({
      name: $(a).text().trim(),
      action: $(a).attr("onclick") ?? "",
    }))
    .filter((a) =>
      /^OG_WELLBORE_EWA_Report_\d{4}-\d{2}-\d{2}\.csv$/.test(a.name),
    )
    .sort((a, b) => b.name.localeCompare(a.name));
  const link = links[0];
  if (!link)
    throw Error("Official bulk download listing has no dated wellbore CSV.");
  const key = link.action.match(/'((?:fileTable:)[^']+)':'[^']+'/)?.[1];
  if (!key)
    throw Error(
      "Official bulk download action changed; no download attempted.",
    );
  const form = new URLSearchParams();
  $("#fileList input[type=hidden]").each((_, e) => {
    const name = $(e).attr("name");
    if (name) form.set(name, $(e).attr("value") ?? "");
  });
  form.set(key, key);
  const cookies = page.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0])
    .join("; ");
  const response = await request(
    "https://mft.rrc.texas.gov/webclient/godrive/PublicGoDrive.xhtml",
    {
      method: "POST",
      body: form,
      signal,
      headers: {
        Cookie: cookies,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
    fetch,
    15 * 60_000,
  );
  if (
    !response.body ||
    !response.headers.get("content-disposition")?.includes(link.name)
  )
    throw Error("Bulk download returned a page instead of the expected CSV.");
  const hash = createHash("sha256");
  let bytes = 0;
  async function* chunks() {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1_000_000_000)
          throw Error("Bulk download exceeded 1 GB; review source size.");
        hash.update(value);
        yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const { records, physicalLines: rowNumber } = await countyBulkRows(
    chunks(),
    county,
  );
  if (!rowNumber || !records.length)
    throw Error(
      "Bulk download had no county records; snapshot was not accepted.",
    );
  return {
    records,
    source: {
      id: "rrc-wellbore",
      provider: "RRC official monthly wellbore CSV",
      url: WELLBORE_BULK,
      retrievedAt: new Date().toISOString(),
      status: "success",
      count: records.length,
      complete: true,
      sha256: hash.digest("hex"),
      warnings: [
        `${link.name}; ${rowNumber} statewide physical record lines scanned; API10 is a wellbore core, not a completion identifier.`,
        "County prefix is filtered before strict CSV parsing; malformed foreign-county text is not interpreted. Selected-county malformed rows fail the entire snapshot.",
        "Monthly snapshot; not a real-time status certification. Dates are completion dates, not spud dates.",
      ],
    },
  };
}

/**
 * Official export is one record per physical line. Filter only its fixed first
 * two quoted identifiers before parsing selected rows. Live 2026-11 export has
 * malformed quotes in a Dimmit well number: that must not corrupt a Gaines
 * row, nor be repaired into invented fields. Selected-county malformed records
 * remain fatal. Embedded newlines in a selected record are also rejected.
 */
export async function countyBulkRows(
  chunks: AsyncIterable<string>,
  county: County,
) {
  const records: { api: string; association: Association }[] = [];
  let buffer = "",
    physicalLines = 0;
  const prefix = new RegExp(`^"[^"\\r\\n]+","${COUNTIES[county]}",`);
  const line = async (text: string) => {
    physicalLines++;
    if (!prefix.test(text)) return;
    async function* one() {
      yield text.replace(/\r$/, "");
    }
    const parsed = [];
    for await (const row of csvRows(one())) parsed.push(row);
    if (parsed.length !== 1)
      throw Error(`Malformed county record at physical line ${physicalLines}.`);
    records.push(bulkAssociation(parsed[0], physicalLines));
  };
  for await (const chunk of chunks) {
    buffer += chunk;
    let start = 0,
      end: number;
    while ((end = buffer.indexOf("\n", start)) >= 0) {
      await line(buffer.slice(start, end));
      start = end + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > 100_000) throw Error("Oversized bulk record.");
  }
  if (buffer) await line(buffer);
  return { records, physicalLines };
}

export async function ingestGis(county: County, signal?: AbortSignal) {
  const rows: Record<string, unknown>[] = [];
  for (const layer of [1, 9])
    rows.push(
      ...(await arcgisRows(
        `${TRRC_GIS}/${layer}`,
        `API LIKE '${COUNTIES[county]}%'`,
        "OBJECTID",
        "*",
        signal,
      )),
    );
  return {
    rows,
    source: {
      id: "rrc-gis",
      provider: "RRC public GIS",
      url: TRRC_GIS,
      retrievedAt: new Date().toISOString(),
      status: "success" as const,
      count: rows.length,
      complete: true,
      warnings: [
        "County API prefix selects county of record. Nearby offsets across the county boundary are not included in this pilot.",
        "Coordinates use the published NAD83 attributes; map symbols are not production or ownership evidence.",
      ],
    },
  };
}

export function catalogItem(a: Record<string, unknown>): CatalogItem {
  const id = String(a.ItemId);
  const date = num(a.DrillDate);
  return {
    id,
    api: api10(a.ApiNumber),
    apiOriginal: str(a.ApiNumber),
    county: String(a.CountyName ?? ""),
    collection: String(a.Collection ?? ""),
    logTypes: str(a.LogTypes),
    material: str(a.MaterialType),
    formation: str(a.Formation),
    fieldName: str(a.FieldName),
    leaseName: str(a.LeaseName),
    topFt: num(a.TopDepthAvailable) ?? num(a.TopDepth),
    bottomFt: num(a.BottomDepthAvailable) ?? num(a.BottomDepth),
    lat: num(a.SurfaceLatitude),
    lng: num(a.SurfaceLongitude),
    coordinatesUncertain: a.CoordsUncertain !== 0,
    drillDate:
      date !== null && Number.isFinite(+new Date(date))
        ? new Date(date).toISOString().slice(0, 10)
        : null,
    accession: str(a.AccessionNumber),
    sourceId: "beg-catalog",
    url: `${BEG}/query?${new URLSearchParams({ f: "json", where: `ItemId=${Number(id)}`, outFields: "*", returnGeometry: "false" })}`,
    raw: a,
  };
}
export async function ingestBeg(county: County, signal?: AbortSignal) {
  const records = await arcgisRows(
    BEG,
    `UPPER(CountyName)='${county}' AND UPPER(StateName)='TEXAS'`,
    "ItemId",
    "*",
    signal,
  );
  return {
    records: records.map(catalogItem),
    source: {
      id: "beg-catalog",
      provider: "UT BEG CONTINUUM metadata",
      url: BEG,
      retrievedAt: new Date().toISOString(),
      status: "success" as const,
      count: records.length,
      complete: false,
      warnings: [
        "Catalog metadata only. Catalog is incomplete; absence is not proof no logs exist. No underlying scans downloaded.",
        "Public query capability is verified; commercial bulk retention/reuse rights require confirmation with BEG.",
        "Formation and depth attributes describe catalog materials, not necessarily a producing completion.",
      ],
    },
  };
}

export function mergeWells(
  county: County,
  bulk: { api: string; association: Association }[],
  gis: Record<string, unknown>[],
): Well[] {
  const byApi = new Map<string, Well>();
  const ensure = (api: string) => {
    let w = byApi.get(api);
    if (!w) {
      w = {
        api,
        county,
        lat: null,
        lng: null,
        locationDescription: null,
        status: "unknown",
        wellNumber: null,
        associations: [],
        association: null,
        identityConflict: false,
        sources: [],
      };
      byApi.set(api, w);
    }
    return w;
  };
  for (const r of bulk) {
    const w = ensure(r.api);
    w.associations.push(r.association);
    w.sources = ["rrc-wellbore"];
    if (!r.api.startsWith(`42${COUNTIES[county]}`))
      throw Error("Bulk/cache county identity mismatch; snapshot rejected.");
    if (
      r.association.onSchedule &&
      r.association.plugDate &&
      ["producing", "shut_in"].includes(r.association.status)
    )
      w.identityConflict = true;
  }
  for (const r of gis) {
    const api = api10(r.API);
    if (!api || !api.startsWith(`42${COUNTIES[county]}`)) continue;
    const w = ensure(api);
    const lat = num(r.GIS_LAT83),
      lng = num(r.GIS_LONG83);
    if (
      lat !== null &&
      lng !== null &&
      lat >= 25 &&
      lat <= 37 &&
      lng >= -107 &&
      lng <= -93
    ) {
      if (
        w.lat !== null &&
        (Math.abs(w.lat - lat) > 0.002 || Math.abs(w.lng! - lng) > 0.002)
      ) {
        w.identityConflict = true;
      } else {
        w.lat = lat;
        w.lng = lng;
      }
    }
    w.wellNumber = w.wellNumber ?? str(r.GIS_WELL_NUMBER);
    w.locationDescription = str(r.GIS_LOCATION_SOURCE) ?? w.locationDescription;
    if (!w.sources.includes("rrc-gis")) w.sources.push("rrc-gis");
  }
  for (const w of byApi.values()) {
    const active = w.associations.filter((a) => a.onSchedule);
    const choices = active.length ? active : w.associations;
    const unique = new Set(
      choices.map((a) =>
        [a.district, a.leaseType, a.lease, a.fieldNumber, a.status].join("|"),
      ),
    );
    if (unique.size === 1) w.association = choices[0];
    else if (unique.size > 1) w.identityConflict = true;
    w.status = w.association?.status ?? "unknown";
  }
  return [...byApi.values()].sort((a, b) => a.api.localeCompare(b.api));
}
