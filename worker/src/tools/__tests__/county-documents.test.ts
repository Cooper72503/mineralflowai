import { describe, it, expect, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { getBrowser } from "../browser.js";
import { getCountyDocument, validatePreviewUrl } from "../county-documents.js";
vi.mock("../browser.js", () => ({ getBrowser: vi.fn() }));
const source = "https://midland.tx.publicsearch.us/doc/39265019";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
function browserFixture(failPage = 0) {
 let current = 1;
 const close = vi.fn();
 const response = { ok: () => current !== failPage, status: () => 403, body: async () => png, dispose: vi.fn() };
 const page = { url: () => source, goto: vi.fn(), waitForFunction: vi.fn(),
  locator: (selector: string) => selector.includes("input") ? { waitFor: vi.fn(), getAttribute: async () => "3" } : { evaluate: async () => `${source.replace("/doc/", "/files/documents/")}/images/page_${current}.png?sig=private` },
  getByRole: () => ({ click: async () => { current++; } }),
 };
 const request = { get: vi.fn(async () => response) };
 vi.mocked(getBrowser).mockResolvedValue({ newContext: async () => ({ newPage: async () => page, request, close }) } as never);
 return { close, request };
}
describe("public county document retrieval", () => {
 it("keeps all preview pages together in one PDF", async () => {
  const f = browserFixture(); const result = await getCountyDocument(source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(3);
  expect(result.sourceUrl).toBe(source); expect(f.request.get).toHaveBeenCalledTimes(3); expect(f.close).toHaveBeenCalledOnce();
 });
 it("does not return a partial document when a later page is inaccessible", async () => {
  const f = browserFixture(2); const result = await getCountyDocument(source);
  expect(result).toEqual({ ok: false, error: "County preview request returned HTTP 403" });
  expect(f.close).toHaveBeenCalledOnce();
 });
 it.each(["http://127.0.0.1/a", "https://evil.example/a", "https://midland.tx.publicsearch.us/files/documents/999/images/a.png"])("rejects foreign image destinations %s", url => {
  expect(() => validatePreviewUrl(url, source)).toThrow();
 });
 it("rejects unsupported source URLs before launching a browser", async () => {
  vi.mocked(getBrowser).mockClear();
  expect((await getCountyDocument("http://localhost/doc/1")).ok).toBe(false);
  expect(getBrowser).not.toHaveBeenCalled();
 });
});
