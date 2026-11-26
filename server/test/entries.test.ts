import { describe, expect, it } from 'vitest';
import { entryIssues } from '../src/features/entries';
import { parseScript } from '../src/parser/parser';
import { parseVersion } from '../src/skript/version';
import { sk } from './helpers';

function check(text: string, version = '2.17.1') {
  const script = parseScript(text);
  return entryIssues(script, parseVersion(version)!).map((i) => ({
    at: `${i.line + 1}:${script.lines[i.line].text.slice(i.start, i.end)}`,
    code: i.code,
    severity: i.severity,
    message: i.message,
    fix: i.fix?.text,
  }));
}

describe('command entries', () => {
  it('reports a misspelled entry with a fix', () => {
    const issues = check(sk('command /hello:', '\tatrigger:', '\t\tsend "hi"'), '2.16.2');
    expect(issues).toEqual([
      {
        at: '2:atrigger',
        code: 'unknown-entry',
        severity: 'error',
        message: "Unexpected entry 'atrigger'. Check whether it's spelled correctly or remove it. Did you mean 'trigger'?",
        fix: 'trigger',
      },
      { at: '1:command /hello:', code: 'missing-entry', severity: 'error', message: "Required entry 'trigger' is missing", fix: undefined },
    ]);
  });

  it('in 2.17, a command needs a trigger or a subcommand instead of a required trigger entry', () => {
    expect(check(sk('command /hello:', '\tatrigger:', '\t\tsend "hi"')).map((i) => i.message)).toEqual([
      "Unexpected entry 'atrigger'. Check whether it's spelled correctly or remove it. Did you mean 'trigger'?",
      "You must have a 'trigger' entry if there are no subcommands!",
    ]);
    expect(check(sk('command /hello:', '\tsubcommand world:', '\t\ttrigger:', '\t\t\tsend "hi"'))).toEqual([]);
  });

  it('fixes misspelled value entries too', () => {
    const issues = check(sk('command /hello:', '\tdescripton: Says hi', '\ttrigger:', '\t\tsend "hi"'));
    expect(issues.map((i) => [i.at, i.fix])).toEqual([['2:descripton', 'description']]);
  });

  it('explains entries in the wrong form, given twice, or plain code', () => {
    const messages = check(
      sk('command /hello:', '\ttrigger: send "hi"', '\tusage:', '\t\tx', '\tsend "hi"', '\tdescription: a', '\tdescription: b', '\ttrigger:', '\t\tstop'),
    ).map((i) => i.message);
    expect(messages).toEqual([
      "Unexpected entry 'trigger'. Check whether it's spelled correctly or remove it ('trigger' must be a section: end it with ':' and put its code on the lines below)",
      "Unexpected entry 'usage'. Check whether it's spelled correctly or remove it ('usage' takes a value on the same line: 'usage: …')",
      "Unexpected entry 'send \"hi\"'. Check whether it's spelled correctly or remove it. Code in a command goes under 'trigger:'",
      "Unexpected entry 'description'. Check whether it's spelled correctly or remove it (it is already given on line 6)",
    ]);
  });

  it('accepts every entry of the version, case-insensitively, and options in keys', () => {
    const valid = sk(
      'options:',
      '\tperm: my.perm',
      'command /hello <text>:',
      '\tAliases: hi, hey',
      '\tdescription: Says hi',
      '\tusage: /hello <name>',
      '\tpermission: {@perm}',
      '\texecutable by: players',
      '\tcooldown: 5 seconds',
      '\tcooldown message: Wait!',
      '\tcooldown bypass: my.bypass',
      '\tcooldown storage: {cooldowns::%player%}',
      '\ttrigger:',
      '\t\tsend "hi %arg-1%"',
    );
    expect(check(valid, '2.16.2')).toEqual([]);
    expect(check(valid, '2.17.1')).toEqual([]);
    // 2.17 entries do not exist before.
    expect(check(sk('command /x:', '\tsuggestions:', '\t\tstop', '\ttrigger:', '\t\tstop'), '2.16.2').map((i) => i.code)).toEqual(['unknown-entry']);
  });

  it('marks permission message as deprecated in 2.17', () => {
    const issues = check(sk('command /x:', '\tpermission: a', '\tpermission message: no', '\ttrigger:', '\t\tstop'));
    expect(issues).toMatchObject([{ code: 'deprecated-entry', severity: 'hint', at: '3:permission message' }]);
  });

  it('warns about cooldown entries without a cooldown, as Skript does', () => {
    expect(check(sk('command /x:', '\tcooldown message: wait', '\ttrigger:', '\t\tstop'), '2.16.2').map((i) => i.message)).toEqual([
      'command /x has a cooldown message set, but not a cooldown',
    ]);
    expect(check(sk('command /x:', '\tcooldown message: wait', '\ttrigger:', '\t\tstop')).map((i) => i.message)).toEqual([
      'There is a cooldown message set, but not a cooldown',
    ]);
  });

  it('checks subcommands like commands, with root-only entries', () => {
    const issues = check(sk('command /x:', '\tsubcommand a:', '\t\tdescription: no', '\t\tatrigger:', '\t\t\tstop'));
    expect(issues.map((i) => i.message)).toEqual([
      'Only the root of a command may have a description.',
      "Unexpected entry 'atrigger'. Check whether it's spelled correctly or remove it. Did you mean 'trigger'?",
    ]);
  });
});
