import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TextEdit } from 'vscode-languageserver';
import { callAt, formatDocument, signatureHelp } from '../src/features/format';
import { WorkspaceIndex } from '../src/index/workspace';
import { parseScript } from '../src/parser/parser';
import type { SkNode } from '../src/parser/types';
import { SyntaxRegistry } from '../src/syntax/registry';
import { sk } from './helpers';
import { catalog } from './project';

function apply(text: string, edits: readonly TextEdit[]): string {
  const lines = text.split('\n');
  // Edits do not overlap; apply from the end so earlier positions stay valid.
  for (const e of [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)) {
    const l = e.range.start.line;
    lines[l] = lines[l].slice(0, e.range.start.character) + e.newText + lines[l].slice(e.range.end.character);
  }
  return lines.join('\n');
}

function format(text: string, insertSpaces = false, tabSize = 4): string {
  const index = new WorkspaceIndex(catalog.forVersion(undefined).version);
  return apply(text, formatDocument(index.update('file:///f.sk', text), { insertSpaces, tabSize }));
}

/** The tree as `depth:key` per node, which is all Skript reads from indentation. */
function shape(text: string): string[] {
  const out: string[] = [];
  const visit = (n: SkNode) => {
    out.push(`${n.depth}:${n.kind}:${n.key}`);
    n.children.forEach(visit);
  };
  parseScript(text).structures.forEach(visit);
  return out;
}

describe('formatting', () => {
  it('re-indents by depth with the editor’s unit and removes trailing whitespace', () => {
    const text = sk('on join:  ', '  if player is op:', '    send "a"   ', '  # a note', '  send "b"', '', '   ', 'command /x:', '\ttrigger:', '\t\tstop');
    expect(format(text)).toBe(sk('on join:', '\tif player is op:', '\t\tsend "a"', '\t# a note', '\tsend "b"', '', '', 'command /x:', '\ttrigger:', '\t\tstop'));
    expect(format(text, true, 2)).toBe(sk('on join:', '  if player is op:', '    send "a"', '  # a note', '  send "b"', '', '', 'command /x:', '  trigger:', '    stop'));
  });

  it('indents a comment like the code below it, and leaves block comments alone', () => {
    const text = sk('on join:', '# about the next line', '    send "a"', '###', '   kept   as is   ', '###');
    expect(format(text)).toBe(sk('on join:', '\t# about the next line', '\tsend "a"', '###', '   kept   as is   ', '###'));
  });

  it('leaves a file with indentation errors alone', () => {
    const text = sk('on join:', '\tsend "a"', '\t   send "b"');
    expect(formatDocument(new WorkspaceIndex(catalog.forVersion(undefined).version).update('file:///f.sk', text), { insertSpaces: false, tabSize: 4 })).toEqual([]);
  });

  const ROOT = join(__dirname, '..', '..', '.corpus', 'Skript');
  it.skipIf(!existsSync(ROOT))('never changes how Skript reads a file (Skript’s own scripts)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : n.endsWith('.sk') ? [p] : [];
      });
    let changed = 0;
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const formatted = format(text, true, 4);
      if (formatted !== text) changed++;
      expect(shape(formatted), file).toEqual(shape(text));
      expect(format(formatted, true, 4), `${file} formats to a fixed point`).toBe(formatted);
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('signature help', () => {
  it('finds the call and argument under the cursor', () => {
    expect(callAt('set {_x} to give(player, 5', 26)).toEqual({ name: 'give', argument: 1, named: undefined });
    expect(callAt('f(a, g(b, c), d', 15)).toEqual({ name: 'f', argument: 2, named: undefined });
    expect(callAt('f("a, b", ', 10)).toEqual({ name: 'f', argument: 1, named: undefined });
    expect(callAt('f(amount: 5', 11)).toEqual({ name: 'f', argument: 0, named: 'amount' });
    expect(callAt('send "x" to player', 10)).toBeUndefined();
  });

  it('shows the signature of a user function and the active parameter', () => {
    const registry = new SyntaxRegistry(catalog.forVersion('2.17.1'));
    const index = new WorkspaceIndex(registry.version);
    const text = sk('function reward(p: player, amount: number = 1) :: boolean:', '\treturn true', 'on join:', '\treward(player, ');
    const file = index.update('file:///s.sk', text);
    const help = signatureHelp(index, file, registry, 3, text.split('\n')[3].length)!;
    expect(help.signatures[0].label).toBe('function reward(p: player, amount: number = 1) :: boolean');
    expect(help.activeParameter).toBe(1);
    const builtin = signatureHelp(index, index.update('file:///b.sk', 'on join:\n\tset {_x} to floor('), registry, 1, 19)!;
    expect(builtin.signatures[0].label).toContain('function floor(');
  });
});
