/**
 * Reads any supported syntax dump and normalizes it to Skout's schema. The
 * shape is detected from the content:
 *
 * - Skript's `docs.json` (`/sk gen-docs`, or docs.skriptlang.org): see skriptDocs.ts.
 * - SkriptHub Docs Tool output (`/gendocs` writes one `<Addon>.json` per addon
 *   to plugins/SkriptHubDocsTool/documentation/). Format from the tool's
 *   JsonFile.kt and SyntaxData.kt: `{ metadata: { version }, events: [...],
 *   conditions, effects, expressions, types, functions, sections, structures }`,
 *   with keys such as "return type", "event values" and "required plugins".
 * - SkriptHub's catalog API (skripthub.net/api/v1/addonsyntaxlist/): an array
 *   of records where `syntax_pattern` packs several patterns into one string.
 * - Skout's own normalized dumps.
 */
import { importSkriptDocs, isSkriptDocs } from './skriptDocs';
import type { SyntaxDump, SyntaxEntry, SyntaxKind } from './schema';

type Json = Record<string, unknown>;

export class DumpFormatError extends Error {}

/** Parses JSON, repairing the one known defect in Skript's published archives. */
export function parseDumpText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Archives 2.6.4 to 2.10.2 list the `region` type pattern as ""region name"" (unescaped quotes).
    const repaired = text.replace(/^(\s*)""([^"\n]*)""(\s*,?\s*)$/gm, '$1"\\"$2\\""$3');
    if (repaired !== text) {
      try {
        return JSON.parse(repaired);
      } catch {
        // fall through to the original error
      }
    }
    throw new DumpFormatError(`not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * @param fileName used as the addon name for SkriptHub Docs Tool files, which
 *   do not name their addon inside (`SkBee.json` → `SkBee`).
 */
export function importDump(json: unknown, fileName: string): SyntaxDump {
  if (Array.isArray(json)) {
    if (json.length === 0 || (json[0] && typeof json[0] === 'object' && 'syntax_pattern' in (json[0] as Json))) return importSkriptHubApi(json as Json[]);
    throw new DumpFormatError('an array, but not of SkriptHub syntax records');
  }
  if (!json || typeof json !== 'object') throw new DumpFormatError('not a JSON object or array');
  const obj = json as Json;
  if (obj.format === 'skout-dump@1') return obj as unknown as SyntaxDump;
  if (isSkriptDocs(obj)) return importSkriptDocs(obj);
  if (isDocsTool(obj)) return importDocsTool(obj, addonNameFromFile(fileName));
  throw new DumpFormatError("not a recognised syntax dump (expected Skript's docs.json, a SkriptHub Docs Tool file or SkriptHub records)");
}

function addonNameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.json$/i, '');
  return base || 'Unknown addon';
}

// --- SkriptHub Docs Tool -------------------------------------------------------------

const DOCS_TOOL_CATEGORIES: Record<string, SyntaxKind> = {
  events: 'event',
  conditions: 'condition',
  effects: 'effect',
  expressions: 'expression',
  types: 'type',
  functions: 'function',
  sections: 'section',
  structures: 'structure',
};

function isDocsTool(obj: Json): boolean {
  if ('source' in obj) return false;
  const hasCategory = Object.keys(DOCS_TOOL_CATEGORIES).some((k) => Array.isArray(obj[k]));
  return hasCategory && ('metadata' in obj || Object.values(obj).some((v) => Array.isArray(v) && v.some((e) => e && typeof e === 'object' && 'patterns' in e)));
}

export function importDocsTool(obj: Json, addon: string): SyntaxDump {
  const version = str((obj.metadata as Json | undefined)?.version);
  const entries: SyntaxEntry[] = [];
  for (const [category, kind] of Object.entries(DOCS_TOOL_CATEGORIES)) {
    const list = obj[category];
    if (!Array.isArray(list)) continue;
    for (const raw of list as Json[]) {
      if (!raw || typeof raw !== 'object') continue;
      entries.push(
        clean({
          id: str(raw.id) || str(raw.name),
          kind,
          name: str(raw.name),
          patterns: list_(raw.patterns),
          description: list_(raw.description).join('\n').trim(),
          examples: list_(raw.examples),
          since: list_(raw.since).join(', ') || undefined,
          addon,
          returns: str(raw['return type']) || undefined,
          eventValues: optional(list_(raw['event values'])),
          cancellable: typeof raw.cancellable === 'boolean' ? raw.cancellable : undefined,
          requirements: optional(list_(raw['required plugins'])),
          keywords: optional(list_(raw.keywords)),
        }),
      );
    }
  }
  const isSkript = addon.toLowerCase() === 'skript';
  return {
    format: 'skout-dump@1',
    source: 'skripthub-docs-tool',
    skriptVersion: isSkript ? version || undefined : undefined,
    addons: { [addon]: version },
    entries,
  };
}

// --- SkriptHub API -----------------------------------------------------------------

const API_KINDS: Record<string, SyntaxKind> = {
  event: 'event',
  condition: 'condition',
  effect: 'effect',
  expression: 'expression',
  type: 'type',
  function: 'function',
  section: 'section',
  structure: 'structure',
};

export function importSkriptHubApi(records: Json[]): SyntaxDump {
  const entries: SyntaxEntry[] = [];
  const addons: Record<string, string> = {};
  for (const r of records) {
    const kind = API_KINDS[str(r.syntax_type).trim().toLowerCase()];
    if (!kind) continue;
    const patterns = str(r.syntax_pattern)
      .split('\n')
      .map((p) => p.replace(/\r$/, '').trim())
      .filter(Boolean);
    if (patterns.length === 0) continue;
    const addonInfo = (r.addon ?? {}) as Json;
    const addon = str(addonInfo.name) || 'Unknown addon';
    addons[addon] ??= '';
    const requirements = Array.isArray(r.required_plugins) ? (r.required_plugins as Json[]).map((p) => str(p?.name)).filter(Boolean) : [];
    const mc = str(r.compatible_minecraft_version).trim();
    if (mc) requirements.push(`Minecraft ${mc}`);
    entries.push(
      clean({
        id: str(r.json_id).trim() || `skripthub:${String(r.id)}`,
        kind,
        name: str(r.title),
        patterns,
        description: str(r.description).trim(),
        examples: [],
        since: str(r.compatible_addon_version).trim() || undefined,
        addon,
        returns: str(r.return_type).trim() || undefined,
        eventValues: optional(splitList(str(r.event_values))),
        cancellable: r.event_cancellable === true ? true : undefined,
        requirements: optional(requirements),
        keywords: optional(splitList(str(r.keywords))),
        deprecated: r.mark_as_removed === true ? true : undefined,
        removedIn: str(r.removed_since).trim() || undefined,
      }),
    );
  }
  return { format: 'skout-dump@1', source: 'skripthub-api', addons, entries };
}

// --- helpers ------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list_(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function optional(items: string[]): string[] | undefined {
  return items.length > 0 ? items : undefined;
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function clean(entry: SyntaxEntry): SyntaxEntry {
  const copy = { ...entry } as Record<string, unknown>;
  for (const key of Object.keys(copy)) if (copy[key] === undefined) delete copy[key];
  return copy as unknown as SyntaxEntry;
}
