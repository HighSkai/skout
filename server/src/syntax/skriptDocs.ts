/**
 * Importer for Skript's own `docs.json`, written by
 * `ch.njol.skript.doc.JSONGenerator` (schema version 2.0). It is what
 * docs.skriptlang.org publishes and what `/sk gen-docs` writes to
 * `plugins/Skript/docs/docs.json`.
 *
 * The generator is inconsistent, so every field is read defensively (checked
 * against the 2.13.2 to 2.17.1 archives): `since` is an array for most kinds
 * but a string for types and functions, `description` is usually an array but
 * sometimes a string, `patterns` and other arrays are often `null`, and
 * experiments spell it `pattern`.
 */
import type { SyntaxDump, SyntaxEntry, SyntaxKind } from './schema';

const CATEGORIES: Record<string, SyntaxKind> = {
  events: 'event',
  conditions: 'condition',
  effects: 'effect',
  expressions: 'expression',
  sections: 'section',
  structures: 'structure',
  types: 'type',
  functions: 'function',
};

type Json = Record<string, unknown>;

export function isSkriptDocs(json: unknown): boolean {
  const j = json as Json | null;
  return !!j && typeof j === 'object' && !Array.isArray(j) && Array.isArray(j.effects) && 'source' in j;
}

export function importSkriptDocs(json: unknown): SyntaxDump {
  const root = json as Json;
  const source = (root.source ?? {}) as Json;
  const addon = str(source.name) || 'Skript';
  const version = str(source.version);
  const entries: SyntaxEntry[] = [];

  for (const [category, kind] of Object.entries(CATEGORIES)) {
    const list = root[category];
    if (!Array.isArray(list)) continue;
    for (const raw of list as Json[]) {
      if (!raw || typeof raw !== 'object') continue;
      const patterns = list_(raw.patterns ?? raw.pattern);
      const entry: SyntaxEntry = {
        id: str(raw.id) || str(raw.name),
        kind,
        name: str(raw.name),
        patterns,
        description: list_(raw.description).join('\n').trim(),
        examples: list_(raw.examples),
        since: list_(raw.since).join(', ') || undefined,
        addon,
        deprecated: raw.deprecated === true ? true : undefined,
        returns: reference(raw.returns),
        eventValues: Array.isArray(raw.eventValues) ? raw.eventValues.map(reference).filter((v): v is string => !!v) : undefined,
        cancellable: typeof raw.cancellable === 'boolean' ? raw.cancellable : undefined,
        requirements: optionalList(raw.requirements),
        keywords: optionalList(raw.keywords),
      };
      entries.push(stripUndefined(entry));
    }
  }

  return { format: 'skout-dump@1', source: 'skript-docs', skriptVersion: version || undefined, addons: { [addon]: version }, entries };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A string, an array of strings, or null, always as a list. */
function list_(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function optionalList(value: unknown): string[] | undefined {
  const items = list_(value);
  return items.length > 0 ? items : undefined;
}

/** `{ "id": "long", "name": "" }` → the readable name, else the id. */
function reference(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Json;
  return str(v.name) || str(v.id) || undefined;
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}
