/**
 * The upgrade checker: compares what the workspace's scripts mean under the
 * current syntax with what they mean under a target syntax (a newer Skript,
 * or a newer dump of one addon), and lists every line that would break.
 *
 * Comparisons are made by matching lines against patterns, not by comparing
 * entry ids: Skript renamed most ids between 2.13 and 2.16 (`EvtJoin` became
 * `join`), so an id-based diff reports hundreds of "removals" that are not.
 */
import { closestPatterns, classify, isConditional } from '../features/syntax';
import type { FileIndex, FunctionDef } from '../index/types';
import type { WorkspaceIndex } from '../index/workspace';
import { scanLine, substituteOptions } from '../index/extract';
import type { SkNode } from '../parser/types';
import { formatSignature, sameRegistryKey, type Parameter } from '../skript/functions';
import { isPlural } from '../skript/plural';
import { compilePattern, matches } from '../syntax/pattern';
import { compareVersions, parseVersion, type Version } from '../skript/version';
import type { PatternRef, SyntaxRegistry } from '../syntax/registry';
import type { SyntaxEntry } from '../syntax/schema';
import { KNOWN_CHANGES } from './known';

export interface UpgradeSide {
  readonly registry: SyntaxRegistry;
  /** The Skript version this side describes. */
  readonly version: Version;
  /** For the report, e.g. `Skript 2.16.2` or `SkBee 3.11.0`. */
  readonly label: string;
}

/** What is being upgraded: Skript itself, or one addon. */
export type UpgradeScope = { readonly kind: 'skript' } | { readonly kind: 'addon'; readonly addon: string };

export type FindingKind = 'removed' | 'deprecated' | 'behaviour' | 'function-type' | 'function-clash' | 'function-removed';

export interface Finding {
  readonly uri: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly severity: 'error' | 'warning' | 'information';
  readonly kind: FindingKind;
  readonly message: string;
  readonly suggestion?: string;
  readonly link?: string;
  readonly lineText: string;
}

export interface DumpDiff {
  readonly removed: readonly { kind: string; name: string; patterns: readonly string[] }[];
  readonly changed: readonly { kind: string; name: string; removedPatterns: readonly string[]; addedPatterns: readonly string[] }[];
  readonly deprecated: readonly { kind: string; name: string }[];
}

export interface UpgradeResult {
  readonly from: string;
  readonly to: string;
  readonly findings: readonly Finding[];
  readonly scripts: number;
  readonly linesChecked: number;
  readonly diff: DumpDiff;
}

export function checkUpgrade(index: WorkspaceIndex, from: UpgradeSide, to: UpgradeSide, scope: UpgradeScope): UpgradeResult {
  const findings: Finding[] = [];
  let scripts = 0;
  let linesChecked = 0;
  const knownChanges =
    scope.kind === 'skript'
      ? KNOWN_CHANGES.filter((c) => {
          const v = parseVersion(c.version)!;
          return compareVersions(v, from.version) > 0 && compareVersions(v, to.version) <= 0;
        })
      : [];
  const typesBefore = typeNames(from.registry);
  const typesAfter = typeNames(to.registry);
  const diff = diffDumps(from.registry, to.registry, scope);
  const phrases = removedExpressionPhrases(diff, to.registry);
  const patternsAfter = new Set(to.registry.entries.flatMap((e) => e.patterns.map(norm)));

  for (const file of index.all()) {
    if (file.disabled) continue; // Skript does not load it
    scripts++;
    const add = (node: { line: number }, start: number, end: number, finding: Omit<Finding, 'uri' | 'line' | 'start' | 'end' | 'lineText'>) =>
      findings.push({ uri: file.uri, line: node.line, start, end, lineText: file.script.lines[node.line].text.trim(), ...finding });

    const visit = (node: SkNode) => {
      const line = file.script.lines[node.line];
      const before = classify(file, node, from.registry);
      if (before && before.kinds.length > 0 && before.hit) {
        linesChecked++;
        const after = classify(file, node, to.registry);
        if (!after?.hit) {
          const oldBest = from.registry.bestMatch(before.kinds, before.text, isConditional) ?? before.hit;
          const replacement = sameEntry(oldBest.entry, to.registry);
          const closest = closestPatterns(before, to.registry).map((r) => `\`${r.label}\``);
          add(node, line.start, line.end, {
            severity: 'error',
            kind: 'removed',
            message: `'${oldBest.entry.name || oldBest.entry.id}' (\`${oldBest.label}\`) is not valid syntax in ${to.label}.`,
            suggestion: replacement
              ? `In ${to.label} it is written: ${replacement.patterns.map((p) => `\`${p}\``).join(', ')}`
              : closest.length > 0
                ? `Closest syntax in ${to.label}: ${closest.join(', ')}`
                : undefined,
          });
        } else {
          const oldBest = from.registry.bestMatch(before.kinds, before.text, isConditional) ?? before.hit;
          const newBest = to.registry.bestMatch(after.kinds, after.text, isConditional) ?? after.hit;
          const replacement = sameEntry(oldBest.entry, to.registry);
          if (
            oldBest.pattern.anchored &&
            specificity(oldBest) >= 6 &&
            specificity(newBest) < specificity(oldBest) &&
            !patternsAfter.has(norm(oldBest.pattern.source)) &&
            !replacement?.patterns.some((p) => fits(p, after.text))
          ) {
            // The syntax the line relied on is gone (not merely reworded in the docs) and only
            // a more general pattern still fits, as when an addon's `launch gizmo at %location%`
            // is replaced and only Skript's `launch %firework effects% at %locations%` is left.
            add(node, line.start, line.end, {
              severity: 'warning',
              kind: 'removed',
              message: `'${oldBest.entry.name || oldBest.entry.id}' (\`${oldBest.label}\`) is gone in ${to.label}; the line now only fits the more general '${newBest.entry.name || newBest.entry.id}' (\`${newBest.label}\`), so it probably breaks.`,
              suggestion: replacement ? `In ${to.label} it is written: ${replacement.patterns.map((p) => `\`${p}\``).join(', ')}` : undefined,
            });
          } else if (newBest.entry.deprecated && !oldBest.entry.deprecated) {
            add(node, line.start, line.end, {
              severity: 'warning',
              kind: 'deprecated',
              message: `'${newBest.entry.name || newBest.entry.id}' is deprecated in ${to.label}.`,
              suggestion: firstSentence(newBest.entry.description),
            });
          }
        }
      }

      // Expressions sit inside slots, which line matching cannot see into; look for
      // the distinctive words of removed expression patterns instead.
      if (phrases.length > 0 && !(before === undefined && node.depth === 0)) {
        const text = substituteOptions(node.key, file.script.options);
        const code = scanLine(text, 0, text.length).masked.toLowerCase().replace(/\s+/g, ' ');
        for (const phrase of phrases) {
          if (!phrase.test.test(code)) continue;
          add(node, line.start, line.end, {
            severity: 'warning',
            kind: 'removed',
            message: `This line seems to use '${phrase.name}' (\`${phrase.pattern}\`), which ${to.label} no longer has.`,
          });
          break;
        }
      }

      if (knownChanges.length > 0) {
        const text = substituteOptions(node.key, file.script.options);
        // String text is blanked, but %…% expressions inside strings are kept.
        const code = scanLine(text, 0, text.length).masked;
        const top = topOf(node);
        const inCommandEntry = top.structure === 'command' && node.parent === top && node.kind === 'simple';
        for (const change of knownChanges) {
          if (change.applies({ node, text, code, inCommandEntry })) {
            add(node, line.start, line.end, { severity: change.severity, kind: 'behaviour', message: change.message, suggestion: change.suggestion, link: change.link });
          }
        }
      }
      node.children.forEach(visit);
    };
    file.script.structures.forEach(visit);

    if (scope.kind === 'skript') {
      for (const def of file.functions) checkFunction(def, file, from, to, typesBefore, typesAfter, add);
      for (const call of file.calls) {
        if (index.visibleFunctions(call.name, file.uri).length > 0) continue;
        if (from.registry.functions.has(call.name) && !to.registry.functions.has(call.name)) {
          add(call, call.start, call.end, {
            severity: 'error',
            kind: 'function-removed',
            message: `The built-in function '${call.name}' does not exist in ${to.label}.`,
          });
        }
      }
    }
  }

  findings.sort((a, b) => a.uri.localeCompare(b.uri) || a.line - b.line || a.start - b.start);
  return { from: from.label, to: to.label, findings: dedupe(findings), scripts, linesChecked, diff };
}

/** Function signatures that would fail to register under the target. */
function checkFunction(
  def: FunctionDef,
  file: FileIndex,
  from: UpgradeSide,
  to: UpgradeSide,
  typesBefore: Set<string>,
  typesAfter: Set<string>,
  add: (node: { line: number }, start: number, end: number, finding: Omit<Finding, 'uri' | 'line' | 'start' | 'end' | 'lineText'>) => void,
): void {
  const signature = def.signature;
  if (!signature) return;
  const types: { text: string; what: string }[] = signature.parameters.map((p: Parameter) => ({ text: p.type, what: `parameter '${p.name}'` }));
  if (signature.returnType) types.push({ text: signature.returnType, what: 'return type' });
  for (const { text, what } of types) {
    const key = typeKey(text);
    if (typesBefore.has(key) && !typesAfter.has(key)) {
      add(def, def.start, def.end, {
        severity: 'error',
        kind: 'function-type',
        message: `${to.label} has no type '${text.trim()}' (used as the ${what}), so Skript reports "Cannot recognise the type" and the function '${def.name}' fails to register.`,
        suggestion: closestType(text, from.registry, to.registry),
      });
    }
  }
  if (!def.local) {
    const clashAfter = to.registry.functions.get(def.name)?.signatures.some((s) => sameRegistryKey(signature, s, to.version));
    const clashBefore = from.registry.functions.get(def.name)?.signatures.some((s) => sameRegistryKey(signature, s, from.version));
    if (clashAfter && !clashBefore) {
      const builtin = to.registry.functions.get(def.name)!;
      add(def, def.start, def.end, {
        severity: 'error',
        kind: 'function-clash',
        message: `${to.label} adds a built-in function '${builtin.entry.patterns[0] ?? def.name}' with the same argument types as your '${formatSignature(signature)}', so yours fails to register ("already exists").`,
        suggestion: `Rename your function, or make it a local function.`,
      });
    }
  }
  void file;
}

/** One finding per line and kind: the first (most specific) wins. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.uri}:${f.line}:${f.kind}:${f.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface RemovedPhrase {
  readonly phrase: string;
  /** The phrase as whole words: `%last usage date%` contains it, `blast usage` does not. */
  readonly test: RegExp;
  readonly name: string;
  readonly pattern: string;
}

/**
 * The longest fixed phrase of each removed expression pattern, kept only when
 * it is distinctive (two or more words, eight or more letters) and no pattern
 * in the target still contains it. `[the] last usage [date]` gives "last usage".
 */
function removedExpressionPhrases(diff: DumpDiff, to: SyntaxRegistry): RemovedPhrase[] {
  const sources: { name: string; pattern: string }[] = [];
  for (const r of diff.removed) if (r.kind === 'expression') r.patterns.forEach((pattern) => sources.push({ name: r.name, pattern }));
  for (const c of diff.changed) if (c.kind === 'expression') c.removedPatterns.forEach((pattern) => sources.push({ name: c.name, pattern }));
  const surviving = to.entries.flatMap((e) => e.patterns).map((p) => p.toLowerCase());
  const phrases: RemovedPhrase[] = [];
  for (const { name, pattern } of sources) {
    let longest = '';
    try {
      for (const e of compilePattern(pattern).elements) {
        if (e.t === 'lit' && e.text.trim().length > longest.length) longest = e.text.trim();
      }
    } catch {
      continue;
    }
    longest = longest.replace(/\s+/g, ' ');
    if (longest.split(' ').length < 2 || longest.replace(/ /g, '').length < 8) continue;
    if (surviving.some((p) => p.includes(longest))) continue;
    const escaped = longest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    phrases.push({ phrase: longest, test: new RegExp(`(^|[^\\p{L}\\d])${escaped}($|[^\\p{L}\\d])`, 'u'), name, pattern });
  }
  return phrases;
}

function fits(pattern: string, text: string): boolean {
  try {
    return matches(compilePattern(pattern), text);
  } catch {
    return false;
  }
}

/** How specific a pattern is: the total length of the words every match must contain. */
function specificity(ref: PatternRef): number {
  return ref.pattern.required.reduce((n, w) => n + w.length, 0);
}

function topOf(node: SkNode): SkNode {
  let top = node;
  while (top.parent) top = top.parent;
  return top;
}

/** Type names users can write, as far as the docs show them: ids (`itemtype`) and names (`Item Type`). */
function typeNames(registry: SyntaxRegistry): Set<string> {
  const names = new Set<string>();
  for (const entry of registry.entries) {
    if (entry.kind !== 'type') continue;
    names.add(typeKey(entry.id));
    if (entry.name) names.add(typeKey(entry.name));
  }
  return names;
}

function typeKey(text: string): string {
  return isPlural(text.trim()).updated.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * A replacement for a vanished type. A rename shows in the data as an old type
 * whose display name now belongs to a type with a new id (Skript 2.16 replaced
 * `structuretype`, shown as "Tree Type", with `treetype`). Otherwise, the type
 * sharing the most words with it, ignoring the word "type" itself.
 */
function closestType(text: string, from: SyntaxRegistry, to: SyntaxRegistry): string | undefined {
  const key = typeKey(text);
  const old = from.entries.find((e) => e.kind === 'type' && (typeKey(e.id) === key || (e.name && typeKey(e.name) === key)));
  const renamed = old?.name && to.entries.find((e) => e.kind === 'type' && e.name.toLowerCase() === old.name.toLowerCase());
  if (renamed) return `It is now called '${renamed.name.toLowerCase()}'.`;

  const ignore = new Set(['type', 'types']);
  const words = new Set(text.toLowerCase().split(/\s+/).map((w) => isPlural(w).updated).filter((w) => !ignore.has(w)));
  let best: SyntaxEntry | undefined;
  let bestScore = 0;
  for (const entry of to.entries) {
    if (entry.kind !== 'type' || !entry.name) continue;
    const score = entry.name.toLowerCase().split(/\s+/).filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best ? `The closest type in ${to.version.text} is '${best.name.toLowerCase()}'.` : undefined;
}

/** The entry with the same kind and name in the other registry (ids changed between versions; names mostly did not). */
function sameEntry(entry: SyntaxEntry, registry: SyntaxRegistry): SyntaxEntry | undefined {
  const name = entry.name.toLowerCase();
  if (!name) return undefined;
  return registry.entries.find((e) => e.kind === entry.kind && e.addon === entry.addon && e.name.toLowerCase() === name);
}

function firstSentence(text: string): string | undefined {
  const clean = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  const end = clean.search(/[.!?](\s|$)/);
  return end === -1 ? clean : clean.slice(0, end + 1);
}

// --- dump diff -------------------------------------------------------------------------

const norm = (pattern: string) => pattern.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * What changed between the two sides' syntax for the scope, independent of the
 * scripts: entries whose patterns all vanished, entries whose patterns changed,
 * and entries newly deprecated. Entries are paired by kind and name.
 */
export function diffDumps(from: SyntaxRegistry, to: SyntaxRegistry, scope: UpgradeScope): DumpDiff {
  const inScope = (e: SyntaxEntry) =>
    e.kind !== 'type' && (scope.kind === 'skript' ? e.addon.toLowerCase() === 'skript' : e.addon === scope.addon);
  const before = from.entries.filter(inScope);
  const after = to.entries.filter(inScope);
  const byKey = new Map(after.map((e) => [`${e.kind}:${e.name.toLowerCase() || e.id}`, e]));
  const byName = new Map(after.map((e) => [e.name.toLowerCase() || e.id, e]));
  // A pattern that moved to another kind (Delay went from effect to section) has not been removed.
  const stillThere = new Set(after.flatMap((e) => e.patterns.map(norm)));

  const removed: DumpDiff['removed'][number][] = [];
  const changed: DumpDiff['changed'][number][] = [];
  const deprecated: DumpDiff['deprecated'][number][] = [];
  for (const old of before) {
    const counterpart = byKey.get(`${old.kind}:${old.name.toLowerCase() || old.id}`) ?? byName.get(old.name.toLowerCase() || old.id);
    const removedPatterns = old.patterns.filter((p) => !stillThere.has(norm(p)));
    if (!counterpart && removedPatterns.length === old.patterns.length) {
      removed.push({ kind: old.kind, name: old.name || old.id, patterns: old.patterns });
      continue;
    }
    const oldSet = new Set(old.patterns.map(norm));
    const addedPatterns = counterpart ? counterpart.patterns.filter((p) => !oldSet.has(norm(p))) : [];
    if (!counterpart) {
      if (removedPatterns.length > 0) changed.push({ kind: old.kind, name: old.name || old.id, removedPatterns, addedPatterns });
      continue;
    }
    if (removedPatterns.length > 0) changed.push({ kind: old.kind, name: old.name || old.id, removedPatterns, addedPatterns });
    if (counterpart.deprecated && !old.deprecated) deprecated.push({ kind: old.kind, name: old.name || old.id });
  }
  return { removed, changed, deprecated };
}
