import { describe, expect, it } from 'vitest';
import { checkBrackets } from '../src/parser/brackets';

function check(code: string): string[] {
  return checkBrackets(code, 0, code.length).map((i) => `${i.code}:${i.char}@${i.column}`);
}

describe('checkBrackets', () => {
  it('accepts balanced real-world lines', () => {
    const lines = [
      'send "&aWelcome %player%!" to player',
      'set {_gui} to chest inventory with 6 rows named "Page %{_page}%"',
      'set slot 1 of {_gui} to stone with lore "&7Price: &a$%{shop::price::%loop-index%}%"',
      'send "%join {_list::*} with ", "%" to player',
      'if chance of 50%:',
      'set {_x} to ""',
      'send "He said ""hi"" and got 50%% off"',
      'set {quest::%player\'s uuid%::active::*} to "tutorial"',
      'openShop(player, {_page})',
      'set {_list::*} to (1, 2 and 3)',
      'send "<#ff0000>[Shop]</#ff0000>"',
    ];
    for (const line of lines) expect(check(line), line).toEqual([]);
  });

  it('reports an unclosed string at its opening quote', () => {
    expect(check('send "hello to player')).toEqual(['unclosed-string:"@5']);
  });

  it('reports the unescaped % in a string, not the cascade after it', () => {
    expect(check('send "Sale: 50% off!" to player')).toEqual(['unclosed-percent:%@14']);
  });

  it('reports an unclosed % expression', () => {
    expect(check('send "Hi %player"')).toEqual(['unclosed-percent:%@9']);
  });

  it('reports unclosed and unmatched brackets', () => {
    expect(check('set {_x to 1')).toEqual(['unclosed-bracket:{@4']);
    expect(check('set {_x} to 1}')).toEqual(['unmatched-bracket:}@13']);
    expect(check('give(player, stone')).toEqual(['unclosed-bracket:(@4']);
    expect(check('send "x")')).toEqual(['unmatched-bracket:)@8']);
  });

  it('reports a bracket left open when an expression ends', () => {
    expect(check('send "%size of (all players%"')).toEqual(['unclosed-bracket:(@15']);
  });

  it('does not let a closer cross a string boundary', () => {
    expect(check('send ")"')).toEqual([]);
    expect(check('send "(" and ")"')).toEqual([]);
  });
});
