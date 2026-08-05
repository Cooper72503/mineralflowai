/**
 * Structured logging + metrics. This codebase's convention (confirmed
 * during Phase 20's own audit — no pino/winston dependency, no
 * console.log inside lib/trrc's other modules) is that library code
 * returns structured data rather than logging directly; callers at the
 * API-route boundary decide what to do with it. This module follows that:
 * a Logger INTERFACE that service.ts calls at each pipeline checkpoint,
 * injectable like the other Phase 19 dependencies, defaulting to a plain
 * structured-JSON console logger — swap in a real log pipeline (Datadog,
 * CloudWatch, etc.) by implementing the same interface, no changes to
 * service.ts required.
 */

export interface LogEvent {
  event: string;
  analysisId: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface Logger {
  log(event: LogEvent): void;
}

export class ConsoleLogger implements Logger {
  log(event: LogEvent): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(event));
  }
}

/** Discards everything — for tests that don't want log noise, or callers that only care about metrics. */
export class NoopLogger implements Logger {
  log(): void {}
}

export function logEvent(logger: Logger, analysisId: string, event: string, fields: Record<string, unknown> = {}): void {
  logger.log({ event, analysisId, timestamp: new Date().toISOString(), ...fields });
}

// ─── Metrics ─────────────────────────────────────────────────────────────────
//
// This module has no persistent store (see index.ts's Phase 0 notes — no
// queryable datastore is wired into this pipeline), so "metrics" here
// means: summarize a BATCH of already-completed OffsetAnalyticsPayloads
// (however the caller chooses to accumulate them — in-memory across a
// session, pulled from wherever they logged the payloads, etc.) into the
// specific rates this engine's observability requirements ask for.

import type { OffsetAnalyticsPayload } from "./types";

export interface MetricsSummary {
  runCount: number;
  geocodeSuccessRate: number; // fraction NOT UNMAPPABLE/MANUAL_REVIEW_REQUIRED
  exactMatchRate: number; // fraction EXACT_PARCEL or EXACT_SURVEY specifically
  noAnalogFrequency: number; // fraction with zero qualified analogs
  avgAnalogCount: number;
  formationMismatchFrequency: number; // avg removedForFormationMismatch per run
  declineFitRejectionRate: number; // avg (candidatesFound - qualifiedAnalogs related to fit rejection) — approximated from analogWells vs qualifiedAnalogs since per-fit rejection detail isn't retained on the payload itself
  avgAnalysisLatencyMs: number;
  providerErrorRate: number; // fraction of runs with at least one "critical" warning
}

const EXACT_METHODS: OffsetAnalyticsPayload["geocode"]["matchMethod"][] = ["EXACT_PARCEL", "EXACT_SURVEY"];
const FAILURE_METHODS: OffsetAnalyticsPayload["geocode"]["matchMethod"][] = ["UNMAPPABLE", "MANUAL_REVIEW_REQUIRED"];

export function computeMetricsSummary(payloads: (OffsetAnalyticsPayload & { durationMs?: number })[]): MetricsSummary {
  const n = payloads.length;
  if (n === 0) {
    return { runCount: 0, geocodeSuccessRate: 0, exactMatchRate: 0, noAnalogFrequency: 0, avgAnalogCount: 0, formationMismatchFrequency: 0, declineFitRejectionRate: 0, avgAnalysisLatencyMs: 0, providerErrorRate: 0 };
  }

  const geocodeSuccesses = payloads.filter(p => !FAILURE_METHODS.includes(p.geocode.matchMethod)).length;
  const exactMatches = payloads.filter(p => EXACT_METHODS.includes(p.geocode.matchMethod)).length;
  const noAnalogRuns = payloads.filter(p => p.analogWells.length === 0).length;
  const totalAnalogCount = payloads.reduce((s, p) => s + p.analogWells.length, 0);
  const totalFormationMismatches = payloads.reduce((s, p) => s + p.search.removedForFormationMismatch, 0);
  const totalDeclineFitRejections = payloads.reduce((s, p) => s + Math.max(0, p.search.qualifiedAnalogs - p.analogWells.filter(a => a.declineFit !== null).length), 0);
  const totalLatency = payloads.reduce((s, p) => s + (p.durationMs ?? 0), 0);
  const runsWithCriticalWarning = payloads.filter(p => p.warnings.some(w => w.severity === "critical")).length;

  return {
    runCount: n,
    geocodeSuccessRate: geocodeSuccesses / n,
    exactMatchRate: exactMatches / n,
    noAnalogFrequency: noAnalogRuns / n,
    avgAnalogCount: totalAnalogCount / n,
    formationMismatchFrequency: totalFormationMismatches / n,
    declineFitRejectionRate: totalDeclineFitRejections / n,
    avgAnalysisLatencyMs: totalLatency / n,
    providerErrorRate: runsWithCriticalWarning / n,
  };
}
