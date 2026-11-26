/**
 * "Skout: Check Upgrade…": asks what to upgrade to, has the server check the
 * workspace, shows the findings in the Problems panel and opens a Markdown
 * report saved to `.skout/reports/`.
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { fetchText } from './downloadDump';

interface ServerStatus {
  targetVersion: string;
  bundledVersions: string[];
  addons: string[];
}

interface Finding {
  uri: string;
  line: number;
  start: number;
  end: number;
  severity: 'error' | 'warning' | 'information';
  kind: string;
  message: string;
  suggestion?: string;
  link?: string;
}

interface UpgradeResponse {
  result: { from: string; to: string; findings: Finding[]; scripts: number };
  markdown: string;
}

const VERSION = /^\d+\.\d+(\.\d+)?(-[\w.]+)?$/;
const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
};

function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export async function checkUpgrade(client: LanguageClient, problems: vscode.DiagnosticCollection): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    void vscode.window.showErrorMessage('Open the folder with your scripts first.');
    return;
  }
  const status = await client.sendRequest<ServerStatus>('skout/status');
  type Choice = vscode.QuickPickItem & { action: 'bundled' | 'download' | 'addon'; version?: string };
  const choices: Choice[] = [
    ...status.bundledVersions
      .filter((v) => newer(v, status.targetVersion))
      .reverse()
      .map((v): Choice => ({ label: `$(arrow-up) Skript ${v}`, description: 'bundled syntax', action: 'bundled', version: v })),
    { label: '$(cloud-download) Another Skript version…', description: 'downloads its docs from docs.skriptlang.org', action: 'download' },
    {
      label: '$(extensions) An addon, from a newer syntax dump…',
      description: status.addons.length > 0 ? `loaded: ${status.addons.join(', ')}` : 'load your addons with skout.syntaxDumps first',
      action: 'addon',
    },
  ];
  const choice = await vscode.window.showQuickPick(choices, {
    title: `Skout: Check upgrade from Skript ${status.targetVersion}`,
    placeHolder: 'What are you upgrading to? (Your current version comes from skout.skriptVersion.)',
  });
  if (!choice) return;

  const reports = vscode.Uri.joinPath(workspace.uri, '.skout', 'reports');
  let params: { skriptVersion?: string; dumpPath?: string; addon?: string; reportPath?: string };
  let reportName: string;
  if (choice.action === 'bundled') {
    params = { skriptVersion: choice.version };
    reportName = `upgrade-to-skript-${choice.version}.md`;
  } else if (choice.action === 'download') {
    const version = await vscode.window.showInputBox({
      title: 'Skript version to upgrade to',
      prompt: 'Skout downloads that version’s documentation from docs.skriptlang.org.',
      validateInput: (v) => (VERSION.test(v.trim()) ? undefined : 'A version such as 2.18.0'),
    });
    if (!version) return;
    const text = await fetchText(`https://docs.skriptlang.org/archives/${version.trim()}/docs.json`, `Downloading Skript ${version.trim()} documentation`);
    if (text === undefined) return;
    const folder = vscode.Uri.joinPath(workspace.uri, '.skout', 'upgrade');
    await vscode.workspace.fs.createDirectory(folder);
    const file = vscode.Uri.joinPath(folder, `skript-${version.trim()}.json`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(text, 'utf8'));
    params = { skriptVersion: version.trim(), dumpPath: file.fsPath };
    reportName = `upgrade-to-skript-${version.trim()}.md`;
  } else {
    const addon = status.addons.length > 0
      ? await vscode.window.showQuickPick(status.addons, { title: 'Which addon are you upgrading?' })
      : await vscode.window.showInputBox({ title: 'Which addon are you upgrading?', prompt: 'Its name as in its syntax dump, e.g. SkBee' });
    if (!addon) return;
    const picked = await vscode.window.showOpenDialog({
      title: `A syntax dump of the newer ${addon}`,
      openLabel: 'Use this syntax dump',
      canSelectMany: false,
      filters: { 'Syntax dump': ['json'] },
      defaultUri: workspace.uri,
    });
    if (!picked?.[0]) return;
    params = { addon, dumpPath: picked[0].fsPath };
    reportName = `upgrade-${addon.replace(/[^\w.-]+/g, '_')}.md`;
  }

  await vscode.workspace.fs.createDirectory(reports);
  const reportUri = vscode.Uri.joinPath(reports, reportName);
  params.reportPath = reportUri.fsPath;

  let response: UpgradeResponse;
  try {
    response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Skout: checking your scripts against the new version…' },
      () => client.sendRequest<UpgradeResponse>('skout/upgrade', params),
    );
  } catch (error) {
    void vscode.window.showErrorMessage((error as Error).message);
    return;
  }

  await vscode.workspace.fs.writeFile(reportUri, Buffer.from(response.markdown, 'utf8'));
  showInProblems(problems, response.result);
  await vscode.commands.executeCommand('markdown.showPreview', reportUri);

  const { findings, from, to } = response.result;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const message =
    findings.length === 0
      ? `Skout found nothing in your scripts that ${to} breaks.`
      : `${from} → ${to}: ${errors} line${errors === 1 ? '' : 's'} will break, ${findings.length - errors} more to review. They are in the Problems panel and the report.`;
  const action = await vscode.window.showInformationMessage(message, ...(findings.length > 0 ? ['Clear from Problems'] : []));
  if (action === 'Clear from Problems') problems.clear();
}

function showInProblems(problems: vscode.DiagnosticCollection, result: UpgradeResponse['result']): void {
  problems.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const f of result.findings) {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(f.line, f.start, f.line, Math.max(f.end, f.start + 1)),
      f.suggestion ? `${f.message}\n${f.suggestion}` : f.message,
      SEVERITY[f.severity],
    );
    diagnostic.source = `Skout upgrade → ${result.to}`;
    diagnostic.code = f.link ? { value: `upgrade-${f.kind}`, target: vscode.Uri.parse(f.link) } : `upgrade-${f.kind}`;
    byUri.set(f.uri, [...(byUri.get(f.uri) ?? []), diagnostic]);
  }
  for (const [uri, diagnostics] of byUri) problems.set(vscode.Uri.parse(uri), diagnostics);
}
