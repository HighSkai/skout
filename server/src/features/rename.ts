/**
 * Rename for functions (definition and every call that resolves to it) and for
 * variable namespaces: renaming `objective` in `{objective::%player%::done}`
 * changes every variable under `{objective::…}` in scope. Edits are marked as
 * needing confirmation, so VS Code shows them in the Refactor Preview first.
 */
import {
  ResponseError,
  type AnnotatedTextEdit,
  type ChangeAnnotation,
  type Range,
  type TextDocumentEdit,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver';
import type { FileIndex, FunctionDef, Span } from '../index/types';
import type { WorkspaceIndex } from '../index/workspace';
import { FUNCTION_NAME } from '../skript/functions';
import type { SkriptSyntax } from '../syntax/catalog';
import { resolveCall, targetAt, type Target } from './navigation';
import { fileName } from './project';

export interface RenameOptions {
  /** Client supports `documentChanges` with change annotations (VS Code does). */
  readonly annotations: boolean;
  /** Version of each open document, for versioned edits. */
  readonly versionOf: (uri: string) => number | null;
}

const INVALID = 1; // a request error, shown to the user by the client

export function prepareRename(index: WorkspaceIndex, file: FileIndex, line: number, character: number, syntax: SkriptSyntax): { range: Range; placeholder: string } {
  const target = targetAt(file, line, character);
  const plan = planFor(index, target, syntax);
  return { range: range(plan.span), placeholder: plan.placeholder };
}

export function rename(
  index: WorkspaceIndex,
  file: FileIndex,
  line: number,
  character: number,
  newName: string,
  syntax: SkriptSyntax,
  options: RenameOptions,
): WorkspaceEdit {
  const plan = planFor(index, targetAt(file, line, character), syntax);
  const error = plan.validate(newName.trim());
  if (error) throw new ResponseError(INVALID, error);
  const edits = plan.edits(newName.trim());

  const byUri = new Map<string, TextEdit[]>();
  for (const edit of edits) {
    const list = byUri.get(edit.uri) ?? [];
    list.push({ range: range(edit), newText: edit.text });
    byUri.set(edit.uri, list);
  }
  const label = `${plan.label} → ${newName.trim()} (${edits.length} change${edits.length === 1 ? '' : 's'} in ${byUri.size} file${byUri.size === 1 ? '' : 's'})`;

  if (!options.annotations) {
    return { changes: Object.fromEntries(byUri) };
  }
  const annotation: ChangeAnnotation = { label, needsConfirmation: true, description: plan.label };
  const documentChanges: TextDocumentEdit[] = [...byUri].map(([uri, list]) => ({
    textDocument: { uri, version: options.versionOf(uri) },
    edits: list.map((e): AnnotatedTextEdit => ({ ...e, annotationId: 'skout.rename' })),
  }));
  return { documentChanges, changeAnnotations: { 'skout.rename': annotation } };
}

interface Edit extends Span {
  readonly uri: string;
  readonly text: string;
}

interface Plan {
  readonly span: Span;
  readonly placeholder: string;
  readonly label: string;
  validate(name: string): string | undefined;
  edits(name: string): Edit[];
}

function planFor(index: WorkspaceIndex, target: Target | undefined, syntax: SkriptSyntax): Plan {
  if (target?.kind === 'definition' || target?.kind === 'call') return functionPlan(index, target, syntax);
  if (target?.kind === 'variable') return variablePlan(index, target);
  throw new ResponseError(INVALID, 'Skout can rename functions and variable names. Put the cursor on a function name or on part of a variable name.');
}

function functionPlan(index: WorkspaceIndex, target: Extract<Target, { kind: 'definition' | 'call' }>, syntax: SkriptSyntax): Plan {
  const defs: FunctionDef[] = target.kind === 'definition' ? sameNameScope(index, target.def) : resolveCall(index, target.call).flatMap((d) => sameNameScope(index, d));
  const unique = [...new Map(defs.map((d) => [`${d.uri}:${d.line}`, d])).values()];
  const span = target.kind === 'definition' ? target.def : target.call;
  const name = target.kind === 'definition' ? target.def.name : target.call.name;
  if (unique.length === 0) {
    throw new ResponseError(INVALID, syntax.functions.has(name) ? `'${name}' is built into Skript and cannot be renamed.` : `'${name}' is not defined in this workspace.`);
  }
  const local = unique[0].local;
  return {
    span,
    placeholder: name,
    label: `Rename ${local ? 'local ' : ''}function ${name}${unique.length > 1 ? ` (all ${unique.length} overloads)` : ''}`,
    validate(newName) {
      if (newName === name) return 'That is already its name.';
      if (!FUNCTION_NAME.test(newName)) return `'${newName}' is not a valid function name: start with a letter or _, then use letters, digits and _.`;
      const scopeUri = local ? unique[0].uri : undefined;
      const clash = scopeUri
        ? index.get(scopeUri)?.functions.some((f) => f.name === newName)
        : index.globalFunctions().some((f) => f.name === newName);
      if (clash) return `A function named '${newName}' already exists${local ? ' in this script' : ''}.`;
      if (!local && syntax.functions.has(newName)) return `'${newName}' is a built-in Skript function.`;
      return undefined;
    },
    edits(newName) {
      const edits: Edit[] = [];
      const seen = new Set<string>();
      const add = (s: Span & { uri: string }) => {
        const id = `${s.uri}:${s.line}:${s.start}`;
        if (seen.has(id)) return;
        seen.add(id);
        edits.push({ uri: s.uri, line: s.line, start: s.start, end: s.end, text: newName });
      };
      for (const def of unique) {
        add(def);
        index.callsTo(def).forEach(add);
      }
      return edits;
    },
  };
}

/** All overloads that share the definition's name and scope: they are renamed together. */
function sameNameScope(index: WorkspaceIndex, def: FunctionDef): FunctionDef[] {
  if (def.local) return (index.get(def.uri)?.functions ?? []).filter((f) => f.local && f.name === def.name);
  return index.globalFunctions().filter((f) => f.name === def.name);
}

function variablePlan(index: WorkspaceIndex, target: Extract<Target, { kind: 'variable' }>): Plan {
  const { occurrence } = target;
  const segment = occurrence.segments[target.segment];
  if (!segment || segment.kind !== 'literal') {
    throw new ResponseError(INVALID, 'Only a fixed part of a variable name can be renamed, not a %expression% or *.');
  }
  const prefix = occurrence.segments.slice(0, target.segment + 1);
  const members = index.inNamespace(prefix, occurrence);
  if (members.some((m) => m.parameter)) {
    throw new ResponseError(INVALID, 'This variable is a function parameter; rename the parameter in the function signature instead.');
  }
  const shown = prefix.map((s) => s.text).join('::');
  const isPrefix = members.some((m) => m.segments.length > prefix.length);
  return {
    span: { line: occurrence.line, start: segment.start, end: segment.end },
    placeholder: segment.text,
    label: `Rename ${occurrence.local ? 'local ' : ''}variable ${isPrefix ? `namespace {${shown}::…}` : `{${shown}}`}`,
    validate(newName) {
      if (newName === segment.text) return 'That is already its name.';
      if (newName === '' || /[{}%"]/.test(newName) || newName.startsWith('::') || newName.endsWith('::')) {
        return `'${newName}' cannot be part of a variable name (no braces, quotes or %, and no leading or trailing ::).`;
      }
      if (target.segment === 0 && occurrence.local !== newName.startsWith('_')) {
        return occurrence.local ? 'A local variable name must keep its leading _.' : 'A global variable name cannot start with _ (that makes it local).';
      }
      return undefined;
    },
    edits(newName) {
      return members.map((m) => {
        const s = m.segments[target.segment];
        return { uri: m.uri, line: m.line, start: s.start, end: s.end, text: newName };
      });
    },
  };
}

function range(span: Span): Range {
  return { start: { line: span.line, character: span.start }, end: { line: span.line, character: span.end } };
}

export { fileName };
