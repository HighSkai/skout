/**
 * Skript syntax patterns: a port of `ch.njol.skript.patterns.PatternCompiler`
 * and the element matchers (Skript 2.17.1).
 *
 *   [optional]   (group)   a|b choices   %type% slots   <regex>   \escape
 *   tag: and ¦mark parse tags (the text before `:` is a tag name, not matched)
 *
 * Matching follows Skript's elements: literals compare case-insensitively with
 * the same lenient handling of spaces (LiteralPatternElement), the first
 * choice that leads to a full match wins, and a `%type%` slot spans whole
 * tokens (strings, variables and bracket groups are single tokens) and is
 * never empty (TypePatternElement).
 *
 * What Skout cannot do is parse the expression inside a slot, so any
 * non-empty text fits it. Matching is therefore deliberately lenient: a line
 * that matches here may still be rejected by Skript, but a line that matches
 * nothing here is genuinely not any known syntax.
 */
import { nextToken } from '../skript/functions';

// --- syntax tree -------------------------------------------------------------

export type Element =
  | { readonly t: 'lit'; readonly text: string }
  | { readonly t: 'opt'; readonly body: Element[] }
  | { readonly t: 'group'; readonly body: Element[] }
  | { readonly t: 'choice'; readonly alts: Element[][] }
  | {
      readonly t: 'type';
      readonly types: string;
      readonly nullable: boolean;
      /** `%*type%`: only literals (TypePatternElement clears PARSE_EXPRESSIONS). */
      readonly literalOnly?: boolean;
      /** `%~type%`: no literals (TypePatternElement clears PARSE_LITERALS). */
      readonly expressionOnly?: boolean;
    }
  | { readonly t: 'regex'; readonly source: string }
  | { readonly t: 'tag' };

export class MalformedPattern extends Error {}

/** PatternCompiler#compile: returns the top-level sequence. */
export function parsePattern(pattern: string): Element[] {
  return compile(pattern);
}

function compile(pattern: string): Element[] {
  const alternatives: Element[][] = [];
  let current: Element[] = [];
  let literal = '';
  const flush = () => {
    if (literal) current.push({ t: 'lit', text: literal.toLowerCase() });
    literal = '';
  };

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '[' || c === '(') {
      flush();
      const close = nextBracket(pattern, c === '[' ? ']' : ')', c, i + 1);
      const body = compile(pattern.slice(i + 1, close));
      current.push(c === '[' ? { t: 'opt', body: unwrapGroup(body) } : { t: 'group', body });
      i = close;
    } else if (c === '|') {
      flush();
      alternatives.push(current);
      current = [];
    } else if (c === '¦' || c === ':') {
      // The text collected so far is the tag (or mark) name; it is not matched.
      literal = '';
      current.push({ t: 'tag' });
    } else if (c === '%') {
      flush();
      const end = pattern.indexOf('%', i + 1);
      if (end === -1) throw new MalformedPattern(`single percentage sign at ${i}`);
      current.push(typeElement(pattern.slice(i + 1, end)));
      i = end;
    } else if (c === '<') {
      // Published docs drop escapes (`\<=` in CondCompare is shown as `<=`), and some
      // addon docs use <placeholder text>. So a `<` is a regex only when a `>`
      // closes it and the content is not obviously something else.
      const end = pattern.indexOf('>', i + 1);
      const content = end === -1 ? '' : pattern.slice(i + 1, end);
      if (end === -1 || content === '' || content.includes('%') || /^[=)\s<]/.test(content)) {
        literal += c;
        continue;
      }
      flush();
      // Human-readable placeholders (`<option name>`) stand for any text.
      current.push({ t: 'regex', source: /^[a-z][a-z .-]*$/i.test(content) ? '.+' : content });
      i = end;
    } else if (c === '\\') {
      i++;
      literal += pattern[i] ?? '';
    } else {
      literal += c;
    }
  }
  flush();
  if (alternatives.length === 0) return current;
  return [{ t: 'choice', alts: [...alternatives, current] }];
}

/** OptionalPatternElement converts `[(a|b)]` to `[a|b]`. */
function unwrapGroup(body: Element[]): Element[] {
  return body.length === 1 && body[0].t === 'group' ? body[0].body : body;
}

function typeElement(text: string): Element {
  let i = 0;
  let nullable = false;
  let literalOnly = false;
  let expressionOnly = false;
  while (i < text.length && '-*~'.includes(text[i])) {
    if (text[i] === '-') nullable = true;
    else if (text[i] === '*') literalOnly = true;
    else expressionOnly = true;
    i++;
  }
  const at = text.indexOf('@', i);
  return { t: 'type', types: at === -1 ? text.slice(i) : text.slice(i, at), nullable, literalOnly, expressionOnly };
}

/** SkriptParser#nextBracket for groups: respects `\` escapes and nesting. */
function nextBracket(pattern: string, closing: string, opening: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') i++;
    else if (c === closing) {
      if (depth === 0) return i;
      depth--;
    } else if (c === opening) depth++;
  }
  throw new MalformedPattern(`missing closing bracket '${closing}'`);
}

// --- linked form for matching -------------------------------------------------

/** Each node knows what follows it, like Skript's linked PatternElements, so a match is a function of (node, offset). */
export type PatternNode =
  | { id: number; k: 'lit'; text: string; next: PatternNode | null }
  | { id: number; k: 'opt'; body: PatternNode | null; next: PatternNode | null }
  | { id: number; k: 'choice'; alts: (PatternNode | null)[] }
  | { id: number; k: 'type'; slot: Extract<Element, { t: 'type' }>; index: number; next: PatternNode | null }
  | { id: number; k: 'regex'; re: RegExp; source: string; next: PatternNode | null };
type Node = PatternNode;

export interface CompiledPattern {
  readonly source: string;
  readonly elements: Element[];
  readonly head: Node | null;
  /** Number of linked nodes, for memo keys. */
  readonly size: number;
  /** Number of `%slots%`. */
  readonly slots: number;
  /** Lower-case words that every match must contain, for a quick pre-check. */
  readonly required: readonly string[];
  /** Literal words anywhere in the pattern, for typo suggestions. */
  readonly words: readonly string[];
  /** Literal words outside optional parts: one of them is always in a matching line. */
  readonly anchors: readonly string[];
  /** Starts with fixed words rather than a slot, so it can only match lines that begin with them. */
  readonly anchored: boolean;
}

/** Whether the first element that must be present is literal text (or a choice of literal texts). */
function startsWithText(seq: Element[]): boolean {
  for (const e of seq) {
    if (e.t === 'tag' || e.t === 'opt' || (e.t === 'lit' && e.text.trim() === '')) continue;
    if (e.t === 'lit') return true;
    if (e.t === 'group') return startsWithText(e.body);
    if (e.t === 'choice') return e.alts.every((alt) => startsWithText(alt));
    return false;
  }
  return false;
}

export function compilePattern(source: string): CompiledPattern {
  const elements = parsePattern(source);
  let id = 0;
  let slots = 0;
  const link = (seq: Element[], next: Node | null): Node | null => {
    let node = next;
    for (let i = seq.length - 1; i >= 0; i--) node = build(seq[i], node);
    return node;
  };
  const build = (e: Element, next: Node | null): Node | null => {
    switch (e.t) {
      case 'lit':
        return { id: id++, k: 'lit', text: e.text, next };
      case 'opt':
        return { id: id++, k: 'opt', body: link(e.body, next), next };
      case 'group':
        return link(e.body, next);
      case 'choice':
        return { id: id++, k: 'choice', alts: e.alts.map((alt) => link(alt, next)) };
      case 'type':
        return { id: id++, k: 'type', slot: e, index: slots++, next };
      case 'regex':
        return { id: id++, k: 'regex', re: javaRegex(e.source), source: e.source, next };
      case 'tag':
        return next;
    }
  };
  const head = link(elements, null);
  const required: string[] = [];
  for (const e of elements) if (e.t === 'lit') required.push(...e.text.split(/\s+/).filter((w) => w.length >= 2));
  const words = new Set<string>();
  const anchors = new Set<string>();
  const collect = (seq: Element[], optional: boolean) => {
    for (const e of seq) {
      if (e.t === 'lit') {
        for (const w of e.text.split(/[^\p{L}\d'-]+/u)) {
          if (w.length < 2) continue;
          words.add(w);
          if (!optional) anchors.add(w);
        }
      } else if (e.t === 'opt') collect(e.body, true);
      else if (e.t === 'group') collect(e.body, optional);
      else if (e.t === 'choice') e.alts.forEach((alt) => collect(alt, optional));
    }
  };
  collect(elements, false);
  return { source, elements, head, size: id, slots, required, words: [...words], anchors: [...anchors], anchored: startsWithText(elements) };
}

function javaRegex(source: string): RegExp {
  try {
    return new RegExp(`^(?:${source})$`, 's');
  } catch {
    return /^.+$/s; // a Java-only construct; stay lenient
  }
}

// --- matching ------------------------------------------------------------------

/** Whether `text` (already trimmed, options substituted) matches the pattern. */
export function matches(pattern: CompiledPattern, text: string): boolean {
  const input = text.trim();
  const lower = input.toLowerCase();
  for (const word of pattern.required) if (!lower.includes(word)) return false;

  const memo = new Map<number, boolean>();
  const width = input.length + 1;
  let steps = 0;

  const match = (node: Node | null, pos: number): boolean => {
    if (node === null) return pos === input.length;
    const key = node.id * width + pos;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (++steps > 20000) return false; // pathological pattern; treat as no match
    let result = false;
    switch (node.k) {
      case 'lit': {
        const end = matchLiteral(node.text, lower, pos);
        result = end !== -1 && match(node.next, end);
        break;
      }
      case 'opt':
        result = match(node.body, pos) || match(node.next, pos);
        break;
      case 'choice':
        result = node.alts.some((alt) => match(alt, pos));
        break;
      case 'type':
        for (let end = nextToken(input, pos); end !== -1 && !result; end = nextToken(input, end)) {
          if (input.slice(pos, end).trim() !== '' && match(node.next, end)) result = true;
        }
        break;
      case 'regex':
        for (let end = nextToken(input, pos); end !== -1 && !result; end = nextToken(input, end)) {
          if (node.re.test(input.slice(pos, end)) && match(node.next, end)) result = true;
        }
        break;
    }
    memo.set(key, result);
    return result;
  };
  return match(pattern.head, 0);
}

/** LiteralPatternElement#match, including its lenient handling of spaces. */
export function matchLiteral(literal: string, lower: string, pos: number): number {
  let i = pos;
  for (const c of literal) {
    if (c === ' ') {
      if (i === 0 || i === lower.length) continue;
      if (lower[i] === ' ') {
        i++;
        continue;
      }
      if (lower[i - 1] === ' ') continue;
      return -1;
    }
    if (i === lower.length || c !== lower[i]) return -1;
    i++;
  }
  return i;
}

// --- rendering ---------------------------------------------------------------------

/**
 * The shortest reading of a pattern: first choices, no optional parts.
 * `snippet` uses LSP placeholders for slots; `label` shows them as `%type%`.
 */
export function render(elements: Element[]): { snippet: string; label: string } {
  let n = 0;
  const walk = (seq: Element[], snippet: boolean): string =>
    seq
      .map((e) => {
        switch (e.t) {
          case 'lit':
            return snippet ? escapeSnippet(e.text) : e.text;
          case 'opt':
          case 'tag':
            return '';
          case 'group':
            return walk(e.body, snippet);
          case 'choice': {
            const alt = e.alts.find((a) => walk(a, false).trim() !== '') ?? e.alts[0];
            return walk(alt, snippet);
          }
          case 'type': {
            const name = e.types.split('/')[0];
            return snippet ? `\${${++n}:${escapeSnippet(name)}}` : `%${name}%`;
          }
          case 'regex':
            return snippet ? `\${${++n}:…}` : '…';
        }
      })
      .join('');
  const label = tidy(walk(elements, false));
  n = 0;
  const snippet = tidy(walk(elements, true));
  return { snippet, label };
}

/**
 * One reading per alternative of the pattern's first top-level choice, so
 * `[player] (login|logging in|join[ing])` can be found by typing "join" and
 * `(message|send [message[s]]) %objects%` by typing "send". At most `max`.
 */
export function renderVariants(elements: Element[], max = 4): { snippet: string; label: string }[] {
  const at = elements.findIndex((e) => e.t === 'choice' || (e.t === 'group' && e.body.length === 1 && e.body[0].t === 'choice'));
  if (at === -1) return [render(elements)];
  const choice = elements[at];
  const alts = choice.t === 'choice' ? choice.alts : (choice as { body: Element[] }).body[0].t === 'choice' ? ((choice as { body: Element[] }).body[0] as { alts: Element[][] }).alts : [];
  const variants: { snippet: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const alt of alts) {
    const variant = render([...elements.slice(0, at), { t: 'group', body: alt }, ...elements.slice(at + 1)]);
    if (variant.label === '' || seen.has(variant.label)) continue;
    seen.add(variant.label);
    variants.push(variant);
    if (variants.length === max) break;
  }
  return variants.length > 0 ? variants : [render(elements)];
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, (c) => `\\${c}`);
}
