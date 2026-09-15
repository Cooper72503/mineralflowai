import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry } from "../ewa.js";

const ok = (status = 200) => ({ status, ok: status < 400, text: async () => "", json: async () => ({}) }) as unknown as Response;
const noSleep = async () => {};

describe("fetchWithRetry — bounded retry for TRRC transport failures", () => {
  it("retries undici's `fetch failed` and succeeds on a later attempt", async () => {
    const f = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok());
    const res = await fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("retries a 5xx and returns the eventual 2xx", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(500)).mockResolvedValueOnce(ok(200));
    const res = await fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 4xx — a real answer, not a dropped request", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(404));
    const res = await fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: noSleep });
    expect(res.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-transport error", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("Invalid API number format"));
    await expect(fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: noSleep })).rejects.toThrow("Invalid API number format");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after the bounded attempt count and rethrows the original error", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: noSleep, attempts: 3 })).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("returns the final 5xx response (not a throw) when every attempt is 5xx, so callers record failed_transient as before", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(ok(500));
    const res = await fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: noSleep, attempts: 3 });
    expect(res.status).toBe(500);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    const f = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
    await fetchWithRetry("https://x/a", {}, { fetchImpl: f, sleep: async ms => { delays.push(ms); }, baseDelayMs: 100 });
    expect(delays).toEqual([100, 200]);
  });
});
