/**
 * Typed configuration, validated at import time (module-load = this
 * engine's "startup," since it runs inside Next.js API routes rather than
 * a long-lived server process). No provider used anywhere in this engine
 * requires an API key — OTLS, RRC GIS, BLM PLSS, and TRRC EWA are all
 * public, unauthenticated services (confirmed live during Phase 0/3
 * audits) — so there is nothing secret to load from an env var here. If a
 * future provider tier needs one (see index.ts's Phase 3 notes on
 * "configured commercial provider"), it must be read from
 * process.env, never hardcoded, matching this codebase's existing
 * convention (see eia-pricing.ts's EIA_API_KEY handling).
 */

export interface OffsetAnalyticsConfig {
  providerTimeoutMs: number;
  maxCandidatesToEnrich: number;
  maxRadiusMiles: number;
  defaultRadiusMiles: number;
  geocodeCacheTtlMs: number;
  geocodeFailureCacheTtlMs: number; // shorter — never cache a failed geocode indefinitely
}

export const DEFAULT_CONFIG: OffsetAnalyticsConfig = {
  providerTimeoutMs: 20_000,
  maxCandidatesToEnrich: 15,
  maxRadiusMiles: 25,
  defaultRadiusMiles: 5,
  geocodeCacheTtlMs: 24 * 60 * 60 * 1000, // 24h — a real survey polygon doesn't move; safe to cache long
  geocodeFailureCacheTtlMs: 5 * 60 * 1000, // 5min — a transient provider hiccup shouldn't poison the cache for a day
};

function validateConfig(config: OffsetAnalyticsConfig): void {
  const errors: string[] = [];
  if (config.providerTimeoutMs <= 0) errors.push("providerTimeoutMs must be positive");
  if (config.maxCandidatesToEnrich <= 0) errors.push("maxCandidatesToEnrich must be positive");
  if (config.maxRadiusMiles <= 0) errors.push("maxRadiusMiles must be positive");
  if (config.defaultRadiusMiles <= 0 || config.defaultRadiusMiles > config.maxRadiusMiles) errors.push("defaultRadiusMiles must be positive and <= maxRadiusMiles");
  if (config.geocodeCacheTtlMs < 0) errors.push("geocodeCacheTtlMs must be non-negative");
  if (config.geocodeFailureCacheTtlMs < 0 || config.geocodeFailureCacheTtlMs > config.geocodeCacheTtlMs) errors.push("geocodeFailureCacheTtlMs must be non-negative and <= geocodeCacheTtlMs");
  if (errors.length > 0) {
    throw new Error(`Invalid OffsetAnalyticsConfig: ${errors.join("; ")}`);
  }
}

validateConfig(DEFAULT_CONFIG);

/** Merges partial overrides onto DEFAULT_CONFIG and validates the result — never returns an unvalidated config. */
export function resolveConfig(overrides: Partial<OffsetAnalyticsConfig> = {}): OffsetAnalyticsConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(merged);
  return merged;
}

/** Applies a default timeout when the caller didn't supply their own AbortSignal — every live provider call should go through this rather than an unbounded fetch. */
export function withDefaultTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ?? AbortSignal.timeout(timeoutMs);
}
