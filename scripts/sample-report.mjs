// Writes docs/sample-upgrade-report.md: the upgrade checker's real output for
// server/test/fixtures/upgrade/scripts.sk, from Skript 2.15.4 to 2.17.1.
// Re-run (`npm run sample-report`) when the checker's messages change.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const outfile = join(root, 'node_modules', '.cache', 'skout-render', 'upgrade.cjs');
mkdirSync(join(outfile, '..'), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { WorkspaceIndex } from './server/src/index/workspace';",
      "export { checkUpgrade } from './server/src/upgrade/check';",
      "export { renderReport } from './server/src/upgrade/report';",
      "export { SyntaxCatalog } from './server/src/syntax/catalog';",
      "export { SyntaxRegistry } from './server/src/syntax/registry';",
      "export { parseVersion } from './server/src/skript/version';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});
const { WorkspaceIndex, checkUpgrade, renderReport, SyntaxCatalog, SyntaxRegistry, parseVersion } = require(outfile);

const catalog = SyntaxCatalog.fromDirectory(join(root, 'dumps'));
const side = (v) => ({ registry: new SyntaxRegistry(catalog.forVersion(v)), version: parseVersion(v), label: `Skript ${v}` });
const index = new WorkspaceIndex(parseVersion('2.15.4'));
const script = 'server/test/fixtures/upgrade/scripts.sk';
index.update(`file:///${script}`, readFileSync(join(root, script), 'utf8'));
const result = checkUpgrade(index, side('2.15.4'), side('2.17.1'), { kind: 'skript' });
const markdown = renderReport(result, {
  linkFor: (_uri, line) => `../${script}#L${line + 1}`,
  nameFor: () => 'scripts.sk',
  date: new Date().toISOString().slice(0, 10),
  skoutVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
});
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs', 'sample-upgrade-report.md'), markdown);
console.log(`docs/sample-upgrade-report.md: ${result.findings.length} findings`);
