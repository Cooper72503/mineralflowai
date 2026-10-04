import type { EconomicsAssumptions } from "../economics-provider";
import type { LeaseDecisionRecord } from "./decision-layer";
import type { ChronologyRow } from "../title/chain-types";

/** One recording can produce many tract/interest events. Count instruments, not events. */
export function titleRecordingCounts(rows: Pick<ChronologyRow, "instrumentId" | "contentVerified">[]) {
  const instruments = new Map<string, boolean>();
  for (const row of rows) instruments.set(row.instrumentId, (instruments.get(row.instrumentId) ?? true) && row.contentVerified);
  return { indexedInstruments: instruments.size, readInstruments: [...instruments.values()].filter(Boolean).length };
}

export function scenarioScope(a: EconomicsAssumptions, lastMonth: string | null): string {
  return `Conditional ${a.interestType === "royalty" ? "royalty" : "working-interest"} scenario: NRI ${a.netRevenueInterest} (${(a.netRevenueInterest * 100).toFixed(2)}% of lease revenue)${a.interestType === "working" ? `; WI ${a.workingInterest}` : ""}. This is the assumed interest, not a price for the whole lease or all submitted wells. Ownership is not verified by entering a decimal. Valuation origin: month after ${lastMonth ?? "unavailable production date"}; not rolled forward to today's date.`;
}

export function scenarioStatus(record: LeaseDecisionRecord | undefined): string {
  return record?.economics.status === "calculated" && record.economics.scenarios
    ? "Conditional lease scenario" : "Economics unavailable";
}
