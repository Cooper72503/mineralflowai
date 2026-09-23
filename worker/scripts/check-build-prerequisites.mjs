import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const missing = [];
for (const relative of ['../../frontend/package-lock.json', '../package-lock.json', '../../frontend/lib/trrc/portfolio/package-engine.ts']) {
  if (!existsSync(new URL(relative, import.meta.url))) missing.push(`Full repository file: ${relative}`);
}
for (const [manifest, modules] of [
  ['../package.json', ['typescript', 'pdf-lib']],
  ['../../frontend/package.json', ['esbuild', 'zod']],
]) {
  const require = createRequire(new URL(manifest, import.meta.url));
  for (const name of modules) {
    try {
      const installed = new URL(`node_modules/${name}/package.json`, new URL(manifest, import.meta.url));
      if (!existsSync(installed)) throw new Error('Local locked dependency is not installed');
      require.resolve(name);
    } catch { missing.push(`${name} required by ${fileURLToPath(new URL(manifest, import.meta.url))}`); }
  }
}
if (missing.length) {
  console.error(`Worker build prerequisites missing:\n${missing.map(item => `- ${item}`).join('\n')}\nUse a full repository checkout, then run:\n  npm run setup:build --prefix worker\n  npm run build --prefix worker\nShip the complete worker/dist directory and install locked worker runtime dependencies on the deployment host.`);
  process.exitCode = 1;
}
