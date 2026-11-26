import { describe, expect, it } from 'vitest';
import { compilePattern, matches, parsePattern, render } from '../src/syntax/pattern';

const m = (pattern: string, text: string) => matches(compilePattern(pattern), text);

describe('pattern compiler (port of PatternCompiler)', () => {
  it('parses optional parts, groups, choices, slots, regex and tags', () => {
    expect(parsePattern('[:local] function <.+>')).toEqual([
      { t: 'opt', body: [{ t: 'tag' }, { t: 'lit', text: 'local' }] },
      { t: 'lit', text: ' function ' },
      { t: 'regex', source: '.+' },
    ]);
    expect(parsePattern('a|b c')).toEqual([{ t: 'choice', alts: [[{ t: 'lit', text: 'a' }], [{ t: 'lit', text: 'b c' }]] }]);
    expect(parsePattern('%-~players@-1%')).toEqual([{ t: 'type', types: 'players', nullable: true }]);
  });

  it('drops the tag name before a colon instead of matching it', () => {
    expect(m('(all:all|any:any) players', 'all players')).toBe(true);
    expect(m('(all:all|any:any) players', 'all:all players')).toBe(false);
  });

  it('treats an escaped character as a literal', () => {
    expect(m('x \\(y\\)', 'x (y)')).toBe(true);
  });

  it('reads `<` without a closing `>` as text, as docs.json prints CondCompare', () => {
    expect(m('%objects% ((is|are) less than|<=) %objects%', '{_a} <= 5')).toBe(true);
  });

  it('treats human-readable <placeholders> from addon docs as any text', () => {
    expect(m('import <fully qualified name>', 'import org.bukkit.Bukkit')).toBe(true);
  });
});

describe('matching (port of the PatternElement matchers)', () => {
  it('is case-insensitive', () => {
    expect(m('broadcast %objects%', 'BroadCast "hi"')).toBe(true);
  });

  it('handles spaces around optional parts the way LiteralPatternElement does', () => {
    const p = 'send [the] resource pack %text% to %players%';
    expect(m(p, 'send resource pack "x" to player')).toBe(true);
    expect(m(p, 'send the resource pack "x" to player')).toBe(true);
    expect(m(p, 'sendthe resource pack "x" to player')).toBe(false);
  });

  it('lets a slot take whole tokens: strings, variables and parentheses', () => {
    expect(m('send %objects% to %players%', 'send "a to b" to player')).toBe(true);
    expect(m('send %objects% to %players%', 'send {list::to::*} to player')).toBe(true);
    expect(m('send %objects% to %players%', 'send (x to y) to player')).toBe(true);
  });

  it('never lets a slot be empty', () => {
    expect(m('send %objects% to %players%', 'send to player')).toBe(false);
  });

  it('requires the whole line to match', () => {
    expect(m('kill %entities%', 'kill player now please')).toBe(true); // the slot takes the rest
    expect(m('stop [the] server', 'stop the server now')).toBe(false);
  });

  it('matches regex parts at token boundaries', () => {
    expect(m('<\\d+> apples', '12 apples')).toBe(true);
    expect(m('<\\d+> apples', 'twelve apples')).toBe(false);
  });

  it('handles possessives with optional letters', () => {
    expect(m("%players%'[s] gizmo (is|are) charged", "player's gizmo is charged")).toBe(true);
    expect(m("%players%'[s] gizmo (is|are) charged", "players' gizmo are charged")).toBe(true);
  });
});

describe('rendering', () => {
  it('keeps the shortest reading: first choices, no optional parts', () => {
    expect(render(parsePattern('(add|give) %objects% to %~objects%'))).toEqual({
      label: 'add %objects% to %objects%',
      snippet: 'add ${1:objects} to ${2:objects}',
    });
    expect(render(parsePattern('send [the] resource pack [from [[the] URL]] %text% to %players%')).snippet).toBe(
      'send resource pack ${1:text} to ${2:players}',
    );
  });

  it('escapes snippet syntax in literal text', () => {
    expect(render(parsePattern('cost $%number%')).snippet).toBe('cost \\$${1:number}');
  });
});
