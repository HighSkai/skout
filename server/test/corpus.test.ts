/**
 * Parses every script in Skript's own repository (fetched by `npm run corpus`).
 * Each one loads in Skript, so a structural error reported here is a false
 * positive in Skout. Skipped when the corpus has not been downloaded.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionLookup, semanticIssues } from '../src/engine/analyze';
import { contextIssues } from '../src/engine/context';
import { Engine } from '../src/engine/engine';
import { entryIssues } from '../src/features/entries';
import { projectIssues } from '../src/features/project';
import { unrecognizedIssues } from '../src/features/syntax';
import { extract } from '../src/index/extract';
import { SyntaxRegistry } from '../src/syntax/registry';
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

describe.skipIf(!existsSync(ROOT))('Skript’s own scripts against Skript’s syntax', () => {
  it('produce no typo reports: every line Skript accepts is left alone', () => {
    const registry = new SyntaxRegistry(catalog.forVersion('2.17.1'));
    const reports: string[] = [];
    for (const file of scripts(ROOT)) {
      const indexed = extract(`file:///${relative(ROOT, file)}`, parseScript(readFileSync(file, 'utf8')), registry.version);
      for (const issue of unrecognizedIssues(indexed, registry, 'typos')) {
        reports.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${issue.line + 1} ${issue.message}`);
      }
    }
    expect(reports).toEqual([]);
  }, 120_000);

  /**
   * The engine parses every line down to its sub-expressions. Skript's tests
   * load in Skript, so any type error reported here is a false positive.
   * Lines inside `parse:` blocks are expected to fail and are not counted.
   */
  it('produce no type errors', () => {
    const registry = new SyntaxRegistry(catalog.forVersion('2.17.1'));
    const engine = new Engine(registry);
    const index = new WorkspaceIndex(registry.version);
    for (const file of scripts(ROOT)) index.update(`file:///${relative(ROOT, file).replaceAll('\\', '/')}`, readFileSync(file, 'utf8'));
    const reports: string[] = [];
    let checked = 0;
    for (const file of index.all()) {
      checked += file.script.lines.length;
      for (const issue of semanticIssues(file, registry, engine, functionLookup(index, file.uri, registry))) {
        if (insideParseBlock(file.script.lines.map((l) => l.text), issue.line)) continue;
        reports.push(`${file.uri.slice('file:///'.length)}:${issue.line + 1} ${issue.code} ${issue.message}`);
      }
    }
    expect(checked).toBeGreaterThan(20_000);
    expect(reports).toEqual([]);
  }, 120_000);

  /**
   * Statements in the wrong place. Everything reported must be a failure
   * Skript's own tests expect (they assert the same message in `parse:` blocks).
   */
  it('report exactly the misplaced statements Skript’s tests expect', () => {
    const registry = new SyntaxRegistry(catalog.forVersion('2.17.1'));
    const index = new WorkspaceIndex(registry.version);
    for (const file of scripts(ROOT)) index.update(`file:///${relative(ROOT, file).replaceAll('\\', '/')}`, readFileSync(file, 'utf8'));
    const reports: string[] = [];
    for (const file of index.all()) {
      for (const issue of contextIssues(file, registry, registry.version)) reports.push(`${file.uri.slice('file:///'.length)}:${issue.line + 1} ${issue.message}`);
    }
    expect(reports.sort()).toEqual([
      'src/test/skript/tests/common/EffSuppressWarnings.sk:17 Unreachable code. The previous statement stops further execution.',
      'src/test/skript/tests/common/EffSuppressWarnings.sk:28 Unreachable code. The previous statement stops further execution.',
      'src/test/skript/tests/common/EffSuppressWarnings.sk:5 Unreachable code. The previous statement stops further execution.',
      "src/test/skript/tests/syntaxes/sections/SecConditional.sk:189 'then' has to placed just after a multiline 'if' or 'else if' section",
    ]);
  });

  it('produce no command entry errors', () => {
    const version = catalog.forVersion('2.17.1').version;
    const reports: string[] = [];
    for (const file of scripts(ROOT)) {
      const script = parseScript(readFileSync(file, 'utf8'));
      for (const issue of entryIssues(script, version)) reports.push(`${relative(ROOT, file)}:${issue.line + 1} ${issue.message}`);
    }
    expect(reports).toEqual([]);
  });
});

/** Whether a line is in a `parse:` section (Skript's tests check that its contents fail to load). */
function insideParseBlock(lines: readonly string[], line: number): boolean {
  const indent = (text: string) => /^\s*/.exec(text)![0].length;
  let depth = indent(lines[line]);
  for (let l = line - 1; l >= 0; l--) {
    const text = lines[l];
    if (text.trim() === '' || text.trim().startsWith('#')) continue;
    if (indent(text) < depth) {
      if (/^\s*parse( if .+)?:\s*$/.test(text)) return true;
      depth = indent(text);
      if (depth === 0) return false;
    }
  }
  return false;
}

/** Registered by Skript's TestFunctions only when its test runner is active. */
const TEST_ONLY_FUNCTIONS = new Set(['case_equals', 'file_separator']);

// `parse:` blocks that expect "The function argument_test(...) does not exist".
for (const line of [67, 75, 87]) EXPECTED_FAILURES.add(`src/test/skript/tests/syntaxes/structures/StructFunction.sk:${line}`);
