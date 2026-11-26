/**
 * Matching script lines against known syntax: hover docs for a line, and
 * conservative "unrecognized syntax" diagnostics.
 *
 * Which syntax a line can be follows how Skript loads a script: a top-level
 * section is an event (StructEvent) unless it is another structure; inside a
 * trigger a plain line is an effect or a condition, `if`/`else if`/`while`
 * take a condition, and any other section header is a section, an effect with
 * a section, or a condition (SecConditional's implicit `<condition>:` form).
 */
import { MarkupKind, type Hover } from 'vscode-languageserver';
import { scanLine, substituteOptions } from '../index/extract';
import type { FileIndex } from '../index/types';
import type { Issue, SkNode } from '../parser/types';
import type { SyntaxKind } from '../syntax/schema';
import type { PatternRef, SyntaxRegistry } from '../syntax/registry';
import { cleanDescription } from './navigation';

export type UnrecognizedMode = 'off' | 'typos' | 'all';

export interface LineSyntax {
  readonly node: SkNode;
  /** What the line was matched as. */
  readonly role: 'event' | 'structure' | 'statement' | 'condition' | 'section' | 'call' | 'keyword';
  /** The text that was matched (options substituted, `on`/`if`/`:` removed). */
  readonly text: string;
  /** Column where `text` starts in the line, when it maps one to one. */
  readonly column: number;
  readonly kinds: readonly SyntaxKind[];
  readonly hit?: PatternRef;
}

const STATEMENT: SyntaxKind[] = ['effect', 'condition', 'section'];
const SECTION_HEADER: SyntaxKind[] = ['section', 'effect', 'condition'];
const CONDITION: SyntaxKind[] = ['condition'];
const EVENT: SyntaxKind[] = ['event'];
const STRUCTURE: SyntaxKind[] = ['structure'];

/** SecConditional's own patterns are handled here, so they never match a plain statement. */
export const isConditional = (ref: PatternRef) => ref.entry.id === 'SecConditional';

const CALL_ONLY = /^[\p{Alphabetic}_][\p{Alphabetic}\d_]*\(.*\)$/u;
/** `key: value` lines inside addon sections are entries, not statements. */
const ENTRY_LINE = /^[a-z][\w -]*:\s+\S/i;

/** Classifies one node, or returns undefined for lines that are not syntax (options, entries, headers Skout parses itself). */
export function classify(file: FileIndex, node: SkNode, registry: SyntaxRegistry): LineSyntax | undefined {
  let top = node;
  while (top.parent) top = top.parent;
  const structure = top.structure;
  const raw = node.key;
  const line = file.script.lines[node.line];
  const substituted = substituteOptions(raw, file.script.options);
  const offset = substituted === raw ? line.start : -1;
  const make = (role: LineSyntax['role'], text: string, at: number, kinds: SyntaxKind[], exclude?: (r: PatternRef) => boolean): LineSyntax => ({
    node,
    role,
    text,
    column: offset === -1 ? -1 : offset + at,
    kinds,
    hit: kinds.length > 0 ? registry.match(kinds, text, exclude) : undefined,
  });

  if (node.depth === 0) {
    if (structure === 'event') {
      const m = /^(?:on\s+)?(?:(?:un)?cancelled\s+|(?:any|all)\s+)?(.+?)(?:\s+with\s+priority\s+\w+)?$/i.exec(substituted);
      const text = m ? m[1] : substituted;
      return make('event', text, substituted.indexOf(text), EVENT);
    }
    if (structure === 'using' || structure === 'other') return make('structure', substituted, 0, STRUCTURE);
    return undefined; // command, function, options, variables, aliases
  }

  if (structure === 'options' || structure === 'aliases' || structure === 'variables') return undefined;
  if (structure === 'command' && (node.parent === top || /^subcommand\b/i.test(raw))) return undefined; // command entries
  if (ENTRY_LINE.test(substituted)) return undefined;

  if (node.kind === 'section') {
    if (/^else$/i.test(substituted) || /^then(?:\s+run)?$/i.test(substituted)) return make('keyword', substituted, 0, []);
    if (/^(?:else\s+)?(?:parse\s+)?if(?:\s+(?:any|at least one(?:\s+of)?|all))?$/i.test(substituted)) return make('keyword', substituted, 0, []);
    const conditional = /^((?:else\s+)?(?:parse\s+)?if\s+|(?:do\s+)?while\s+)(.+)$/i.exec(substituted);
    if (conditional) return make('condition', conditional[2], conditional[1].length, CONDITION);
    return make('section', substituted, 0, SECTION_HEADER, isConditional);
  }

  if (CALL_ONLY.test(substituted)) return make('call', substituted, 0, []);
  return make('statement', substituted, 0, STATEMENT, isConditional);
}

/** Hover for the syntax a line matched. */
export function syntaxHover(file: FileIndex, node: SkNode, registry: SyntaxRegistry): Hover | undefined {
  const syntax = classify(file, node, registry);
  if (!syntax?.hit) return undefined;
  const best = registry.bestMatch(syntax.kinds, syntax.text, isConditional) ?? syntax.hit;
  const line = file.script.lines[node.line];
  return {
    contents: { kind: MarkupKind.Markdown, value: describeEntry(best) },
    range: { start: { line: node.line, character: line.start }, end: { line: node.line, character: line.end } },
  };
}

export function describeEntry(ref: PatternRef): string {
  const e = ref.entry;
  const kind = e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
  const parts = [`**${e.name || e.id}** · ${kind} · ${e.addon}${e.since ? ` · since ${e.since}` : ''}${e.deprecated ? ' · **deprecated**' : ''}`];
  parts.push('```skript\n' + e.patterns.join('\n') + '\n```');
  const description = cleanDescription(e.description);
  if (description) parts.push(description);
  if (e.examples.length > 0) parts.push('Example:\n```skript\n' + e.examples[0].replace(/\t/g, '    ').trimEnd() + '\n```');
  if (e.requirements?.length) parts.push(`Requires: ${e.requirements.join(', ')}`);
  return parts.join('\n\n');
}

// --- unrecognized syntax ------------------------------------------------------------

/**
 * Lines that match no known syntax. In `typos` mode only lines where changing
 * one word makes them match are reported (high confidence, with a quick fix);
 * in `all` mode every unmatched line is reported, as information, with the
 * closest known patterns.
 */
export function unrecognizedIssues(file: FileIndex, registry: SyntaxRegistry, mode: UnrecognizedMode): Issue[] {
  if (mode === 'off') return [];
  const issues: Issue[] = [];
  const visit = (node: SkNode) => {
    if (!node.invalid) {
      const syntax = classify(file, node, registry);
      if (syntax && syntax.kinds.length > 0 && !syntax.hit) {
        const issue = report(file, syntax, registry, mode);
        if (issue) issues.push(issue);
      }
    }
    node.children.forEach(visit);
  };
  file.script.structures.forEach(visit);
  return issues;
}

export interface TypoFix {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function report(file: FileIndex, syntax: LineSyntax, registry: SyntaxRegistry, mode: UnrecognizedMode): Issue | undefined {
  const line = file.script.lines[syntax.node.line];
  const typo = findTypo(syntax, registry);
  if (typo) {
    const fixable = syntax.column !== -1;
    const issue: Issue & { fix?: TypoFix } = {
      code: 'unrecognized-syntax',
      category: 'unrecognizedSyntax',
      severity: 'warning',
      line: syntax.node.line,
      start: fixable ? syntax.column + typo.start : line.start,
      end: fixable ? syntax.column + typo.end : line.end,
      message: `Skript does not know '${typo.word}' here. Did you mean '${typo.replacement}'? (${typo.hit.entry.name || typo.hit.entry.id}: ${readingWith(typo.hit, typo.replacement)})`,
      fix: fixable ? { line: syntax.node.line, start: syntax.column + typo.start, end: syntax.column + typo.end, text: typo.replacement } : undefined,
    };
    return issue;
  }
  if (mode !== 'all') return undefined;
  const closest = closestPatterns(syntax, registry);
  const what = syntax.role === 'event' ? 'event' : syntax.role === 'condition' ? 'condition' : 'syntax';
  const hint = closest.length > 0 ? ` Closest: ${closest.map((r) => `'${r.label}'`).join(', ')}.` : '';
  const addons = registry.addons.length > 0 ? ` Loaded addons: ${registry.addons.join(', ')}.` : ' If it comes from an addon, add that addon\'s syntax dump to skout.syntaxDumps.';
  return {
    code: 'unrecognized-syntax',
    category: 'unrecognizedSyntax',
    severity: 'information',
    line: syntax.node.line,
    start: line.start,
    end: line.end,
    message: `This line matches no known ${what}.${hint}${addons}`,
  };
}

/** The reading of a pattern that uses `word`, e.g. `send %objects%` rather than `message %objects%`. */
function readingWith(ref: PatternRef, word: string): string {
  return ref.variants.find((v) => v.label.toLowerCase().split(/\s+/).includes(word))?.label ?? ref.label;
}

interface Typo {
  readonly word: string;
  readonly replacement: string;
  /** Offsets within the matched text. */
  readonly start: number;
  readonly end: number;
  readonly hit: PatternRef;
}

/**
 * Tries replacing one unknown word with a known word one or two edits away,
 * and keeps it only if the line then matches a pattern for which that word is
 * essential. Short words are skipped: turning `area` into `are` makes almost
 * any line fit `%objects% are %objects%`, which proves nothing.
 */
function findTypo(syntax: LineSyntax, registry: SyntaxRegistry): Typo | undefined {
  const vocabulary = registry.vocabulary(syntax.kinds);
  // Only words in code: strings and variable names are blanked out.
  const masked = scanLine(syntax.text, 0, syntax.text.length).flat;
  const words = [...masked.matchAll(/[\p{L}][\p{L}'-]*/gu)];
  for (const m of words) {
    const word = m[0].toLowerCase();
    if (word.length < 4 || vocabulary.has(word)) continue;
    const limit = word.length <= 4 ? 1 : 2;
    const candidates: { w: string; d: number }[] = [];
    for (const known of vocabulary) {
      if (known.length < 4 || Math.abs(known.length - word.length) > limit) continue;
      const d = distance(word, known, limit);
      if (d <= limit) candidates.push({ w: known, d });
    }
    candidates.sort((a, b) => a.d - b.d || a.w.localeCompare(b.w));
    for (const { w } of candidates.slice(0, 6)) {
      const fixed = syntax.text.slice(0, m.index) + w + syntax.text.slice(m.index + m[0].length);
      const hit = registry.match(syntax.kinds, fixed, isConditional);
      if (hit && hit.pattern.anchors.includes(w)) return { word: m[0], replacement: w, start: m.index, end: m.index + m[0].length, hit };
    }
  }
  return undefined;
}

/** Patterns sharing the most literal words with the line. */
export function closestPatterns(syntax: LineSyntax, registry: SyntaxRegistry): PatternRef[] {
  const words = new Set(syntax.text.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? []);
  const scored: { ref: PatternRef; score: number }[] = [];
  for (const kind of syntax.kinds) {
    for (const ref of registry.patterns(kind)) {
      let score = 0;
      for (const w of ref.pattern.words) if (words.has(w)) score++;
      if (score > 0) scored.push({ ref, score: score / Math.sqrt(ref.pattern.words.length || 1) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const result: PatternRef[] = [];
  for (const { ref } of scored) {
    if (seen.has(ref.entry.id)) continue;
    seen.add(ref.entry.id);
    result.push(ref);
    if (result.length === 3) break;
  }
  return result;
}

/**
 * Edit distance where swapping two neighbouring letters counts as one edit
 * (optimal string alignment), since `sned` for `send` is the commonest typo.
 * Gives up early above `limit`.
 */
function distance(a: string, b: string, limit: number): number {
  let before = Array.from({ length: b.length + 1 }, () => 0);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}
