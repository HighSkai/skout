import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { functionLookup, semanticIssues } from '../src/engine/analyze';
import { Engine } from '../src/engine/engine';
import { toDiagnostics } from '../src/features/diagnostics';
import { projectIssues } from '../src/features/project';
import { unrecognizedIssues } from '../src/features/syntax';
import { SyntaxRegistry } from '../src/syntax/registry';
import { WorkspaceIndex } from '../src/index/workspace';
import { defaultSettings } from '../src/settings';
import { fixture } from './helpers';
import { catalog } from './project';

/** A realistic file of at least `lines` lines, built from the fixtures with renamed functions. */
export function bigScript(lines: number, prefix = ''): string {
  const parts = ['valid/shop-gui.sk', 'valid/stats.sk'].map(fixture);
  const out: string[] = [];
  let copy = 0;
  while (out.length < lines) {
    for (const part of parts) out.push(...part.replace(/openShop/g, `openShop${prefix}${copy}`).split('\n'));
    copy++;
  }
  return out.join('\n');
}

function percentile(times: number[], p: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

describe('performance', () => {
  const syntax = catalog.forVersion(undefined);

  it('handles a keystroke in a 2,000-line file well inside the 100 ms budget', () => {
    const text = bigScript(2000);
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2000);
    const index = new WorkspaceIndex(syntax.version);

    // What the server does per keystroke: re-parse and re-index the file, then publish its diagnostics.
    for (let i = 0; i < 5; i++) toDiagnostics(index.update('file:///big.sk', text).script.issues, defaultSettings);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const edited = `${text}\n# edit ${i}`;
      const start = performance.now();
      toDiagnostics(index.update('file:///big.sk', edited).script.issues, defaultSettings);
      times.push(performance.now() - start);
    }
    const p95 = percentile(times, 0.95);
    console.log(`2,000-line keystroke: median ${percentile(times, 0.5).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    expect(p95).toBeLessThan(100);
  });

  it('matches every line of a 2,000-line file against Skript syntax within budget', () => {
    const registry = new SyntaxRegistry(syntax);
    const index = new WorkspaceIndex(registry.version);
    const text = bigScript(2000);
    const cold = performance.now();
    unrecognizedIssues(index.update('file:///big.sk', text), registry, 'typos');
    const coldMs = performance.now() - cold;
    // After that, lines are cached by text: a keystroke re-matches only the line that changed.
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const file = index.update('file:///big.sk', `${text}\non join:\n\tsend "edit ${i}" to player`);
      unrecognizedIssues(file, registry, 'typos');
      times.push(performance.now() - start);
    }
    const p95 = percentile(times, 0.95);
    console.log(`syntax matching, 2,000 lines: first pass ${coldMs.toFixed(0)} ms, then per keystroke p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(100);
  });

  it('type-checks a 2,000-line file, then only the edited line per keystroke', () => {
    const registry = new SyntaxRegistry(syntax);
    const engine = new Engine(registry);
    const index = new WorkspaceIndex(registry.version);
    const text = bigScript(2000);
    const cold = performance.now();
    const file = index.update('file:///big.sk', text);
    semanticIssues(file, registry, engine, functionLookup(index, file.uri, registry));
    const coldMs = performance.now() - cold;
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const edited = index.update('file:///big.sk', `${text}\non join:\n\tset {_x} to ${i} + length of "edit ${i}"`);
      semanticIssues(edited, registry, engine, functionLookup(index, edited.uri, registry));
      times.push(performance.now() - start);
    }
    const p95 = percentile(times, 0.95);
    console.log(`type checking, 2,000 lines: first pass ${coldMs.toFixed(0)} ms, then per keystroke p95 ${p95.toFixed(1)} ms`);
    expect(coldMs).toBeLessThan(2000);
    expect(p95).toBeLessThan(100);
  });

  it('re-checks a 100,000-line project in the background quickly', () => {
    const index = new WorkspaceIndex(syntax.version);
    for (let f = 0; f < 50; f++) index.update(`file:///s${f}.sk`, bigScript(2000, `f${f}_`));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      projectIssues({ index, catalog, syntax, version: syntax.version, settings: defaultSettings });
      times.push(performance.now() - start);
    }
    const median = percentile(times, 0.5);
    console.log(`project pass over 50 files / 100k lines: median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(1000);
  });
});
