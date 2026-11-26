/**
 * Runs the engine over a script: every event header, statement, condition and
 * section header that matches known syntax is parsed down to its
 * sub-expressions, and the problems Skout is sure of become diagnostics.
 */
import { classify, type LineSyntax } from '../features/syntax';
import type { FileIndex } from '../index/types';
import type { WorkspaceIndex } from '../index/workspace';
import type { Issue, SkNode } from '../parser/types';
import type { SyntaxRegistry } from '../syntax/registry';
import type { Engine, FunctionLookup, StatementResult } from './engine';

/** The functions a file can call: its own and global ones, then Skript's built-ins. */
export function functionLookup(index: WorkspaceIndex, uri: string, registry: SyntaxRegistry): FunctionLookup {
  return (name) => {
    const own = index.visibleFunctions(name, uri).flatMap((f) => (f.signature ? [f.signature] : []));
    if (own.length > 0) return { signatures: own, checkArguments: true };
    const builtin = registry.functions.get(name);
    if (builtin && builtin.signatures.length > 0) return { signatures: builtin.signatures, checkArguments: false };
    return undefined;
  };
}

/** The engine's verdict on one line, or undefined for lines it does not check. */
export function analyzeLine(syntax: LineSyntax, engine: Engine, functions: FunctionLookup): StatementResult | undefined {
  if (syntax.role === 'keyword') return undefined;
  if (syntax.role === 'call') return engine.expression(syntax.text, { functions });
  if (syntax.kinds.length === 0 || !syntax.hit) return undefined; // unrecognized: reported elsewhere
  return engine.statement(syntax.text, syntax.kinds, { exclude: syntax.exclude, functions });
}

export function semanticIssues(file: FileIndex, registry: SyntaxRegistry, engine: Engine, functions: FunctionLookup): Issue[] {
  const issues: Issue[] = [];
  const visit = (node: SkNode) => {
    if (!node.invalid) {
      const syntax = classify(file, node, registry);
      const result = syntax && analyzeLine(syntax, engine, functions);
      if (syntax && result?.status === 'error' && result.problem) {
        const line = file.script.lines[node.line];
        const p = result.problem;
        const mapped = syntax.column !== -1;
        issues.push({
          code: p.code,
          category: 'types',
          severity: 'error',
          message: mapped ? p.message : `${p.message} (in '${syntax.text}')`,
          line: node.line,
          start: mapped ? syntax.column + p.start : line.start,
          end: mapped ? syntax.column + p.end : line.end,
        });
      }
    }
    node.children.forEach(visit);
  };
  file.script.structures.forEach(visit);
  return issues;
}
