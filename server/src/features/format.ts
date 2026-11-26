/**
 * Formatting and signature help.
 *
 * The formatter only touches whitespace that Skript does not read: it
 * re-indents every line from its depth in the tree with one indent unit (the
 * editor's), indents comment lines like the code below them, and removes
 * trailing whitespace. Skript's structure depends only on indentation being
 * consistent per section (SectionNode#load_i), so re-indenting by depth keeps
 * the meaning. A file with indentation errors is left alone: its intended
 * structure is not known. Block comments are never changed.
 */
import { ParameterInformation, SignatureInformation, type FormattingOptions, type SignatureHelp, type TextEdit } from 'vscode-languageserver';
import type { FileIndex } from '../index/types';
import type { WorkspaceIndex } from '../index/workspace';
import { LineKind } from '../parser/lines';
import type { SkNode } from '../parser/types';
import { formatSignature, nextToken, type Signature } from '../skript/functions';
import type { BuiltinSyntax } from '../syntax/registry';

const STRUCTURAL = new Set(['indent-mixed', 'indent-unexpected', 'missing-colon', 'unclosed-block-comment']);

export function formatDocument(file: FileIndex, options: FormattingOptions): TextEdit[] {
  const script = file.script;
  if (script.issues.some((i) => STRUCTURAL.has(i.code))) return [];
  const unit = options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';

  const depth = new Map<number, number>();
  const visit = (node: SkNode) => {
    depth.set(node.line, node.depth);
    node.children.forEach(visit);
  };
  script.structures.forEach(visit);

  const edits: TextEdit[] = [];
  const lines = script.lines;
  let nextDepth = 0;
  // Walk backwards so a comment can take the depth of the code below it.
  const wanted: (number | undefined)[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind === LineKind.Code) {
      const d = depth.get(i);
      wanted[i] = d;
      if (d !== undefined) nextDepth = d;
    } else if (line.kind === LineKind.Comment) {
      wanted[i] = nextDepth;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === LineKind.BlockComment || line.kind === LineKind.BlockCommentDelimiter) continue;
    const text = line.text;
    const indentEnd = text.length - text.trimStart().length;
    if (line.kind === LineKind.Blank) {
      if (text.length > 0) edits.push({ range: range(i, 0, text.length), newText: '' });
      continue;
    }
    const target = wanted[i];
    if (target !== undefined) {
      const indent = unit.repeat(target);
      if (text.slice(0, indentEnd) !== indent) edits.push({ range: range(i, 0, indentEnd), newText: indent });
    }
    const contentEnd = text.trimEnd().length;
    if (contentEnd < text.length) edits.push({ range: range(i, contentEnd, text.length), newText: '' });
  }
  return edits;
}

function range(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

// --- signature help --------------------------------------------------------------------

/** The function call around `character`, and which argument the cursor is in. */
export function callAt(text: string, character: number): { name: string; argument: number; named?: string } | undefined {
  // Walk back to the innermost unclosed `(` before the cursor that follows a function name.
  let depth = 0;
  for (let i = Math.min(character, text.length) - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = /([\p{Alphabetic}_][\p{Alphabetic}\d_]*)\s*$/u.exec(text.slice(0, i))?.[1];
      if (!name) continue;
      const args = text.slice(i + 1, character);
      let argument = 0;
      let start = 0;
      for (let j = 0; j < args.length; ) {
        if (args[j] === ',') {
          argument++;
          start = j + 1;
          j++;
          continue;
        }
        const next = nextToken(args, j);
        if (next === -1) break;
        j = next;
      }
      const named = /^\s*([^:(){}",]+?)\s*:/.exec(args.slice(start))?.[1];
      return { name, argument, named };
    }
  }
  return undefined;
}

export function signatureHelp(index: WorkspaceIndex, file: FileIndex, syntax: BuiltinSyntax, line: number, character: number): SignatureHelp | undefined {
  const text = file.script.lines[line]?.text;
  if (text === undefined) return undefined;
  const call = callAt(text, character);
  if (!call) return undefined;
  const own = index.visibleFunctions(call.name, file.uri).flatMap((f) => (f.signature ? [{ signature: f.signature, doc: f.doc }] : []));
  const builtin = syntax.functions.get(call.name);
  const found = own.length > 0 ? own : (builtin?.signatures ?? []).map((signature) => ({ signature, doc: builtin?.entry.description }));
  if (found.length === 0) return undefined;
  const signatures = found.map(({ signature, doc }) => info(signature, doc));
  const pick = found.findIndex(({ signature }) => signature.parameters.length > call.argument);
  const active = Math.max(0, pick);
  const parameters = found[active].signature.parameters;
  const named = call.named ? parameters.findIndex((p) => p.name === call.named) : -1;
  return { signatures, activeSignature: active, activeParameter: named !== -1 ? named : Math.min(call.argument, Math.max(0, parameters.length - 1)) };
}

function info(signature: Signature, doc: string | undefined): SignatureInformation {
  const label = formatSignature(signature);
  const parameters = signature.parameters.map((p) => {
    const text = `${p.name}: ${p.type}`;
    const start = label.indexOf(text);
    return ParameterInformation.create(start === -1 ? text : [start, start + text.length], p.defaultValue ? `default: ${p.defaultValue}` : undefined);
  });
  return SignatureInformation.create(label, doc?.replace(/<[^>]+>/g, ''), ...parameters);
}
