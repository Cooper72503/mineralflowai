// Explicit preparation; npm run build itself never installs or changes dependencies.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directories = [new URL('../../frontend/', import.meta.url), new URL('../', import.meta.url)];
for (const directory of directories) {
  if (!existsSync(new URL('package-lock.json', directory))) {
    console.error('Build setup requires a full repository checkout with frontend/ and worker/ lockfiles.');
    process.exit(1);
  }
}
for (const directory of directories) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--include=dev'], { cwd: fileURLToPath(directory), stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`Dependency installation failed in ${fileURLToPath(directory)}: ${result.error?.message ?? result.status}`);
    process.exit(1);
  }
}
