/**
 * The language engine: syntax data prepared for the expression parser, and
 * the analysis of whole lines (an event, an effect, a condition, a section
 * header) against the patterns Skript would try.
 *
 * A line is checked like ScriptLoader / SkriptParser#parse would load it:
 * every pattern of the allowed kinds is tried, each `%slot%` is parsed
 * recursively, and the line is fine as soon as one pattern accepts it. It is an
 * error only when patterns fit its shape but every one of them fails on a
 * sub-expression Skout understands completely.
 */
import type { Signature } from '../skript/functions';
import type { PatternRef, SyntaxRegistry } from '../syntax/registry';
import type { SyntaxKind } from '../syntax/schema';
import { matches, type Element } from '../syntax/pattern';
import { BudgetExceeded, better, LineParser, outweighs, type ExpressionCandidate, type ExprNode, type ParserData, type Problem, type Slot } from './expressions';
import { PatternIndex } from '../syntax/patternIndex';
import { TypeSystem } from './types';

export type { ExprNode, Problem } from './expressions';

export interface StatementResult {
  /**
   * - `ok`: some pattern accepts the line;
   * - `error`: patterns fit, but each fails for a reason Skout is sure of (`problem`);
   * - `doubtful`: patterns fit and fail, but only because Skout read words it
   *   does not know as part of them; the line may be syntax Skout has no data for;
   * - `unmatched`: no pattern fits its shape (unknown syntax, see `unrecognized-syntax`);
   * - `incomplete`: too expensive to check; nothing is reported.
   */
  readonly status: 'ok' | 'error' | 'doubtful' | 'unmatched' | 'incomplete';
  /** The reading that was accepted: the pattern, with a node per slot. */
  readonly root?: ExprNode;
  readonly problem?: Problem;
}

/** The functions a script can call. */
export interface FunctionLookup {
  /**
   * Signatures, and whether arguments may be type-checked against them. Built-in
   * functions are documented without their overloads, so only their return
   * types are used.
   */
  (name: string): { readonly signatures: readonly Signature[]; readonly checkArguments: boolean } | undefined;
}

const NO_FUNCTIONS: FunctionLookup = () => undefined;

interface CacheEntry {
  readonly result: StatementResult;
  /** Function lookups the result depends on, with what they returned. */
  readonly deps: ReadonlyMap<string, string>;
}

export class Engine implements ParserData {
  readonly types: TypeSystem;
  private readonly expressions: PatternIndex<ExpressionCandidate>;
  private readonly slotCache = new Map<string, Slot>();
  private readonly statementPatterns = new Map<string, PatternIndex<PatternRef>>();
  private readonly cache = new Map<string, CacheEntry>();
  private lookup: FunctionLookup = NO_FUNCTIONS;
  private deps: Map<string, string> | undefined;

  constructor(readonly registry: SyntaxRegistry) {
    this.types = new TypeSystem(registry.entries);
    const expressions = ordered(registry.patterns('expression'))
      .filter((ref) => ref.entry.id !== 'ExprArithmetic') // parsed natively
      .map((ref) => ({ ref, pattern: ref.pattern, returns: this.types.returns(ref.entry.returns), generic: isGeneric(ref.pattern.elements) }));
    this.expressions = new PatternIndex(expressions.map((item) => ({ item, pattern: item.pattern })));
  }

  expressionScope(line: string): { candidates(lower: string): readonly ExpressionCandidate[] } {
    return this.expressions.scope(line);
  }

  // --- ParserData ----------------------------------------------------------------------

  private readonly elementSlots = new WeakMap<object, Slot>();

  /** The slot of a pattern's `%type%` element, cached per element. */
  slotOf(element: { readonly types: string; readonly literalOnly?: boolean; readonly expressionOnly?: boolean }): Slot {
    let slot = this.elementSlots.get(element);
    if (!slot) {
      slot = this.slot(element.types, element.literalOnly, element.expressionOnly);
      this.elementSlots.set(element, slot);
    }
    return slot;
  }

  slot(types: string, literalOnly = false, expressionOnly = false): Slot {
    const key = `${types}|${literalOnly}|${expressionOnly}`;
    let slot = this.slotCache.get(key);
    if (!slot) {
      const alternatives = types.split('/').map((t) => this.types.slot(t));
      slot = { types: alternatives, single: alternatives.every((t) => !t.plural), literalOnly, expressionOnly };
      this.slotCache.set(key, slot);
    }
    return slot;
  }

  functions(name: string): readonly Signature[] | undefined {
    const found = this.lookup(name);
    this.deps?.set(name, fingerprint(found));
    if (!found) return undefined;
    // Without argument checks, a call is only typed by what it returns.
    if (!found.checkArguments) return found.signatures.map((s) => ({ ...s, parameters: s.parameters.map((p) => ({ ...p, type: 'objects', plural: true })) }));
    return found.signatures;
  }

  // --- lines -------------------------------------------------------------------------

  /**
   * Checks a line as one of `kinds`. `exclude` leaves out patterns handled
   * elsewhere (SecConditional's), and is part of the cache key by name.
   */
  statement(text: string, kinds: readonly SyntaxKind[], options: { exclude?: (ref: PatternRef) => boolean; functions?: FunctionLookup } = {}): StatementResult {
    const key = `${kinds.join(',')}\u0000${options.exclude?.name ?? ''}\u0000${text}`;
    return this.cached(key, options.functions, () => {
      const parser = new LineParser(text, this);
      let best: ExprNode | undefined;
      let problem: Problem | undefined;
      for (const ref of this.patternsFor(kinds).candidates(parser.lower.trim())) {
        if (options.exclude?.(ref) || !matches(ref.pattern, text)) continue;
        const result = parser.match(ref.pattern, 0, text.length);
        if (result.ok) {
          if (!best || result.unknowns < best.unknowns) {
            best = { kind: 'syntax', start: 0, end: text.length, ref, type: this.types.returns(ref.entry.returns), children: result.slots, unknowns: result.unknowns };
          }
          if (result.unknowns === 0) break;
        } else {
          problem = better(problem, result.problem);
        }
      }
      if (best && !outweighs(problem, [best])) return { status: 'ok', root: best };
      if (!problem) return { status: 'unmatched' };
      return { status: problem.doubt === 0 ? 'error' : 'doubtful', problem };
    });
  }

  /** Checks a whole line as one expression (a line that is only a function call). */
  expression(text: string, options: { functions?: FunctionLookup } = {}): StatementResult {
    return this.cached(`expr\u0000${text}`, options.functions, () => {
      const parser = new LineParser(text, this);
      const verdict = parser.check(0, text.length, this.slot('objects'));
      if (verdict.ok) return { status: 'ok', root: verdict.node };
      if (!verdict.problem) return { status: 'unmatched' };
      return { status: verdict.problem.doubt === 0 ? 'error' : 'doubtful', problem: verdict.problem };
    });
  }

  private cached(key: string, lookup: FunctionLookup | undefined, compute: () => StatementResult): StatementResult {
    lookup ??= NO_FUNCTIONS;
    const hit = this.cache.get(key);
    if (hit && [...hit.deps].every(([name, print]) => fingerprint(lookup(name)) === print)) return hit.result;
    this.lookup = lookup;
    this.deps = new Map();
    let result: StatementResult;
    try {
      result = compute();
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      result = { status: 'incomplete' };
    }
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(key, { result, deps: this.deps });
    this.deps = undefined;
    this.lookup = NO_FUNCTIONS;
    return result;
  }

  private patternsFor(kinds: readonly SyntaxKind[]): PatternIndex<PatternRef> {
    const key = kinds.join(',');
    let index = this.statementPatterns.get(key);
    if (!index) {
      const list = ordered(kinds.flatMap((kind) => this.registry.patterns(kind))).filter((ref) => !isCatchAll(ref.pattern.elements));
      index = new PatternIndex(list.map((ref) => ({ item: ref, pattern: ref.pattern })));
      this.statementPatterns.set(key, index);
    }
    return index;
  }
}

/** Most specific first: patterns that start with fixed words, then by the length of their required words. */
function ordered(refs: readonly PatternRef[]): PatternRef[] {
  const score = (ref: PatternRef) => (ref.pattern.anchored ? 1000 : 0) + ref.pattern.required.reduce((n, w) => n + w.length, 0);
  return refs
    .map((ref, order) => ({ ref, order, score: score(ref) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.ref);
}

/** The first element that must be present, skipping optional parts. */
function lead(elements: readonly Element[]): Element | undefined {
  for (const e of elements) {
    if (e.t === 'tag' || e.t === 'opt' || (e.t === 'lit' && e.text.trim() === '')) continue;
    if (e.t === 'group') return lead(e.body);
    return e;
  }
  return undefined;
}

const LOOSE = /^\(?\.[+*]\)?$/;

/** A pattern that is only a `<.+>`: it says nothing about a line. */
function isCatchAll(elements: readonly Element[]): boolean {
  const meaningful = elements.filter((e) => e.t !== 'tag');
  return meaningful.length === 1 && meaningful[0].t === 'regex';
}

/** Starts with a literal-only slot (`%*type%`) or a `<.+>`: fits almost any words. */
function isGeneric(elements: readonly Element[]): boolean {
  const first = lead(elements);
  if (!first) return false;
  return (first.t === 'type' && first.literalOnly === true) || (first.t === 'regex' && LOOSE.test(first.source));
}

function fingerprint(found: ReturnType<FunctionLookup>): string {
  if (!found) return '-';
  return `${found.checkArguments ? 'c' : 'r'}${found.signatures.map((s) => `${s.name}(${s.parameters.map((p) => `${p.name}:${p.type}`).join(',')})${s.returnType ?? ''}`).join(';')}`;
}
