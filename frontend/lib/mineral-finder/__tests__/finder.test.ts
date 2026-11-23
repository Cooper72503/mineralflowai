import { describe, expect, it, vi } from "vitest";
import {
  csvRows,
  countyBulkRows,
  bulkAssociation,
  mergeWells,
  catalogItem,
  ymd,
} from "../ingestion";
import { parseFinderRequest } from "../criteria";
import { arcgisRows } from "../http";
import {
  distanceMiles,
  matchingOffsets,
  recommendPurchase,
  screen,
} from "../screen";
import type {
  Association,
  CatalogItem,
  FinderSnapshot,
  Production,
  Well,
} from "../types";

async function* chunks(...values: string[]) {
  yield* values;
}
const association: Association = {
  district: "8A",
  lease: "01234",
  leaseType: "O",
  fieldNumber: "12345",
  fieldName: "TEST (SAN ANDRES)",
  operator: "Example operator",
  status: "plugged",
  completionDate: "1970-01-01",
  plugDate: "2000-01-01",
  onSchedule: false,
  sourceRow: "1",
  raw: [],
};
const well = (api: string, overrides: Partial<Well> = {}): Well => ({
  api,
  county: "GAINES",
  lat: 32.75,
  lng: -102.6,
  status: "plugged",
  wellNumber: "1",
  locationDescription: "Published coordinates",
  associations: [association],
  association,
  identityConflict: false,
  sources: ["rrc-wellbore", "rrc-gis"],
  ...overrides,
});
const catalog: CatalogItem = catalogItem({
  ItemId: 10,
  ApiNumber: "421650000100",
  CountyName: "GAINES",
  Collection: "GLF",
  MaterialType: "Log",
  LogTypes: "INDUCTION",
  TopDepth: 1000,
  BottomDepth: 5000,
  CoordsUncertain: 1,
});
const criteria = parseFinderRequest(
  "Find plugged wells in Gaines County before 1995",
);
const snapshot = (wells: Well[], cat: CatalogItem[] = []): FinderSnapshot => ({
  wells,
  catalog: cat,
  sources: [],
});

describe("county ingestion integrity", () => {
  it("preserves quotes, newlines, empty fields, zero and chunk boundaries", async () => {
    const rows = [];
    for await (const r of csvRows(
      chunks('"A"', '"B","line\nnext",0,\r', '\n"C","D",1,\n'),
    ))
      rows.push(r);
    expect(rows).toEqual([
      ['A"B', "line\nnext", "0", ""],
      ["C", "D", "1", ""],
    ]);
  });
  it("rejects truncated quoted fields rather than seal partial data", async () => {
    await expect(
      (async () => {
        for await (const _ of csvRows(chunks('"A","B'))) {
        }
      })(),
    ).rejects.toThrow("Truncated");
  });
  it("filters malformed foreign-county text but rejects malformed selected county rows", async () => {
    const bad = '"01","127","12732968","DIMMIT","2023H"","","INEOS"\n';
    expect((await countyBulkRows(chunks(bad), "GAINES")).records).toEqual([]);
    await expect(
      countyBulkRows(chunks(bad.replace('"127"', '"165"')), "GAINES"),
    ).rejects.toThrow();
  });
  it("validates dates and refuses zero-filled or calendar-invalid dates", () => {
    expect(ymd("19700229")).toBeNull();
    expect(ymd("00000000")).toBeNull();
    expect(ymd("19720229")).toBe("1972-02-29");
  });
  it("rejects a county/API mismatch and changed column count", () => {
    const row = Array(59).fill("");
    row[1] = "165";
    row[2] = "15100001";
    expect(() => bulkAssociation(row, 1)).toThrow("identity");
    expect(() => bulkAssociation(row.slice(1), 1)).toThrow();
  });
  it("uses an explicit plugging date when the official status text is blank", () => {
    const row = Array(59).fill("");
    row[1] = "165";
    row[2] = "16500001";
    row[20] = "19950101";
    expect(bulkAssociation(row, 1).association.status).toBe("plugged");
  });
  it("withholds multiple active lease associations and conflicting coordinates", () => {
    const w = mergeWells(
      "GAINES",
      [
        {
          api: "4216500001",
          association: { ...association, onSchedule: true },
        },
        {
          api: "4216500001",
          association: { ...association, onSchedule: true, lease: "56789" },
        },
      ],
      [],
    );
    expect(w[0].identityConflict).toBe(true);
    expect(w[0].association).toBeNull();
  });
  it("rejects replayed/cache records from another county", () => {
    expect(() =>
      mergeWells("FISHER", [{ api: "4216500001", association }], []),
    ).toThrow("county identity mismatch");
  });
  it("does not turn an Oil Well map symbol into production evidence or null into zero latitude", () => {
    const w = mergeWells(
      "GAINES",
      [],
      [
        {
          API: "16500001",
          GIS_LAT83: null,
          GIS_LONG83: null,
          GIS_SYMBOL_DESCRIPTION: "Oil Well",
        },
      ],
    )[0];
    expect(w.status).toBe("unknown");
    expect(w.lat).toBeNull();
  });
});

describe("bounded source pagination", () => {
  it("follows keyset pages and verifies the advertised count", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ count: 2 }))
      .mockResolvedValueOnce(
        Response.json({
          features: [{ attributes: { ItemId: 1 } }],
          exceededTransferLimit: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          features: [{ attributes: { ItemId: 2 } }],
          exceededTransferLimit: false,
        }),
      );
    expect(
      await arcgisRows(
        "https://example.org/1",
        "County='GAINES'",
        "ItemId",
        "*",
        undefined,
        fetcher,
      ),
    ).toHaveLength(2);
    expect(decodeURIComponent(fetcher.mock.calls[2][0])).toContain("ItemId>1");
  });
  it("detects repeated pages rather than looping or duplicating evidence", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => Response.json({ count: 2 }))
      .mockImplementation(async () =>
        Response.json({ features: [{ attributes: { ItemId: 1 } }] }),
      );
    await expect(
      arcgisRows(
        "https://example.org/1",
        "1=1",
        "ItemId",
        "*",
        undefined,
        fetcher,
      ),
    ).rejects.toThrow(/duplicate|unordered/);
  });
});

describe("scientifically bounded screening", () => {
  it("parses county, cutoff, radius and count without a model", () => {
    expect(
      parseFinderRequest(
        "Top 10 plugged wells in Fisher County before 1980 within 2 miles",
      ),
    ).toMatchObject({
      county: "FISHER",
      beforeYear: 1980,
      radiusMiles: 2,
      limit: 10,
    });
    expect(() => parseFinderRequest("Gaines and Fisher")).toThrow();
    expect(() => parseFinderRequest("Midland County")).toThrow();
  });
  it("does not infer age, location or acquisition rights", () => {
    const s = screen(
      snapshot([
        well("4216500001", {
          associations: [{ ...association, completionDate: null }],
        }),
      ]),
      criteria,
      "test",
    );
    expect(s.prospects).toHaveLength(0);
    expect(s.excluded.age_not_established_before_cutoff).toBe(1);
  });
  it("counts completion-before-cutoff only as an upper bound on drilling date", () => {
    const p = screen(snapshot([well("4216500001")]), criteria, "test")
      .prospects[0];
    expect(p.ageEvidence.basis).toBe("completion_upper_bound");
    expect(p.economics.status).toBe("insufficient_data");
    expect(p.risks.join(" ")).toContain("does not establish");
  });
  it("rejects a nearby wrong formation, wrong field, unknown field and faraway well", () => {
    const w = well("4216500001");
    const other = well("4216500002", {
      status: "producing",
      lat: 32.751,
      association: { ...association, status: "producing" },
    });
    const offsets = matchingOffsets(
      w,
      [
        w,
        other,
        {
          ...other,
          api: "4216500003",
          association: { ...other.association!, fieldNumber: "9999" },
        },
        {
          ...other,
          api: "4216500004",
          association: {
            ...other.association!,
            fieldName: "TEST (WOLFCAMP A)",
          },
        },
        { ...other, api: "4216500005", lat: 33.5 },
      ],
      criteria,
      new Map(),
    );
    expect(offsets.map((o) => o.api)).toEqual(["4216500002"]);
    expect(offsets[0].match).toBe("field_reservoir_proxy");
    expect(offsets[0].historicallyProductive).toBeNull();
    expect(distanceMiles(w, other)).toBeLessThan(1);
  });
  it("does not infer production success or interpret catalog formation as producing interval", () => {
    const p = screen(
      snapshot([well("4216500001")], [{ ...catalog, formation: "SAN ANDRES" }]),
      criteria,
      "test",
    ).prospects[0];
    expect(p.formationBasis).toContain("not a verified");
    expect(p.production).toBeNull();
    expect(p.decline).toBeNull();
    expect(p.scoreExplanation.reduce((s, x) => s + x.points, 0)).toBe(p.score);
  });
  it("requires useful depth coverage and prices only a verified per-log estimate", () => {
    const p = recommendPurchase(
      [catalog, { ...catalog, id: "11", logTypes: "DEPTH CONTROL" }],
      { usd: null, checkedAt: null },
    );
    expect(p).toHaveLength(1);
    expect(p[0].estimatedUsd).toBeNull();
    expect(p[0].approval).toBe("required");
    expect(
      recommendPurchase([{ ...catalog, bottomFt: null }], {
        usd: 10,
        checkedAt: "2026-11-23",
      }),
    ).toHaveLength(0);
  });
  it("keeps shared-lease production from classifying an individual marginal well", () => {
    const a = well("4216500001", { status: "producing" });
    const b = well("4216500002", { status: "producing" });
    const p: Production = {
      key: "8A|O|01234",
      sourceId: "production:8A|O|01234",
      retrievedAt: "2026-11-23",
      status: "success",
      rows: [{ month: "2026-10", oil: 10, gas: null, water: null }],
      reason: null,
    };
    const s = screen(
      snapshot([a, b]),
      { ...criteria, marginalBopd: 5 },
      "test",
      new Map([[p.key, p]]),
    );
    expect(s.prospects).toHaveLength(0);
    expect(s.excluded.marginal_well_rate_not_established).toBe(2);
  });
});
