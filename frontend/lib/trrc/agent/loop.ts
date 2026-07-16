/**
 * TRRC Public Records Investigator — agentic loop.
 *
 * Drives the claude-fable-5 agent through its investigation, streaming progress
 * events for each tool call and returning the completed TrrcAgentContext when done.
 */

import Anthropic from "@anthropic-ai/sdk";
import { TRRC_AGENT_SYSTEM_PROMPT } from "./system-prompt";
import { TRRC_AGENT_TOOLS } from "./tool-definitions";
import { handleTrrcToolCall, makeEmptyTrrcAgentContext } from "./tool-handlers";
import type { TrrcAgentContext } from "./tool-handlers";

const MAX_TOOL_CALLS = 50;

// ─── Event types ──────────────────────────────────────────────────────────────

export type TrrcAgentProgressEvent = {
  type: "tool_call";
  tool: string;
  summary: string;
};

export type TrrcAgentDoneEvent = {
  type: "done";
  ctx: TrrcAgentContext;
};

export type TrrcAgentErrorEvent = {
  type: "error";
  message: string;
};

export type TrrcAgentEvent =
  | TrrcAgentProgressEvent
  | TrrcAgentDoneEvent
  | TrrcAgentErrorEvent;

// ─── Main loop ────────────────────────────────────────────────────────────────

/**
 * Run the full TRRC agentic investigation.
 *
 * @param input - Raw user input and pre-resolved entities from the DB
 * @param onEvent - Callback for streaming tool_call progress, done, and error events
 * @returns Completed TrrcAgentContext with all collected data and the agent's report
 */
export async function runTrrcAgentLoop(
  input: {
    raw_input: string;
    input_type: string;
    resolved_entities: Array<{
      entity_type: string;
      canonical_identifier: string;
      display_name: string;
      attributes: Record<string, unknown>;
    }>;
  },
  onEvent: (event: TrrcAgentEvent) => void,
): Promise<TrrcAgentContext> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const ctx = makeEmptyTrrcAgentContext();

  // Pre-seed context from resolved entities so the agent starts with known identifiers
  for (const entity of input.resolved_entities) {
    if (entity.entity_type === "wellbore") {
      const api = entity.canonical_identifier;
      if (api && !ctx.api_numbers.includes(api)) ctx.api_numbers.push(api);
      if (!ctx.district && entity.attributes["district"]) {
        ctx.district = String(entity.attributes["district"]);
      }
    } else if (entity.entity_type === "lease") {
      if (!ctx.lease_number && entity.attributes["lease_number"]) {
        ctx.lease_number = String(entity.attributes["lease_number"]);
      }
      if (!ctx.district && entity.attributes["district"]) {
        ctx.district = String(entity.attributes["district"]);
      }
    } else if (entity.entity_type === "operator") {
      if (!ctx.operator_name && entity.attributes["normalized_name"]) {
        ctx.operator_name = String(entity.attributes["normalized_name"]);
      }
      if (!ctx.operator_number && entity.attributes["operator_number"]) {
        ctx.operator_number = String(entity.attributes["operator_number"]);
      }
    }
  }

  const userMessage = buildInitialMessage(input);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let toolCallCount = 0;

  while (toolCallCount < MAX_TOOL_CALLS) {
    const response = await anthropic.messages.create({
      model: "claude-fable-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: TRRC_AGENT_SYSTEM_PROMPT,
      tools: TRRC_AGENT_TOOLS,
      messages,
    });

    // Add assistant turn to message history
    messages.push({ role: "assistant", content: response.content });

    // Pull out tool use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // If no tool calls and stop_reason is end_turn, Claude is done without submitting
    if (toolUseBlocks.length === 0) break;

    // Process each tool call
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      toolCallCount++;

      const result = await handleTrrcToolCall(
        block.name,
        block.input as Record<string, unknown>,
        ctx,
      );

      onEvent({ type: "tool_call", tool: block.name, summary: result.summary });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result.data),
      });

      // If submit_report was called and succeeded, we're done
      if (block.name === "submit_report" && result.ok) {
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

  // If we got here without submit_report, loop exhausted or Claude stopped early
  if (!ctx.agentReport) {
    onEvent({
      type: "error",
      message: `Agent completed ${toolCallCount} tool calls but did not submit a report. Partial data may be available.`,
    });
  } else {
    onEvent({ type: "done", ctx });
  }

  return ctx;
}

// ─── Initial message builder ──────────────────────────────────────────────────

function buildInitialMessage(input: {
  raw_input: string;
  input_type: string;
  resolved_entities: Array<{
    entity_type: string;
    canonical_identifier: string;
    display_name: string;
    attributes: Record<string, unknown>;
  }>;
}): string {
  const parts: string[] = [
    "Please conduct a complete TRRC public records due diligence investigation on the following input.",
    "",
    `## Raw Input`,
    `"${input.raw_input}"`,
    `Input Type: ${input.input_type.replace(/_/g, " ").toUpperCase()}`,
    "",
  ];

  if (input.resolved_entities.length > 0) {
    parts.push("## Pre-Resolved Entities");
    parts.push("The entity resolver has already identified the following candidates:");
    parts.push("");
    for (const entity of input.resolved_entities) {
      parts.push(`- **${entity.display_name}** (${entity.entity_type})`);
      parts.push(`  Canonical ID: ${entity.canonical_identifier}`);
      const attrs = Object.entries(entity.attributes)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      if (attrs) parts.push(`  Attributes: ${attrs}`);
    }
    parts.push("");
  }

  parts.push(
    "## Investigation instructions",
    "1. Begin by confirming the identity of this asset using the appropriate search tool.",
    "2. Fetch production data from TRRC directly — do NOT rely on any pre-stated production figures.",
    "3. Check well status, plugging records, and inactive well lists for liability exposure.",
    "4. Fetch compliance violations and inspection records for the operator.",
    "5. Cover all applicable data sources — document any you cannot query and why.",
    "6. When your investigation is complete, call submit_report with your full synthesis.",
    "",
    "Begin your investigation now.",
  );

  return parts.join("\n");
}
