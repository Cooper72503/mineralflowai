// Build once from the existing frontend engines. Deploy the resulting artifact
// with worker/dist; the droplet never needs a separate implementation of GOLD.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../frontend/package.json',import.meta.url));
const {build}=require('esbuild');
await build({entryPoints:[fileURLToPath(new URL('../../frontend/lib/trrc/portfolio/package-engine.ts',import.meta.url))],outfile:fileURLToPath(new URL('../dist/report-engine.mjs',import.meta.url)),bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'info'});
