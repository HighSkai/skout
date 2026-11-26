import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { registerVariablesView } from './variablesView';

let client: LanguageClient | undefined;

/** What `activate` returns; the integration tests use it to talk to the server. */
export interface SkoutApi {
  readonly client: LanguageClient;
}

interface ServerStatus {
  files: number;
  targetVersion: string;
  builtinsVersion: string;
  bundledVersions: string[];
}

export async function activate(context: vscode.ExtensionContext): Promise<SkoutApi> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6011'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'skript' },
      { scheme: 'untitled', language: 'skript' },
    ],
    outputChannelName: 'Skout',
  };

  // The id `skout` makes the client honour the `skout.trace.server` setting.
  client = new LanguageClient('skout', 'Skout', serverOptions, clientOptions);
  await client.start();

  registerVariablesView(context, client);
  registerStatus(context, client);
  return { client };
}

/** A language status item showing which Skript version the checks follow. */
function registerStatus(context: vscode.ExtensionContext, languageClient: LanguageClient): void {
  const item = vscode.languages.createLanguageStatusItem('skout.status', { language: 'skript' });
  item.name = 'Skout';
  item.text = 'Skout: indexing…';
  item.command = { title: 'Set Skript version', command: 'workbench.action.openSettings', arguments: ['skout.skriptVersion'] };
  const update = async () => {
    const status = await languageClient.sendRequest<ServerStatus>('skout/status');
    item.text = `Skript ${status.targetVersion}`;
    item.detail =
      `${status.files} script${status.files === 1 ? '' : 's'} indexed · built-in syntax from bundled ${status.builtinsVersion}` +
      (status.targetVersion === status.builtinsVersion ? '' : ` (closest to ${status.targetVersion})`);
  };
  context.subscriptions.push(item, languageClient.onNotification('skout/indexChanged', () => void update()));
  void update();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
