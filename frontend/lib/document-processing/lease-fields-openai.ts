/**
 * Stage D: OpenAI JSON structuring from normalized document text.
 */

import OpenAI from "openai";
import { cleanExtractedDocumentText } from "./extracted-text-quality";
import type { DocumentCategory } from "./document-classification";
import {
  normalizeParsedLeaseResult,
  type ParsedLeaseResult,
} from "./parsed-lease-result";

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(
  value: unknown,
  stepName: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(
      `${stepName}: expected a string but got ${describeValue(value)}.`,
    );
  }
}

function assertPlainObject(
  value: unknown,
  stepName: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(
      `${stepName}: expected a plain object but got ${describeValue(value)}.`,
    );
  }
}

const LEASE_PARSE_SYSTEM = `You are a parser for mineral lease and deed documents. Given extracted text from a document, output a JSON object with exactly these keys (use null for any value you cannot find):
- grantor (string or null): party granting / conveying (use when the instrument says Grantor or is a deed; for a lease you may use the lessor here too, or null if only Lessor is labeled)
- grantee (string or null): party receiving the interest (Grantee on deeds/assignments; may match Lessee on leases)
- lessor (string or null): party granting the lease / mineral rights (Lessor in a lease)
- lessee (string or null): party receiving the lease / mineral rights (Lessee in a lease)
- county (string or null): county name
- state (string or null): state name or abbreviation
- legal_description (string or null): legal land description
- effective_date (string or null): effective date of the lease (any clear date format)
- recording_date (string or null): date recorded
- royalty_rate (string or null): royalty percentage or fraction, e.g. "1/8" or "12.5%"
- term_length (string or null): primary term or duration
- mailing_address (string or null): owner or notice mailing block when clearly present
- document_type (string or null): the kind of instrument, e.g. "Mineral Deed", "Assignment of Oil and Gas Lease", "Oil and Gas Lease" — use null if unclear
- confidence_score (number): your confidence in the overall extraction, between 0 and 1 (e.g. 0.85).

When the text has explicit headings such as "Grantor", "GRANTOR:", "Grantee", or "GRANTEE:", copy those names into grantor and grantee (not into lessor/lessee unless the document is clearly a lease using Lessor/Lessee labels).

The text may be from OCR or a weak PDF text layer: skip isolated garbage lines, infer words split across line breaks, and handle common OCR confusions (0 vs O, 1 vs l vs I, rn vs m) when resolving names, counties, states, and legal descriptions.

Return only valid JSON, no markdown or extra text.`;

function systemPromptForCategory(category: DocumentCategory | undefined): string {
  if (!category) return LEASE_PARSE_SYSTEM;
  const hints: Record<DocumentCategory, string> = {
    mineral_deed:
      "Classifier: mineral_deed — prioritize Grantor/Grantee, legal description, and recording/effective dates; royalty only if clearly stated.",
    oil_gas_lease:
      "Classifier: oil_gas_lease — prioritize Lessor/Lessee, royalty rate, primary term, and lease dates.",
    assignment:
      "Classifier: assignment — prioritize assignor/assignee (or grantor/grantee), subject lease references, and effective date.",
    division_order:
      "Classifier: division_order — prioritize interest owners, decimals/NRI, payee lines, and well/unit references; lease-style term fields may be absent.",
    other:
      "Classifier: other — extract whatever parties and land references exist; document_type may be nonstandard.",
  };
  return `${LEASE_PARSE_SYSTEM}\n\n${hints[category]}`;
}

export function safeParseJsonObject(
  content: string,
  stepName: string,
): Record<string, unknown> {
  assertString(content, stepName);
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Parsed JSON was not an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = content.slice(start, end + 1);
      const parsed2 = JSON.parse(sliced) as unknown;
      if (
        parsed2 == null ||
        typeof parsed2 !== "object" ||
        Array.isArray(parsed2)
      ) {
        throw new Error("Sliced JSON was not an object.");
      }
      return parsed2 as Record<string, unknown>;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${stepName}: OpenAI response was not valid JSON: ${message}`,
    );
  }
}

export type OpenAiLeaseParseOptions = {
  model?: string;
  maxChars?: number;
  /** Pre-extraction category so the model emphasizes the right fields. */
  documentCategory?: DocumentCategory;
};

/**
 * Calls OpenAI and returns structured fields (before merge with heuristics).
 * On failure (missing key, transport errors, malformed JSON, etc.), logs and returns an empty-normalized result.
 */
export async function parseLeaseFieldsWithOpenAi(
  extractedText: string,
  options?: OpenAiLeaseParseOptions,
): Promise<ParsedLeaseResult> {
  try {
    assertString(extractedText, "OPENAI_CALL_START");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const msg = "OPENAI_API_KEY is not set; cannot parse lease fields.";
      console.error("[parseLeaseFieldsWithOpenAi]", msg);
      throw new Error(`OPENAI_CALL_START: ${msg}`);
    }
    const trimmedInput = extractedText.trim();
    const normalizedForModel =
      trimmedInput.length === 0
        ? ""
        : (() => {
            const cleaned = cleanExtractedDocumentText(extractedText);
            return cleaned.length > 0 ? cleaned : trimmedInput;
          })();

    if (normalizedForModel === "") {
      return normalizeParsedLeaseResult(
        {
          lessor: null,
          lessee: null,
          grantor: null,
          grantee: null,
          county: null,
          state: null,
          legal_description: null,
          effective_date: null,
          recording_date: null,
          royalty_rate: null,
          term_length: null,
          mailing_address: null,
          document_type: null,
          confidence_score: 0,
        },
        "",
      );
    }

    const model = options?.model ?? "gpt-4o-mini";
    const maxChars = options?.maxChars ?? 12000;
    const systemPrompt = systemPromptForCategory(options?.documentCategory);
    const client = new OpenAI({ apiKey });

    let completion: unknown;
    try {
      completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Extract lease fields from this document text:\n\n${normalizedForModel.slice(0, maxChars)}`,
          },
        ],
        response_format: { type: "json_object" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`OPENAI_CALL_START: OpenAI request failed: ${msg}`);
    }

    assertPlainObject(completion, "OPENAI_CALL_START");

    const choices: unknown = (completion as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error(
        `OPENAI_CALL_START: OpenAI returned no choices (got ${describeValue(choices)}).`,
      );
    }

    const firstChoice = choices[0] as unknown;
    assertPlainObject(firstChoice, "OPENAI_CALL_START");

    const message = (firstChoice as { message?: unknown }).message;
    const contentValue = isPlainObject(message)
      ? (message as { content?: unknown }).content
      : undefined;
    const content =
      typeof contentValue === "string" ? contentValue.trim() : undefined;
    if (!content) {
      const msg = "OpenAI returned no content in completion choices.";
      console.error("[parseLeaseFieldsWithOpenAi]", msg, {
        choicesLength: Array.isArray(choices) ? choices.length : 0,
        finishReason: isPlainObject(firstChoice)
          ? (firstChoice as { finish_reason?: unknown }).finish_reason
          : undefined,
      });
      throw new Error(msg);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = safeParseJsonObject(content, "OPENAI_CALL_START");
    } catch (parseErr) {
      const msg =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.error(
        "[parseLeaseFieldsWithOpenAi] Invalid/malformed JSON in OpenAI response",
        {
          error: msg,
          contentPreview: content.slice(0, 300),
        },
      );
      throw parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    }

    const num = (v: unknown): number => {
      if (typeof v === "number" && v >= 0 && v <= 1) return v;
      if (typeof v === "string") {
        const n = parseFloat(v);
        if (!Number.isNaN(n) && n >= 0 && n <= 1) return n;
      }
      return 0;
    };
    const llmConf = num(parsed.confidence_score);
    const confFloored =
      normalizedForModel.trim().length >= 15
        ? Math.max(0.25, llmConf)
        : llmConf;
    const str = (v: unknown): string | null =>
      v != null && typeof v === "string" && v.trim() !== "" ? v.trim() : null;

    return normalizeParsedLeaseResult(
      {
        lessor: str(parsed.lessor),
        lessee: str(parsed.lessee),
        grantor: str(parsed.grantor),
        grantee: str(parsed.grantee),
        county: str(parsed.county),
        state: str(parsed.state),
        legal_description: str(parsed.legal_description),
        effective_date: str(parsed.effective_date),
        recording_date: str(parsed.recording_date),
        royalty_rate: str(parsed.royalty_rate),
        term_length: str(parsed.term_length),
        mailing_address: str(parsed.mailing_address),
        document_type: str(parsed.document_type),
        confidence_score: confFloored,
      },
      normalizedForModel,
    );
  } catch (err) {
    console.error("[extract] OPENAI_FAILED", err);
    return normalizeParsedLeaseResult(
      {
        lessor: null,
        lessee: null,
        grantor: null,
        grantee: null,
        county: null,
        state: null,
        legal_description: null,
        effective_date: null,
        recording_date: null,
        royalty_rate: null,
        term_length: null,
        mailing_address: null,
        document_type: null,
        confidence_score: 0,
      },
      typeof extractedText === "string" ? extractedText : "",
    );
  }
}
