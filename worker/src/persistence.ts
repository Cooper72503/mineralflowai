/** Operational persistence failures must stop completion, not become source gaps. */
export class PipelinePersistenceError extends Error {}
/** A source outage stopped the run before the well could be identified; the run should be retried, not completed. */
export class TransientRetrievalError extends Error {}

/**
 * A database or network interruption, not a fact about the well: the work
 * should be retried, never recorded as failed. Live 2026-10-04: five of a
 * twelve-well package failed permanently on "upstream request timeout" while
 * the Supabase instance was unreachable, and a package was marked failed
 * after four quick attempts during the same outage.
 */
const TRANSIENT_INFRASTRUCTURE = /upstream request timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|Connection terminated|connection timeout|canceling statement due to statement timeout|<!DOCTYPE html>|\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b|\bHTTP (?:502|503|504|52[0-4])\b|\berror code:? 52[0-4]\b/i;
export function isTransientInfrastructureError(err: unknown): boolean {
  if (err instanceof TransientRetrievalError) return false;
  const message = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return TRANSIENT_INFRASTRUCTURE.test(message);
}

export async function checkedQuery<T extends { error?: { message: string } | null }>(query: PromiseLike<T>, context: string): Promise<T> {
  const result = await query;
  if (result.error) throw new PipelinePersistenceError(`${context}: ${result.error.message}`);
  return result;
}
