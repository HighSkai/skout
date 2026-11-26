import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScript, walk } from '../src/parser/parser';
import { codes, fixture, issues, outline, sk } from './helpers';

describe('valid real-world scripts', () => {
  it.each(['valid/shop-gui.sk', 'valid/quests.sk', 'valid/stats.sk'])('%s has no issues', (path) => {
    expect(codes(fixture(path))).toEqual([]);
  });

  it('builds the tree of a GUI script with nested if / else if / loop', () => {
    const script = parseScript(fixture('valid/shop-gui.sk'));
    expect(script.structures.map((s) => `${s.structure}: ${s.key}`)).toEqual([
      'options: options',
      'command: command /shop [<integer>]',
      'function: function openShop(p: player, page: integer = 1)',
      'event: on inventory click',
    ]);
    const fn = script.structures[2];
    const loop = fn.children.find((c) => c.key.startsWith('loop'))!;
    expect(loop.children.map((c) => c.key)).toEqual([
      'if {_slot} >= 45',
      'set {_item} to loop-value',
      'if {shop::price::%loop-index%} is not set',
      'else if {shop::price::%loop-index%} <= 0',
      'else',
      'add 1 to {_slot}',
    ]);
    expect(fn.lastLine).toBe(34);
  });

  it('keeps command entries and trigger separate', () => {
    const command = parseScript(fixture('valid/shop-gui.sk')).structures[1];
    expect(command.children.map((c) => `${c.kind}:${c.key.split(':')[0]}`)).toEqual([
      'simple:permission',
      'simple:permission message',
      'simple:aliases',
      'simple:usage',
      'section:trigger',
    ]);
  });

  it('ignores everything inside a ### block comment', () => {
    const script = parseScript(fixture('valid/quests.sk'));
    expect(script.structures.map((s) => s.key)).not.toContain('on right click on sign');
  });

  it('classifies structures using Skript’s structure patterns', () => {
    const script = parseScript(
      sk('using for loops', 'aliases:', '\tores = diamond ore, emerald ore', 'local function f():', '\tstop', 'every 5 minutes:', '\tstop', 'auto reload'),
    );
    expect(script.structures.map((s) => s.structure)).toEqual(['using', 'aliases', 'function', 'event', 'other']);
  });
});

describe('indentation (mirrors SectionNode#load_i)', () => {
  it('lets each top-level structure choose its own indent unit', () => {
    const text = sk('on join:', '\tsend "a"', 'on quit:', '    send "b"', '    if true is true:', '        send "c"');
    expect(codes(text)).toEqual(['indent-style@4']);
    expect(issues(text)[0].severity).toBe('information');
  });

  it('reports a structure whose own indentation mixes tabs and spaces', () => {
    expect(codes(sk('on join:', '\t  send "a"'))).toEqual(['indent-mixed@2']);
  });

  it('reports a line that mixes tabs and spaces inside a structure', () => {
    expect(codes(sk('on join:', '\tif true is true:', '\t\tsend "a"', '\t    send "b"'))).toEqual(['indent-mixed@4']);
  });

  it('reports a line indented deeper than its section allows, in Skript’s words', () => {
    const result = issues(sk('on join:', '\tsend "a"', '\t\tsend "b"', '\t\tsend "c"'));
    // Reported once; the tree is recovered so the following line is not flagged again.
    expect(result.map((i) => `${i.code}@${i.line + 1}`)).toEqual(['indent-unexpected@3']);
    expect(result[0].message).toBe(
      "Indentation error: expected 1 tab, but found 2 tabs. If line 2 should start a section, it needs a ':' at the end.",
    );
  });

  it('reports an over-indented line after a complete section', () => {
    const result = issues(sk('on join:', '\tif true is true:', '\t\tsend "a"', '\t\t\t\tsend "b"'));
    expect(result.map((i) => i.message)).toEqual(['Indentation error: expected 2 tabs, but found 4 tabs.']);
  });

  it('reports a partial indent unit', () => {
    const result = issues(sk('command /x:', '    trigger:', '        send "a"', '      send "b"'));
    expect(result.map((i) => `${i.code}@${i.line + 1}`)).toEqual(['indent-unexpected@4']);
    expect(result[0].message).toBe('Indentation error: expected 8 spaces, but found 6 spaces.');
  });

  it('reports indentation at the top level', () => {
    const result = issues(sk('on join:', '\tsend "a"', '', ' send "b"'));
    expect(result.map((i) => i.message)).toEqual(['Indentation error: expected 1 tab, but found 1 space.']);
  });

  it('closes several sections at once when indentation drops', () => {
    const script = parseScript(sk('on join:', '\tif true is true:', '\t\tif false is false:', '\t\t\tsend "deep"', '\tsend "back"'));
    expect(script.issues).toEqual([]);
    expect(outline(script)).toBe(
      ['on join: [event]', '  if true is true:', '    if false is false:', '      send "deep"', '  send "back"'].join('\n'),
    );
  });

  it('ignores the indentation of comments and blank lines', () => {
    expect(codes(sk('on join:', '# top-level comment', '\tsend "a"', '        # oddly indented comment', '', '\tsend "b"'))).toEqual([]);
  });
});

describe('missing colon', () => {
  it('detects a missing colon on a nested section header and recovers the tree', () => {
    const script = parseScript(sk('on join:', '\tif player is op', '\t\tsend "hi"', '\t\tsend "there"', '\tsend "done"'));
    expect(codes(script)).toEqual(['missing-colon@2']);
    expect(outline(script)).toBe(
      ['on join: [event]', '  if player is op: [recovered]', '    send "hi"', '    send "there"', '  send "done"'].join('\n'),
    );
  });

  it('detects a missing colon on a top-level structure', () => {
    const script = parseScript(sk('on join', '    send "hi"', '    send "there"'));
    expect(codes(script)).toEqual(['missing-colon@1']);
    expect(script.structures[0].structure).toBe('event');
    expect(script.structures[0].children).toHaveLength(2);
  });

  it('detects a missing colon on a command trigger', () => {
    expect(codes(sk('command /spawn:', '\ttrigger', '\t\tteleport player to spawn of world "world"'))).toEqual(['missing-colon@2']);
  });

  it('does not guess a missing colon when the next line is two levels deeper', () => {
    expect(codes(sk('on join:', '\tsend "a"', '\t\t\tsend "b"'))).toEqual(['indent-unexpected@3']);
  });
});

describe('empty sections', () => {
  it('warns about a section with nothing under it', () => {
    const result = issues(sk('on join:', '\tif player is op:', '\tsend "a"'));
    expect(result.map((i) => `${i.code}@${i.line + 1}:${i.severity}`)).toEqual(['empty-section@2:warning']);
  });

  it('warns about an empty section at the end of the file', () => {
    expect(codes(sk('on join:', '\tsend "a"', '', 'on quit:', ''))).toEqual(['empty-section@4']);
  });

  it('does not count comments as content', () => {
    expect(codes(sk('on join:', '\t# todo'))).toEqual(['empty-section@1']);
  });
});

describe('unclosed strings, expressions and brackets', () => {
  it('reports them on code lines', () => {
    expect(codes(sk('on join:', '\tsend "hello to player', '\tsend "50% off"', '\tset {_x to 1'))).toEqual([
      'unclosed-string@2',
      'unclosed-percent@3',
      'unclosed-bracket@4',
    ]);
  });

  it('does not check raw text in options, aliases and command entries', () => {
    const text = sk(
      'options:',
      '\tsale: 50% off (today only',
      'aliases:',
      '\tweird = "stone',
      'command /sale:',
      '\tusage: /sale <amount> (50% max',
      '\tpermission message: &cNo "access',
      '\ttrigger:',
      '\t\tsend "{@sale}"',
    );
    expect(codes(text)).toEqual([]);
  });

  it('trusts {@options} whose value contains brackets, as Skript substitutes them as text', () => {
    // From Skript's own StructFunction test: the option supplies the opening bracket.
    const text = sk('function {@function}) :: boolean:', '\treturn true', '', 'options:', '\tfunction: foo(');
    expect(codes(text)).toEqual([]);
  });

  it('still checks lines whose options are plain values', () => {
    expect(codes(sk('options:', '\tname: My Server', 'on join:', '\tsend "{@name}'))).toEqual(['unclosed-string@4']);
  });

  it('still checks the code inside a command trigger', () => {
    expect(codes(sk('command /sale:', '\ttrigger:', '\t\tsend "unclosed'))).toEqual(['unclosed-string@3']);
  });

  it('treats an unbalanced [ or ] as a warning, not an error', () => {
    const result = issues(sk('on join:', '\tset {_x} to {_list::*}[1'));
    expect(result.map((i) => `${i.code}:${i.severity}`)).toEqual(['unclosed-bracket:warning']);
  });
});

describe('options', () => {
  it('collects entries, nested sections as dotted keys, and unescapes ##', () => {
    const script = parseScript(fixture('valid/shop-gui.sk') + '\n' + sk('options:', '\tcolors:', '\t\tprimary: &a', '\t\tsecondary: &7'));
    expect(Object.fromEntries([...script.options].map(([k, v]) => [k, v.value]))).toEqual({
      prefix: '&8[&6Shop&8]&r',
      accent: '<#f5c542>',
      'max-page': '3',
      'colors.primary': '&a',
      'colors.secondary': '&7',
    });
    expect(script.options.get('accent')?.line).toBe(4);
  });
});

describe('comments', () => {
  it('reports an unclosed block comment', () => {
    expect(codes(sk('on join:', '\tsend "a"', '###', 'on quit:', '\tsend "b"'))).toEqual(['unclosed-block-comment@3']);
  });

  it('warns when # silently starts a comment inside a value', () => {
    const result = issues(sk('options:', '\taccent: <#f5c542>'));
    expect(result.map((i) => `${i.code}@${i.line + 1}:${i.start}`)).toEqual(['accidental-comment@2:10']);
  });

  it('does not warn about an ordinary trailing comment', () => {
    expect(codes(sk('on join:', '\tsend "a" # greet'))).toEqual([]);
  });
});

describe('the integration test workspace', () => {
  it('broken.sk contains exactly the planted problems', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'test-workspace', 'scripts', 'broken.sk'), 'utf8');
    expect(codes(text).sort()).toEqual([
      'accidental-comment@3',
      'empty-section@12',
      'indent-unexpected@10',
      'missing-colon@6',
      'unclosed-bracket@9',
      'unclosed-percent@8',
      'unclosed-string@16',
    ]);
  });
});

describe('tolerance while typing', () => {
  it('never throws and always returns a tree, whatever the input', () => {
    const pieces = ['on join:', '\t', '\tif ', '"', '%', '{', '}', '(', ')', '###', '#', '  ', '\t\t', ':', 'send "x', 'else:', '\r\n', '\n'];
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let run = 0; run < 500; run++) {
      let text = '';
      const length = Math.floor(random() * 40);
      for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)];
      const script = parseScript(text);
      let count = 0;
      walk(script.structures, () => count++);
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the rest of the file usable after a half-typed line', () => {
    const script = parseScript(sk('on join:', '\tif player', '\t\t', 'function greet(p: player):', '\tsend "hi" to {_p}'));
    expect(script.structures.map((s) => s.structure)).toEqual(['event', 'function']);
    expect(script.structures[1].children).toHaveLength(1);
  });
});
