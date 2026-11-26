import { describe, expect, it } from 'vitest';
import { definition, hover, references, targetAt, workspaceSymbols } from '../src/features/navigation';
import { prepareRename, rename } from '../src/features/rename';
import { variablesTree } from '../src/features/variablesTree';
import type { FileIndex } from '../src/index/types';
import { loadProject, messagesFor, projectCodes, uriOf } from './project';

const project = loadProject();

/** Position of `needle` (its first character, plus `offset`) on the line containing it. */
function at(file: FileIndex, needle: string, offset = 0): { line: number; character: number } {
  const lines = file.script.lines;
  for (const l of lines) {
    const i = l.text.indexOf(needle);
    if (i !== -1) return { line: l.index, character: i + offset };
  }
  throw new Error(`${needle} not found`);
}

const file = (rel: string) => project.index.get(uriOf(rel))!;
const where = (loc: { uri: string; range: { start: { line: number } } }) => `${loc.uri.slice('file:///project/'.length)}:${loc.range.start.line + 1}`;

describe('project diagnostics', () => {
  it('reports exactly the planted problems', () => {
    expect(projectCodes(project.issues)).toEqual([
      'argument-count@broken.sk:5',
      'duplicate-function@broken.sk:13',
      'duplicate-function@util.sk:2',
      'invalid-function@broken.sk:16',
      'invalid-function@broken.sk:19',
      'undefined-function@broken.sk:6',
      'undefined-function@broken.sk:7',
      'unknown-option@broken.sk:8',
      'unset-variable@broken.sk:11',
      'unset-variable@broken.sk:9',
    ]);
  });

  it('explains argument counts with defaults', () => {
    expect(messagesFor(project.issues, 'broken.sk', 'argument-count')).toEqual(["'giveCoins' takes 1 to 2 arguments, but is called with 3 arguments."]);
  });

  it('suggests the closest variable for a likely typo', () => {
    expect(messagesFor(project.issues, 'broken.sk', 'unset-variable')).toEqual([
      '{quest::%uuid of player%::actve::*} is read here but never set anywhere in the workspace. Did you mean {quest::%uuid of player%::active::*}?',
      '{_totl} is read here but never set in this trigger. Did you mean {_total}?',
    ]);
  });

  it('names the other definition of a duplicate, ignoring overloads and disabled scripts', () => {
    expect(messagesFor(project.issues, 'util.sk', 'duplicate-function')).toEqual([
      "Function 'formatCoins' with the same argument types is also defined at broken.sk:13. Skript loads only one of them.",
    ]);
  });

  it('uses Skript’s own wording for an undefined option', () => {
    expect(messagesFor(project.issues, 'broken.sk', 'unknown-option')).toEqual(['undefined option {@prefx}']);
  });

  it('does not see functions in disabled (-) scripts from other scripts', () => {
    expect(messagesFor(project.issues, 'broken.sk', 'undefined-function')[1]).toContain("Function 'onlyHere' is not defined");
  });

  it('treats same-name functions as duplicates before Skript 2.12', () => {
    const old = loadProject('project', '2.11.0');
    expect(messagesFor(old.issues, 'util.sk', 'duplicate-function')).toContain(
      "Function 'describe' is also defined at util.sk:13. Skript 2.11.0 does not allow two functions with the same name.",
    );
  });

  it('flags built-ins newer than the target version', () => {
    const p = loadProject('builtins', '2.15.4');
    expect(messagesFor(p.issues, 'calls.sk', 'undefined-function')).toEqual([
      "'entity' is a built-in function from Skript 2.16, but your target version is 2.15.4 (skout.skriptVersion).",
    ]);
    expect(projectCodes(loadProject('builtins', '2.16.2').issues)).toEqual([]);
  });

  it('honours skout.knownFunctions for addon functions', () => {
    const p = loadProject('project', undefined, { knownFunctions: ['formatCoin', 'onlyHere'] });
    expect(messagesFor(p.issues, 'broken.sk', 'undefined-function')).toEqual([]);
  });
});

describe('navigation', () => {
  it('goes from a call to its definition in another file', () => {
    const quests = file('quests.sk');
    const target = targetAt(quests, at(quests, 'formatCoins(').line, at(quests, 'formatCoins(').character + 2)!;
    expect(definition(project.index, quests, target).map(where).sort()).toEqual(['broken.sk:13', 'util.sk:2']);
  });

  it('prefers a local function in the same script', () => {
    const quests = file('quests.sk');
    const pos = at(quests, 'helper()', 1);
    expect(definition(project.index, quests, targetAt(quests, pos.line, pos.character)!).map(where)).toEqual(['quests.sk:25']);
  });

  it('finds every call of a function across files', () => {
    const util = file('util.sk');
    const pos = at(util, 'giveCoins(', 1);
    const refs = references(project.index, util, targetAt(util, pos.line, pos.character)!, true).map(where);
    expect(refs.sort()).toEqual(['broken.sk:5', 'quests.sk:10', 'quests.sk:9', 'util.sk:5']);
  });

  it('shows the signature, doc comment and call count on hover', () => {
    const quests = file('quests.sk');
    const pos = at(quests, 'formatCoins(', 1);
    const h = hover(project.index, quests, targetAt(quests, pos.line, pos.character)!, project.syntax);
    const text = (h!.contents as { value: string }).value;
    expect(text).toContain('function formatCoins(n: number) :: text');
    expect(text).toContain('Formats a number of coins for chat.');
    expect(text).toContain('called 2 times');
  });

  it('shows built-in function docs on hover', () => {
    const util = file('util.sk');
    const pos = at(util, 'sum(', 1);
    const text = (hover(project.index, util, targetAt(util, pos.line, pos.character)!, project.syntax)!.contents as { value: string }).value;
    expect(text).toContain('sum(ns: numbers)');
    expect(text).toContain(`Built into Skript ${project.syntax.version.text}`);
  });

  it('shows where a variable is set and read, and its namespace', () => {
    const quests = file('quests.sk');
    const pos = at(quests, '{quest::%uuid of player%::active::*} to', 2);
    const text = (hover(project.index, quests, targetAt(quests, pos.line, pos.character)!, project.syntax)!.contents as { value: string }).value;
    expect(text).toContain('Global variable');
    expect(text).toContain('**Set** in 1 place');
    expect(text).toContain('Namespace `{quest::…}`');
  });

  it('goes from a variable to where it is set, and from {@option} to its entry', () => {
    const quests = file('quests.sk');
    const pos = at(quests, 'send {_quest}', 7);
    expect(definition(project.index, quests, targetAt(quests, pos.line, pos.character)!).map(where)).toEqual(['quests.sk:22']);
    const opt = at(quests, '{@reward}', 3);
    expect(definition(project.index, quests, targetAt(quests, opt.line, opt.character)!).map(where)).toEqual(['quests.sk:2']);
  });

  it('lists functions, commands and options as workspace symbols', () => {
    expect(workspaceSymbols(project.index, 'coins').map((s) => s.name)).toEqual(expect.arrayContaining(['formatCoins', 'giveCoins']));
    expect(workspaceSymbols(project.index, 'quests').map((s) => s.name)).toContain('/quests');
  });
});

describe('rename', () => {
  const options = { annotations: true, versionOf: () => null };

  it('renames a function and every call, for preview', () => {
    const util = file('util.sk');
    const pos = at(util, 'giveCoins(', 2);
    expect(prepareRename(project.index, util, pos.line, pos.character, project.syntax).placeholder).toBe('giveCoins');
    const edit = rename(project.index, util, pos.line, pos.character, 'rewardCoins', project.syntax, options);
    const changes = edit.documentChanges!.flatMap((d) => ('edits' in d ? d.edits.map((e) => `${d.textDocument.uri.slice(16)}:${e.range.start.line + 1}`) : []));
    expect(changes.sort()).toEqual(['broken.sk:5', 'quests.sk:10', 'quests.sk:9', 'util.sk:5']);
    expect(edit.changeAnnotations!['skout.rename'].needsConfirmation).toBe(true);
  });

  it('renames a variable namespace prefix everywhere', () => {
    const quests = file('quests.sk');
    const pos = at(quests, '{quest::settings', 2);
    const edit = rename(project.index, quests, pos.line, pos.character, 'quests', project.syntax, options);
    const edits = edit.documentChanges!.flatMap((d) => ('edits' in d ? d.edits : []));
    expect(edits.every((e) => 'newText' in e && e.newText === 'quests')).toBe(true);
    // quests.sk: variables: entry, set, 2 reads in the if, loop, for each; broken.sk: the typo read
    expect(edits).toHaveLength(7);
  });

  it('rejects names Skript would not accept', () => {
    const util = file('util.sk');
    const pos = at(util, 'giveCoins(', 2);
    expect(() => rename(project.index, util, pos.line, pos.character, 'give coins', project.syntax, options)).toThrow(/not a valid function name/);
    expect(() => rename(project.index, util, pos.line, pos.character, 'describe', project.syntax, options)).toThrow(/already exists/);
    const quests = file('quests.sk');
    const v = at(quests, '{quest::settings', 2);
    expect(() => rename(project.index, quests, v.line, v.character, '_quest', project.syntax, options)).toThrow(/cannot start with _/);
  });

  it('refuses to rename built-in functions', () => {
    const util = file('util.sk');
    const pos = at(util, 'sum(', 1);
    expect(() => prepareRename(project.index, util, pos.line, pos.character, project.syntax)).toThrow(/built into Skript/);
  });
});

describe('variables view', () => {
  it('groups globals by namespace and flags unset ones', () => {
    const tree = variablesTree(project.index);
    const quest = tree.find((n) => n.label === 'quest')!;
    expect(quest.children!.map((c) => c.label)).toEqual(['%…%', 'settings']);
    const dynamic = quest.children![0];
    expect(dynamic.children!.map((c) => `${c.label}${c.unset ? ' (unset)' : ''}`)).toEqual(['active', 'actve (unset)']);
    expect(tree.at(-1)!.label).toBe('Local variables');
  });
});
