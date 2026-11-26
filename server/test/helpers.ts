import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScript } from '../src/parser/parser';
import type { Issue, ParsedScript, SkNode } from '../src/parser/types';

export const FIXTURES = join(__dirname, 'fixtures');

export function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

/** Joins lines with `\n`. Write tabs as `\t` so the indentation is visible in the test. */
export function sk(...lines: string[]): string {
  return lines.join('\n');
}

/** `code@line` for every issue, the compact form most assertions use (lines are 1-based). */
export function codes(script: ParsedScript | string): string[] {
  const parsed = typeof script === 'string' ? parseScript(script) : script;
  return parsed.issues.map((i) => `${i.code}@${i.line + 1}`);
}

export function issues(text: string): Issue[] {
  return parseScript(text).issues;
}

/** A compact picture of the tree: `key` per node, children indented by two spaces. */
export function outline(script: ParsedScript): string {
  const out: string[] = [];
  const visit = (node: SkNode, depth: number) => {
    const flags = [node.structure, node.invalid ? 'invalid' : '', node.recovered ? 'recovered' : ''].filter(Boolean).join(',');
    out.push(`${'  '.repeat(depth)}${node.key}${node.kind === 'section' ? ':' : ''}${flags ? ` [${flags}]` : ''}`);
    node.children.forEach((child) => visit(child, depth + 1));
  };
  script.structures.forEach((node) => visit(node, 0));
  return out.join('\n');
}
