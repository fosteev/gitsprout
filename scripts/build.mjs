import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
};

const webview = {
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
};

const settings = { ...webview, entryPoints: ['webview/settings/main.ts'], outfile: 'dist/settings.js' };

// Markers for the background problem matcher in .vscode/tasks.json: F5 waits for
// "build finished" so the Extension Development Host never starts before dist/ exists.
const watchLog = (name) => ({
  name: 'watch-log',
  setup(b) {
    b.onStart(() => console.log(`[watch] ${name} build started`));
    b.onEnd((r) => console.log(`[watch] ${name} build finished, ${r.errors.length} error(s)`));
  },
});

if (watch) {
  const ctxs = await Promise.all([
    context({ ...extension, plugins: [watchLog('extension')], logLevel: 'error' }),
    context({ ...webview, plugins: [watchLog('webview')], logLevel: 'error' }),
    context({ ...settings, plugins: [watchLog('settings')], logLevel: 'error' }),
  ]);
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([build(extension), build(webview), build(settings)]);
  console.log('built dist/extension.js, dist/webview.js, dist/settings.js');
}
