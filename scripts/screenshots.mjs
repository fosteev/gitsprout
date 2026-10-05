// README screenshots: bundles scripts/screenshots/run.ts with esbuild and runs it.
// Usage: pnpm screenshots [frame…] (needs Chrome; override the path with CHROME_PATH). Frames: docs/screenshots/*.png.
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await import('./build.mjs');
// Inside node_modules so the bundle resolves playwright-core from the project.
const outfile = join(root, 'node_modules/.cache/gitsprout-screenshots/run.mjs');
await build({
  entryPoints: [join(root, 'scripts/screenshots/run.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['playwright-core', 'vscode'], logLevel: 'error',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
process.argv.splice(2, 0, root);
await import(pathToFileURL(outfile).href);
