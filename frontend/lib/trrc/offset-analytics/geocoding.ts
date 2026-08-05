/**
 * Geocoding orchestration — dispatches a parsed LegalDescription to the
 * right provider. No provider-specific HTTP logic lives here; this is
 * pure routing plus the UNPARSED/manual-review terminal case.
 */

import type { GeocodeResult, LegalDescription, LegalDescriptionGeocoder, WarningEntry } from "./types";
import { geocodeTexasLegalDescription } from "./providers/texas-land-grid";
import { geocodePlssLegalDescription } from "./providers/plss";
import { DEFAULT_CONFIG, type OffsetAnalyticsConfig } from "./constants";

export class OffsetAnalyticsGeocoder implements LegalDescriptionGeocoder {
  async geocode(legalDescription: LegalDescription, signal?: AbortSignal): Promise<GeocodeResult> {
    switch (legalDescription.jurisdiction) {
      case "TX_LAND_GRID":
        return geocodeTexasLegalDescription(legalDescription, signal);
      case "PLSS":
        return geocodePlssLegalDescription(legalDescription, signal);
      case "UNPARSED":
        return manualReviewFromUnparsed(legalDescription);
      default: {
        // Exhaustiveness guard — if LegalDescription ever grows a new
        // jurisdiction variant without a case here, this is a compile error.
        const _exhaustive: never = legalDescription;
        throw new Error(`Unhandled legal description jurisdiction: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}

// Bumped whenever a provider's parsing/matching logic changes meaningfully
// (e.g. a new abstract-prefix fixed, a new match tier added) — folded into
// the cache key so old entries computed under different logic naturally
// stop being reused instead of silently persisting stale results
// ("source versioning" per this engine's security/config requirements).
const GEOCODE_LOGIC_VERSION = 1;

function cacheKeyFor(legalDescription: LegalDescription): string {
  return `v${GEOCODE_LOGIC_VERSION}:${JSON.stringify(legalDescription)}`;
}

interface CacheEntry {
  result: GeocodeResult;
  expiresAt: number;
}

const FAILURE_MATCH_METHODS: GeocodeResult["matchMethod"][] = ["MANUAL_REVIEW_REQUIRED", "UNMAPPABLE"];

/**
 * Wraps any LegalDescriptionGeocoder with an in-memory TTL cache. Real
 * survey/PLSS polygons don't move, so a successful match is cached for a
 * long TTL (config.geocodeCacheTtlMs) — but a failed match
 * (MANUAL_REVIEW_REQUIRED / UNMAPPABLE) is cached for a much shorter TTL
 * (config.geocodeFailureCacheTtlMs), since a failure is often a transient
 * provider hiccup or a temporarily-misconfigured input, not a permanent
 * fact about the tract — caching it indefinitely would make a fixable
 * problem look unfixable.
 *
 * In-memory only: this lives for the lifetime of one Node process (a
 * single Next.js server instance/request lambda), not across restarts or
 * multiple server instances — see index.ts's Phase 0 notes on why no
 * shared datastore is wired into this pipeline yet. Real, working cache
 * for what it is; not a claim of cross-instance persistence it doesn't have.
 */
export class CachedGeocoder implements LegalDescriptionGeocoder {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly inner: LegalDescriptionGeocoder,
    private readonly config: OffsetAnalyticsConfig = DEFAULT_CONFIG,
  ) {}

  async geocode(legalDescription: LegalDescription): Promise<GeocodeResult> {
    const key = cacheKeyFor(legalDescription);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const result = await this.inner.geocode(legalDescription);
    const isFailure = FAILURE_MATCH_METHODS.includes(result.matchMethod);
    const ttl = isFailure ? this.config.geocodeFailureCacheTtlMs : this.config.geocodeCacheTtlMs;
    this.cache.set(key, { result, expiresAt: Date.now() + ttl });
    return result;
  }

  /** For tests and diagnostics — not part of the LegalDescriptionGeocoder interface. */
  cacheSize(): number {
    return this.cache.size;
  }
}

function manualReviewFromUnparsed(desc: Extract<LegalDescription, { jurisdiction: "UNPARSED" }>): GeocodeResult {
  const warnings: WarningEntry[] = desc.parserWarnings.map(w => ({ code: "PARSE_WARNING", message: w, severity: "warning" as const }));
  warnings.push({
    code: "UNPARSED_INPUT",
    message: `Legal description text could not be parsed into either Texas land-grid or PLSS form. Unresolved: ${desc.unresolvedComponents.join(", ") || "unspecified"}`,
    severity: "critical",
  });
  return {
    canonicalIdentifier: null, centroidLatitude: null, centroidLongitude: null,
    geometry: null, geometryType: null, sourceProvider: "NONE", sourceRecordId: null,
    sourceUrlOrQueryId: null, spatialReferenceSystem: "EPSG:4326", retrievedAt: new Date().toISOString(),
    matchMethod: "MANUAL_REVIEW_REQUIRED", confidence: 0, warnings,
  };
}
