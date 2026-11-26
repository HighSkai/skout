/**
 * The expression parser: parses any span of a line the way
 * SkriptParser#parseSingleExpr does (Skript 2.17.1), recursively, into typed
 * nodes.
 *
 *   1. `(…)` around the whole span: the inside.
 *   2. `{…}`: a variable.
 *   3. `name(…)`: a function call, with each argument checked against the
 *      parameter's type.
 *   4. `"…"`: text, with each `%expression%` inside parsed too.
 *   5. Expressions: every known expression pattern that fits, with every slot
 *      parsed recursively, plus Skript's arithmetic (ExprArithmetic), which is
 *      implemented natively because its documented return type is `Object`.
 *   6. Literals Skout can recognise: numbers, booleans, time spans.
 *
 * What a span is NOT is never guessed. A span that no known syntax explains
 * is `unknown` and fits every slot: it may be an item type such as `diamond
 * sword`, or syntax from an addon Skout has no dump for. An error is only
 * reported when every reading Skout finds is certainly wrong.
 *
 * Several readings of one span are kept, ranked by how many unknown parts
 * they rest on. A reading that known syntax explains completely beats one
 * that only fits because some part of it is unknown: `name of player` is
 * ExprName (text), not `%number% of %item types%` with `name` as an unknown
 * number.
 */
import { nextToken, parseArguments, type Signature } from '../skript/functions';
import { matches, matchLiteral, type CompiledPattern, type PatternNode } from '../syntax/pattern';
import type { PatternRef } from '../syntax/registry';
import { isBooleanLiteral, isNumberLiteral, isTimespanLiteral } from './literals';
import { OPERATOR_NAMES, operate, type Compatibility, type Family, type Operator, type SlotType, type TypeInfo, type TypeSystem } from './types';

export type NodeKind =
  | 'syntax'
  | 'arithmetic'
  | 'string'
  | 'number'
  | 'boolean'
  | 'timespan'
  | 'variable'
  | 'call'
  | 'list'
  | 'typeLiteral'
  | 'literal'
  | 'unknown';

export interface ExprNode {
  readonly kind: NodeKind;
  /** Offsets in the analysed text. */
  readonly start: number;
  readonly end: number;
  /** Undefined when the type is not known. */
  readonly type?: TypeInfo;
  /** Certainly several values: a list variable or a list. */
  readonly plural?: boolean;
  /** The syntax this node is, for `syntax` nodes and the statement root. */
  readonly ref?: PatternRef;
  /** Function name for `call`, operator for `arithmetic`. */
  readonly name?: string;
  /** The signature a call resolved to. */
  readonly signature?: Signature;
  readonly children: readonly ExprNode[];
  /** How many parts of this reading Skout could not verify. */
  readonly unknowns: number;
}

export type ProblemCode = 'type-mismatch' | 'invalid-operation' | 'single-value' | 'argument-type';

export interface Problem {
  readonly code: ProblemCode;
  readonly message: string;
  readonly start: number;
  readonly end: number;
  /** Higher wins when several readings fail; like Skript's ErrorQuality. */
  readonly quality: number;
  /**
   * How many other parts of the failed reading Skout could not verify. Only a
   * problem with no doubt is reported: a line that only fails because Skout
   * read some unknown words as part of a pattern may be syntax it does not know.
   */
  readonly doubt: number;
}

export interface Slot {
  readonly types: readonly SlotType[];
  /** Every alternative is singular, e.g. `%number%`. */
  readonly single: boolean;
  readonly literalOnly: boolean;
  readonly expressionOnly: boolean;
}

/** An expression pattern, prepared for the parser. */
export interface ExpressionCandidate {
  readonly ref: PatternRef;
  readonly pattern: CompiledPattern;
  readonly returns?: TypeInfo;
  /**
   * Generic patterns such as ExprEntity's `[the] [event-]<.+>` or ExprSets'
   * `[the] %*type%` fit nearly any words; Skript sorts them out in `init`.
   * They are tried only when nothing more specific fits.
   */
  readonly generic: boolean;
}

/** What the parser needs to know about the environment. */
export interface ParserData {
  readonly types: TypeSystem;
  /** For one line: the expression patterns that may match a lower-case, trimmed part of it, most specific first. */
  expressionScope(line: string): { candidates(lower: string): readonly ExpressionCandidate[] };
  slot(types: string, literalOnly?: boolean, expressionOnly?: boolean): Slot;
  /** The slot of a pattern's `%type%` element. */
  slotOf(element: { readonly types: string; readonly literalOnly?: boolean; readonly expressionOnly?: boolean }): Slot;
  /** Signatures of a function visible here; undefined when the function is unknown. */
  functions(name: string): readonly Signature[] | undefined;
}

interface SpanResult {
  /** Readings that worked, best first. */
  readonly parses: readonly ExprNode[];
  /** Why the readings that matched failed, when none worked. */
  readonly problem?: Problem;
}

export type SlotVerdict =
  | { readonly ok: true; readonly node: ExprNode }
  | { readonly ok: false; readonly problem?: Problem };

type MatchResult = { readonly ok: true; readonly slots: readonly ExprNode[]; readonly unknowns: number } | { readonly ok: false; readonly problem?: Problem };

const NO_MATCH: MatchResult = { ok: false };
const EMPTY: SpanResult = { parses: [] };
const MAX_PARSES = 12;

export class BudgetExceeded extends Error {}

/** Parses spans of one line. Results are memoized for the lifetime of the parser. */
export class LineParser {
  readonly lower: string;
  private readonly spans = new Map<number, SpanResult>();
  private readonly verdicts = new Map<string, SlotVerdict>();
  private readonly active = new Set<number>();
  private steps = 0;
  private readonly width: number;
  private readonly scope: { candidates(lower: string): readonly ExpressionCandidate[] };

  constructor(
    readonly text: string,
    private readonly data: ParserData,
    private readonly budget = 150_000,
  ) {
    this.lower = text.toLowerCase();
    this.width = text.length + 1;
    this.scope = data.expressionScope(this.lower);
  }

  private tick(n = 1): void {
    this.steps += n;
    if (this.steps > this.budget) throw new BudgetExceeded();
  }

  // --- spans -------------------------------------------------------------------------

  /** All readings of `text[start, end)`, trimmed. */
  parse(start: number, end: number): SpanResult {
    [start, end] = this.trim(start, end);
    if (start >= end) return EMPTY;
    const key = start * this.width + end;
    const cached = this.spans.get(key);
    if (cached) return cached;
    if (this.active.has(key)) return EMPTY; // a pattern that reduces to one of its own slots
    this.active.add(key);
    this.tick();
    try {
      const result = this.parseUncached(start, end);
      this.spans.set(key, result);
      return result;
    } finally {
      this.active.delete(key);
    }
  }

  private parseUncached(start: number, end: number): SpanResult {
    const text = this.text;
    const first = text[start];
    const whole = nextToken(text, start) === end;

    if (first === '(' && whole) return this.parse(start + 1, end - 1);
    if (first === '{' && whole) {
      return { parses: [{ kind: 'variable', start, end, plural: /::\*\}$/.test(text.slice(start, end)), children: [], unknowns: 0, name: text.slice(start + 1, end - 1) }] };
    }
    if (first === '"' && whole) return this.string(start, end);
    const call = /^([\p{Alphabetic}_][\p{Alphabetic}\d_]*)\(/u.exec(text.slice(start, end));
    if (call && nextToken(text, start + call[1].length) === end) return this.call(start, end, call[1]);

    const parses: ExprNode[] = [];
    let problem: Problem | undefined;
    const collect = (result: SpanResult) => {
      parses.push(...result.parses);
      problem = better(problem, result.problem);
    };

    collect(this.arithmetic(start, end));
    const candidates = this.scope.candidates(this.lower.slice(start, end));
    for (const candidate of candidates) {
      if (!candidate.generic) collect(this.expression(candidate, start, end));
    }
    const literal = this.literal(start, end);
    if (literal) parses.push(literal);
    if (parses.length === 0) {
      for (const candidate of candidates) {
        if (candidate.generic) collect(this.expression(candidate, start, end));
      }
    }
    if (parses.length === 0 || outweighs(problem, parses)) return { parses: [], problem };
    return { parses: rank(parses) };
  }

  private trim(start: number, end: number): [number, number] {
    while (start < end && /\s/.test(this.text[start])) start++;
    while (end > start && /\s/.test(this.text[end - 1])) end--;
    return [start, end];
  }

  // --- slots -------------------------------------------------------------------------

  /** Whether `text[start, end)` can fill `slot`, and the reading that does. */
  check(start: number, end: number, slot: Slot): SlotVerdict {
    [start, end] = this.trim(start, end);
    if (start >= end) return { ok: false };
    // `(…)` is whatever is inside, including a list.
    if (this.text[start] === '(' && nextToken(this.text, start) === end) return this.check(start + 1, end - 1, slot);
    // A pattern whose slot would be the very span being parsed: no reading (Skript would recurse forever).
    if (this.active.has(start * this.width + end)) return { ok: false };
    const key = `${start},${end},${slotKey(slot)}`;
    const cached = this.verdicts.get(key);
    if (cached) return cached;
    const verdict = this.checkUncached(start, end, slot);
    this.verdicts.set(key, verdict);
    return verdict;
  }

  private checkUncached(start: number, end: number, slot: Slot): SlotVerdict {
    if (slot.literalOnly) return this.checkLiteral(start, end, slot);
    const result = this.parse(start, end);
    let parses = result.parses;
    if (slot.expressionOnly) parses = parses.filter((n) => !isLiteralNode(n));
    if (parses.length === 0) {
      if (slot.expressionOnly && result.parses.length > 0) return { ok: false };
      // SkriptParser#parseExpression tries the whole text first, then a list.
      const list = this.list(start, end, slot);
      if (list?.ok) return list;
      const problem = better(result.problem, list && !list.ok ? list.problem : undefined);
      if (problem) return { ok: false, problem };
      return { ok: true, node: unknownNode(start, end) };
    }
    // A reading that known syntax explains completely is the one that counts.
    const certain = parses.filter((n) => n.unknowns === 0);
    const readings = certain.length > 0 ? certain : parses;
    let mismatch: Problem | undefined;
    for (const node of readings) {
      const fit = this.fits(node, slot);
      if (fit === true) return { ok: true, node };
      mismatch ??= fit;
    }
    return { ok: false, problem: mismatch };
  }

  /** True, or the problem that keeps `node` out of `slot`. */
  private fits(node: ExprNode, slot: Slot): true | Problem {
    if (node.kind === 'list') {
      for (const child of node.children) {
        const fit = this.fits(child, slot);
        if (fit !== true) return fit;
      }
      return true;
    }
    if (node.plural && slot.single && (node.kind === 'variable' || node.kind === 'call')) {
      return {
        code: 'single-value',
        message: `'${this.text.slice(node.start, node.end)}' can only be a single ${orList(slot.types.map((t) => t.info?.singular ?? t.word))}, not more.`,
        start: node.start,
        end: node.end,
        quality: 3,
        doubt: node.unknowns,
      };
    }
    if (compatibleWith(this.data.types, node.type, slot) !== 'no') return true;
    return {
      code: 'type-mismatch',
      message: `${this.describe(node)} is ${notOfType(this.data.types, slot)}`,
      start: node.start,
      end: node.end,
      quality: 2,
      doubt: node.unknowns,
    };
  }

  /** `"hello"`, `5`, or `'name of player' (a text)`. */
  private describe(node: ExprNode): string {
    let text = this.text.slice(node.start, node.end);
    if (text.length > 60) text = `${text.slice(0, 57)}…`;
    if (node.kind === 'string' || isLiteralNode(node)) return text;
    return node.type ? `'${text}' (${this.data.types.withArticle(node.type, node.plural)})` : `'${text}'`;
  }

  /** `%*type%`: a literal is required. */
  private checkLiteral(start: number, end: number, slot: Slot): SlotVerdict {
    const text = this.text.slice(start, end);
    const first = text[0];
    if (first === '{' || first === '(' || /^[\p{Alphabetic}_][\p{Alphabetic}\d_]*\(/u.test(text)) return { ok: false };
    if (first === '"') {
      if (slot.types.some((t) => t.info?.family === 'text' || !t.info) && nextToken(this.text, start) === end) return this.string(start, end).parses[0] ? { ok: true, node: this.string(start, end).parses[0] } : { ok: false };
      return { ok: false };
    }
    for (const t of slot.types) {
      if (t.info?.id === 'classinfo' || t.word === 'type' || t.word === 'types') {
        const info = this.data.types.lookup(text.replace(/^(?:an?|the)\s+/i, ''));
        if (info) return { ok: true, node: { kind: 'typeLiteral', start, end, type: info, children: [], unknowns: 0 } };
        continue;
      }
      const literal = this.literal(start, end);
      if (literal && literal.type && compatibleWith(this.data.types, literal.type, { ...slot, types: [t] }) !== 'no') return { ok: true, node: literal };
      if (!t.info?.family && /^[\p{L}\d][\p{L}\d _':-]*$/u.test(text) && !isBooleanLiteral(text)) {
        return { ok: true, node: { kind: 'literal', start, end, type: t.info, children: [], unknowns: 1 } };
      }
    }
    return { ok: false };
  }

  /** Lists (`a, b and c`): each element must fit the slot. Only tried when the whole span is not a known expression. */
  private list(start: number, end: number, slot: Slot): SlotVerdict | undefined {
    const pieces = splitList(this.text, start, end);
    if (pieces.length < 2) return undefined;
    const children: ExprNode[] = [];
    let failure: Problem | undefined;
    for (const [s, e] of pieces) {
      const verdict = this.check(s, e, { ...slot, single: false });
      if (!verdict.ok) {
        if (!verdict.problem) return { ok: true, node: unknownNode(start, end) };
        failure = better(failure, verdict.problem);
        continue;
      }
      children.push(verdict.node);
    }
    if (failure) return { ok: false, problem: withDoubt(failure, children.reduce((n, c) => n + c.unknowns, 0)) };
    return { ok: true, node: { kind: 'list', start, end, plural: true, children, unknowns: children.reduce((n, c) => n + c.unknowns, 0) } };
  }

  // --- readings ----------------------------------------------------------------------

  private literal(start: number, end: number): ExprNode | undefined {
    const text = this.text.slice(start, end);
    const types = this.data.types;
    if (isNumberLiteral(text)) return { kind: 'number', start, end, type: types.get(/^-?[\d_]+$/.test(text) ? 'integer' : 'number'), children: [], unknowns: 0 };
    if (isBooleanLiteral(text)) return { kind: 'boolean', start, end, type: types.get('boolean'), children: [], unknowns: 0 };
    if (isTimespanLiteral(text)) return { kind: 'timespan', start, end, type: types.get('timespan'), children: [], unknowns: 0 };
    return undefined;
  }

  /** VariableString: text, with each `%expression%` parsed as an object. */
  private string(start: number, end: number): SpanResult {
    const text = this.text;
    const children: ExprNode[] = [];
    let unknowns = 0;
    for (let i = start + 1; i < end - 1; i++) {
      const c = text[i];
      if (c === '"') {
        i++; // "" is an escaped quote
        continue;
      }
      if (c !== '%') continue;
      if (text[i + 1] === '%') {
        i++;
        continue;
      }
      const close = closingPercent(text, i + 1, end - 1);
      if (close === -1) break; // reported by the bracket checker
      const verdict = this.check(i + 1, close, this.data.slot('objects'));
      if (!verdict.ok) {
        if (verdict.problem) return { parses: [], problem: withDoubt(verdict.problem, unknowns) };
      } else {
        children.push(verdict.node);
        unknowns += verdict.node.unknowns;
      }
      i = close;
    }
    return { parses: [{ kind: 'string', start, end, type: this.data.types.get('string'), children, unknowns }] };
  }

  /** A function call, with each argument checked against the parameters of some overload. */
  private call(start: number, end: number, name: string): SpanResult {
    const open = start + name.length;
    const argsText = this.text.slice(open + 1, end - 1);
    const args = parseArguments(argsText).map((a) => {
      // The value's own span within the line, without a `name:` prefix.
      const part = argsText.slice(a.start, a.end);
      const valueEnd = open + 1 + a.start + part.trimEnd().length;
      return { ...a, valueStart: valueEnd - a.value.length, valueEnd };
    });
    const signatures = this.data.functions(name);
    const objects = this.data.slot('objects');

    if (!signatures || signatures.length === 0) {
      const children: ExprNode[] = [];
      for (const arg of args) {
        const verdict = this.check(arg.valueStart, arg.valueEnd, objects);
        if (!verdict.ok) {
          if (verdict.problem) return { parses: [], problem: withDoubt(verdict.problem, 1) };
          continue;
        }
        children.push(verdict.node);
      }
      return { parses: [{ kind: 'call', start, end, name, children, unknowns: 1 }] };
    }

    let problem: Problem | undefined;
    for (const signature of signatures) {
      const children: ExprNode[] = [];
      let failed = false;
      for (let i = 0; i < args.length && !failed; i++) {
        const arg = args[i];
        const parameter = arg.name ? signature.parameters.find((p) => p.name === arg.name) : signature.parameters[i];
        const slot = parameter ? this.data.slot(parameter.type) : objects;
        const verdict = this.check(arg.valueStart, arg.valueEnd, parameter ? { ...slot, single: !parameter.plural } : slot);
        if (verdict.ok) {
          children.push(verdict.node);
          continue;
        }
        failed = true;
        if (verdict.problem && parameter) {
          const p = verdict.problem;
          const known = children.reduce((n, c) => n + c.unknowns, 0);
          // english.lang `functions.invalid argument` (FunctionReferenceParser, 2.14 to 2.17).
          const message = `Can't understand the argument for the parameter '${parameter.name}' with type '${parameter.type}': ${this.text.slice(arg.valueStart, arg.valueEnd)}.`;
          problem = better(problem, withDoubt(p.code === 'type-mismatch' ? { ...p, code: 'argument-type', message: `${message} (${p.message})`, quality: 3 } : p, known));
        }
      }
      if (failed) continue;
      const returns = signature.returnType ? this.data.types.slot(signature.returnType) : undefined;
      return {
        parses: [{
          kind: 'call',
          start,
          end,
          name,
          signature,
          type: returns?.info,
          plural: returns?.plural ? true : undefined,
          children,
          unknowns: children.reduce((n, c) => n + c.unknowns, 0),
        }],
      };
    }
    return { parses: [], problem };
  }

  /**
   * ExprArithmetic: `%object%[ ]<op>[ ]%object%` for + - * / ^, checked with
   * Skript's operations (DefaultOperations) instead of its `Object` return type.
   */
  private arithmetic(start: number, end: number): SpanResult {
    const text = this.text;
    const parses: ExprNode[] = [];
    let problem: Problem | undefined;
    const object = this.data.slot('object');
    for (let i = start; i < end; ) {
      const next = nextToken(text, i);
      if (next === -1) break;
      const c = text[i];
      if (next === i + 1 && isOperator(c) && i > start && i < end - 1 && this.operatorAt(i, start)) {
        const left = this.check(start, i, object);
        const right = left.ok || left.problem ? this.check(i + 1, end, object) : { ok: false as const };
        if (!left.ok || !right.ok) {
          const failed = !left.ok ? left.problem : !right.ok ? right.problem : undefined;
          const other = !left.ok ? (right.ok ? right.node.unknowns : 0) : left.ok ? left.node.unknowns : 0;
          problem = better(problem, failed && withDoubt(failed, other));
        } else {
          const result = this.operation(c as Operator, left.node, right.node, start, end);
          if ('code' in result) problem = better(problem, result);
          else parses.push(result);
        }
      }
      i = next;
    }
    return { parses, problem };
  }

  /** Whether the character at `i` can be an operator rather than part of a word (`event-block`) or a sign (`-5`). */
  private operatorAt(i: number, start: number): boolean {
    const text = this.text;
    if (text[i] !== '-') return true;
    let before = i - 1;
    while (before > start && text[before] === ' ') before--;
    if (isOperator(text[before])) return false; // `5 - -3`: the second `-` is a sign
    const spacedLeft = text[i - 1] === ' ';
    const spacedRight = text[i + 1] === ' ';
    if (spacedLeft || spacedRight) return true;
    // `5-3`, `{_a}-{_b}`, `(x)-1`, but not `event-block` or `loop-value`.
    return /[\d)}"]/.test(text[i - 1]) && /[\d({"]/.test(text[i + 1]);
  }

  private operation(operator: Operator, left: ExprNode, right: ExprNode, start: number, end: number): ExprNode | Problem {
    const types = this.data.types;
    const l = left.type?.id === 'object' ? undefined : left.type;
    const r = right.type?.id === 'object' ? undefined : right.type;
    const node = (type?: TypeInfo): ExprNode => ({
      kind: 'arithmetic',
      start,
      end,
      name: operator,
      type,
      children: [left, right],
      unknowns: left.unknowns + right.unknowns,
    });
    const fail = (message: string): Problem => ({ code: 'invalid-operation', message, start, end, quality: 3, doubt: left.unknowns + right.unknowns });
    const name = OPERATOR_NAMES[operator];
    const cap = name.charAt(0).toUpperCase() + name.slice(1);

    if (l?.family && r?.family) {
      const result = operate(operator, l.family, r.family);
      if (!result) return fail(`${cap} can't be performed on ${types.withArticle(l)} and ${types.withArticle(r)}`);
      return node(familyType(types, result));
    }
    // One side known, the other a variable or another `Object`: Skript still
    // fails when the known type has no operation with this operator at all.
    const objectLike = (n: ExprNode) => n.kind === 'variable' || n.type?.id === 'object';
    if (l?.family && objectLike(right) && !hasOperation(operator, l.family, 'left')) return fail(`${cap} can't be performed on ${types.withArticle(l, left.plural)}`);
    if (r?.family && objectLike(left) && !hasOperation(operator, r.family, 'right')) return fail(`${cap} can't be performed on ${types.withArticle(r, right.plural)}`);
    return node(undefined);
  }

  /** One expression pattern on a span. */
  private expression(candidate: ExpressionCandidate, start: number, end: number): SpanResult {
    // The untyped matcher is much cheaper and rules out most patterns.
    if (!matches(candidate.pattern, this.text.slice(start, end))) return EMPTY;
    const result = this.match(candidate.pattern, start, end);
    if (!result.ok) return result.problem ? { parses: [], problem: result.problem } : EMPTY;
    let type = candidate.returns;
    let unknowns = result.unknowns;
    if (candidate.generic && result.slots.length === 0) {
      // ExprEntity and friends: an event value when the words name a type (`player`), else unverifiable.
      const words = this.text.slice(start, end).replace(/^(?:the\s+)?(?:event-)?/i, '');
      if (!/^[\p{L}][\p{L}\d _'-]*$/u.test(words) || isBooleanLiteral(words)) return EMPTY;
      const info = this.data.types.lookup(words);
      type = info ?? type;
      unknowns = info ? 0 : 1;
    }
    return {
      parses: [{ kind: 'syntax', start, end, ref: candidate.ref, type, children: result.slots, unknowns }],
    };
  }

  // --- typed pattern matching ------------------------------------------------------

  /**
   * Matches a pattern against `text[start, end)` with every slot parsed and
   * checked. The best successful match is the one with the fewest unknown
   * parts; otherwise the most telling problem.
   */
  match(pattern: CompiledPattern, start: number, end: number): MatchResult {
    if (!pattern.head) return start === end ? { ok: true, slots: [], unknowns: 0 } : NO_MATCH;
    const input = this.text.slice(start, end);
    const lower = this.lower.slice(start, end);
    const width = input.length + 1;
    const memo = new Map<number, MatchResult>();

    const run = (node: PatternNode | null, pos: number): MatchResult => {
      if (node === null) return pos === input.length ? { ok: true, slots: [], unknowns: 0 } : NO_MATCH;
      const key = node.id * width + pos;
      const cached = memo.get(key);
      if (cached) return cached;
      this.tick();
      let result: MatchResult = NO_MATCH;
      switch (node.k) {
        case 'lit': {
          const next = matchLiteral(node.text, lower, pos);
          result = next === -1 ? NO_MATCH : run(node.next, next);
          break;
        }
        case 'opt':
          result = pick(run(node.body, pos), () => run(node.next, pos));
          break;
        case 'choice': {
          for (const alt of node.alts) {
            result = pick(result, () => run(alt, pos));
            if (result.ok && result.unknowns === 0) break;
          }
          break;
        }
        case 'type': {
          const slot = this.data.slotOf(node.slot);
          for (let e = nextToken(input, pos); e !== -1; e = nextToken(input, e)) {
            if (input.slice(pos, e).trim() === '') continue;
            const rest = run(node.next, e);
            if (!rest.ok && !rest.problem) continue;
            const verdict = this.check(start + pos, start + e, slot);
            let attempt: MatchResult;
            if (!verdict.ok) attempt = verdict.problem ? { ok: false, problem: better(withDoubt(verdict.problem, rest.ok ? rest.unknowns : 0), rest.ok ? undefined : rest.problem) } : NO_MATCH;
            else if (!rest.ok) attempt = { ok: false, problem: rest.problem && withDoubt(rest.problem, verdict.node.unknowns) };
            else attempt = { ok: true, slots: [verdict.node, ...rest.slots], unknowns: verdict.node.unknowns + rest.unknowns };
            result = pick(result, () => attempt);
            if (result.ok && result.unknowns === 0) break;
          }
          break;
        }
        case 'regex': {
          const loose = /^\(?\.[+*]\)?$/.test(node.source);
          for (let e = nextToken(input, pos); e !== -1; e = nextToken(input, e)) {
            if (!node.re.test(input.slice(pos, e))) continue;
            const rest = run(node.next, e);
            // A `<.+>` stands for something Skript parses in `init` (a condition, an entity type…), which Skout does not check.
            const attempt: MatchResult = !loose ? rest : rest.ok ? { ...rest, unknowns: rest.unknowns + 1 } : { ok: false, problem: rest.problem && withDoubt(rest.problem, 1) };
            result = pick(result, () => attempt);
            if (result.ok && result.unknowns === 0) break;
          }
          break;
        }
      }
      memo.set(key, result);
      return result;
    };
    return run(pattern.head, 0);
  }
}

// --- helpers ---------------------------------------------------------------------------

function pick(current: MatchResult, next: () => MatchResult): MatchResult {
  if (current.ok && current.unknowns === 0) return current;
  const other = next();
  if (current.ok && other.ok) return other.unknowns < current.unknowns ? other : current;
  if (current.ok) return current;
  if (other.ok) return other;
  const problem = better(current.problem, other.problem);
  return problem ? { ok: false, problem } : NO_MATCH;
}

/**
 * A reading that known syntax explains completely and that fails for certain
 * beats readings that only work because some words were taken as something
 * Skout cannot check: `length of 5` is ExprLength on a number, not the armour
 * slot "length" of the entity 5.
 */
export function outweighs(problem: Problem | undefined, parses: readonly { readonly unknowns: number }[]): boolean {
  return problem !== undefined && problem.doubt === 0 && parses.every((p) => p.unknowns > 0);
}

export function better(a: Problem | undefined, b: Problem | undefined): Problem | undefined {
  if (!a) return b;
  if (!b) return a;
  // A certain problem beats a doubtful one, then Skript's error quality decides.
  if ((a.doubt === 0) !== (b.doubt === 0)) return a.doubt === 0 ? a : b;
  if (b.quality > a.quality) return b;
  // Same quality: the narrower problem is the more precise one.
  if (b.quality === a.quality && b.end - b.start < a.end - a.start) return b;
  return a;
}

function withDoubt(problem: Problem, doubt: number): Problem {
  return doubt === 0 ? problem : { ...problem, doubt: problem.doubt + doubt };
}

function rank(parses: ExprNode[]): ExprNode[] {
  const sorted = parses.map((n, i) => ({ n, i })).sort((a, b) => a.n.unknowns - b.n.unknowns || a.i - b.i).map((x) => x.n);
  return sorted.length > MAX_PARSES ? sorted.slice(0, MAX_PARSES) : sorted;
}

function unknownNode(start: number, end: number): ExprNode {
  return { kind: 'unknown', start, end, children: [], unknowns: 1 };
}

function isLiteralNode(node: ExprNode): boolean {
  return node.kind === 'number' || node.kind === 'boolean' || node.kind === 'timespan' || node.kind === 'literal' || node.kind === 'typeLiteral';
}

function isOperator(c: string | undefined): boolean {
  return c === '+' || c === '-' || c === '*' || c === '/' || c === '^';
}

/** Whether `family` has any operation with `operator` on the given side (Arithmetics#lookupLeftOperations / lookupRightOperations). */
function hasOperation(operator: Operator, family: Family, side: 'left' | 'right'): boolean {
  const others: Family[] = ['number', 'text', 'boolean', 'timespan', 'date', 'vector'];
  return others.some((other) => (side === 'left' ? operate(operator, family, other) : operate(operator, other, family)) !== undefined);
}

function familyType(types: TypeSystem, family: Family): TypeInfo | undefined {
  const id = family === 'text' ? 'string' : family;
  return types.get(id);
}

export function compatibleWith(types: TypeSystem, type: TypeInfo | undefined, slot: Slot): Compatibility {
  let best: Compatibility = 'no';
  for (const t of slot.types) {
    const c = types.compatible(type, t.info);
    if (c === 'yes') return 'yes';
    if (c === 'unknown') best = 'unknown';
  }
  return slot.types.length === 0 ? 'unknown' : best;
}

function slotKey(slot: Slot): string {
  return `${slot.types.map((t) => t.word).join('/')}${slot.single ? '1' : '+'}${slot.literalOnly ? '*' : ''}${slot.expressionOnly ? '~' : ''}`;
}

/** SkriptParser#notOfType: "not a text", "neither a player nor an entity". */
function notOfType(types: TypeSystem, slot: Slot): string {
  const names = slot.types.map((t) => (t.info ? types.withArticle(t.info) : t.word));
  if (names.length === 1) return `not ${names[0]}`;
  return `neither ${names.slice(0, -1).join(', ')} nor ${names[names.length - 1]}`;
}

function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** The `%` that closes an expression inside a string, skipping nested strings and variables. */
function closingPercent(text: string, from: number, limit: number): number {
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === '%') return i;
    if (c === '{' || c === '(') {
      const next = nextToken(text, i);
      if (next === -1 || next > limit) return -1;
      i = next - 1;
    } else if (c === '"') {
      // A string inside the expression: quotes are doubled inside the outer string.
      const close = text.indexOf('"', text[i + 1] === '"' ? i + 2 : i + 1);
      if (close === -1 || close > limit) return -1;
      i = text[close + 1] === '"' ? close + 1 : close;
    }
  }
  return -1;
}

/** Top-level `,`, ` and `, ` or ` separators of a list. */
export function splitList(text: string, start: number, end: number): [number, number][] {
  const pieces: [number, number][] = [];
  let pieceStart = start;
  const lower = text.toLowerCase();
  for (let i = start; i < end; ) {
    const c = text[i];
    let sep = 0;
    if (c === ',') sep = 1;
    else if (c === ' ' && (lower.startsWith(' and ', i) || lower.startsWith(' or ', i))) sep = lower.startsWith(' and ', i) ? 5 : 4;
    if (sep > 0) {
      pieces.push([pieceStart, i]);
      i += sep;
      // `, and`
      if (sep === 1 && (lower.startsWith(' and ', i) || lower.startsWith(' or ', i))) i += lower.startsWith(' and ', i) ? 5 : 4;
      pieceStart = i;
      continue;
    }
    const next = nextToken(text, i);
    if (next === -1) return [];
    i = next;
  }
  pieces.push([pieceStart, end]);
  return pieces.filter(([s, e]) => text.slice(s, e).trim() !== '');
}
