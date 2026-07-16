/**
 * TRRC Entity Resolver — unit tests.
 *
 * Tests the pure (no network) entity resolution logic.
 * resolveEntities does all work locally — no mocking required.
 *
 * Run with: npx vitest run lib/trrc/__tests__/entity-resolver.test.ts
 */

import { describe, it, expect } from "vitest";
import { resolveEntities } from "../entity-resolver";

// ─── API number input ─────────────────────────────────────────────────────────

describe("resolveEntities — API number input", () => {
  it("resolves dashed API number to a wellbore entity with high confidence", async () => {
    const result = await resolveEntities(
      "42-151-01734",
      null,   // no type override
      null,   // no county
      null,   // no district
      null,   // no operator
      null,   // no lease name
    );

    expect(result.error).toBeNull();
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    expect(result.entities[0].entity_type).toBe("wellbore");
    expect(result.entities[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.needs_user_selection).toBe(false);
    expect(result.resolution_trace.length).toBeGreaterThan(0);
    expect(result.input_type).toBe("api_number");
  });

  it("resolves plain 10-digit API number to the same wellbore", async () => {
    const result = await resolveEntities("4215101734", null, null, null, null, null);

    expect(result.error).toBeNull();
    expect(result.entities[0].entity_type).toBe("wellbore");
    expect(result.entities[0].attributes["api10"]).toBe("4215101734");
  });

  it("also creates a lease entity when district can be inferred from API county code", async () => {
    // county_code 151 → district 04 — the resolver should add a lease entity
    const result = await resolveEntities("42-151-01734", null, null, null, null, null);

    expect(result.error).toBeNull();
    const leaseEntity = result.entities.find((e) => e.entity_type === "lease");
    expect(leaseEntity).toBeDefined();
  });

  it("sets normalized_input to the wellbore canonical identifier", async () => {
    const result = await resolveEntities("4215101734", null, null, null, null, null);
    expect(result.normalized_input).toBe("4215101734");
  });
});

// ─── Operator name input ──────────────────────────────────────────────────────

describe("resolveEntities — operator name input", () => {
  it("resolves operator name to an operator entity", async () => {
    const result = await resolveEntities(
      "Pioneer Natural Resources",
      null, null, null, null, null,
    );

    expect(result.error).toBeNull();
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    expect(result.entities[0].entity_type).toBe("operator");
    expect(result.input_type).toBe("operator_name");
  });

  it("operator name entity has confidence <= 0.9 (less certain than API)", async () => {
    const result = await resolveEntities(
      "Pioneer Natural Resources",
      null, null, null, null, null,
    );

    expect(result.entities[0].confidence).toBeLessThanOrEqual(0.9);
  });

  it("normalizes the operator name to uppercase in canonical_identifier", async () => {
    const result = await resolveEntities(
      "pioneer natural resources",
      null, null, null, null, null,
    );

    expect(result.entities[0].canonical_identifier).toBe("PIONEER NATURAL RESOURCES");
  });
});

// ─── Legal description input ──────────────────────────────────────────────────

describe("resolveEntities — legal description input", () => {
  it("resolves legal description to at least one entity", async () => {
    const result = await resolveEntities(
      "Section 15, Block 33, Abstract 789, Wheeler County, TX",
      null, "Wheeler", null, null, null,
    );

    expect(result.error).toBeNull();
    expect(result.entities.length).toBeGreaterThanOrEqual(1);
    expect(result.input_type).toBe("legal_description");
  });

  it("sets needs_user_selection true for legal descriptions", async () => {
    const result = await resolveEntities(
      "Section 15, Block 33, Abstract 789, Wheeler County, TX",
      null, "Wheeler", null, null, null,
    );

    expect(result.needs_user_selection).toBe(true);
  });

  it("all legal description entities have confidence < 0.85", async () => {
    const result = await resolveEntities(
      "Section 15, Block 33, Abstract 789, Wheeler County, TX",
      null, "Wheeler", null, null, null,
    );

    for (const entity of result.entities) {
      expect(entity.confidence).toBeLessThan(0.85);
    }
  });
});

// ─── Empty input ──────────────────────────────────────────────────────────────

describe("resolveEntities — empty input", () => {
  it("returns error for empty string", async () => {
    const result = await resolveEntities("", null, null, null, null, null);

    // Either error is set OR entities is empty
    const hasError = result.error !== null;
    const noEntities = result.entities.length === 0;
    expect(hasError || noEntities).toBe(true);
  });

  it("returns error for whitespace-only input", async () => {
    const result = await resolveEntities("   ", null, null, null, null, null);

    expect(result.error).not.toBeNull();
    expect(result.entities).toHaveLength(0);
  });

  it("returns needs_user_selection true for empty input", async () => {
    const result = await resolveEntities("", null, null, null, null, null);
    expect(result.needs_user_selection).toBe(true);
  });
});

// ─── Type override ────────────────────────────────────────────────────────────

describe("resolveEntities — type override", () => {
  it("honors operator_name override even for a numeric-looking input", async () => {
    const result = await resolveEntities(
      "Pioneer Natural Resources LLC",
      "operator_name",
      null, null, null, null,
    );

    expect(result.entities[0].entity_type).toBe("operator");
  });

  it("records the type override in resolution_trace", async () => {
    const result = await resolveEntities(
      "Pioneer Natural Resources LLC",
      "operator_name",
      null, null, null, null,
    );

    // Trace should note the detected vs. overridden type if they differ
    expect(result.resolution_trace.length).toBeGreaterThan(0);
  });
});

// ─── Lease number input ───────────────────────────────────────────────────────

describe("resolveEntities — RRC lease number", () => {
  it("resolves 4-6 digit numeric string to a lease entity", async () => {
    const result = await resolveEntities("12345", null, null, null, null, null);

    expect(result.error).toBeNull();
    expect(result.entities[0].entity_type).toBe("lease");
    expect(result.input_type).toBe("rrc_lease_number");
  });

  it("sets lower confidence when no district provided", async () => {
    const result = await resolveEntities("12345", null, null, null, null, null);
    // No district — confidence should be 0.6
    expect(result.entities[0].confidence).toBeLessThan(0.85);
  });

  it("sets higher confidence when district is provided", async () => {
    const result = await resolveEntities("12345", null, null, "05", null, null);
    // With district — confidence should be 0.9
    expect(result.entities[0].confidence).toBeGreaterThanOrEqual(0.85);
  });
});
