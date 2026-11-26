import { describe, expect, it } from 'vitest';
import { functionLookup, semanticIssues } from '../src/engine/analyze';
import { Engine, type ExprNode } from '../src/engine/engine';
import { expressionHover } from '../src/engine/hover';
import { isBooleanLiteral, isNumberLiteral, isTimespanLiteral } from '../src/engine/literals';
import { operate } from '../src/engine/types';
import { WorkspaceIndex } from '../src/index/workspace';
import type { SkNode } from '../src/parser/types';
import type { SyntaxKind } from '../src/syntax/schema';
import { SyntaxRegistry } from '../src/syntax/registry';
import { sk } from './helpers';
import { catalog } from './project';

const registry = new SyntaxRegistry(catalog.forVersion('2.17.1'));
const engine = new Engine(registry);
const STATEMENT: SyntaxKind[] = ['effect', 'condition', 'section'];
const notConditional = (ref: { entry: { id: string } }) => ref.entry.id === 'SecConditional';

function check(line: string, kinds: SyntaxKind[] = STATEMENT) {
  return engine.statement(line, kinds, { exclude: notConditional });
}

/** The tree as `kind:id[text]:type`, children indented. */
function tree(node: ExprNode, text: string, depth = 0): string[] {
  const head = `${'  '.repeat(depth)}${node.kind}${node.ref ? `:${node.ref.entry.id}` : node.name ? `:${node.name}` : ''}[${text.slice(node.start, node.end)}]${node.type ? `:${node.type.id}` : ''}`;
  return [head, ...node.children.flatMap((c) => tree(c, text, depth + 1))];
}

describe('types', () => {
  it('resolves slot words the way SkriptParser does: English plural, then the type by name', () => {
    // Skript's entitydata and entitytype share the name "entity type"; docs patterns show names, not codenames.
    expect(engine.types.slot('entity types')).toMatchObject({ plural: true, info: { singular: 'entity type' } });
    expect(engine.types.slot('texts')).toMatchObject({ plural: true, info: { id: 'string' } });
    expect(engine.types.slot('number')).toMatchObject({ plural: false, info: { id: 'number' } });
    expect(engine.types.slot('time span')).toMatchObject({ plural: false, info: { id: 'timespan' } });
    expect(engine.types.slot('offline players')).toMatchObject({ plural: true, info: { id: 'offlineplayer' } });
  });

  it('names types as default.lang does', () => {
    expect(engine.types.withArticle(engine.types.get('string')!)).toBe('a text');
    expect(engine.types.withArticle(engine.types.get('long')!)).toBe('an integer');
    expect(engine.types.withArticle(engine.types.get('boolean')!)).toBe('a boolean (yes/no)');
    // Documented return types use display names, and functions use codenames such as `long`.
    expect(engine.types.returns('Text')?.id).toBe('string');
    expect(engine.types.returns('long')?.id).toBe('long');
  });

  it('only rules out conversions inside the closed world', () => {
    const t = (id: string) => engine.types.get(id)!;
    expect(engine.types.compatible(t('integer'), t('number'))).toBe('yes');
    expect(engine.types.compatible(t('number'), t('vector'))).toBe('yes'); // DefaultConverters: Number → Vector
    expect(engine.types.compatible(t('string'), t('number'))).toBe('no');
    expect(engine.types.compatible(t('string'), t('player'))).toBe('unknown'); // an addon may convert
    expect(engine.types.compatible(t('player'), t('number'))).toBe('unknown');
  });

  it('knows DefaultOperations, including the commutative variants', () => {
    expect(operate('+', 'number', 'number')).toBe('number');
    expect(operate('+', 'text', 'text')).toBe('text');
    expect(operate('+', 'number', 'text')).toBeUndefined();
    expect(operate('*', 'number', 'timespan')).toBe('timespan');
    expect(operate('/', 'number', 'timespan')).toBeUndefined();
    expect(operate('-', 'date', 'timespan')).toBe('date');
    expect(operate('+', 'date', 'date')).toBeUndefined();
    expect(operate('+', 'vector', 'number')).toBe('vector'); // the number converts to a vector
  });
});

describe('literals', () => {
  it('recognises numbers like JavaClasses.DECIMAL_PATTERN', () => {
    for (const n of ['5', '-1', '2_000', '0.5', '50%', '1e3', '90 degrees', '3 in radians']) expect(isNumberLiteral(n), n).toBe(true);
    for (const n of ['5.', '.5', 'five', '5 diamonds', '1,5']) expect(isNumberLiteral(n), n).toBe(false);
  });

  it('recognises time spans like Timespan#parse, but not a bare unit', () => {
    for (const t of ['5 seconds', 'a minute', '1 minute and 30 seconds', '2 real minutes', '3 mc days', '1:30', '10 ticks']) expect(isTimespanLiteral(t), t).toBe(true);
    for (const t of ['second', 'seconds', '5', 'and 5 seconds', '5 bananas']) expect(isTimespanLiteral(t), t).toBe(false);
  });

  it('recognises booleans', () => {
    for (const b of ['true', 'false', 'yes', 'no', 'on', 'off', 'TRUE']) expect(isBooleanLiteral(b), b).toBe(true);
    expect(isBooleanLiteral('maybe')).toBe(false);
  });
});

describe('type errors Skout is sure of', () => {
  const errors: [string, string][] = [
    ['set {_result} to 5 + "hello"', "Addition can't be performed on an integer and a text"],
    ['set {_x} to "a" - "b"', "Subtraction can't be performed on a text and a text"],
    ['set {_t} to now + now', "Addition can't be performed on a date and a date"],
    ['set {_x} to 2 seconds + 5', "Addition can't be performed on a time span and an integer"],
    ['set {_x} to true * 2', "Multiplication can't be performed on a boolean (yes/no) and an integer"],
    ['set {_x} to "a" - {_y}', "Subtraction can't be performed on a text"],
    ['wait "5 seconds"', '"5 seconds" is not a time span'],
    ['broadcast "%5 + true%"', "Addition can't be performed on an integer and a boolean (yes/no)"],
    ['set {_x} to {_list::*} + 1', "'{_list::*}' can only be a single object, not more."],
    ['set {_n} to length of 5', '5 is not a text'],
    ['set {_x} to 1 + 2 * "a"', "Multiplication can't be performed on an integer and a text"],
  ];
  for (const [line, message] of errors) {
    it(line, () => {
      const result = check(line);
      expect(result.status).toBe('error');
      expect(result.problem?.message).toBe(message);
    });
  }

  it('points at the sub-expression, not the whole line', () => {
    const line = 'set {_result} to 5 + "hello"';
    const p = check(line).problem!;
    expect(line.slice(p.start, p.end)).toBe('5 + "hello"');
    const wait = 'wait "5 seconds"';
    const q = check(wait).problem!;
    expect(wait.slice(q.start, q.end)).toBe('"5 seconds"');
  });
});

describe('lines Skript accepts stay quiet', () => {
  const valid = [
    'set {_result} to 5 + 3',
    'set {_x} to "a" + "b"',
    'wait 5 seconds',
    'set {_t} to now - 5 seconds',
    'set {_n} to 5 + name of player', // the name property returns Object in 2.17
    'set {_x} to loop-value + 1',
    'set {_x} to event-block',
    'set {_x} to -5 + 2',
    'set {_v} to vector(1, 2, 3) * 2',
    'set {_a} to unix timestamp of {_now} * 1 seconds',
    'set {_dates::*} to 1 day ago, 1 second ago, and 100 years ago',
    'set {_mixed::*} to shuffled (characters between "a" and "f", integers from 1 to 5)',
    'set {_times::*} to time since (1 day ago, 1 hour ago, 1 minute ago, 1 minute from now)',
    'give player diamond sword', // an item type Skout cannot check
    'kill all zombies',
    'message "Hello %player%, you have %player\'s health% hp"',
    'set {_x} to 5 + some addon expression', // unknown words are never an error
    'teleport player to spawn of world "world"',
    'add 1 to {_count}',
    'set {_x::*} to {_y::*}',
  ];
  for (const line of valid) {
    it(line, () => expect(check(line).problem?.doubt === 0 ? check(line).problem?.message : 'quiet').toBe('quiet'));
  }

  it('does not report a failure that rests on words Skout does not know', () => {
    // Test-only syntax (`assert`) is not documented; the line only fits CondCompare by reading `assert {_x}` as one value.
    const result = check('assert {_test::*} is "abz", "zde", and block at spawn of world "world" with "failed"');
    expect(result.status).not.toBe('error');
  });
});

describe('typed trees', () => {
  it('parses every slot recursively', () => {
    const line = 'set {_n} to length of name of player';
    const root = check(line).root!;
    expect(tree(root, line)).toEqual([
      'syntax:EffChange[set {_n} to length of name of player]',
      '  variable:_n[{_n}]',
      '  syntax:ExprLength[length of name of player]:number',
      '    syntax:PropExprName[name of player]:object',
      '      syntax:ExprEntity[player]:player',
    ]);
  });

  it('types arithmetic from the operands', () => {
    const line = 'set {_x} to 2 * (3 + 4)';
    const root = check(line).root!;
    expect(tree(root, line)).toEqual([
      'syntax:EffChange[set {_x} to 2 * (3 + 4)]',
      '  variable:_x[{_x}]',
      '  arithmetic:*[2 * (3 + 4)]:number',
      '    number[2]:integer',
      '    arithmetic:+[3 + 4]:number',
      '      number[3]:integer',
      '      number[4]:integer',
    ]);
  });

  it('parses expressions inside text', () => {
    const line = 'send "%player%: %1 + 2%" to player';
    const root = check(line).root!;
    expect(tree(root, line).slice(0, 4)).toEqual([
      'syntax:EffMessage[send "%player%: %1 + 2%" to player]',
      '  string["%player%: %1 + 2%"]:string',
      '    syntax:ExprEntity[player]:player',
      '    arithmetic:+[1 + 2]:number',
    ]);
  });
});

describe('functions', () => {
  const text = sk(
    'function double(n: number) :: number:',
    '\treturn {_n} * 2',
    '',
    'on join:',
    '\tset {_x} to double("five")',
    '\tset {_y} to double(5) + 1',
    '\tset {_z} to double(5) + "a"',
    '\tset {_w} to unknownFunction("x") + 1',
  );

  it('checks arguments against the parameter types and types the call by its return type', () => {
    const index = new WorkspaceIndex(registry.version);
    const file = index.update('file:///f.sk', text);
    const issues = semanticIssues(file, registry, engine, functionLookup(index, file.uri, registry));
    expect(issues.map((i) => `${i.code}@${i.line + 1}:${text.split('\n')[i.line].slice(i.start, i.end)} ${i.message}`)).toEqual([
      `argument-type@5:"five" Can't understand the argument for the parameter 'n' with type 'number': "five". ("five" is not a number)`,
      'invalid-operation@7:double(5) + "a" Addition can\'t be performed on a number and a text',
    ]);
  });

  it('does not check arguments of built-in functions, whose overloads are not documented', () => {
    expect(check('set {_v} to vector(1, 2)').status).toBe('ok');
  });
});

describe('file analysis', () => {
  it('maps problems to the line and skips lines with options it cannot map', () => {
    const text = sk('options:', '\tdelay: 5 seconds', '', 'on join:', '\twait "5 seconds"', '\twait {@delay}', '\tset {_x} to {@delay} + "s"');
    const index = new WorkspaceIndex(registry.version);
    const file = index.update('file:///o.sk', text);
    const issues = semanticIssues(file, registry, engine, functionLookup(index, file.uri, registry));
    expect(issues.map((i) => `${i.line + 1}:${i.start}-${i.end} ${i.message}`)).toEqual([
      '5:6-17 "5 seconds" is not a time span',
      "7:1-27 Addition can't be performed on a time span and a text (in 'set {_x} to 5 seconds + \"s\"')",
    ]);
  });

  it('hovers the sub-expression under the cursor with its type', () => {
    const text = sk('on join:', '\tset {_n} to length of name of player');
    const index = new WorkspaceIndex(registry.version);
    const file = index.update('file:///h.sk', text);
    const node = file.script.structures[0].children[0] as SkNode;
    const at = (word: string) => text.split('\n')[1].indexOf(word) + 1;
    const hover = (word: string) => {
      const h = expressionHover(file, node, at(word), registry, engine, functionLookup(index, file.uri, registry));
      return h && typeof h.contents === 'object' && 'value' in h.contents ? h.contents.value.split('\n')[0] : undefined;
    };
    expect(hover('length')).toBe('`length of name of player` · a number');
    expect(hover('player')).toBe('`player` · a player');
    expect(hover('{_n}')).toContain('**Variable**');
  });
});
