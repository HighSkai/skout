/**
 * Tokenizes lines with VS Code's own TextMate engine (vscode-textmate and
 * Oniguruma) to check the grammar in syntaxes/skript.tmLanguage.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

const ROOT = join(__dirname, '..', '..');
let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(join(ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () =>
      textmate.parseRawGrammar(readFileSync(join(ROOT, 'syntaxes', 'skript.tmLanguage.json'), 'utf8'), 'skript.tmLanguage.json'),
  });
  const loaded = await registry.loadGrammar('source.skript');
  if (!loaded) throw new Error('grammar did not load');
  grammar = loaded;
});

/** Tokenizes `lines` and returns `text → innermost scope` pairs for each token of the last line. */
function scopes(...lines: string[]): [string, string][] {
  let state = textmate.INITIAL;
  let result: [string, string][] = [];
  for (const line of lines) {
    const tokens = grammar.tokenizeLine(line, state);
    result = tokens.tokens.map((t) => [line.slice(t.startIndex, t.endIndex), t.scopes[t.scopes.length - 1]]);
    state = tokens.ruleStack;
  }
  return result;
}

function scopeOf(text: string, ...lines: string[]): string | undefined {
  return scopes(...lines).find(([t]) => t.includes(text))?.[1];
}

describe('TextMate grammar', () => {
  it('scopes comments, but not # inside strings', () => {
    expect(scopeOf('greet', '\tsend "hi" # greet')).toBe('comment.line.number-sign.skript');
    expect(scopeOf('#1', '\tsend "&#ff0000 #1"')).toBe('string.quoted.double.skript');
  });

  it('treats ## as an escaped # rather than a comment', () => {
    expect(scopeOf('##', '\taccent: <##f5c542>')).toBe('constant.character.escape.skript');
    expect(scopeOf('f5c542', '\taccent: <##f5c542>')).not.toContain('comment');
  });

  it('scopes block comments across lines', () => {
    expect(scopeOf('kept', 'on join:', '###', 'kept for reference')).toBe('comment.block.skript');
  });

  it('scopes %expressions% and variables inside strings', () => {
    expect(scopeOf('%', '\tsend "Hi %player%!"')).toBe('punctuation.section.embedded.begin.skript');
    expect(scopeOf('::', '\tsend "%{coins::%uuid of player%}%"')).toBe('punctuation.separator.list.skript');
  });

  it('scopes variables, options and function calls', () => {
    expect(scopeOf('{@prefix}', '\tsend "x" to {_p} # {@prefix}')).toBe('comment.line.number-sign.skript');
    expect(scopeOf('{@prefix}', '\tset {_x} to {@prefix}')).toBe('variable.other.constant.option.skript');
    expect(scopeOf('_', '\tset {_x} to 1')).toBe('storage.modifier.local.skript');
    expect(scopeOf('openShop', '\topenShop(player, 1)')).toBe('entity.name.function.call.skript');
  });

  it('scopes structure headers', () => {
    expect(scopeOf('function', 'function openShop(p: player) :: text:')).toBe('keyword.other.function.skript');
    expect(scopeOf('openShop', 'function openShop(p: player) :: text:')).toBe('entity.name.function.skript');
    expect(scopeOf('player', 'function openShop(p: player) :: text:')).toBe('entity.name.type.skript');
    expect(scopeOf('command', 'command /shop [<integer>]:')).toBe('keyword.other.command.skript');
    expect(scopeOf('options', 'options:')).toBe('keyword.other.structure.skript');
    expect(scopeOf('on', 'on join:')).toBe('keyword.other.event.skript');
  });

  it('scopes control keywords and colour codes', () => {
    expect(scopeOf('else if', '\telse if {_x} is 1:')).toBe('keyword.control.skript');
    expect(scopeOf('&a', '\tsend "&aHello"')).toBe('constant.other.color.skript');
  });
});
