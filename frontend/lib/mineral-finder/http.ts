/** Bounded requests; per-attempt timeout, retryable transport/429/5xx only. */
export async function request(
  url: string,
  init: RequestInit = {},
  fetcher = fetch,
  timeoutMs = 45_000,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const response = await fetcher(url, {
        ...init,
        signal,
        headers: {
          "User-Agent": "MineralFlow-MineralFinder/1.0",
          ...init.headers,
        },
      });
      if (response.ok) return response;
      const retry = response.status === 429 || response.status >= 500;
      await response.body?.cancel();
      const error = Error(
        `HTTP ${response.status} from ${new URL(url).hostname}`,
      );
      if (!retry) throw Object.assign(error, { permanent: true });
      last = error;
    } catch (error) {
      if (init.signal?.aborted || (error as { permanent?: boolean }).permanent)
        throw error;
      last = error;
    }
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
  }
  throw last;
}

export async function jsonRequest(
  url: string,
  signal?: AbortSignal,
  fetcher = fetch,
): Promise<any> {
  const response = await request(url, { signal }, fetcher);
  const body = await response.json();
  if (body.error)
    throw Error(
      `Source API error: ${body.error.message ?? JSON.stringify(body.error)}`,
    );
  return body;
}

/** Keyset pagination prevents duplicate pages and detects ignored cursors/caps. */
export async function arcgisRows(
  base: string,
  where: string,
  key: string,
  fields: string,
  signal?: AbortSignal,
  fetcher = fetch,
  maxRows = 100_000,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: number | null = null;
  const countUrl = `${base}/query?${new URLSearchParams({ f: "json", where, returnCountOnly: "true" })}`;
  const count = (await jsonRequest(countUrl, signal, fetcher)).count;
  if (!Number.isInteger(count) || count < 0 || count > maxRows)
    throw Error(`Unbounded or invalid source count: ${count}`);
  while (rows.length < count) {
    const q = new URLSearchParams({
      f: "json",
      where: cursor === null ? where : `(${where}) AND ${key}>${cursor}`,
      outFields: fields,
      returnGeometry: "false",
      orderByFields: `${key} ASC`,
      resultRecordCount: "1000",
    });
    const body = await jsonRequest(`${base}/query?${q}`, signal, fetcher);
    if (!Array.isArray(body.features) || !body.features.length)
      throw Error("Source pagination ended before the advertised count.");
    for (const feature of body.features) {
      const row = feature.attributes;
      const id = Number(row?.[key]);
      if (!Number.isFinite(id) || (cursor !== null && id <= cursor))
        throw Error("Source returned duplicate or unordered pagination keys.");
      rows.push(row);
      cursor = id;
    }
    if (rows.length > maxRows)
      throw Error("Source exceeded the ingestion safety limit.");
    if (body.exceededTransferLimit === false && rows.length < count)
      throw Error("Source changed during pagination; retry the snapshot.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (rows.length !== count)
    throw Error("Source count changed during ingestion; retry the snapshot.");
  return rows;
}
