// Bundles the VS Code client and the language server into dist/.
//
//   node scripts/build.mjs               development build
//   node scripts/build.mjs --production  minified, no source maps (used by vsce)
//   node scripts/build.mjs --watch       rebuild on change
//   node scripts/build.mjs --tests       also bundle the integration tests
import * as esbuild from 'esbuild';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const tests = args.has('--tests');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // `vscode` is provided by the editor at runtime and must never be bundled.
  external: ['vscode'],
};

const builds = [
  { ...common, entryPoints: { client: 'client/src/extension.ts' }, outdir: 'dist' },
  // The server is editor-agnostic: `node dist/server.js --stdio` works in any LSP client.
  { ...common, entryPoints: { server: 'server/src/server.ts' }, outdir: 'dist' },
];

if (tests) {
  builds.push({
    ...common,
    entryPoints: {
      'test/runTest': 'client/test/runTest.ts',
      'test/suite/index': 'client/test/suite/index.ts',
      'test/suite/extension.test': 'client/test/suite/extension.test.ts',
    },
    outdir: 'dist',
    // mocha and the test runner are loaded from node_modules at test time.
    external: ['vscode', 'mocha', '@vscode/test-electron'],
  });
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
