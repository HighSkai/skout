/**
 * All syntax Skout knows for this workspace: Skript's own (bundled for the
 * target version, or the user's `/sk gen-docs` output) plus any addon dumps,
 * with compiled patterns grouped by kind.
 */
import type { Version } from '../skript/version';
import { parseVersion } from '../skript/version';
import type { Signature } from '../skript/functions';
import { parseDocSignature, type BuiltinFunction, type SkriptSyntax } from './catalog';
import { compilePattern, matches, render, renderVariants, type CompiledPattern } from './pattern';
import type { SyntaxDump, SyntaxEntry, SyntaxKind } from './schema';

export interface PatternRef {
  readonly entry: SyntaxEntry;
  readonly pattern: CompiledPattern;
  /** Index of the pattern within the entry. */
  readonly index: number;
  readonly label: string;
  readonly snippet: string;
  /** Readings for completion: one per alternative of the leading choice. */
  readonly variants: readonly { readonly label: string; readonly snippet: string }[];
}

/** What the function checks need: the version built-ins come from, and the built-in functions. */
export interface BuiltinSyntax {
  readonly version: Version;
  readonly functions: ReadonlyMap<string, BuiltinFunction>;
}

export interface LoadedDump {
  readonly path: string;
  readonly dump: SyntaxDump;
}

/** Patterns that match any text: they say nothing about a line, so they never count as a match. */
function isCatchAll(pattern: CompiledPattern): boolean {
  const meaningful = pattern.elements.filter((e) => e.t !== 'tag');
  return meaningful.length === 1 && meaningful[0].t === 'regex';
}

export class SyntaxRegistry implements BuiltinSyntax {
  readonly version: Version;
  readonly functions: Map<string, BuiltinFunction>;
  readonly entries: readonly SyntaxEntry[];
  /** Addon names with loaded syntax, and where Skript's own syntax came from. */
  readonly addons: readonly string[];
  readonly skriptSource: string;

  private readonly compiled = new Map<SyntaxKind, PatternRef[]>();
  private readonly cache = new Map<string, PatternRef | null>();
  private readonly vocabularies = new Map<string, Set<string>>();

  constructor(bundled: SkriptSyntax, dumps: readonly LoadedDump[] = []) {
    // A Skript dump from the user's own server replaces the bundled one.
    const own = dumps.find((d) => isSkriptDump(d.dump));
    const skript = own?.dump ?? bundled.dump;
    this.version = (own && parseVersion(own.dump.skriptVersion)) || bundled.version;
    this.skriptSource = own ? own.path : `bundled Skript ${bundled.version.text}`;

    const entries: SyntaxEntry[] = [...skript.entries];
    const addons = new Set<string>();
    for (const { dump } of dumps) {
      if (isSkriptDump(dump)) continue;
      for (const entry of dump.entries) {
        // SkriptHub also lists Skript's own syntax, older than the dump in use.
        if (entry.addon.toLowerCase() === 'skript') continue;
        entries.push(entry);
        addons.add(entry.addon);
      }
    }
    this.entries = entries;
    this.addons = [...addons].sort();

    this.functions = new Map();
    for (const entry of entries) {
      if (entry.kind !== 'function') continue;
      const signatures = entry.patterns.map(parseDocSignature).filter((s): s is Signature => s !== undefined);
      const name = signatures[0]?.name ?? entry.id;
      const existing = this.functions.get(name);
      if (existing) this.functions.set(name, { ...existing, signatures: [...existing.signatures, ...signatures] });
      else this.functions.set(name, { name, signatures, entry });
    }
  }

  /** Compiled patterns of one kind, compiled on first use. Malformed patterns are skipped. */
  patterns(kind: SyntaxKind): PatternRef[] {
    let list = this.compiled.get(kind);
    if (list) return list;
    list = [];
    for (const entry of this.entries) {
      if (entry.kind !== kind) continue;
      entry.patterns.forEach((source, index) => {
        try {
          const pattern = compilePattern(source);
          const { label, snippet } = render(pattern.elements);
          list!.push({ entry, pattern, index, label, snippet, variants: renderVariants(pattern.elements) });
        } catch {
          // A pattern Skript itself would reject; ignore it.
        }
      });
    }
    this.compiled.set(kind, list);
    return list;
  }

  /** The first pattern of the given kinds that matches `text`, cached by text. */
  match(kinds: readonly SyntaxKind[], text: string, exclude?: (ref: PatternRef) => boolean): PatternRef | undefined {
    const key = `${kinds.join(',')}\u0000${exclude ? 'x' : ''}\u0000${text}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    let hit: PatternRef | undefined;
    outer: for (const kind of kinds) {
      for (const ref of this.patterns(kind)) {
        if (isCatchAll(ref.pattern) || exclude?.(ref)) continue;
        if (matches(ref.pattern, text)) {
          hit = ref;
          break outer;
        }
      }
    }
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(key, hit ?? null);
    return hit;
  }

  /**
   * The most specific matching pattern: the one whose required words are longest in total.
   * Slots match any text, so a generic pattern such as `open %blocks%` also fits
   * SkBee's `open real anvil inventory to player`; for docs, the specific one wins.
   */
  bestMatch(kinds: readonly SyntaxKind[], text: string, exclude?: (ref: PatternRef) => boolean): PatternRef | undefined {
    const key = `best\u0000${kinds.join(',')}\u0000${exclude ? 'x' : ''}\u0000${text}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    let best: PatternRef | undefined;
    let bestScore = -1;
    for (const kind of kinds) {
      for (const ref of this.patterns(kind)) {
        if (isCatchAll(ref.pattern) || exclude?.(ref)) continue;
        const score = ref.pattern.required.reduce((n, w) => n + w.length, 0);
        if (score <= bestScore || !matches(ref.pattern, text)) continue;
        best = ref;
        bestScore = score;
      }
    }
    this.cache.set(key, best ?? null);
    return best;
  }

  /** Every literal word in patterns of these kinds, for typo suggestions. */
  vocabulary(kinds: readonly SyntaxKind[]): Set<string> {
    const key = kinds.join(',');
    let words = this.vocabularies.get(key);
    if (!words) {
      words = new Set();
      for (const kind of kinds) for (const ref of this.patterns(kind)) ref.pattern.words.forEach((w) => words!.add(w));
      this.vocabularies.set(key, words);
    }
    return words;
  }
}


function isSkriptDump(dump: SyntaxDump): boolean {
  return dump.source === 'skript-docs' || (dump.source === 'skripthub-docs-tool' && Object.keys(dump.addons).some((a) => a.toLowerCase() === 'skript'));
}
