// Copies pdfjs-dist's browser worker into public/ so the run-statement reader
// loads it as a static file. Bundling it fails: Next 14's minifier cannot
// parse pdfjs 4's worker module. Runs before `dev` and `build`.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const source = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build", "pdf.worker.min.mjs");
mkdirSync("public", { recursive: true });
copyFileSync(source, path.join("public", "pdf.worker.min.mjs"));
