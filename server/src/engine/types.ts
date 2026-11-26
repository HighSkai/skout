/**
 * Skript's types as far as Skout can know them statically.
 *
 * Names come from Skript's default.lang (`typeNames.generated.ts`) for core
 * types and from the syntax dumps for addon types. Slot words such as
 * `%entity types%` are resolved the way SkriptParser#createExprInfo does it:
 * Utils#getEnglishPlural splits off the plural, then the singular is looked up
 * by name.
 *
 * Type checking is closed-world over a small set of families whose conversions
 * Skout knows completely from Skript's DefaultConverters and DefaultOperations
 * (2.17.1): numbers, text, booleans, time spans, dates and vectors. Between two
 * members of that set, Skout can say for certain that no conversion exists.
 * Anything involving another type is "unknown" and never an error, because an
 * addon may register converters that Skout cannot see.
 */
import { isPlural } from '../skript/plural';
import type { SyntaxEntry } from '../syntax/schema';
import { TYPE_NAMES } from './typeNames.generated';

export type Family = 'number' | 'text' | 'boolean' | 'timespan' | 'date' | 'vector';

export interface TypeInfo {
  /** Skript's codename, e.g. `string`, `itemtype`, or an addon type's documented id. */
  readonly id: string;
  readonly singular: string;
  readonly plural: string;
  /** `a`, `an`, or empty. */
  readonly article: string;
  /** Set for the closed-world types. */
  readonly family?: Family;
}

const FAMILIES: Readonly<Record<string, Family>> = {
  number: 'number',
  integer: 'number',
  long: 'number',
  short: 'number',
  byte: 'number',
  double: 'number',
  float: 'number',
  string: 'text',
  boolean: 'boolean',
  timespan: 'timespan',
  date: 'date',
  vector: 'vector',
};

export interface SlotType {
  /** As written in the pattern, e.g. `entity types`. */
  readonly word: string;
  /** Undefined when Skout does not know the type (an addon type without a dump). */
  readonly info?: TypeInfo;
  readonly plural: boolean;
}

export type Compatibility = 'yes' | 'no' | 'unknown';

export class TypeSystem {
  private readonly byId = new Map<string, TypeInfo>();
  private readonly byName = new Map<string, TypeInfo>();
  private readonly slotCache = new Map<string, SlotType>();
  readonly object: TypeInfo;

  constructor(entries: readonly SyntaxEntry[]) {
    for (const [id, [singular, plural, article]] of Object.entries(TYPE_NAMES)) {
      this.add({ id, singular, plural, article, family: FAMILIES[id] });
    }
    // Lang names first, so "integer" means Skript's integer and not long or short.
    for (const [id, [singular, plural]] of Object.entries(TYPE_NAMES)) {
      const info = this.byId.get(id)!;
      this.name(singular, info);
      this.name(plural, info);
      this.name(singular.replace(/\s*\(.*\)$/, ''), info); // "boolean (yes/no)"
    }
    for (const entry of entries) {
      if (entry.kind !== 'type') continue;
      const id = entry.id.toLowerCase();
      let info = this.byId.get(id);
      if (!info) {
        const singular = (entry.name || entry.id).toLowerCase();
        info = { id, singular, plural: isPlural(singular).plural ? singular : `${singular}s`, article: /^[aeiou]/.test(singular) ? 'an' : 'a', family: FAMILIES[id] };
        this.add(info);
      }
      this.name(entry.name, info);
      this.name(entry.id, info);
    }
    this.object = this.byId.get('object')!;
  }

  private add(info: TypeInfo): void {
    if (!this.byId.has(info.id)) this.byId.set(info.id, info);
    this.name(info.id, info);
  }

  private name(name: string | undefined, info: TypeInfo): void {
    if (!name) return;
    const key = name.toLowerCase().trim();
    if (key && !this.byName.has(key)) this.byName.set(key, info);
    const compact = key.replace(/[\s_-]+/g, '');
    if (compact && !this.byName.has(compact)) this.byName.set(compact, info);
  }

  get(id: string): TypeInfo | undefined {
    return this.byId.get(id);
  }

  /** A type by any of its names, singular or plural. */
  lookup(name: string): TypeInfo | undefined {
    const key = name.toLowerCase().trim();
    return this.byName.get(key) ?? this.byName.get(key.replace(/[\s_-]+/g, ''));
  }

  /** One alternative of a `%slot%`, e.g. `entity types` → entity type, plural. */
  slot(word: string): SlotType {
    let cached = this.slotCache.get(word);
    if (cached) return cached;
    const trimmed = word.trim();
    const { updated, plural } = isPlural(trimmed);
    const info = this.lookup(updated) ?? this.lookup(trimmed);
    cached = { word: trimmed, info, plural };
    this.slotCache.set(word, cached);
    return cached;
  }

  /** A documented return type ("Text", "long", "Object"), or undefined when unknown. */
  returns(name: string | undefined): TypeInfo | undefined {
    if (!name) return undefined;
    return this.lookup(name) ?? this.lookup(isPlural(name).updated);
  }

  /** "a text", "an integer". */
  withArticle(info: TypeInfo, plural = false): string {
    if (plural) return info.plural;
    return info.article ? `${info.article} ${info.singular}` : info.singular;
  }

  /**
   * Whether a value of type `from` can fill a slot of type `to`: assignable, or
   * convertible with one of Skript's converters. Only answers "no" inside the
   * closed world.
   */
  compatible(from: TypeInfo | undefined, to: TypeInfo | undefined): Compatibility {
    if (!from || !to) return 'unknown';
    if (to.id === 'object' || from.id === 'object' || from.id === to.id) return 'yes';
    if (from.family && to.family) {
      if (from.family === to.family) return 'yes';
      // DefaultConverters: Number → Vector.
      if (from.family === 'number' && to.family === 'vector') return 'yes';
      return 'no';
    }
    return 'unknown';
  }
}

// --- arithmetic ----------------------------------------------------------------------

export type Operator = '+' | '-' | '*' | '/' | '^';

/** Operator#getName as Skript prints it in "<operator> can't be performed on …". */
export const OPERATOR_NAMES: Readonly<Record<Operator, string>> = {
  '+': 'addition',
  '-': 'subtraction',
  '*': 'multiplication',
  '/': 'division',
  '^': 'exponentiation',
};

interface Operation {
  readonly left: Family;
  readonly right: Family;
  readonly returns: Family;
}

const op = (left: Family, right: Family, returns: Family): Operation => ({ left, right, returns });

/**
 * DefaultOperations (Skript 2.17.1), by operator, including the commutative
 * variants registered alongside (Number * Vector, Number / Vector, Number * Timespan).
 */
const OPERATIONS: Readonly<Record<Operator, readonly Operation[]>> = {
  '+': [op('number', 'number', 'number'), op('vector', 'vector', 'vector'), op('timespan', 'timespan', 'timespan'), op('date', 'timespan', 'date'), op('text', 'text', 'text')],
  '-': [op('number', 'number', 'number'), op('vector', 'vector', 'vector'), op('timespan', 'timespan', 'timespan'), op('date', 'timespan', 'date')],
  '*': [op('number', 'number', 'number'), op('vector', 'vector', 'vector'), op('vector', 'number', 'vector'), op('number', 'vector', 'vector'), op('timespan', 'number', 'timespan'), op('number', 'timespan', 'timespan')],
  '/': [op('number', 'number', 'number'), op('vector', 'vector', 'vector'), op('vector', 'number', 'vector'), op('number', 'vector', 'vector'), op('timespan', 'timespan', 'number'), op('timespan', 'number', 'timespan')],
  '^': [op('number', 'number', 'number')],
};

/** Converters between closed families (DefaultConverters: Number → Vector). */
function converts(from: Family, to: Family): boolean {
  return from === to || (from === 'number' && to === 'vector');
}

/**
 * The family an operation on two closed-world operands returns, or undefined
 * when Skript has no such operation (Arithmetics#lookupOperationInfo, which
 * also tries the operands' converters).
 */
export function operate(operator: Operator, left: Family, right: Family): Family | undefined {
  for (const operation of OPERATIONS[operator]) {
    if (operation.left === left && operation.right === right) return operation.returns;
  }
  for (const operation of OPERATIONS[operator]) {
    if (converts(left, operation.left) && converts(right, operation.right)) return operation.returns;
  }
  return undefined;
}
