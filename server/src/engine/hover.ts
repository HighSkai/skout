/**
 * Hover for the sub-expression under the cursor: what Skout parsed it as, its
 * type, and the docs of the syntax it matched.
 */
import { MarkupKind, type Hover } from 'vscode-languageserver';
import { describeEntry, classify } from '../features/syntax';
import type { FileIndex } from '../index/types';
import type { SkNode } from '../parser/types';
import { formatSignature } from '../skript/functions';
import type { SyntaxRegistry } from '../syntax/registry';
import { analyzeLine } from './analyze';
import type { Engine, ExprNode, FunctionLookup } from './engine';

/** The innermost node at `offset` (in the analysed text), skipping the statement itself. */
export function nodeAtOffset(root: ExprNode, offset: number): ExprNode | undefined {
  let found: ExprNode | undefined;
  const visit = (node: ExprNode, depth: number) => {
    if (offset < node.start || offset >= node.end) return;
    if (depth > 0) found = node;
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return found;
}

const KIND_LABEL: Partial<Record<ExprNode['kind'], string>> = {
  arithmetic: 'Arithmetic',
  string: 'Text',
  number: 'Number literal',
  boolean: 'Boolean literal',
  timespan: 'Time span literal',
  variable: 'Variable',
  call: 'Function call',
  list: 'List',
  typeLiteral: 'Type',
  literal: 'Literal',
  unknown: 'Not recognised',
};

export function expressionHover(
  file: FileIndex,
  node: SkNode,
  character: number,
  registry: SyntaxRegistry,
  engine: Engine,
  functions: FunctionLookup,
): Hover | undefined {
  const syntax = classify(file, node, registry);
  if (!syntax || syntax.column === -1) return undefined;
  const result = analyzeLine(syntax, engine, functions);
  if (!result?.root) return undefined;
  const target = nodeAtOffset(result.root, character - syntax.column);
  // Plain values say little on their own; the line's own docs are more useful there.
  if (!target || target.kind === 'unknown' || target.kind === 'literal') return undefined;
  const text = syntax.text.slice(target.start, target.end);
  const parts: string[] = [];
  const type = target.type ? engine.types.withArticle(target.type, target.plural) : target.plural ? 'several values' : 'unknown until the script runs';
  if (target.kind === 'syntax' && target.ref) {
    parts.push(`\`${text}\` · ${type}`);
    parts.push(describeEntry(target.ref));
  } else {
    let head = `**${KIND_LABEL[target.kind] ?? target.kind}** \`${text}\` · ${type}`;
    if (target.kind === 'arithmetic') head = `**${KIND_LABEL.arithmetic}** (\`${target.name}\`) · ${type}`;
    parts.push(head);
    if (target.kind === 'call' && target.signature) parts.push('```skript\n' + formatSignature(target.signature) + '\n```');
    if (target.kind === 'variable') parts.push(target.plural ? 'A list variable: several values.' : 'Its type is only known when the script runs.');
  }
  const line = node.line;
  return {
    contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') },
    range: { start: { line, character: syntax.column + target.start }, end: { line, character: syntax.column + target.end } },
  };
}
