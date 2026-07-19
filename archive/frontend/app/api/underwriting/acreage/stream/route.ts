/**
 * POST /api/underwriting/acreage/stream
 *
 * SSE streaming version of the acreage valuation endpoint.
 * Sends per-step progress events then a final "report" event.
 *
 * Event format: `data: <JSON>\n\n`
 * Types:
 *   { type: "progress", step: string, detail: string }
 *   { type: "report",   report: AcreageValuationReport }
 *   { type: "error",    message: string }
 */

import { NextRequest } from "next/server";
import { runAcreageValuation } from "@/lib/underwriting/offset-intelligence-engine";
import type { AcreageInput } from "@/lib/underwriting/types-acreage";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const maxDuration = 60;

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return new Response(sseEvent({ type: "error", message: "Not authenticated." }), {
      status: 401,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  let body: Partial<AcreageInput>;
  try {
    body = await req.json();
  } catch {
    return new Response(sseEvent({ type: "error", message: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const legal_description = (body.legal_description ?? "").trim();
  if (!legal_description || legal_description.length < 5) {
    return new Response(sseEvent({ type: "error", message: "legal_description is required (min 5 characters)" }), {
      status: 400,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const input: AcreageInput = {
    legal_description,
    county:         body.county         ?? null,
    state:          body.state          ?? null,
    acreage:        body.acreage        ?? null,
    nri:            body.nri            ?? null,
    operator_hint:  body.operator_hint  ?? null,
    formation_hint: body.formation_hint ?? null,
    ask_price_usd:  body.ask_price_usd  ?? null,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: object) => controller.enqueue(enc.encode(sseEvent(data)));

      try {
        const report = await runAcreageValuation(input, (event) => {
          send({ type: "progress", step: event.step, detail: event.detail });
        });
        send({ type: "report", report });
      } catch (err) {
        send({ type: "error", message: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}
