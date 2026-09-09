/** Operational persistence failures must stop completion, not become source gaps. */
export class PipelinePersistenceError extends Error {}

export async function checkedQuery<T extends { error?: { message: string } | null }>(query: PromiseLike<T>, context: string): Promise<T> {
  const result = await query;
  if (result.error) throw new PipelinePersistenceError(`${context}: ${result.error.message}`);
  return result;
}
