/**
 * Cross-Source Contradiction Detection Engine
 *
 * Compares data across all evidence sources — seller documents, TRRC wellbore
 * query, TRRC production, completion records, and compliance — and surfaces
 * contradictions that require manual review before any offer can be made.
 *
 * Implements the five contradiction types from the Manus AI code review:
 *   1. Operator mismatch      — seller doc ≠ TRRC wellbore query
 *   2. Lease mismatch         — user-input lease ≠ TRRC-resolved lease
 *   3. Status mismatch        — wellbore shows active, but production is zero
 *   4. Production mismatch    — seller claim materially exceeds TRRC stabilized rate
 *   5. Completion mismatch    — seller claims workover/recompletion, no CMPL record found
 *
 * Each contradiction carries:
 *   - severity: "critical" | "important" | "informational"
 *   - field: the specific data point that conflicts
 *   - source_a / value_a: first source and its value
 *   - source_b / value_b: second source and its value
 *   - recommended_action: exact step the underwriter should take
 *   - auto_suppresses_economics: true when this contradiction is severe enough
 *     to make offer/NPV calculations unreliable
 */

import type { DocumentExtractionResult } from "./document-extraction";
import type { TrrcViolation } from "./trrc-compliance";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ContradictionSeverity = "critical" | "important" | "informational";

export type Contradiction = {
  id: string;
  severity: ContradictionSeverity;
  /** Which data point is in conflict (e.g. "Operator Name", "Current Production Rate") */
  field: string;
  /** Human-readable description of what the contradiction is */
  description: string;
  /** First source (e.g. "Seller document") */
  source_a: string;
  value_a: string | number | null;
  /** Second source (e.g. "TRRC wellbore query") */
  source_b: string;
  value_b: string | number | null;
  /** Exact action the underwriter must take before proceeding */
  recommended_action: string;
  /**
   * When true, the economics section and offer range should be suppressed
   * until this contradiction is resolved.  Critical-severity contradictions
   * on production or ownership fields always set this to true.
   */
  auto_suppresses_economics: boolean;
};

// ─── Input context ────────────────────────────────────────────────────────────

export type ContradictionContext = {
  /** Raw seller/operator documents extracted by AI */
  extracted: DocumentExtractionResult | null;
  /** Operator name resolved from TRRC wellbore query (not from docs) */
  trrcOperatorName: string | null;
  /** Lease number resolved from TRRC wellbore query */
  trrcResolvedLeaseNo: string | null;
  /** Lease number(s) provided by the user or extracted from docs */
  userProvidedLeaseNos: string[];
  /** API numbers provided by the user */
  userProvidedApis: string[];
  /** API numbers resolved via TRRC (may differ from input) */
  trrcResolvedApis: string[];
  /** TRRC stabilized production rate (output of production-engine) */
  trrcStabilizedRateBbl: number | null;
  /** Month/year of the most recent TRRC production row */
  trrcLatestProductionMonth: string | null;
  /** Whether the TRRC wellbore record shows this well as "active" */
  trrcWellboreStatusActive: boolean | null;
  /** Number of TRRC months with zero production at the end of the series */
  trrcConsecutiveZeroMonthsAtEnd: number;
  /** True if the seller documents mention a recent workover or recompletion */
  sellerClaimsWorkover: boolean;
  /** True if any TRRC completion record was found for this API */
  trrcCompletionFound: boolean;
  /** Seller-stated current monthly production (BBL/mo), if any */
  sellerClaimedMonthlyBbl: number | null;
  /** Open TRRC violations count */
  openViolationCount: number;
  /** County from user input */
  inputCounty: string | null;
  /** County resolved from TRRC (from wellbore result HTML) */
  trrcResolvedCounty: string | null;
};

// ─── Name normalization helper ────────────────────────────────────────────────

/** Strip legal suffixes, punctuation, and case for operator name comparison */
function normalizeOperatorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|corp|co|ltd|lp|operating|oil|gas|energy|resources|petroleum)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns true when two operator names are clearly different (not just formatting) */
function operatorNamesConflict(a: string, b: string): boolean {
  const na = normalizeOperatorName(a);
  const nb = normalizeOperatorName(b);
  if (!na || !nb) return false;
  // Allow for one being a substring of the other (e.g. "Pioneer" vs "Pioneer Natural Resources")
  if (na.includes(nb) || nb.includes(na)) return false;
  return na !== nb;
}

// ─── Main detector ────────────────────────────────────────────────────────────

export function detectContradictions(ctx: ContradictionContext): Contradiction[] {
  const out: Contradiction[] = [];
  let idCounter = 0;
  const id = () => `C${String(++idCounter).padStart(3, "0")}`;

  // ── 1. Operator mismatch ──────────────────────────────────────────────────
  //
  // Seller documents state one operator; TRRC wellbore query returns a different
  // one.  This is a critical red flag — either the wrong well was matched, or the
  // operator change was not disclosed.
  {
    const docOperator  = ctx.extracted?.operator_name ?? null;
    const trrcOperator = ctx.trrcOperatorName;

    if (docOperator && trrcOperator && operatorNamesConflict(docOperator, trrcOperator)) {
      out.push({
        id: id(),
        severity: "critical",
        field: "Operator Name",
        description:
          `Seller documents identify the operator as "${docOperator}", but the TRRC wellbore ` +
          `query returns "${trrcOperator}". Either the wrong well was matched, or an undisclosed ` +
          `operator change has occurred.`,
        source_a:   "Seller / operator documents",
        value_a:    docOperator,
        source_b:   "TRRC wellbore query (EWA)",
        value_b:    trrcOperator,
        recommended_action:
          "Confirm current operator via TRRC P-5 Organization Report. Do not proceed until " +
          "operator identity is confirmed — a mismatch blocks RRC transfer approval.",
        auto_suppresses_economics: true,
      });
    }
  }

  // ── 2. Lease mismatch ─────────────────────────────────────────────────────
  //
  // The user (or doc extraction) provided a specific RRC lease number, but TRRC
  // resolved to a different lease.  Production data would then be attributed to
  // the wrong asset.
  {
    const userLeases = ctx.userProvidedLeaseNos.map(l => l.replace(/\D/g, "")).filter(Boolean);
    const trrcLease  = ctx.trrcResolvedLeaseNo?.replace(/\D/g, "") ?? null;

    if (trrcLease && userLeases.length > 0 && !userLeases.includes(trrcLease)) {
      out.push({
        id: id(),
        severity: "critical",
        field: "RRC Lease Number",
        description:
          `User provided lease number(s) ${ctx.userProvidedLeaseNos.join(", ")} but TRRC resolved ` +
          `the API to lease ${ctx.trrcResolvedLeaseNo}. Production data may be attributed to the ` +
          `wrong asset.`,
        source_a:   "User input / document extraction",
        value_a:    ctx.userProvidedLeaseNos.join(", "),
        source_b:   "TRRC wellbore query (EWA)",
        value_b:    ctx.trrcResolvedLeaseNo,
        recommended_action:
          "Verify correct RRC lease number with seller. Confirm the API resolves to the intended " +
          "lease before using any production figures for valuation.",
        auto_suppresses_economics: true,
      });
    }
  }

  // ── 3. Status mismatch ────────────────────────────────────────────────────
  //
  // TRRC wellbore record shows the well as active/producing, but the most recent
  // TRRC production months are all zero.  Possible causes: shut-in not reported,
  // production attributed to a different lease, TRRC data lag, or mechanical failure.
  {
    if (
      ctx.trrcWellboreStatusActive === true &&
      ctx.trrcConsecutiveZeroMonthsAtEnd >= 3
    ) {
      out.push({
        id: id(),
        severity: "important",
        field: "Well Status vs. Production",
        description:
          `TRRC wellbore record shows this well as active/producing, but the last ` +
          `${ctx.trrcConsecutiveZeroMonthsAtEnd} TRRC months show zero production. ` +
          `The well may be shut in, the production may be reported under a different lease, ` +
          `or there may be an unreported mechanical failure.`,
        source_a:   "TRRC wellbore status",
        value_a:    "Active",
        source_b:   `TRRC production (last ${ctx.trrcConsecutiveZeroMonthsAtEnd} months)`,
        value_b:    "0 BBL/month",
        recommended_action:
          "Request current well status and most recent gauge ticket from operator. Confirm " +
          "whether the well is shut-in and if a restart plan exists. Adjust economics to $0 " +
          "revenue until production is confirmed.",
        auto_suppresses_economics: false, // already handled by offline detection
      });
    }
  }

  // ── 4. Production mismatch ────────────────────────────────────────────────
  //
  // Seller claims a current production rate that is materially higher than the
  // TRRC-stabilized rate.  A ratio > 1.5× is a significant red flag — it suggests
  // either production has recently increased (requires run tickets to verify) or
  // the seller is misrepresenting the asset.
  {
    const claimed    = ctx.sellerClaimedMonthlyBbl;
    const stabilized = ctx.trrcStabilizedRateBbl;

    if (claimed != null && stabilized != null && stabilized > 0) {
      const ratio = claimed / stabilized;

      if (ratio > 2.0) {
        out.push({
          id: id(),
          severity: "critical",
          field: "Current Production Rate",
          description:
            `Seller documents claim ${claimed.toLocaleString()} BBL/month current production, ` +
            `but the TRRC-stabilized rate is ${stabilized.toLocaleString()} BBL/month — a ` +
            `${ratio.toFixed(1)}× discrepancy. This is a material misrepresentation risk.`,
          source_a:   "Seller / operator documents",
          value_a:    claimed,
          source_b:   "TRRC stabilized production rate",
          value_b:    stabilized,
          recommended_action:
            "Require signed purchaser run statements for the last 12 months before any offer. " +
            "Do not use seller-stated production in economics until run tickets are verified.",
          auto_suppresses_economics: true,
        });
      } else if (ratio > 1.5) {
        out.push({
          id: id(),
          severity: "important",
          field: "Current Production Rate",
          description:
            `Seller documents claim ${claimed.toLocaleString()} BBL/month current production, ` +
            `but the TRRC-stabilized rate is ${stabilized.toLocaleString()} BBL/month — a ` +
            `${ratio.toFixed(1)}× discrepancy. Could indicate recent stimulation or overstatement.`,
          source_a:   "Seller / operator documents",
          value_a:    claimed,
          source_b:   "TRRC stabilized production rate",
          value_b:    stabilized,
          recommended_action:
            "Request purchaser run statements for the most recent 3 months. If seller claims a " +
            "recent workover, require completion records and post-workover gauge tickets.",
          auto_suppresses_economics: false,
        });
      } else if (ratio > 1.2) {
        // ── §3.1.2 Logic of Skepticism — 20% discrepancy informational flag ──
        // Any seller claim that diverges from TRRC by ≥20% must be explicitly flagged
        // as UNVERIFIED until run tickets independently confirm the seller's stated rate.
        // Even a 20% uplift is material at acquisition multiples of 3–6× annual NCF.
        out.push({
          id: id(),
          severity: "informational",
          field: "Current Production Rate",
          description:
            `Seller-stated rate (${claimed.toLocaleString()} BBL/month) exceeds TRRC-stabilized ` +
            `rate (${stabilized.toLocaleString()} BBL/month) by ${((ratio - 1) * 100).toFixed(0)}%. ` +
            `Seller claim is UNVERIFIED — TRRC public record is used as authoritative basis ` +
            `until purchaser run tickets independently confirm the higher rate.`,
          source_a:   "Seller / operator documents",
          value_a:    claimed,
          source_b:   "TRRC stabilized production rate (authoritative)",
          value_b:    stabilized,
          recommended_action:
            "Cross-reference seller-stated rate against the last 3 months of signed purchaser " +
            "run statements before using it in valuation. TRRC rate is treated as authoritative " +
            "until run tickets confirm otherwise. A 20%+ uplift is material at 4–6× NCF multiples.",
          auto_suppresses_economics: false,
        });
      }
    }
  }

  // ── 5. Completion / workover mismatch ────────────────────────────────────
  //
  // Seller documents describe a recent recompletion or workover (a value-add
  // story), but no corresponding completion record appears in TRRC CMPL.
  // This doesn't prove the workover didn't happen (it may not have been filed
  // yet, or it may be a minor repair), but it must be flagged.
  {
    if (ctx.sellerClaimsWorkover && !ctx.trrcCompletionFound) {
      out.push({
        id: id(),
        severity: "important",
        field: "Workover / Recompletion Evidence",
        description:
          "Seller documents describe a recent workover or recompletion, but no corresponding " +
          "completion record was found in TRRC CMPL. The workover is supported by seller " +
          "documents only — no independent public record.",
        source_a:   "Seller / operator documents",
        value_a:    "Workover or recompletion claimed",
        source_b:   "TRRC CMPL completion records",
        value_b:    "No completion packet found",
        recommended_action:
          "Request signed workover AFE, daily drilling report, and completion certificate from " +
          "operator. Require post-workover gauge tickets to verify claimed production improvement.",
        auto_suppresses_economics: false,
      });
    }
  }

  // ── 6. County mismatch ────────────────────────────────────────────────────
  //
  // User-provided county doesn't match the county TRRC resolved to. This usually
  // means the API was mistyped or the wrong well was looked up.
  {
    const inputCounty = ctx.inputCounty?.toLowerCase().replace(/\s+county$/i, "").trim();
    const trrcCounty  = ctx.trrcResolvedCounty?.toLowerCase().replace(/\s+county$/i, "").trim();

    if (inputCounty && trrcCounty && inputCounty !== trrcCounty) {
      out.push({
        id: id(),
        severity: "critical",
        field: "County",
        description:
          `User provided county "${ctx.inputCounty}" but TRRC resolved the API to ` +
          `${ctx.trrcResolvedCounty} County. The API number may belong to a different well.`,
        source_a:   "User input",
        value_a:    ctx.inputCounty,
        source_b:   "TRRC wellbore query",
        value_b:    ctx.trrcResolvedCounty,
        recommended_action:
          "Verify the API number is correct. Check that the county code (digits 3–5 of the " +
          "10-digit API) matches the expected county. A county mismatch means production data " +
          "is from the wrong well.",
        auto_suppresses_economics: true,
      });
    }
  }

  // ── 7. Open violations + active acquisition ───────────────────────────────
  //
  // Open TRRC violations are a title risk — the state can block a transfer until
  // violations are cured.  Flag when we have production data but open violations.
  {
    if (ctx.openViolationCount > 0 && ctx.trrcStabilizedRateBbl != null) {
      out.push({
        id: id(),
        severity: ctx.openViolationCount >= 3 ? "critical" : "important",
        field: "Open TRRC Violations",
        description:
          `${ctx.openViolationCount} open TRRC violation(s) on record. Open violations ` +
          `must be cured before RRC will approve an operator transfer — they represent a ` +
          `title and closing risk that is not reflected in the production economics.`,
        source_a:   "TRRC violation database",
        value_a:    ctx.openViolationCount,
        source_b:   "Acquisition intent",
        value_b:    "Transfer requires clean compliance status",
        recommended_action:
          `Request cure plan and estimated cost for all ${ctx.openViolationCount} open violation(s). ` +
          "Require seller to resolve all violations before closing or escrow cure costs at closing.",
        auto_suppresses_economics: false,
      });
    }
  }

  return out;
}

// ─── Build context from report-builder inputs ─────────────────────────────────

/**
 * Convenience function — constructs a ContradictionContext from the standard
 * inputs available in buildDDReport(), so the caller doesn't have to manually
 * assemble the context object.
 */
export function buildContradictionContext(args: {
  extracted:                 DocumentExtractionResult | null;
  trrcOperatorName:          string | null;
  trrcResolvedLeaseNo:       string | null;
  userProvidedLeaseNos:      string[];
  userProvidedApis:          string[];
  trrcResolvedApis:          string[];
  trrcStabilizedRateBbl:     number | null;
  trrcLatestProductionMonth: string | null;
  trrcConsecutiveZeroMonthsAtEnd: number;
  sellerClaimsWorkover:      boolean;
  trrcCompletionFound:       boolean;
  sellerClaimedMonthlyBbl:   number | null;
  openViolationCount:        number;
  inputCounty:               string | null;
  trrcResolvedCounty:        string | null;
  trrcWellboreStatusActive:  boolean | null;
}): ContradictionContext {
  return args;
}
