/**
 * Parses every script in Skript's own repository (fetched by `npm run corpus`).
 * Each one loads in Skript, so a structural error reported here is a false
 * positive in Skout. Skipped when the corpus has not been downloaded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectIssues } from '../src/features/project';
import { WorkspaceIndex } from '../src/index/workspace';
import { parseScript } from '../src/parser/parser';
import { defaultSettings } from '../src/settings';
import { catalog } from './project';

const ROOT = join(__dirname, '..', '..', '.corpus', 'Skript');

/**
 * Lines Skript's own tests expect to fail, inside `parse:` blocks followed by
 * `assert last parse logs is set`. Reporting them is correct. Valid for the
 * pinned corpus (Skript 2.17.1).
 */
const EXPECTED_FAILURES = new Set([
  // `set {##_b::%"{}"#%}`: a # inside %…% in a variable name starts a comment.
  'src/test/skript/tests/misc/comments.sk:45',
]);

function scripts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...scripts(path));
    else if (name.endsWith('.sk')) out.push(path);
  }
  return out;
}

describe.skipIf(!existsSync(ROOT))('Skript’s own scripts', () => {
  it('produce no structural errors', () => {
    const files = scripts(ROOT);
    expect(files.length).toBeGreaterThan(500);
    const problems: string[] = [];
    for (const file of files) {
      const script = parseScript(readFileSync(file, 'utf8'));
      const name = relative(ROOT, file).replaceAll('\\', '/');
      for (const issue of script.issues) {
        if (issue.severity !== 'error') continue;
        if (EXPECTED_FAILURES.has(`${name}:${issue.line + 1}`)) continue;
        problems.push(`${name}:${issue.line + 1}:${issue.start + 1} ${issue.code} ${issue.message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * The cross-file checks over Skript's test suite. The tests deliberately use
   * unset variables, so `unset-variable` is not asserted; everything else must
   * be explained by test-only code.
   */
  it('produce no cross-file errors outside deliberate test failures', () => {
    const syntax = catalog.forVersion('2.17.1');
    const index = new WorkspaceIndex(syntax.version);
    for (const file of scripts(join(ROOT, 'src', 'test', 'skript', 'tests'))) {
      index.update(`file:///${relative(ROOT, file).replaceAll('\\', '/')}`, readFileSync(file, 'utf8'));
    }
    const issues = projectIssues({ index, catalog, syntax, version: syntax.version, settings: defaultSettings });
    const problems: string[] = [];
    for (const [uri, list] of issues) {
      for (const issue of list) {
        if (issue.code === 'unset-variable') continue;
        const name = uri.slice('file:///'.length);
        const call = issue.message.match(/^Function '(\w+)'/)?.[1];
        if (issue.code === 'undefined-function' && call && TEST_ONLY_FUNCTIONS.has(call)) continue;
        if (EXPECTED_FAILURES.has(`${name}:${issue.line + 1}`)) continue;
        problems.push(`${name}:${issue.line + 1} ${issue.code} ${issue.message}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

/** Registered by Skript's TestFunctions only when its test runner is active. */
const TEST_ONLY_FUNCTIONS = new Set(['case_equals', 'file_separator']);

// `parse:` blocks that expect "The function argument_test(...) does not exist".
for (const line of [67, 75, 87]) EXPECTED_FAILURES.add(`src/test/skript/tests/syntaxes/structures/StructFunction.sk:${line}`);
