/**
 * Read every row of a query, page by page.
 *
 * PostgREST returns at most 1,000 rows per request unless paged, and says
 * nothing when it truncates. Live case: the Buttercup title job held 1,317
 * party rows; analysis read 1,000, so the most recently written parties —
 * the ones just corrected — vanished and their events rendered "— → —".
 * Every bulk read of title rows goes through this, ordered by id so pages
 * are stable.
 */
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export const PAGE_SIZE = 1000;

export async function selectAll<T>(page: (from: number, to: number) => Page<T>): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { data: rows, error: null };
  }
}
