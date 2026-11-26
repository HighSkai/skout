import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completions } from '../src/features/completion';
import { classify, syntaxHover, unrecognizedIssues } from '../src/features/syntax';
import { extract } from '../src/index/extract';
import type { FileIndex } from '../src/index/types';
import { WorkspaceIndex } from '../src/index/workspace';
import { parseScript } from '../src/parser/parser';
import type { SkNode } from '../src/parser/types';
import { importDump, parseDumpText } from '../src/syntax/importers';
import { loadDumps } from '../src/syntax/load';
import { SyntaxRegistry } from '../src/syntax/registry';
import { FIXTURES, fixture, sk } from './helpers';
import { catalog } from './project';

const registry = new SyntaxRegistry(catalog.forVersion('2.16.2'));
const DUMPS = join(FIXTURES, 'dumps');

function fileOf(text: string, r = registry): FileIndex {
  return extract('file:///t.sk', parseScript(text), r.version);
}

function lines(file: FileIndex, r = registry): string[] {
  const out: string[] = [];
  const visit = (node: SkNode) => {
    const s = classify(file, node, r);
    if (s && s.kinds.length > 0) {
      // The most specific match, as hover shows it; any match means the line is recognised.
      const best = s.hit && r.bestMatch(s.kinds, s.text, (ref) => ref.entry.id === 'SecConditional');
      out.push(`${s.role}:${best ? best.entry.id : 'NONE'}`);
    }
    node.children.forEach(visit);
  };
  file.script.structures.forEach(visit);
  return out;
}

describe('importers', () => {
  it('reads SkriptHub Docs Tool files, naming the addon after the file', () => {
    const path = join(DUMPS, 'docs-tool', 'Gizmo.json');
    const dump = importDump(parseDumpText(readFileSync(path, 'utf8')), path);
    expect(dump.source).toBe('skripthub-docs-tool');
    expect(dump.addons).toEqual({ Gizmo: '1.4.0' });
    const fn = dump.entries.find((e) => e.kind === 'function')!;
    expect(fn).toMatchObject({ id: 'gizmoPower', returns: 'number', addon: 'Gizmo', since: '1.3.0' });
    expect(dump.entries.find((e) => e.kind === 'event')).toMatchObject({ eventValues: ['player'], cancellable: true });
    expect(dump.entries.find((e) => e.kind === 'effect')).toMatchObject({ requirements: ['Paper'] });
  });

  it('reads SkriptHub catalog records, splitting packed patterns and keeping removals', () => {
    const dump = importDump(parseDumpText(readFileSync(join(DUMPS, 'skripthub-Widgets.json'), 'utf8')), 'x.json');
    expect(dump.source).toBe('skripthub-api');
    const spin = dump.entries.find((e) => e.id === 'widgets:effect:spin')!;
    expect(spin.patterns).toEqual(['spin [the] widget %string%', 'spin [the] widget %string% for %timespan%']);
    expect(spin.requirements).toEqual(['WidgetLib', 'Minecraft 1.20+']);
    expect(spin.keywords).toEqual(['spin', 'rotate']);
    expect(dump.entries.find((e) => e.name === 'Old Widget Wobble')).toMatchObject({ id: 'skripthub:9002', deprecated: true, removedIn: '2.0' });
  });

  it('repairs the unescaped quotes in Skript archives up to 2.10.2', () => {
    const dump = importDump(parseDumpText(readFileSync(join(DUMPS, 'old-archive.json'), 'utf8')), 'old.json');
    expect(dump.entries[0].patterns).toEqual(['"region name"', 'pattern_end']);
  });

  it('loads every .json in a folder listed in skout.syntaxDumps', async () => {
    const result = await loadDumps(['dumps/docs-tool', 'dumps/skripthub-Widgets.json', 'missing.json'], [FIXTURES]);
    expect(result.dumps.map((d) => Object.keys(d.dump.addons).join())).toEqual(['Gizmo', 'Widgets,Skript']);
    expect(result.errors).toEqual(['missing.json: not found']);
  });
});

describe('line classification', () => {
  it('recognises every line of the real-world fixtures', () => {
    for (const name of ['valid/shop-gui.sk', 'valid/quests.sk', 'valid/stats.sk']) {
      expect(lines(fileOf(fixture(name))).filter((l) => l.endsWith('NONE')), name).toEqual([]);
    }
  });

  it('matches events, effects, conditions and sections', () => {
    const file = fileOf(sk('on join:', '\tsend "hi" to player', '\tif player is op:', '\t\tkill player', '\tloop all players:', '\t\tstop', 'every 5 minutes:', '\tbroadcast "x"'));
    // Skript 2.16's docs.json uses class names for most ids and short names for events.
    expect(lines(file)).toEqual([
      'event:join',
      'statement:EffMessage',
      'condition:CondIsOp',
      'statement:EffKill',
      'section:SecLoop',
      'statement:EffExit',
      'event:periodical',
      'statement:EffBroadcast',
    ]);
  });

  it('skips options, command entries and function headers', () => {
    expect(lines(fileOf(sk('options:', '\tx: y', 'command /a:', '\tpermission: a.b', '\ttrigger:', '\t\tstop', 'function f():', '\tstop')))).toEqual([
      'statement:EffExit',
      'statement:EffExit',
    ]);
  });
});

describe('unrecognized syntax', () => {
  const issues = (text: string, mode: 'typos' | 'all' = 'typos', r = registry) => unrecognizedIssues(fileOf(text, r), r, mode);

  it('reports a misspelled word with a quick fix', () => {
    const result = issues(sk('on join:', '\tsned "hi" to player'));
    expect(result.map((i) => i.message)).toEqual([
      "Skript does not know 'sned' here. Did you mean 'send'? (Message: send %objects%)",
    ]);
    expect(result[0].fix).toEqual({ line: 1, start: 1, end: 5, text: 'send' });
  });

  it('catches typos in events and in conditions after if', () => {
    expect(issues(sk('on jion:', '\tstop')).map((i) => i.fix?.text)).toEqual(['join']);
    expect(issues(sk('on join:', '\tif {_list::*} contians "a":', '\t\tstop')).map((i) => i.fix?.text)).toEqual(['contain']); // the pattern is `%texts% contain[s] %texts%`
  });

  it('misses typos that still fit a generic pattern, rather than guess', () => {
    // `X has Y` fits PropCondContains with any X and Y, so the line counts as recognised.
    expect(issues(sk('on join:', '\tif player has permision "vip":', '\t\tstop'))).toEqual([]);
  });

  it('stays quiet about lines it cannot fix, unless asked for all', () => {
    const text = sk('on join:', '\tfrobnicate the gizmo');
    expect(issues(text)).toEqual([]);
    const all = issues(text, 'all');
    expect(all.map((i) => i.severity)).toEqual(['information']);
    expect(all[0].message).toContain('matches no known syntax');
  });

  it('does not turn a word into is/are to force a match', () => {
    expect(issues(sk('on join:', '\tarea effect player'))).toEqual([]);
  });

  it('recognises addon syntax once its dump is loaded', async () => {
    const { dumps } = await loadDumps(['dumps/docs-tool', 'dumps/skripthub-Widgets.json'], [FIXTURES]);
    const withAddons = new SyntaxRegistry(catalog.forVersion('2.16.2'), dumps);
    expect(withAddons.addons).toEqual(['Gizmo', 'Widgets']);
    const text = sk('on gizmo charge:', "\tif player's gizmo is charged:", '\t\tlaunch gizmo at player with power 3', '\tspin widget "w"');
    expect(lines(fileOf(text, withAddons), withAddons)).toEqual([
      'event:EvtGizmoCharge',
      'condition:CondGizmoCharged',
      'statement:EffGizmoLaunch',
      'statement:widgets:effect:spin',
    ]);
    // (`launch gizmoo at player` would still fit Skript's `launch %firework effects% at %locations%`.)
    expect(issues(sk('on join:', '\tspinn widget "w"'), 'typos', withAddons).map((i) => i.fix?.text)).toEqual(['spin']);
    // SkriptHub's copy of Skript syntax is ignored in favour of the real Skript dump.
    expect(withAddons.patterns('effect').some((r) => r.entry.id === 'EffFrobnicate')).toBe(false);
    expect(withAddons.functions.has('gizmoPower')).toBe(true);
  });
});

describe('syntax hover', () => {
  it('shows the entry a line matched, with its pattern and description', () => {
    const file = fileOf(sk('on join:', '\tbroadcast "hi"'));
    const node = file.script.structures[0].children[0];
    const text = (syntaxHover(file, node, registry)!.contents as { value: string }).value;
    expect(text).toContain('**Broadcast** · Effect · Skript');
    expect(text).toContain('broadcast %objects%');
  });
});

describe('completion', () => {
  const at = (text: string, line: number, character: number) => {
    const index = new WorkspaceIndex(registry.version);
    const file = index.update('file:///t.sk', text);
    return completions({ index, registry, file, lineText: text.split('\n')[line], line, character });
  };
  const labels = (items: ReturnType<typeof at>) => items.map((i) => i.label);

  it('offers structures and events at the top level', () => {
    const items = at('', 0, 0);
    expect(labels(items)).toEqual(expect.arrayContaining(['command', 'function', 'options', 'on join']));
    const join = items.find((i) => i.label === 'on join')!;
    expect((join.textEdit as { newText: string }).newText).toBe('on join:\n\t$0');
  });

  it('offers only events after `on `', () => {
    const items = at('on jo', 0, 5);
    expect(items.every((i) => i.kind === 23 /* Event */)).toBe(true);
    expect(labels(items)).toContain('join');
  });

  it('offers effects, conditions and sections with snippets at the start of a statement', () => {
    const items = at(sk('on join:', '\tse'), 1, 3);
    const send = items.find((i) => i.label === 'send %objects%')!;
    expect((send.textEdit as { newText: string; range: { start: { character: number } } }).newText).toBe('send ${1:objects}');
    expect((send.textEdit as { range: { start: { character: number } } }).range.start.character).toBe(1);
    expect(labels(items)).toEqual(expect.arrayContaining(['if', 'loop %objects%']));
  });

  it('offers conditions after if', () => {
    const items = at(sk('on join:', '\tif pl'), 1, 6);
    expect(items.every((i) => i.kind === 24 /* Operator: conditions */)).toBe(true);
    expect((items.find((i) => i.label === '%offline players% is op')!.textEdit as { newText: string }).newText).toBe('${1:offline players} is op:\n\t$0');
  });

  it('offers command entries directly under a command', () => {
    expect(labels(at(sk('command /x:', '\tperm'), 1, 5))).toEqual(expect.arrayContaining(['trigger', 'permission', 'cooldown']));
  });

  it('offers variables after { and options after {@', () => {
    const text = sk('options:', '\tprefix: x', 'on join:', '\tset {coins::%player%} to 1', '\tset {_x} to {', '\tsend "{@');
    expect(labels(at(text, 4, 14))).toEqual(expect.arrayContaining(['{coins::%player%}', '{_x}']));
    expect(labels(at(text, 5, 9))).toEqual(['{@prefix}']);
  });

  it('offers your functions and built-in ones as calls', () => {
    const items = at(sk('function reward(p: player, n: number):', '\tstop', 'on join:', '\tset {_x} to re'), 3, 15);
    expect((items.find((i) => i.label === 'reward()')!.textEdit as { newText: string }).newText).toBe('reward(${1:p}, ${2:n})');
    expect(labels(items)).toContain('floor()');
  });

  it('offers nothing inside the text of a string or a comment', () => {
    expect(at(sk('on join:', '\tsend "hel'), 1, 10)).toEqual([]);
    expect(at(sk('on join:', '\tstop # no'), 1, 10)).toEqual([]);
  });
});
