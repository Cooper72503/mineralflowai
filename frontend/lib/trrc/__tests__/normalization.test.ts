/**
 * TRRC Normalization — unit tests.
 *
 * Tests pure, I/O-free normalization utilities:
 *   normalizeApiNumber, detectInputType, normalizeLeaseNumber,
 *   normalizeOperatorName, isValidTexasApiNumber, extractDistrictFromApi
 *
 * Run with: npx vitest run lib/trrc/__tests__/normalization.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  normalizeApiNumber,
  detectInputType,
  normalizeLeaseNumber,
  normalizeOperatorName,
  isValidTexasApiNumber,
  extractDistrictFromApi,
} from "../normalization";

// ─── normalizeApiNumber ───────────────────────────────────────────────────────

describe("normalizeApiNumber — valid Texas inputs", () => {
  it("parses dashed 10-digit form: '42-151-01734'", () => {
    const result = normalizeApiNumber("42-151-01734");
    expect(result).not.toBeNull();
    expect(result!.api10).toBe("4215101734");
    expect(result!.formatted).toBe("42-151-01734-00-00");
    expect(result!.state_code).toBe("42");
    expect(result!.county_code).toBe("151");
    expect(result!.is_texas).toBe(true);
  });

  it("parses plain 10-digit form: '4215101734'", () => {
    const result = normalizeApiNumber("4215101734");
    expect(result).not.toBeNull();
    expect(result!.api10).toBe("4215101734");
    expect(result!.formatted).toBe("42-151-01734-00-00");
    expect(result!.state_code).toBe("42");
    expect(result!.county_code).toBe("151");
    expect(result!.is_texas).toBe(true);
  });

  it("parses 14-digit plain UWI: '42151017340000'", () => {
    const result = normalizeApiNumber("42151017340000");
    expect(result).not.toBeNull();
    expect(result!.api10).toBe("4215101734");
    expect(result!.formatted).toBe("42-151-01734-00-00");
    expect(result!.state_code).toBe("42");
    expect(result!.county_code).toBe("151");
    expect(result!.is_texas).toBe(true);
  });

  it("parses full 14-digit dashed UWI: '42-151-01734-00-00'", () => {
    const result = normalizeApiNumber("42-151-01734-00-00");
    expect(result).not.toBeNull();
    expect(result!.api10).toBe("4215101734");
    expect(result!.formatted).toBe("42-151-01734-00-00");
    expect(result!.state_code).toBe("42");
    expect(result!.county_code).toBe("151");
    expect(result!.is_texas).toBe(true);
  });

  it("returns consistent results for all four equivalent input forms", () => {
    const forms = [
      "42-151-01734",
      "4215101734",
      "42151017340000",
      "42-151-01734-00-00",
    ];
    const results = forms.map((f) => normalizeApiNumber(f));
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r!.api10).toBe("4215101734");
      expect(r!.formatted).toBe("42-151-01734-00-00");
      expect(r!.is_texas).toBe(true);
    }
  });
});

describe("normalizeApiNumber — invalid / non-Texas inputs", () => {
  it("returns null for non-Texas state code '12-345-67890'", () => {
    expect(normalizeApiNumber("12-345-67890")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeApiNumber("")).toBeNull();
  });

  it("returns null for non-numeric string 'not-an-api'", () => {
    expect(normalizeApiNumber("not-an-api")).toBeNull();
  });

  it("returns null for short string '999'", () => {
    expect(normalizeApiNumber("999")).toBeNull();
  });
});

// ─── detectInputType ──────────────────────────────────────────────────────────

describe("detectInputType — API numbers", () => {
  it("detects dashed Texas API as 'api_number'", () => {
    expect(detectInputType("42-151-01734")).toBe("api_number");
  });

  it("detects plain 10-digit Texas API as 'api_number'", () => {
    expect(detectInputType("4215101734")).toBe("api_number");
  });

  it("detects 14-digit UWI as 'api_number'", () => {
    expect(detectInputType("42151017340000")).toBe("api_number");
  });
});

describe("detectInputType — lease numbers", () => {
  it("detects 6-digit numeric string in P5 range as 'p5_number' (>=100000)", () => {
    // "123456" is >= 100000, so detectInputType classifies it as p5_number per the code
    expect(detectInputType("123456")).toBe("p5_number");
  });

  it("detects 6-digit numeric string below P5 range as 'rrc_lease_number' (<100000)", () => {
    // "012345" → trimmed to "012345" — purely numeric, 6 digits, parseInt=12345 < 100000
    // → p5_number branch skips it, falls through to rrc_lease_number
    expect(detectInputType("012345")).toBe("rrc_lease_number");
  });

  it("detects 4-digit numeric string as 'rrc_lease_number'", () => {
    expect(detectInputType("1234")).toBe("rrc_lease_number");
  });
});

describe("detectInputType — gas well IDs", () => {
  it("detects 'G' prefix + digits as 'gas_well_id'", () => {
    expect(detectInputType("G1234567")).toBe("gas_well_id");
  });

  it("detects 'GW' prefix + digits as 'gas_well_id'", () => {
    expect(detectInputType("GW12345")).toBe("gas_well_id");
  });

  it("detects dash-separated gas well ID as 'gas_well_id'", () => {
    expect(detectInputType("G-12345")).toBe("gas_well_id");
  });
});

describe("detectInputType — operator names", () => {
  it("detects company name with LLC as 'operator_name'", () => {
    expect(detectInputType("Pioneer Natural Resources")).toBe("operator_name");
  });

  it("detects company with 'Resources' keyword as 'operator_name'", () => {
    expect(detectInputType("Oxy Resources LLC")).toBe("operator_name");
  });
});

describe("detectInputType — legal descriptions", () => {
  it("detects string with 'Section' keyword as 'legal_description'", () => {
    expect(detectInputType("Section 15, Block 33, T&P RR Co Survey, Abstract 789")).toBe(
      "legal_description",
    );
  });

  it("detects string with 'Abstract' keyword as 'legal_description'", () => {
    expect(detectInputType("Section 15, Block 33, Abstract 789, Wheeler County, TX")).toBe(
      "legal_description",
    );
  });
});

describe("detectInputType — lease names", () => {
  it("detects short multi-word non-company string as 'lease_name'", () => {
    // "Taylor W.J." without company suffix, no digits — lease_name
    const result = detectInputType("Taylor Lease");
    expect(result).toBe("lease_name");
  });
});

// ─── normalizeLeaseNumber ─────────────────────────────────────────────────────

describe("normalizeLeaseNumber", () => {
  it("strips leading zeros from '01234' → '1234'", () => {
    expect(normalizeLeaseNumber("01234")).toBe("1234");
  });

  it("returns unchanged number without leading zeros: '12345' → '12345'", () => {
    expect(normalizeLeaseNumber("12345")).toBe("12345");
  });

  it("trims surrounding whitespace: '  12345  ' → '12345'", () => {
    expect(normalizeLeaseNumber("  12345  ")).toBe("12345");
  });

  it("returns '0' from '000000'", () => {
    expect(normalizeLeaseNumber("000000")).toBe("0");
  });

  it("preserves district-prefixed format and normalizes numeric part: '06:012345' → '06:12345'", () => {
    expect(normalizeLeaseNumber("06:012345")).toBe("06:12345");
  });
});

// ─── normalizeOperatorName ────────────────────────────────────────────────────

describe("normalizeOperatorName", () => {
  it("uppercases lowercase operator name", () => {
    expect(normalizeOperatorName("pioneer natural resources")).toBe(
      "PIONEER NATURAL RESOURCES",
    );
  });

  it("removes trailing period from 'Corp.'", () => {
    expect(normalizeOperatorName("Exxon Mobil Corp.")).toBe("EXXON MOBIL CORP");
  });

  it("collapses internal whitespace and trims", () => {
    expect(normalizeOperatorName("  Shell   Oil  Co  ")).toBe("SHELL OIL CO");
  });

  it("normalizes 'L.L.C.' to 'LLC'", () => {
    expect(normalizeOperatorName("Permian Basin L.L.C.")).toBe("PERMIAN BASIN LLC");
  });

  it("normalizes 'Inc.' to 'INC'", () => {
    expect(normalizeOperatorName("Concho Resources Inc.")).toBe(
      "CONCHO RESOURCES INC",
    );
  });
});

// ─── isValidTexasApiNumber ────────────────────────────────────────────────────

describe("isValidTexasApiNumber", () => {
  it("returns true for valid dashed Texas API '42-151-01734'", () => {
    expect(isValidTexasApiNumber("42-151-01734")).toBe(true);
  });

  it("returns true for valid plain 10-digit Texas API '4215101734'", () => {
    expect(isValidTexasApiNumber("4215101734")).toBe(true);
  });

  it("returns false for non-Texas state code '12-345-67890'", () => {
    expect(isValidTexasApiNumber("12-345-67890")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidTexasApiNumber("")).toBe(false);
  });

  it("returns false for junk string 'not-valid'", () => {
    expect(isValidTexasApiNumber("not-valid")).toBe(false);
  });
});

// ─── extractDistrictFromApi ───────────────────────────────────────────────────

describe("extractDistrictFromApi — official RRC county routing", () => {
  // https://www.rrc.texas.gov/about-us/locations/oil-gas-counties-districts/
  it.each([
    ["4215101734", "7B"], ["4220112345", "03"], ["4232901234", "08"],
    ["4200512345", "06"], ["4216502733", "8A"], ["4243934308", "05"],
  ])("routes %s to %s", (api, district) => expect(extractDistrictFromApi(api)).toBe(district));
  it.each(["not-an-api", "", "4299812345"])("rejects %s", api => expect(extractDistrictFromApi(api)).toBeNull());
});

describe("API identity preservation", () => {
  it.each(["G42123456", "42-165-502085", "42165027331", "421650273300001", "42-002-12345", "42-165-027"])("does not silently coerce %s", api => expect(normalizeApiNumber(api)).toBeNull());
  it("preserves sidetrack and completion identity", () => {
    expect(normalizeApiNumber("42-165-02733-01-02")?.api14).toBe("42165027330102");
    expect(normalizeApiNumber("421650273301")?.api14).toBe("42165027330100");
  });
  it("detects eight-digit RRC numbers without state prefix", () => expect(detectInputType("16502733")).toBe("api_number"));
});
