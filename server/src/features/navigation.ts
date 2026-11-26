/**
 * Go to definition, find references, hover and workspace symbols for
 * functions, variables and `{@options}`.
 */
import { MarkupKind, SymbolKind, type Hover, type Location, type SymbolInformation } from 'vscode-languageserver';
import type { FileIndex, FunctionCall, FunctionDef, OptionRef, Span, VariableOccurrence } from '../index/types';
import { segmentEquals, writeCovers, type WorkspaceIndex } from '../index/workspace';
import type { OptionEntry } from '../parser/types';
import { formatSignature } from '../skript/functions';
import type { BuiltinFunction } from '../syntax/catalog';
import type { BuiltinSyntax } from '../syntax/registry';
import { fileName } from './project';

export type Target =
  | { readonly kind: 'definition'; readonly def: FunctionDef }
  | { readonly kind: 'call'; readonly call: FunctionCall }
  | { readonly kind: 'variable'; readonly occurrence: VariableOccurrence; readonly segment: number }
  | { readonly kind: 'option'; readonly ref: OptionRef }
  | { readonly kind: 'optionEntry'; readonly entry: OptionEntry; readonly span: Span };

const within = (s: Span, line: number, character: number) => s.line === line && character >= s.start && character <= s.end;

/** What is under the cursor. Nested variables win over the variable whose name contains them. */
export function targetAt(file: FileIndex, line: number, character: number): Target | undefined {
  const def = file.functions.find((d) => d.name && within(d, line, character));
  if (def) return { kind: 'definition', def };
  const call = file.calls.find((c) => within(c, line, character));
  if (call) return { kind: 'call', call };
  const ref = file.optionRefs.find((r) => within(r, line, character));

  let best: VariableOccurrence | undefined;
  for (const v of file.variables) {
    if (!within(v, line, character)) continue;
    if (!best || v.end - v.start < best.end - best.start) best = v;
  }
  if (best && !(ref && ref.start > best.start)) {
    const segment = best.segments.findIndex((s) => character >= s.start && character <= s.end);
    return { kind: 'variable', occurrence: best, segment: segment === -1 ? best.segments.length - 1 : segment };
  }
  if (ref) return { kind: 'option', ref };

  for (const entry of file.script.options.values()) {
    if (entry.line !== line) continue;
    const text = file.script.lines[line].text;
    const name = entry.key.slice(entry.key.lastIndexOf('.') + 1);
    const start = text.indexOf(name);
    if (start !== -1 && character >= start && character <= start + name.length) {
      return { kind: 'optionEntry', entry, span: { line, start, end: start + name.length } };
    }
  }
  return undefined;
}

/** The definitions a call resolves to: local functions of its script first, then global ones. */
export function resolveCall(index: WorkspaceIndex, call: FunctionCall): FunctionDef[] {
  const defs = index.visibleFunctions(call.name, call.uri);
  const local = defs.filter((d) => d.local);
  return local.length > 0 ? local : defs;
}

export function definition(index: WorkspaceIndex, file: FileIndex, target: Target): Location[] {
  switch (target.kind) {
    case 'definition':
      return [location(target.def)];
    case 'call':
      return resolveCall(index, target.call).map(location);
    case 'variable':
      return writesOf(index, target.occurrence).map(location);
    case 'option': {
      const entry = file.script.options.get(target.ref.name);
      return entry ? [optionLocation(file, entry)] : [];
    }
    case 'optionEntry':
      return [location({ uri: file.uri, ...target.span })];
  }
}

export function references(index: WorkspaceIndex, file: FileIndex, target: Target, includeDeclaration: boolean): Location[] {
  switch (target.kind) {
    case 'definition':
    case 'call': {
      const defs = target.kind === 'definition' ? [target.def] : resolveCall(index, target.call);
      const result: (Span & { uri: string })[] = [];
      if (includeDeclaration) result.push(...defs);
      const seen = new Set<string>();
      for (const def of defs) {
        for (const call of index.callsTo(def)) {
          const id = `${call.uri}:${call.line}:${call.start}`;
          if (!seen.has(id)) {
            seen.add(id);
            result.push(call);
          }
        }
      }
      if (target.kind === 'call' && defs.length === 0) result.push(...file.calls.filter((c) => c.name === target.call.name));
      return result.map(location);
    }
    case 'variable':
      return index.sameVariable(target.occurrence).map(location);
    case 'option':
    case 'optionEntry': {
      const name = target.kind === 'option' ? target.ref.name : target.entry.key;
      const refs = file.optionRefs.filter((r) => r.name === name).map(location);
      const entry = file.script.options.get(name);
      return includeDeclaration && entry ? [optionLocation(file, entry), ...refs] : refs;
    }
  }
}

export function hover(index: WorkspaceIndex, file: FileIndex, target: Target, syntax: BuiltinSyntax): Hover | undefined {
  const value = hoverText(index, file, target, syntax);
  if (!value) return undefined;
  const span = target.kind === 'variable' ? target.occurrence : target.kind === 'definition' ? target.def : target.kind === 'call' ? target.call : target.kind === 'option' ? target.ref : target.span;
  return {
    contents: { kind: MarkupKind.Markdown, value },
    range: { start: { line: span.line, character: span.start }, end: { line: span.line, character: span.end } },
  };
}

function hoverText(index: WorkspaceIndex, file: FileIndex, target: Target, syntax: BuiltinSyntax): string | undefined {
  switch (target.kind) {
    case 'definition':
      return functionHover([target.def], index, undefined, syntax);
    case 'call': {
      const defs = resolveCall(index, target.call);
      const builtin = defs.some((d) => d.local) ? undefined : syntax.functions.get(target.call.name);
      if (defs.length === 0 && !builtin) return `\`${target.call.name}()\` is not defined in this workspace or built into Skript ${syntax.version.text}.`;
      return functionHover(defs, index, builtin, syntax);
    }
    case 'variable':
      return variableHover(index, target.occurrence, target.segment);
    case 'option': {
      const entry = file.script.options.get(target.ref.name);
      return entry
        ? `\`{@${entry.key}}\` = \`${entry.value}\`\n\nOption defined on line ${entry.line + 1}.`
        : `\`{@${target.ref.name}}\` is not defined in this script's \`options:\`.`;
    }
    case 'optionEntry': {
      const uses = file.optionRefs.filter((r) => r.name === target.entry.key).length;
      return `\`{@${target.entry.key}}\` = \`${target.entry.value}\`\n\nUsed ${uses} time${uses === 1 ? '' : 's'} in this script.`;
    }
  }
}

function functionHover(defs: FunctionDef[], index: WorkspaceIndex, builtin: BuiltinFunction | undefined, syntax: BuiltinSyntax): string {
  const parts: string[] = [];
  for (const def of defs) {
    const signature = def.signature ? formatSignature(def.signature) : def.header;
    let block = '```skript\n' + signature + '\n```';
    if (def.doc) block += `\n\n${def.doc}`;
    const calls = index.callsTo(def).length;
    block += `\n\n${def.local ? 'Local function' : 'Function'} in [${fileName(def.uri)}:${def.line + 1}](${def.uri}#L${def.line + 1}) · called ${calls} time${calls === 1 ? '' : 's'}`;
    parts.push(block);
  }
  if (builtin) {
    let block = '```skript\n' + builtin.entry.patterns.join('\n') + '\n```';
    const description = cleanDescription(builtin.entry.description);
    if (description) block += `\n\n${description}`;
    block += `\n\nBuilt into Skript ${syntax.version.text}${builtin.entry.since ? ` · since ${builtin.entry.since}` : ''}`;
    parts.push(block);
  }
  return parts.join('\n\n---\n\n');
}

function variableHover(index: WorkspaceIndex, occurrence: VariableOccurrence, segment: number): string {
  const all = index.sameVariable(occurrence);
  const writes = all.filter((v) => v.write);
  const reads = all.filter((v) => !v.write);
  const covering = writesOf(index, occurrence);
  const scope = occurrence.local ? 'Local variable' : 'Global variable';
  const lines = [`\`{${occurrence.raw}}\` · ${scope}`];
  lines.push('');
  lines.push(`**Set** in ${count(writes.length)}${covering.length > writes.length ? ` (and possibly by ${count(covering.length - writes.length)} through a list or dynamic name)` : ''}${listLocations(writes)}`);
  lines.push('');
  lines.push(`**Read** in ${count(reads.length)}${listLocations(reads)}`);

  // Hovering an inner part of the name describes that namespace too.
  if (segment < occurrence.segments.length - 1 && occurrence.segments[segment].kind === 'literal') {
    const prefix = occurrence.segments.slice(0, segment + 1);
    const members = index.inNamespace(prefix, occurrence);
    const names = new Set(members.map((m) => m.key));
    const namespace = prefix.map((s) => s.text).join('::');
    lines.push('');
    lines.push(`Namespace \`{${namespace}::…}\`: ${names.size} variable${names.size === 1 ? '' : 's'}, set in ${count(members.filter((m) => m.write).length)}, read in ${count(members.filter((m) => !m.write).length)}.`);
  }
  return lines.join('\n');
}

/** Writes that may set `occurrence`, including writes through a list or a dynamic name. */
export function writesOf(index: WorkspaceIndex, occurrence: VariableOccurrence): VariableOccurrence[] {
  return index.variablesWhere(
    (v) =>
      v.write &&
      v.local === occurrence.local &&
      (!v.local || (v.uri === occurrence.uri && v.scope === occurrence.scope)) &&
      (v.key === occurrence.key || (segmentEquals(v.segments[0], occurrence.segments[0]) && writeCovers(v.segments, occurrence.segments))),
  );
}

export function workspaceSymbols(index: WorkspaceIndex, query: string): SymbolInformation[] {
  const q = query.toLowerCase();
  const matches = (name: string) => q === '' || fuzzy(name.toLowerCase(), q);
  const result: SymbolInformation[] = [];
  for (const file of index.all()) {
    for (const def of file.functions) {
      if (def.name && matches(def.name)) {
        result.push({ name: def.name, kind: SymbolKind.Function, location: location(def), containerName: fileName(file.uri) });
      }
    }
    for (const command of file.commands) {
      if (matches(command.name)) {
        result.push({ name: `/${command.name}`, kind: SymbolKind.Method, location: location(command), containerName: fileName(file.uri) });
      }
    }
    for (const entry of file.script.options.values()) {
      if (matches(entry.key)) {
        result.push({ name: `{@${entry.key}}`, kind: SymbolKind.Constant, location: optionLocation(file, entry), containerName: fileName(file.uri) });
      }
    }
  }
  return result.slice(0, 500);
}

function fuzzy(text: string, query: string): boolean {
  let i = 0;
  for (const c of text) if (c === query[i]) i++;
  return i === query.length;
}

function count(n: number): string {
  return `${n} place${n === 1 ? '' : 's'}`;
}

function listLocations(occurrences: VariableOccurrence[]): string {
  if (occurrences.length === 0) return '';
  const shown = occurrences.slice(0, 5).map((v) => `[${fileName(v.uri)}:${v.line + 1}](${v.uri}#L${v.line + 1})`);
  return `: ${shown.join(', ')}${occurrences.length > 5 ? `, and ${occurrences.length - 5} more` : ''}`;
}

/** Skript's docs descriptions contain HTML links and line breaks. */
export function cleanDescription(text: string): string {
  return text
    .replace(/<a\s+href=['"]([^'"]+)['"][^>]*>(.*?)<\/a>/gi, '$2')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(code|b|i|strong|em)>/gi, (tag) => (/code/i.test(tag) ? '`' : /b|strong/i.test(tag) ? '**' : '_'))
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function location(span: Span & { uri: string }): Location {
  return { uri: span.uri, range: { start: { line: span.line, character: span.start }, end: { line: span.line, character: span.end } } };
}

function optionLocation(file: FileIndex, entry: OptionEntry): Location {
  const text = file.script.lines[entry.line].text;
  const name = entry.key.slice(entry.key.lastIndexOf('.') + 1);
  const start = Math.max(0, text.indexOf(name));
  return location({ uri: file.uri, line: entry.line, start, end: start + name.length });
}
