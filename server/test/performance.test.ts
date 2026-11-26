import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { toDiagnostics } from '../src/features/diagnostics';
import { parseScript } from '../src/parser/parser';
import { defaultSettings } from '../src/settings';
import { fixture } from './helpers';

/** A realistic file of at least `lines` lines, built from the fixtures with renamed functions. */
export function bigScript(lines: number): string {
  const parts = ['valid/shop-gui.sk', 'valid/stats.sk'].map(fixture);
  const out: string[] = [];
  let copy = 0;
  while (out.length < lines) {
    for (const part of parts) out.push(...part.replace(/openShop/g, `openShop${copy}`).split('\n'));
    copy++;
  }
  return out.join('\n');
}

describe('performance', () => {
  it('parses and diagnoses a 2,000-line file well inside the 100 ms per-keystroke budget', () => {
    const text = bigScript(2000);
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2000);

    // Warm up the JIT, then time what one keystroke costs: a full reparse of the file.
    for (let i = 0; i < 5; i++) toDiagnostics(parseScript(text), defaultSettings);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const edited = text + `\n# edit ${i}`;
      const start = performance.now();
      toDiagnostics(parseScript(edited), defaultSettings);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`2,000-line file: median ${times[15].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    expect(p95).toBeLessThan(100);
  });
});
