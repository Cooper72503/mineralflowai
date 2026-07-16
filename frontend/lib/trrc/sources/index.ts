/**
 * TRRC Source Adapters — Central Export
 *
 * All adapters implement TrrcSourceAdapter from lib/trrc/types.ts.
 * Use getAllAdapters() to get the full list for engine registration.
 */

export { ProductionByLeaseSource, ProductionByApiSource } from "./production-source";
export { ComplianceSource } from "./compliance-source";
export { CompletionSource } from "./completion-source";
export { P5Source } from "./p5-source";
export { InactiveWellSource } from "./inactive-well-source";
export { InjectionSource } from "./injection-source";
export { WellboreSource } from "./wellbore-source";
export { LeaseInventorySource } from "./lease-inventory-source";
export { ProrationSource } from "./proration-source";
export {
  ImagedRecordsSource,
  DrillingPermitSource,
  PluggingRecordsSource,
  OrphanWellSource,
  SeveranceSource,
  P4GathererSource,
  WellStatusSource,
} from "./manual-fallback-sources";

import type { TrrcSourceAdapter } from "../types";
import { ProductionByLeaseSource, ProductionByApiSource } from "./production-source";
import { ComplianceSource } from "./compliance-source";
import { CompletionSource } from "./completion-source";
import { P5Source } from "./p5-source";
import { InactiveWellSource } from "./inactive-well-source";
import { InjectionSource } from "./injection-source";
import { WellboreSource } from "./wellbore-source";
import { LeaseInventorySource } from "./lease-inventory-source";
import { ProrationSource } from "./proration-source";
import {
  ImagedRecordsSource,
  DrillingPermitSource,
  PluggingRecordsSource,
  OrphanWellSource,
  SeveranceSource,
  P4GathererSource,
  WellStatusSource,
} from "./manual-fallback-sources";

/**
 * Returns all registered TRRC source adapters.
 * Order reflects recommended execution priority:
 *   1. Identity / wellbore resolution
 *   2. Production (automated)
 *   3. Compliance / regulatory
 *   4. Operator status
 *   5. Manual fallbacks last
 */
export function getAllAdapters(): TrrcSourceAdapter[] {
  return [
    // Identity
    WellboreSource,
    LeaseInventorySource,

    // Production
    ProductionByLeaseSource,
    ProductionByApiSource,
    ProrationSource,

    // Completion / drilling
    CompletionSource,

    // Compliance / regulatory
    ComplianceSource,
    InactiveWellSource,
    InjectionSource,

    // Operator status
    P5Source,

    // Manual fallbacks
    ImagedRecordsSource,
    DrillingPermitSource,
    PluggingRecordsSource,
    OrphanWellSource,
    SeveranceSource,
    P4GathererSource,
    WellStatusSource,
  ];
}

/**
 * Returns only enabled adapters.
 */
export function getEnabledAdapters(): TrrcSourceAdapter[] {
  return getAllAdapters().filter(a => a.is_enabled);
}

/**
 * Returns only automated adapters (not manual fallbacks).
 */
export function getAutomatedAdapters(): TrrcSourceAdapter[] {
  return getAllAdapters().filter(a => !a.requires_browser);
}

/**
 * Returns only manual fallback adapters.
 */
export function getManualAdapters(): TrrcSourceAdapter[] {
  return getAllAdapters().filter(a => a.requires_browser);
}

/**
 * Look up a single adapter by id.
 * Returns null if not found.
 */
export function getAdapterById(id: string): TrrcSourceAdapter | null {
  return getAllAdapters().find(a => a.id === id) ?? null;
}
