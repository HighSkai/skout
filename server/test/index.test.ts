import { describe, expect, it } from 'vitest';
import { extract, scanLine, segmentsOf } from '../src/index/extract';
import { writeCovers } from '../src/index/workspace';
import { parseScript } from '../src/parser/parser';
import { parseVersion } from '../src/skript/version';
import { fixture, sk } from './helpers';

const v = parseVersion('2.17.1')!;
const index = (text: string) => extract('file:///t.sk', parseScript(text), v);
const vars = (text: string) => index(text).variables.map((o) => `${o.write ? 'set' : 'get'} {${o.raw}}`);

describe('variables', () => {
  it('finds variables in code, strings and dynamic names', () => {
    expect(vars(sk('on join:', '\tsend "Coins: %{coins::%uuid of player%}%" to player'))).toEqual(['get {coins::%uuid of player%}']);
    const nested = index(sk('on join:', '\tset {quest::%{_id}%::done} to true')).variables;
    expect(nested.map((o) => `${o.raw}:${o.topLevel ? 'top' : 'nested'}:${o.write ? 'set' : 'get'}`)).toEqual([
      '_id:nested:get',
      'quest::%{_id}%::done:top:set',
    ]);
  });

  it('ignores braces in string text and {@options}', () => {
    expect(vars(sk('options:', '\tp: x', 'on join:', '\tsend "use {name} here {@p}" to player'))).toEqual([]);
  });

  it('marks every changer target as a write (EffChange, EffCopy, SecFor)', () => {
    const text = sk(
      'on join:',
      '\tset {_a} and {_b} to 1',
      '\tadd 1 to {_c}',
      '\tremove all 2 from {_d::*}',
      '\tdelete {_e}',
      '\treset {_f}',
      '\tincrease {_g} by 2',
      '\tcopy {_a} into {_h}',
      '\tfor each {_i} in {_d::*}:',
      '\t\tsend {_i}',
      '\tset {_j} to {_a} + {_b}',
    );
    expect(vars(text)).toEqual([
      'set {_a}', 'set {_b}', 'set {_c}', 'set {_d::*}', 'set {_e}', 'set {_f}', 'set {_g}',
      'get {_a}', 'set {_h}', 'set {_i}', 'get {_d::*}', 'get {_i}', 'set {_j}', 'get {_a}', 'get {_b}',
    ]);
  });

  it('treats function parameters and named command arguments as set', () => {
    const file = index(sk('function f(p: player, xs: numbers):', '\tsend {_p}', 'command /c <target: player> <amounts: numbers>:', '\ttrigger:', '\t\tsend {_target}'));
    expect(file.variables.filter((o) => o.parameter).map((o) => o.raw)).toEqual(['_p', '_xs::*', '_target', '_amounts::*']);
  });

  it('treats `variables:` defaults as set', () => {
    expect(vars(sk('variables:', '\t{joins} = 0', '\t{balance::%player%} = 0'))).toEqual(['set {joins}', 'set {balance::%player%}']);
  });

  it('splits names into segments, keeping %…% whole', () => {
    expect(segmentsOf('quest::%uuid of player%::active::*', 0).map((s) => `${s.kind}:${s.text}`)).toEqual([
      'literal:quest',
      'dynamic:%uuid of player%',
      'literal:active',
      'wildcard:*',
    ]);
  });

  it('decides whether a write may set a read', () => {
    const s = (name: string) => segmentsOf(name, 0);
    expect(writeCovers(s('coins::%player%'), s('coins::%uuid of player%'))).toBe(true);
    expect(writeCovers(s('list::*'), s('list::5'))).toBe(true);
    expect(writeCovers(s('list::%x%'), s('list::*'))).toBe(true);
    expect(writeCovers(s('Quest::A'), s('quest::a'))).toBe(true); // case-insensitive
    expect(writeCovers(s('quest::active'), s('quest::actve'))).toBe(false);
    expect(writeCovers(s('a'), s('a::*'))).toBe(false);
  });
});

describe('function calls', () => {
  const calls = (text: string) => index(text).calls.map((c) => `${c.name}/${c.args.length}`);

  it('finds calls in code and inside %…% of strings, not in string text', () => {
    expect(calls(sk('on join:', '\tsend "Hi(%name(player)%) fake(1)" to player', '\tset {_x} to max(1, 2, floor(3.5))'))).toEqual([
      'name/1',
      'max/3',
      'floor/1',
    ]);
  });

  it('skips skript-reflect Java calls and constructors', () => {
    expect(calls(sk('on load:', '\tset {_l} to new ArrayList()', '\tset {_v} to Bukkit.getVersion()', '\t{_l}.add(1)'))).toEqual([]);
  });

  it('indexes real-world fixtures without stray calls', () => {
    const file = extract('file:///shop.sk', parseScript(fixture('valid/shop-gui.sk')), v);
    expect(file.calls.map((c) => c.name)).toEqual(['openShop']);
    expect(file.functions.map((f) => f.name)).toEqual(['openShop']);
    expect(file.commands.map((c) => `${c.name} ${c.aliases.join(',')}`)).toEqual(['shop store,market']);
  });
});

describe('scanLine', () => {
  it('blanks string text and variable names for call detection', () => {
    const line = 'send "x(1)" to {a(b)}';
    const scan = scanLine(line, 0, line.length);
    expect(scan.masked).toBe('send "    " to {    }');
  });
});
