/**
 * Diagnostics that need the whole workspace: function definitions and calls
 * across files, `{@option}` references, and variables that are read but never
 * set. Every rule follows Skript's source; see server/src/skript/functions.ts.
 */
import type { FileIndex, FunctionCall, FunctionDef, VariableOccurrence } from '../index/types';
import { writeCovers, type WorkspaceIndex } from '../index/workspace';
import type { Issue, IssueCategory, IssueCode, RelatedLocation, Severity } from '../parser/types';
import { formatSignature, isListFunction, maxArguments, minArguments, sameRegistryKey, type Signature } from '../skript/functions';
import { atLeast, compareVersions, type Version } from '../skript/version';
import type { SkoutSettings } from '../settings';
import type { SkriptSyntax, SyntaxCatalog } from '../syntax/catalog';

export interface ProjectContext {
  readonly index: WorkspaceIndex;
  readonly catalog: SyntaxCatalog;
  /** Built-in syntax from the bundled dump closest to the target version. */
  readonly syntax: SkriptSyntax;
  /** The Skript version scripts target (skout.skriptVersion); version-dependent rules follow it. */
  readonly version: Version;
  readonly settings: SkoutSettings;
}

export function projectIssues(ctx: ProjectContext): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>();
  const add = (uri: string, issue: Issue) => {
    let list = out.get(uri);
    if (!list) out.set(uri, (list = []));
    list.push(issue);
  };
  for (const uri of ctx.index.uris()) out.set(uri, []);

  checkDefinitions(ctx, add);
  for (const file of ctx.index.all()) {
    checkCalls(ctx, file, add);
    checkOptions(file, add);
  }
  checkVariables(ctx, add);
  return out;
}

type Add = (uri: string, issue: Issue) => void;

function issue(
  code: IssueCode,
  category: IssueCategory,
  severity: Severity,
  span: { line: number; start: number; end: number },
  message: string,
  related?: RelatedLocation[],
): Issue {
  return { code, category, severity, line: span.line, start: span.start, end: Math.max(span.end, span.start + 1), message, related };
}

// --- definitions -------------------------------------------------------------

function checkDefinitions(ctx: ProjectContext, add: Add): void {
  const version = ctx.version;
  const groups = new Map<string, FunctionDef[]>();

  for (const file of ctx.index.all()) {
    for (const def of file.functions) {
      if (def.error) {
        add(def.uri, issue('invalid-function', 'functionSignature', 'error', def.name ? def : { line: def.line, start: def.start, end: def.start + def.header.length }, def.error));
        continue;
      }
      if (file.disabled && !def.local) continue; // not loaded by Skript, so it collides with nothing
      const key = def.local ? `${def.uri}\u0000${def.name}` : def.name;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push(def);
    }
  }

  for (const group of groups.values()) {
    for (const def of group) {
      const clashes = group.filter((other) => other !== def && sameRegistryKey(def.signature!, other.signature!, version));
      if (clashes.length === 0) continue;
      const where = clashes.map((c) => `${fileName(c.uri)}:${c.line + 1}`).join(', ');
      const message = atLeast(version, 2, 12)
        ? `Function '${def.name}' with the same argument types is also defined at ${where}. Skript loads only one of them.`
        : `Function '${def.name}' is also defined at ${where}. Skript ${version.text} does not allow two functions with the same name.`;
      add(def.uri, issue('duplicate-function', 'duplicateFunction', 'error', def, message, clashes.map((c) => related(c, 'Also defined here'))));
    }
  }

  // A global script function may not have the same name and argument types as a built-in one.
  for (const def of ctx.index.globalFunctions()) {
    if (!def.signature) continue;
    const builtin = ctx.syntax.functions.get(def.name);
    if (!builtin) continue;
    const clash = atLeast(version, 2, 12) ? builtin.signatures.some((s) => sameRegistryKey(def.signature!, s, version)) : true;
    if (!clash) continue;
    add(def.uri, issue('duplicate-function', 'duplicateFunction', 'error', def,
      atLeast(version, 2, 12)
        ? `Function '${def.name}' with the same argument types already exists: it is built into Skript ${ctx.syntax.version.text}. Rename it or make it local.`
        : `A function named '${def.name}' is built into Skript ${ctx.syntax.version.text}. Rename it or make it local.`));
  }
}

// --- calls -------------------------------------------------------------------

function checkCalls(ctx: ProjectContext, file: FileIndex, add: Add): void {
  const known = new Set(ctx.settings.knownFunctions);
  const version = ctx.version;

  for (const call of file.calls) {
    if (known.has(call.name)) continue;
    const defs = ctx.index.visibleFunctions(call.name, file.uri);
    const local = defs.filter((d) => d.local);
    const resolved = local.length > 0 ? local : defs;
    const builtin = ctx.syntax.functions.get(call.name);

    if (resolved.length === 0 && !builtin) {
      add(file.uri, undefinedFunction(ctx, call));
      continue;
    }
    if (resolved.some((d) => !d.signature)) continue; // an invalid definition is reported where it is

    // Built-in functions are not checked: Skript's docs.json lists one signature per
    // name and drops overloads (2.17.1 documents only vector(n), not vector(x, y, z)).
    if (local.length === 0 && builtin) continue;
    const signatures: Signature[] = resolved.map((d) => d.signature!);
    if (signatures.length === 0 || signatures.some(isListFunction)) continue;
    const count = call.args.length;
    if (signatures.some((s) => count >= minArguments(s) && count <= maxArguments(s))) continue;
    // Before 2.14 Skript read the arguments as one list, so `f(1 and 2)` could fill two parameters.
    if (!atLeast(version, 2, 14) && call.args.some((a) => /\s(?:and|or)\s/i.test(a.value))) continue;

    add(file.uri, issue('argument-count', 'argumentCount', 'error', call, argumentCountMessage(call, signatures),
      resolved.map((d) => related(d, formatSignature(d.signature!)))));
  }
}

function undefinedFunction(ctx: ProjectContext, call: FunctionCall): Issue {
  const added = ctx.catalog.addedIn(call.name);
  const version = ctx.version;
  if (added && compareVersions(added, version) > 0) {
    return issue('undefined-function', 'undefinedFunction', 'error', call,
      `'${call.name}' is a built-in function from Skript ${added.text}, but your target version is ${version.text} (skout.skriptVersion).`);
  }
  return issue('undefined-function', 'undefinedFunction', 'warning', call,
    `Function '${call.name}' is not defined in this workspace and is not built into Skript ${ctx.syntax.version.text}. ` +
      `If an addon provides it, add it to skout.knownFunctions.`);
}

function argumentCountMessage(call: FunctionCall, signatures: Signature[]): string {
  const count = call.args.length;
  const plural = (n: number) => `${n} argument${n === 1 ? '' : 's'}`;
  const takes = signatures.map((s) => {
    const min = minArguments(s);
    const max = maxArguments(s);
    return min === max ? `${max}` : `${min} to ${max}`;
  });
  const unique = [...new Set(takes)];
  const accepted = unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(', ')} or ${unique.at(-1)}`;
  const label = unique.length === 1 && unique[0] === '1' ? 'argument' : 'arguments';
  return `'${call.name}' takes ${accepted} ${label}, but is called with ${plural(count)}.`;
}

// --- options -----------------------------------------------------------------

function checkOptions(file: FileIndex, add: Add): void {
  for (const ref of file.optionRefs) {
    if (file.script.options.has(ref.name)) continue;
    // ScriptLoader's own message.
    add(file.uri, issue('unknown-option', 'unknownOption', 'error', ref, `undefined option {@${ref.name}}`));
  }
}

// --- variables ---------------------------------------------------------------

function checkVariables(ctx: ProjectContext, add: Add): void {
  const globalWrites = new Map<string, VariableOccurrence[]>();
  const dynamicFirst: VariableOccurrence[] = [];
  const localWrites = new Map<string, VariableOccurrence[]>();
  const reads: VariableOccurrence[] = [];

  for (const file of ctx.index.all()) {
    for (const v of file.variables) {
      if (!v.write) {
        reads.push(v);
        continue;
      }
      if (v.local) {
        push(localWrites, `${v.uri}\u0000${v.scope}`, v);
      } else if (v.segments[0].kind === 'literal') {
        push(globalWrites, v.segments[0].norm, v);
      } else {
        dynamicFirst.push(v);
      }
    }
  }

  // One representative write per global name, for typo suggestions.
  const globalPool = [...new Map([...globalWrites.values()].flat().map((w) => [w.key, w])).values()];
  // Coverage depends only on the name (and scope), so each is decided once.
  const verdicts = new Map<string, { covered: boolean; suggestion?: VariableOccurrence }>();

  for (const read of reads) {
    const first = read.segments[0];
    if (first.kind !== 'literal' || read.raw.includes('{@')) continue; // the name is not known until runtime

    const scopeKey = read.local ? `${read.uri}\u0000${read.scope}` : '';
    const verdictKey = `${scopeKey}\u0000${read.key}`;
    let verdict = verdicts.get(verdictKey);
    if (!verdict) {
      const candidates = read.local ? localWrites.get(scopeKey) ?? [] : [...(globalWrites.get(first.norm) ?? []), ...dynamicFirst];
      const covered = candidates.some((w) => writeCovers(w.segments, read.segments));
      verdict = { covered, suggestion: covered ? undefined : closest(read, read.local ? candidates : globalPool) };
      verdicts.set(verdictKey, verdict);
    }
    if (verdict.covered) continue;

    const suggestion = verdict.suggestion;
    const hint = suggestion ? ` Did you mean {${suggestion.raw}}?` : '';
    const message = read.local
      ? `{${read.raw}} is read here but never set in this ${scopeName(ctx, read)}.${hint}`
      : `{${read.raw}} is read here but never set anywhere in the workspace.${hint}`;
    add(read.uri, issue('unset-variable', 'unsetVariable', 'warning', read, message,
      suggestion ? [related(suggestion, `{${suggestion.raw}} is set here`)] : undefined));
  }
}

function scopeName(ctx: ProjectContext, v: VariableOccurrence): string {
  const structure = ctx.index.get(v.uri)?.script.structures.find((s) => s.line === v.scope)?.structure;
  return structure === 'function' ? 'function' : structure === 'command' ? 'command' : 'trigger';
}

/** The written variable whose name is closest to the read one, if it is a plausible typo. */
function closest(read: VariableOccurrence, writes: VariableOccurrence[]): VariableOccurrence | undefined {
  let best: VariableOccurrence | undefined;
  let bestDistance = Infinity;
  const seen = new Set<string>();
  for (const w of writes) {
    if (seen.has(w.key) || w.key === read.key) continue;
    seen.add(w.key);
    const d = levenshtein(read.key, w.key);
    if (d < bestDistance) {
      bestDistance = d;
      best = w;
    }
  }
  return best && bestDistance <= Math.max(1, Math.floor(read.key.length / 4)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return Infinity;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function related(span: { uri: string; line: number; start: number; end: number }, message: string): RelatedLocation {
  return { uri: span.uri, line: span.line, start: span.start, end: span.end, message };
}

export function fileName(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
}

export type { Version };
