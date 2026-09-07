/**
 * Batch API-number input parsing for the title-chain workflow.
 *
 * Accepts one API number or a pasted batch separated by spaces, commas,
 * semicolons, or line breaks. Reuses normalizeApiNumber() (the validator
 * the rest of the app already trusts) for the state/county/well core, and
 * additionally preserves what that helper drops: a 12/14-digit input's
 * sidetrack and completion suffixes. Two inputs that differ only in
 * suffix are two distinct wellbores and are NOT deduplicated together;
 * two inputs that normalize to the same 14-digit identity are.
 *
 * Every input gets an individual result — an invalid entry never fails
 * the batch. Original text is preserved verbatim on each result.
 */

import { normalizeApiNumber } from "../normalization";
import { COUNTY_CODE_TO_NAME } from "./county-codes";

export interface ParsedApiInput {
  originalInput: string;
  ok: boolean;
  error: string | null;
  api10: string | null;
  api14: string | null;
  sidetrackSuffix: string | null;
  completionSuffix: string | null;
  stateCode: string | null;
  countyCode: string | null;
  countyName: string | null;
  formatted: string | null;
  /** true when an earlier input in the same batch normalized to the same api14 */
  duplicateOf: string | null;
}

export interface ParsedApiBatch {
  inputs: ParsedApiInput[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
}

export const MAX_APIS_PER_JOB = 50;

export function splitApiInputText(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export function parseApiInput(raw: string): ParsedApiInput {
  const originalInput = raw.trim();
  const base: ParsedApiInput = {
    originalInput, ok: false, error: null, api10: null, api14: null, sidetrackSuffix: null, completionSuffix: null,
    stateCode: null, countyCode: null, countyName: null, formatted: null, duplicateOf: null,
  };

  if (!originalInput) return { ...base, error: "Empty input." };
  if (!/^[\d\s-]+$/.test(originalInput)) {
    return { ...base, error: `"${originalInput}" contains characters that are not digits or dashes.` };
  }

  const digits = originalInput.replace(/\D/g, "");
  if (digits.length !== 8 && digits.length !== 10 && digits.length !== 12 && digits.length !== 14) {
    return { ...base, error: `"${originalInput}" has ${digits.length} digits — expected 8, 10, 12, or 14.` };
  }
  // Dashed input must have well-formed segments: [ccc-wwwww] or [42-ccc-wwwww] with optional [-ss[-cc]].
  // "42-165-027" is a truncated 10-digit number, not an 8-digit county+well form.
  if (originalInput.includes("-")) {
    const segs = originalInput.split("-").map(x => x.trim());
    const shape = segs.map(x => x.length).join(",");
    const ok = ["3,5", "2,3,5", "2,3,5,2", "2,3,5,2,2", "3,5,2", "3,5,2,2"].includes(shape);
    if (!ok) return { ...base, error: `"${originalInput}" has segment lengths ${shape} — expected 42-CCC-WWWWW with optional -SS-CC suffixes.` };
  }

  // Suffix preservation: the shared normalizer truncates to 10 digits, so
  // capture sidetrack/completion codes here before it does.
  let sidetrackSuffix: string | null = null;
  let completionSuffix: string | null = null;
  if (digits.length === 12) sidetrackSuffix = digits.slice(10, 12);
  if (digits.length === 14) { sidetrackSuffix = digits.slice(10, 12); completionSuffix = digits.slice(12, 14); }

  const normalized = normalizeApiNumber(originalInput);
  if (!normalized) {
    if (digits.length >= 10 && !digits.startsWith("42")) {
      return { ...base, error: `"${originalInput}" has state code ${digits.slice(0, 2)} — only Texas (42) is supported in this release.` };
    }
    return { ...base, error: `"${originalInput}" is not a valid Texas API number.` };
  }

  const countyName = COUNTY_CODE_TO_NAME[normalized.county_code] ?? null;
  if (!countyName) {
    return { ...base, error: `"${originalInput}" has county code ${normalized.county_code}, which is not a Texas county code.` };
  }

  const st = sidetrackSuffix ?? "00";
  const cp = completionSuffix ?? "00";
  const api14 = `${normalized.api10}${st}${cp}`;

  return {
    ...base,
    ok: true,
    api10: normalized.api10,
    api14,
    sidetrackSuffix,
    completionSuffix,
    stateCode: normalized.state_code,
    countyCode: normalized.county_code,
    countyName,
    formatted: `${normalized.state_code}-${normalized.county_code}-${normalized.well_code}-${st}-${cp}`,
  };
}

export function parseApiBatch(text: string | string[]): ParsedApiBatch {
  const tokens = Array.isArray(text) ? text.flatMap(splitApiInputText) : splitApiInputText(text);
  const seen = new Map<string, string>();
  const inputs: ParsedApiInput[] = [];
  let validCount = 0, invalidCount = 0, duplicateCount = 0;

  for (const token of tokens) {
    const parsed = parseApiInput(token);
    if (parsed.ok && parsed.api14) {
      const prior = seen.get(parsed.api14);
      if (prior) {
        duplicateCount++;
        inputs.push({ ...parsed, duplicateOf: prior });
        continue;
      }
      seen.set(parsed.api14, parsed.originalInput);
      validCount++;
    } else {
      invalidCount++;
    }
    inputs.push(parsed);
  }

  return { inputs, validCount, invalidCount, duplicateCount };
}
