/**
 * Function signatures and calls, following Skript 2.17.1:
 *
 * - StructFunction.SIGNATURE_PATTERN and FunctionParser for definitions;
 * - FunctionReferenceParser.FUNCTION_CALL_PATTERN and FunctionArgumentParser
 *   for calls;
 * - Signature#getMinParameters / getMaxParameters for argument counts;
 * - SkriptParser#next for splitting at top-level commas.
 *
 * Version differences that matter (checked against each release's source):
 * overloading by parameter types arrived in 2.12; `->` return types and named
 * arguments (`f(amount: 5)`) arrived in 2.14.
 */
import { isPlural } from './plural';
import { atLeast, type Version } from './version';

/** Functions.functionNamePattern (`\p{IsAlphabetic}` in Java). */
export const FUNCTION_NAME = /^[\p{Alphabetic}_][\p{Alphabetic}\d_]*$/u;

const SIGNATURE_214 = /^(?:local )?function (?<name>[\p{Alphabetic}_][\p{Alphabetic}\d_]*)\((?<args>.*?)\)(?:\s*(?<arrow>->|::| returns )\s*(?<returns>.+))?$/u;
const SIGNATURE_OLD = /^(?:local )?function (?<name>[\p{Alphabetic}_][\p{Alphabetic}\d_]*)\((?<args>.*?)\)(?:\s*(?<arrow>::| returns )\s*(?<returns>.+))?$/u;

/** FunctionParser.SCRIPT_PARAMETER_PATTERN */
const PARAMETER = /^\s*(?<name>[^:(){}",]+?)\s*:\s*(?<type>[a-zA-Z ]+?)\s*(?:\s*=\s*(?<def>.+))?\s*$/;

/** FunctionArgumentParser.PART_PATTERN */
const ARGUMENT_PART = /^(?:\s*(?<name>[^:(){}",]+):)?(?<value>.+)$/s;

export interface Parameter {
  /** As written, e.g. `items::*`. */
  readonly name: string;
  /** The local variable it becomes, without braces, e.g. `_items::*` or `_p`. */
  readonly variable: string;
  readonly type: string;
  readonly plural: boolean;
  readonly defaultValue?: string;
  /** Offset of the parameter text inside the signature's argument list. */
  readonly offset: number;
}

export interface Signature {
  readonly name: string;
  readonly local: boolean;
  readonly parameters: readonly Parameter[];
  readonly returnType?: string;
  readonly arrow?: '->' | '::' | 'returns';
  /** Offset of the name in the signature text. */
  readonly nameOffset: number;
}

export type SignatureResult =
  | { readonly ok: true; readonly signature: Signature }
  | { readonly ok: false; readonly message: string; readonly name?: string; readonly nameOffset?: number };

/**
 * Parses a function structure header (the section key, without the trailing
 * `:` and with options already substituted).
 */
export function parseSignature(header: string, version: Version): SignatureResult {
  const modern = atLeast(version, 2, 14);
  const match = (modern ? SIGNATURE_214 : SIGNATURE_OLD).exec(header);
  if (!match?.groups) {
    const nameMatch = /^(?:local\s+)?function\s+([^\s(]+)/u.exec(header);
    let message = `Invalid function signature: ${header}`;
    if (!modern && SIGNATURE_214.test(header)) message += ` (the '->' return type needs Skript 2.14 or newer)`;
    else if (/^(?:local\s+)?function\s+([^\s(]+)/u.test(header) && nameMatch && !FUNCTION_NAME.test(nameMatch[1])) {
      message += ` (a function name starts with a letter or _ and contains only letters, digits and _)`;
    }
    return { ok: false, message, name: nameMatch?.[1], nameOffset: nameMatch ? header.indexOf(nameMatch[1]) : undefined };
  }

  const { name, args, arrow, returns } = match.groups;
  const nameOffset = header.indexOf(name, header.indexOf('function') + 'function'.length);
  const argsOffset = nameOffset + name.length + 1;
  const parameters: Parameter[] = [];

  if (args.length > 0) {
    const parts = splitTopLevel(args);
    if (!parts) {
      return { ok: false, message: 'Invalid text/variables/parentheses in the arguments of this function', name, nameOffset };
    }
    const seen = new Set<string>();
    for (const part of parts) {
      const p = PARAMETER.exec(part.text);
      if (!p?.groups) {
        return {
          ok: false,
          name,
          nameOffset,
          message: `The ${ordinal(parameters.length + 1)} argument's definition is invalid. It should look like 'name: type' or 'name: type = default value'.`,
        };
      }
      const paramName = p.groups.name;
      const key = paramName.toLowerCase();
      if (seen.has(key)) {
        return { ok: false, name, nameOffset, message: `Each argument's name must be unique, but the name '${paramName}' occurs at least twice.` };
      }
      seen.add(key);
      const plural = isPlural(p.groups.type).plural;
      // FunctionParser strips a trailing `::*` (or turns it into `::1` for a
      // single type); a plural parameter is then stored as a list variable.
      const base = paramName.endsWith('*') ? paramName.slice(0, -3) + (plural ? '' : '::1') : paramName;
      parameters.push({
        name: paramName,
        variable: plural ? `_${base}::*` : `_${base}`,
        type: p.groups.type,
        plural,
        defaultValue: p.groups.def,
        offset: argsOffset + part.start,
      });
    }
  }

  return {
    ok: true,
    signature: {
      name,
      local: header.startsWith('local '),
      parameters,
      returnType: returns?.trim(),
      arrow: arrow === undefined ? undefined : arrow.trim() === 'returns' ? 'returns' : (arrow.trim() as '->' | '::'),
      nameOffset,
    },
  };
}

/** Signature#getMinParameters: parameters up to the last one without a default. */
export function minArguments(signature: Signature): number {
  for (let i = signature.parameters.length - 1; i >= 0; i--) {
    if (signature.parameters[i].defaultValue === undefined) return i + 1;
  }
  return 0;
}

export function maxArguments(signature: Signature): number {
  return signature.parameters.length;
}

/** A function with one plural parameter accepts any number of arguments as its list. */
export function isListFunction(signature: Signature): boolean {
  return signature.parameters.length === 1 && signature.parameters[0].plural;
}

/**
 * Whether two signatures collide in Skript's registry. Since 2.12 functions
 * are told apart by parameter types (overloading); before that, by name alone.
 * Type names are compared as written (singular form plus plurality); aliases
 * such as `num` for `number` are not resolved, so a collision through an alias
 * is missed rather than guessed.
 */
export function sameRegistryKey(a: Signature, b: Signature, version: Version): boolean {
  if (a.name !== b.name || a.local !== b.local) return false;
  if (!atLeast(version, 2, 12)) return true;
  if (a.parameters.length !== b.parameters.length) return false;
  return a.parameters.every((p, i) => typeKey(p) === typeKey(b.parameters[i]));
}

function typeKey(p: Parameter): string {
  const { updated, plural } = isPlural(p.type.trim());
  return `${updated.toLowerCase()}${plural ? '[]' : ''}`;
}

export function formatSignature(signature: Signature): string {
  const params = signature.parameters
    .map((p) => `${p.name}: ${p.type}${p.defaultValue !== undefined ? ` = ${p.defaultValue}` : ''}`)
    .join(', ');
  const returns = signature.returnType ? ` :: ${signature.returnType}` : '';
  return `${signature.local ? 'local ' : ''}function ${signature.name}(${params})${returns}`;
}

export interface CallArgument {
  /** Set for named arguments (`amount: 5`), Skript 2.14+. */
  readonly name?: string;
  readonly value: string;
  /** Offset of the argument in the argument text. */
  readonly start: number;
  readonly end: number;
}

/** FunctionArgumentParser: top-level commas split arguments; empty parts are dropped. */
export function parseArguments(args: string): CallArgument[] {
  if (args.length === 0) return [];
  const parts = splitTopLevel(args) ?? [{ text: args, start: 0 }];
  const result: CallArgument[] = [];
  for (const part of parts) {
    const m = ARGUMENT_PART.exec(part.text);
    if (!m?.groups) continue;
    result.push({
      name: m.groups.name?.trim(),
      value: m.groups.value.trim(),
      start: part.start,
      end: part.start + part.text.length,
    });
  }
  return result;
}

/** Splits at commas outside strings, variables and parentheses. Returns undefined if one is unclosed. */
export function splitTopLevel(text: string): { text: string; start: number }[] | undefined {
  const parts: { text: string; start: number }[] = [];
  let start = 0;
  let i = 0;
  while (i <= text.length) {
    if (i === text.length || text[i] === ',') {
      parts.push({ text: text.slice(start, i), start });
      start = i + 1;
      i++;
      continue;
    }
    const next = nextToken(text, i);
    if (next === -1) return undefined;
    i = next;
  }
  return parts;
}

/** SkriptParser#next: skips a string, a variable or a parenthesised group as one token. */
export function nextToken(text: string, i: number): number {
  if (i >= text.length) return -1;
  switch (text[i]) {
    case '"': {
      const end = nextQuote(text, i + 1);
      return end < 0 ? -1 : end + 1;
    }
    case '{': {
      const end = nextVariableBracket(text, i + 1);
      return end < 0 ? -1 : end + 1;
    }
    case '(': {
      for (let j = i + 1; j >= 0 && j < text.length; j = nextToken(text, j)) {
        if (text[j] === ')') return j + 1;
      }
      return -1;
    }
    default:
      return i + 1;
  }
}

/** SkriptParser#nextQuote: `%` toggles an expression, `""` is an escaped quote. */
function nextQuote(text: string, start: number): number {
  let inExpression = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && !inExpression) {
      if (i === text.length - 1 || text[i + 1] !== '"') return i;
      i++;
    } else if (c === '%') {
      inExpression = !inExpression;
    }
  }
  return -1;
}

/** VariableString#nextVariableBracket */
function nextVariableBracket(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (text[i] === '{') {
      depth++;
    }
  }
  return -1;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
