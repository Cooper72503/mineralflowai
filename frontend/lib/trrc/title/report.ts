/**
 * Report assembly. The chronological table, ownership branches, findings,
 * source inventory, and the downloadable JSON are ALL projections of one
 * validated TitleChainAnalysis object — this module renders that object,
 * it never recomputes anything, so no two surfaces can diverge.
 */

import type { TitleChainAnalysis, ChronologyRow, OwnershipBranch, PartyRef, Holding } from "./chain-types";
import { STATUS_DISPLAY, TITLE_CHAIN_REPORT_STATEMENT } from "./chain-types";
import { Fraction } from "./fraction";

export interface ReportExecutiveSummary {
  apiNumbers: string[];
  tracts: string[];
  interestScope: string[];
  earliestEvidencedHolders: Array<{ branch: string; holders: string[]; date: string | null }>;
  apparentCurrentHolders: Array<{ branch: string; holders: Array<{ names: string; share: string; status: string; note: string | null }> }>;
  status: string;
  statusCode: string;
  statusRule: string;
  coverageLimitations: string[];
  findingCounts: Record<string, number>;
}

export interface TitleChainReport {
  schemaVersion: string;
  analysisId: string;
  jobId: string;
  version: number;
  generatedAt: string;
  statement: string;
  executiveSummary: ReportExecutiveSummary;
  chronology: ChronologyRow[];
  branches: OwnershipBranch[];
  findings: TitleChainAnalysis["findings"];
  sourceInventory: TitleChainAnalysis["sourceInventory"];
  searchCoverage: TitleChainAnalysis["searchCoverage"];
  analysis: TitleChainAnalysis;
}

export function formatParty(p: PartyRef): string {
  const cap = p.capacity !== "individual" && p.capacity !== "unknown" ? ` (${p.capacityDetail ?? p.capacity.replace(/_/g, " ")})` : "";
  return `${p.displayName}${cap}`;
}

export function formatShare(h: Holding): string {
  if (!h.share) return "not quantified in reviewed records";
  const f = Fraction.fromJson(h.share);
  return f ? `${f.toString()} (${f.toDecimal(6)})` : "not quantified";
}

export function buildTitleChainReport(analysis: TitleChainAnalysis): TitleChainReport {
  const findingCounts: Record<string, number> = {};
  for (const f of analysis.findings) findingCounts[f.type] = (findingCounts[f.type] ?? 0) + 1;

  const executiveSummary: ReportExecutiveSummary = {
    apiNumbers: analysis.wells.map(w => w.formatted ?? w.originalInput),
    tracts: analysis.tracts.filter(t => t.matchStatus === "confirmed").map(t => t.tractLabel),
    interestScope: analysis.interestScope,
    earliestEvidencedHolders: analysis.branches.map(b => ({ branch: `${b.tractLabel} — ${b.interestType.replace(/_/g, " ")}`, holders: b.earliestEvidencedHolders.map(formatParty), date: b.earliestEvidencedDate })),
    apparentCurrentHolders: analysis.branches.map(b => ({
      branch: `${b.tractLabel} — ${b.interestType.replace(/_/g, " ")}`,
      holders: b.apparentHolders.map(h => ({ names: h.parties.map(formatParty).join(" & "), share: formatShare(h), status: h.status.replace(/_/g, " "), note: h.shareNote })),
    })),
    status: STATUS_DISPLAY[analysis.status],
    statusCode: analysis.status,
    statusRule: analysis.statusRule,
    coverageLimitations: analysis.limitations,
    findingCounts,
  };

  return {
    schemaVersion: analysis.schemaVersion,
    analysisId: analysis.analysisId,
    jobId: analysis.jobId,
    version: analysis.version,
    generatedAt: analysis.generatedAt,
    statement: TITLE_CHAIN_REPORT_STATEMENT,
    executiveSummary,
    chronology: analysis.chronology,
    branches: analysis.branches,
    findings: analysis.findings,
    sourceInventory: analysis.sourceInventory,
    searchCoverage: analysis.searchCoverage,
    analysis,
  };
}

/** Plain-text rendering (used for the .txt download and for tests that prove table/JSON parity). */
export function renderChronologyText(rows: ChronologyRow[]): string {
  const header = ["Date (basis)", "Instrument", "Parties", "Recording", "Tract / interest", "Fraction", "Verified", "Notes"].join(" | ");
  const lines = rows.map(r => [
    `${r.sortDate ?? "undated"} (${r.dateBasis})`, r.instrumentType.replace(/_/g, " "), r.parties, r.recordingReference ?? "—",
    `${r.tractLabel} / ${r.interestType.replace(/_/g, " ")} (${r.effect})`, r.fraction ?? "—", r.contentVerified ? "yes" : "index only", r.notes,
  ].join(" | "));
  return [header, ...lines].join("\n");
}
