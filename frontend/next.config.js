/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Prevent Next from bundling these packages into the route handler.
    // Bundling the ESM `.mjs` builds can crash at runtime inside the app route
    // (e.g. `Object.defineProperty called on non-object` from webpack interop).
    serverComponentsExternalPackages: [
      "pdf-parse",
      "tesseract.js",
      "pdfjs-dist",
      "@napi-rs/canvas",
    ],
    // The GOLD/GOLD2 PDF renderers (lib/trrc/gold/pdf.ts, gold2/pdf.ts)
    // register Nimbus Sans from local .otf files resolved via
    // process.cwd(). Next's output file tracing can't follow a runtime
    // path.join(), so without this the fonts are missing from the
    // serverless bundle and @react-pdf/renderer fails at render time.
    outputFileTracingIncludes: {
      "/api/trrc/due-diligence/[runId]/report": ["./lib/trrc/gold/fonts/**/*"],
    },
  },
};

module.exports = nextConfig;
