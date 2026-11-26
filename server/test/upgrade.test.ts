import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../src/index/workspace';
import type { SkNode } from '../src/parser/types';
import { parseVersion } from '../src/skript/version';
import { loadDumps } from '../src/syntax/load';
import { SyntaxRegistry, type LoadedDump } from '../src/syntax/registry';
import { checkUpgrade, diffDumps, type UpgradeSide } from '../src/upgrade/check';
import { renderReport } from '../src/upgrade/report';
import { FIXTURES, fixture, sk } from './helpers';
import { catalog } from './project';

function skript(version: string, dumps: LoadedDump[] = []): UpgradeSide {
  const registry = new SyntaxRegistry(catalog.forVersion(version), dumps);
  return { registry, version: parseVersion(version)!, label: `Skript ${version}` };
}

function check(text: string, from: UpgradeSide, to: UpgradeSide, scope: Parameters<typeof checkUpgrade>[3] = { kind: 'skript' }) {
  const index = new WorkspaceIndex(from.version);
  index.update('file:///project/scripts.sk', text);
  return checkUpgrade(index, from, to, scope);
}

const kinds = (result: ReturnType<typeof check>) => result.findings.map((f) => `${f.kind}@${f.line + 1}`);

describe('upgrading Skript', () => {
  const scripts = fixture('upgrade/scripts.sk');

  it('finds what 2.15.4 → 2.16.2 breaks in functions and changes in behaviour', () => {
    const result = check(scripts, skript('2.15.4'), skript('2.16.2'));
    expect(kinds(result)).toEqual(['behaviour@10', 'function-clash@12', 'function-type@15']);
    const messages = result.findings.map((f) => f.message);
    expect(messages[1]).toContain("adds a built-in function 'entity(uuid: uuid)' with the same argument types");
    expect(messages[2]).toContain("has no type 'structure type' (used as the parameter 't')");
    // 2.15's structure type was displayed as "Tree Type"; 2.16 has a type with that name.
    expect(result.findings[2].suggestion).toBe("It is now called 'tree type'.");
  });

  it('does not flag a type that kept its name (tree type)', () => {
    const result = check(scripts, skript('2.15.4'), skript('2.16.2'));
    expect(result.findings.some((f) => f.lineText.includes('tree type'))).toBe(false);
  });

  it('finds what 2.16.2 → 2.17.1 breaks, including a removed expression inside a string', () => {
    const result = check(scripts, skript('2.16.2'), skript('2.17.1'));
    expect(kinds(result)).toEqual(['behaviour@3', 'behaviour@5', 'removed@6']);
    expect(result.findings[0].link).toBe('https://github.com/SkriptLang/Skript/releases/tag/2.17.0');
    expect(result.findings[2].message).toContain("'Cooldown Time/Remaining Time/Elapsed Time/Last Usage/Bypass Permission'");
  });

  it('reports nothing for an upgrade to the same version', () => {
    expect(check(scripts, skript('2.17.1'), skript('2.17.1')).findings).toEqual([]);
  });

  it('flags a line that no longer matches any syntax, with the closest replacement', () => {
    // `command "…"` worked while `execute` was optional (2.16); 2.17 requires it.
    const result = check(sk('on join:', '\tcommand "say hi"'), skript('2.16.2'), skript('2.17.1'));
    expect(kinds(result)).toEqual(['removed@2']);
    expect(result.findings[0].suggestion).toContain('execute [the] [bungee[cord]] command[s] %texts%');
  });

  it('flags calls to built-in functions the target does not have', async () => {
    const { dumps } = await loadDumps(['dumps/docs-tool'], [FIXTURES]);
    // Gizmo's gizmoPower() is known with the addon loaded, unknown without it.
    const result = check(sk('on join:', '\tsend "%gizmoPower(2)%" to player'), skript('2.17.1', dumps), skript('2.17.1'));
    expect(kinds(result)).toEqual(['function-removed@2']);
  });
});

describe('upgrading an addon', () => {
  it('compares two dumps of the addon: renamed effects, deprecations', async () => {
    const before = (await loadDumps(['dumps/docs-tool'], [FIXTURES])).dumps;
    const after = (await loadDumps(['dumps/gizmo-2'], [FIXTURES])).dumps;
    const from = skript('2.17.1', before);
    const to = { ...skript('2.17.1', after), label: 'Gizmo 2.0.0' };
    const text = sk('on gizmo charge:', '\tlaunch gizmo at player with power 3', "\tif player's gizmo is charged:", '\t\tstop');
    const result = check(text, { ...from, label: 'Gizmo 1.4.0' }, to, { kind: 'addon', addon: 'Gizmo' });
    expect(kinds(result)).toEqual(['removed@2', 'deprecated@3']);
    expect(result.findings[0].suggestion).toBe('In Gizmo 2.0.0 it is written: `fire [a] gizmo from %location% [with power %number%]`');
    expect(result.findings[1].suggestion).toBe("Checks whether a player's gizmo is charged.");
  });

  it('treats syntax SkriptHub marks as removed as gone in the newest version', async () => {
    const { dumps } = await loadDumps(['dumps/skripthub-Widgets.json'], [FIXTURES]);
    const from = skript('2.17.1', dumps);
    const to = { registry: new SyntaxRegistry(catalog.forVersion('2.17.1'), dumps, { dropRemoved: true }), version: from.version, label: 'Widgets (latest)' };
    const result = check(sk('on join:', '\twobble widget "w"', '\tspin widget "w"'), from, to, { kind: 'addon', addon: 'Widgets' });
    expect(kinds(result)).toEqual(['removed@2']);
  });
});

describe('dump diff', () => {
  it('does not count syntax that moved between kinds as removed', () => {
    const diff = diffDumps(new SyntaxRegistry(catalog.forVersion('2.15.4')), new SyntaxRegistry(catalog.forVersion('2.16.2')), { kind: 'skript' });
    const removed = diff.removed.map((r) => r.name);
    expect(removed).not.toContain('Delay'); // became a section in 2.16
    expect(removed).toContain('On Gamemode Change');
    expect(diff.deprecated.map((d) => d.name)).toContain('Book Title');
  });
});

describe('report', () => {
  it('renders findings with links, sections and the method', () => {
    const result = check(fixture('upgrade/scripts.sk'), skript('2.15.4'), skript('2.17.1'));
    const markdown = renderReport(result, {
      linkFor: (_uri, line) => `../../scripts.sk#L${line + 1}`,
      nameFor: () => 'scripts.sk',
      date: '2026-11-26',
      skoutVersion: '0.4.0',
    });
    expect(markdown).toContain('# Upgrade check: Skript 2.15.4 → Skript 2.17.1');
    expect(markdown).toContain('| Functions that will fail to register | 2 |');
    expect(markdown).toContain('- **[scripts.sk:12](../../scripts.sk#L12)** `function entity(id: uuid) :: entity:`');
    expect(markdown).toContain('([release notes](https://github.com/SkriptLang/Skript/releases/tag/2.17.0))');
    expect(markdown).toContain('## How this was checked');
  });

  it('says plainly when nothing breaks', () => {
    const markdown = renderReport(check(sk('on join:', '\tsend "hi" to player'), skript('2.16.2'), skript('2.17.1')), {
      linkFor: () => '#',
      nameFor: () => 'x',
      date: '2026-11-26',
      skoutVersion: '0.4.0',
    });
    expect(markdown).toContain('**Nothing to change.**');
  });
});

// Skript's own test scripts at 2.17.1 are valid in 2.17.1, so checking an upgrade
// to 2.17.1 must not report them as breaking, except code nested in the test
// framework's `parse:` blocks, which is not real script structure.
const CORPUS = join(__dirname, '..', '..', '.corpus', 'Skript', 'src', 'test', 'skript', 'tests');
describe.skipIf(!existsSync(CORPUS))('Skript’s own 2.17.1 tests, upgraded from 2.16.2', () => {
  it('report no breaking lines outside parse: blocks', () => {
    const index = new WorkspaceIndex(parseVersion('2.16.2')!);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : n.endsWith('.sk') ? [p] : [];
      });
    for (const f of walk(CORPUS)) index.update(`file:///${relative(CORPUS, f).replaceAll('\\', '/')}`, readFileSync(f, 'utf8'));
    const result = checkUpgrade(index, skript('2.16.2'), skript('2.17.1'), { kind: 'skript' });
    const insideParse = (uri: string, line: number) => {
      const file = index.get(uri)!;
      let found = false;
      const visit = (node: SkNode, inParse: boolean) => {
        const here = inParse || /^parse$/i.test(node.key);
        if (node.line === line) found = here;
        node.children.forEach((c) => visit(c, here));
      };
      file.script.structures.forEach((s) => visit(s, false));
      return found;
    };
    const real = result.findings.filter((f) => f.kind === 'removed' && !insideParse(f.uri, f.line));
    expect(real.map((f) => `${f.uri}:${f.line + 1} ${f.lineText}`)).toEqual([]);
  }, 120_000);
});
