import { describe, expect, it } from 'vitest';
import { contextIssues } from '../src/engine/context';
import { WorkspaceIndex } from '../src/index/workspace';
import { parseVersion } from '../src/skript/version';
import { SyntaxRegistry } from '../src/syntax/registry';
import { sk } from './helpers';
import { catalog } from './project';

const registry = new SyntaxRegistry(catalog.forVersion('2.17.1'));

function check(text: string, version = '2.17.1'): string[] {
  const index = new WorkspaceIndex(registry.version);
  const file = index.update('file:///c.sk', text);
  return contextIssues(file, registry, parseVersion(version)!).map((i) => `${i.line + 1}:${i.severity} ${i.message}`);
}

describe('conditionals', () => {
  it('needs an if before else and else if', () => {
    expect(check(sk('on join:', '\tsend "a"', '\telse:', '\t\tsend "b"'))).toEqual([
      "3:error 'else' has to be placed just after another 'if' or 'else if' section",
    ]);
    expect(check(sk('on join:', '\telse if player is op:', '\t\tsend "b"'))).toEqual([
      "2:error 'else if' has to be placed just after another 'if' or 'else if' section",
    ]);
    expect(check(sk('on join:', '\tif player is op:', '\t\tsend "a"', '\telse:', '\t\tsend "b"', '\telse:', '\t\tsend "c"'))).toEqual([
      "6:error 'else' has to be placed just after another 'if' or 'else if' section",
    ]);
  });

  it('accepts chains, implicit conditions and multiline ifs', () => {
    expect(check(sk(
      'on join:',
      '\tif player is op:',
      '\t\tsend "a"',
      '\telse if player is flying:',
      '\t\tsend "b"',
      '\telse:',
      '\t\tsend "c"',
      '\tplayer is sneaking:',
      '\t\tsend "d"',
      '\telse:',
      '\t\tsend "e"',
      '\tif any:',
      '\t\tplayer is op',
      '\t\tplayer is flying',
      '\tthen:',
      '\t\tsend "f"',
      '\telse:',
      '\t\tsend "g"',
    ))).toEqual([]);
  });

  it('checks multiline ifs as SecConditional does', () => {
    expect(check(sk('on join:', '\tif any:', '\t\tplayer is op', '\tsend "x"'))).toEqual([
      "2:error 'if any' sections must contain at least two conditions",
      "2:error 'if any' has to be placed just before a 'then' section",
    ]);
    expect(check(sk('on join:', '\tif:', '\t\t1 is 1', '\t\t2 is 2', '\tthen:', '\t\tstop', '\tthen:', '\t\tstop'))).toEqual([
      "7:error 'then' has to placed just after a multiline 'if' or 'else if' section",
    ]);
  });

  it('stays quiet after a line it does not know, which may be an addon condition', () => {
    expect(check(sk('on join:', '\tsome addon section:', '\t\tsend "a"', '\telse:', '\t\tsend "b"'))).toEqual([]);
  });
});

describe('loops', () => {
  it('needs a loop for loop-value and continue', () => {
    expect(check(sk('on join:', '\tsend "%loop-value%"', '\tcontinue', '\tloop all players:', '\t\tsend "%loop-player%" to loop-player', '\t\tcontinue'))).toEqual([
      "2:error There's no loop that matches 'loop-value'",
      "3:error The 'continue' effect may only be used in loops",
    ]);
  });

  it('ignores loop- in variable names, text and comments', () => {
    expect(check(sk('on join:', '\tset {loop-value} to 1 # loop-value', '\tsend "loop-value"'))).toEqual([]);
  });

  it('checks exit levels', () => {
    expect(check(sk('on join:', '\texit loop', '\tloop 3 times:', '\t\texit 2 loops'))).toEqual([
      "2:error Can't stop any loops as there are no loops present",
      "4:error Can't stop 2 loops as there are only 1 loops present",
    ]);
  });
});

describe('return', () => {
  it('is only allowed in functions with a return type, and not after a delay', () => {
    expect(check(sk(
      'on join:',
      '\treturn 1',
      'function a():',
      '\treturn 1',
      'function b() :: number:',
      '\twait 1 tick',
      '\treturn 1',
      'function c() :: number:',
      '\treturn 1',
    ))).toEqual([
      '2:error The return statement cannot be used here',
      "4:error The function 'a' doesn't return any value. Please use 'stop' or 'exit' if you want to stop the trigger.",
      "7:error A return statement after a delay is useless, as the calling trigger will resume when the delay starts (and won't get any returned value)",
    ]);
  });

  it('is allowed in a 2.17 command trigger, which may return a result', () => {
    const command = sk('command /x:', '\ttrigger:', '\t\treturn 1');
    expect(check(command, '2.17.1')).toEqual([]);
    expect(check(command, '2.16.2')).toEqual(['3:error The return statement cannot be used here']);
  });
});

describe('unreachable code', () => {
  it('warns about the statement after one that stops execution', () => {
    expect(check(sk('on join:', '\tstop', '\tsend "a"', '\tsend "b"'))).toEqual(['3:warning Unreachable code. The previous statement stops further execution.']);
  });

  it('does not warn after an inline condition, and honours suppress / unsuppress', () => {
    expect(check(sk('function f() :: boolean:', '\treturn false if 1 is 2', '\treturn true'))).toEqual([]);
    expect(check(sk('on join:', '\tsuppress unreachable code warnings', '\tstop', '\tstop', '\tsend "x"', '\tunsuppress unreachable code warnings', '\tstop', '\tstop'))).toEqual([
      '8:warning Unreachable code. The previous statement stops further execution.',
    ]);
  });
});
