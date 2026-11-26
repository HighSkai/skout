/**
 * The "Skout: Variables" view: global variables grouped by namespace, local
 * variables by file and structure, each with where it is set and read.
 * The data comes from the server's `skout/variables` request.
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** Mirrors server/src/features/variablesTree.ts. */
interface VariableLocation {
  readonly uri: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly write: boolean;
  readonly preview: string;
}

interface VariableTreeNode {
  readonly label: string;
  readonly kind: 'namespace' | 'variable' | 'group' | 'file' | 'structure';
  readonly name?: string;
  readonly sets: number;
  readonly reads: number;
  readonly unset?: boolean;
  readonly locations?: readonly VariableLocation[];
  readonly children?: readonly VariableTreeNode[];
}

type Item = { readonly node: VariableTreeNode } | { readonly location: VariableLocation };

const ICONS: Record<VariableTreeNode['kind'], string> = {
  namespace: 'symbol-namespace',
  variable: 'symbol-variable',
  group: 'symbol-folder',
  file: 'file',
  structure: 'symbol-event',
};

export class VariablesProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly client: LanguageClient) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(item?: Item): Promise<Item[]> {
    if (!item) {
      const roots = await this.client.sendRequest<VariableTreeNode[]>('skout/variables');
      return roots.map((node) => ({ node }));
    }
    if ('location' in item) return [];
    const children = (item.node.children ?? []).map((node) => ({ node }));
    const locations = [...(item.node.locations ?? [])]
      .sort((a, b) => Number(b.write) - Number(a.write))
      .map((location) => ({ location }));
    return [...children, ...locations];
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if ('location' in item) {
      const l = item.location;
      const uri = vscode.Uri.parse(l.uri);
      const tree = new vscode.TreeItem(`${uri.path.slice(uri.path.lastIndexOf('/') + 1)}:${l.line + 1}`, vscode.TreeItemCollapsibleState.None);
      tree.description = l.write ? 'set' : 'read';
      tree.tooltip = l.preview;
      tree.iconPath = new vscode.ThemeIcon(l.write ? 'edit' : 'eye');
      tree.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [uri, { selection: new vscode.Range(l.line, l.start, l.line, l.end) } satisfies vscode.TextDocumentShowOptions],
      };
      return tree;
    }
    const n = item.node;
    const expandable = (n.children?.length ?? 0) + (n.locations?.length ?? 0) > 0;
    const tree = new vscode.TreeItem(n.label, expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    tree.description = `${n.sets} set · ${n.reads} read`;
    tree.iconPath = n.unset
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(ICONS[n.kind]);
    if (n.name) {
      tree.tooltip = new vscode.MarkdownString(`\`{${n.name}}\`${n.unset ? '\n\nRead somewhere but never set.' : ''}`);
    }
    tree.contextValue = n.kind;
    return tree;
  }
}

/** Registers the view and keeps it in step with the index, refreshing only while it is visible. */
export function registerVariablesView(context: vscode.ExtensionContext, client: LanguageClient): VariablesProvider {
  const provider = new VariablesProvider(client);
  const view = vscode.window.createTreeView('skout.variables', { treeDataProvider: provider, showCollapseAll: true });
  let stale = false;
  let timer: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('skout.variables.refresh', () => provider.refresh()),
    view.onDidChangeVisibility((e) => {
      if (e.visible && stale) {
        stale = false;
        provider.refresh();
      }
    }),
    client.onNotification('skout/indexChanged', () => {
      if (!view.visible) {
        stale = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => provider.refresh(), 400);
    }),
  );
  return provider;
}
