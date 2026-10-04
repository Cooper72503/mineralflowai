import { describe, it, expect } from "vitest";
import { isTransientInfrastructureError, TransientRetrievalError, PipelinePersistenceError } from "../persistence.js";

describe("database and network interruptions are retried, not recorded as failures", () => {
  it("recognises the live 2026-10-04 outage messages", () => {
    for (const m of ["Run progress persistence failed: upstream request timeout", "Could not load run: upstream request timeout",
      "TypeError: fetch failed", "Failed to create login role: Connection terminated due to connection timeout",
      "Title job reload failed: <!DOCTYPE html><title>supabase.co | 521: Web server is down</title>", "HTTP 503 Service Unavailable",
      "canceling statement due to statement timeout"])
      expect(isTransientInfrastructureError(new Error(m))).toBe(true);
    expect(isTransientInfrastructureError(new PipelinePersistenceError("Diligence run claim: upstream request timeout"))).toBe(true);
  });
  it("leaves real failures and TRRC outages to their own handling", () => {
    for (const m of ["Required asset identifiers could not be resolved", "Invalid Texas API", "Package member runs missing", "Evidence changed"])
      expect(isTransientInfrastructureError(new Error(m))).toBe(false);
    expect(isTransientInfrastructureError(new TransientRetrievalError("TRRC well identity lookup unavailable: fetch failed"))).toBe(false);
  });
});
