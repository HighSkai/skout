// Downloads Skript's own .sk scripts (its test suite and bundled examples) into
// .corpus/Skript for the parser stress test. Every one of them loads in Skript,
// so any structural error Skout reports on them is a false positive.
//
// Development only: Skout itself never makes network calls on its own.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const target = '.corpus/Skript';
// Pinned so the allow-list in server/test/corpus.test.ts stays valid. Pass another tag to try it.
const ref = process.argv[2] ?? '2.17.1';

mkdirSync('.corpus', { recursive: true });
if (!existsSync(target)) {
  execFileSync('git', ['clone', '--depth', '1', '--branch', ref, '--filter=blob:none', '--sparse',
    'https://github.com/SkriptLang/Skript.git', target], { stdio: 'inherit' });
}
execFileSync('git', ['-C', target, 'sparse-checkout', 'set', 'src/test/skript', 'src/main/resources/scripts'], { stdio: 'inherit' });
console.log(`Corpus ready in ${target}`);
