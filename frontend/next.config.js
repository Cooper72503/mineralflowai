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
      // Title-document text extraction loads three things by RUNTIME path,
      // which Next's output file tracing cannot follow, so they must be
      // named here or the serverless bundle ships without them. Live
      // failure on 2026-09-22: all six retrieved Midland deeds returned
      // `OCR failed: Setting up fake worker failed: "Cannot find module
      // '/var/task/frontend/node_modules/pdfjs-dist/legacy/build/
      // pdf.worker.mjs'"` — pdf.mjs was traced (static import), its worker
      // was not (dynamic). tesseract.js loads its node worker script and
      // its wasm core the same way.
      "/api/trrc/title-chain/[jobId]/ingest": [
        "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
        "./node_modules/tesseract.js/src/worker-script/**/*",
        "./node_modules/tesseract.js-core/**/*",
      ],
    },
  },
};

module.exports = nextConfig;
