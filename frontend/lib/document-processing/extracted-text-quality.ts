/**
 * Heuristic quality score (0–1) for PDF text-layer extraction vs image-based PDFs.
 * Used to trigger OCR when the embedded text layer looks unreliable.
 */

export type TextLayerQualityOptions = {
  /** From pdf-parse `numpages`; improves detection of nearly-empty multi-page PDFs. */
  numpages?: number;
};

/**
 * Returns approximate confidence that `text` is usable structured English/legal content
 * (not scrambled, fragmented, or empty relative to page count).
 */
export function estimateExtractedTextConfidence(
  text: string,
  options?: TextLayerQualityOptions
): number {
  const t = text.trim();
  if (!t) return 0;

  let score = 0.58;
  const len = t.length;

  let controlOrBinaryLike = 0;
  for (let i = 0; i < len; i++) {
    const c = t.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127 || (c > 127 && c < 160)) controlOrBinaryLike++;
  }
  const noiseRatio = controlOrBinaryLike / len;
  score -= Math.min(0.45, noiseRatio * 1.4);

  const alnum = (t.match(/[a-zA-Z0-9]/g) ?? []).length;
  const alnumRatio = alnum / len;
  score += (alnumRatio - 0.52) * 0.55;

  const words = t.split(/\s+/).filter((w) => w.length > 0);
  const alphaWords = words.filter((w) => /[a-zA-Z]/.test(w));
  const singleCharTokens = words.filter(
    (w) => w.length === 1 && /[a-zA-Z0-9]/.test(w)
  ).length;
  if (words.length > 15 && singleCharTokens / words.length > 0.14) {
    score -= 0.2;
  }

  if (alphaWords.length > 0) {
    const alphaChars = alphaWords.reduce(
      (s, w) => s + w.replace(/[^a-zA-Z]/g, "").length,
      0
    );
    const avgAlphaLen = alphaChars / alphaWords.length;
    if (avgAlphaLen < 2.4 && alphaWords.length > 12) score -= 0.14;
    if (avgAlphaLen >= 3.2) score += 0.08;
  }

  const lines = t.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > 6) {
    const tiny = lines.filter((l) => l.length <= 2).length;
    if (tiny / lines.length > 0.28) score -= 0.16;
  }

  const numpages = options?.numpages ?? 0;
  if (numpages >= 1) {
    const perPage = len / numpages;
    if (numpages >= 2 && perPage < 38) score -= 0.2;
    if (perPage < 18) score -= 0.12;
  }

  if (len < 100) score -= 0.08;
  if (len < 45) score -= 0.12;

  return Math.max(0, Math.min(1, score));
}

/**
 * Normalizes whitespace, removes obvious OCR/extraction noise lines, fixes common hyphenation breaks.
 */
export function cleanExtractedDocumentText(raw: string): string {
  if (!raw) return "";

  let t = raw.replace(/\uFEFF/g, "");
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  t = t.replace(/([a-zA-Z])-\n([a-zA-Z])/g, "$1$2");

  const lines = t.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    let s = line.replace(/[\t\u00A0]+/g, " ").replace(/[ ]{2,}/g, " ").trim();
    if (!s) continue;
    if (s.length <= 2 && !/[a-zA-Z0-9]/.test(s)) continue;
    if (s.length <= 4 && /^[^a-zA-Z0-9]*$/.test(s)) continue;
    const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
    const weird = (s.match(/[^\s\w.,;:%/()$&@#\-'"`]/g) ?? []).length;
    if (s.length >= 8 && letters / s.length < 0.12 && weird / s.length > 0.35) continue;
    kept.push(s);
  }

  let out = kept.join("\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
