import { describe, expect, it } from 'vitest';
import { isListFunction, maxArguments, minArguments, parseArguments, parseSignature, sameRegistryKey, splitTopLevel } from '../src/skript/functions';
import { isPlural } from '../src/skript/plural';
import { parseVersion } from '../src/skript/version';
import { parseDocSignature } from '../src/syntax/catalog';

const v217 = parseVersion('2.17.1')!;
const v213 = parseVersion('2.13.2')!;
const v211 = parseVersion('2.11.0')!;

function sig(header: string, version = v217) {
  const result = parseSignature(header, version);
  if (!result.ok) throw new Error(result.message);
  return result.signature;
}

describe('isPlural (port of Skript Utils#isPlural)', () => {
  it.each([
    ['numbers', true, 'number'],
    ['players', true, 'player'],
    ['entities', true, 'entity'],
    ['entity', false, 'entity'],
    ['texts', true, 'text'],
    ['time spans', true, 'time span'],
    ['item types', true, 'item type'],
    ['integer', false, 'integer'],
    ['status', false, 'status'],
  ])('%s', (word, plural, singular) => {
    expect(isPlural(word)).toEqual({ plural, updated: singular });
  });
});

describe('function signatures (StructFunction / FunctionParser)', () => {
  it('parses names, parameters, defaults and return types', () => {
    const s = sig('function giveCoins(p: player, amount: number = 1) :: text');
    expect(s.name).toBe('giveCoins');
    expect(s.parameters.map((p) => [p.name, p.type, p.defaultValue, p.variable])).toEqual([
      ['p', 'player', undefined, '_p'],
      ['amount', 'number', '1', '_amount'],
    ]);
    expect(s.returnType).toBe('text');
    expect(minArguments(s)).toBe(1);
    expect(maxArguments(s)).toBe(2);
  });

  it('accepts all three return syntaxes from 2.14, and only :: and returns before', () => {
    expect(sig('function a() -> text').returnType).toBe('text');
    expect(sig('function a() returns text').returnType).toBe('text');
    const old = parseSignature('function a() -> text', v213);
    expect(old.ok).toBe(false);
    expect(!old.ok && old.message).toContain("the '->' return type needs Skript 2.14 or newer");
  });

  it('reads local functions and list parameters', () => {
    const s = sig('local function total(values: numbers) :: number');
    expect(s.local).toBe(true);
    expect(s.parameters[0].variable).toBe('_values::*');
    expect(isListFunction(s)).toBe(true);
  });

  it('rejects `::` in parameter names, as SCRIPT_PARAMETER_PATTERN does', () => {
    expect(parseSignature('function f(items::*: numbers)', v217).ok).toBe(false);
  });

  it('counts optional parameters only from the end (Signature#getMinParameters)', () => {
    expect(minArguments(sig('function f(a: number = 1, b: number)'))).toBe(2);
  });

  it('reports Skript’s own errors for invalid signatures', () => {
    const bad = (h: string) => {
      const r = parseSignature(h, v217);
      return r.ok ? '' : r.message;
    };
    expect(bad('function bad name(x: number)')).toBe('Invalid function signature: function bad name(x: number)');
    expect(bad('function f(x number)')).toBe("The 1st argument's definition is invalid. It should look like 'name: type' or 'name: type = default value'.");
    expect(bad('function f(x: number, X: text)')).toBe("Each argument's name must be unique, but the name 'X' occurs at least twice.");
    // The lazy signature pattern matches, then the arguments fail to split.
    expect(bad('function f(x: number = (1)')).toBe('Invalid text/variables/parentheses in the arguments of this function');
  });

  it('treats functions with different argument types as overloads from 2.12', () => {
    const a = sig('function describe(n: number)');
    const b = sig('function describe(t: text)');
    const c = sig('function describe(x: number)');
    const d = sig('function describe(n: numbers)');
    expect(sameRegistryKey(a, b, v217)).toBe(false);
    expect(sameRegistryKey(a, c, v217)).toBe(true);
    expect(sameRegistryKey(a, d, v217)).toBe(false);
    expect(sameRegistryKey(a, b, v211)).toBe(true);
  });
});

describe('call arguments (FunctionArgumentParser)', () => {
  it('splits at top-level commas only', () => {
    expect(parseArguments('player, "a, b", (1, 2), {list::%x, y%}').map((a) => a.value)).toEqual(['player', '"a, b"', '(1, 2)', '{list::%x, y%}']);
  });

  it('reads named arguments', () => {
    expect(parseArguments('amount: 5, p: player').map((a) => `${a.name}=${a.value}`)).toEqual(['amount=5', 'p=player']);
  });

  it('counts no arguments for an empty call', () => {
    expect(parseArguments('')).toEqual([]);
  });

  it('reports unclosed groups', () => {
    expect(splitTopLevel('(1, 2')).toBeUndefined();
  });
});

describe('built-in signatures from the docs', () => {
  it('reads `optional` parameters and range notes leniently', () => {
    const location = parseDocSignature('location(x: number, y: number, z: number, world: optional world, yaw: optional number, pitch: optional number)')!;
    expect([minArguments(location), maxArguments(location)]).toEqual([3, 6]);
    const rgb = parseDocSignature('rgb(red: integer between 0 and 255, green: integer between 0 and 255, blue: integer between 0 and 255, alpha: optional integer between 0 and 255)')!;
    expect([minArguments(rgb), maxArguments(rgb)]).toEqual([3, 4]);
    expect(isListFunction(parseDocSignature('sum(ns: numbers)')!)).toBe(true);
  });
});
