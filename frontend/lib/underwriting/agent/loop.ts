/**
 * Claude agentic loop — drives the due diligence investigation.
 *
 * Claude receives the document text + known identifiers, then decides
 * what to look up, calls TRRC tools, and submits findings when done.
 * Each tool call is streamed as a progress event so the UI stays live.
 */

import Anthropic                          from "@anthropic-ai/sdk";
import { AGENT_SYSTEM_PROMPT }            from "./system-prompt";
import { AGENT_TOOLS }                    from "./tool-definitions";
import { handleToolCall, makeEmptyContext } from "./tool-handlers";
import type { AgentContext }              from "./tool-handlers";
import type { UnderwritingInput }         from "@/lib/underwriting/types";

const MAX_TOOL_CALLS = 25;

export type AgentProgressEvent = {
  type: "tool_call";
  tool:    string;
  summary: string;
};

export type AgentDoneEvent = {
  type: "done";
  ctx:  AgentContext;
};

export type AgentErrorEvent = {
  type:    "error";
  message: string;
};

export type AgentEvent = AgentProgressEvent | AgentDoneEvent | AgentErrorEvent;

/**
 * Run the full agentic investigation.
 * Calls `onEvent` for every tool call and on completion.
 */
export async function runAgentLoop(
  input:   UnderwritingInput,
  onEvent: (event: AgentEvent) => void,
): Promise<AgentContext> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const ctx = makeEmptyContext();

  // Build the initial user message from all available inputs
  const userMessage = buildInitialMessage(input);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let toolCallCount = 0;

  while (toolCallCount < MAX_TOOL_CALLS) {
    const response = await anthropic.messages.create({
      model:      "claude-opus-4-8",
      max_tokens: 8192,
      thinking:   { type: "adaptive" },
      system:     AGENT_SYSTEM_PROMPT,
      tools:      AGENT_TOOLS,
      messages,
    });

    // Add assistant turn to message history
    messages.push({ role: "assistant", content: response.content });

    // Pull out tool use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // If no tool calls and stop_reason is end_turn, Claude is done without submitting — break
    if (toolUseBlocks.length === 0) break;

    // Process each tool call
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      toolCallCount++;

      const result = await handleToolCall(
        block.name,
        block.input as Record<string, unknown>,
        ctx,
      );

      onEvent({ type: "tool_call", tool: block.name, summary: result.summary });

      toolResults.push({
        type:        "tool_result",
        tool_use_id: block.id,
        content:     JSON.stringify(result.data),
      });

      // If submit_report was called, we're done
      if (block.name === "submit_report" && result.ok) {
        // Add tool results to messages and exit
        messages.push({ role: "user", content: toolResults });
        onEvent({ type: "done", ctx });
        return ctx;
      }
    }

    // Add tool results and continue loop
    messages.push({ role: "user", content: toolResults });

    // Stop if natural end
    if (response.stop_reason === "end_turn") break;
  }

  // If we got here without submit_report, either loop exhausted or Claude stopped early
  if (!ctx.agentAssessment) {
    onEvent({
      type: "error",
      message: `Agent completed ${toolCallCount} tool calls but did not submit a report. Partial data may be available.`,
    });
  } else {
    onEvent({ type: "done", ctx });
  }

  return ctx;
}

// ── Build the initial user message ────────────────────────────────────────────

function buildInitialMessage(input: UnderwritingInput): string {
  const parts: string[] = [
    "Please conduct a complete due diligence investigation on the following mineral rights acquisition.",
    "",
  ];

  // Known identifiers
  if (input.api_numbers?.length)      parts.push(`API Numbers provided by seller: ${input.api_numbers.join(", ")}`);
  if (input.rrc_lease_numbers?.length) parts.push(`RRC Lease Numbers: ${input.rrc_lease_numbers.join(", ")}`);
  if (input.operator_name)            parts.push(`Operator: ${input.operator_name}`);
  if (input.lease_name)               parts.push(`Lease Name: ${input.lease_name}`);
  if (input.county)                   parts.push(`County: ${input.county}`);
  if (input.state)                    parts.push(`State: ${input.state}`);
  if (input.nri_decimal)              parts.push(`NRI: ${(input.nri_decimal * 100).toFixed(4)}%`);
  if (input.wi_decimal)               parts.push(`WI: ${(input.wi_decimal * 100).toFixed(4)}%`);

  parts.push("");

  // Document text
  if (input.documents?.length) {
    parts.push("## Acquisition Documents");
    parts.push("");
    for (const doc of input.documents) {
      parts.push(`### ${doc.filename}${doc.doc_type ? ` (${doc.doc_type})` : ""}`);
      parts.push(doc.text.slice(0, 12000)); // cap per-doc to avoid token overflow
      parts.push("");
    }
  }

  parts.push(
    "Start your investigation. Remember:",
    "1. Verify any API numbers before using them.",
    "2. Pull production from TRRC by lease number — do NOT use seller's stated production figures.",
    "3. Check the actual well count — never trust the seller's description.",
    "4. Run compliance check — empty result does NOT mean clean.",
    "5. Cross-check every seller claim against what TRRC shows.",
    "6. Call submit_report when you have completed your investigation.",
  );

  return parts.join("\n");
}
