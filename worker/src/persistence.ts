/** Operational persistence failures must stop completion, not become source gaps. */
export class PipelinePersistenceError extends Error {}
/** A source outage stopped the run before the well could be identified; the run should be retried, not completed. */
export class TransientRetrievalError extends Error {}

export async function checkedQuery<T extends { error?: { message: string } | null }>(query: PromiseLike<T>, context: string): Promise<T> {
  const result = await query;
  if (result.error) throw new PipelinePersistenceError(`${context}: ${result.error.message}`);
  return result;
}
