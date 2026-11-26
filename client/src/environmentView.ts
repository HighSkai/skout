/**
 * The "Environment" view in the Skout sidebar: which Skript version the
 * checks follow and why, the server Skout found, each addon with whether its
 * syntax is loaded (lines that use an addon without loaded syntax are not
 * checked), the syntax dumps in use, and what the server's log reported.
 * The data comes from the server's `skout/environment` request.
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** Mirrors the `skout/environment` response in server/src/server.ts. */
interface EnvironmentInfo {
  readonly server?: { readonly root: string; readonly source: 'setting' | 'workspace'; readonly log?: string };
  readonly skript: { readonly target: string; readonly from: 'setting' | 'server' | 'bundled'; readonly syntax: string; readonly installed?: string };
  readonly addons: readonly { readonly name: string; readonly version: string; readonly syntax: 'loaded' | 'missing'; readonly entries: number }[];
  readonly dumps: readonly string[];
  readonly syntaxAddons: readonly string[];
  readonly files: number;
  readonly checked: number;
  readonly typeErrors: number;
  readonly log?: { readonly path: string; readonly read: boolean; readonly reloads: number; readonly problems: number };
}

interface Row {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly command?: vscode.Command;
  readonly children?: readonly Row[];
}

const openSetting = (id: string): vscode.Command => ({ title: 'Open setting', command: 'workbench.action.openSettings', arguments: [id] });

export function rows(info: EnvironmentInfo): Row[] {
  const out: Row[] = [];
  const from = { setting: 'set in skout.skriptVersion', server: "the server's Skript jar", bundled: 'newest bundled version' }[info.skript.from];
  out.push({
    label: `Skript ${info.skript.target}`,
    description: from,
    tooltip: `Checks follow Skript ${info.skript.target} (${from}). Skript's syntax comes from ${info.skript.syntax}.`,
    icon: 'versions',
    command: openSetting('skout.skriptVersion'),
  });

  if (info.server) {
    out.push({
      label: 'Server',
      description: info.server.root,
      tooltip: `${info.server.root}\n${info.server.source === 'setting' ? 'From skout.server.folder.' : 'Found from the workspace folder.'}`,
      icon: 'server',
      command: openSetting('skout.server.folder'),
    });
  } else {
    out.push({
      label: 'No server folder',
      description: 'set skout.server.folder',
      tooltip: 'Skout reads the Skript version, addons, syntax dumps and log of a server folder (the one with plugins/Skript in it). Open it as the workspace, or set skout.server.folder.',
      icon: 'server',
      command: openSetting('skout.server.folder'),
    });
  }

  if (info.server) {
    const missing = info.addons.filter((a) => a.syntax === 'missing').length;
    out.push({
      label: `Addons (${info.addons.length})`,
      description: missing > 0 ? `${missing} without syntax` : info.addons.length > 0 ? 'all syntax loaded' : undefined,
      icon: 'extensions',
      children: info.addons.map((a) => ({
        label: `${a.name} ${a.version}`,
        description: a.syntax === 'loaded' ? `syntax loaded (${a.entries})` : 'no syntax: its lines are not checked',
        tooltip:
          a.syntax === 'loaded'
            ? `${a.entries} syntax entries of ${a.name} are loaded, so lines that use them are checked.`
            : `Skout has no syntax for ${a.name}. Lines that use it are left alone rather than reported. Run /gendocs with SkriptHub Docs Tool on the server, or use Skout: Download Syntax Dump.`,
        icon: a.syntax === 'loaded' ? 'pass' : 'warning',
        color: a.syntax === 'loaded' ? 'testing.iconPassed' : 'list.warningForeground',
        command: a.syntax === 'missing' ? { title: 'Download syntax dump', command: 'skout.downloadSyntaxDump' } : undefined,
      })),
    });
  }

  out.push({
    label: `Syntax dumps (${info.dumps.length})`,
    description: info.syntaxAddons.length > 0 ? info.syntaxAddons.join(', ') : 'Skript only',
    icon: 'symbol-namespace',
    children: info.dumps.map((d) => ({ label: d.split(/[\\/]/).pop() ?? d, description: d, icon: 'file' })),
  });

  out.push({
    label: 'Checks',
    description: `${info.checked} of ${info.files} scripts type-checked · ${info.typeErrors} type error${info.typeErrors === 1 ? '' : 's'}`,
    tooltip: 'Open scripts are checked at once; the rest in the background.',
    icon: 'checklist',
  });

  if (info.log) {
    out.push({
      label: 'Server log',
      description: info.log.read ? `${info.log.problems} problem${info.log.problems === 1 ? '' : 's'} reported by Skript` : 'not read (skout.server.readLog)',
      tooltip: `${info.log.path}\nAfter /sk reload, the errors Skript prints there appear in the Problems panel as "Skript (server)", on the line that still holds the code Skript quoted.`,
      icon: 'output',
      command: openSetting('skout.server.readLog'),
    });
  }
  return out;
}

export class EnvironmentProvider implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly client: LanguageClient) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(row?: Row): Promise<Row[]> {
    if (row) return [...(row.children ?? [])];
    return rows(await this.client.sendRequest<EnvironmentInfo>('skout/environment'));
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, row.children && row.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = row.description;
    item.tooltip = row.tooltip ?? row.description;
    if (row.icon) item.iconPath = new vscode.ThemeIcon(row.icon, row.color ? new vscode.ThemeColor(row.color) : undefined);
    item.command = row.command;
    return item;
  }
}

export function registerEnvironmentView(context: vscode.ExtensionContext, client: LanguageClient): EnvironmentProvider {
  const provider = new EnvironmentProvider(client);
  let timer: NodeJS.Timeout | undefined;
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 300);
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('skout.environment', provider),
    vscode.commands.registerCommand('skout.environment.refresh', () => provider.refresh()),
    client.onNotification('skout/environmentChanged', refresh),
    client.onNotification('skout/indexChanged', refresh),
  );
  return provider;
}
