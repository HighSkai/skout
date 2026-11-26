import { FoldingRangeKind, SymbolKind, type DocumentSymbol, type FoldingRange } from 'vscode-languageserver';
import { LineKind } from '../parser/lines';
import { walk } from '../parser/parser';
import type { ParsedScript, SkNode, StructureKind } from '../parser/types';

const KIND: Record<StructureKind, SymbolKind> = {
  event: SymbolKind.Event,
  command: SymbolKind.Method,
  function: SymbolKind.Function,
  options: SymbolKind.Namespace,
  variables: SymbolKind.Namespace,
  aliases: SymbolKind.Namespace,
  using: SymbolKind.Module,
  other: SymbolKind.Object,
};

/** Top-level structures, with `options:` entries nested as constants. */
export function documentSymbols(script: ParsedScript): DocumentSymbol[] {
  return script.structures.map((node) => {
    const symbol = symbolFor(script, node, KIND[node.structure ?? 'other'], node.key);
    if (node.structure === 'options') {
      symbol.children = node.children
        .filter((child) => child.kind === 'simple' && child.key.includes(':'))
        .map((child) => {
          const name = child.key.slice(0, child.key.indexOf(':')).trim();
          const value = child.key.slice(child.key.indexOf(':') + 1).trim();
          const entry = symbolFor(script, child, SymbolKind.Constant, name);
          entry.detail = value;
          return entry;
        });
    }
    return symbol;
  });
}

function symbolFor(script: ParsedScript, node: SkNode, kind: SymbolKind, name: string): DocumentSymbol {
  const first = script.lines[node.line];
  const last = script.lines[node.lastLine];
  return {
    name: name || '(empty)',
    kind,
    range: {
      start: { line: node.line, character: 0 },
      end: { line: node.lastLine, character: last.text.length },
    },
    selectionRange: {
      start: { line: node.line, character: first.start },
      end: { line: node.line, character: first.end },
    },
  };
}

/** One folding range per section, plus `###` block comments. */
export function foldingRanges(script: ParsedScript): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  walk(script.structures, (node) => {
    if (node.kind === 'section' && node.lastLine > node.line) {
      ranges.push({ startLine: node.line, endLine: node.lastLine });
    }
  });

  let open = -1;
  for (const line of script.lines) {
    if (line.kind !== LineKind.BlockCommentDelimiter) continue;
    if (open === -1) {
      open = line.index;
    } else {
      ranges.push({ startLine: open, endLine: line.index, kind: FoldingRangeKind.Comment });
      open = -1;
    }
  }
  return ranges;
}
