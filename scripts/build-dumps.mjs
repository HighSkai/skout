// Downloads Skript's published docs.json for the bundled versions and writes
// normalized dumps to dumps/skript-<version>.json.
//
// Development only: run it when a new Skript version is released, then commit
// the result. Skout itself never downloads anything unless the user runs
// "Skout: Download syntax dump".
//
// The data comes from SkriptLang/Skript's documentation (GPL-3.0).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

/** Latest patch of each recent minor release. Archives below 2.10 are not valid JSON upstream. */
const VERSIONS = ['2.14.3', '2.15.4', '2.16.2', '2.17.1'];

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const out = join(root, 'dumps');
mkdirSync(out, { recursive: true });

const importer = join(root, 'node_modules', '.cache', 'skout-dumps', 'skriptDocs.cjs');
esbuild.buildSync({ entryPoints: [join(root, 'server/src/syntax/skriptDocs.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: importer, logLevel: 'silent' });
const { importSkriptDocs } = require(importer);

for (const version of VERSIONS) {
  const url = `https://docs.skriptlang.org/archives/${version}/docs.json`;
  const response = await fetch(url, { headers: { 'user-agent': 'skout-build-dumps' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const dump = importSkriptDocs(await response.json());
  if (dump.skriptVersion !== version) throw new Error(`${url} describes ${dump.skriptVersion}, expected ${version}`);
  const file = join(out, `skript-${version}.json`);
  writeFileSync(file, JSON.stringify(dump));
  const counts = {};
  for (const e of dump.entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  console.log(`${file}: ${dump.entries.length} entries`, counts);
}
