/**
 * "Skout: Download syntax dump": the only place Skout uses the network, and
 * only when the user runs it. Saves the files to `.skout/syntax/` in the
 * workspace and adds that folder to `skout.syntaxDumps`.
 *
 * Sources:
 * - Skript's own docs for a version: docs.skriptlang.org/archives/<v>/docs.json
 * - Addon syntax from SkriptHub's catalog: skripthub.net/api/v1/addonsyntaxlist/
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

const FOLDER = '.skout/syntax';
const VERSION = /^\d+\.\d+(\.\d+)?(-[\w.]+)?$/;

interface SkriptHubRecord {
  addon?: { name?: string };
}

export async function downloadSyntaxDump(client: LanguageClient): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    void vscode.window.showErrorMessage('Open a folder first: Skout saves syntax dumps inside the workspace.');
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(book) Skript, for a version', description: 'docs.skriptlang.org', id: 'skript' as const },
      { label: '$(extensions) Addons, from SkriptHub', description: 'skripthub.net', id: 'skripthub' as const },
    ],
    { title: 'Skout: Download syntax dump', placeHolder: 'Which syntax should Skout download?' },
  );
  if (!choice) return;

  const target = vscode.Uri.joinPath(workspace.uri, ...FOLDER.split('/'));
  await vscode.workspace.fs.createDirectory(target);
  const written = choice.id === 'skript' ? await downloadSkript(target) : await downloadAddons(target);
  if (written.length === 0) return;

  const config = vscode.workspace.getConfiguration('skout', workspace.uri);
  const dumps = config.get<string[]>('syntaxDumps') ?? [];
  if (!dumps.includes(FOLDER)) {
    await config.update('syntaxDumps', [...dumps, FOLDER], vscode.ConfigurationTarget.Workspace);
  } else {
    await client.sendRequest('skout/reloadDumps');
  }
  void vscode.window.showInformationMessage(`Skout saved ${written.join(', ')} to ${FOLDER} and is using it now.`);
}

async function downloadSkript(target: vscode.Uri): Promise<string[]> {
  const configured = vscode.workspace.getConfiguration('skout').get<string>('skriptVersion') || '2.17.1';
  const version = await vscode.window.showInputBox({
    title: 'Skript version',
    prompt: 'The Skript version your server runs. Skout downloads its documentation from docs.skriptlang.org.',
    value: configured,
    validateInput: (v) => (VERSION.test(v.trim()) ? undefined : 'A version such as 2.16.2'),
  });
  if (!version) return [];
  const url = `https://docs.skriptlang.org/archives/${version.trim()}/docs.json`;
  const text = await fetchText(url, `Downloading Skript ${version} documentation`);
  if (text === undefined) return [];
  const name = `skript-${version.trim()}.json`;
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, name), Buffer.from(text, 'utf8'));
  return [name];
}

async function downloadAddons(target: vscode.Uri): Promise<string[]> {
  const text = await fetchText('https://skripthub.net/api/v1/addonsyntaxlist/', 'Downloading the SkriptHub addon catalog (about 8 MB)');
  if (text === undefined) return [];
  let records: SkriptHubRecord[];
  try {
    records = JSON.parse(text) as SkriptHubRecord[];
  } catch {
    void vscode.window.showErrorMessage('SkriptHub returned something that is not JSON. Try again later.');
    return [];
  }
  const byAddon = new Map<string, SkriptHubRecord[]>();
  for (const record of records) {
    const name = record.addon?.name;
    // Skript's own syntax comes from the bundled or downloaded Skript docs instead.
    if (!name || name.toLowerCase() === 'skript') continue;
    byAddon.set(name, [...(byAddon.get(name) ?? []), record]);
  }
  const picked = await vscode.window.showQuickPick(
    [...byAddon]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .map(([name, list]) => ({ label: name, description: `${list.length} syntax elements` })),
    { title: 'Which addons does your server use?', canPickMany: true, matchOnDescription: false },
  );
  if (!picked || picked.length === 0) return [];
  const written: string[] = [];
  for (const { label } of picked) {
    const name = `skripthub-${label.replace(/[^\w.-]+/g, '_')}.json`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, name), Buffer.from(JSON.stringify(byAddon.get(label)), 'utf8'));
    written.push(name);
  }
  return written;
}

export async function fetchText(url: string, title: string): Promise<string | undefined> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Skout (VS Code extension)' } });
      if (!response.ok) {
        void vscode.window.showErrorMessage(`Download failed: ${url} answered HTTP ${response.status}.`);
        return undefined;
      }
      return await response.text();
    } catch (error) {
      if (!token.isCancellationRequested) void vscode.window.showErrorMessage(`Download failed: ${(error as Error).message}`);
      return undefined;
    }
  });
}
