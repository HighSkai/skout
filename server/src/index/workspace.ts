/**
 * The project-wide index: one FileIndex per `.sk` file, open or not. Updating
 * a file re-parses and re-extracts only that file; everything cross-file is
 * computed from the per-file results on demand.
 */
import { parseScript } from '../parser/parser';
import type { Version } from '../skript/version';
import { extract } from './extract';
import type { FileIndex, FunctionCall, FunctionDef, Segment, VariableOccurrence } from './types';

export class WorkspaceIndex {
  private readonly files = new Map<string, FileIndex>();
  /** Bumped on every change, so callers can cache derived data. */
  generation = 0;

  constructor(private version: Version) {}

  setVersion(version: Version): void {
    this.version = version;
    for (const [uri, file] of this.files) {
      const lines = file.script.lines.map((l) => l.text).join('\n');
      const extracted = extract(uri, parseScript(lines), version);
      this.files.set(uri, file.disabled ? { ...extracted, disabled: true } : extracted);
    }
    this.generation++;
  }

  update(uri: string, text: string, disabled = false): FileIndex {
    const extracted = extract(uri, parseScript(text), this.version);
    const file = disabled ? { ...extracted, disabled } : extracted;
    this.files.set(uri, file);
    this.generation++;
    return file;
  }

  delete(uri: string): boolean {
    const deleted = this.files.delete(uri);
    if (deleted) this.generation++;
    return deleted;
  }

  get(uri: string): FileIndex | undefined {
    return this.files.get(uri);
  }

  has(uri: string): boolean {
    return this.files.has(uri);
  }

  all(): IterableIterator<FileIndex> {
    return this.files.values();
  }

  uris(): string[] {
    return [...this.files.keys()];
  }

  get size(): number {
    return this.files.size;
  }

  // --- functions -------------------------------------------------------------

  /**
   * The definitions a call in `fromUri` can reach, as FunctionRegistry#getSignatures
   * does: local functions of that script, then global ones.
   */
  visibleFunctions(name: string, fromUri: string): FunctionDef[] {
    const from = this.files.get(fromUri);
    const local = (from?.functions ?? []).filter((f) => f.local && f.name === name);
    const global = this.globalTable().get(name) ?? [];
    // A disabled script still sees its own global functions.
    const own = from?.disabled ? from.functions.filter((f) => !f.local && f.name === name) : [];
    return [...local, ...global, ...own];
  }

  globalFunctions(): FunctionDef[] {
    return [...this.globalTable().values()].flat();
  }

  private table: { generation: number; byName: Map<string, FunctionDef[]> } | undefined;

  /** Global functions of enabled scripts by name, rebuilt only after a change. */
  private globalTable(): Map<string, FunctionDef[]> {
    if (this.table?.generation === this.generation) return this.table.byName;
    const byName = new Map<string, FunctionDef[]>();
    for (const file of this.files.values()) {
      if (file.disabled) continue;
      for (const f of file.functions) {
        if (f.local) continue;
        const list = byName.get(f.name);
        if (list) list.push(f);
        else byName.set(f.name, [f]);
      }
    }
    this.table = { generation: this.generation, byName };
    return byName;
  }

  /** Calls that resolve to `def`: in its own script for a local function, else everywhere it is not shadowed. */
  callsTo(def: FunctionDef): FunctionCall[] {
    const result: FunctionCall[] = [];
    const fromDisabled = this.files.get(def.uri)?.disabled === true;
    for (const file of this.files.values()) {
      if ((def.local || fromDisabled) && file.uri !== def.uri) continue;
      if (!def.local && file.functions.some((f) => f.local && f.name === def.name)) continue;
      for (const call of file.calls) if (call.name === def.name) result.push(call);
    }
    return result;
  }

  // --- variables -------------------------------------------------------------

  /** All occurrences of the variable `occurrence` names (same key; same scope for locals). */
  sameVariable(occurrence: VariableOccurrence): VariableOccurrence[] {
    return this.variablesWhere((v) => v.key === occurrence.key && sameScope(v, occurrence));
  }

  /** Occurrences whose first `depth` segments match `prefix` (a namespace). */
  inNamespace(prefix: readonly Segment[], like: VariableOccurrence): VariableOccurrence[] {
    return this.variablesWhere(
      (v) => sameScope(v, like) && v.segments.length >= prefix.length && prefix.every((s, i) => segmentEquals(s, v.segments[i])),
    );
  }

  variablesWhere(predicate: (v: VariableOccurrence) => boolean): VariableOccurrence[] {
    const result: VariableOccurrence[] = [];
    for (const file of this.files.values()) for (const v of file.variables) if (predicate(v)) result.push(v);
    return result;
  }
}

/** Globals share one scope; locals belong to one structure in one file. */
export function sameScope(a: VariableOccurrence, b: VariableOccurrence): boolean {
  if (a.local !== b.local) return false;
  return !a.local || (a.uri === b.uri && a.scope === b.scope);
}

export function segmentEquals(a: Segment, b: Segment): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'literal' ? a.norm === b.norm : a.kind === 'wildcard' || a.text.replace(/\s+/g, ' ') === b.text.replace(/\s+/g, ' ');
}

/**
 * Whether a write to `write` may have set the variable `read` uses. Dynamic
 * parts (`%player%`) may hold any value, and a list (`::*`) covers every
 * element under it, so this errs towards "yes".
 */
export function writeCovers(write: readonly Segment[], read: readonly Segment[]): boolean {
  for (let i = 0; ; i++) {
    if (i >= write.length) return i >= read.length;
    if (i >= read.length) return false;
    const w = write[i];
    const r = read[i];
    if (w.kind === 'wildcard' || r.kind === 'wildcard') return true;
    if (w.kind === 'dynamic' || r.kind === 'dynamic') continue;
    if (w.norm !== r.norm) return false;
  }
}
