/**
 * Data for the "Skout: Variables" view: global variables grouped by namespace
 * (`{quest::%uuid%::active::*}` sits under quest › %…% › active › *), and
 * local variables grouped by file and structure. Sent to the client through
 * the custom `skout/variables` request.
 */
import type { VariableOccurrence } from '../index/types';
import { writeCovers, type WorkspaceIndex } from '../index/workspace';
import { fileName } from './project';

export interface VariableLocation {
  readonly uri: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly write: boolean;
  /** The line's code, trimmed, for the tooltip. */
  readonly preview: string;
}

export interface VariableTreeNode {
  readonly label: string;
  readonly kind: 'namespace' | 'variable' | 'group' | 'file' | 'structure';
  /** The full name for variables, e.g. `quest::%…%::active::*`. */
  readonly name?: string;
  readonly sets: number;
  readonly reads: number;
  /** Read somewhere but never set in its scope. */
  readonly unset?: boolean;
  readonly locations?: readonly VariableLocation[];
  readonly children?: readonly VariableTreeNode[];
}

interface Builder {
  label: string;
  kind: VariableTreeNode['kind'];
  name?: string;
  occurrences: VariableOccurrence[];
  children: Map<string, Builder>;
}

export function variablesTree(index: WorkspaceIndex): VariableTreeNode[] {
  const globals: Builder = { label: '', kind: 'group', occurrences: [], children: new Map() };
  const locals = new Map<string, Map<number, VariableOccurrence[]>>();

  for (const file of index.all()) {
    for (const v of file.variables) {
      if (v.local) {
        const byScope = locals.get(v.uri) ?? new Map<number, VariableOccurrence[]>();
        locals.set(v.uri, byScope);
        byScope.set(v.scope, [...(byScope.get(v.scope) ?? []), v]);
        continue;
      }
      // `{list::*}` is shown as the node `list`: a trailing * names the list, not a child.
      const segments = v.segments.length > 1 && v.segments.at(-1)!.kind === 'wildcard' ? v.segments.slice(0, -1) : v.segments;
      let node = globals;
      segments.forEach((segment, i) => {
        const key = segment.kind === 'literal' ? segment.norm : segment.kind === 'wildcard' ? '*' : '%';
        let child = node.children.get(key);
        if (!child) {
          child = { label: label(segment.text, segment.kind), kind: 'namespace', occurrences: [], children: new Map() };
          node.children.set(key, child);
        }
        if (i === segments.length - 1) {
          child.occurrences.push(v);
          child.name = v.segments.map((s) => label(s.text, s.kind)).join('::');
        }
        node = child;
      });
    }
  }

  const allGlobalWrites = index.variablesWhere((v) => v.write && !v.local);
  const preview = (v: VariableOccurrence) => index.get(v.uri)?.script.lines[v.line]?.text.trim().slice(0, 160) ?? '';
  const finish = (b: Builder, writes: VariableOccurrence[]): VariableTreeNode => {
    const children = [...b.children.values()].sort(byLabel).map((c) => finish(c, writes));
    const own = b.occurrences;
    const isVariable = own.length > 0;
    const unset = own.some((r) => !r.write && r.segments[0].kind === 'literal' && !writes.some((w) => writeCovers(w.segments, r.segments)));
    return {
      label: b.label,
      kind: isVariable ? (children.length > 0 ? 'namespace' : 'variable') : b.kind,
      name: isVariable ? b.name : undefined,
      sets: own.filter((v) => v.write).length + children.reduce((n, c) => n + c.sets, 0),
      reads: own.filter((v) => !v.write).length + children.reduce((n, c) => n + c.reads, 0),
      unset: unset || undefined,
      locations: isVariable ? own.map((v) => ({ uri: v.uri, line: v.line, start: v.start, end: v.end, write: v.write, preview: preview(v) })) : undefined,
      children: children.length > 0 ? children : undefined,
    };
  };
  const result: VariableTreeNode[] = [...globals.children.values()].sort(byLabel).map((b) => finish(b, allGlobalWrites));

  if (locals.size > 0) {
    const files: VariableTreeNode[] = [...locals]
      .sort(([a], [b]) => fileName(a).localeCompare(fileName(b)))
      .map(([uri, byScope]) => {
        const file = index.get(uri);
        const structures: VariableTreeNode[] = [...byScope]
          .sort(([a], [b]) => a - b)
          .map(([scope, occurrences]) => {
            const structure = file?.script.structures.find((s) => s.line === scope);
            const byKey = new Map<string, Builder>();
            for (const v of occurrences) {
              const b: Builder = byKey.get(v.key) ?? { label: `{${v.raw}}`, kind: 'variable', name: v.raw, occurrences: [], children: new Map() };
              b.occurrences.push(v);
              byKey.set(v.key, b);
            }
            const writes = occurrences.filter((v) => v.write);
            const children = [...byKey.values()].sort(byLabel).map((b) => finish(b, writes));
            return node(structure?.key ?? `line ${scope + 1}`, 'structure', children, occurrences);
          });
        return node(fileName(uri), 'file', structures, [...byScope.values()].flat());
      });
    result.push(node('Local variables', 'group', files, [...locals.values()].flatMap((m) => [...m.values()].flat())));
  }
  return result;
}

function node(label: string, kind: VariableTreeNode['kind'], children: VariableTreeNode[], occurrences: VariableOccurrence[]): VariableTreeNode {
  return {
    label,
    kind,
    sets: occurrences.filter((v) => v.write).length,
    reads: occurrences.filter((v) => !v.write).length,
    children,
  };
}

function label(text: string, kind: string): string {
  return kind === 'dynamic' ? '%…%' : text;
}

function byLabel(a: { label: string }, b: { label: string }): number {
  return a.label.localeCompare(b.label);
}
