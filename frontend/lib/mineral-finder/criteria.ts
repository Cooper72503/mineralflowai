import { z } from "zod";
import type { Criteria } from "./types";

export const CriteriaSchema = z
  .object({
    county: z.enum(["GAINES", "FISHER"]),
    beforeYear: z
      .number()
      .int()
      .min(1850)
      .max(new Date().getUTCFullYear() + 1),
    radiusMiles: z.number().finite().min(0.25).max(10),
    limit: z.number().int().min(1).max(25),
    statuses: z
      .array(z.enum(["plugged", "shut_in", "producing", "dry", "unknown"]))
      .min(1)
      .max(5),
    marginalBopd: z.number().finite().positive().max(100).nullable(),
  })
  .strict();

/** A bounded, disclosed command parser. Never asks a model to invent a query. */
export function parseFinderRequest(
  query: string,
  overrides: Partial<Criteria> = {},
): Criteria {
  if (query.length > 2000)
    throw Error("Keep the research request under 2,000 characters.");
  if (/\b(?:statewide|all\s+(?:of\s+)?texas|lower\s+48)\b/i.test(query))
    throw Error(
      "This pilot runs one county at a time: Gaines or Fisher, Texas.",
    );
  const counties = [
    ...query.toUpperCase().matchAll(/\b(GAINES|FISHER)\b/g),
  ].map((m) => m[1]);
  for (const m of query.matchAll(/\b([A-Za-z]+)\s+County\b/gi))
    if (!["GAINES", "FISHER"].includes(m[1].toUpperCase()))
      throw Error("This pilot supports Gaines and Fisher counties, Texas.");
  if (new Set(counties).size > 1) throw Error("Run one county at a time.");
  if (
    /\b(?:midland|martin|howard|reeves|louisiana|oklahoma|new mexico)\b/i.test(
      query,
    )
  )
    throw Error("This pilot supports Gaines and Fisher counties, Texas.");
  const before = query.match(/\bbefore\s+(\d{4})\b/i);
  const radius = query.match(
    /\b(?:within|radius(?:\s+of)?)\s+(\d+(?:\.\d+)?)\s*miles?\b/i,
  );
  const max = query.match(/\b(?:top|up to)\s+(\d+)\b/i);
  const marginal = query.match(
    /\b(?:below|under|less than)\s+(\d+(?:\.\d+)?)\s*(?:bopd|bbl\/day|barrels?\s*(?:per|a)\s*day)/i,
  );
  return CriteriaSchema.parse({
    county: counties[0] ?? "GAINES",
    beforeYear: before ? +before[1] : 1995,
    radiusMiles: radius ? +radius[1] : 3,
    limit: max ? +max[1] : 25,
    statuses: ["plugged", "shut_in"],
    marginalBopd: marginal ? +marginal[1] : null,
    ...overrides,
  });
}
